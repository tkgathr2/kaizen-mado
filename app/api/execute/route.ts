// ── POST /api/execute ── 「着手」チケットを実改修へ流す（実行オーケストレーターの入口） ──
// 「着手」＝社長がGO（承認サイン）を出した状態。社長指示2026-06-27「GO後は対象・機微に
// 関わらず自動で最後まで直して反映」に従い、ここでは機微キーワード・autoEligible を理由に
// 止めない（提案フェーズ=process.ts で社長にGO伺いを出す preGate の役割はそちらに残す）。
// GO後にここで止めるのは「物理的に自動修正不能」なときだけ＝対象システムが未定義 or
// repo が null（PR先が無い）。その場合だけ「社長に相談」ではなく正直に「リポ未設定」を伝える。
//  - 直せる   → GitHub Actions(repository_dispatch)を起動し「実装中」へ（autoMerge=true＝反映まで）。
//  - 直せない → 「社長確認」へ。LINEで「リポが未設定」を正直に伝える（実改修はしない）。
// CRON_SECRET 保護（本番で未設定＝fail-closed）。Vercel Cron等で定期実行する想定。
// 鍵(GITHUB_DISPATCH_TOKEN/LINE)が無ければ各処理はfail-safeでスキップ（状態は進めない）。
import { NextRequest, NextResponse } from "next/server";
import {
  fetchTicketsByState,
  updateTicketState,
  appendDiscussionBlocks,
  fetchStaleImplementing,
  staleImplementingMinutes,
} from "@/lib/tickets";
import { findTarget } from "@/lib/targets";
import {
  dispatchExecution,
  dispatchEnabled,
  buildDispatchPayload,
  type DispatchPayload,
} from "@/lib/orchestrate";
import { pushText, truncateForLine, notionPageUrl, stageBar, BOARD_URL, msgHead } from "@/lib/line";
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
    // ── stuck回収（reaper）──
    // planモードの先頭で、callbackに到達せず「実装中」のまま滞留したチケットを「着手」へ戻す。
    // implementジョブ（GitHub Actions）が失敗/タイムアウト/中断するとcallbackが来ず、
    // チケットが「実装中」のまま永久滞留する（回収経路ゼロ）のを防ぐ。戻したものは
    // 「次回スキャン」で再処理される＝同じ実行では着手リストから除外して二重処理を避ける。
    const reaped: string[] = [];
    const reapedPageIds = new Set<string>();
    if (planMode) {
      const minutes = staleImplementingMinutes();
      const stale = await fetchStaleImplementing(minutes, Math.max(limit, 5)).catch((e) => {
        console.error("[execute] stuck回収の取得失敗", (e as Error).message);
        return [] as Awaited<ReturnType<typeof fetchStaleImplementing>>;
      });
      for (const s of stale) {
        try {
          await updateTicketState(s.pageId, "着手");
          await appendDiscussionBlocks(s.pageId, [
            {
              heading: "stuck回収（自動リセット）",
              body: `「実装中」のまま${minutes}分以上応答が無かったため「着手」へ戻しました（次回スキャンで再処理）。`,
            },
          ]);
          reaped.push(s.ticketId);
          reapedPageIds.add(s.pageId);
        } catch (e) {
          console.error("[execute] stuck回収の戻し失敗", s.ticketId, (e as Error).message);
        }
      }
    }

    const fetched = await fetchTicketsByState("着手", limit);
    // reaperで今まさに戻したチケットは、同じ実行では拾わない（次回スキャンに委ねる＝二重処理防止）。
    const tickets = fetched.filter((t) => !reapedPageIds.has(t.pageId));
    const dispatched: string[] = [];
    const escalated: string[] = [];
    const skipped: { ticketId: string; reason: string }[] = [];
    const plan: DispatchPayload[] = []; // planモードで実行ワークフローに渡すペイロード

    for (const ticket of tickets) {
      const target = findTarget(ticket.system);

      // ── GO後の唯一の停止条件＝「物理的に自動修正不能」 ──
      // 「着手」＝社長GO済み。機微・autoEligible では止めない（process.ts の提案フェーズで
      // 社長にGO伺いを出すのが preGate の役割で、GO後にここで再判定して止めない）。
      // ここで止まるのは PR先が存在しないときだけ＝対象未定義 or repo:null。その場合は
      // 「社長に相談」ではなく正直に「リポが未設定です」と伝える（機微・autoEligibleの理由は出さない）。
      if (!target || !target.repo) {
        const sys = target?.system ?? ticket.system ?? "（不明なシステム）";
        await updateTicketState(ticket.pageId, "社長確認");
        await appendDiscussionBlocks(ticket.pageId, [
          {
            heading: "自動修正できません（リポ未設定）",
            body: target
              ? `「${sys}」のリポジトリ(owner/repo)が未設定のため、PR先が無く自動修正できません。リポを教えてください（または担当へ）。`
              : `「${sys}」は対象システムとして未定義のため自動修正できません。対象マッピングを追加してください（または担当へ）。`,
          },
        ]);
        await pushText(
          [
            msgHead("⚠️", "自動修正できません", ticket.system, ticket.title), // まず「何の件か」
            `（${ticket.ticketId}）`,
            ``,
            target
              ? `「${truncateForLine(sys, 24)}」のリポジトリが未設定です。`
              : `「${truncateForLine(sys, 24)}」が対象システムに未登録です。`,
            `リポを教えてください（または担当へ）。`,
            ``,
            stageBar(3),
            `詳細 ▶ ${notionPageUrl(ticket.pageId)}`,
            `全体像 ▶ ${BOARD_URL}`,
          ].join("\n")
        );
        escalated.push(ticket.ticketId);
        continue;
      }

      // planモード：自分でdispatchせず「実装中」へ進めてペイロードを返す。
      // 実行はGitHub Actions（github.token）が担う＝VercelにPAT不要。
      if (planMode) {
        // ── 巻き戻し防御（dispatch経路と同じ） ──
        // 「実装中」へ進めた後の処理が失敗すると、callbackは「実装中」しか拾わない一方で
        // 本チケットはplanにも乗らない＝宙づりになる。失敗したら「着手」へ戻して
        // 次回スキャンに委ねる（戻し自体が失敗してもreaperが最終的に回収する）。
        await updateTicketState(ticket.pageId, "実装中");
        try {
          await appendDiscussionBlocks(ticket.pageId, [
            { heading: "自動着手（Actions実行）", body: `GitHub Actionsが改修→PR作成（${target.repo}・PRレビュー型）。` },
          ]);
          // 新仕様：着手の進捗FYI（旧「🔧 いま直しています」）は送らない（自分から送るLINEは
          // 「GO伺い」と「詰まり連絡」だけ）。状態遷移・dispatchは維持する。
          // 「着手」＝社長GO済み＝autoMerge=true（反映まで全自動）。実際の自動マージは
          // ワークフロー側の安全網（CI(tsc/test/build)緑＋禁止パス非接触）を満たすときだけ実行される。
          plan.push(buildDispatchPayload(ticket, target, true));
          dispatched.push(ticket.ticketId);
        } catch (e) {
          await updateTicketState(ticket.pageId, "着手").catch((e2) => {
            console.error("[execute] plan経路の巻き戻し失敗", ticket.ticketId, (e2 as Error).message);
          });
          skipped.push({ ticketId: ticket.ticketId, reason: "plan処理失敗（着手へ巻き戻し）" });
          console.error("[execute] plan処理失敗", ticket.ticketId, (e as Error).message);
        }
        continue;
      }

      // 従来：Vercelからrepository_dispatchで起動（GITHUB_DISPATCH_TOKEN必須）。
      if (!dispatchEnabled()) {
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch未設定（GITHUB_DISPATCH_TOKEN）" });
        continue;
      }
      // ── 競合（レース）対策：dispatch の「前」に「実装中」へ更新する ──
      // 旧実装は dispatch成功 → その後 Notion更新 の順だった。短いCIジョブだと、
      // Notion更新が反映される前に execute/callback が走り、ガードが「着手」を見て skip し、
      // 完了通知が出ず残置していた（非アトミック）。先に「実装中」へ進めておけば、
      // どれだけCIが速くても callback は必ず「実装中」を見て正しく処理できる。
      // dispatch が失敗したら「着手」へ巻き戻して次回の再実行に委ねる。
      await updateTicketState(ticket.pageId, "実装中");
      // 「着手」＝社長GO済み＝autoMerge=true（反映まで全自動）。実際の自動マージは
      // ワークフロー側の安全網（CI緑＋禁止パス非接触）を満たすときだけ実行される。
      const ok = await dispatchExecution({ ticket, target, autoMerge: true });
      if (ok) {
        await appendDiscussionBlocks(ticket.pageId, [
          { heading: "自動着手", body: `実行ワークフローを起動（${target.repo}）。AIが改修→PR作成→レビュー待ち（PRレビュー型）。` },
        ]);
        // 新仕様：着手の進捗FYI（旧「🔧 いま直しています」）は送らない（自分から送るLINEは
        // 「GO伺い」と「詰まり連絡」だけ）。状態遷移・dispatchは維持する。
        dispatched.push(ticket.ticketId);
      } else {
        // dispatch失敗：先に進めた「実装中」を「着手」へ巻き戻す（次のexecuteで再試行できるように）。
        await updateTicketState(ticket.pageId, "着手").catch((e) => {
          console.error("[execute] 巻き戻し失敗", ticket.ticketId, (e as Error).message);
        });
        skipped.push({ ticketId: ticket.ticketId, reason: "dispatch失敗" });
      }
    }

    return NextResponse.json({
      ok: true,
      dispatched,
      escalated,
      ...(planMode ? { plan } : {}),
      ...(reaped.length ? { reaped } : {}),
      ...(skipped.length ? { skipped } : {}),
    });
  } catch (err) {
    console.error("[execute] failed:", (err as Error).message);
    return NextResponse.json({ ok: false, error: "処理に失敗しました。" }, { status: 500 });
  }
}
