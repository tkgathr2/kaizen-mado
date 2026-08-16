// Notion → Postgres チケット移行の本体ロジック。認証済みの本番route
// （app/api/admin/migrate-tickets/route.ts）と、CRON_SECRETをVercel CLIから読めない
// 制約下での一時再検証route（用済み次第削除）の両方から呼べるよう共通化する。
import { getPool } from "@/lib/db/pool";
import { SCHEMA_SQL } from "@/lib/db/schema";
import { fetchAllNotionTickets, fetchDiscussionBlocks } from "@/lib/db/notionMigrationSource";

export interface MigrationResult {
  status: number;
  body: Record<string, unknown>;
}

export async function runMigration(opts: {
  notionToken: string;
  notionDbId: string;
  dryRun: boolean;
}): Promise<MigrationResult> {
  const { notionToken, notionDbId, dryRun } = opts;

  const tickets = await fetchAllNotionTickets(notionToken, notionDbId);
  const invalid = tickets.filter((t) => t.ticketNumber == null);
  const valid = tickets.filter((t) => t.ticketNumber != null);

  if (dryRun) {
    return {
      status: 200,
      body: {
        dryRun: true,
        notionTotal: tickets.length,
        validCount: valid.length,
        invalidCount: invalid.length,
        invalidNotionPageIds: invalid.map((t) => t.notionPageId),
        sample: valid.slice(0, 2),
      },
    };
  }

  const pool = getPool();
  await pool.query(SCHEMA_SQL);

  // 【bug-check-lab High-3対応・2026-08-16】デプロイ後・移行実行前に新規起票が
  // 発生していないか（notion_page_idがNULLの行）を確認し、あれば409で中止する。
  const orphanRes = await pool.query(
    `SELECT id, ticket_number FROM tickets WHERE notion_page_id IS NULL ORDER BY id ASC LIMIT 20`
  );
  if (orphanRes.rows.length > 0) {
    return {
      status: 409,
      body: {
        error: "new tickets already exist before migration ran",
        detail:
          "notion_page_idがNULLの行（＝移行前に作成された新規チケット）が既に存在します。" +
          "このまま移行するとticket_number衝突で失敗します。対応方針を確認してから再実行してください。",
        orphanCount: orphanRes.rows.length,
        orphanSample: orphanRes.rows,
      },
    };
  }

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
           line_chat, notion_page_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
           COALESCE($22::timestamptz, now()), COALESCE($23::timestamptz, now()))
         ON CONFLICT (notion_page_id) DO UPDATE SET
           system=EXCLUDED.system, type=EXCLUDED.type, importance=EXCLUDED.importance,
           title=EXCLUDED.title, detail=EXCLUDED.detail, reporter=EXCLUDED.reporter,
           state=EXCLUDED.state, assignee=EXCLUDED.assignee, fgs_url=EXCLUDED.fgs_url,
           pr_url=EXCLUDED.pr_url, urgency=EXCLUDED.urgency, importance_score=EXCLUDED.importance_score,
           priority=EXCLUDED.priority, priority_reason=EXCLUDED.priority_reason,
           status_changed_at=EXCLUDED.status_changed_at, slack_channel_id=EXCLUDED.slack_channel_id,
           slack_thread_ts=EXCLUDED.slack_thread_ts, slack_user_id=EXCLUDED.slack_user_id,
           line_chat=EXCLUDED.line_chat, updated_at=EXCLUDED.updated_at
         RETURNING id, (xmax = 0) AS was_insert`,
        [
          t.ticketNumber, t.system, t.type, t.importance, t.title, t.detail, t.reporter, t.state, t.assignee,
          t.fgsUrl, t.prUrl, t.urgency, t.importanceScore, t.priority, t.priorityReason,
          t.statusChangedAt, t.slackChannelId, t.slackThreadTs, t.slackUserId,
          t.lineChat, t.notionPageId, t.createdTime, t.lastEdited,
        ]
      );
      const ticketDbId = upsertRes.rows[0].id;
      const wasInsert = upsertRes.rows[0].was_insert;
      if (wasInsert) inserted++;
      else updated++;

      if (wasInsert) {
        const blocks = await fetchDiscussionBlocks(notionToken, t.notionPageId, { throwOnError: true });
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
      try {
        await client.query("ROLLBACK");
      } catch {
        // ROLLBACK自体の失敗（接続断等）は無視してエラーレスポンスは必ず返す。
      }
      return {
        status: 500,
        body: {
          error: "migration failed",
          detail: (err as Error).message,
          progress: { inserted, updated, blocksInserted },
          failedNotionPageId: t.notionPageId,
        },
      };
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
  const countMatch = pgCount === valid.length;

  return {
    status: 200,
    body: {
      ok: countMatch,
      notionValidCount: valid.length,
      notionInvalidCount: invalid.length,
      invalidNotionPageIds: invalid.map((t) => t.notionPageId),
      postgresCount: pgCount,
      inserted,
      updated,
      blocksInserted,
      ticketNumberSeqStartsAt: maxNum + 1,
    },
  };
}
