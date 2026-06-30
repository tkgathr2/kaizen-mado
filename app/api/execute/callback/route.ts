// ── POST /api/execute/callback ── 実行ワークフローからの結果通知を受ける ──
// .github/workflows/kaizen-execute.yml が PR→ゲート→マージ→デプロイ→ヘルスの結果を返す。
//  - merged    → 「完了」へ。学び還元(returnLearningFromCompleted)を回す。Slack起点なら完了返信も送る。
//              → 学びの記録は returnLearningFromCompleted（統一メモリ層）に一本化（Slack専用の別記録は持たない）。
//  - review    → 「レビュー」へ。3条件ゲート不通過＝人の確認待ち。（FYI通知は新仕様で無し・/boardで確認）
//  - failed    → 「差し戻し」へ。実装失敗＝人の助けが要る詰まりとして「詰まり連絡」を1回だけLINE送信。
// ★ 新仕様：自分から送るLINEは「GO伺い」と「詰まり連絡」だけ。進捗FYI（着手/完了/PR完成）は送らない。
// 認証は CRON_SECRET（x-cron-secret）を流用。鍵未設定なら本番fail-closed。
import { NextRequest, NextResponse } from "next/server";
import {
  updateTicketState,
  appendDiscussionBlocks,
  fetchTicketByPageId,
  setStatusChangedAt,
} from "@/lib/tickets";
import { returnLearningFromCompleted } from "@/lib/learn";
import { notifyStuckOnce } from "@/lib/notify";
import { checkCronSecret } from "@/lib/cronAuth";
import { isInfraError, buildInfraNoticeText, pushText } from "@/lib/line";
import { isValidFailureClass, FAILURE_CLASSES } from "@/lib/kz-state";
import { postToSlack } from "@/lib/slack";

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

  // ── Phase 1: failureClass バリデーション（result=failed のときは必須）──
  // failureClass が欠落・不正値のままログに残らないのを防ぐため、400で早期拒否する。
  // UNKNOWN の場合は evidenceLog（最低100字）を必須として無根拠の UNKNOWN 乱用を防ぐ。
  if (result === "failed") {
    const failureClass = body?.failureClass;
    if (!isValidFailureClass(failureClass)) {
      return NextResponse.json(
        {
          ok: false,
          error: `failureClass is required when result=failed. Must be one of: ${FAILURE_CLASSES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    if (failureClass === "UNKNOWN") {
      const evidenceLog: string = typeof body?.evidenceLog === "string" ? body.evidenceLog : "";
      if (evidenceLog.length < 100) {
        return NextResponse.json(
          {
            ok: false,
            error: "evidenceLog is required when failureClass=UNKNOWN (min 100 chars)",
          },
          { status: 400 }
        );
      }
    }
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
      await setStatusChangedAt(pageId); // Phase 1: 状態変更日時を記録
      await appendDiscussionBlocks(pageId, [
        { heading: "本番反映 完了", body: `自動改修→マージ→デプロイ完了。${prUrl}` },
      ]);

      // Slack起点チケットなら元のスレッドに完了通知を返信する（fail-safe）。
      // slackChannelId / slackThreadTs が揃っている場合のみ送信。
      if (current.slackChannelId && current.slackThreadTs) {
        await postToSlack(
          current.slackChannelId,
          current.slackThreadTs,
          `✅ ご指摘いただいた件（${ticketId}）、修正が完了しました。ご確認ください。`
        ).catch(() => false); // 投稿失敗はログのみ・フロー全体は止めない
      }

      // 完了通知をLINEに送る（GOを送った社長が結果を知れるようにする）
      await pushText(
        `✅ ${ticketId}（${system}）の改修が完了しました！本番に反映済みです。
${prUrl}`
      ).catch(() => false);
      // 学び還元（KNOWHOW_ENABLED時のみ実働。OFFなら no-op）
      const learn = await returnLearningFromCompleted(5).catch(() => ({ memorized: 0 }));
      return NextResponse.json({ ok: true, state: "完了", learned: learn.memorized });
    }

    if (result === "review") {
      // PRレビュー型では「review」が通常の成功（AIがPRを作って人の確認待ち）。
      await updateTicketState(pageId, "レビュー");
      await setStatusChangedAt(pageId); // Phase 1: 状態変更日時を記録
      await appendDiscussionBlocks(pageId, [
        { heading: "PR作成（レビュー待ち）", body: `${detail}\nPR: ${prUrl}` },
      ]);
      // PR作成通知をLINEに送る（人のマージが必要なケースで迷子にならないようにする）
      await pushText(
        `🔍 ${ticketId}（${system}）のPRができました。確認・マージをお願いします。
${prUrl}`
      ).catch(() => false);
      return NextResponse.json({ ok: true, state: "レビュー" });
    }

    // failed → 失敗の中身で2分岐する（KZ-9）。
    //  (A) 基盤エラー（認証/権限/設定系の仕組み側不調）：真田が裏で直せば再走できる。
    //      → 状態は「実装中」のまま保持（差し戻さない＝基盤復旧後に自動で再走できる）。
    //         社長LINEは「⚙️ 仕組み側の不調・自動で再挑戦」系に切り替える（「直せません」と出さない）。
    //  (B) それ以外（AI改修そのものの失敗）：従来どおり「差し戻し」＋詰まり連絡を1回だけ送る。
    if (isInfraError(detail)) {
      // 状態は変えない（実装中のまま）。経緯だけ議論に残し、復旧後の再走に備える。
      await appendDiscussionBlocks(pageId, [
        {
          heading: "基盤エラー（実装中のまま保持）",
          body: `仕組み側（認証/権限/設定）の不調で自動改修まで進めませんでした。基盤復旧後に再走します。\n詳細：${detail || "(理由不明)"}`,
        },
      ]);
      // 文面分岐：詰まり連絡ではなく「仕組み側の不調・自動で再挑戦」を送る。
      await pushText(buildInfraNoticeText(current)).catch(() => false);
      return NextResponse.json({ ok: true, state: "実装中", infra: true });
    }

    // (B) AI改修の失敗 → 差し戻し。「人の助けが要る詰まり」として詰まり連絡を1回だけ送る（de-dup）。
    await updateTicketState(pageId, "差し戻し");
    await setStatusChangedAt(pageId); // Phase 1: 状態変更日時を記録
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
