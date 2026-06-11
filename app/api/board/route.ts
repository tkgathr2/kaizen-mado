// ── GET /api/board ── 状況ダッシュボード用：チケットを状態ごとに返す（読み取り専用） ──
// /board ページがポーリングで叩く。Notion未設定でも 200 で空を返す（窓口を止めない fail-safe）。
// 機微情報(detail等)は lib/board.toBoardCard で落としているため、現状の公開設定でも安全。
// 認証はページと同じ（middleware）。鍵が入ってGoogle認証ONになれば /board ごと保護される。
import { NextResponse } from "next/server";
import { fetchAllTickets } from "@/lib/tickets";
import { groupByState, countByState } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);
}

export async function GET() {
  if (!notionConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      columns: [],
      counts: {},
      total: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const tickets = await fetchAllTickets(100);
    const columns = groupByState(tickets, { includeEmpty: true });
    return NextResponse.json({
      ok: true,
      configured: true,
      columns,
      counts: countByState(columns),
      total: tickets.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/board] failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "チケットの取得に失敗しました。" },
      { status: 502 }
    );
  }
}
