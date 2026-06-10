// ── 成長ダッシュボード用の集計API ──
// middleware の保護対象（認証ONになれば自動でログイン必須になる）。
// Notion読取は重いので60秒キャッシュ（CDN/s-maxage）で叩きすぎを防ぐ。
import { NextResponse } from "next/server";
import { fetchAllTicketRows, aggregateTickets } from "@/lib/stats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await fetchAllTicketRows();
    const stats = aggregateTickets(rows);
    return NextResponse.json(stats, {
      headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "stats error" },
      { status: 500 }
    );
  }
}
