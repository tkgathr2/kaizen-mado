/**
 * GET /api/board/proposal-token?pageId=...
 *
 * /board から GO/却下ボタン用のトークンを取得。
 * LINE署名トークンと同じ形式で返す。
 */

import { NextRequest, NextResponse } from "next/server";
import { crypto } from "node:crypto";

const SECRET = process.env.LINE_CHANNEL_SECRET || "dev-secret";

/**
 * チケット ID と秘密鍵からトークンを生成（LINE signature と同じロジック）。
 */
function generateProposalToken(pageId: string, state: string): string {
  // HMAC-SHA256 でトークンを生成
  const data = `${pageId}:${state}`;
  const hmac = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("base64");
  return hmac;
}

export async function GET(req: NextRequest) {
  const pageId = req.nextUrl.searchParams.get("pageId");

  if (!pageId) {
    return NextResponse.json({ error: "pageId 必須" }, { status: 400 });
  }

  // pageId から チケットの状態を取得（Notion から簡易版）
  // ここでは "GO待ち" を固定（本番は fetchTicketByPageId から取得）
  const state = "GO待ち";

  const token = generateProposalToken(pageId, state);
  return NextResponse.json({ token, pageId, state });
}
