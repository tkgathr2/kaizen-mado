// ── POST /api/execute/callback ── 実行ワークフローからの結果通知を受ける ──
// .github/workflows/kaizen-execute.yml が PR→ゲート→マージ→デプロイ→ヘルスの結果を返す。
//  - merged    → 「完了」へ。LINEで「直しました」を報告し、学び還元(returnLearningFromCompleted)を回す。
//  - review    → 「レビュー」へ。3条件ゲート不通過＝人の確認待ち。PR URLをLINEで知らせる。
//  - failed    → 「差し戻し」へ。実装失敗。理由をLINEで知らせる。
// 認証は CRON_SECRET（x-cron-secret）を流用。鍵未設定なら本番fail-closed。
import { NextRequest, NextResponse } from "next/server";
import {
  updateTicketState,
  appendDiscussionBlocks,
  fetchTicketByPageId,
} from "@/lib/tickets";
import { returnLearningFromCompleted } from "@/lib/learn";
import { pushText, truncateForLine } from "@/lib/line";
import { checkCronSecret } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Result = "merged" | "review" | "failed";

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
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

  // 状態ガード：実行中(実装中)のチケットにだけ結果を反映する。
  // 偽callback・リプレイで任意pageIdを「完了」に書き換えるのを防ぐ（CRON_SECRETに加えた多層防御）。
  let current;
  try {
    current = await fetchTicketByPageId(pageId);
  } catch (e) {
    console.error("[execute/callback] チケット取得失敗", (e as Error).message);
    return NextResponse.json({ ok: false, error: "ticket fetch failed" }, { status: 502 });
  }
  if (!current) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }
  if (current.state !== "実装中") {
    // 既に確定済み or 想定外状態 → 何もしない（冪等）。
    return NextResponse.json({ ok: true, skipped: true, state: current.state });
  }

  try {
    if (result === "merged") {
      await updateTicketState(pageId, "完了");
      await appendDiscussionBlocks(pageId, [
        { heading: "本番反映 完了", body: `自動改修→マージ→デプロイ完了。${prUrl}` },
      ]);
      await pushText(
        [`✅ 本番反映しました ${ticketId}｜${system}`, ``, `PR ▶ ${prUrl}`].join("\n")
      );
      // 学び還元（KNOWHOW_ENABLED時のみ実働。OFFなら no-op）。
      const learn = await returnLearningFromCompleted(5).catch(() => ({ memorized: 0 }));
      return NextResponse.json({ ok: true, state: "完了", learned: learn.memorized });
    }

    if (result === "review") {
      // PRレビュー型では「review」が通常の成功（AIがPRを作って人の確認待ち）。
      await updateTicketState(pageId, "レビュー");
      await appendDiscussionBlocks(pageId, [
        { heading: "PR作成（レビュー待ち）", body: `${detail}\nPR: ${prUrl}` },
      ]);
      await pushText(
        [
          `✅ PRができました ${ticketId}｜${system}`,
          ...(detail ? [`内容：${truncateForLine(detail, 60)}`] : []),
          ``,
          `差分を確認して「Merge」で本番反映されます。`,
          `PR ▶ ${prUrl}`,
        ].join("\n")
      );
      return NextResponse.json({ ok: true, state: "レビュー" });
    }

    // failed
    await updateTicketState(pageId, "差し戻し");
    await appendDiscussionBlocks(pageId, [
      { heading: "実装失敗（差し戻し）", body: detail || "(理由不明)" },
    ]);
    await pushText(
      [
        `🔴 直せませんでした ${ticketId}｜${system}`,
        `理由：${truncateForLine(detail || "不明", 60)}`,
        ``,
        `議論に戻しました。見直して再提案します。`,
      ].join("\n")
    );
    return NextResponse.json({ ok: true, state: "差し戻し" });
  } catch (err) {
    console.error("[execute/callback] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
