// ── POST /api/process ── 受付 → 議論中 → GO待ち（第2段=内部処理） ──
// 「受付」状態のチケットを順に処理し、CTO Agent Lab の議論結果をページに追記して
// 「GO待ち」へ進める。GO待ちにしたら、用件を真田システム（mention-hisho）へ受け渡し、
// 真田の既存LINEカード（✅OK/✏️修正/🚫却下/🛠ClaudeCodeへ送る）で社長に確認してもらう。
// 受け渡しに失敗したときは、カイゼンくん自前LINE（旧pushProposal）へは一切フォールバック
// しない（社長指示 2026-08-15「カイゼンくんのLINEチャネルに一切来ない仕組みにして」）。
// 代わりに真田Bot名義のSlack警告（notifySlackAlert・社長＋幹部Botのみのチャンネル）を送り、
// 社長に何も届かない無音状態を作らない。
//
// 【2026-08-12 社長指示】重要度・危険度に関係なく**全チケットが必ず社長のLINE確認を経由する**。
// 旧「真田自走（オートパイロット）＝安全な案件は社長に聞かず自動着手」は廃止した。
// 着手は社長がLINEカードで「🛠ClaudeCodeへ送る」を押したときに真田側から起きるため、
// この経路からの /api/execute kick も無くなった。
// CRON_SECRET が設定されていれば認証を要求（x-cron-secret または Vercel Cron の Bearer）。
import { NextRequest, NextResponse } from "next/server";
import {
  fetchTicketsByState,
  updateTicketState,
  appendDiscussionBlocks,
  setTicketAssignee,
  setStatusChangedAt,
} from "@/lib/tickets";
import { discussTicket } from "@/lib/discuss";
import { notifySlackAlert, notifyKuharaCopy, buildKuharaGoText, BOARD_URL } from "@/lib/line";
import { handoffToSanada } from "@/lib/handoff";
import { checkCronSecret } from "@/lib/cronAuth";
import { returnLearningFromCompleted } from "@/lib/learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動/自前cronは POST。どちらも同じ処理。
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let limit = 5;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.limit === "number" && body.limit > 0) {
      limit = Math.floor(body.limit);
    }
  } catch {
    // body 任意：なくてよい
  }

  try {
    const tickets = await fetchTicketsByState("受付", limit);
    // notifiedVia: どの経路で社長へ届けたか。"handoff"=真田システム経由（本線）／
    // "line"=自前LINEのGO伺い（handoff失敗時のフォールバック）／"none"=どちらも届かず。
    const processed: {
      ticketId: string;
      recommendation: string;
      source: string;
      notified: boolean;
      notifiedVia: "handoff" | "slack-alert" | "none";
    }[] = [];
    const errors: { ticketId: string; error: string }[] = [];

    for (const ticket of tickets) {
      try {
        // 議論中へ → 議論 → 結果追記 → 担当付与 → GO待ちへ
        await updateTicketState(ticket.pageId, "議論中");
        const d = await discussTicket(ticket);
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "方針", body: d.houshin },
          { heading: "改善手順", body: d.steps.length ? d.steps.map((s) => `・${s}`).join("\n") : "（追ってヒアリング）" },
          { heading: "工数見積", body: d.kousuu },
          { heading: "リスク", body: d.risks.length ? d.risks.map((r) => `・${r}`).join("\n") : "（特になし）" },
          { heading: "重要度 / 緊急度", body: `重要度：${d.importance}　/　緊急度：${d.urgency}` },
          { heading: "推奨", body: d.recommendation },
          { heading: "GO伺いドラフト（未送信）", body: d.goDraft },
        ]);
        await setTicketAssignee(ticket.pageId, "CTO Agent Lab");

        // ── 全件「GO待ち」＋社長へ確認（2026-08-12 社長指示） ──
        // 重要度・危険度に関係なく、必ず社長のLINE確認を経由させる。オートパイロット分岐は廃止。
        const goWaitTicket = { ...ticket, state: "GO待ち" };
        await updateTicketState(ticket.pageId, "GO待ち");
        await setStatusChangedAt(ticket.pageId); // Phase 1: 状態変更日時を記録

        // 久原さん複製投稿（ベストエフォート・失敗しても本来のGO伺い通知には一切影響しない）。
        await notifyKuharaCopy("GO伺い", buildKuharaGoText(goWaitTicket, d)).catch(() => false);

        // 本線：真田システム（mention-hisho）へ受け渡す。真田側が「真田宛メンション」として
        // 扱い、既存の真田LINEカード（✅OK/✏️修正/🚫却下/🛠ClaudeCodeへ送る）を社長へ出す。
        let notifiedVia: "handoff" | "slack-alert" | "none" = "none";
        const handed = await handoffToSanada(goWaitTicket, d);
        if (handed) {
          notifiedVia = "handoff";
        } else {
          // フォールバック：受け渡しが無効/失敗したときは、カイゼンくん自前LINE（旧pushProposal）
          // へは送らず、真田Bot名義のSlack警告（社長＋幹部Botのみのチャンネル）で知らせる
          // （社長に何も届かない無音状態を作らないため。自前LINEフォールバックは廃止）。
          const alerted = await notifySlackAlert(
            `GO伺い（${ticket.ticketId}／${ticket.system}）を真田チャネルへ送れませんでした。カイゼンくんの盤面（${BOARD_URL}）から直接ご確認ください。`,
            "⚠️ GO伺いが真田チャネルへ送れませんでした"
          );
          notifiedVia = alerted ? "slack-alert" : "none";
        }
        console.log("[process] 社長へ通知", {
          ticketId: ticket.ticketId,
          notifiedVia,
        });

        processed.push({
          ticketId: ticket.ticketId,
          recommendation: d.recommendation,
          source: d.source,
          notified: notifiedVia !== "none",
          notifiedVia,
        });
      } catch (err) {
        // ── 宙づり対策：先に「議論中」へ進めた後で後続のNotion書込みがthrowすると、
        // catchで状態が戻らず「議論中」のまま残置していた（fetchTicketsByStateは「受付」しか
        // 再取得しないため二度と拾われない）。失敗したら「受付」へ戻し、次回cronで再処理させる。
        // 戻し自体が失敗しても本来のエラーは errors に積んで他チケットの処理は続ける。
        await updateTicketState(ticket.pageId, "受付").catch((e) => {
          console.error(
            "[process] 受付への巻き戻し失敗",
            ticket.ticketId,
            (e as Error).message
          );
        });
        // 1件失敗しても他を続行する
        errors.push({
          ticketId: ticket.ticketId,
          error: (err as Error).message,
        });
      }
    }

    // 学び還元（Phase2蒸留）を毎日ここで回す：完了済み・未学習チケットをknowhowへ。
    // 従来は execute/callback（自動改修のマージ時）でしか走らず、手動完了・社長案件の
    // 完了チケットが永遠に蒸留されなかった（learned=0 の真因）。失敗してもcron全体は止めない。
    const learn = await returnLearningFromCompleted(10).catch((err) => {
      console.error("[process] learn failed:", (err as Error).message);
      return { memorized: 0 };
    });

    return NextResponse.json({
      ok: true,
      count: processed.length,
      processed,
      learned: learn.memorized,
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    console.error("[process] failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "処理に失敗しました。" },
      { status: 500 }
    );
  }
}
