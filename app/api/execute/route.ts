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
import { dispatchExecution, dispatchEnabled } from "@/lib/orchestrate";
import { pushText } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
          `🛑 これは社長案件です（${ticket.ticketId}）\n` +
            `対象: ${ticket.system} / ${ticket.type} / 重要度${ticket.importance}\n` +
            `件名: ${ticket.title}\n` +
            `理由:\n${decision.reasons.map((r) => `・${r}`).join("\n")}\n` +
            `自動では直しません。本番投入の可否をご判断ください。`
        );
        escalated.push(ticket.ticketId);
        continue;
      }

      // auto：dispatch可能なら実行ワークフローを起動し「実装中」へ。
      if (!dispatchEnabled() || !target?.repo) {
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch未設定（GITHUB_DISPATCH_TOKEN/repo）" });
        continue;
      }
      const ok = await dispatchExecution({ ticket, target });
      if (ok) {
        await updateTicketState(ticket.pageId, "実装中");
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "自動着手", body: `実行ワークフローを起動（${target.repo}）。PR→ゲート→マージ→デプロイ→報告。` },
        ]);
        dispatched.push(ticket.ticketId);
      } else {
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch失敗" });
      }
    }

    return NextResponse.json({
      ok: true,
      dispatched,
      escalated,
      ...(skipped.length ? { skipped } : {}),
    });
  } catch (err) {
    console.error("[execute] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
