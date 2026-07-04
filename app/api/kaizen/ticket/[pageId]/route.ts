/**
 * GET /api/kaizen/ticket/[pageId]
 * チケット詳細（状態問わず）+ LINE会話履歴を取得。チケット詳細ページ用。
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchTicketByPageId } from "@/lib/tickets";
import { getLineChat } from "@/lib/kaizen-notion";
import { notionUrlFromPageId } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatEntry {
  sender: string;
  text: string;
  time?: string;
}

/** 「HH:MM sender: message」形式の1行をパースする。形式が崩れていれば sender="?" で全文を text に入れる。 */
function parseChatLine(line: string): ChatEntry {
  const m = line.match(/^(\d{1,2}:\d{2})?\s*([^:]+):\s*(.*)$/);
  if (m) {
    return { time: m[1] || undefined, sender: m[2].trim(), text: m[3].trim() };
  }
  return { sender: "?", text: line };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { pageId } = await params;
    if (!pageId) {
      return NextResponse.json({ error: "pageId is required" }, { status: 400 });
    }

    const ticket = await fetchTicketByPageId(pageId);
    if (!ticket) {
      return NextResponse.json({ error: "チケットが見つかりません" }, { status: 404 });
    }

    const lineChat = await getLineChat(pageId);
    const chatLines = lineChat
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const chat = chatLines.map(parseChatLine);

    return NextResponse.json({
      ok: true,
      ticketId: ticket.ticketId,
      title: ticket.title,
      system: ticket.system,
      state: ticket.state,
      url: notionUrlFromPageId(ticket.pageId),
      chat,
      chatLineCount: chat.length,
    });
  } catch (error) {
    console.error("/api/kaizen/ticket/[pageId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
