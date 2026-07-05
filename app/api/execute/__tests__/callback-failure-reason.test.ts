import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// callback の failed 経路で「理由：不明」を根絶するテスト：
//  ① detail が空でも「何が失敗したか＋次のアクション（Actionsログ確認）」を必ず1行入れる。
//  ② detail があればそのまま流す（改変しない）。
//  ③ 対象リポ不明でも「不明」とは言わず GitHub Actions への導線を出す。

const updateTicketState = vi.fn(async (..._a: unknown[]) => {});
const appendDiscussionBlocks = vi.fn(async (..._a: unknown[]) => {});
const fetchTicketByPageId = vi.fn(async (_id: string): Promise<unknown> => null);
const setStatusChangedAt = vi.fn(async () => {});
const notifyStuckOnce = vi.fn(async (..._a: unknown[]) => true);
const notifyReviewOnce = vi.fn(async (..._a: unknown[]) => true);
const buildMergedText = vi.fn(() => "merged-text");
const pushText = vi.fn(async () => true);
const enqueueNotification = vi.fn(async (..._a: unknown[]) => {});
const findTarget = vi.fn((..._a: unknown[]) => null as unknown);

vi.mock("@/lib/tickets", () => ({
  updateTicketState: (...a: unknown[]) => updateTicketState(...a),
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...a),
  fetchTicketByPageId: (...a: unknown[]) => fetchTicketByPageId(...(a as [string])),
  setStatusChangedAt: (...a: unknown[]) => setStatusChangedAt(...(a as [])),
}));
vi.mock("@/lib/learn", () => ({
  returnLearningFromCompleted: async () => ({ memorized: 0 }),
}));
vi.mock("@/lib/notify", () => ({
  notifyStuckOnce: (...a: unknown[]) => notifyStuckOnce(...a),
  notifyReviewOnce: (...a: unknown[]) => notifyReviewOnce(...a),
  buildMergedText: (...a: unknown[]) => buildMergedText(...(a as [])),
}));
vi.mock("@/lib/line", () => ({
  // isInfraError は実装同等の空文字判定だけ再現（空detailは基盤エラーにならない）。
  isInfraError: (d: string | null | undefined) => Boolean((d || "").includes("401")),
  buildInfraNoticeText: () => "infra-text",
  pushText: (...a: unknown[]) => pushText(...(a as [])),
}));
vi.mock("@/lib/slack", () => ({ postToSlack: async () => true }));
vi.mock("@/lib/notification", () => ({
  enqueueNotification: (...a: unknown[]) => enqueueNotification(...a),
}));
vi.mock("@/lib/targets", () => ({ findTarget: (...a: unknown[]) => findTarget(...a) }));

import { POST } from "../callback/route";

function makeReq(body: Record<string, unknown>): any {
  return {
    headers: { get: () => null },
    json: async () => body,
  };
}

function implementingTicket() {
  return {
    pageId: "page-1",
    ticketId: "KZ-17",
    system: "カイゼンくん本体",
    type: "改善",
    importance: "中",
    title: "自動改修が失敗し続ける件",
    detail: "…",
    reporter: "現場",
    state: "実装中",
    fgsUrl: null,
  };
}

describe("/api/execute/callback failed経路の失敗理由（「不明」根絶）", () => {
  const savedSecret = process.env.CRON_SECRET;
  const savedInsecure = process.env.ALLOW_INSECURE_CRON;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchTicketByPageId.mockResolvedValue(implementingTicket());
    findTarget.mockReturnValue(null);
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedInsecure === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = savedInsecure;
  });

  it("detail空：Actionsログへの導線つきの理由を組み立て、Notion/LINE/ダイジェスト全部に流す", async () => {
    findTarget.mockReturnValue({
      system: "カイゼンくん本体",
      repo: "tkgathr2/kaizen-mado",
      healthUrl: null,
      forbiddenPaths: [],
      autoEligible: true,
    });

    const res = await POST(
      makeReq({
        pageId: "page-1",
        ticketId: "KZ-17",
        system: "カイゼンくん本体",
        result: "failed",
        detail: "",
      })
    );
    const json = await res.json();
    expect(json.state).toBe("差し戻し");

    // Notion議論ブロック：「(理由不明)」を出さない。
    const bodies = appendDiscussionBlocks.mock.calls
      .flatMap((c) => (c[1] as { body?: string }[]) ?? [])
      .map((b) => b.body ?? "")
      .join();
    expect(bodies).not.toContain("(理由不明)");
    expect(bodies).toContain("実装ジョブが失敗理由を返さず終了");
    expect(bodies).toContain("https://github.com/tkgathr2/kaizen-mado/actions");

    // LINE詰まり連絡：同じ理由を渡す（旧「不明（くわしくは /board を…）」は廃止）。
    const reason = String(notifyStuckOnce.mock.calls[0]?.[1] ?? "");
    expect(reason).toContain("Actionsログ確認");
    expect(reason).not.toContain("不明（くわしくは");

    // 日次ダイジェスト：要約に「不明」を含まない＝enqueue側で落とされずに載る。
    const digestDetail = String(enqueueNotification.mock.calls[0]?.[3] ?? "");
    expect(digestDetail).toContain("実装ジョブが失敗理由を返さず終了");
    expect(digestDetail).not.toContain("不明（");
  });

  it("detail空＋対象リポ未登録：それでもGitHub Actionsへの導線を出す", async () => {
    findTarget.mockReturnValue(null);

    await POST(
      makeReq({
        pageId: "page-1",
        ticketId: "KZ-17",
        system: "未知システム",
        result: "failed",
        detail: "",
      })
    );

    const reason = String(notifyStuckOnce.mock.calls[0]?.[1] ?? "");
    expect(reason).toContain("対象リポのGitHub Actions");
  });

  it("detailあり：実エラー文をそのまま流す（改変しない）", async () => {
    await POST(
      makeReq({
        pageId: "page-1",
        ticketId: "KZ-17",
        system: "カイゼンくん本体",
        result: "failed",
        detail: "変更が生成されませんでした",
        failureClass: "IMPL_FAILED",
      })
    );

    expect(notifyStuckOnce).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "KZ-17" }),
      "変更が生成されませんでした"
    );
    const bodies = appendDiscussionBlocks.mock.calls
      .flatMap((c) => (c[1] as { body?: string }[]) ?? [])
      .map((b) => b.body ?? "")
      .join();
    expect(bodies).toContain("[IMPL_FAILED] 変更が生成されませんでした");
  });

  it("基盤エラー（isInfraError=true）は従来どおり実装中のまま保持（差し戻さない）", async () => {
    const res = await POST(
      makeReq({
        pageId: "page-1",
        ticketId: "KZ-17",
        system: "カイゼンくん本体",
        result: "failed",
        detail: "401 Unauthorized",
      })
    );
    const json = await res.json();
    expect(json.infra).toBe(true);
    expect(updateTicketState).not.toHaveBeenCalled();
  });
});
