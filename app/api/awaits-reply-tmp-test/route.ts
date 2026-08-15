// 一時検証用エンドポイント（awaitsReply:true のfyi handoff経路のテスト送信・検証後削除）。
import { NextResponse } from "next/server";
import { handoffFyiToSanada } from "@/lib/handoff";

export async function GET() {
  const ok = await handoffFyiToSanada(
    "KZ-TEST-AWAITSREPLY",
    "🧪 詰まり連絡テスト送信\nこれに引用返信（長押し→返信）すると、カイゼンくん側のPOST /api/kaizen/replyへ書き戻されるはずです。"
      + "\nこれを教えてください。引用返信で答えてください。",
    { awaitsReply: true }
  );
  return NextResponse.json({ ok });
}
