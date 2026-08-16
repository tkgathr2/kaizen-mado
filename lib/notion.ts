// ── 改善チケットの起票（サーバ側のみ） ──
//
// 【2026-08-16 Notion API → Postgres(Railway) 移行】
// 起票先を Notion DB から Postgres（lib/db/schema.ts の tickets）へ移した。
// Notion への書き込みは一切行わない。ファイル名 lib/notion.ts は呼び出し元
// （app/api/submit・app/api/slack/events・app/api/line/webhook）が
// `@/lib/notion` から import しているため据え置く（呼び出し元は変更しない方針）。
// createTicket の名前・引数・戻り値（SubmitResult）は移行前と同一。
import type { Ticket } from "./types";
import { normalizeSystemForTicket } from "./systems";
import { getPool, ensureSchema } from "./db/pool";
import { mapTicketRow } from "./tickets";
import { ticketUrlOf } from "./handoff";

export interface SubmitResult {
  ticketId: string; // 例: "KZ-12"
  pageUrl: string;
  pageId: string;
}

/** 新規チケットの初期状態（Notion時代の 状態=受付 と同じ）。 */
const INITIAL_STATE = "受付";

/** ticket_number 採番の衝突リトライ回数。
 *
 * ★採番方式の判断（2026-08-16）：移行エンドポイント
 *   app/api/admin/migrate-tickets/route.ts は最後に `ticket_number_seq` を作って
 *   MAX+1 にsetvalしている。しかし本番起票がそのシーケンスに依存すると、
 *   **移行を流す前（新規DB・ローカル開発・テスト）はシーケンスが存在せず INSERT が落ちる**
 *   ＝起票が失敗して現場の声を取りこぼす。カイゼンくんの最優先は「声を絶対に落とさない」
 *   なので、シーケンスの有無に依存しない `MAX(ticket_number)+1` を採る。
 *   一意性の最終保証は schema.ts の UNIQUE 制約で、同時起票が重なったときだけ
 *   UNIQUE 違反(23505)を捕まえて番号を取り直す（起票は低頻度なのでこれで十分）。
 *   ＝シーケンスが有っても無くても正しく動く。 */
const TICKET_NUMBER_RETRIES = 5;

/**
 * 改善チケットDBに「状態=受付」で1件起票する。
 * @param ticket 会話から確定したチケット（slackChannelId等のSlackメタも含む）
 * @param reporter 起票者（任意。フォーム入力 or "現場フォーム" or "Slack:<@UXXX>"）
 */
export async function createTicket(
  ticket: Ticket,
  reporter: string | null
): Promise<SubmitResult> {
  await ensureSchema();

  const system = normalizeSystemForTicket(ticket.system);
  const title = (ticket.title || "改善のご要望").slice(0, 100);

  // Notion時代に best-effort（プロパティが無ければ落として再試行）で書いていた
  // 優先度スコアリング・Slackメタは、Postgres では列が常に存在するので素直に入れる。
  const values = [
    system,
    ticket.type,
    ticket.importance,
    title,
    ticket.detail,
    reporter?.trim() || "現場フォーム",
    INITIAL_STATE,
    typeof ticket.urgency === "number" ? ticket.urgency : null,
    typeof ticket.importanceScore === "number" ? ticket.importanceScore : null,
    ticket.priority ?? null,
    ticket.priorityReason ?? null,
    ticket.slackChannelId ?? null,
    ticket.slackThreadTs ?? null,
    ticket.slackUserId ?? null,
  ];

  const row = await insertTicket(values);
  const mapped = mapTicketRow(row);
  return {
    ticketId: mapped.ticketId,
    pageUrl: ticketPageUrl(mapped.pageId),
    pageId: mapped.pageId,
  };
}

/** tickets へ1件INSERTし、採番衝突(23505)だけリトライする。 */
async function insertTicket(values: any[]): Promise<any> {
  const sql = `
    INSERT INTO tickets (
      ticket_number, system, type, importance, title, detail, reporter, state,
      urgency, importance_score, priority, priority_reason,
      slack_channel_id, slack_thread_ts, slack_user_id
    ) VALUES (
      (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets),
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    RETURNING *`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < TICKET_NUMBER_RETRIES; attempt++) {
    try {
      const res = await getPool().query(sql, values);
      const row = res.rows?.[0];
      if (!row) throw new Error("INSERT が行を返しませんでした");
      return row;
    } catch (err) {
      lastErr = err;
      // 23505 = unique_violation。同時起票で同じ ticket_number を取った場合のみ再試行。
      if ((err as { code?: string })?.code !== "23505") throw err;
      console.warn(
        `[tickets] ticket_number 採番が衝突したため再試行します (${attempt + 1}/${TICKET_NUMBER_RETRIES})`
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("ticket_number の採番に失敗しました");
}

/** チケットの参照URL。Notion時代はNotionページURLを返していたが、正本がDBへ移ったので
 * カイゼンくん自身のチケット詳細画面（/board/ticket/[pageId]）を指す。
 * ベースURLが分からない環境では空文字（存在しないNotionリンクを作らない）。 */
/**
 * 【bug-check-lab Medium-5修正・2026-08-16】NEXT_PUBLIC_BASE_URL/VERCEL_URLという
 * このファイル独自のenv varを見ていたが、house標準は KAIZEN_PUBLIC_BASE
 * （lib/handoff.ts・lib/line.tsと同じ、既定値 https://kaizen.takagi.bz）。
 * ticketUrlOf に一本化する。
 */
function ticketPageUrl(pageId: string): string {
  return pageId ? ticketUrlOf(pageId) : "";
}
