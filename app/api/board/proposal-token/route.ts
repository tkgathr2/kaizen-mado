/**
 * GET /api/board/proposal-token?pageId=...
 *
 * /board の GO/却下ボタン用トークンを発行する。
 *
 * ★認証必須（isAuthEnabled 時）：ログイン済みでなければ発行しない。
 *   無認証で誰でもトークンを取得できると、GO/却下の署名検証が認証境界として無意味になるため。
 * ★トークンは lib/line.ts の proposalToken() を使い、検証側 verifyProposalToken と必ず一致させる
 *   （旧実装は自前で HMAC を再計算しており、プレフィックス・エンコード・長さが検証側と食い違って
 *    ボタンが常に失敗していた）。
 * ★state は実チケット状態から取得（GO/却下後は失効＝事実上のワンタイム化）。
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAuthEnabled } from "@/lib/authz";
import { proposalToken } from "@/lib/line";
import { fetchTicketByPageId } from "@/lib/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Notion pageId（32hex、ハイフンあり/なし両対応）。SSRF/パス注入・不正入力を入口で弾く。
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  // 認証必須（有効時）：ログイン済みの社長のみトークンを取得できる。
  if (isAuthEnabled()) {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
    }
  }

  const pageId = req.nextUrl.searchParams.get("pageId");
  if (!pageId || !UUID_RE.test(pageId)) {
    return NextResponse.json({ error: "pageId が不正です" }, { status: 400 });
  }

  // 実チケット状態でトークンを発行（GO/却下で状態が変われば旧トークンは失効）。
  const ticket = await fetchTicketByPageId(pageId);
  if (!ticket) {
    return NextResponse.json({ error: "チケットが見つかりません" }, { status: 404 });
  }

  const token = proposalToken(pageId, ticket.state);
  if (!token) {
    return NextResponse.json(
      { error: "トークン生成に失敗しました（LINE_CHANNEL_SECRET 未設定）" },
      { status: 500 }
    );
  }
  return NextResponse.json({ token, pageId, state: ticket.state });
}
