// ── Phase 3：recall（仕様v2.0 §2） ──
// 窓口チャットが confirm（要約確認）に進む直前に1回だけ、knowhow から類似の
// 声・学びを検索し、利用者への返答に一言添える。
// 守り（会話体験を recall の都合で壊さない）：
//  - 既定OFF（KAIZEN_RECALL_ENABLED !== "true" なら何もしない）
//  - タイムアウト1.5秒・失敗は無言スキップ（空配列を返すだけ）
import type { Ticket } from "./types";

const DEFAULT_BASE = "https://knowhow.up.railway.app";
const TIMEOUT_MS = 1500;

export interface RecallHit {
  content: string;
  score: number;
  tags: string[];
}

export function isRecallEnabled(): boolean {
  return process.env.KAIZEN_RECALL_ENABLED === "true";
}

/** knowhow に類似ノウハウを問い合わせる。無効・失敗・0件はすべて [] */
export async function recallSimilar(ticket: Ticket, topK = 3): Promise<RecallHit[]> {
  if (!isRecallEnabled()) return [];

  const base = process.env.KNOWHOW_API_BASE || DEFAULT_BASE;
  const projectKey = process.env.KNOWHOW_PROJECT_KEY || "cto-lab";
  const query = `${ticket.system} ${ticket.title} ${ticket.detail}`.slice(0, 500);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.KB_API_KEY) headers["X-API-Key"] = process.env.KB_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/devin/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_key: projectKey, query, top_k: topK }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .filter((r: any) => typeof r?.content === "string" && r.content.trim())
      .map((r: any) => ({
        content: String(r.content),
        score: Number(r.score) || 0,
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      }));
  } catch {
    return []; // タイムアウト・通信失敗は無言スキップ（会話を止めない）
  } finally {
    clearTimeout(timer);
  }
}

/** recall結果を利用者向けの一言に整形する。0件なら null */
export function buildRecallNote(hits: RecallHit[]): string | null {
  if (!hits.length) return null;
  const top = hits[0].content.replace(/\s+/g, " ").trim().slice(0, 90);
  const count = hits.length;
  return `💡 参考：似た声・ノウハウが過去に${count}件見つかりました（例：「${top}…」）。重複していても遠慮なくこのまま送ってください。件数が多い声ほど優先されます。`;
}
