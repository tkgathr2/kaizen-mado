/**
 * POST /api/kaizen/line-chat
 * LINE メッセージをチケットの lineChat フィールドに追記。
 * LINE webhook → このエンドポイント で会話を DB 保存。
 */

import { NextRequest, NextResponse } from "next/server";
import { appendLineChat } from "@/lib/kaizen-notion";
import { findGoMachiByTicketId, fetchTicketsByState } from "@/lib/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface LineChatRequest {
  /** チケット ID（KZ-XX 形式）または Notion ページ ID */
  ticketId?: string;
  pageId?: string;
  /** ユーザーのメッセージ（またはボット返信） */
  message: string;
  /** 送信者（"user" or "assistant" など） */
  sender: "user" | "assistant" | "system";
  /** タイムスタンプ（ISO 文字列）。指定なければサーバー時刻を使用 */
  timestamp?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LineChatRequest;

    // チケット ID または pageId のいずれかは必須
    let pageId = body.pageId;
    if (!pageId && body.ticketId) {
      const ticket = await findGoMachiByTicketId(body.ticketId);
      if (!ticket) {
        return NextResponse.json(
          { error: `Ticket ${body.ticketId} not found` },
          { status: 404 }
        );
      }
      pageId = ticket.pageId;
    }

    if (!pageId) {
      return NextResponse.json(
        { error: "ticketId or pageId is required" },
        { status: 400 }
      );
    }

    if (!body.message) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 }
      );
    }

    // 時刻フォーマット：HH:MM または フルタイムスタンプ
    const ts = body.timestamp ? new Date(body.timestamp) : new Date();
    const timeStr = ts.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    // lineChat 行を構築：「HH:MM 送信者: メッセージ」
    const chatLine = `${timeStr} ${body.sender}: ${body.message}`;

    // Notion に追記
    const ok = await appendLineChat(pageId, chatLine);

    if (!ok) {
      return NextResponse.json(
        { error: "Failed to append lineChat to Notion" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      pageId,
      chatLine,
      timestamp: ts.toISOString(),
    });
  } catch (error) {
    console.error("/api/kaizen/line-chat error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
