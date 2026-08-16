// ── 一時検証エンドポイント（社長指示DB移行・bug-check-lab High修正後の再検証用・検証後即削除） ──
// 本番CRON_SECRETはVercel CLIから読めない（Sensitive環境変数）ため、無認証で件数だけを
// 返す最小限のエンドポイントで dryRun 相当の検証を行う。本文（タイトル・内容・reporter等）は
// 一切返さない＝bug-check-lab High-4で問題視された「実データの無認証公開」は再発させない。
import { NextResponse } from "next/server";
import { fetchAllNotionTickets } from "@/lib/db/notionMigrationSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  if (!notionToken || !notionDbId) {
    return NextResponse.json({ error: "env not set" }, { status: 500 });
  }
  const tickets = await fetchAllNotionTickets(notionToken, notionDbId);
  const invalid = tickets.filter((t) => t.ticketNumber == null);
  const valid = tickets.filter((t) => t.ticketNumber != null);
  return NextResponse.json({
    notionTotal: tickets.length,
    validCount: valid.length,
    invalidCount: invalid.length,
  });
}
