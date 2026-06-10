// ── イベント駆動トリガ：自分自身の保護エンドポイントを起こす ──
// 起票直後に /api/process、GO検知直後に /api/execute を即起動するため、
// サーバ側から自分の保護GETを Authorization: Bearer CRON_SECRET で叩く。
// 呼び出し側は unstable_after で包み、利用者への応答をブロックしない。
// CRON_SECRET 未投入なら何もしない（cron と同じ fail-safe）。Vercel Cron は日次の安全網。
const DEFAULT_BASE = "https://kaizen.takagi.bz";

export function publicBase(): string {
  // 明示設定 > Vercel自動付与 > 既定
  const explicit = process.env.KAIZEN_PUBLIC_BASE;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return DEFAULT_BASE;
}

/**
 * 内部の保護GETエンドポイントを1回叩く（fire-and-forget 想定）。
 * 失敗してもthrowしない（呼び出し元のフローを壊さない）。鍵未設定なら no-op。
 */
export async function kickEndpoint(path: string): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  try {
    const res = await fetch(`${publicBase()}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[trigger] kick非2xx", { path, status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    console.error("[trigger] kick例外", { path, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
