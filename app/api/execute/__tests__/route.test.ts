import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /api/execute のGO後挙動テスト（社長指示2026-06-27「GO＝全自動修正」）：
//  ① GO後（state=着手）は機微キーワード・autoEligible を理由に止めない＝そのまま実改修へ流す。
//  ② 止まるのは「物理的に自動修正不能」なときだけ＝repo:null（PR先なし）。その場合は
//     「社長に相談」ではなく「自動修正できません（リポ未設定）」で正直に弾く。
//  ③ dispatch には autoMerge=true（反映まで全自動）を渡す。

const updateTicketState = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const appendDiscussionBlocks = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const fetchTicketsByState = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const fetchStaleImplementing = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const staleImplementingMinutes = vi.fn(() => 30);
const pushText = vi.fn(async () => true);
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
}));
vi.mock("@/lib/targets", () => ({ findTarget: (...a: unknown[]) => findTarget(...a) }));
vi.mock("@/lib/orchestrate", () => ({
  dispatchExecution: (...a: unknown[]) => dispatchExecution(...(a as [])),
  dispatchEnabled: () => dispatchEnabled(),
  buildDispatchPayload: (...a: unknown[]) => buildDispatchPayload(...a),
}));
vi.mock("@/lib/line", () => ({
  pushText: (...a: unknown[]) => pushText(...(a as [])),
  truncateForLine: (s: string) => s,
  notionPageUrl: () => "u",
  stageBar: () => "",
  BOARD_URL: "x",
  msgHead: () => "",
}));

import { POST } from "../route";

function makeReq(planMode = false): any {
  return {
    headers: { get: () => null },
    json: async () => ({}),
    nextUrl: { searchParams: { get: (k: string) => (k === "mode" && planMode ? "plan" : null) } },
  };
}

function ticket(over: Record<string, unknown> = {}) {
  return {
    pageId: "page-1",
    ticketId: "KZ-22",
    system: "Indeed応募通知",
    type: "改善",
    importance: "中",
    title: "Gmail認証エラーを直して",
    detail: "認証エラーでメールが取れない（パスワード/認証/氏名）",
    reporter: "現場",
    state: "着手",
    fgsUrl: null,
    ...over,
  };
}

describe("/api/execute GO後は全自動（機微・autoEligibleで止めない）", () => {
  const savedSecret = process.env.CRON_SECRET;
  const savedInsecure = process.env.ALLOW_INSECURE_CRON;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchEnabled.mockReturnValue(true);
    dispatchExecution.mockResolvedValue(true);
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedInsecure === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = savedInsecure;
  });

  it("機微キーワードを含むGO済みチケットでも止めず、autoMerge=true で dispatch する", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticket()]);
    // repo あり＝物理的に直せる。
    findTarget.mockReturnValue({ system: "Indeed応募通知", repo: "tkgathr2/recruit", healthUrl: null, forbiddenPaths: [], autoEligible: true });

    const res = await POST(makeReq(false));
    const json = await res.json();

    // 社長確認へエスカレしていない（「実装中」へ進めて dispatch している）。
    expect(updateTicketState).toHaveBeenCalledWith("page-1", "実装中");
    expect(updateTicketState).not.toHaveBeenCalledWith("page-1", "社長確認");
    // dispatch は autoMerge=true で呼ばれる（反映まで全自動）。
    expect(dispatchExecution).toHaveBeenCalledWith(
      expect.objectContaining({ autoMerge: true })
    );
    // 「社長に相談」LINEは送らない。
    expect(pushText).not.toHaveBeenCalled();
    expect(json.dispatched).toContain("KZ-22");
    expect(json.escalated ?? []).not.toContain("KZ-22");
  });

  it("repo:null（PR先なし）のときだけ『自動修正できません（リポ未設定）』で正直に弾く", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticket({ system: "簡単日報くん" })]);
    // autoEligible=true でも repo:null＝物理的に直せない。
    findTarget.mockReturnValue({ system: "簡単日報くん", repo: null, healthUrl: null, forbiddenPaths: [], autoEligible: true });

    const res = await POST(makeReq(false));
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-1", "社長確認");
    expect(dispatchExecution).not.toHaveBeenCalled();
    // 追記の見出しが「リポ未設定」で、機微/autoEligibleの理由は出さない。
    const headings = appendDiscussionBlocks.mock.calls
      .flatMap((c) => (c[1] as { heading: string }[]) ?? [])
      .map((b) => b.heading);
    expect(headings.join()).toContain("リポ未設定");
    expect(headings.join()).not.toContain("社長案件へエスカレ");
    expect(json.escalated).toContain("KZ-22");
  });

  it("対象未定義（findTarget=null）も『自動修正できません』で弾く", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticket({ system: "未知システム" })]);
    findTarget.mockReturnValue(null);

    const res = await POST(makeReq(false));
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-1", "社長確認");
    expect(dispatchExecution).not.toHaveBeenCalled();
    expect(json.escalated).toContain("KZ-22");
  });

  it("planモード：直せるチケットは buildDispatchPayload(…, true) で autoMerge=true", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticket()]);
    findTarget.mockReturnValue({ system: "Indeed応募通知", repo: "tkgathr2/recruit", healthUrl: null, forbiddenPaths: [], autoEligible: true });

    const res = await POST(makeReq(true));
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-1", "実装中");
    // 第3引数（autoMerge）が true で呼ばれる。
    const call = buildDispatchPayload.mock.calls[0];
    expect(call?.[2]).toBe(true);
    expect(json.dispatched).toContain("KZ-22");
  });
});
