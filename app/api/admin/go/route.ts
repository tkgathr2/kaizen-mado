// ── POST /api/admin/go ── LINEを介さず直接GO/修正/却下を適用するデモ用エンドポイント ──
// CRON_SECRET 認証必須。通常フローのLINE webhookと同じ applyGoAction を呼ぶ。
// 用途：LINE未設定環境でのデモ・自動化テスト・切り分け検証。
import { NextRequest, NextResponse } from "next/server";
import { findGoMachiByTicketId, fetchTicketsByState } from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";
import type { GoAction } from "@/lib/line";
import { kickEndpoint } from "@/lib/trigger";
import { checkAdminGoAuth } from "@/lib/cronAuth";
import { waitUntil } from "@vercel/functions";
import { disambiguateGoTarget } from "@/lib/kaizen-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // GO奪取防止：共用CRON_SECRETから分離した専用認証。
  // 本番で ADMIN_GO_SECRET 未設定なら 404（口を塞ぎ存在も隠す）。設定時は x-admin-go-secret 必須。
  const auth = checkAdminGoAuth(req);
  if (auth === "disabled") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (auth !== "ok") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { ticketId?: string; action?: string; note?: string; recentContext?: string } = {};
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
  let disambiguationResult = null;

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
    if (rows.length === 1) {
      ticket = rows[0];
    } else {
      // 複数候補：recentContext があれば LLM で推定
      if (body.recentContext) {
        disambiguationResult = await disambiguateGoTarget(body.recentContext, rows);
        if (disambiguationResult) {
          ticket = rows.find((r) => r.ticketId === disambiguationResult!.ticketId) || null;
          if (!ticket) {
            return NextResponse.json(
              { error: "Disambiguation result ticket not found" },
              { status: 500 }
            );
          }
        }
      }

      // LLM 推定失敗 or recentContext なし：手動指定を促す
      if (!ticket) {
        return NextResponse.json(
          {
            error: `GO待ちが${rows.length}件あります。ticketId を指定してください`,
            candidates: rows.map((r) => ({ ticketId: r.ticketId, title: r.title, system: r.system })),
            hint: "または recentContext（直前のメッセージ）を含めると AI で推定します",
          },
          { status: 409 }
        );
      }
    }
  }

  const result = await applyGoAction(action, ticket, body.note);

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
    ...(disambiguationResult && {
      disambiguation: {
        confidence: disambiguationResult.confidence,
        reason: disambiguationResult.reason,
        hasMultipleCandidates: disambiguationResult.hasMultipleCandidates,
      },
    }),
  });
}
