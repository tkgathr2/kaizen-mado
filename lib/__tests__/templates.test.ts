/**
 * templates.ts の基本テスト
 */
import { describe, it, expect } from "vitest";
import { SUGGESTION_TEMPLATES } from "../templates";
import type { SuggestionTemplate } from "../templates";

describe("SUGGESTION_TEMPLATES", () => {
  it("配列が空でない（6〜8件）", () => {
    expect(SUGGESTION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(SUGGESTION_TEMPLATES.length).toBeLessThanOrEqual(8);
  });

  it("各エントリに label と text が非空で存在する", () => {
    for (const t of SUGGESTION_TEMPLATES) {
      expect(typeof t.label).toBe("string");
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(typeof t.text).toBe("string");
      expect(t.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("SuggestionTemplate 型と互換性がある", () => {
    const first: SuggestionTemplate = SUGGESTION_TEMPLATES[0];
    expect(first).toHaveProperty("label");
    expect(first).toHaveProperty("text");
  });

  it("label が重複していない", () => {
    const labels = SUGGESTION_TEMPLATES.map((t) => t.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});
