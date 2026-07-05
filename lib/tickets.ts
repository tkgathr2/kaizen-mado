// ── Notion 改善チケットDB の読取・更新（第2段=フィードバック改善ループの内部処理） ──
// 起票(lib/notion.ts)の延長。状態遷移・議論ブロック追記・冪等マークを担う。
// 誰にも送信しない（対人送信・課金・本番DB破壊は含めない）。
import type { Ticket } from "./types";
import { normalizeForDedup } from "./dedup";
import { normalizeSystemForTicket } from "./systems";

const NOTION_VERSION = "2022-06-28";

export interface TicketRow {
  pageId: string;
  ticketId: string;
  system: string;
  type: string;
  importance: string;
  title: string;
  detail: string;
  reporter: string;
  state: string;
  fgsUrl: string | null;
  /** Notionの最終更新時刻（ISO文字列）。/board の並び・表示用。古いコードは未使用なので任意。 */
  lastEdited?: string;
  /** Notionの作成時刻（ISO文字列）。起票前 冪等チェックの時間窓判定用。任意。 */
  createdTime?: string;
  // ── 優先度スコアリング（§4.5.1・後方互換で任意。旧チケットは undefined＝表示は「—」）──
  urgency?: number; // 緊急度 1〜10
  importanceScore?: number; // 重要度 1〜10
  priority?: string; // 優先度（高/中/低）
  priorityReason?: string; // 算出根拠1行
  /** 状態が変わった日時（ISO文字列）。Phase 1 タイムアウト計測用。Notionプロパティ「状態変更日時」（date型）。
   * 旧チケット・プロパティ未設定は undefined（タイムアウト判定せず安全側）。 */
  statusChangedAt?: string;
  // ── Slack起点チケット用（幹部Botへの app_mention から自動起票された場合のみ設定） ──
  slackChannelId?: string; // メンションが届いたチャンネルID（完了時の返信先）
  slackThreadTs?: string;  // メンションのスレッドts（完了時の返信先スレッド）
  slackUserId?: string;    // メンションしたユーザーのSlack ID
}

function getAuth(): { token: string; databaseId: string } {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) throw new Error("NOTION_DATABASE_ID is not set");
  return { token, databaseId };
}

