// ── 一時実行エンドポイント（社長指示DB移行・本番CRON_SECRETがVercel CLIから読めないため
//    今回1回だけ使う代替経路・実行後即削除予定）。
// このプレビューデプロイはVercelのデプロイ保護（SSO）が既にかかっており、
// チームメンバー以外はアクセスできない。checkCronSecret（アプリ側認証）は
// あえて課さず、Vercel SSOのみに依存する（本番昇格routeとは別物・一時使用限定）。
import { NextRequest, NextResponse } from "next/server";
import { runMigration } from "@/lib/db/migrationRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  if (!notionToken || !notionDbId) {
    return NextResponse.json({ error: "NOTION_TOKEN or NOTION_DATABASE_ID not set" }, { status: 500 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await runMigration({ notionToken, notionDbId, dryRun });
  return NextResponse.json(result.body, { status: result.status });
}
