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

/** GO/修正/却下 を適用する。GO待ちでなければ何もしない（冪等）。
 * note＝社長が修正(fix)時に添えた本文（「◯◯を直して」）。議論へ反映するため保存する。 */
export async function applyGoAction(
  action: GoAction,
  ticket: TicketRow,
  note?: string
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
        `${msgHead("✅", "GO受けました", ticket.system, ticket.title)}\n` + // まず「何の件か」
        `（${ticket.ticketId}）進めます。結果はまたお知らせします。\n\n` +
        `${stageBar(3)}\n` + // ③GO受領（→着手へ）
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
