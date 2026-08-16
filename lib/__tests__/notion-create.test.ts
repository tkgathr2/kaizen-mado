import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// lib/notion.ts の createTicket（起票）が Notion API → Postgres へ移行したことの検証（2026-08-16）。
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db/pool", () => ({
  getPool: () => ({ query: (...args: any[]) => queryMock(...args) }),
  ensureSchema: async () => undefined,
}));

import { createTicket } from "../notion";
import type { Ticket } from "../types";

const T0 = new Date("2026-06-26T12:00:00.000Z");

function insertedRow(over: Record<string, any> = {}) {
  return {
    id: "42",
    ticket_number: 131,
    system: "ほうこちゃん",
    type: "改善",
    importance: "中",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    reporter: "高木",
    state: "受付",
    assignee: "",
    fgs_url: null,
    pr_url: null,
    urgency: null,
    importance_score: null,
    priority: null,
    priority_reason: null,
    status_changed_at: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    slack_user_id: null,
    notion_page_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

const baseTicket: Ticket = {
  system: "ほうこちゃん",
  type: "改善",
  title: "写真が横倒し",
  detail: "PDFで回転する",
  importance: "中",
};

const sqlOf = (i = 0) => String(queryMock.mock.calls[i][0]).replace(/\s+/g, " ").trim();
const paramsOf = (i = 0) => queryMock.mock.calls[i][1];

let savedBaseUrl: string | undefined;
let savedFetch: typeof global.fetch;

beforeEach(() => {
  queryMock.mockReset();
  savedBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  // Notionへは一切出ていかないことを担保するため fetch を握って監視する。
  savedFetch = global.fetch;
  global.fetch = vi.fn();
});

afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = savedBaseUrl;
  global.fetch = savedFetch;
});

describe("createTicket（Postgres起票）", () => {
  it("tickets へ INSERT し、SubmitResult を返す（Notion APIは叩かない）", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });

    const result = await createTicket(baseTicket, "高木");

    expect(result.ticketId).toBe("KZ-131");
    // notion_page_id が無い新規行なので、pageId は内部ID(42=0x2a)から合成される。
    expect(result.pageId).toBe("00000000-0000-4000-8000-00000000002a");
    expect(global.fetch).not.toHaveBeenCalled();

    expect(sqlOf()).toContain("INSERT INTO tickets");
    expect(sqlOf()).toContain("(SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets)");
    expect(sqlOf()).toContain("RETURNING *");
    // 状態は「受付」で始まる
    expect(paramsOf()[6]).toBe("受付");
    expect(paramsOf()[5]).toBe("高木");
  });

  it("起票者が空なら『現場フォーム』にフォールバックする", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });
    await createTicket(baseTicket, "   ");
    expect(paramsOf()[5]).toBe("現場フォーム");

    queryMock.mockClear();
    await createTicket(baseTicket, null);
    expect(paramsOf()[5]).toBe("現場フォーム");
  });

  it("優先度スコアリング・Slackメタも同じINSERTで保存する（Notion時代の再試行は不要）", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });
    await createTicket(
      {
        ...baseTicket,
        urgency: 9,
        importanceScore: 8,
        priority: "高",
        priorityReason: "業務停止",
        slackChannelId: "C1",
        slackThreadTs: "1720000000.0001",
        slackUserId: "U1",
      },
      "高木"
    );
    const p = paramsOf();
    expect(p.slice(7)).toEqual([9, 8, "高", "業務停止", "C1", "1720000000.0001", "U1"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("スコア・Slackメタが無ければ null で入る", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });
    await createTicket(baseTicket, "高木");
    expect(paramsOf().slice(7)).toEqual([null, null, null, null, null, null, null]);
  });

  it("タイトルは100字で切る", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });
    await createTicket({ ...baseTicket, title: "あ".repeat(150) }, "高木");
    expect(paramsOf()[3]).toHaveLength(100);
  });

  it("タイトル未設定なら『改善のご要望』", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });
    await createTicket({ ...baseTicket, title: "" }, "高木");
    expect(paramsOf()[3]).toBe("改善のご要望");
  });

  it("ticket_number の採番衝突(23505)はリトライして成功させる", async () => {
    const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
    queryMock
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({ rows: [insertedRow({ ticket_number: 133 })] });

    const result = await createTicket(baseTicket, "高木");
    expect(result.ticketId).toBe("KZ-133");
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("採番衝突以外のDBエラーは即座に投げる（握り潰さない）", async () => {
    queryMock.mockRejectedValue(
      Object.assign(new Error("connection refused"), { code: "08006" })
    );
    await expect(createTicket(baseTicket, "高木")).rejects.toThrow(/connection refused/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("pageUrl はチケット詳細画面を指す（KAIZEN_PUBLIC_BASE。未設定時は既定のhttps://kaizen.takagi.bzに一本化・bug-check-lab Medium-5修正）", async () => {
    queryMock.mockResolvedValue({ rows: [insertedRow()] });

    // KAIZEN_PUBLIC_BASE未設定でも既定値が使われる（NEXT_PUBLIC_BASE_URL/VERCEL_URLには
    // もはや依存しない。旧実装は未設定時に空文字を返していたが、house標準の
    // ticketUrlOf(lib/handoff.ts)へ一本化したことで常にURLが返るようになった）。
    const r1 = await createTicket(baseTicket, "高木");
    expect(r1.pageUrl).toBe(
      "https://kaizen.takagi.bz/board/ticket/00000000-0000-4000-8000-00000000002a"
    );

    const savedBase = process.env.KAIZEN_PUBLIC_BASE;
    process.env.KAIZEN_PUBLIC_BASE = "https://custom.example.com";
    try {
      const r2 = await createTicket(baseTicket, "高木");
      expect(r2.pageUrl).toBe(
        "https://custom.example.com/board/ticket/00000000-0000-4000-8000-00000000002a"
      );
    } finally {
      if (savedBase === undefined) delete process.env.KAIZEN_PUBLIC_BASE;
      else process.env.KAIZEN_PUBLIC_BASE = savedBase;
    }
  });
});
