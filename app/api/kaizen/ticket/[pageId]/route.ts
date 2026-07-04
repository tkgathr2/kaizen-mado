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

// Notion pageId（32hex、ハイフンあり/なし両対応）。SSRF/パス注入・不正入力を入口で弾く。
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// 会話ログに書かれる送信者ラベル（webhook=user/assistant、line-chat API=user/assistant/system、和名も許容）。
const KNOWN_SENDERS = new Set(["user", "assistant", "system", "社長", "カイゼンくん"]);

/**
 * 「HH:MM(:SS)? sender: message」形式の1行をパースする。
 * - 秒あり（line-chat API は HH:MM:SS で書く）に対応。
 * - 本文に「https://…」等のコロンが含まれても本文側に残す（sender は非貪欲＋既知ラベル照合）。
 * - sender が既知ラベルでない（URL先頭など誤検出）行は sender="?" で全文を保持する。
 */
function parseChatLine(line: string): ChatEntry {
  const m = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)?\s*([^:]+?):\s*([\s\S]*)$/);
  if (m && KNOWN_SENDERS.has(m[2].trim())) {
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
    if (!pageId || !UUID_RE.test(pageId)) {
      return NextResponse.json({ error: "pageId が不正です" }, { status: 400 });
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
