// ── GET /api/admin/line-check ── LINE設定の診断エンドポイント ──
// CRON_SECRET 認証必須。鍵の「有無」だけ返す（値は絶対に返さない）。
// 用途：LINE webhook 401 の切り分け（どのキーが未設定か確認する）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { lineEnabled } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const keys = {
    LINE_CHANNEL_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    LINE_CHANNEL_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
    LINE_TARGET_USER_ID: Boolean(process.env.LINE_TARGET_USER_ID),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    KAIZEN_DISTILL_ENABLED: process.env.KAIZEN_DISTILL_ENABLED ?? "(未設定)",
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
    GOOGLE_GENERATIVE_AI_API_KEY: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    GITHUB_DISPATCH_TOKEN: Boolean(process.env.GITHUB_DISPATCH_TOKEN),
    KAIZEN_AUTOPILOT: process.env.KAIZEN_AUTOPILOT ?? "(未設定=デフォルトON)",
  };

  return NextResponse.json({
    lineEnabled: lineEnabled(),
    keys,
    diagnosis: !keys.LINE_CHANNEL_SECRET
      ? "LINE_CHANNEL_SECRET 未設定 → webhook 401 の原因"
      : !keys.LINE_CHANNEL_ACCESS_TOKEN
        ? "LINE_CHANNEL_ACCESS_TOKEN 未設定 → 送信不可"
        : !keys.LINE_TARGET_USER_ID
          ? "LINE_TARGET_USER_ID 未設定 → 送信先不明"
          : "LINE設定OK（401が続くならLINE DevelopersでChannel Secretを再確認）",
  });
}
