import { describe, it, expect } from "vitest";
import { clampScore, computePriority, isPriority } from "../priority";

describe("clampScore", () => {
  it("1〜10の整数はそのまま返す", () => {
    expect(clampScore(1)).toBe(1);
    expect(clampScore(5)).toBe(5);
    expect(clampScore(10)).toBe(10);
  });
  it("範囲外は1〜10にクランプする", () => {
    expect(clampScore(0)).toBe(1);
    expect(clampScore(-3)).toBe(1);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(99)).toBe(10);
  });
  it("小数は四捨五入する", () => {
    expect(clampScore(7.4)).toBe(7);
    expect(clampScore(7.6)).toBe(8);
  });
  it("数値文字列は数値として扱う", () => {
    expect(clampScore("8")).toBe(8);
  });
  it("数値でなければ null", () => {
    expect(clampScore(undefined)).toBeNull();
    expect(clampScore(null)).toBeNull();
    expect(clampScore("abc")).toBeNull();
    expect(clampScore(NaN)).toBeNull();
  });
});

describe("computePriority（§4.5.1 マッピング）", () => {
  it("高：どちらか8以上かつ合計14以上", () => {
    expect(computePriority(8, 9)).toBe("高"); // 合計17
    expect(computePriority(9, 5)).toBe("高"); // 緊急9・合計14
    expect(computePriority(6, 8)).toBe("高"); // 重要8・合計14
  });
  it("8以上でも合計14未満なら高にならない", () => {
    expect(computePriority(8, 3)).toBe("中"); // 合計11
  });
  it("どちらも8未満なら（合計14以上でも）高にならない", () => {
    expect(computePriority(7, 7)).toBe("中"); // 合計14だが両方<8
  });
  it("中：合計8〜13", () => {
    expect(computePriority(4, 4)).toBe("中"); // 合計8
    expect(computePriority(6, 7)).toBe("中"); // 合計13
  });
  it("低：合計7以下", () => {
    expect(computePriority(1, 1)).toBe("低"); // 合計2
    expect(computePriority(3, 4)).toBe("低"); // 合計7
  });
  it("範囲外入力もクランプして判定する", () => {
    expect(computePriority(20, 20)).toBe("高");
    expect(computePriority(0, 0)).toBe("低"); // 1+1=2
  });
});

describe("isPriority", () => {
  it("高/中/低のみ true", () => {
    expect(isPriority("高")).toBe(true);
    expect(isPriority("中")).toBe(true);
    expect(isPriority("低")).toBe(true);
  });
  it("それ以外は false", () => {
    expect(isPriority("urgent")).toBe(false);
    expect(isPriority("")).toBe(false);
    expect(isPriority(undefined)).toBe(false);
    expect(isPriority(8)).toBe(false);
  });
});
