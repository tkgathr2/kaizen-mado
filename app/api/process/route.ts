// ── POST /api/process ── 受付 → 議論中 → GO待ち（第2段=内部処理） ──
// 「受付」状態のチケットを順に処理し、CTO Agent Lab の議論結果をページに追記して
// 「GO待ち」へ進める。GO待ちにしたら、GO伺いを高木さん本人のLINEへpushする
// （対外・対人告知ではなく、社長への承認伺い1通。LINE鍵が未設定なら静かにスキップ）。
// CRON_SECRET が設定されていれば認証を要求（x-cron-secret または Vercel Cron の Bearer）。
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  fetchTicketsByState,
  updateTicketState,
  appendDiscussionBlocks,
  setTicketAssignee,
  setStatusChangedAt,
} from "@/lib/tickets";
import { discussTicket } from "@/lib/discuss";
import { pushProposal } from "@/lib/line";
import { checkCronSecret } from "@/lib/cronAuth";
import { returnLearningFromCompleted } from "@/lib/learn";
import { findTarget } from "@/lib/targets";
import { preGate, autopilotEnabled } from "@/lib/gate";
import { kickEndpoint } from "@/lib/trigger";

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
    const processed: { ticketId: string; recommendation: string; source: string; notified: boolean }[] = [];
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

        // ── 真田自走（オートパイロット） ──
        // 安全（preGate=auto＝自動許可システム＋機微/新機能を含まない）かつ推奨がGOなら、
        // 社長にGO伺いせず自動で「着手」へ進める（＝真田の判断でやって事後報告）。
        // 危険（escalate）や自走OFFなら従来どおり「GO待ち」にしてGO伺いをpush（社長に聞く）。
        const target = findTarget(ticket.system);
        const gate = preGate({ ...ticket, state: "GO待ち" }, target);
        // 推奨は enum（GO推奨/要検討/非推奨）。自走は「GO推奨」だけ。
        // 要検討・非推奨はラボが慎重判断＝従来どおり社長にGO伺い（聞く）。
        const recommendGo = d.recommendation === "GO推奨";

        if (autopilotEnabled() && gate.mode === "auto" && recommendGo) {
          // 自動GO：GO待ちを飛ばして着手へ。次のexecuteが実装→PR→（自走なら）マージまで。
          await updateTicketState(ticket.pageId, "着手");
          await setStatusChangedAt(ticket.pageId); // Phase 1: 状態変更日時を記録
          await appendDiscussionBlocks(ticket.pageId, [
            {
              heading: "真田自走（自動GO）",
              body: "安全な改善のため、社長へのGO伺いを省略し真田の判断で着手。危険・対人・課金・本番破壊に該当する場合のみ社長確認（preGate=auto）。",
            },
          ]);
          // 「着手」にしたら即 /api/execute を起こして実改修へ進める（応答はブロックしない）。
          // line/webhook・admin/go と同じ形。vercel.json の crons は空＝安全網がないため、
          // ここで kick しないと自動GOチケットが「着手」のまま実装パイプラインに乗らず残置する。
          waitUntil(kickEndpoint("/api/execute"));
          // 新仕様：自分から送るLINEは「GO伺い」と「詰まり連絡」だけ。
          // 着手予告（旧「🤖 真田が直します」FYI）は不要のため送らない（状態遷移・kickは維持）。
          processed.push({
            ticketId: ticket.ticketId,
            recommendation: d.recommendation,
            source: d.source,
            notified: false,
          });
        } else {
          // 従来：GO待ち＋GO伺い（社長に聞く）。自走未許可システム・危険案件はここ。
          await updateTicketState(ticket.pageId, "GO待ち");
          await setStatusChangedAt(ticket.pageId); // Phase 1: 状態変更日時を記録
          const pushed = await pushProposal({ ...ticket, state: "GO待ち" }, d);
          processed.push({
            ticketId: ticket.ticketId,
            recommendation: d.recommendation,
            source: d.source,
            notified: pushed,
          });
        }
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
