import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetRateLimit } from "@/lib/ratelimit";

// 名無し起票の拒否（社長指示）：reporter が widget/session のどちらからも
// 取れないときは Notion 起票せず 400 を返すことを検証する。
// 手入力欄はUI側で廃止済み（社長指示）だが、widget埋め込みの reporterParam も
// サーバから見れば同じ body.reporter 経路を通るため、そこは変わらず 200 になる
// （＝Web UI を経由しない直接APIコールでは自称 reporter を防げない既知の制約。
//   bug-check-lab 2026-08-09 レビューで確認済み。閉じるには埋め込み元ごとの署名検証が必要）。

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

function makeReq(
  body: unknown,
  env: Record<string, string> = {},
  headers: Record<string, string> = {}
): any {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const baseTicket = { ticket: { system: "prorepo", type: "改善", title: "件名", detail: "詳細" } };

describe("POST /api/submit（起票者必須ガード）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimit();
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.KAIZEN_SUBMIT_RATE_PER_MIN;
    delete process.env.KAIZEN_SUBMIT_RATE_PER_HOUR;
  });

  it("reporter が無い（widget/session すべて空）と400で起票しない", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: null }));
    expect(res.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("reporter が空白のみでも400で起票しない", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: "   " }));
    expect(res.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("body.reporter（widgetのreporterParam経路）があれば起票する（認証OFF）", async () => {
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

  it("認証ON・未ログインでbody.reporterも無ければ400", async () => {
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

  it("reporter の改行・連続空白を無害化してからNotionへ渡す（LINE文面注入対策）", async () => {
    const res = await POST(makeReq({ ...baseTicket, reporter: "田中\n📮 経路：Slack から" }));
    expect(res.status).toBe(200);
    expect(createTicket).toHaveBeenCalledWith(expect.anything(), "田中 📮 経路：Slack から");
  });

  it("reporter を40文字に切ってからNotionへ渡す", async () => {
    const long = "あ".repeat(60);
    const res = await POST(makeReq({ ...baseTicket, reporter: long }));
    expect(res.status).toBe(200);
    expect(createTicket).toHaveBeenCalledWith(expect.anything(), "あ".repeat(40));
  });

  it("同一IPからの連打は分あたり上限で429になる", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const env = { KAIZEN_SUBMIT_RATE_PER_MIN: "2", KAIZEN_SUBMIT_RATE_PER_HOUR: "100" };
    const req1 = makeReq({ ...baseTicket, reporter: "高木" }, env, headers);
    const req2 = makeReq({ ...baseTicket, reporter: "高木" }, env, headers);
    const req3 = makeReq({ ...baseTicket, reporter: "高木" }, env, headers);
    expect((await POST(req1)).status).toBe(200);
    expect((await POST(req2)).status).toBe(200);
    const res3 = await POST(req3);
    expect(res3.status).toBe(429);
    expect(createTicket).toHaveBeenCalledTimes(2);
  });

  it("異なるIPからの送信はレート制限を共有しない", async () => {
    const env = { KAIZEN_SUBMIT_RATE_PER_MIN: "1", KAIZEN_SUBMIT_RATE_PER_HOUR: "100" };
    const reqA1 = makeReq({ ...baseTicket, reporter: "高木" }, env, { "x-forwarded-for": "203.0.113.1" });
    const reqA2 = makeReq({ ...baseTicket, reporter: "高木" }, env, { "x-forwarded-for": "203.0.113.1" });
    const reqB1 = makeReq({ ...baseTicket, reporter: "脇本" }, env, { "x-forwarded-for": "203.0.113.2" });
    expect((await POST(reqA1)).status).toBe(200);
    expect((await POST(reqA2)).status).toBe(429);
    expect((await POST(reqB1)).status).toBe(200);
  });
});
