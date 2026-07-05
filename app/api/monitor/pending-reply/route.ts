// ── POST /api/monitor/pending-reply ── 監視返信案の登録・承認実行 ──
// kaizen-monitor（ローカル常駐）が LINE 報告直後に返信案を保留登録する口。
// 認証は /api/line/push と同じ checkLinePushAuth（MONITOR_PUSH_SECRET / CRON_SECRET）。
// body.action = "approve" で最新保留の承認実行（E2E テスト・LINE webhook 以外からの手動承認用）。
import { NextRequest, NextResponse } from "next/server";
import { checkLinePushAuth } from "@/lib/cronAuth";
import {
  registerPendingReply,
  approveLatestPendingReply,
  sendMonitorReportAndRegister,
} from "@/lib/monitor-reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkLinePushAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    action?: string;
    report_text?: string;
    channel_id?: string;
    thread_ts?: string;
    draft?: string;
    source_text?: string;
    sender_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // 報告送信＋保留登録（LINE報告のメッセージIDを保留に紐付け＝引用返信での対象特定を可能にする）
  if (body.action === "report") {
    if (!body.report_text || !body.channel_id || !body.thread_ts || !body.draft) {
      return NextResponse.json(
        { error: "missing report_text/channel_id/thread_ts/draft" },
        { status: 400 }
      );
    }
    const r = await sendMonitorReportAndRegister({
      reportText: body.report_text,
      channelId: body.channel_id,
      threadTs: body.thread_ts,
      draft: body.draft,
      sourceText: body.source_text,
      senderId: body.sender_id,
    });
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id: r.id, line_message_id: r.lineMessageId });
  }

  // 承認実行（最新保留 → 真田Botでスレッド返信）
  if (body.action === "approve") {
    const r = await approveLatestPendingReply();
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, reason: r.reason, error: r.error },
        { status: r.reason === "no_pending" ? 404 : 502 }
      );
    }
    return NextResponse.json({ ok: true, permalink: r.permalink });
  }

  // 保留登録
  if (!body.channel_id || !body.thread_ts || !body.draft) {
    return NextResponse.json(
      { error: "missing channel_id/thread_ts/draft" },
      { status: 400 }
    );
  }
  const r = await registerPendingReply({
    channelId: body.channel_id,
    threadTs: body.thread_ts,
    draft: body.draft,
    sourceText: body.source_text,
  });
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, id: r.id });
}
