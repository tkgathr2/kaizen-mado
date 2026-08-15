// 一時検証用エンドポイント（kind="stall"停滞リマインドFlexカードの本番テスト送信・検証後削除）。
import { NextResponse } from "next/server";
import { handoffStallToSanada } from "@/lib/handoff";

export async function GET() {
  const ok = await handoffStallToSanada({
    kind: "stall",
    ticketId: "KZ-TEST-STALL",
    title: "【検証用】kz-sweep停滞リマインドFlexカードの本番実測（後で削除）",
    system: "カイゼンくん本体",
    stallKind: "awaiting_go",
    stallPhase: "remind",
    elapsedHours: 50,
    autoCloseInHours: 118,
    ticketUrl: "https://www.notion.so/38c0d9808b3b8163b430e2942b412c1b",
  });
  return NextResponse.json({ ok });
}
