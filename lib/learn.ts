// ── ⑧ 完了チケット → 学び還元（knowhowへ memorize） ──
// 完了済みかつ未学習のチケットを knowhow に memorize して開発資産として貯める。
// 段階リリースのため既定OFF（KNOWHOW_ENABLED !== "true" なら no-op）。
// knowhow送信は認証ゼロで全公開 → PIIを必ずマスクしてから送る。
// memorize成功した行のみ FGSリンクに冪等マークを付け、次回 is_empty から外す。
import { maskPII } from "./pii";
import {
  fetchCompletedUnlearned,
  setTicketUrlField,
  type TicketRow,
} from "./tickets";

const DEFAULT_BASE = "https://knowhow.up.railway.app";
const MEMORIZED_MARK = "knowhow://memorized";

/** 完了チケットを knowhow に memorize する。成功したら true */
async function memorizeCompleted(ticket: TicketRow): Promise<boolean> {
  const base = process.env.KNOWHOW_API_BASE || DEFAULT_BASE;
  const projectKey = process.env.KNOWHOW_PROJECT_KEY || "cto-lab";

  const safeTitle = maskPII(ticket.title);
  const safeDetail = maskPII(ticket.detail);

  const rawLog = [
    `【完了カイゼン】${ticket.ticketId}`,
    `対象: ${ticket.system}`,
    `種別: ${ticket.type} / 重要度: ${ticket.importance}`,
    `件名: ${safeTitle}`,
    `内容: ${safeDetail}`,
    `学び: 現場の声を起点に改善を完了。再発防止・横展開の観点で活用する。`,
  ].join("\n");

  const body = {
    project_key: projectKey,
    tool: "kaizen-mado",
    status: "success",
    raw_log: rawLog,
    tags: ["完了カイゼン", ticket.system, ticket.type, ticket.importance],
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.KB_API_KEY) headers["X-API-Key"] = process.env.KB_API_KEY;

  try {
    const res = await fetch(`${base}/api/devin/memorize`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[learn] memorize failed ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[learn] memorize error:", (err as Error).message);
    return false;
  }
}

/**
 * 完了済み未学習チケットを knowhow に還元する。
 * 既定OFF（KNOWHOW_ENABLED !== "true"）なら {memorized:0, skipped:"disabled"}。
 */
export async function returnLearningFromCompleted(
  limit = 10
): Promise<{ memorized: number; skipped?: string }> {
  if (process.env.KNOWHOW_ENABLED !== "true") {
    return { memorized: 0, skipped: "disabled" };
  }

  const rows = await fetchCompletedUnlearned(limit);
  let memorized = 0;

  for (const row of rows) {
    const ok = await memorizeCompleted(row);
    if (!ok) continue; // 失敗は握りつぶし＝マークしない→次回再試行
    try {
      await setTicketUrlField(row.pageId, MEMORIZED_MARK);
      memorized += 1;
    } catch (err) {
      // マーク失敗は次回再送（二重送信は許容＝重複より取りこぼし回避を優先）
      console.error("[learn] mark failed:", (err as Error).message);
    }
  }

  return { memorized };
}
