import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { memorizeToKnowhow } from "../knowhow";
import type { Ticket } from "../types";

const baseTicket: Ticket = {
  system: "プロレポ",
  type: "改善",
  title: "一覧が表示されない",
  detail: "一覧ページを開くと何も表示されません",
  importance: "中",
};

describe("memorizeToKnowhow", () => {
  let originalEnabled: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnabled = process.env.KNOWHOW_ENABLED;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.KNOWHOW_ENABLED;
    } else {
      process.env.KNOWHOW_ENABLED = originalEnabled;
    }
    global.fetch = originalFetch;
  });

  it("KNOWHOW_ENABLED未設定のときfetchを呼ばずfalseを返す", async () => {
    delete process.env.KNOWHOW_ENABLED;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await memorizeToKnowhow(baseTicket, "TKT-001");
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("KNOWHOW_ENABLED=falseのときfetchを呼ばずfalseを返す", async () => {
    process.env.KNOWHOW_ENABLED = "false";
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await memorizeToKnowhow(baseTicket, "TKT-001");
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("KNOWHOW_ENABLED=trueのときfetchを1回呼ぶ", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    await memorizeToKnowhow(baseTicket, "TKT-002");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("有効化時・res.ok=trueならtrueを返す", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await memorizeToKnowhow(baseTicket, "TKT-003");
    expect(result).toBe(true);
  });

  it("有効化時・res.ok=falseならfalseを返す（例外なし）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await memorizeToKnowhow(baseTicket, "TKT-004");
    expect(result).toBe(false);
  });

  it("有効化時・fetchがthrowしてもfalseを返す（例外なし）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await memorizeToKnowhow(baseTicket, "TKT-005");
    expect(result).toBe(false);
  });

  it("送信bodyのraw_logにメールアドレスが含まれない（PIIマスク確認）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    let capturedBody = "";
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({ ok: true });
    });

    const ticketWithPII: Ticket = {
      ...baseTicket,
      title: "tanaka@example.com からの問い合わせ",
      detail: "担当者(tanaka@example.com)が確認しました",
    };
    await memorizeToKnowhow(ticketWithPII, "TKT-006");

    const parsed = JSON.parse(capturedBody);
    expect(parsed.raw_log).not.toContain("tanaka@example.com");
    expect(parsed.raw_log).toContain("[メール]");
  });

  it("送信bodyのraw_logに電話番号が含まれない（PIIマスク確認）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    let capturedBody = "";
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({ ok: true });
    });

    const ticketWithPhone: Ticket = {
      ...baseTicket,
      title: "090-1234-5678 から連絡あり",
      detail: "03-9876-5432 に折り返し電話してください",
    };
    await memorizeToKnowhow(ticketWithPhone, "TKT-007");

    const parsed = JSON.parse(capturedBody);
    expect(parsed.raw_log).not.toContain("090-1234-5678");
    expect(parsed.raw_log).not.toContain("03-9876-5432");
    expect(parsed.raw_log).toContain("[電話]");
  });

  it("raw_logに起票者欄が存在しない（人名は正規表現で守れないため送らない・仕様v2.0 §3）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    let capturedBody = "";
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({ ok: true });
    });

    await memorizeToKnowhow(baseTicket, "TKT-009");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.raw_log).not.toContain("起票者");
  });

  it("エンドポイントURLに/api/devin/memorizeを含む", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true });
    });

    await memorizeToKnowhow(baseTicket, "TKT-008");
    expect(capturedUrl).toContain("/api/devin/memorize");
  });
});
