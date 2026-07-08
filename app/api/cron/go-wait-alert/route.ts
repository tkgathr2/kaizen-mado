// ── GET /api/cron/go-wait-alert ── GO待ち24時間超過アラート（毎朝8時JST）──
// Vercel Cron が 08:00 JST（＝23:00 UTC・vercel.json "0 23 * * *"。notification-batch と
// 同じJST→UTC変換規則）に叩く。GO待ちのまま24時間を超えた案件をSlack #カイゼンくん へ通知する。
// 社長向けLINEダイジェスト（/api/cron/notification-batch）とは別レイヤー（開発チーム向け・Slack）。
// CRON_SECRET 認証必須（本番で未設定＝fail-closed）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { runGoWaitAlert } from "@/lib/goWaitAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動テストは POST でも可。
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
  const result = await runGoWaitAlert();
  const status = result.ok ? 200 : 502;
  return NextResponse.json(result, { status });
}
