// ── 一時運用エンドポイント：Notion → Postgres チケット移行（社長指示 2026-08-16・検証後削除） ──
// 本番（Vercel）はNOTION_TOKEN/DATABASE_URL等のSensitive環境変数をCLIから引けないため、
// これらが実際に読める本番実行環境の中でこの移行を1回だけ動かす。
// 認証は既存のcron共通鍵（checkCronSecret・x-cron-secret）を流用（新規鍵を増やさない）。
// べき等（notion_page_idでUPSERT）・件数突合込み。scripts/migrate-tickets-to-postgres.mjs
// と同じロジック（将来ローカル実行する場合の参考用に.mjs版も残す）。
// Notion読み取りロジックは lib/db/notionMigrationSource.ts に共通化（検証用一時エンドポイント
// からも同じロジックを再利用するため）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { getPool } from "@/lib/db/pool";
import { SCHEMA_SQL } from "@/lib/db/schema";
import { fetchAllNotionTickets, fetchDiscussionBlocks } from "@/lib/db/notionMigrationSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  if (!notionToken || !notionDbId) {
    return NextResponse.json({ error: "NOTION_TOKEN or NOTION_DATABASE_ID not set" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const tickets = await fetchAllNotionTickets(notionToken, notionDbId);
  const invalid = tickets.filter((t) => t.ticketNumber == null);
  const valid = tickets.filter((t) => t.ticketNumber != null);

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      notionTotal: tickets.length,
      validCount: valid.length,
      invalidCount: invalid.length,
      invalidNotionPageIds: invalid.map((t) => t.notionPageId),
      sample: valid.slice(0, 2),
    });
  }

  const pool = getPool();
  await pool.query(SCHEMA_SQL);

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
         ON CONFLICT (notion_page_id) DO UPDATE SET
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
      if (wasInsert) inserted++;
      else updated++;

      if (wasInsert) {
        const blocks = await fetchDiscussionBlocks(notionToken, t.notionPageId);
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
      return NextResponse.json(
        {
          error: "migration failed",
          detail: (err as Error).message,
          progress: { inserted, updated, blocksInserted },
          failedNotionPageId: t.notionPageId,
        },
        { status: 500 }
      );
    } finally {
      client.release();
    }
  }

  const maxRes = await pool.query(`SELECT COALESCE(MAX(ticket_number), 0) AS max_num FROM tickets`);
  const maxNum = Number(maxRes.rows[0].max_num);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ticket_number_seq`);
  await pool.query(`SELECT setval('ticket_number_seq', $1, false)`, [maxNum + 1]);

  const countRes = await pool.query(`SELECT COUNT(*) AS c FROM tickets`);
  const pgCount = Number(countRes.rows[0].c);
  const countMatch = pgCount >= valid.length;

  return NextResponse.json({
    ok: countMatch,
    notionValidCount: valid.length,
    notionInvalidCount: invalid.length,
    invalidNotionPageIds: invalid.map((t) => t.notionPageId),
    postgresCount: pgCount,
    inserted,
    updated,
    blocksInserted,
    ticketNumberSeqStartsAt: maxNum + 1,
  });
}