function headers(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

// ── プロパティ抽出ヘルパ ──
function plainFromTitle(prop: any): string {
  const arr = prop?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((r: any) => r?.plain_text ?? "").join("");
}
function plainFromRichText(prop: any): string {
  const arr = prop?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((r: any) => r?.plain_text ?? "").join("");
}
function nameFromSelect(prop: any): string {
  return prop?.select?.name ?? "";
}
function numberFromProp(prop: any): number | undefined {
  const n = prop?.number;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
function idFromUniqueId(prop: any): string {
  const u = prop?.unique_id;
  if (!u) return "";
  const prefix = u.prefix || "KZ";
  if (u.number == null) return "";
  return `${prefix}-${u.number}`;
}
function valueFromUrl(prop: any): string | null {
  const v = prop?.url;
  return typeof v === "string" && v ? v : null;
}
function dateFromProp(prop: any): string | null {
  const d = prop?.date?.start;
  return typeof d === "string" && d ? d : null;
}

function parseRow(page: any): TicketRow {
  const props = page?.properties ?? {};
  return {
    pageId: String(page?.id ?? ""),
    ticketId: idFromUniqueId(props["ID"]) || idFromUniqueId(findUniqueId(props)),
    system: nameFromSelect(props["対象システム"]),
    type: nameFromSelect(props["種別"]),
    importance: nameFromSelect(props["重要度"]),
    title: plainFromTitle(props["チケット名"]),
    detail: plainFromRichText(props["内容"]),
    reporter: plainFromRichText(props["起票者"]),
    state: nameFromSelect(props["状態"]),
    fgsUrl: valueFromUrl(props["FGSリンク"]),
    lastEdited: typeof page?.last_edited_time === "string" ? page.last_edited_time : "",
    createdTime: typeof page?.created_time === "string" ? page.created_time : "",
    // 優先度スコアリング（任意・プロパティが無ければ undefined＝旧チケット互換）。
    urgency: numberFromProp(props["緊急度"]),
    importanceScore: numberFromProp(props["重要度スコア"]),
    priority: nameFromSelect(props["優先度"]) || undefined,
    priorityReason: plainFromRichText(props["優先度根拠"]) || undefined,
    // Phase 1 タイムアウト計測用。Notionプロパティ「状態変更日時」（date型）。
    // プロパティが無い旧チケットは undefined（タイムアウト判定せず安全側）。
    statusChangedAt: dateFromProp(props["状態変更日時"]) || undefined,
    // Slack起点チケット用（プロパティが無ければ undefined＝通常チケット互換）。
    slackChannelId: plainFromRichText(props["Slack Channel ID"]) || undefined,
    slackThreadTs: plainFromRichText(props["Slack Thread TS"]) || undefined,
    slackUserId: plainFromRichText(props["Slack User ID"]) || undefined,
  };
}

/** プロパティ名が不定の unique_id を拾う（最初の1つ） */
function findUniqueId(props: any): any {
  for (const key of Object.keys(props || {})) {
    if (props[key]?.type === "unique_id") return props[key];
  }
  return null;
}

// Notion query の1ページ最大件数。これを超える件数は has_more/next_cursor で繰り返し取得する。
const NOTION_PAGE_SIZE = 100;

/**
 * Notion DBクエリをページネーション込みで全件取得する（limit に達するまで）。
 * 旧実装は先頭ページ(page_size=limit)しか見ず、limit>100 や「全件」を意図しても
 * has_more を辿らないため取りこぼしていた。has_more の間 start_cursor を付けて繰り返す。
 * @param filter Notion filter（null可＝全件）
 * @param limit  取得上限（全件取りたい場合は十分大きな数を渡す）
 * @param sorts  Notion sorts（任意）
 */
async function queryDatabase(
  filter: any,
  limit: number,
  sorts?: any
): Promise<TicketRow[]> {
  const { token, databaseId } = getAuth();
  const cap = Math.max(1, Math.floor(limit));
  const rows: TicketRow[] = [];
  let cursor: string | undefined = undefined;

  // has_more の間ループ。1ページ毎に残り必要件数だけ要求して limit でちょうど止める。
  do {
    const remaining = cap - rows.length;
    const pageSize = Math.min(NOTION_PAGE_SIZE, remaining);
    const payload: any = { page_size: pageSize };
    if (filter) payload.filter = filter;
    if (sorts) payload.sorts = sorts;
    if (cursor) payload.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Notion query error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const page of results) {
      rows.push(parseRow(page));
      if (rows.length >= cap) break;
    }
    cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
  } while (cursor && rows.length < cap);

  return rows;
}

/** 指定状態のチケットを取得 */
export async function fetchTicketsByState(
  state: string,
  limit = 5
): Promise<TicketRow[]> {
  return queryDatabase(
    { property: "状態", select: { equals: state } },
    limit
  );
}

/** 全チケットを最終更新の新しい順で取得（/board の状況可視化用・読み取り専用）。
 * ページネーション対応：limit が100を超えても has_more を辿って全件取得する。 */
export async function fetchAllTickets(limit = 100): Promise<TicketRow[]> {
  return queryDatabase(
    null,
    limit,
    [{ timestamp: "last_edited_time", direction: "descending" }]
  );
}

/** pageIdで1件取得（webhookでGO時に現在状態を確認＝冪等化のため）。無ければnull。 */
export async function fetchTicketByPageId(pageId: string): Promise<TicketRow | null> {
  const { token } = getAuth();
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: headers(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion get error ${res.status}: ${t.slice(0, 300)}`);
  }
  const page = await res.json();
  return parseRow(page);
}

// ── 起票前 冪等チェック（インスタンス跨ぎの真の二重起票防止） ──
// lib/dedup.ts のメモリ段は「同一プロセス内」しか効かない。Vercelの
// serverless は連打を別インスタンスで受けうるため、メモリ段をすり抜けた
// 二重起票が Notion に2件できる。そこで createTicket の直前に Notion を
// 1回問い合わせ、「直近N秒以内・完全同一内容（＋記名なら同一起票者）」の
// 既存チケットがあれば、新規作成せずそれを返す。
//
// ★ fail-safe：このチェックが失敗/タイムアウトしたら null を返し、呼び出し側は
//   通常どおり新規作成する（＝声を絶対に取りこぼさない。迷ったら作る側に倒す）。

/** 起票前 冪等チェックの時間窓（秒）。env KAIZEN_SUBMIT_DEDUP_SECONDS（既定15秒）。
 * 1〜600秒の範囲にクランプ（長すぎる窓は正当な再起票を握りつぶすため）。 */
export function submitDedupSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_SUBMIT_DEDUP_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 15;
  return Math.min(600, Math.max(1, Math.floor(raw)));
}

/** 匿名（reporter空）の時間窓は記名より短くする（別人の正当な短文を消さない安全側）。
 * 既定で記名の半分（最低1秒）。記名は submitDedupSeconds をそのまま使う。 */
export function anonSubmitDedupSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.floor(submitDedupSeconds(env) / 2));
}

/** Notion 上で「直近window秒以内・完全同一内容」の既存チケットを照合する純粋ロジック。
 * Notion側で created_time＋対象システム(＋記名なら起票者)まで絞った候補 rows を受け、
 * title/detail/種別/重要度/起票者を正規化して厳密一致するものを1件返す（無ければnull）。
 * 完全一致のみを重複とみなす＝別内容・別importance は通す（声を取りこぼさない）。 */
export function matchDuplicate(
  rows: TicketRow[],
  ticket: Ticket,
  reporter: string | null,
  anonymous: boolean
): TicketRow | null {
  const norm = normalizeForDedup;
  const wantSystem = norm(normalizeSystemForTicket(ticket.system));
  const wantType = norm(ticket.type || "");
  const wantTitle = norm(ticket.title || "");
  const wantDetail = norm(ticket.detail || "");
  const wantImportance = norm(ticket.importance || "");
  const wantReporter = norm(reporter || "");

  for (const r of rows) {
    if (norm(r.system) !== wantSystem) continue;
    if (norm(r.type) !== wantType) continue;
    if (norm(r.title) !== wantTitle) continue;
    if (norm(r.detail) !== wantDetail) continue;
    if (norm(r.importance) !== wantImportance) continue;
    // 記名のときは起票者も一致を要求（別人の同一内容を誤って弾かない）。
    // 匿名のときは起票者キーが無いので内容完全一致のみで判定する。
    if (!anonymous && norm(r.reporter) !== wantReporter) continue;
    return r;
  }
  return null;
}

/**
 * createTicket 直前に1回呼ぶ「Notion側の起票前 冪等チェック」。
 * 直近window秒以内・同一 対象システム（＋記名なら同一起票者）の候補を Notion から取り、
 * matchDuplicate で完全同一内容を厳密照合する。ヒットしたらその既存 TicketRow を返す。
 * 失敗（クエリエラー/タイムアウト/認証未設定など）は握りつぶして null を返す（fail-safe）。
 */
export async function findRecentDuplicate(
  ticket: Ticket,
  reporter: string | null,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<TicketRow | null> {
  try {
    const anonymous = !reporter || reporter.trim().length === 0;
    const windowSec = anonymous ? anonSubmitDedupSeconds(env) : submitDedupSeconds(env);
    const since = new Date(now - windowSec * 1000).toISOString();
    const system = normalizeSystemForTicket(ticket.system);

    // Notion filter：作成時刻が窓内 AND 対象システム一致（＋記名なら起票者一致）。
    // title/detail の厳密一致は取得後にアプリ側（matchDuplicate）で正規化照合する。
    const and: any[] = [
      { timestamp: "created_time", created_time: { on_or_after: since } },
      { property: "対象システム", select: { equals: system } },
    ];
    if (!anonymous) {
      and.push({ property: "起票者", rich_text: { equals: (reporter || "").trim() } });
    }

    // 窓内の候補だけ取れば十分（連打は数件）。新しい順で取得。
    const rows = await queryDatabase({ and }, 25, [
      { timestamp: "created_time", direction: "descending" },
    ]);
    return matchDuplicate(rows, ticket, reporter, anonymous);
  } catch (err) {
    // fail-safe：照合に失敗しても起票は止めない（声を取りこぼさない）。
    console.error(
      "[tickets] findRecentDuplicate failed (fallback to create):",
      (err as Error).message
    );
    return null;
  }
}

/** ticketId（例 KZ-12）でGO待ちチケットを探す（テキスト返信「GO KZ-12」用）。 */
export async function findGoMachiByTicketId(ticketId: string): Promise<TicketRow | null> {
  const rows = await fetchTicketsByState("GO待ち", 25);
  const norm = ticketId.toUpperCase().replace(/\s/g, "");
  return rows.find((r) => r.ticketId.toUpperCase().replace(/\s/g, "") === norm) ?? null;
}

/** 「実装中」が一定時間以上滞留したチケット（=stuck）の判定しきい値（分）。
 * implement ジョブ（GitHub Actions）が失敗/タイムアウト/中断で callback に到達しないと、
 * チケットが「実装中」のまま永久滞留する。閾値は env KAIZEN_STUCK_MINUTES（既定30分）。 */
export function staleImplementingMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_STUCK_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** あるチケットが「実装中」かつ最終更新から minutes 分以上経過しているか（stuck判定）。
 * lastEdited（Notion last_edited_time）で経過を測る。lastEdited が無い/不正なら
 * 経過判定できないので「stuckではない（false）」とみなす（誤って巻き戻さない安全側）。 */
export function isStaleImplementing(
  row: Pick<TicketRow, "state" | "lastEdited">,
  now: number,
  minutes: number
): boolean {
  if (row.state !== "実装中") return false;
  if (!row.lastEdited) return false;
  const edited = Date.parse(row.lastEdited);
  if (!Number.isFinite(edited)) return false;
  return now - edited >= minutes * 60_000;
}

/** 「実装中」のまま stuck（一定時間以上滞留）しているチケットを取得する。
 * implement ジョブが callback に到達せず取り残されたチケットを回収するための入口。
 * Notion 側に時間フィルタは無いため「実装中」を取得してから lastEdited で経過判定する。 */
export async function fetchStaleImplementing(
  minutes: number = staleImplementingMinutes(),
  limit = 10,
  now: number = Date.now()
): Promise<TicketRow[]> {
  const rows = await fetchTicketsByState("実装中", limit);
  return rows.filter((r) => isStaleImplementing(r, now, minutes));
}

// ── 自動リトライ上限（reaper の無限リトライ根絶・KZ-17事案） ──
// reaper は「実装中」滞留チケットを「着手」へ戻すたびに議論ブロックへ印（REAPER_RESET_HEADING）を
// 残している。この印の「数」をリトライ回数の真実の源にする（Notionが正＝インスタンス跨ぎでも効く・
// 追加のNotionプロパティ不要＝プロパティが無いDBでも壊れない）。
// 上限（env KAIZEN_MAX_RETRIES・既定3）に達したら「着手」へ戻さず「差し戻し」へ落とす。

/** reaper が「実装中→着手」へ戻すとき議論に残す印の見出し（カウント対象）。 */
export const REAPER_RESET_HEADING = "stuck回収（自動リセット）";

/** リトライ上限到達で差し戻したときの見出し。これ「以降」の印だけを数える＝
 * 人が原因を直して再GOしたら、また上限までリトライ枠が復活する（永久封印にしない）。 */
export const RETRY_CAP_HEADING = "自動リトライ上限（差し戻し）";

/** 直近の失敗理由を拾う見出し（callback が残す議論ブロック）。 */
const FAILURE_HEADINGS = ["基盤エラー", "実装失敗"];

/** 自動リトライの上限回数。env KAIZEN_MAX_RETRIES（既定3・0〜20にクランプ）。
 * 0＝自動リトライ禁止（初回stuckで即差し戻し）。不正値・負値は既定3（安全側）。 */
export function maxAutoRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_MAX_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return 3;
  return Math.min(20, Math.floor(raw));
}

export interface ReaperRetryInfo {
  /** これまでに reaper が「着手」へ戻した回数（最後の上限到達以降）。 */
  count: number;
  /** 議論ブロックに残っている直近の失敗理由（無ければ null）。 */
  lastFailure: string | null;
}

function plainFromBlockRichText(block: any, type: string): string {
  const arr = block?.[type]?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((r: any) => r?.plain_text ?? "").join("");
}

/** 議論ブロック列から「リトライ回数」と「直近の失敗理由」を数える純粋ロジック。
 * - REAPER_RESET_HEADING を含む heading_3 を1リトライと数える。
 * - RETRY_CAP_HEADING を見たらカウントをリセット（再GO後は枠が復活）。
 * - FAILURE_HEADINGS（基盤エラー/実装失敗）直後の paragraph を失敗理由として拾う（最後のものが勝つ）。
 *   本文に「詳細：」があればその後ろだけを理由として使う（定型文を除いた実エラー文）。 */
export function summarizeRetryBlocks(blocks: any[]): ReaperRetryInfo {
  let count = 0;
  let lastFailure: string | null = null;
  let pendingFailureHeading = false;
  for (const b of blocks || []) {
    if (b?.type === "heading_3") {
      const text = plainFromBlockRichText(b, "heading_3");
      if (text.includes(RETRY_CAP_HEADING)) {
        count = 0; // 上限到達で一区切り。以降（人が再GOした後）の印だけ数える。
      } else if (text.includes(REAPER_RESET_HEADING)) {
        count++;
      }
      pendingFailureHeading = FAILURE_HEADINGS.some((h) => text.includes(h));
    } else if (b?.type === "paragraph" && pendingFailureHeading) {
      const raw = plainFromBlockRichText(b, "paragraph").trim();
      if (raw) {
        const idx = raw.lastIndexOf("詳細：");
        const reason = (idx >= 0 ? raw.slice(idx + "詳細：".length) : raw).trim();
        if (reason) lastFailure = reason;
      }
      pendingFailureHeading = false;
    }
  }
  return { count, lastFailure };
}

/** チケットページの議論ブロックを読み、リトライ回数と直近失敗理由を返す。
 * ★ fail-safe：取得失敗・鍵未設定・例外はすべて { count: 0, lastFailure: null } を返す
 * ＝「数えられないときは従来どおり『着手』へ戻す側」に倒す（誤って差し戻さない安全側）。 */
export async function getReaperRetryInfo(pageId: string): Promise<ReaperRetryInfo> {
  const empty: ReaperRetryInfo = { count: 0, lastFailure: null };
  try {
    const token = process.env.NOTION_TOKEN;
    if (!token || !pageId) return empty;
    const blocks: any[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    // 100件×10ページ＝最大1000ブロックまで見る（議論が異常に長いページでも処理を有界に保つ）。
    do {
      const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
      url.searchParams.set("page_size", "100");
      if (cursor) url.searchParams.set("start_cursor", cursor);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      });
      if (!res.ok) {
        console.error("[tickets] getReaperRetryInfo 取得失敗（count=0の安全側）", res.status);
        return empty;
      }
      const data = await res.json();
      blocks.push(...(Array.isArray(data?.results) ? data.results : []));
      cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
    } while (cursor && ++pages < 10);
    return summarizeRetryBlocks(blocks);
  } catch (err) {
    console.error(
      "[tickets] getReaperRetryInfo 例外（count=0の安全側）:",
      (err as Error).message
    );
    return empty;
  }
}

/** 完了済みかつ未学習（FGSリンク空）のチケットを取得 */
export async function fetchCompletedUnlearned(limit = 10): Promise<TicketRow[]> {
  return queryDatabase(
    {
      and: [
        { property: "状態", select: { equals: "完了" } },
        { property: "FGSリンク", url: { is_empty: true } },
      ],
    },
    limit
  );
}

async function patchPage(pageId: string, properties: any): Promise<void> {
  const { token } = getAuth();
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion update error ${res.status}: ${t.slice(0, 300)}`);
  }
}

