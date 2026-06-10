// ── POST /api/execute/callback ── 実行ワークフローからの結果通知を受ける ──
// .github/workflows/kaizen-execute.yml が PR→ゲート→マージ→デプロイ→ヘルスの結果を返す。
//  - merged    → 「完了」へ。LINEで「直しました」を報告し、学び還元(returnLearningFromCompleted)を回す。
//  - review    → 「レビュー」へ。3条件ゲート不通過＝人の確認待ち。PR URLをLINEで知らせる。
//  - failed    → 「差し戻し」へ。実装失敗。理由をLINEで知らせる。
// 認証は CRON_SECRET（x-cron-secret）を流用。鍵未設定なら本番fail-closed。
import { NextRequest, NextResponse } from "next/server";
import { updateTicketState, appendDiscussionBlocks } from "@/lib/tickets";
import { returnLearningFromCompleted } from "@/lib/learn";
import { pushText } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-cron-secret") === secret;
}

type Result = "merged" | "review" | "failed";

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const pageId: string = body?.pageId || "";
  const ticketId: string = body?.ticketId || "(?)";
  const result: Result = body?.result;
  const prUrl: string = body?.prUrl || "";
  const system: string = body?.system || "";
  const detail: string = typeof body?.detail === "string" ? body.detail.slice(0, 400) : "";

  if (!pageId || (result !== "merged" && result !== "review" && result !== "failed")) {
    return NextResponse.json({ error: "missing pageId/result" }, { status: 400 });
  }

  try {
    if (result === "merged") {
      await updateTicketState(pageId, "完了");
      await appendDiscussionBlocks(pageId, [
        { heading: "本番反映 完了", body: `自動改修→マージ→デプロイ完了。${prUrl}` },
      ]);
      await pushText(
        `✅ 直しました（${ticketId}）\n対象: ${system}\n本番反映まで完了しました。\n${prUrl}`
      );
      // 学び還元（KNOWHOW_ENABLED時のみ実働。OFFなら no-op）。
      const learn = await returnLearningFromCompleted(5).catch(() => ({ memorized: 0 }));
      return NextResponse.json({ ok: true, state: "完了", learned: learn.memorized });
    }

    if (result === "review") {
      await updateTicketState(pageId, "レビュー");
      await appendDiscussionBlocks(pageId, [
        { heading: "人の確認待ち（ゲート不通過）", body: `${detail}\nPR: ${prUrl}` },
      ]);
      await pushText(
        `🟡 レビューが必要です（${ticketId}）\n対象: ${system}\n` +
          `自動ゲートを通らなかったため、PRを残しました。確認をお願いします。\n${prUrl}`
      );
      return NextResponse.json({ ok: true, state: "レビュー" });
    }

    // failed
    await updateTicketState(pageId, "差し戻し");
    await appendDiscussionBlocks(pageId, [
      { heading: "実装失敗（差し戻し）", body: detail || "(理由不明)" },
    ]);
    await pushText(
      `🔴 実装に失敗しました（${ticketId}）\n対象: ${system}\n理由: ${detail || "不明"}\n差し戻しました。`
    );
    return NextResponse.json({ ok: true, state: "差し戻し" });
  } catch (err) {
    console.error("[execute/callback] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
