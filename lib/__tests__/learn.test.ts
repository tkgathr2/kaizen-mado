import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { returnLearningFromCompleted } from "../learn";

// 完了済み未学習チケット1件を返す query 応答
function completedQueryResponse() {
  return {
    ok: true,
    json: async () => ({
      results: [
        {
          id: "page-done-1",
          properties: {
            ID: { type: "unique_id", unique_id: { prefix: "KZ", number: 5 } },
            対象システム: { type: "select", select: { name: "プロレポ" } },
            種別: { type: "select", select: { name: "bug" } },
            重要度: { type: "select", select: { name: "高" } },
            チケット名: { type: "title", title: [{ plain_text: "エラー修正" }] },
            内容: { type: "rich_text", rich_text: [{ plain_text: "500が出る" }] },
            起票者: { type: "rich_text", rich_text: [{ plain_text: "現場フォーム" }] },
            状態: { type: "select", select: { name: "完了" } },
            FGSリンク: { type: "url", url: null },
          },
        },
      ],
    }),
  };
}

describe("returnLearningFromCompleted", () => {
  let originalEnabled: string | undefined;
  let originalToken: string | undefined;
  let originalDbId: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnabled = process.env.KNOWHOW_ENABLED;
    originalToken = process.env.NOTION_TOKEN;
    originalDbId = process.env.NOTION_DATABASE_ID;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.KNOWHOW_ENABLED;
    else process.env.KNOWHOW_ENABLED = originalEnabled;
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    if (originalDbId === undefined) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = originalDbId;
    global.fetch = originalFetch;
  });

  it("KNOWHOW_ENABLED 未設定なら {memorized:0, skipped:'disabled'}（fetchを呼ばない）", async () => {
    delete process.env.KNOWHOW_ENABLED;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await returnLearningFromCompleted();
    expect(result).toEqual({ memorized: 0, skipped: "disabled" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("有効化＋完了チケット1件で memorized:1 を返し、マークPATCHが呼ばれる", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    process.env.NOTION_TOKEN = "test-token";
    process.env.NOTION_DATABASE_ID = "test-db";

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      // query（DB) → 完了チケット応答 / それ以外（memorize・PATCH）は ok
      if (url.includes("/databases/")) {
        return Promise.resolve(completedQueryResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromCompleted();
    expect(result.memorized).toBe(1);

    // memorize 送信があり PIIマスク対象のraw_logが入っている
    const memorizeCall = calls.find((c) => c.url.includes("/api/devin/memorize"));
    expect(memorizeCall).toBeDefined();
    const memBody = JSON.parse(memorizeCall!.init.body as string);
    expect(memBody.raw_log).toContain("【完了カイゼン】");

    // FGSリンクへの冪等マーク PATCH が呼ばれる
    const markCall = calls.find(
      (c) =>
        c.url === "https://api.notion.com/v1/pages/page-done-1" &&
        c.init.method === "PATCH"
    );
    expect(markCall).toBeDefined();
    const markBody = JSON.parse(markCall!.init.body as string);
    expect(markBody.properties.FGSリンク.url).toBe("knowhow://memorized");
  });

  it("memorize が ok=false ならマークせず memorized:0", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    process.env.NOTION_TOKEN = "test-token";
    process.env.NOTION_DATABASE_ID = "test-db";

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/databases/")) {
        return Promise.resolve(completedQueryResponse());
      }
      if (url.includes("/api/devin/memorize")) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromCompleted();
    expect(result.memorized).toBe(0);
    const markCall = calls.find(
      (c) => c.url.includes("/pages/") && c.init.method === "PATCH"
    );
    expect(markCall).toBeUndefined();
  });
});
