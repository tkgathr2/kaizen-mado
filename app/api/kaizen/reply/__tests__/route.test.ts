import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// POST /api/kaizen/reply の検証：
// 真田チャネル（mention-hisho）が、社長の引用返信（詰まり連絡への回答）を書き戻す口。
//  - 認証：x-kaizen-reply-secret を KAIZEN_REPLY_SECRET と比較。未設定は503（fail-closed）。
//  - ticketId でチケットを探し、見つかれば「真田チャネルからの回答」として議論ブロックへ追記。
//  - 見つからなければ 404 {ok:false, error:"ticket not found"}。

const findTicketByTicketId = vi.fn(async (_id: string): Promise<unknown> => null);
const appendDiscussionBlocks = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("@/lib/tickets", () => ({
  findTicketByTicketId: (...a: unknown[]) => findTicketByTicketId(...(a as [string])),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
}));

import { POST } from "../route";

function makeReq(body: unknown, headers: Record<string, string> = {}): any {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const ticket = {
  pageId: "page-reply-1",
  ticketId: "KZ-9",
  system: "カイゼンくん本体",
  type: "改善",
  importance: "中",
  title: "詰まったやつ",
  detail: "d",
  reporter: "現場",
  state: "差し戻し",
  fgsUrl: null,
};

describe("POST /api/kaizen/reply", () => {
  const savedSecret = process.env.KAIZEN_REPLY_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KAIZEN_REPLY_SECRET = "reply-secret";
    findTicketByTicketId.mockResolvedValue(ticket);
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.KAIZEN_REPLY_SECRET;
    else process.env.KAIZEN_REPLY_SECRET = savedSecret;
  });

  it("KAIZEN_REPLY_SECRET未設定なら503（fail-closed・チケット検索もしない）", async () => {
    delete process.env.KAIZEN_REPLY_SECRET;
    const res = await POST(
      makeReq(
        { ticketId: "KZ-9", replyText: "回答です" },
        { "x-kaizen-reply-secret": "anything" }
      )
    );
    expect(res.status).toBe(503);
    expect(findTicketByTicketId).not.toHaveBeenCalled();
  });

  it("認証ヘッダ不一致なら401", async () => {
    const res = await POST(
      makeReq({ ticketId: "KZ-9", replyText: "回答です" }, { "x-kaizen-reply-secret": "wrong" })
    );
    expect(res.status).toBe(401);
    expect(findTicketByTicketId).not.toHaveBeenCalled();
  });

  it("認証ヘッダ無しなら401", async () => {
    const res = await POST(makeReq({ ticketId: "KZ-9", replyText: "回答です" }));
    expect(res.status).toBe(401);
  });

  it("正しい認証・ticketId/replyTextありなら議論ブロックへ追記して{ok:true}", async () => {
    const res = await POST(
      makeReq(
        { ticketId: "KZ-9", replyText: "認証情報はこれです" },
        { "x-kaizen-reply-secret": "reply-secret" }
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(findTicketByTicketId).toHaveBeenCalledWith("KZ-9");
    expect(appendDiscussionBlocks).toHaveBeenCalledWith("page-reply-1", [
      { heading: "真田チャネルからの回答", body: "認証情報はこれです" },
    ]);
  });

  it("チケットが見つからなければ404 {ok:false, error:'ticket not found'}", async () => {
    findTicketByTicketId.mockResolvedValue(null);
    const res = await POST(
      makeReq(
        { ticketId: "KZ-999", replyText: "回答です" },
        { "x-kaizen-reply-secret": "reply-secret" }
      )
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ ok: false, error: "ticket not found" });
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("ticketId/replyTextが欠けていれば400", async () => {
    const res1 = await POST(
      makeReq({ replyText: "回答です" }, { "x-kaizen-reply-secret": "reply-secret" })
    );
    expect(res1.status).toBe(400);

    const res2 = await POST(
      makeReq({ ticketId: "KZ-9" }, { "x-kaizen-reply-secret": "reply-secret" })
    );
    expect(res2.status).toBe(400);

    expect(findTicketByTicketId).not.toHaveBeenCalled();
  });

  it("不正なJSONなら400", async () => {
    const req: any = {
      headers: { get: (name: string) => (name === "x-kaizen-reply-secret" ? "reply-secret" : null) },
      json: async () => {
        throw new Error("bad json");
      },
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("Notionへの追記が例外を投げたら500 {ok:false}", async () => {
    appendDiscussionBlocks.mockRejectedValueOnce(new Error("notion down"));
    const res = await POST(
      makeReq(
        { ticketId: "KZ-9", replyText: "回答です" },
        { "x-kaizen-reply-secret": "reply-secret" }
      )
    );
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
  });
});
