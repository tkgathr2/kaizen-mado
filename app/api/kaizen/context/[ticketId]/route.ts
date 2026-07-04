/**
 * GET /api/kaizen/context/[ticketId]
 * チケットの LINE 会話履歴と現在の状態を取得（AI 推論や UI 表示用コンテキスト）。
 */

import { NextRequest, NextResponse } from "next/server";
import { findGoMachiByTicketId, fetchTicketsByState, fetchTicketByPageId } from "@/lib/tickets";
import { getLineChat } from "@/lib/kaizen-notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ContextResponse {
  ok: boolean;
  ticketId: string;
  title: string;
  system: string;
  state: string;
  /** チケットの最新 LINE 会話ログ */
  lineChat: string;
  /** 会話行数 */
  chatLineCount: number;
  /** 直近 3 行の会話（最新の文脈） */
  recentContext: string[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const resolvedParams = await params;
    const ticketId = resolvedParams.ticketId;
    if (!ticketId) {
      return NextResponse.json(
        { error: "ticketId is required" },
        { status: 400 }
      );
    }

    // チケット取得
    const ticket = await findGoMachiByTicketId(ticketId);
    if (!ticket) {
      return NextResponse.json(
        { error: `Ticket ${ticketId} not found or not in GO待ち state` },
        { status: 404 }
      );
    }

    // LINE チャット履歴取得
    const lineChat = await getLineChat(ticket.pageId);
    const chatLines = lineChat
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);

    // 直近 3 行の文脈
    const recentContext = chatLines.slice(-3);

    const result: ContextResponse = {
      ok: true,
      ticketId: ticket.ticketId,
      title: ticket.title,
      system: ticket.system,
      state: ticket.state,
      lineChat,
      chatLineCount: chatLines.length,
      recentContext,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error(`/api/kaizen/context/[ticketId] error:`, error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
