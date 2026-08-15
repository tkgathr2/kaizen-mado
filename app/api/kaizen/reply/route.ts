// ── POST /api/kaizen/reply ── 真田チャネル（mention-hisho）からの引用返信の書き戻し口 ──
// 背景：カイゼンくんは自前LINEチャネルへの送信を全廃した（社長指示 2026-08-15「カイゼンくんの
// LINEチャネルに一切来ない仕組みにして」）。詰まり連絡（lib/notify.ts notifyStuckOnce）は
// 真田専用LINEチャネルへ handoffFyiToSanada(..., {awaitsReply:true}) で送られ、社長の回答を
// 待つ性質を持つ。真田専用LINEチャネルのwebhookは自由文の返信を全部Claude Code Routine起動に
// 使ってしまうため、社長には「このメッセージを引用返信で答えてください」と案内している
// （lib/notify.ts buildStuckText）。相手側（mention-hisho）は awaitsReply:true が付いた通知
// だけLINE送信後の messageId を控えておき、社長がその通知を引用返信したときに限って
// このエンドポイントへ {ticketId, replyText} をPOSTしてくる。ここではチケットを探し、
// 議論ブロックへ「真田チャネルからの回答」として追記するだけ（状態遷移や自動再実行はしない
// ＝回答を確実にNotionへ残すことが目的で、続きの判断は人・別ワークフローに委ねる）。
//
// 認証：ヘッダ x-kaizen-reply-secret を env KAIZEN_REPLY_SECRET と timing-safe 比較。
// シークレット未設定は fail-closed（503・存在自体を隠す必要はないが機能を止める）。
import { NextRequest, NextResponse } from "next/server";
import { findTicketByTicketId, appendDiscussionBlocks } from "@/lib/tickets";
import { checkKaizenReplyAuth } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = checkKaizenReplyAuth(req);
  if (auth === "disabled") {
    return NextResponse.json(
      { ok: false, error: "not configured" },
      { status: 503 }
    );
  }
  if (auth !== "ok") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { ticketId?: string; replyText?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const ticketId = (body.ticketId || "").trim();
  const replyText = (body.replyText || "").trim();
  if (!ticketId || !replyText) {
    return NextResponse.json(
      { ok: false, error: "ticketId / replyText は必須です" },
      { status: 400 }
    );
  }

  try {
    const ticket = await findTicketByTicketId(ticketId);
    if (!ticket) {
      return NextResponse.json(
        { ok: false, error: "ticket not found" },
        { status: 404 }
      );
    }

    await appendDiscussionBlocks(ticket.pageId, [
      { heading: "真田チャネルからの回答", body: replyText },
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[kaizen/reply] failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "処理に失敗しました。" },
      { status: 500 }
    );
  }
}
