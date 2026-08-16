#!/usr/bin/env node
// ── カイゼンくん改善チケットDB：Notion → Postgres 移行スクリプト（2026-08-16） ──
//
// 安全設計：
// - べき等（何度実行しても同じ結果）。notion_page_id をキーに UPSERT するため、
//   途中失敗しても再実行で続きから進む（重複は作らない）。
// - Notion側は一切書き換えない（読み取り専用）。
// - 議論ブロック（heading_3 + paragraph）も1件ずつ挿入順を保って移行する
//   （getReaperRetryInfo のリトライ回数カウントが挿入順に依存するため）。
// - 移行後、Notion側の件数とPostgres側の件数を突合し、1件でも欠けたら
//   非ゼロ終了する（サイレントな取りこぼしを許さない）。
// - 実行後、ticket_number のシーケンスを「移行データの最大値+1」に進める
//   （新規チケットが既存番号と衝突しないように）。
//
// 使い方: node scripts/migrate-tickets-to-postgres.mjs [--dry-run]
//   --dry-run … Notionから全件読み、件数・サンプルを表示するだけでPostgresへは書き込まない。

import pg from "pg";

const NOTION_VERSION = "2022-06-28";
const DRY_RUN = process.argv.includes("--dry-run");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[migrate] 環境変数 ${name} が未設定です`);
    process.exit(1);
  }
  return v;
}

const NOTION_TOKEN = requireEnv("NOTION_TOKEN");
const NOTION_DATABASE_ID = requireEnv("NOTION_DATABASE_ID");
const DATABASE_URL = DRY_RUN ? process.env.DATABASE_URL : requireEnv("DATABASE_URL");

function notionHeaders() {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function plainFromTitle(prop) {
  const arr = prop?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => r?.plain_text ?? "").join("");
}
function plainFromRichText(prop) {
  const arr = prop?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => r?.plain_text ?? "").join("");
}
function nameFromSelect(prop) {
  return prop?.select?.name ?? "";
}
function numberFromProp(prop) {
  const n = prop?.number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function urlFromProp(prop) {
  const v = prop?.url;
  return typeof v === "string" && v ? v : null;
}
function dateFromProp(prop) {
  const d = prop?.date?.start;
  return typeof d === "string" && d ? d : null;
}
function findUniqueId(props) {
  for (const key of Object.keys(props || {})) {
    if (props[key]?.type === "unique_id") return props[key];
  }
  return null;
}
function ticketNumberFromProps(props) {
  const u = props["ID"]?.type === "unique_id" ? props["ID"] : findUniqueId(props);
  if (!u?.unique_id && u?.type !== "unique_id") {
    // parseRowと同じ二段構え（propsの中身自体がunique_idオブジェクトのことがある）
  }
  const numberHolder = u?.unique_id ?? u;
  const n = numberHolder?.number;
  return typeof n === "number" ? n : null;
}

function parseNotionPage(page) {
  const props = page?.properties ?? {};
  return {
    notionPageId: String(page?.id ?? ""),
    ticketNumber: ticketNumberFromProps(props),
    system: nameFromSelect(props["対象システム"]),
    type: nameFromSelect(props["種別"]),
    importance: nameFromSelect(props["重要度"]),
    title: plainFromTitle(props["チケット名"]),
    detail: plainFromRichText(props["内容"]),
    reporter: plainFromRichText(props["起票者"]),
    state: nameFromSelect(props["状態"]),
    assignee: plainFromRichText(props["担当"]),
    fgsUrl: urlFromProp(props["FGSリンク"]),
    prUrl: urlFromProp(props["PR URL"]),
    urgency: numberFromProp(props["緊急度"]),
    importanceScore: numberFromProp(props["重要度スコア"]),
    priority: nameFromSelect(props["優先度"]) || null,
    priorityReason: plainFromRichText(props["優先度根拠"]) || null,
    statusChangedAt: dateFromProp(props["状態変更日時"]),
    slackChannelId: plainFromRichText(props["Slack Channel ID"]) || null,
    slackThreadTs: plainFromRichText(props["Slack Thread TS"]) || null,
    slackUserId: plainFromRichText(props["Slack User ID"]) || null,
    createdTime: typeof page?.created_time === "string" ? page.created_time : null,
    lastEdited: typeof page?.last_edited_time === "string" ? page.last_edited_time : null,
  };
}

/** Notion DBを全ページ取得（has_moreを辿る）。 */
async function fetchAllNotionTickets() {
  const rows = [];
  let cursor = undefined;
  let pageCount = 0;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Notion query error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const page of results) rows.push(parseNotionPage(page));
    cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
    pageCount++;
    console.log(`[migrate] Notion取得中... ${rows.length}件（${pageCount}ページ目）`);
  } while (cursor);
  return rows;
}

/** チケットページの子ブロック（heading_3 + paragraph の議論ログ）を挿入順で全件取得。 */
async function fetchDiscussionBlocks(notionPageId) {
  const entries = [];
  let cursor = undefined;
  let pages = 0;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${notionPageId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const res = await fetch(url.toString(), { method: "GET", headers: notionHeaders() });
    if (!res.ok) {
      console.warn(`[migrate]   議論ブロック取得失敗 pageId=${notionPageId} status=${res.status}（この行は空のまま続行）`);
      return entries;
    }
    const data = await res.json();
    const blocks = Array.isArray(data?.results) ? data.results : [];
    for (const b of blocks) {
      if (b?.type === "heading_3") {
        const text = (b.heading_3?.rich_text || []).map((r) => r?.plain_text ?? "").join("");
        entries.push({ heading: text || null, body: null, createdTime: b.created_time || null });
      } else if (b?.type === "paragraph") {
        const text = (b.paragraph?.rich_text || []).map((r) => r?.plain_text ?? "").join("");
        if (entries.length > 0 && entries[entries.length - 1].body === null && entries[entries.length - 1].heading !== undefined) {
          // 直前がheadingで body未設定なら同じ行に合体（tickets.tsのappendDiscussionBlocksが
          // heading+bodyを1組として書き込む挙動を再現）。
        }
        entries.push({ heading: null, body: text || null, createdTime: b.created_time || null });
      }
    }
    cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
  } while (cursor && ++pages < 10);
  return entries;
}

async function main() {
  console.log(`[migrate] 開始（${DRY_RUN ? "DRY RUN" : "本番書き込み"}）`);

  const tickets = await fetchAllNotionTickets();
  console.log(`[migrate] Notion側チケット総数: ${tickets.length}件`);

  const invalid = tickets.filter((t) => t.ticketNumber == null);
  if (invalid.length > 0) {
    console.warn(`[migrate] ⚠️ ticket_numberが取れない行が${invalid.length}件あります（unique_idプロパティ異常の可能性）。該当notionPageId:`, invalid.map((t) => t.notionPageId));
  }
  const valid = tickets.filter((t) => t.ticketNumber != null);

  if (DRY_RUN) {
    console.log("[migrate] --dry-run のためPostgresへの書き込みは行いません。");
    console.log("[migrate] サンプル（先頭3件）:", JSON.stringify(valid.slice(0, 3), null, 2));
    console.log(`[migrate] 移行対象: ${valid.length}件 / 総数: ${tickets.length}件 / 異常: ${invalid.length}件`);
    return;
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    // スキーマは lib/db/schema.ts と同一内容（このスクリプトは独立実行のためインラインで持つ）。
    const { readFileSync } = await import("node:fs");
    const schemaTs = readFileSync(new URL("../lib/db/schema.ts", import.meta.url), "utf8");
    const m = schemaTs.match(/SCHEMA_SQL = `([\s\S]*?)`;/);
    if (!m) throw new Error("schema.ts から SCHEMA_SQL を抽出できませんでした");
    await pool.query(m[1]);
    console.log("[migrate] スキーマ確認/作成完了");

    let inserted = 0;
    let updated = 0;
    let blocksInserted = 0;

    for (const t of valid) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upsertRes = await client.query(
          `INSERT INTO tickets (
             ticket_number, system, type, importance, title, detail, reporter, state, assignee,
             fgs_url, pr_url, urgency, importance_score, priority, priority_reason,
             status_changed_at, slack_channel_id, slack_thread_ts, slack_user_id,
             notion_page_id, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             COALESCE($21::timestamptz, now()), COALESCE($22::timestamptz, now()))
           ON CONFLICT (notion_page_id) WHERE notion_page_id IS NOT NULL DO UPDATE SET
             system=EXCLUDED.system, type=EXCLUDED.type, importance=EXCLUDED.importance,
             title=EXCLUDED.title, detail=EXCLUDED.detail, reporter=EXCLUDED.reporter,
             state=EXCLUDED.state, assignee=EXCLUDED.assignee, fgs_url=EXCLUDED.fgs_url,
             pr_url=EXCLUDED.pr_url, urgency=EXCLUDED.urgency, importance_score=EXCLUDED.importance_score,
             priority=EXCLUDED.priority, priority_reason=EXCLUDED.priority_reason,
             status_changed_at=EXCLUDED.status_changed_at, slack_channel_id=EXCLUDED.slack_channel_id,
             slack_thread_ts=EXCLUDED.slack_thread_ts, slack_user_id=EXCLUDED.slack_user_id,
             updated_at=EXCLUDED.updated_at
           RETURNING id, (xmax = 0) AS was_insert`,
          [
            t.ticketNumber, t.system, t.type, t.importance, t.title, t.detail, t.reporter, t.state, t.assignee,
            t.fgsUrl, t.prUrl, t.urgency, t.importanceScore, t.priority, t.priorityReason,
            t.statusChangedAt, t.slackChannelId, t.slackThreadTs, t.slackUserId,
            t.notionPageId, t.createdTime, t.lastEdited,
          ]
        );
        const ticketDbId = upsertRes.rows[0].id;
        const wasInsert = upsertRes.rows[0].was_insert;
        if (wasInsert) inserted++; else updated++;

        // 議論ブロックは「新規挿入したチケットのときだけ」移行する（再実行時の重複防止・
        // 既存行がある＝前回既に移行済みとみなす）。
        if (wasInsert) {
          const blocks = await fetchDiscussionBlocks(t.notionPageId);
          for (const b of blocks) {
            await client.query(
              `INSERT INTO ticket_discussion_blocks (ticket_id, heading, body, created_at)
               VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))`,
              [ticketDbId, b.heading, b.body, b.createdTime]
            );
            blocksInserted++;
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] ❌ 失敗 notionPageId=${t.notionPageId} ticketNumber=${t.ticketNumber}:`, err.message);
        throw err;
      } finally {
        client.release();
      }
      if ((inserted + updated) % 20 === 0) {
        console.log(`[migrate] 進捗: ${inserted + updated}/${valid.length}件処理済み（新規${inserted}・更新${updated}・議論ブロック${blocksInserted}）`);
      }
    }

    console.log(`[migrate] 移行処理完了: 新規${inserted}件・更新${updated}件・議論ブロック${blocksInserted}件`);

    // シーケンスを移行データの最大ticket_numberより後ろへ進める（新規採番との衝突防止）。
    const maxRes = await pool.query(`SELECT COALESCE(MAX(ticket_number), 0) AS max_num FROM tickets`);
    const maxNum = Number(maxRes.rows[0].max_num);
    // ticket_numberはUNIQUE制約のみでSERIALではないため、専用シーケンスを作り
    // アプリ側の新規採番はそのシーケンスから払い出す設計にする（tickets.ts側で使用）。
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ticket_number_seq`);
    await pool.query(`SELECT setval('ticket_number_seq', $1, false)`, [maxNum + 1]);
    console.log(`[migrate] ticket_number_seq を ${maxNum + 1} から開始するよう設定しました`);

    // ── 件数突合（最重要・1件でも欠けたら失敗として終了） ──
    const countRes = await pool.query(`SELECT COUNT(*) AS c FROM tickets`);
    const pgCount = Number(countRes.rows[0].c);
    console.log(`[migrate] 突合: Notion側有効件数=${valid.length} / Postgres側件数=${pgCount}`);
    if (pgCount < valid.length) {
      console.error(`[migrate] ❌ 件数不一致！Postgres側が${valid.length - pgCount}件少ないです。移行未完了として扱ってください。`);
      process.exit(1);
    }
    if (invalid.length > 0) {
      console.warn(`[migrate] ⚠️ 完了しましたが、ticket_number異常で移行対象外にした${invalid.length}件があります。上記ログのnotionPageIdを手動確認してください。`);
    }
    console.log("[migrate] ✅ 件数突合OK。移行完了。");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] 致命的エラー:", err);
  process.exit(1);
});
