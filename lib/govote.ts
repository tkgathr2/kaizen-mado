// ── GO/修正/却下 を受けてチケット状態を遷移する（二段階GOの①着手GO） ──
// GO待ち以外のチケットには作用しない（webhook重複配信に対する冪等化）。
// ここでは対象システムのコードは触らない。GO→「着手」へ進めるだけで、
// 実際の実装＝実行オーケストレーター（Phase B / app/api/execute）が別途・ゲート付きで担う。
import type { TicketRow } from "./tickets";
import { updateTicketState, appendDiscussionBlocks } from "./tickets";
import type { GoAction } from "./line";
import { stageBar, BOARD_URL, msgHead } from "./line";
import { KZ_STATUS } from "./kz-state";

export interface ApplyResult {
  ok: boolean;
  reply: string;
  newState?: string;
  skipped?: boolean;
}

/**
 * 誰が実装するか。
 * - "sanada"（唯一の実装経路） … 真田システム（mention-hisho）側の Claude Code。社長がLINEカードの
 *                     「🛠 ClaudeCodeへ送る」を押し、真田側が**起動に成功したあと**に書き戻してくる。
 *                     このときカイゼンくん側の自動改修が同じチケットを掴むと二重実装になるため、
 *                     状態を「着手」ではなく「真田実装中」にして自動改修の対象から外す
 *                     （バグチェック High-1・kz-state.ts の SANADA_IMPLEMENTING 参照）。
 * - "kaizen"        … 【廃止・2026-08-15 社長指示】カイゼンくん自身の自動改修（/api/execute →
 *                     GitHub Actions）は廃止した。真田handoffが失敗した時のフォールバックLINE・
 *                     盤面（/board）のGOボタンからGOしても、もう自動改修は始まらない
 *                     （下記 applyGoAction 参照・案内メッセージを返すだけで状態は変えない）。
 *                     型としては後方互換のため残すが、実質的にこの分岐は到達しても無効化される。
 */
export type GoExecutor = "kaizen" | "sanada";

/** GO/修正/却下 を適用する。GO待ちでなければ何もしない（冪等）。
 * note＝社長が修正(fix)時に添えた本文（「◯◯を直して」）。議論へ反映するため保存する。
 * opts.executor＝GO時に誰が実装するか（既定は "kaizen"）。 */
export async function applyGoAction(
  action: GoAction,
  ticket: TicketRow,
  note?: string,
  opts?: { executor?: GoExecutor }
): Promise<ApplyResult> {
  if (ticket.state !== "GO待ち") {
    return {
      ok: false,
      skipped: true,
      reply:
        `${ticket.ticketId} は今「${ticket.state}」のため操作できません。\n` +
        `GO待ちの提案にだけ「GO ${ticket.ticketId}」の形で返信してください。`,
    };
  }

  if (action === "go") {
    // 真田側の Claude Code が既に起動している場合は、カイゼンくん側の自動改修に拾わせない
    // （「着手」にすると /api/execute と kaizen-loop.yml が同じチケットを二重実装する）。
    if (opts?.executor === "sanada") {
      try {
        await updateTicketState(ticket.pageId, KZ_STATUS.SANADA_IMPLEMENTING);
      } catch (e) {
        // 【2026-08-12 本番実測】Notion は未登録の select 選択肢を自動作成せず 400 を返す。
        // 原因が一目で分かるようにしてから投げ直す（握り潰して「着手」へ落とすのは絶対にしない。
        // それをやると二重実装が復活する。ここは進まない方に倒すのが正しい）。
        console.error(
          "[govote] 「真田実装中」への遷移に失敗しました。Notionの改善チケットDBの「状態」プロパティに" +
            "選択肢『真田実装中』が登録されているか確認してください（未登録だと Invalid select value で400）。",
          { ticketId: ticket.ticketId, error: (e as Error).message }
        );
        throw e;
      }
      await appendDiscussionBlocks(ticket.pageId, [
        {
          heading: "GO受領（真田実装）",
          body:
            "社長がLINEカードの「🛠 ClaudeCodeへ送る」を押し、真田システム（mention-hisho）側の " +
            "Claude Code セッションが起動済み。実装は真田側が担うため、カイゼンくん側の自動改修" +
            "（/api/execute → GitHub Actions）の対象外にする。",
        },
      ]);
      return {
        ok: true,
        newState: KZ_STATUS.SANADA_IMPLEMENTING,
        reply:
          `${msgHead("🛠", "真田が実装します", ticket.system, ticket.title)}\n` +
          `（${ticket.ticketId}）真田側のClaude Codeが着手しました。\n` +
          `カイゼンくん側の自動改修は動かしません（二重実装を防ぐため）。\n\n` +
          `${stageBar(3)}\n` +
          `全体像 ▶ ${BOARD_URL}`,
      };
    }
    // 【廃止・2026-08-15 社長指示】カイゼンくん自身の自動改修（executor未指定＝旧"kaizen"）は
    // ここで止める。状態は「GO待ち」のまま変えず（GitHub Actionsへは繋がない）、真田専用LINE
    // チャネルでの操作を案内するだけにする。この分岐に来るのは、真田handoffが失敗した時の
    // フォールバックLINE（app/api/line/webhook/route.ts）と盤面（app/api/board/action/route.ts）
    // のGOボタン経由のみ（本線の真田チャネル「🛠 ClaudeCodeへ送る」は opts.executor==="sanada" で
    // 上の分岐に入るため、ここには来ない）。
    return {
      ok: true,
      skipped: true,
      reply:
        `${msgHead("ℹ️", "GOは真田チャネルからお願いします", ticket.system, ticket.title)}\n` +
        `（${ticket.ticketId}）カイゼンくん自身の自動改修は廃止しました。\n` +
        `真田専用LINEチャネルのカードで「🛠 ClaudeCodeへ送る」を押してください。\n\n` +
        `全体像 ▶ ${BOARD_URL}`,
    };
  }

  if (action === "fix") {
    await updateTicketState(ticket.pageId, "差し戻し");
    // 社長が添えた修正本文(note)があれば議論ブロックに保存し、再提案で必ず反映できるようにする。
    // 旧実装は note を捨てていたため「修正 KZ-12 ◯◯を直して」の◯◯が議論に残らなかった。
    const trimmed = (note ?? "").trim();
    const blocks: { heading?: string; body?: string }[] = [
      { heading: "修正要望", body: "社長より修正要望 → 議論へ差し戻し。内容を反映して再提案する。" },
    ];
    if (trimmed) {
      blocks.push({ heading: "社長の修正指示", body: trimmed.slice(0, 1900) });
    }
    await appendDiscussionBlocks(ticket.pageId, blocks);
    return {
      ok: true,
      newState: "差し戻し",
      reply:
        `${msgHead("✏️", "修正ですね", ticket.system, ticket.title)}\n` +
        `（${ticket.ticketId}）議論に戻して、見直してから再提案します。` +
        (trimmed ? `\n承りました：${trimmed.slice(0, 40)}` : ""),
    };
  }

  // reject
  await updateTicketState(ticket.pageId, "却下");
  await appendDiscussionBlocks(ticket.pageId, [
    { heading: "却下", body: "社長判断により却下。" },
  ]);
  return {
    ok: true,
    newState: "却下",
    reply:
      `${msgHead("🚫", "却下", ticket.system, ticket.title)}\n` +
      `（${ticket.ticketId}）今回は見送ります。`,
  };
}