/** 状態(select)を更新 */
export async function updateTicketState(
  pageId: string,
  state: string
): Promise<void> {
  await patchPage(pageId, { 状態: { select: { name: state } } });
}

/** FGSリンク(url)を設定（学び還元の冪等マーク用） */
export async function setTicketUrlField(
  pageId: string,
  url: string
): Promise<void> {
  await patchPage(pageId, { FGSリンク: { url } });
}

/** 担当(rich_text)を設定 */
export async function setTicketAssignee(
  pageId: string,
  who: string
): Promise<void> {
  await patchPage(pageId, {
    担当: { rich_text: [{ type: "text", text: { content: who.slice(0, 1900) } }] },
  });
}

/** 議論内容を heading_3 + paragraph ブロックとしてページ末尾に追記 */
export async function appendDiscussionBlocks(
  pageId: string,
  lines: { heading?: string; body?: string }[]
): Promise<void> {
  const { token } = getAuth();
  const children: any[] = [];
  for (const line of lines) {
    if (line.heading) {
      children.push({
        object: "block",
        type: "heading_3",
        heading_3: {
          rich_text: [
            { type: "text", text: { content: line.heading.slice(0, 1900) } },
          ],
        },
      });
    }
    if (line.body) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { type: "text", text: { content: line.body.slice(0, 1900) } },
          ],
        },
      });
    }
  }
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children`,
    {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ children }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion append error ${res.status}: ${t.slice(0, 300)}`);
  }
}

