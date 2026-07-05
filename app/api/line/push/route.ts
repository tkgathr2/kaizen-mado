// ── LINE push エンドポイント（カイゼンくん自身から送る） ──
// checkLinePushAuth で認証：CRON_SECRET (x-cron-secret / Authorization: Bearer) に加え、
// 監視系クライアント専用の MONITOR_PUSH_SECRET (x-monitor-secret) も受ける（LINE通知のみの最小権限鍵）。
// mention-hisho への相乗りを廃止し、カイゼンくん固有の LINE チャンネルのみで送る（2026-06-28）。
import { NextRequest, NextResponse } from "next/server";
import { checkLinePushAuth } from "@/lib/cronAuth";
import { pushText } from "@/lib/line";

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

  const ok = await pushText(message);
  if (!ok) {
    return NextResponse.json({ error: "LINE send failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
