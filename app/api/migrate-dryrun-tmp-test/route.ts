// 一時検証用エンドポイント（Notion読み取りロジックのdryRun確認・検証後削除）。
import { NextResponse } from "next/server";
import { fetchAllNotionTickets } from "@/lib/db/notionMigrationSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const notionToken = process.env.NOTION_TOKEN;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  if (!notionToken || !notionDbId) {
    return NextResponse.json({ error: "NOTION_TOKEN or NOTION_DATABASE_ID not set" }, { status: 500 });
  }
  const tickets = await fetchAllNotionTickets(notionToken, notionDbId);
  const invalid = tickets.filter((t) => t.ticketNumber == null);
  const valid = tickets.filter((t) => t.ticketNumber != null);
  return NextResponse.json({
    notionTotal: tickets.length,
    validCount: valid.length,
    invalidCount: invalid.length,
    invalidNotionPageIds: invalid.map((t) => t.notionPageId),
    sampleTicketIds: valid.slice(0, 5).map((t) => `KZ-${t.ticketNumber}`),
  });
}
