import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTicketsByState,
  fetchAllTickets,
  fetchCompletedUnlearned,
  updateTicketState,
  setTicketUrlField,
  appendDiscussionBlocks,
} from "../tickets";

// 指定件数ぶんのダミー結果ページを生成（has_more / next_cursor 制御つき）。
function page(count: number, hasMore: boolean, cursor?: string) {
  const results = Array.from({ length: count }, (_, i) => ({
    id: `page-${cursor ?? "first"}-${i}`,
    properties: {
      ID: { type: "unique_id", unique_id: { prefix: "KZ", number: i + 1 } },
      対象システム: { type: "select", select: { name: "プロレポ" } },
      種別: { type: "select", select: { name: "改善" } },
      重要度: { type: "select", select: { name: "中" } },
      チケット名: { type: "title", title: [{ plain_text: `t${i}` }] },
      内容: { type: "rich_text", rich_text: [] },
      起票者: { type: "rich_text", rich_text: [] },
      状態: { type: "select", select: { name: "完了" } },
      FGSリンク: { type: "url", url: null },
    },
  }));
  return {
    ok: true,
    json: async () => ({ results, has_more: hasMore, next_cursor: hasMore ? (cursor ?? "cur-1") : null }),
  };
}

// query 応答のダミー（properties一式入り1件）
function queryResponse() {
  return {
    ok: true,
    json: async () => ({
      results: [
        {
          id: "page-abc-123",
          properties: {
            ID: { type: "unique_id", unique_id: { prefix: "KZ", number: 12 } },
            対象システム: { type: "select", select: { name: "プロレポ" } },
            種別: { type: "select", select: { name: "改善" } },
            重要度: { type: "select", select: { name: "高" } },
            チケット名: {
              type: "title",
              title: [{ plain_text: "一覧が" }, { plain_text: "表示されない" }],
            },
            内容: {
              type: "rich_text",
              rich_text: [{ plain_text: "一覧ページが空になる" }],
            },
            起票者: {
              type: "rich_text",
              rich_text: [{ plain_text: "現場フォーム" }],
            },
            状態: { type: "select", select: { name: "受付" } },
            FGSリンク: { type: "url", url: null },
          },
        },
      ],
    }),
  };
}

describe("tickets", () => {
  let originalToken: string | undefined;
  let originalDbId: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalToken = process.env.NOTION_TOKEN;
    originalDbId = process.env.NOTION_DATABASE_ID;
    originalFetch = global.fetch;
    process.env.NOTION_TOKEN = "test-token";
    process.env.NOTION_DATABASE_ID = "test-db";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    if (originalDbId === undefined) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = originalDbId;
    global.fetch = originalFetch;
  });

  it("fetchTicketsByState がプロパティを TicketRow に正しくマップする", async () => {
    global.fetch = vi.fn().mockResolvedValue(queryResponse());

    const rows = await fetchTicketsByState("受付", 5);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.pageId).toBe("page-abc-123");
    expect(r.ticketId).toBe("KZ-12");
    expect(r.system).toBe("プロレポ");
    expect(r.type).toBe("改善");
    expect(r.importance).toBe("高");
    expect(r.title).toBe("一覧が表示されない");
    expect(r.detail).toBe("一覧ページが空になる");
    expect(r.reporter).toBe("現場フォーム");
    expect(r.state).toBe("受付");
    expect(r.fgsUrl).toBeNull();
  });

  it("fetchTicketsByState は query エンドポイントへ正しい filter/page_size で POST する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(queryResponse());
    });

    await fetchTicketsByState("受付", 3);
    expect(capturedUrl).toBe(
      "https://api.notion.com/v1/databases/test-db/query"
    );
    expect(capturedInit.method).toBe("POST");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.filter).toEqual({ property: "状態", select: { equals: "受付" } });
    expect(body.page_size).toBe(3);
  });

  it("updateTicketState は page を PATCH し状態 select を更新する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await updateTicketState("page-xyz", "GO待ち");
    expect(capturedUrl).toBe("https://api.notion.com/v1/pages/page-xyz");
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.状態).toEqual({ select: { name: "GO待ち" } });
  });

  it("setTicketUrlField は FGSリンク url を PATCH する", async () => {
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await setTicketUrlField("page-xyz", "knowhow://memorized");
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.FGSリンク).toEqual({ url: "knowhow://memorized" });
  });

  it("appendDiscussionBlocks は blocks/children へ heading_3 と paragraph を PATCH する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await appendDiscussionBlocks("page-xyz", [
      { heading: "方針", body: "対応します" },
    ]);
    expect(capturedUrl).toBe(
      "https://api.notion.com/v1/blocks/page-xyz/children"
    );
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.children).toHaveLength(2);
    expect(body.children[0].type).toBe("heading_3");
    expect(body.children[1].type).toBe("paragraph");
    expect(body.children[0].heading_3.rich_text[0].text.content).toBe("方針");
    expect(body.children[1].paragraph.rich_text[0].text.content).toBe("対応します");
  });

  it("token 未設定のとき throw する", async () => {
    delete process.env.NOTION_TOKEN;
    global.fetch = vi.fn();
    await expect(fetchTicketsByState("受付")).rejects.toThrow();
  });

  it("query 応答が ok=false のとき throw する", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => "err" });
    await expect(fetchTicketsByState("受付")).rejects.toThrow(/Notion query error/);
  });

  // ── ページネーション（has_more / next_cursor）対応 ──
  it("fetchAllTickets は has_more の間 start_cursor を付けて全件取得する", async () => {
    const captured: any[] = [];
    let call = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured.push(JSON.parse(init.body as string));
      call++;
      // 1ページ目: 100件 has_more=true、2ページ目: 30件 has_more=false。
      return Promise.resolve(call === 1 ? page(100, true, "cur-1") : page(30, false));
    });

    const rows = await fetchAllTickets(500);
    expect(rows).toHaveLength(130); // 100 + 30 を取りこぼさず合算
    expect(captured).toHaveLength(2);
    expect(captured[0].start_cursor).toBeUndefined(); // 1回目はカーソルなし
    expect(captured[1].start_cursor).toBe("cur-1"); // 2回目は前回のnext_cursor
    expect(captured[0].sorts).toBeTruthy(); // ボードはsorts付き
  });

  it("fetchAllTickets は limit に達したら has_more でも止める", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(page(100, true, "cur-1"));
    });
    const rows = await fetchAllTickets(100);
    expect(rows).toHaveLength(100);
    expect(call).toBe(1); // limitちょうどで2ページ目を引かない
  });

  it("fetchCompletedUnlearned もページネーションで全件取得する", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(call === 1 ? page(100, true, "cur-1") : page(5, false));
    });
    const rows = await fetchCompletedUnlearned(1000);
    expect(rows).toHaveLength(105);
    expect(call).toBe(2);
  });
});
