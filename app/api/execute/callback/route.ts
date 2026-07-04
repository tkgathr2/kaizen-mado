// ── POST /api/execute/callback ── 実行ワークフローからの結果通知を受ける ──
// .github/workflows/kaizen-execute.yml が PR→ゲート→マージ→デプロイ→ヘルスの結果を返す。
//  - merged    → 「完了」へ。学び還元(returnLearningFromCompleted)を回す。Slack起点なら完了返信も送る。
//              → 学びの記録は returnLearningFromCompleted（統一メモリ層）に一本化（Slack専用の別記録は持たない）。
//  - review    → 「レビュー」へ。自動マージ条件を満たさず人のMerge待ち。「Merge待ちLINE」を1回だけ送る。
//  - failed    → 「差し戻し」へ。実装失敗＝人の助けが要る詰まりとして「詰まり連絡」を1回だけLINE送信。
//  - closed    → 「却下」へ。人がPRをマージせずクローズ（review-syncが検知）。LINEなし。
// ★ 通知方針（社長指示 2026-07-03「GOしたのに完了/停止が分からない」で改定）：
//   GO後の結末（反映しました／Merge待ち／詰まり）は必ず1回LINEで知らせる。途中経過FYIは送らない。
// 認証は CRON_SECRET（x-cron-secret）を流用。鍵未設定なら本番fail-closed。
import { NextRequest, NextResponse } from "next/server";
import {
  updateTicketState,
  appendDiscussionBlocks,
  fetchTicketByPageId,
  setStatusChangedAt,
} from "@/lib/tickets";
import { returnLearningFromCompleted } from "@/lib/learn";
import { notifyStuckOnce, notifyReviewOnce, buildMergedText } from "@/lib/notify";
import { checkCronSecret } from "@/lib/cronAuth";
import { isInfraError, buildInfraNoticeText, pushText } from "@/lib/line";
import { isValidFailureClass, type FailureClass } from "@/lib/kz-state";
import { postToSlack } from "@/lib/slack";
import { enqueueNotification } from "@/lib/notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// closed = 人がPRをマージせずクローズした（review-sync が検知）→ 却下へ。
type Result = "merged" | "review" | "failed" | "closed";

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

  if (
    !pageId ||
    (result !== "merged" && result !== "review" && result !== "failed" && result !== "closed")
  ) {
    return NextResponse.json({ error: "missing pageId/result" }, { status: 400 });
  }

  // ── failureClass の吸収（result=failed のとき）──
  // 旧実装は「欠落・不正値なら400で早期拒否」だったが、ワークフロー側が failureClass を
  // 送っていなかったため、失敗callbackが全部400で捨てられ→チケットは「実装中」のまま→
  // reaperが「着手」へ戻す→再実行→また失敗… という【無限の無音リトライ】になっていた
  // （社長指摘 2026-07-03「止まっていても連絡がない」の直接原因）。
  // 通知経路は絶対に塞がない＝欠落・不正値は UNKNOWN に丸めて受理し、警告ログだけ残す（fail-open）。
  let failureClass: FailureClass = "UNKNOWN";
  if (result === "failed") {
    if (isValidFailureClass(body?.failureClass)) {
      failureClass = body.failureClass;
    } else {
      console.warn(
        `[execute/callback] failureClass 欠落/不正（UNKNOWN扱いで続行）: ${ticketId}`,
        String(body?.failureClass ?? "(なし)")
      );
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
  // 受け入れ可能な現在状態（result別）：
  //  - merged … 実装中（自動マージ完走）に加え「レビュー」も許す＝人がPRをMergeした場合
  //             （review-sync が検知して merged を送る。従来はレビューのまま永久滞留していた）。
  //  - closed … 「レビュー」のみ＝人がPRをマージせずクローズ→却下へ。
  //  - review/failed … 従来どおり「実装中」のみ（偽callback・リプレイ防御を維持）。
  const allowedStates: string[] =
    result === "merged" ? ["実装中", "レビュー"] : result === "closed" ? ["レビュー"] : ["実装中"];
  if (!allowedStates.includes(current.state)) {
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

      // 完了報告LINE（社長指示 2026-07-03「GOしたのに完了したか分からない」対策）。
      // GO済み案件の終点なので1回だけ・fail-safe（送信失敗でもループは止めない）。
      await pushText(buildMergedText(current, prUrl)).catch(() => false);
      // 日次ダイジェスト（改善⑤）へ完了を1件積む＝朝8時のふりかえりまとめ用。
      await enqueueNotification(
        ticketId,
        "completion",
        `「${current.title}」を本番反映しました`
      ).catch(() => {});
      // 学び還元（KNOWHOW_ENABLED時のみ実働。OFFなら no-op）。
      const learn = await returnLearningFromCompleted(5).catch(() => ({ memorized: 0 }));
      return NextResponse.json({ ok: true, state: "完了", learned: learn.memorized });
    }

    if (result === "closed") {
      // 人がPRをマージせずクローズ＝この改修は不採用の意思表示 → 却下で閉じる。
      // クローズしたのは人自身なのでLINEは送らない（本人が知っている）。
      await updateTicketState(pageId, "却下");
      await setStatusChangedAt(pageId);
      await appendDiscussionBlocks(pageId, [
        { heading: "PRクローズ検知（却下）", body: `${detail || "PRがマージされずクローズされました"}\nPR: ${prUrl}` },
      ]);
      return NextResponse.json({ ok: true, state: "却下" });
    }

    if (result === "review") {
      // PRレビュー型では「review」が通常の成功（AIがPRを作って人の確認待ち）。
      await updateTicketState(pageId, "レビュー");
      await setStatusChangedAt(pageId); // Phase 1: 状態変更日時を記録
      await appendDiscussionBlocks(pageId, [
        { heading: "PR作成（レビュー待ち）", body: `${detail}\nPR: ${prUrl}` },
      ]);
      // Merge待ち連絡（社長のアクション待ち＝進捗FYIではなく判断要求）。
      // 旧仕様はここで無音＝GO済みPRが誰にも知られず放置されていた
      // （実測でKZ-24/25/26/32/37の5本が無音滞留）。1チケット1回・de-dup付き
      // （master側の素のpushTextはreaper再走で連打し得るため、de-dup付きへ統合）。
      await notifyReviewOnce(current, prUrl, detail).catch(() => false);
      // 日次ダイジェスト（改善⑤）へレビュー待ちを1件積む。
      await enqueueNotification(
        ticketId,
        "pr_ready",
        `「${current.title}」のPRができました（レビュー待ち）`
      ).catch(() => {});
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
      { heading: "実装失敗（差し戻し）", body: `[${failureClass}] ${detail || "(理由不明)"}` },
    ]);
    await notifyStuckOnce(current, detail || "不明（くわしくは /board をご確認ください）");
    // 日次ダイジェスト（改善⑤）へエラーを1件積む。要約が不明瞭（空/「不明」）なら
    // enqueue 側で積まれない（「理由：不明」の禁止）＝実エラー文があるときだけ載る。
    await enqueueNotification(
      ticketId,
      "error",
      `「${current.title}」の自動改修が失敗（差し戻し）`,
      detail
    ).catch(() => {});
    return NextResponse.json({ ok: true, state: "差し戻し" });
  } catch (err) {
    console.error("[execute/callback] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
