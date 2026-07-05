import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// reaper のリトライ上限テスト（無限リトライ根絶・KZ-17事案）：
//  ① count < 上限 … 従来どおり「着手」へ戻す（印にリトライ回数を明記）。
//  ② count >= 上限 … 「着手」へ戻さず「差し戻し」＋🛑LINE（最後の失敗理由つき）。
//  ③ env KAIZEN_MAX_RETRIES で上限を上書きできる。
//  ④ カウント取得失敗（getReaperRetryInfo が {count:0} を返す契約）→ 安全側＝戻す。

const updateTicketState = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const appendDiscussionBlocks = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const fetchTicketsByState = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const fetchStaleImplementing = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const staleImplementingMinutes = vi.fn(() => 30);
const getReaperRetryInfo = vi.fn(async (_pageId: string) => ({ count: 0, lastFailure: null as string | null }));
const maxAutoRetries = vi.fn(() => 3);
const setStatusChangedAt = vi.fn(async () => {});
const pushText = vi.fn(async (_t: string) => true);
const dispatchExecution = vi.fn(async (..._a: unknown[]) => true);
const dispatchEnabled = vi.fn(() => true);
const buildDispatchPayload = vi.fn((..._a: unknown[]) => ({ autoMerge: true }));
const findTarget = vi.fn((..._a: unknown[]) => null as unknown);

vi.mock("@/lib/tickets", () => ({
  fetchTicketsByState: (...a: unknown[]) => fetchTicketsByState(...a),
  updateTicketState: (...a: unknown[]) => updateTicketState(...a),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  fetchStaleImplementing: (...a: unknown[]) => fetchStaleImplementing(...a),
  staleImplementingMinutes: () => staleImplementingMinutes(),
  getReaperRetryInfo: (...a: unknown[]) => getReaperRetryInfo(...(a as [string])),
  maxAutoRetries: () => maxAutoRetries(),
  setStatusChangedAt: (...a: unknown[]) => setStatusChangedAt(...(a as [])),
  REAPER_RESET_HEADING: "stuck回収（自動リセット）",
  RETRY_CAP_HEADING: "自動リトライ上限（差し戻し）",
}));
vi.mock("@/lib/targets", () => ({ findTarget: (...a: unknown[]) => findTarget(...a) }));
vi.mock("@/lib/orchestrate", () => ({
  dispatchExecution: (...a: unknown[]) => dispatchExecution(...(a as [])),
  dispatchEnabled: () => dispatchEnabled(),
  buildDispatchPayload: (...a: unknown[]) => buildDispatchPayload(...a),
}));
vi.mock("@/lib/line", () => ({
  pushText: (...a: unknown[]) => pushText(...(a as [string])),
  truncateForLine: (s: string) => s,
  notionPageUrl: (id: string) => `https://www.notion.so/${id}`,
  stageBar: () => "",
  BOARD_URL: "x",
  msgHead: (_e: string, kind: string) => kind,
}));
vi.mock("@/lib/notification", () => ({
  enqueueNotification: async () => {},
}));

import { POST } from "../route";

function makePlanReq(): any {
  return {
    headers: { get: () => null },
    json: async () => ({}),
    nextUrl: { searchParams: { get: (k: string) => (k === "mode" ? "plan" : null) } },
  };
}

function staleTicket(over: Record<string, unknown> = {}) {
  return {
    pageId: "page-stuck",
    ticketId: "KZ-17",
    system: "カイゼンくん本体",
    type: "改善",
    importance: "中",
    title: "自動改修が失敗し続ける件",
    detail: "…",
    reporter: "現場",
    state: "実装中",
    fgsUrl: null,
    ...over,
  };
}

