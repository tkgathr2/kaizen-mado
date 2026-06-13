// ── GO/修正/却下 を受けてチケット状態を遷移する（二段階GOの①着手GO） ──
// GO待ち以外のチケットには作用しない（webhook重複配信に対する冪等化）。
// ここでは対象システムのコードは触らない。GO→「着手」へ進めるだけで、
// 実際の実装＝実行オーケストレーター（Phase B / app/api/execute）が別途・ゲート付きで担う。
import type { TicketRow } from "./tickets";
import { updateTicketState, appendDiscussionBlocks } from "./tickets";
import type { GoAction } from "./line";
import { stageBar, BOARD_URL, msgHead } from "./line";

export interface ApplyResult {
  ok: boolean;
  reply: string;
  newState?: string;
  skipped?: boolean;
}

/** GO/修正/却下 を適用する。GO待ちでなければ何もしない（冪等）。 */
export async function applyGoAction(
  action: GoAction,
  ticket: TicketRow
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
    await updateTicketState(ticket.pageId, "着手");
    await appendDiscussionBlocks(ticket.pageId, [
      { heading: "GO受領（着手GO）", body: "社長GO → 状態を「着手」へ。実行オーケストレーター待ち。" },
    ]);
    return {
      ok: true,
      newState: "着手",
      reply:
        `${msgHead("✅", "GO受領", ticket.system, ticket.title)}\n` + // まず「何の件か」
        `（${ticket.ticketId}）進めます。結果はまたお知らせします。\n\n` +
        `${stageBar(3)}\n` + // ③GO受領（→着手へ）
        `全体像 ▶ ${BOARD_URL}`,
    };
  }

  if (action === "fix") {
    await updateTicketState(ticket.pageId, "差し戻し");
    await appendDiscussionBlocks(ticket.pageId, [
      { heading: "修正要望", body: "社長より修正要望 → 議論へ差し戻し。内容を反映して再提案する。" },
    ]);
    return {
      ok: true,
      newState: "差し戻し",
      reply:
        `${msgHead("✏️", "修正受領", ticket.system, ticket.title)}\n` +
        `（${ticket.ticketId}）議論に戻して、見直してから再提案します。`,
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
