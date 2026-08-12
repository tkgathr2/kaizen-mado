import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /api/process の宙づり対策テスト：
// 議論ステップで「議論中」へ先行更新した後に後続のNotion書込みがthrowしたとき、
// catch で必ず「受付」へ巻き戻す（fetchTicketsByState は「受付」しか拾わないため、
// 戻さないと「議論中」のまま二度と処理されず残置する）ことを検証する。

const updateTicketState = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const appendDiscussionBlocks = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const setTicketAssignee = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const setStatusChangedAt = vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
const fetchTicketsByState = vi.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
const discussTicket = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
const returnLearningFromCompleted = vi.fn(
  (..._a: unknown[]): Promise<{ memorized: number }> => Promise.resolve({ memorized: 0 })
);
// 新仕様の検証用：LINE送信モックを名前付きで保持し「呼ばれない」ことを検証する。
const pushProposal = vi.fn(async () => true);
const pushText = vi.fn(async () => true);
// 2026-08-12：真田システム（mention-hisho）への受け渡し。成功したら pushProposal は呼ばない。
const handoffToSanada = vi.fn(async () => true);
const kickEndpoint = vi.fn(async () => true);

vi.mock("@/lib/tickets", () => ({
  fetchTicketsByState: (...a: unknown[]) => fetchTicketsByState(...a),
  updateTicketState: (...a: unknown[]) => updateTicketState(...a),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  setTicketAssignee: (...a: unknown[]) => setTicketAssignee(...a),
  setStatusChangedAt: (...a: unknown[]) => setStatusChangedAt(...a),
}));
vi.mock("@/lib/discuss", () => ({
  discussTicket: (...a: unknown[]) => discussTicket(...a),
}));
vi.mock("@/lib/learn", () => ({
  returnLearningFromCompleted: (...a: unknown[]) => returnLearningFromCompleted(...a),
}));
// LINE送信・トリガ・ターゲット解決・ゲートは名前付きモックで差し替え（呼び出し検証に使う）。
vi.mock("@/lib/line", () => ({
  pushProposal: (...a: unknown[]) => pushProposal(...(a as [])),
  pushText: (...a: unknown[]) => pushText(...(a as [])),
  msgHead: () => "",
  stageBar: () => "",
  BOARD_URL: "x",
}));
vi.mock("@/lib/handoff", () => ({
  handoffToSanada: (...a: unknown[]) => handoffToSanada(...(a as [])),
}));
vi.mock("@/lib/trigger", () => ({ kickEndpoint: (...a: unknown[]) => kickEndpoint(...(a as [])) }));
vi.mock("@/lib/targets", () => ({ findTarget: vi.fn(() => ({ repo: "tkgathr2/x" })) }));

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
    // clearAllMocks は実装（mockResolvedValue 等）を消さないため、テスト間で明示的に既定へ戻す。
    handoffToSanada.mockResolvedValue(true);
    pushProposal.mockResolvedValue(true);
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

// ── 2026-08-12 社長指示：全チケットが必ず社長のLINE確認を経由する（オートパイロット廃止） ──
// 通知の本線は真田システム（mention-hisho）への受け渡し。失敗したときだけ自前LINEへフォールバック。
describe("/api/process 全件GO待ち＋真田システムへの受け渡し", () => {
  const savedEnv = process.env.NODE_ENV;
  const savedSecret = process.env.CRON_SECRET;
  const savedInsecure = process.env.ALLOW_INSECURE_CRON;

  function ticketRow(overrides: Record<string, unknown> = {}) {
    return {
      pageId: "page-2",
      ticketId: "KZ-2",
      system: "カイゼンくん本体",
      type: "改善",
      importance: "低",
      title: "t2",
      detail: "d2",
      reporter: "現場",
      state: "受付",
      fgsUrl: null,
      ...overrides,
    };
  }

  // 旧仕様なら自動着手に流れていた条件（安全・低リスク・GO推奨）の議論結果。
  function goDiscussion() {
    return {
      houshin: "h",
      steps: ["①なおす"],
      kousuu: "k",
      risks: [],
      importance: "中",
      urgency: "中",
      recommendation: "GO推奨",
      goDraft: "g",
      problemPlain: "こまりごと",
      fixPlain: ["なおす"],
      riskPlain: "特になし",
      source: "fallback",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handoffToSanada.mockResolvedValue(true);
    pushProposal.mockResolvedValue(true);
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

  it("GO推奨・安全案件でも自動着手せず「GO待ち」にする（オートパイロット廃止）", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticketRow()]);
    discussTicket.mockResolvedValueOnce(goDiscussion());

    const res = await POST(makeReq());
    const json = await res.json();

    expect(updateTicketState).toHaveBeenCalledWith("page-2", "GO待ち");
    // ★肝：どんなに安全でも「着手」へは進めない＝必ず社長のLINE確認を経由する。
    expect(updateTicketState).not.toHaveBeenCalledWith("page-2", "着手");
    // 着手しないので /api/execute の kick も起きない。
    expect(kickEndpoint).not.toHaveBeenCalled();
    expect(json.ok).toBe(true);
  });

  it("受け渡し成功時は自前LINE（pushProposal）を送らない", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticketRow()]);
    discussTicket.mockResolvedValueOnce(goDiscussion());
    handoffToSanada.mockResolvedValue(true);

    const res = await POST(makeReq());
    const json = await res.json();

    expect(handoffToSanada).toHaveBeenCalledTimes(1);
    expect(pushProposal).not.toHaveBeenCalled();
    expect(pushText).not.toHaveBeenCalled();
    expect(json.processed?.[0]?.notifiedVia).toBe("handoff");
    expect(json.processed?.[0]?.notified).toBe(true);
  });

  it("受け渡し失敗時は自前LINE（pushProposal）へフォールバックする", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticketRow()]);
    discussTicket.mockResolvedValueOnce(goDiscussion());
    handoffToSanada.mockResolvedValue(false);

    const res = await POST(makeReq());
    const json = await res.json();

    expect(handoffToSanada).toHaveBeenCalledTimes(1);
    // 無音状態を作らないため、handoffが落ちたら従来のGO伺いを送る。
    expect(pushProposal).toHaveBeenCalledTimes(1);
    expect(json.processed?.[0]?.notifiedVia).toBe("line");
    expect(json.processed?.[0]?.notified).toBe(true);
  });

  it("受け渡しもLINEも失敗したら notifiedVia=none で記録する", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticketRow()]);
    discussTicket.mockResolvedValueOnce(goDiscussion());
    handoffToSanada.mockResolvedValue(false);
    pushProposal.mockResolvedValue(false);

    const res = await POST(makeReq());
    const json = await res.json();

    expect(json.processed?.[0]?.notifiedVia).toBe("none");
    expect(json.processed?.[0]?.notified).toBe(false);
  });

  it("受け渡しには state=GO待ち のチケットと議論結果を渡す", async () => {
    fetchTicketsByState.mockResolvedValueOnce([ticketRow()]);
    const d = goDiscussion();
    discussTicket.mockResolvedValueOnce(d);

    await POST(makeReq());

    const [passedTicket, passedDiscussion] = handoffToSanada.mock.calls[0] as any[];
    expect(passedTicket.ticketId).toBe("KZ-2");
    expect(passedTicket.state).toBe("GO待ち");
    expect(passedDiscussion.houshin).toBe("h");
    expect(passedDiscussion.steps).toEqual(["①なおす"]);
  });
});
