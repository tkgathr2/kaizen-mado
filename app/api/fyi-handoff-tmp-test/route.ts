// 一時検証用エンドポイント（真田handoff fyi経路のテスト送信・検証後削除）。
import { NextResponse } from "next/server";
import { handoffFyiToSanada } from "@/lib/handoff";

export async function GET() {
  const ok = await handoffFyiToSanada(
    "KZ-TEST-FYI",
    "🧪 fyi handoffテスト送信\nこれが真田専用LINEチャネル（トークルーム「真田」）に届いていればOKです。"
  );
  return NextResponse.json({ ok });
}
