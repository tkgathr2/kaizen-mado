import { describe, expect, it } from "vitest";
import { isEmbed } from "@/lib/embed";

describe("isEmbed", () => {
  it("真値表記（1/true/yes・大文字・空白）を埋め込みと判定する", () => {
    expect(isEmbed("1")).toBe(true);
    expect(isEmbed("true")).toBe(true);
    expect(isEmbed("TRUE")).toBe(true);
    expect(isEmbed(" yes ")).toBe(true);
  });

  it("未指定・空・その他の値は通常表示", () => {
    expect(isEmbed(null)).toBe(false);
    expect(isEmbed(undefined)).toBe(false);
    expect(isEmbed("")).toBe(false);
    expect(isEmbed("0")).toBe(false);
    expect(isEmbed("false")).toBe(false);
    expect(isEmbed("embed")).toBe(false);
  });
});
