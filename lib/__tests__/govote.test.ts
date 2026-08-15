import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TicketRow } from "../tickets";

// tickets の副作用（Notion書き込み）はモックして、状態遷移の呼び出しだけ検証する。
vi.mock("../tickets", () => ({
  updateTicketState: vi.fn().mockResolvedValue(undefined),
  appendDiscussionBlocks: vi.fn().mockResolvedValue(undefined),
}));

import { applyGoAction } from "../govote";
import { updateTicketState, appendDiscussionBlocks } from "../tickets";

function ticket(state: string): TicketRow {
  return {
    pageId: "page-1",
    ticketId: "KZ-12",
    system: "プロレポ",
    type: "改善",
    importance: "高",
    title: "一覧が重い",
    detail: "...",
    reporter: "現場",
    state,
    fgsUrl: null,
  };
}

describe("applyGoAction", () => {
  beforeEach(() => {
    vi.mocked(updateTicketState).mockClear();
    vi.mocked(appendDiscussionBlocks).mockClear();
  });

  // 【2026-08-15 社長指示】カイゼンくん自身の自動改修（executor未指定＝旧"kaizen"）は廃止。
  // 状態は変えず、真田専用LINEチャネルでの操作を案内するだけになる。
  it("GO待ち + go（executor未指定） → 状態は変えず真田チャネルへの案内を返す", async () => {
    const r = await applyGoAction("go", ticket("GO待ち"));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.newState).toBeUndefined();
    expect(updateTicketState).not.toHaveBeenCalled();
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
    expect(r.reply).toContain("KZ-12");
    expect(r.reply).toContain("真田");
  });

  it("GO待ち + fix → 差し戻し", async () => {
    const r = await applyGoAction("fix", ticket("GO待ち"));
    expect(r.newState).toBe("差し戻し");
    expect(updateTicketState).toHaveBeenCalledWith("page-1", "差し戻し");
  });

  it("GO待ち + fix + 本文(note) → 修正指示を議論ブロックに保存し返信にも反映", async () => {
    const note = "ボタンの色を青に直して";
    const r = await applyGoAction("fix", ticket("GO待ち"), note);
    expect(r.newState).toBe("差し戻し");
    // appendDiscussionBlocks に「社長の修正指示」ブロックが含まれる
    const blocks = vi.mocked(appendDiscussionBlocks).mock.calls[0][1];
    const noteBlock = blocks.find((b) => b.heading === "社長の修正指示");
    expect(noteBlock?.body).toBe(note);
    // 返信にも要約が乗る
    expect(r.reply).toContain("承りました");
  });

  it("GO待ち + fix で note 無しなら修正指示ブロックを増やさない", async () => {
    await applyGoAction("fix", ticket("GO待ち"));
    const blocks = vi.mocked(appendDiscussionBlocks).mock.calls[0][1];
    expect(blocks.find((b) => b.heading === "社長の修正指示")).toBeUndefined();
  });

  it("GO待ち + reject → 却下", async () => {
    const r = await applyGoAction("reject", ticket("GO待ち"));
    expect(r.newState).toBe("却下");
    expect(updateTicketState).toHaveBeenCalledWith("page-1", "却下");
  });

  it("GO待ち以外（着手済み）は冪等にスキップし、状態を変えない", async () => {
    const r = await applyGoAction("go", ticket("着手"));
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(updateTicketState).not.toHaveBeenCalled();
    expect(r.reply).toContain("着手");
  });

  it("完了済みにGOが来ても二重実行しない", async () => {
    const r = await applyGoAction("go", ticket("完了"));
    expect(r.skipped).toBe(true);
    expect(updateTicketState).not.toHaveBeenCalled();
  });
});
