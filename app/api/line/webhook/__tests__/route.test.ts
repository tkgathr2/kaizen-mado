// ── /api/line/webhook の「全体学習 配線」結合テスト ──
// 会話パスと判断パス（GO/却下/修正）で、memory層（record/recall）が実際に呼ばれることを検証する。
// memory層だけモック（converse の配線ヘルパは本物を走らせる）＝「実際につながっている」ことの担保。
// LINE署名検証・Notion読書・LINE返信・トリガは名前付きモックで閉じる（実HTTPは飛ばさない）。
import { describe, it, expect, vi, beforeEach } from "vitest";

// waitUntil は渡された Promise をそのまま実行させる（記録の発火を観測できるよう即解決を待つ）。
const scheduled: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    scheduled.push(Promise.resolve(p).catch(() => {}));
  },
}));

// memory層モック（配線の終端＝ここが呼ばれれば「つながっている」）
const recordLearning = vi.fn(async (..._a: unknown[]): Promise<boolean> => true);
const recallLearning = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
vi.mock("@/lib/memory", () => ({
  recordLearning: (...a: unknown[]) => recordLearning(...(a as [])),
  recallLearning: (...a: unknown[]) => recallLearning(...(a as [])),
}));

// LINE：署名OK・本人OK・自由文/コマンド解析・返信は観測用モック
const replyText = vi.fn(async () => undefined);
const verifyLineSignature = vi.fn((): boolean => true);
const isAuthorizedUser = vi.fn((): boolean => true);
const parsePostback = vi.fn((): { action: string; pageId: string; token: string } | null => null);
const parseTextCommand = vi.fn((): { action: string; ticketId: string; body: string } | null => null);
const verifyProposalToken = vi.fn((): boolean => true);
const getQuotedMap = vi.fn((): Record<string, string> => ({}));
vi.mock("@/lib/line", () => ({
  verifyLineSignature: (...a: unknown[]) => verifyLineSignature(...(a as [])),
  parsePostback: (...a: unknown[]) => parsePostback(...(a as [])),
  verifyProposalToken: (...a: unknown[]) => verifyProposalToken(...(a as [])),
  parseTextCommand: (...a: unknown[]) => parseTextCommand(...(a as [])),
  isAuthorizedUser: (...a: unknown[]) => isAuthorizedUser(...(a as [])),
  replyText: (...a: unknown[]) => replyText(...(a as [])),
  getQuotedMap: (...a: unknown[]) => getQuotedMap(...(a as [])),
}));

// チケット読取：GO待ち1件を返す（会話のcommand解決に使う）
const goMachiRow = {
  pageId: "p1",
  ticketId: "KZ-5",
  system: "ステレポ",
  type: "改善",
  importance: "中",
  title: "一覧が重い",
  detail: "",
  reporter: "現場",
  state: "GO待ち",
  fgsUrl: null,
};
const fetchTicketsByState = vi.fn(async () => [goMachiRow]);
const fetchAllTickets = vi.fn(async () => [goMachiRow]);
const findGoMachiByTicketId = vi.fn(async () => goMachiRow);
const fetchTicketByPageId = vi.fn(async () => goMachiRow);
const findRecentDuplicate = vi.fn(async () => null);
vi.mock("@/lib/tickets", () => ({
  fetchTicketByPageId: (...a: unknown[]) => fetchTicketByPageId(...(a as [])),
  findGoMachiByTicketId: (...a: unknown[]) => findGoMachiByTicketId(...(a as [])),
  fetchTicketsByState: (...a: unknown[]) => fetchTicketsByState(...(a as [])),
  fetchAllTickets: (...a: unknown[]) => fetchAllTickets(...(a as [])),
  findRecentDuplicate: (...a: unknown[]) => findRecentDuplicate(...(a as [])),
}));

// GO適用：成功（ok:true）を返す
const applyGoAction = vi.fn(async () => ({ ok: true, newState: "着手", reply: "GO受けました" }));
vi.mock("@/lib/govote", () => ({
  applyGoAction: (...a: unknown[]) => applyGoAction(...(a as [])),
}));

vi.mock("@/lib/trigger", () => ({ kickEndpoint: vi.fn(async () => true) }));
const createTicket = vi.fn(async () => ({ ticketId: "KZ-9" }));
vi.mock("@/lib/notion", () => ({
  createTicket: (...a: unknown[]) => createTicket(...(a as [])),
}));

import { POST } from "../route";

