import { describe, it, expect } from "vitest";
import { TARGETS, findTarget } from "../targets";

describe("targets", () => {
  it("全システムが autoEligible=true（社長指示2026-06-27「全部ONにして」）", () => {
    // 1件でも false が残っていたら、GO後にautoEligibleを理由に止まりうるので回帰防止。
    const notEligible = TARGETS.filter((t) => !t.autoEligible).map((t) => t.system);
    expect(notEligible).toEqual([]);
  });

  it("findTarget は名前で引ける／未知は null", () => {
    expect(findTarget("ステレポ")?.repo).toBe("tkgathr2/sterepo");
    expect(findTarget("存在しないシステム")).toBe(null);
    expect(findTarget(null)).toBe(null);
    expect(findTarget(undefined)).toBe(null);
  });

  it("repo:null のシステムも存在する（物理的に自動修正不能＝リポ未設定で正直に弾く対象）", () => {
    // autoEligible=true でも repo が無いものは execute 側で「リポ未設定」として弾かれる。
    const repoNull = TARGETS.filter((t) => t.repo === null);
    expect(repoNull.length).toBeGreaterThan(0);
  });
});
