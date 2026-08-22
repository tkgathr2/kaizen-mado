// ── 一時検証: 久原さん複製通知の実送信テスト（社長指示・検証後削除）──
// 架空チケットデータで notifyKuharaCopy を直接叩き、実チケットには一切触れずに
// #真田さんカイゼンくんへのお知らせ（KAIZEN_KUHARA_SLACK_CHANNEL）へ複製投稿されるかを確認する。
// 認証は他の内部エンドポイントと同じ checkCronSecret（x-cron-secret）。
import { NextRequest, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/cronAuth";
import { notifyKuharaCopy, buildKuharaGoText } from "@/lib/line";

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
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
