/**
 * POST /api/board/action
 *
 * /board の GO/却下ボタンから呼ばれる。
 * LINE署名トークンで認証し、社長本人からの操作を確認。
 * 操作は applyGoAction を通して実行。
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyProposalToken } from "@/lib/line";
import { fetchTicketByPageId } from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";
import { isAuthorizedUser } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActionRequest {
  pageId: string;
  action: "go" | "reject";
  token: string; // LINE 署名トークン
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ActionRequest;
    const { pageId, action, token } = body;

    if (!pageId || !action || !token) {
      return NextResponse.json(
        { ok: false, error: "pageId, action, token が必須" },
        { status: 400 }
      );
    }

    // トークン検証（LINE 署名）
    const ticket = await fetchTicketByPageId(pageId);
    if (!ticket) {
      return NextResponse.json(
        { ok: false, error: "チケットが見つかりません" },
        { status: 404 }
      );
    }

    if (!verifyProposalToken(pageId, token, ticket.state)) {
      return NextResponse.json(
        { ok: false, error: "トークンが無効または期限切れです" },
        { status: 403 }
      );
    }

    // 操作を実行
    const result = await applyGoAction(action, ticket);

    return NextResponse.json({
      ok: result.ok,
      message: result.reply,
      newState: result.newState,
    });
  } catch (e) {
    console.error("[api/board/action] error:", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "操作に失敗しました" },
      { status: 500 }
    );
  }
}
