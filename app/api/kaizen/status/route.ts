/**
 * GET /api/kaizen/status
 * LINE 「カイゼン状況」コマンド用：簡潔な状況サマリを返す。
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchAllTickets } from "@/lib/tickets";
import { groupByState, countByState } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StatusSummary {
  ok: boolean;
  total: number;
  byCounts: Record<string, number>;
  /** GO待ちが 7 日以上停滞しているチケット */
  stalled: Array<{ ticketId: string; title: string; daysWaiting: number }>;
  /** シンプルなテキスト形式（LINE 返信用） */
  textSummary: string;
}

export async function GET(req: NextRequest) {
  try {
    const tickets = await fetchAllTickets();

    // 状態別集計
    const columns = groupByState(tickets, { includeEmpty: false });
    const counts = countByState(columns);

    // GO待ちが 7 日以上のチケットを検出（停滞チケット）
    const stallThresholdMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stalled = tickets
      .filter((t) => t.state === "GO待ち" && t.statusChangedAt)
      .map((t) => {
        const changedTime = new Date(t.statusChangedAt!).getTime();
        const daysWaiting = Math.floor((now - changedTime) / (24 * 60 * 60 * 1000));
        return { ticket: t, daysWaiting };
      })
      .filter(({ daysWaiting }) => daysWaiting >= 7)
      .map(({ ticket, daysWaiting }) => ({
        ticketId: ticket.ticketId,
        title: ticket.title,
        daysWaiting,
      }));

    // テキストサマリ（LINE 返信用）
    const lines: string[] = ["📊 カイゼン状況"];
    lines.push(`全${tickets.length}件`);
    lines.push("");

    // 主要な状態ごとの件数
    const mainStates = ["受付", "議論中", "GO待ち", "着手", "実装中", "レビュー", "完了"];
    for (const state of mainStates) {
      if (counts[state]) {
        const emoji =
          state === "受付"
            ? "📥"
            : state === "議論中"
              ? "💬"
              : state === "GO待ち"
                ? "✋"
                : state === "着手"
                  ? "🔧"
                  : state === "実装中"
                    ? "⚙️"
                    : state === "レビュー"
                      ? "🔍"
                      : state === "完了"
                        ? "✅"
                        : "•";
        lines.push(`${emoji} ${state}: ${counts[state]}`);
      }
    }

    // 停滞チケット表示
    if (stalled.length > 0) {
      lines.push("");
      lines.push("⚠️ GO待ち停滞（7日以上）");
      for (const s of stalled.slice(0, 3)) {
        lines.push(`  - ${s.ticketId}: ${s.title.slice(0, 30)}... (${s.daysWaiting}日)`);
      }
      if (stalled.length > 3) {
        lines.push(`  ... ほか ${stalled.length - 3} 件`);
      }
    }

    const textSummary = lines.join("\n");

    const result: StatusSummary = {
      ok: true,
      total: tickets.length,
      byCounts: counts,
      stalled,
      textSummary,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("/api/kaizen/status error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
