// ── LINE push エンドポイント（外部監視系クライアントからの汎用通知） ──
// checkLinePushAuth で認証：CRON_SECRET (x-cron-secret / Authorization: Bearer) に加え、
// 監視系クライアント専用の MONITOR_PUSH_SECRET (x-monitor-secret) も受ける（LINE通知のみの最小権限鍵）。
// 【社長指示 2026-08-15】カイゼンくん自前LINEチャネルへの送信は全廃。真田システム経由が本線、
// 失敗時はSlack警告（旧: mention-hishoへの相乗りを廃止しカイゼンくん固有チャンネルのみで送る
// という2026-06-28の決定を、本件で再度上書きする）。
import { NextRequest, NextResponse } from "next/server";
import { checkLinePushAuth } from "@/lib/cronAuth";
import { notifySlackAlert } from "@/lib/line";
import { handoffFyiToSanada } from "@/lib/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINE_TEXT_MAX = 5000;

export async function POST(req: NextRequest) {
  if (!checkLinePushAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { text?: string; message?: string; sender?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const raw = body.text ?? body.message ?? "";
  if (!raw || typeof raw !== "string") {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
  }

  // title があれば先頭に付ける（task-complete.ps1 の [Claude Code] プレフィクス互換）
  const titleRaw = typeof body.title === "string" ? body.title
                 : typeof body.sender === "string" ? body.sender : "";
  const title = titleRaw.replace(/[\r\n\t]/g, " ").trim().slice(0, 40);
  const message = title ? `[${title}] ${raw}` : raw;

  if (message.length > LINE_TEXT_MAX) {
    return NextResponse.json(
      { error: "text too long", max: LINE_TEXT_MAX, got: message.length },
      { status: 400 }
    );
  }

  // ticketId概念が無い外部通知のため、合成IDで冪等キーを作る（同一内容の連投を弾く）。
  const pushId = `external-push:${title || "untitled"}`;
  const handed = await handoffFyiToSanada(pushId, message).catch(() => false);
  if (!handed) {
    const alerted = await notifySlackAlert(
      `外部通知（${title || "無題"}）を真田チャネルへ送れませんでした。text: ${message.slice(0, 100)}`,
      "⚠️ 外部通知が真田チャネルへ送れませんでした"
    ).catch(() => false);
    if (!alerted) {
      return NextResponse.json({ error: "send failed" }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true });
}
