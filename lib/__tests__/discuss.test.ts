import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discussTicket, coerceDiscussion } from "../discuss";
import type { TicketRow } from "../tickets";

const baseTicket: TicketRow = {
  pageId: "page-1",
  ticketId: "KZ-1",
  system: "プロレポ",
  type: "改善",
  importance: "中",
  title: "一覧が表示されない",
  detail: "一覧ページが空になる",
  reporter: "現場フォーム",
  state: "受付",
  fgsUrl: null,
};

describe("discussTicket", () => {
  let originalKey: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  it("ANTHROPIC_API_KEY 未設定のとき fallback を返す（fetch を呼ばない）", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("fallback");
    expect(typeof result.houshin).toBe("string");
    expect(result.houshin.length).toBeGreaterThan(0);
    expect(Array.isArray(result.risks)).toBe(true);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(["GO推奨", "要検討", "非推奨"]).toContain(result.recommendation);
    expect(result.goDraft.length).toBeGreaterThan(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("重要度=高なら fallback の推奨は GO推奨", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await discussTicket({ ...baseTicket, importance: "高" });
    expect(result.recommendation).toBe("GO推奨");
  });

  it("API 応答が ok=false のとき fallback に落ちる（throwしない）", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("fallback");
  });

  it("tool_use が返れば source=claude で整形して返す", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "record_discussion",
            input: {
              houshin: "対応します",
              kousuu: "2日",
              risks: ["影響範囲確認"],
              recommendation: "GO推奨",
              go_ukagai_draft: "GO伺いです",
            },
          },
        ],
      }),
    });

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("claude");
    expect(result.houshin).toBe("対応します");
    expect(result.recommendation).toBe("GO推奨");
    expect(result.goDraft).toBe("GO伺いです");
  });

  it("tool_use が無いとき fallback に落ちる", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "hello" }] }),
    });

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("fallback");
  });
});

describe("coerceDiscussion", () => {
  it("壊れ入力を安全に整形する（risks非配列→[]、recommendation不正→要検討、欠落→空）", () => {
    const r = coerceDiscussion({
      houshin: 123,
      risks: "not-an-array",
      recommendation: "なんか",
    });
    expect(r.houshin).toBe("");
    expect(r.kousuu).toBe("");
    expect(r.risks).toEqual([]);
    expect(r.recommendation).toBe("要検討");
    expect(r.goDraft).toBe("");
  });

  it("正常入力をそのまま整形する", () => {
    const r = coerceDiscussion({
      houshin: " 方針 ",
      kousuu: "1日",
      risks: ["a", "", "b"],
      recommendation: "非推奨",
      go_ukagai_draft: "下書き",
    });
    expect(r.houshin).toBe("方針");
    expect(r.risks).toEqual(["a", "b"]);
    expect(r.recommendation).toBe("非推奨");
    expect(r.goDraft).toBe("下書き");
  });
});