// ── Phase 1 追加関数 ──

/**
 * 状態変更日時（date型）を現在時刻で更新する。
 * `updateTicketState` と一緒に呼ぶことで、タイムアウト計測の起点を記録する。
 * Notionプロパティ「状態変更日時」が DB に存在しない場合は PATCH が 400 になるが、
 * fail-safe で握り潰す（タイムアウト計測できないだけで本筋の状態遷移は損なわない）。
 */
export async function setStatusChangedAt(
  pageId: string,
  now: Date = new Date()
): Promise<void> {
  try {
    await patchPage(pageId, {
      状態変更日時: { date: { start: now.toISOString() } },
    });
  } catch (err) {
    // プロパティ未設定（旧DB）でも状態遷移は止めない。
    console.warn("[tickets] setStatusChangedAt skipped:", (err as Error).message);
  }
}

/**
 * 終端でない全チケットを取得する（kz-sweep cron 用）。
 * 対象状態: GO待ち・差し戻し・レビュー（タイムアウト監視対象）。
 * 着手/実装中は既存 execute の reaper が担うためここでは除外する。
 */
export async function fetchNonTerminalTickets(limit = 50): Promise<TicketRow[]> {
  const states = ["GO待ち", "差し戻し", "レビュー"];
  const results: TicketRow[] = [];
  for (const state of states) {
    const rows = await fetchTicketsByState(state, Math.ceil(limit / states.length));
    results.push(...rows);
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}
