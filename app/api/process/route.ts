// ── POST /api/process ── 受付 → 議論中 → GO待ち（第2段=内部処理） ──
// 「受付」状態のチケットを順に処理し、CTO Agent Lab の議論結果をページに追記して
// 「GO待ち」へ進める。GO待ちにしたら、GO伺いを高木さん本人のLINEへpushする
// （対外・対人告知ではなく、社長への承認伺い1通。LINE鍵が未設定なら静かにスキップ）。
// CRON_SECRET が設定されていれば認証を要求（x-cron-secret または Vercel Cron の Bearer）。
import { NextRequest, NextResponse } from "next/server";
import {
  fetchTicketsByState,
  updateTicketState,
  appendDiscussionBlocks,
  setTicketAssignee,
} from "@/lib/tickets";
import { discussTicket } from "@/lib/discuss";
import { pushProposal } from "@/lib/line";
import { checkCronSecret } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動/自前cronは POST。どちらも同じ処理。
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let limit = 5;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.limit === "number" && body.limit > 0) {
      limit = Math.floor(body.limit);
    }
  } catch {
    // body 任意：なくてよい
  }

  try {
    const tickets = await fetchTicketsByState("受付", limit);
    const processed: { ticketId: string; recommendation: string; source: string; notified: boolean }[] = [];
    const errors: { ticketId: string; error: string }[] = [];

    for (const ticket of tickets) {
      try {
        // 議論中へ → 議論 → 結果追記 → 担当付与 → GO待ちへ
        await updateTicketState(ticket.pageId, "議論中");
        const d = await discussTicket(ticket);
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "方針", body: d.houshin },
          { heading: "工数見積", body: d.kousuu },
          { heading: "リスク", body: d.risks.length ? d.risks.map((r) => `・${r}`).join("\n") : "（特になし）" },
          { heading: "推奨", body: d.recommendation },
          { heading: "GO伺いドラフト（未送信）", body: d.goDraft },
        ]);
        await setTicketAssignee(ticket.pageId, "CTO Agent Lab");
        await updateTicketState(ticket.pageId, "GO待ち");
        // GO伺いを高木さん本人のLINEへpush（GO/修正/却下のボタン付き）。
        // LINE鍵未設定なら pushProposal は false を返すだけ（ループは止めない）。
        const pushed = await pushProposal(
          { ...ticket, state: "GO待ち" },
          d
        );
        processed.push({
          ticketId: ticket.ticketId,
          recommendation: d.recommendation,
          source: d.source,
          notified: pushed,
        });
      } catch (err) {
        // 1件失敗しても他を続行する
        errors.push({
          ticketId: ticket.ticketId,
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      count: processed.length,
      processed,
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    console.error("[process] failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "処理に失敗しました。" },
      { status: 500 }
    );
  }
}
