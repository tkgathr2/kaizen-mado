import { describe, expect, it } from "vitest";
import { inProgressFromFunnel } from "../inProgress";

// 進行中 ＝ 全件 −「完了」−「見送り」。段が増えても数え漏れないことを担保する。
describe("inProgressFromFunnel", () => {
  it("完了・見送り以外の合計を返す", () => {
    const funnel = [
      { stage: "受付", count: 3 },
      { stage: "検討・提案中", count: 2 },
      { stage: "改修中", count: 1 },
      { stage: "完了", count: 5 },
      { stage: "見送り", count: 4 },
    ];
    expect(inProgressFromFunnel(funnel)).toBe(6); // 3+2+1
  });

  it("空でも0", () => {
    expect(inProgressFromFunnel([])).toBe(0);
  });

  it("完了・見送りだけなら0", () => {
    expect(
      inProgressFromFunnel([
        { stage: "完了", count: 7 },
        { stage: "見送り", count: 2 },
      ])
    ).toBe(0);
  });

  it("新しい段が増えても進行中として数える（直書きの数え漏れを防ぐ）", () => {
    const funnel = [
      { stage: "受付", count: 1 },
      { stage: "新段階・テスト中", count: 4 }, // 将来追加される進行中の段
      { stage: "完了", count: 9 },
    ];
    expect(inProgressFromFunnel(funnel)).toBe(5); // 1+4（完了は除外）
  });
});
