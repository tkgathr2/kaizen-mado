// ── LINE push エンドポイント（カイゼンくん自身から送る） ──
// x-push-secret ヘッダーで CRON_SECRET 認証（相乗り禁止グランドルール 2026-06-28）。
// mention-hisho への相乗りを廃止し、カイゼンくん固有の LINE チャンネルのみで送る。
import { NextRequest, NextResponse } from "next/server";
import { pushText } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-push-secret");
  const expected = process.env.CRON_SECRET;
  if (!expected || secret !== expected) {
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
  const title = body.title ?? body.sender ?? "";
  const message = title ? `[${title}] ${raw}` : raw;

  const ok = await pushText(message);
  if (!ok) {
    return NextResponse.json({ error: "LINE send failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
