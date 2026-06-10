// ── cron/内部エンドポイントの共通認証 ──
// CRON_SECRET を2方式で受ける：
//  - x-cron-secret: <secret>            （手動/自前cron）
//  - Authorization: Bearer <secret>     （Vercel Cron が自動付与）
// 本番で CRON_SECRET 未設定なら fail-closed（false）。開発(NODE_ENV!==production)は通す。
import type { NextRequest } from "next/server";

export function checkCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
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
