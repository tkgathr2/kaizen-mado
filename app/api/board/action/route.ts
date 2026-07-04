/**
 * POST /api/board/action
 *
 * /board の GO/却下ボタンから呼ばれる。
 * LINE署名トークンで認証し、社長本人からの操作を確認。
 * 操作は applyGoAction を通して実行。
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAuthEnabled } from "@/lib/authz";
import { verifyProposalToken } from "@/lib/line";
import { fetchTicketByPageId } from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActionRequest {
  pageId: string;
  action: "go" | "reject";
  token: string; // LINE 署名トークン
}

export async function POST(req: NextRequest) {
  try {
    // 認証必須（有効時）：ログイン済みでなければ GO/却下（不可逆・自動改修起動）を実行させない。
    if (isAuthEnabled()) {
      const session = await auth();
      if (!session?.user) {
        return NextResponse.json({ ok: false, error: "認証が必要です" }, { status: 401 });
      }
    }

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
