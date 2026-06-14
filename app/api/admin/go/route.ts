// ── POST /api/admin/go ── LINEを介さず直接GO/修正/却下を適用するデモ用エンドポイント ──
// CRON_SECRET 認証必須。通常フローのLINE webhookと同じ applyGoAction を呼ぶ。
// 用途：LINE未設定環境でのデモ・自動化テスト・切り分け検証。
import { NextRequest, NextResponse } from "next/server";
import { findGoMachiByTicketId, fetchTicketsByState } from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";
import type { GoAction } from "@/lib/line";
import { kickEndpoint } from "@/lib/trigger";
import { checkCronSecret } from "@/lib/cronAuth";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { ticketId?: string; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = body.action as GoAction | undefined;
  if (action !== "go" && action !== "fix" && action !== "reject") {
    return NextResponse.json(
      { error: 'action は "go" / "fix" / "reject" のいずれかを指定してください' },
      { status: 400 }
    );
  }

  let ticket = null;
  if (body.ticketId) {
    ticket = await findGoMachiByTicketId(body.ticketId);
    if (!ticket) {
      return NextResponse.json(
        { error: `GO待ちのチケット "${body.ticketId}" が見つかりませんでした` },
        { status: 404 }
      );
    }
  } else {
    const rows = await fetchTicketsByState("GO待ち", 5);
    if (rows.length === 0) {
      return NextResponse.json({ error: "GO待ちのチケットがありません" }, { status: 404 });
    }
    if (rows.length > 1) {
      return NextResponse.json(
        {
          error: `GO待ちが${rows.length}件あります。ticketId を指定してください`,
          tickets: rows.map((r) => ({ ticketId: r.ticketId, title: r.title, system: r.system })),
        },
        { status: 409 }
      );
    }
    ticket = rows[0];
  }

  const result = await applyGoAction(action, ticket);

  // GO→「着手」になったら即 /api/execute を起こして実改修へ
  if (result.newState === "着手") {
    waitUntil(kickEndpoint("/api/execute"));
  }

  return NextResponse.json({
    ok: result.ok,
    ticketId: ticket.ticketId,
    newState: result.newState,
    skipped: result.skipped,
    reply: result.reply,
  });
}
