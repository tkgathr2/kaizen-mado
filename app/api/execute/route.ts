// ── POST /api/execute ── 「着手」チケットを実改修へ流す（実行オーケストレーターの入口） ──
// GO検知で「着手」になったチケットを拾い、preGateで自動/社長案件を振り分ける：
//  - auto      → GitHub Actions(repository_dispatch)を起動し「実装中」へ。
//  - escalate  → 「社長確認」へ。これは社長案件としてLINEで②本番投入GOを仰ぐ（実改修はしない）。
// CRON_SECRET 保護（本番で未設定＝fail-closed）。Vercel Cron等で定期実行する想定。
// 鍵(GITHUB_DISPATCH_TOKEN/LINE)が無ければ各処理はfail-safeでスキップ（状態は進めない）。
import { NextRequest, NextResponse } from "next/server";
import {
  fetchTicketsByState,
  updateTicketState,
  appendDiscussionBlocks,
} from "@/lib/tickets";
import { findTarget } from "@/lib/targets";
import { preGate } from "@/lib/gate";
import {
  dispatchExecution,
  dispatchEnabled,
  buildDispatchPayload,
  type DispatchPayload,
} from "@/lib/orchestrate";
import { pushText, truncateForLine, notionPageUrl, stageBar, BOARD_URL } from "@/lib/line";
import { checkCronSecret } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動/自前cronは POST。
// ?mode=plan … 自分でdispatchせず、auto対象の実装ペイロードを返す（GitHub Actions側が
//   github.token で実行するための「PAT不要ループ」用）。社長案件のescalateは従来どおり自分で処理。
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const planMode = req.nextUrl.searchParams.get("mode") === "plan";

  let limit = 3;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.limit === "number" && body.limit > 0) {
      limit = Math.floor(body.limit);
    }
  } catch {
    // body 任意
  }

  try {
    const tickets = await fetchTicketsByState("着手", limit);
    const dispatched: string[] = [];
    const escalated: string[] = [];
    const skipped: { ticketId: string; reason: string }[] = [];
    const plan: DispatchPayload[] = []; // planモードで実行ワークフローに渡すペイロード

    for (const ticket of tickets) {
      const target = findTarget(ticket.system);
      const decision = preGate(ticket, target);

      if (decision.mode === "escalate") {
        // 社長案件：状態を「社長確認」へ進め、LINEで②本番投入GOを仰ぐ。
        await updateTicketState(ticket.pageId, "社長確認");
        await appendDiscussionBlocks(ticket.pageId, [
          {
            heading: "社長案件へエスカレ（②本番投入GO）",
            body: decision.reasons.map((r) => `・${r}`).join("\n"),
          },
        ]);
        await pushText(
          [
            stageBar(3), // ③のGO段で社長判断へ分岐
            `🛑 社長案件です ${ticket.ticketId}｜${ticket.system}`,
            `「${truncateForLine(ticket.title, 28)}」`,
            ``,
            `自動では直しません。理由：`,
            ...decision.reasons.slice(0, 3).map((r) => `・${truncateForLine(r, 38)}`),
            ...(decision.reasons.length > 3 ? [`・ほか${decision.reasons.length - 3}件（詳細はNotion）`] : []),
            ``,
            `進め方は社長のご判断をお願いします。`,
            `詳細 ▶ ${notionPageUrl(ticket.pageId)}`,
            `全体像 ▶ ${BOARD_URL}`,
          ].join("\n")
        );
        escalated.push(ticket.ticketId);
        continue;
      }

      // auto：repoが確定していなければ自動不可。
      if (!target?.repo) {
        skipped.push({ ticketId: ticket.ticketId, reason: "repo未確定" });
        continue;
      }

      // planモード：自分でdispatchせず「実装中」へ進めてペイロードを返す。
      // 実行はGitHub Actions（github.token）が担う＝VercelにPAT不要。
      if (planMode) {
        await updateTicketState(ticket.pageId, "実装中");
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "自動着手（Actions実行）", body: `GitHub Actionsが改修→PR作成（${target.repo}・PRレビュー型）。` },
        ]);
        await pushText(
          [
            stageBar(4), // ④着手
            `🔧 着手しました ${ticket.ticketId}｜${ticket.system}`,
            `確認用のPR（差分）を作成中。できたらお知らせします。`,
            `全体像 ▶ ${BOARD_URL}`,
          ].join("\n")
        );
        plan.push(buildDispatchPayload(ticket, target));
        dispatched.push(ticket.ticketId);
        continue;
      }

      // 従来：Vercelからrepository_dispatchで起動（GITHUB_DISPATCH_TOKEN必須）。
      if (!dispatchEnabled()) {
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch未設定（GITHUB_DISPATCH_TOKEN）" });
        continue;
      }
      const ok = await dispatchExecution({ ticket, target });
      if (ok) {
        await updateTicketState(ticket.pageId, "実装中");
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "自動着手", body: `実行ワークフローを起動（${target.repo}）。AIが改修→PR作成→レビュー待ち（PRレビュー型）。` },
        ]);
        // GOからPR完成までの間、動いていることが伝わるよう「着手」を通知。
        await pushText(
          [
            stageBar(4), // ④着手
            `🔧 着手しました ${ticket.ticketId}｜${ticket.system}`,
            `確認用のPR（差分）を作成中。できたらお知らせします。`,
            `全体像 ▶ ${BOARD_URL}`,
          ].join("\n")
        );
        dispatched.push(ticket.ticketId);
      } else {
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch失敗" });
      }
    }

    return NextResponse.json({
      ok: true,
      dispatched,
      escalated,
      ...(planMode ? { plan } : {}),
      ...(skipped.length ? { skipped } : {}),
    });
  } catch (err) {
    console.error("[execute] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
