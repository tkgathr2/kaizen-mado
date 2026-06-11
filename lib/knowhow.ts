// ── ノウハウキング(knowhow) デュアルライト連動（第1.5段・方向②） ──
// 改善チケットDBへの起票が成功したあと、同じ内容を knowhow にも memorize して
// 「現場の声」を開発資産として貯める。Notion起票が主・knowhowは従＝失敗しても
// ユーザーには起票成功を返す（呼び出し側で fire-and-forget）。
//
// 設計判断: project_kaizen_knowhow_link_decision（真田裁定 2026-06-07）
// 仕様: HO-83 / スキル改修仕様v2（POST /api/devin/memorize）
import type { Ticket } from "./types";
import { maskPII } from "./pii";

const DEFAULT_BASE = "https://knowhow.up.railway.app";

/**
 * 起票済みチケットを knowhow に memorize する。
 * 連動が無効（NOTION相当のenv未設定）なら何もしない（no-op）。
 * 例外は投げず boolean を返す（呼び出し側は結果を待たなくてよい）。
 * 起票者名は送らない（knowhowは公開系で、人名は正規表現マスクで守れないため。仕様v2.0 §3）。
 */
export async function memorizeToKnowhow(
  ticket: Ticket,
  ticketId: string
): Promise<boolean> {
  // 明示的に有効化されていなければ連動しない（段階リリースのため既定OFF）
  if (process.env.KNOWHOW_ENABLED !== "true") return false;

  const base = process.env.KNOWHOW_API_BASE || DEFAULT_BASE;
  const projectKey = process.env.KNOWHOW_PROJECT_KEY || "cto-lab";

  // knowhowは認証ゼロで全公開 → PIIを必ずマスクしてから送る
  const safeDetail = maskPII(ticket.detail);
  const safeTitle = maskPII(ticket.title);

  const rawLog = [
    `【カイゼン窓口の声】${ticketId}`,
    `対象システム: ${ticket.system}`,
    `種別: ${ticket.type} / 重要度: ${ticket.importance}`,
    `件名: ${safeTitle}`,
    `内容: ${safeDetail}`,
  ].join("\n");

  const body = {
    project_key: projectKey,
    tool: "kaizen-mado",
    status: "success",
    raw_log: rawLog,
    tags: ["カイゼン窓口", ticket.system, ticket.type, ticket.importance],
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  // 将来 X-API-Key がONになったら env から付与（無改修で切替）
  if (process.env.KB_API_KEY) headers["X-API-Key"] = process.env.KB_API_KEY;

  try {
    const res = await fetch(`${base}/api/devin/memorize`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[knowhow] memorize failed ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[knowhow] memorize error:", (err as Error).message);
    return false;
  }
}