function makeReq(events: unknown[]): any {
  return {
    text: async () => JSON.stringify({ events }),
    headers: { get: () => "sig" },
  };
}

async function flush(): Promise<void> {
  await Promise.all(scheduled.splice(0));
}

// recordLearning に渡された LearningEvent を kind で絞り込む（テスト用に any へ落とす）。
function recordedEvents(kind: string): any[] {
  return recordLearning.mock.calls
    .map((c) => c[0] as any)
    .filter((e) => e?.kind === kind);
}

describe("/api/line/webhook 全体学習の配線", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduled.length = 0;
    verifyLineSignature.mockReturnValue(true);
    isAuthorizedUser.mockReturnValue(true);
    parseTextCommand.mockReturnValue(null);
    parsePostback.mockReturnValue(null);
    verifyProposalToken.mockReturnValue(true);
    getQuotedMap.mockReturnValue({});
    fetchTicketsByState.mockResolvedValue([goMachiRow]);
    fetchAllTickets.mockResolvedValue([goMachiRow]);
    applyGoAction.mockResolvedValue({ ok: true, newState: "着手", reply: "GO受けました" });
    // 会話は鍵なしでフォールバック文を返す経路（recallは呼ばれるが [] 既定）
    delete process.env.ANTHROPIC_API_KEY;
    process.env.KNOWHOW_ENABLED = "true";
  });

  it("状況質問（自由文）：返答前に recallLearning を引き、会話を recordLearning(conversation) する", async () => {
    process.env.ANTHROPIC_API_KEY = "k"; // 会話生成を通す（recall→generateReply経路）
    // generateReply 内の Anthropic fetch を失敗させてフォールバックさせる（記録は走る）
    const realFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as typeof fetch;

    const ev = { type: "message", message: { type: "text", text: "今どうなってる？" }, source: { userId: "u" }, replyToken: "rt" };
    const res = await POST(makeReq([ev]));
    expect(res).toBeTruthy();
    await flush();

    // recall が返答前に引かれている
    expect(recallLearning).toHaveBeenCalled();
    // 会話1ターンが記録された（kind:conversation）
    const convCalls = recordedEvents("conversation");
    expect(convCalls.length).toBe(1);
    expect(convCalls[0].summary).toContain("今どうなってる");

    global.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("GO（自由文コマンド）：decision を recordLearning する", async () => {
    const ev = { type: "message", message: { type: "text", text: "さっきの件GO" }, source: { userId: "u" }, replyToken: "rt" };
    await POST(makeReq([ev]));
    await flush();

    expect(applyGoAction).toHaveBeenCalled();
    const decisionCalls = recordedEvents("decision");
    expect(decisionCalls.length).toBe(1);
    expect(decisionCalls[0].summary).toContain("GO（承認）");
    expect(decisionCalls[0].summary).toContain("KZ-5");
  });

  it("テキストコマンド（GO KZ-5）：decision を recordLearning する", async () => {
    parseTextCommand.mockReturnValue({ action: "go", ticketId: "KZ-5", body: "" });
    const ev = { type: "message", message: { type: "text", text: "GO KZ-5" }, source: { userId: "u" }, replyToken: "rt" };
    await POST(makeReq([ev]));
    await flush();

    expect(applyGoAction).toHaveBeenCalled();
    expect(recordedEvents("decision").length).toBe(1);
  });

  it("ボタン（postback）GO：decision を recordLearning する", async () => {
    parsePostback.mockReturnValue({ action: "go", pageId: "p1", token: "t" });
    const ev = { type: "postback", postback: { data: "x" }, source: { userId: "u" }, replyToken: "rt" };
    await POST(makeReq([ev]));
    await flush();

    expect(applyGoAction).toHaveBeenCalled();
    expect(recordedEvents("decision").length).toBe(1);
  });

  it("記録（memory）が throw しても webhook は 200 を返す（fail-safe）", async () => {
    recordLearning.mockRejectedValue(new Error("boom"));
    parseTextCommand.mockReturnValue({ action: "go", ticketId: "KZ-5", body: "" });
    const ev = { type: "message", message: { type: "text", text: "GO KZ-5" }, source: { userId: "u" }, replyToken: "rt" };
    const res = await POST(makeReq([ev]));
    expect(res).toBeTruthy();
    await expect(flush()).resolves.toBeUndefined();
    // 返信は通常どおり行われる（記録失敗は社長への返信を壊さない）
    expect(replyText).toHaveBeenCalled();
  });
});
