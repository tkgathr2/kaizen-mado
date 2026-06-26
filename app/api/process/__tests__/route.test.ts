import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /api/process の宙づり対策テスト：
// 議論ステップで「議論中」へ先行更新した後に後続のNotion書込みがthrowしたとき、
// catch で必ず「受付」へ巻き戻す（fetchTicketsByState は「受付」しか拾わないため、
// 戻さないと「議論中」のまま二度と処理されず残置する）ことを検証する。

const updateTicketState = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const appendDiscussionBlocks = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const setTicketAssignee = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const fetchTicketsByState = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const discussTicket = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
const returnLearningFromCompleted = vi.fn(
  (..._a: unknown[]): Promise<{ memorized: number }> => Promise.resolve({ memorized: 0 })
);

vi.mock("@/lib/tickets", () => ({
  fetchTicketsByState: (...a: unknown[]) => fetchTicketsByState(...a),
  updateTicketState: (...a: unknown[]) => updateTicketState(...a),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  setTicketAssignee: (...a: unknown[]) => setTicketAssignee(...a),
}));
vi.mock("@/lib/discuss", () => ({
  discussTicket: (...a: unknown[]) => discussTicket(...a),
}));
vi.mock("@/lib/learn", () => ({
  returnLearningFromCompleted: (...a: unknown[]) => returnLearningFromCompleted(...a),
}));
// LINE送信・トリガ・ターゲット解決・ゲートは本テストの関心外なので無害化。
vi.mock("@/lib/line", () => ({
  pushProposal: vi.fn(async () => true),
  pushText: vi.fn(async () => true),
  msgHead: () => "",
  stageBar: () => "",
  BOARD_URL: "x",
}));
vi.mock("@/lib/trigger", () => ({ kickEndpoint: vi.fn(async () => true) }));
vi.mock("@/lib/targets", () => ({ findTarget: vi.fn(() => null) }));
vi.mock("@/lib/gate", () => ({
  preGate: vi.fn(() => ({ mode: "escalate", reasons: [] })),
  autopilotEnabled: vi.fn(() => false),
}));

import { POST } from "../route";

function makeReq(): any {
  return {
    headers: { get: () => null },
    json: async () => ({}),
    nextUrl: { searchParams: { get: () => null } },
  };
}

describe("/api/process 失敗時の状態巻き戻し", () => {
  const savedEnv = process.env.NODE_ENV;
  const savedSecret = process.env.CRON_SECRET;
  const savedInsecure = process.env.ALLOW_INSECURE_CRON;

  beforeEach(() => {
    vi.clearAllMocks();
    // CRON_SECRET未設定でも、明示フラグ ALLOW_INSECURE_CRON=1 のとき checkCronSecret が通る
    // （cronAuth は未設定時 fail-closed。本番は CRON_SECRET 設定で保護）。
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";
    (process.env as any).NODE_ENV = "test";
  });
  afterEach(() => {
    (process.env as any).NODE_ENV = savedEnv;
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedInsecure === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = savedInsecure;
  });

  it("議論ステップで例外が出たら状態を「受付」へ戻す", async () => {
    fetchTicketsByState.mockResolvedValueOnce([
      {
        pageId: "page-1",
        ticketId: "KZ-1",
        system: "プロレポ",
        type: "改善",
        importance: "中",
        title: "t",
        detail: "d",
        reporter: "現場",
        state: "受付",
        fgsUrl: null,
      },
    ]);
    // 「議論中」へ更新後の議論でthrow → catchへ。
    discussTicket.mockRejectedValueOnce(new Error("boom"));

    const res = await POST(makeReq());
    const json = await res.json();

    // 議論中へ進めた呼び出しと、受付へ戻した呼び出しの両方が起きている。
    expect(updateTicketState).toHaveBeenCalledWith("page-1", "議論中");
    expect(updateTicketState).toHaveBeenCalledWith("page-1", "受付");
    // 受付への巻き戻しは議論中への更新より後に呼ばれる（順序）。
    const states = updateTicketState.mock.calls.map((c) => c[1]);
    expect(states.indexOf("受付")).toBeGreaterThan(states.indexOf("議論中"));
    // エラーは握って応答自体は200で返し、errorsに積む。
    expect(json.ok).toBe(true);
    expect(json.errors?.[0]?.ticketId).toBe("KZ-1");
  });
});
