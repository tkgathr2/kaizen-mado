// ── 一時検証エンドポイント（社長指示「テストで送って」・詰まり通知の重複防止を本番で実地検証・検証後即削除） ──
// middleware.tsのmatcherで/api/adminは元々除外されておりNextAuthの対象外。
// 本番カスタムドメイン(kaizen.takagi.bz)はVercel SSO対象外(all_except_custom_domains設定)。
// checkCronSecretはあえて課さず、この一時ルート自体を検証後すぐ削除することで安全性を担保する。
import { NextResponse } from "next/server";
import { fetchTicketByPageId, hasDiscussionHeading } from "@/lib/tickets";
import { notifyStuckOnce } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// KZ-138（既存のテスト用チケット・却下済みで実運用に影響しない）
const TEST_PAGE_ID = "3bb0d980-8b3b-818e-85b6-f1cb622d3521";

export async function GET() {
  const ticket = await fetchTicketByPageId(TEST_PAGE_ID);
  if (!ticket) {
    return NextResponse.json({ error: "test ticket not found" }, { status: 404 });
  }

  const beforeMarker = await hasDiscussionHeading(TEST_PAGE_ID, "詰まり通知済み");
  const firstSend = await notifyStuckOnce(ticket, "【テスト送信・DB移行後の重複防止検証】社長指示によるテスト");
  const afterFirstMarker = await hasDiscussionHeading(TEST_PAGE_ID, "詰まり通知済み");
  const secondSend = await notifyStuckOnce(ticket, "【テスト送信2回目・重複防止確認】");

  return NextResponse.json({
    ticketId: ticket.ticketId,
    beforeMarker,
    firstSend,
    afterFirstMarker,
    secondSend,
    dedupWorking: firstSend === true && secondSend === false,
  });
}
