// ── 一時検証: 久原さん複製通知の実送信テスト（社長指示・検証後削除）──
// 架空チケットデータで notifyKuharaCopy を直接叩き、実チケットには一切触れずに
// #真田さんカイゼンくんへのお知らせ（KAIZEN_KUHARA_SLACK_CHANNEL）へ複製投稿されるかを確認する。
//
// 【認証について】本来は checkCronSecret（x-cron-secret）に合わせる想定だったが、Vercel本番の
// CRON_SECRET は Sensitive 設定でCLIから値を読み出せない（意図的な仕様・回避しない）ため、
// このテスト専用エンドポイントに限り使い捨てのハードコードトークンで代替する。
// GETのみ・架空チケットのみ・実データへの副作用なし（Slack投稿1回のみ）という限定的な範囲であり、
// 検証完了後はこのファイルごと削除する前提。
const TEST_TOKEN = "kuhara-notify-check-20260822-x7f3q9pz";

import { NextRequest, NextResponse } from "next/server";
import { notifyKuharaCopy, buildKuharaGoText } from "@/lib/line";

export async function GET(req: NextRequest) {
  if (req.headers.get("x-test-token") !== TEST_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const fakeTicket = {
    ticketId: "KZ-TEST",
    system: "kaizen-mado",
    title: "カイゼンくん複製通知の実送信テスト（架空チケット・実データではありません）",
    pageId: "test-page-id",
  } as any;
  const fakeDiscuss = {
    problemPlain: "久原さんチャンネルへの複製投稿が実際に届くかの確認です。",
    recommendation: "このメッセージへの対応は不要です。",
  } as any;

  const sent = await notifyKuharaCopy("GO伺い", buildKuharaGoText(fakeTicket, fakeDiscuss));
  return NextResponse.json({ ok: true, sent });
}
