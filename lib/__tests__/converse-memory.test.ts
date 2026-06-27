// ── 全体学習の配線（会話エンジン側フック）のユニットテスト ──
// memory層（recordLearning/recallLearning）はモックして、会話エンジンが
//  ①会話で recordLearning（conversation）を呼ぶ
//  ②GO/却下＝decision、修正＝correction を記録する
//  ③返答前に recallLearning を引いて文脈に整形する
// を検証する。すべて fail-safe（memoryが throw しても会話側は壊れない）も確認する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryHit } from "../memory";

// memory層をモック（記録・recall の呼び出しを観測する）
vi.mock("../memory", () => ({
  recordLearning: vi.fn(async () => true),
  recallLearning: vi.fn(async () => [] as MemoryHit[]),
}));

import { recordLearning, recallLearning } from "../memory";
import {
  recallForReply,
  formatLearningContext,
  recordConversationTurn,
  recordDecisionTurn,
} from "../converse";

const mockedRecord = vi.mocked(recordLearning);
const mockedRecall = vi.mocked(recallLearning);

describe("formatLearningContext（recall結果を返答プロンプト用に整形）", () => {
  it("0件なら空文字（プロンプトに足さない＝素通し）", () => {
    expect(formatLearningContext([])).toBe("");
    expect(formatLearningContext(null)).toBe("");
    expect(formatLearningContext(undefined)).toBe("");
  });

  it("ヒットを箇条書きにする（最大3件・空はスキップ）", () => {
    const hits: MemoryHit[] = [
      { content: "社長は簡潔な返事を好む", score: 0.9, tags: [] },
      { content: "  ", score: 0.1, tags: [] },
      { content: "ステレポは速度重視", score: 0.8, tags: [] },
    ];
    const out = formatLearningContext(hits);
    expect(out).toContain("・社長は簡潔な返事を好む");
    expect(out).toContain("・ステレポは速度重視");
    // 空はフィルタされる
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("recallForReply（返答前に過去の学びを引く）", () => {
  beforeEach(() => {
    mockedRecall.mockReset();
    mockedRecall.mockResolvedValue([]);
  });

  it("recallLearning を query＋topK で呼ぶ", async () => {
    mockedRecall.mockResolvedValue([
      { content: "前例A", score: 0.7, tags: [] },
    ]);
    const hits = await recallForReply("ステレポ どう？", 3);
    expect(mockedRecall).toHaveBeenCalledWith("ステレポ どう？", { topK: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe("前例A");
  });

  it("recallLearning が throw しても [] を返す（会話を止めない）", async () => {
    mockedRecall.mockRejectedValue(new Error("boom"));
    const hits = await recallForReply("x");
    expect(hits).toEqual([]);
  });
});

describe("recordConversationTurn（会話1ターンを記録）", () => {
  beforeEach(() => {
    mockedRecord.mockReset();
    mockedRecord.mockResolvedValue(true);
  });

  it("kind:conversation で社長発言を summary、AI返答を detail に記録", async () => {
    const ok = await recordConversationTurn("一覧が遅い", "順番に進めます", "プロレポ");
    expect(ok).toBe(true);
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    const ev = mockedRecord.mock.calls[0][0];
    expect(ev.kind).toBe("conversation");
    expect(ev.summary).toBe("一覧が遅い");
    expect(ev.detail).toBe("順番に進めます");
    expect(ev.system).toBe("プロレポ");
  });

  it("社長発言が空なら記録しない（ノイズを貯めない）", async () => {
    const ok = await recordConversationTurn("   ", "返答");
    expect(ok).toBe(false);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("system 未指定なら undefined（必須でない）", async () => {
    await recordConversationTurn("やあ", "こんにちは", null);
    expect(mockedRecord.mock.calls[0][0].system).toBeUndefined();
  });

  it("recordLearning が throw しても false（会話を止めない）", async () => {
    mockedRecord.mockRejectedValue(new Error("net"));
    const ok = await recordConversationTurn("x", "y");
    expect(ok).toBe(false);
  });
});

describe("recordDecisionTurn（社長の判断を教師信号に記録）", () => {
  const ticket = { ticketId: "KZ-5", system: "ステレポ", title: "一覧が重い" };

  beforeEach(() => {
    mockedRecord.mockReset();
    mockedRecord.mockResolvedValue(true);
  });

  it("GO は kind:decision で記録", async () => {
    await recordDecisionTurn("go", ticket);
    const ev = mockedRecord.mock.calls[0][0];
    expect(ev.kind).toBe("decision");
    expect(ev.summary).toContain("GO（承認）");
    expect(ev.summary).toContain("KZ-5");
    expect(ev.system).toBe("ステレポ");
  });

  it("却下 は kind:decision で記録", async () => {
    await recordDecisionTurn("reject", ticket);
    const ev = mockedRecord.mock.calls[0][0];
    expect(ev.kind).toBe("decision");
    expect(ev.summary).toContain("却下");
  });

  it("修正(fix) は kind:correction で記録（しくじり先生＝軌道修正）", async () => {
    await recordDecisionTurn("fix", ticket, "色を青に直して");
    const ev = mockedRecord.mock.calls[0][0];
    expect(ev.kind).toBe("correction");
    expect(ev.summary).toContain("修正指示");
    expect(ev.detail).toContain("色を青に直して");
  });

  it("note が無ければ detail は undefined", async () => {
    await recordDecisionTurn("go", ticket);
    expect(mockedRecord.mock.calls[0][0].detail).toBeUndefined();
  });

  it("recordLearning が throw しても false（処理を止めない）", async () => {
    mockedRecord.mockRejectedValue(new Error("net"));
    const ok = await recordDecisionTurn("go", ticket);
    expect(ok).toBe(false);
  });
});