describe("/api/execute reaper リトライ上限（KAIZEN_MAX_RETRIES・既定3）", () => {
  const savedSecret = process.env.CRON_SECRET;
  const savedInsecure = process.env.ALLOW_INSECURE_CRON;

  beforeEach(() => {
    vi.clearAllMocks();
    maxAutoRetries.mockReturnValue(3);
    getReaperRetryInfo.mockResolvedValue({ count: 0, lastFailure: null });
    fetchTicketsByState.mockResolvedValue([]);
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedInsecure === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = savedInsecure;
  });

  it("count 0→1→2 は従来どおり「着手」へ戻す・3 で差し戻し（0→1→2→3）", async () => {
    for (const count of [0, 1, 2]) {
      vi.clearAllMocks();
      maxAutoRetries.mockReturnValue(3);
      fetchTicketsByState.mockResolvedValue([]);
      fetchStaleImplementing.mockResolvedValue([staleTicket()]);
      getReaperRetryInfo.mockResolvedValue({ count, lastFailure: null });

      const res = await POST(makePlanReq());
      const json = await res.json();

      expect(updateTicketState).toHaveBeenCalledWith("page-stuck", "着手");
      expect(updateTicketState).not.toHaveBeenCalledWith("page-stuck", "差し戻し");
      expect(pushText).not.toHaveBeenCalled();
      expect(json.reaped).toContain("KZ-17");
      expect(json.retryCapped ?? []).not.toContain("KZ-17");
      // 印にリトライ回数を明記（何回目/上限）。
      const bodies = appendDiscussionBlocks.mock.calls
        .flatMap((c) => (c[1] as { body?: string }[]) ?? [])
        .map((b) => b.body ?? "");
      expect(bodies.join()).toContain(`自動リトライ ${count + 1}/3 回目`);
    }

    // count=3（上限到達）→ 差し戻し。
    vi.clearAllMocks();
    maxAutoRetries.mockReturnValue(3);
    fetchTicketsByState.mockResolvedValue([]);
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    getReaperRetryInfo.mockResolvedValue({ count: 3, lastFailure: "401 Unauthorized" });

    const res = await POST(makePlanReq());
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-stuck", "差し戻し");
    expect(updateTicketState).not.toHaveBeenCalledWith("page-stuck", "着手");
    expect(json.retryCapped).toContain("KZ-17");
    expect(json.reaped ?? []).not.toContain("KZ-17");
  });

  it("上限到達時は🛑LINEを1回送る（回数＋最後の失敗理由＋差し戻し）", async () => {
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    getReaperRetryInfo.mockResolvedValue({ count: 3, lastFailure: "401 Unauthorized" });

    await POST(makePlanReq());

    expect(pushText).toHaveBeenCalledTimes(1);
    const text = String(pushText.mock.calls[0][0]);
    expect(text).toContain("KZ-17");
    expect(text).toContain("3回試して失敗したため停止");
    expect(text).toContain("401 Unauthorized");
    expect(text).toContain("差し戻し");
    // 議論ブロックにも上限到達の印を残す（次回以降このチケットは数え直し）。
    const headings = appendDiscussionBlocks.mock.calls
      .flatMap((c) => (c[1] as { heading?: string }[]) ?? [])
      .map((b) => b.heading ?? "");
    expect(headings.join()).toContain("自動リトライ上限");
  });

  it("失敗理由が残っていないときは「不明」ではなくActionsログ確認の文言を出す", async () => {
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    getReaperRetryInfo.mockResolvedValue({ count: 3, lastFailure: null });
    findTarget.mockReturnValue({
      system: "カイゼンくん本体",
      repo: "tkgathr2/kaizen-mado",
      healthUrl: null,
      forbiddenPaths: [],
      autoEligible: true,
    });

    await POST(makePlanReq());

    const text = String(pushText.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("実装ジョブが完了報告なしで停止");
    expect(text).toContain("https://github.com/tkgathr2/kaizen-mado/actions");
    expect(text).not.toContain("理由：不明");
  });

  it("env上書き：上限1なら count=1 で差し戻し", async () => {
    maxAutoRetries.mockReturnValue(1);
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    getReaperRetryInfo.mockResolvedValue({ count: 1, lastFailure: "tests failed" });

    const res = await POST(makePlanReq());
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-stuck", "差し戻し");
    expect(json.retryCapped).toContain("KZ-17");
  });

  it("カウント取得失敗（契約＝count:0）は安全側＝従来どおり「着手」へ戻す", async () => {
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    // getReaperRetryInfo は内部fail-safeで {count:0,lastFailure:null} を返す契約。
    getReaperRetryInfo.mockResolvedValue({ count: 0, lastFailure: null });

    const res = await POST(makePlanReq());
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-stuck", "着手");
    expect(updateTicketState).not.toHaveBeenCalledWith("page-stuck", "差し戻し");
    expect(json.reaped).toContain("KZ-17");
  });

  it("差し戻したチケットは同じ実行の着手リストから除外する（二重処理防止）", async () => {
    fetchStaleImplementing.mockResolvedValue([staleTicket()]);
    getReaperRetryInfo.mockResolvedValue({ count: 3, lastFailure: "x" });
    // 着手フェッチに同じ pageId が混ざって返っても処理しない。
    fetchTicketsByState.mockResolvedValue([staleTicket({ state: "着手" })]);
    findTarget.mockReturnValue({
      system: "カイゼンくん本体",
      repo: "tkgathr2/kaizen-mado",
      healthUrl: null,
      forbiddenPaths: [],
      autoEligible: true,
    });

    const res = await POST(makePlanReq());
    const json = await res.json();

    expect(json.dispatched ?? []).not.toContain("KZ-17");
    expect(buildDispatchPayload).not.toHaveBeenCalled();
  });
});
