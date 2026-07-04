// ── GET /api/cron/notification-batch ── 毎朝8時JSTの通知ダイジェスト送信 ──
// Vercel Cron が 08:00 JST（＝23:00 UTC・vercel.json "0 23 * * *"）に叩く。
// Notion（KAIZEN_DIGEST_PAGE_ID）に溜めた途中経過（着手/PR/完了/エラー/停滞）を
// 束ね・再送抑止のうえ、1通のダイジェストとして社長へ LINE 送信する。
//
// ★ 即時の判断要求／結末通知（GO伺い・完了・Merge待ち・詰まり）は別経路（notify.ts）で
//   従来どおり即時に届く。本 cron はそれと重複しない"日次まとめ"の追加レイヤー。
// ★ KAIZEN_DIGEST_PAGE_ID / LINE 未設定なら no-op（本番は明示設定するまで無効＝挙動不変）。
// CRON_SECRET 認証必須（本番で未設定＝fail-closed）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { runDailyNotificationBatch } from "@/lib/notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動は POST でも可。
export async function GET(req: NextRequest) {
  return handler(req);
}
export async function POST(req: NextRequest) {
  return handler(req);
}

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // cron スケジュール自体を「8時である」ことの権威とし、force で時刻ガードを飛ばす
  // （Vercel Cron の発火時刻ゆらぎで 08:30 を跨いでも取りこぼさない）。
  const result = await runDailyNotificationBatch({ force: true });
  const status = result.ok ? 200 : 502;
  return NextResponse.json({ ...result }, { status });
}
