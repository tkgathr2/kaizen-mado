// ── 成長ダッシュボード用の集計API ──
// middleware の保護対象（認証ONになれば自動でログイン必須になる）。
// Notion読取は重いので60秒キャッシュ（CDN/s-maxage）で叩きすぎを防ぐ。
import { NextResponse } from "next/server";
import { fetchAllTicketRows, aggregateTickets, maskStatsReporters } from "@/lib/stats";
import { isAuthEnabled } from "@/lib/authz";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await fetchAllTicketRows();
    const stats = aggregateTickets(rows);

    // ── 起票者(PII)漏えい防止 ──
    // 認証ON＋ログイン済みのときだけ起票者名(個人情報)を素で返す。それ以外（認証OFFや未ログイン）
    // ではマスクする。middleware は認証OFFの間 /api/stats を保護しないため、ここでも二重に守る。
    const authed = isAuthEnabled() && Boolean((await auth())?.user);
    const payload = authed ? stats : maskStatsReporters(stats);

    // PII（生の起票者名）を含む応答は共有キャッシュに載せない（private, no-store）。
    // マスク済み（PII無し）の応答だけ従来どおり CDN キャッシュ可。
    const cacheControl = authed
      ? "private, no-store"
      : "public, s-maxage=60, stale-while-revalidate=300";

    return NextResponse.json(payload, {
      headers: { "cache-control": cacheControl },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "stats error" },
      { status: 500 }
    );
  }
}
