import { describe, it, expect, vi, beforeEach } from "vitest";

// 名無し起票の拒否（社長指示）：reporter が widget/session/手入力のどれからも
// 取れないときは Notion 起票せず 400 を返すことを検証する。

const auth = vi.fn(async (): Promise<any> => null);
const createTicket = vi.fn(async (..._a: unknown[]) => ({ ok: true, ticketId: "KZ-1", pageId: "p1" }));
const memorizeToKnowhow = vi.fn(async (..._a: unknown[]) => false);
const kickEndpoint = vi.fn(async (..._a: unknown[]) => true);
const acceptSubmit = vi.fn((..._a: unknown[]) => true);
const findRecentDuplicate = vi.fn(async (..._a: unknown[]) => null);

vi.mock("@/auth", () => ({ auth: (...a: unknown[]) => auth(...(a as [])) }));
vi.mock("@/lib/notion", () => ({ createTicket: (...a: unknown[]) => createTicket(...a) }));
vi.mock("@/lib/knowhow", () => ({ memorizeToKnowhow: (...a: unknown[]) => memorizeToKnowhow(...a) }));
vi.mock("@/lib/trigger", () => ({ kickEndpoint: (...a: unknown[]) => kickEndpoint(...a) }));
vi.mock("@/lib/dedup", () => ({ acceptSubmit: (...a: unknown[]) => acceptSubmit(...a) }));
vi.mock("@/lib/tickets", () => ({
  findRecentDuplicate: (...a: unknown[]) => findRecentDuplicate(...a),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: (_p: Promise<unknown>) => {} }));

import { POST } from "../route";

function makeReq(body: unknown, env: Record<string, string> = {}): any {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return {
    headers: { get: () => null },
    json: async () => body,
  };
}

const baseTicket = { ticket: { system: "prorepo", type: "改善", title: "件名", detail: "詳細" } };

describe("POST /api/submit（起票者必須ガード）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_SECRET;
  });

  it("reporter が無い（widget/session/手入力すべて空）と400で起票しない", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: null }));
    expect(res.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("reporter が空白のみでも400で起票しない", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: "   " }));
    expect(res.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("手入力の reporter があれば起票する（認証OFF）", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: "高木" }));
    expect(res.status).toBe(200);
    expect(createTicket).toHaveBeenCalledWith(expect.anything(), "高木");
  });

  it("認証ON・ログイン済みならbody.reporter無しでもセッション名で起票する", async () => {
    auth.mockResolvedValueOnce({ user: { name: "高木豊大", email: "atsuhiro@takagi.bz" } });
    const res = await POST(
      makeReq(
        { ...baseTicket, reporter: null },
        { AUTH_GOOGLE_ID: "x", AUTH_GOOGLE_SECRET: "y", AUTH_SECRET: "z" }
      )
    );
    expect(res.status).toBe(200);
    expect(createTicket).toHaveBeenCalledWith(expect.anything(), "高木豊大");
  });

  it("認証ON・未ログインで手入力も無ければ400", async () => {
    auth.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq(
        { ...baseTicket, reporter: null },
        { AUTH_GOOGLE_ID: "x", AUTH_GOOGLE_SECRET: "y", AUTH_SECRET: "z" }
      )
    );
    expect(res.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });
});
