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

  // W4：fallbackにも具体手順・重要度・緊急度が入る
  it("fallback に具体手順(steps)・重要度・緊急度が入る", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await discussTicket({ ...baseTicket, type: "bug", importance: "高" });
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    // チケットの重要度を引き継ぐ
    expect(result.importance).toBe("高");
    // bug は緊急度=高 と推定
    expect(result.urgency).toBe("高");
    expect(["高", "中", "低"]).toContain(result.importance);
    expect(["高", "中", "低"]).toContain(result.urgency);
  });

  // LINE通知用の素人語フィールドが fallback にも入る
  it("fallback に素人語フィールド(problemPlain/fixPlain/riskPlain)が入る", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await discussTicket({ ...baseTicket, type: "bug" });
    expect(typeof result.problemPlain).toBe("string");
    expect(result.problemPlain.length).toBeGreaterThan(0);
    expect(Array.isArray(result.fixPlain)).toBe(true);
    expect(result.fixPlain.length).toBeGreaterThan(0);
    expect(result.fixPlain.length).toBeLessThanOrEqual(3);
    expect(typeof result.riskPlain).toBe("string");
    expect(result.riskPlain.length).toBeGreaterThan(0);
  });

  it("fallback の緊急度は種別で変わる（新機能=低）", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await discussTicket({ ...baseTicket, type: "新機能" });
    expect(r.urgency).toBe("低");
    expect(r.steps.length).toBeGreaterThan(0);
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
              steps: ["①直す", "②テスト"],
              kousuu: "2日",
              risks: ["影響範囲確認"],
              importance: "高",
              urgency: "低",
              recommendation: "GO推奨",
              go_ukagai_draft: "GO伺いです",
              problem_plain: "一覧が空っぽで見られない",
              fix_plain: ["表示の不具合を直す", "戻らないか確かめる"],
              risk_plain: "直したあと別の画面に影響が出ないか確認します",
            },
          },
        ],
      }),
    });

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("claude");
    expect(result.houshin).toBe("対応します");
    expect(result.steps).toEqual(["①直す", "②テスト"]);
    expect(result.importance).toBe("高");
    expect(result.urgency).toBe("低");
    expect(result.recommendation).toBe("GO推奨");
    expect(result.goDraft).toBe("GO伺いです");
    expect(result.problemPlain).toBe("一覧が空っぽで見られない");
    expect(result.fixPlain).toEqual(["表示の不具合を直す", "戻らないか確かめる"]);
    expect(result.riskPlain).toBe("直したあと別の画面に影響が出ないか確認します");
  });

  it("claude応答で plain が欠落なら houshin/steps/risks から補う（後方互換）", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "record_discussion",
            input: {
              houshin: "ここを直す方針です",
              steps: ["①該当箇所を修正", "②テスト追加"],
              kousuu: "1日",
              risks: ["既存機能への影響"],
              importance: "中",
              urgency: "中",
              recommendation: "要検討",
              go_ukagai_draft: "x",
              // problem_plain / fix_plain / risk_plain は欠落
            },
          },
        ],
      }),
    });

    const result = await discussTicket(baseTicket);
    expect(result.source).toBe("claude");
    // problemPlain は houshin から補う
    expect(result.problemPlain).toContain("ここを直す方針です");
    // fixPlain は steps から補う
    expect(result.fixPlain).toEqual(["①該当箇所を修正", "②テスト追加"]);
    // riskPlain は risks[0] から補う
    expect(result.riskPlain).toBe("既存機能への影響");
  });

  it("claude応答で importance/urgency が欠落ならチケットの重要度→中で補う", async () => {
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
              risks: [],
              recommendation: "要検討",
              go_ukagai_draft: "x",
            },
          },
        ],
      }),
    });

    // チケット重要度=低 → importance は低に、urgency は欠落なので低（fallbackLevel）に。
    const result = await discussTicket({ ...baseTicket, importance: "低" });
    expect(result.importance).toBe("低");
    expect(result.urgency).toBe("低");
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
  it("壊れ入力を安全に整形する（risks/steps非配列→[]、level不正→既定、recommendation不正→要検討、欠落→空）", () => {
    const r = coerceDiscussion({
      houshin: 123,
      steps: "not-an-array",
      risks: "not-an-array",
      importance: "なんか",
      urgency: 99,
      recommendation: "なんか",
    });
    expect(r.houshin).toBe("");
    expect(r.steps).toEqual([]);
    expect(r.kousuu).toBe("");
    expect(r.risks).toEqual([]);
    // level 不正・欠落は fallbackLevel（既定「中」）
    expect(r.importance).toBe("中");
    expect(r.urgency).toBe("中");
    expect(r.recommendation).toBe("要検討");
    expect(r.goDraft).toBe("");
    // plain は欠落・空でも破綻しない（riskPlain は「特になし」、fixPlainは[]）
    expect(typeof r.problemPlain).toBe("string");
    expect(Array.isArray(r.fixPlain)).toBe(true);
    expect(r.riskPlain).toBe("特になし");
  });

  it("fallbackLevel を渡すと level 欠落時にそれを使う", () => {
    const r = coerceDiscussion({ houshin: "x" }, "高");
    expect(r.importance).toBe("高");
    expect(r.urgency).toBe("高");
  });

  it("plain 欠落時は houshin/steps/risks から補う（後方互換）", () => {
    const r = coerceDiscussion({
      houshin: "ここを直す方針です",
      steps: ["①直す", "②テスト"],
      risks: ["影響範囲確認"],
    });
    expect(r.problemPlain).toContain("ここを直す方針です");
    expect(r.fixPlain).toEqual(["①直す", "②テスト"]);
    expect(r.riskPlain).toBe("影響範囲確認");
  });

  it("plain を直接渡せばそれを使う（長すぎは末尾を整える）", () => {
    const r = coerceDiscussion({
      problem_plain: "一覧が見られない",
      fix_plain: ["表示を直す", "確認する"],
      risk_plain: "特になし",
    });
    expect(r.problemPlain).toBe("一覧が見られない");
    expect(r.fixPlain).toEqual(["表示を直す", "確認する"]);
    expect(r.riskPlain).toBe("特になし");
  });

  it("正常入力をそのまま整形する", () => {
    const r = coerceDiscussion({
      houshin: " 方針 ",
      steps: [" ①直す ", "", "②テスト"],
      kousuu: "1日",
      risks: ["a", "", "b"],
      importance: "高",
      urgency: "低",
      recommendation: "非推奨",
      go_ukagai_draft: "下書き",
    });
    expect(r.houshin).toBe("方針");
    expect(r.steps).toEqual(["①直す", "②テスト"]);
    expect(r.risks).toEqual(["a", "b"]);
    expect(r.importance).toBe("高");
    expect(r.urgency).toBe("低");
    expect(r.recommendation).toBe("非推奨");
    expect(r.goDraft).toBe("下書き");
  });
});
