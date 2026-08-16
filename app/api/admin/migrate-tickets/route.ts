// ── 一時運用エンドポイント：Notion → Postgres チケット移行（社長指示 2026-08-16・検証後削除） ──
// 本番（Vercel）はNOTION_TOKEN/DATABASE_URL等のSensitive環境変数をCLIから引けないため、
// これらが実際に読める本番実行環境の中でこの移行を1回だけ動かす。
// 認証は既存のcron共通鍵（checkCronSecret・x-cron-secret）を流用（新規鍵を増やさない）。
// べき等（notion_page_idでUPSERT）・件数突合込み。scripts/migrate-tickets-to-postgres.mjs
// と同じロジック（将来ローカル実行する場合の参考用に.mjs版も残す）。
// 実処理本体は lib/db/migrationRunner.ts に共通化（一時検証routeとも共有するため）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { runMigration } from "@/lib/db/migrationRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  if (!notionToken || !notionDbId) {
    return NextResponse.json({ error: "NOTION_TOKEN or NOTION_DATABASE_ID not set" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await runMigration({ notionToken, notionDbId, dryRun });
  return NextResponse.json(result.body, { status: result.status });
}
