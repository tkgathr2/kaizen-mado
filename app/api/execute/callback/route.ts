// ── POST /api/execute/callback ── 実行ワークフローからの結果通知を受ける ──
// .github/workflows/kaizen-execute.yml が PR→ゲート→マージ→デプロイ→ヘルスの結果を返す。
//  - merged    → 「完了」へ。学び還元(returnLearningFromCompleted)を回す。（FYI通知は新仕様で無し）
//  - review    → 「レビュー」へ。3条件ゲート不通過＝人の確認待ち。（FYI通知は新仕様で無し・/boardで確認）
//  - failed    → 「差し戻し」へ。実装失敗＝人の助けが要る詰まりとして「詰まり連絡」を1回だけLINE送信。
// ★ 新仕様：自分から送るLINEは「GO伺い」と「詰まり連絡」だけ。進捗FYI（着手/完了/PR完成）は送らない。
// 認証は CRON_SECRET（x-cron-secret）を流用。鍵未設定なら本番fail-closed。
import { NextRequest, NextResponse } from "next/server";
import {
  updateTicketState,
  appendDiscussionBlocks,
  fetchTicketByPageId,
} from "@/lib/tickets";
import { returnLearningFromCompleted } from "@/lib/learn";
import { notifyStuckOnce } from "@/lib/notify";
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
      // 新仕様：完了報告FYI（旧「🎉 直して反映しました」）は送らない（自分から送るLINEは
      // 「GO伺い」と「詰まり連絡」だけ）。状態遷移・学び還元は維持する。
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
      // 新仕様：PR完成FYI（旧「✅ 直せました（Merge押して）」）は送らない（自分から送るLINEは
      // 「GO伺い」と「詰まり連絡」だけ）。状態遷移は維持する（PRは /board で確認できる）。
      return NextResponse.json({ ok: true, state: "レビュー" });
    }

    // failed → 差し戻し。これは「人の助けが要る詰まり」として詰まり連絡を1回だけ送る。
    // ※ 真田が裏で直せるシステム故障（モデル切れ等の技術障害）と、人の助けが要る詰まりの
    //   自動切り分けは将来の死活監視で扱う＝今はスコープ外。ここでは failed をそのまま
    //   「人の助けが要る詰まり」として扱い、同じチケットでは1回だけ通知（de-dup）する。
    await updateTicketState(pageId, "差し戻し");
    await appendDiscussionBlocks(pageId, [
      { heading: "実装失敗（差し戻し）", body: detail || "(理由不明)" },
    ]);
    await notifyStuckOnce(current, detail || "不明（くわしくは /board をご確認ください）");
    return NextResponse.json({ ok: true, state: "差し戻し" });
  } catch (err) {
    console.error("[execute/callback] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
