import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── /api/cron/kz-sweep：状態タイムアウト監視の通知が構造化stallペイロードで
//    handoffStallToSanada（kind="stall"）を呼ぶことを検証する（2026-08-15 社長形式承認・案A）。
// hasDiscussionHeading（Postgres版・DB移行2026-08-16）は既定で「未リマインド」側（false）を
// 返すモックにする（旧 hasReminderBlock の Notion直叩き版と同じ既定挙動）。

const fetchNonTerminalTickets = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const updateTicketState = vi.fn(async (..._a: unknown[]) => {});
const appendDiscussionBlocks = vi.fn(async (..._a: unknown[]) => {});
const setStatusChangedAt = vi.fn(async () => {});
const hasDiscussionHeading = vi.fn(async (..._a: unknown[]) => false);
const checkCronSecret = vi.fn((..._a: unknown[]) => true);
const notifySlackAlert = vi.fn(async (..._a: unknown[]) => true);
const enqueueNotification = vi.fn(async (..._a: unknown[]) => {});
const handoffStallToSanada = vi.fn(async (_payload: any) => true);

vi.mock("@/lib/tickets", () => ({
  fetchNonTerminalTickets: (...a: unknown[]) => fetchNonTerminalTickets(...a),
  updateTicketState: (...a: unknown[]) => updateTicketState(...a),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  setStatusChangedAt: (...a: unknown[]) => setStatusChangedAt(...(a as [])),
  hasDiscussionHeading: (...a: unknown[]) => hasDiscussionHeading(...a),
}));
vi.mock("@/lib/cronAuth", () => ({
  checkCronSecret: (...a: unknown[]) => checkCronSecret(...a),
}));
vi.mock("@/lib/line", () => ({
  notifySlackAlert: (...a: unknown[]) => notifySlackAlert(...a),
}));
vi.mock("@/lib/notification", () => ({
  enqueueNotification: (...a: unknown[]) => enqueueNotification(...a),
}));
vi.mock("@/lib/handoff", () => ({
  handoffStallToSanada: (p: unknown) => handoffStallToSanada(p),
  ticketUrlOf: (pageId: string) => `https://www.notion.so/${(pageId || "").replace(/-/g, "")}`,
}));

import { GET } from "../route";

function makeReq(): any {
  return { headers: { get: () => null } };
}

const HOUR = 3_600_000;

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    pageId: "page-131",
    ticketId: "KZ-131",
    system: "カイゼンくん本体",
    type: "改善",
    importance: "中",
    title: "停滞チケット",
    detail: "…",
    reporter: "現場",
    state: "GO待ち",
    fgsUrl: null,
    statusChangedAt: new Date().toISOString(),
    lastEdited: new Date().toISOString(),
    ...overrides,
  };
}

describe("/api/cron/kz-sweep（構造化stallペイロード送信）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkCronSecret.mockReturnValue(true);
    handoffStallToSanada.mockResolvedValue(true);
    fetchNonTerminalTickets.mockResolvedValue([]);
    hasDiscussionHeading.mockResolvedValue(false); // 常に「未リマインド」側へ倒す
  });

  it("GO待ち48h超：stallKind=awaiting_go, stallPhase=remind, autoCloseInHoursを含めて送る", async () => {
    const now = Date.now();
    const row = ticket({
      state: "GO待ち",
      statusChangedAt: new Date(now - 50 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.results[0].action).toBe("reminded");

    expect(handoffStallToSanada).toHaveBeenCalledTimes(1);
    const payload = handoffStallToSanada.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: "stall",
      ticketId: "KZ-131",
      title: "停滞チケット",
      system: "カイゼンくん本体",
      stallKind: "awaiting_go",
      stallPhase: "remind",
      elapsedHours: 50,
      ticketUrl: "https://www.notion.so/page131",
      autoCloseInHours: 118, // 168h - 50h
    });
    expect("prUrl" in payload).toBe(false);
  });

  it("GO待ち7日超：stallKind=awaiting_go, stallPhase=closed（autoCloseInHoursは含めない）", async () => {
    const now = Date.now();
    const row = ticket({
      state: "GO待ち",
      statusChangedAt: new Date(now - 169 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.results[0].action).toBe("closed");
    expect(updateTicketState).toHaveBeenCalledWith("page-131", "クローズ");

    const payload = handoffStallToSanada.mock.calls[0][0];
    expect(payload).toMatchObject({
      stallKind: "awaiting_go",
      stallPhase: "closed",
      elapsedHours: 169,
    });
    expect("autoCloseInHours" in payload).toBe(false);
  });

  it("差し戻し48h超：stallKind=blocked, stallPhase=remind, autoCloseInHoursを含める", async () => {
    const now = Date.now();
    const row = ticket({
      state: "差し戻し",
      statusChangedAt: new Date(now - 60 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    const payload = handoffStallToSanada.mock.calls[0][0];
    expect(payload).toMatchObject({
      stallKind: "blocked",
      stallPhase: "remind",
      elapsedHours: 60,
      autoCloseInHours: 108, // 168h - 60h
    });
  });

  it("レビュー7日超・PR URLありのチケット：stallKind=review, prUrlを含める", async () => {
    const now = Date.now();
    const row = ticket({
      state: "レビュー",
      statusChangedAt: new Date(now - 200 * HOUR).toISOString(),
      prUrl: "https://github.com/tkgathr2/kaizen-mado/pull/12",
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    const payload = handoffStallToSanada.mock.calls[0][0];
    expect(payload).toMatchObject({
      stallKind: "review",
      stallPhase: "remind",
      prUrl: "https://github.com/tkgathr2/kaizen-mado/pull/12",
    });
    expect("autoCloseInHours" in payload).toBe(false);
  });

  it("レビュー7日超・PR URL未記録のチケット：prUrlキー自体を省略する", async () => {
    const now = Date.now();
    const row = ticket({
      state: "レビュー",
      statusChangedAt: new Date(now - 200 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    const payload = handoffStallToSanada.mock.calls[0][0];
    expect("prUrl" in payload).toBe(false);
  });

  it("真田実装中48h超：stallKind=sanada_implementing, stallPhase=remind（autoCloseInHoursなし）", async () => {
    const now = Date.now();
    const row = ticket({
      state: "真田実装中",
      statusChangedAt: new Date(now - 50 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    const payload = handoffStallToSanada.mock.calls[0][0];
    expect(payload).toMatchObject({
      stallKind: "sanada_implementing",
      stallPhase: "remind",
      elapsedHours: 50,
    });
    expect("autoCloseInHours" in payload).toBe(false);
  });

  it("handoffStallToSanadaが失敗（false）したらSlack警告へフォールバックする", async () => {
    handoffStallToSanada.mockResolvedValue(false);
    const now = Date.now();
    const row = ticket({
      state: "GO待ち",
      statusChangedAt: new Date(now - 50 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    expect(notifySlackAlert).toHaveBeenCalledTimes(1);
    const [detail] = notifySlackAlert.mock.calls[0] as [string];
    expect(detail).toContain("KZ-131");
  });

  it("handoffStallToSanadaが成功（true）したらSlack警告は呼ばない", async () => {
    handoffStallToSanada.mockResolvedValue(true);
    const now = Date.now();
    const row = ticket({
      state: "GO待ち",
      statusChangedAt: new Date(now - 50 * HOUR).toISOString(),
    });
    fetchNonTerminalTickets.mockResolvedValue([row]);

    await GET(makeReq());
    expect(notifySlackAlert).not.toHaveBeenCalled();
  });
});
