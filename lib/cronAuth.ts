// ── cron/内部エンドポイントの共通認証 ──
// CRON_SECRET を2方式で受ける：
//  - x-cron-secret: <secret>            （手動/自前cron）
//  - Authorization: Bearer <secret>     （Vercel Cron が自動付与）
// CRON_SECRET 未設定なら、環境に関わらず原則拒否（fail-closed）。
// preview/誤設定で内部APIが素通しになる事故を防ぐ。
// 開発の利便のためにだけ、明示フラグ ALLOW_INSECURE_CRON=1 のときに限り未設定でも通す。
import type { NextRequest } from "next/server";

export function checkCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // secret 未設定：明示的に許可された開発環境だけ通す。それ以外は拒否。
    return process.env.ALLOW_INSECURE_CRON === "1";
  }
  const x = req.headers.get("x-cron-secret");
  if (x && safeEqual(x, secret)) return true;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), secret)) {
    return true;
  }
  return false;
}

// 長さ非依存の簡易定数時間比較（タイミング差を減らす）。
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
