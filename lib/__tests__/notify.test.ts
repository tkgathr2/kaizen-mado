import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// lib/notify.ts の検証：
//  - 詰まり連絡は「同じチケットで1回だけ」送る（de-dup）。
//    判定は Notion ページ直下に heading_3「詰まり通知済み」があるか。
//  - 真田システム（mention-hisho）への handoff が本線。lineEnabled/handoffEnabled どちらかが
//    有効なら試みる（自前LINEは全廃したため lineEnabled 単独では何も送らない）。
//  - handoffが失敗したら、カイゼンくん自前LINEへは一切フォールバックせず、真田Bot名義の
//    Slack警告（notifySlackAlert）へ倒す（社長指示 2026-08-15）。
//  - 送れたときだけ印（heading_3 + 理由）をページへ追記する。

// LINE/Slack警告は名前付きモックで差し替え（呼ばれた/呼ばれてないを検証）。
const lineEnabled = vi.fn(() => true);
const notifySlackAlert = vi.fn(async (_detail: string) => true);
vi.mock("@/lib/line", () => ({
  lineEnabled: () => lineEnabled(),
  notifySlackAlert: (...a: unknown[]) => notifySlackAlert(...(a as [string])),
  truncateForLine: (s: string, max: number) => (s || "").slice(0, max),
  BOARD_URL: "https://kaizen.takagi.bz/board",
  msgHead: () => "HEAD",
  stageBar: () => "STAGE",
  actionBanner: (kind: string, action?: string) => `BANNER(${kind}:${action ?? ""})`,
}));

// 印の追記（appendDiscussionBlocks）も差し替えて、呼ばれた回数・引数を検証。
const appendDiscussionBlocks = vi.fn(async () => undefined);
vi.mock("@/lib/tickets", () => ({
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...(a as [])),
}));

// 真田システムへの受け渡し（handoffFyiToSanada）も差し替える。
const handoffEnabled = vi.fn(() => false);
const handoffFyiToSanada = vi.fn(async () => false);
vi.mock("@/lib/handoff", () => ({
  handoffEnabled: () => handoffEnabled(),
  handoffFyiToSanada: (...a: unknown[]) => handoffFyiToSanada(...(a as [])),
}));

import { notifyStuckOnce, hasStuckMarker, STUCK_MARKER_HEADING, buildStuckText } from "../notify";
import type { TicketRow } from "../tickets";

const ticket: TicketRow = {
  pageId: "page-x",
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

// fetch をモックして Notion blocks 取得を制御する。
function mockFetchReturningBlocks(blocks: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: blocks }),
  })) as unknown as typeof fetch;
}

describe("lib/notify 詰まり連絡の de-dup", () => {
  const savedFetch = global.fetch;
  const savedToken = process.env.NOTION_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    lineEnabled.mockReturnValue(true);
    notifySlackAlert.mockResolvedValue(true);
    handoffEnabled.mockReturnValue(true);
    handoffFyiToSanada.mockResolvedValue(true);
    process.env.NOTION_TOKEN = "tok";
  });
  afterEach(() => {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = savedToken;
  });

  it("印が無ければ真田handoffで送信し、印（詰まり通知済み）を追記する", async () => {
    global.fetch = mockFetchReturningBlocks([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: "実装失敗（差し戻し）" }] } },
    ]);

    const sent = await notifyStuckOnce(ticket, "Notionトークンが必要です");

    expect(sent).toBe(true);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
    // awaitsReply:true を渡す（相手側が引用返信の照合に使うフラグ）。
    expect(handoffFyiToSanada).toHaveBeenCalledWith(
      "KZ-9",
      expect.stringContaining("引用返信"),
      { awaitsReply: true }
    );
    expect(notifySlackAlert).not.toHaveBeenCalled();
    // 送れたら印を残す。
    expect(appendDiscussionBlocks).toHaveBeenCalledTimes(1);
    const args = appendDiscussionBlocks.mock.calls[0] as unknown as [string, { heading?: string }[]];
    expect(args[0]).toBe("page-x");
    expect(args[1][0].heading).toBe(STUCK_MARKER_HEADING);
  });

  it("既に印があれば送らない（連打防止・handoff/Slackどちらも呼ばれない）", async () => {
    global.fetch = mockFetchReturningBlocks([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: STUCK_MARKER_HEADING }] } },
    ]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(handoffFyiToSanada).not.toHaveBeenCalled();
    expect(notifySlackAlert).not.toHaveBeenCalled();
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("LINE未設定でも真田handoffが有効なら試みる（自前LINEへは依存しない）", async () => {
    lineEnabled.mockReturnValue(false);
    handoffEnabled.mockReturnValue(true);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(true);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
  });

  it("LINE・真田handoffの両方が無効なら送らない（fail-safe）", async () => {
    lineEnabled.mockReturnValue(false);
    handoffEnabled.mockReturnValue(false);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(handoffFyiToSanada).not.toHaveBeenCalled();
    expect(notifySlackAlert).not.toHaveBeenCalled();
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("真田handoffが失敗したら、カイゼンくん自前LINEへは送らずSlack警告へ倒す", async () => {
    handoffFyiToSanada.mockResolvedValue(false);
    notifySlackAlert.mockResolvedValue(true);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(true);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
    expect(notifySlackAlert).toHaveBeenCalledTimes(1);
    const [detail] = notifySlackAlert.mock.calls[0] as [string];
    expect(detail).toContain("KZ-9");
    expect(appendDiscussionBlocks).toHaveBeenCalledTimes(1);
  });

  it("真田handoff・Slack警告の両方が失敗したら印を残さない（次回再試行できるように）", async () => {
    handoffFyiToSanada.mockResolvedValue(false);
    notifySlackAlert.mockResolvedValue(false);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("hasStuckMarker：取得失敗(!ok)時は連打回避で true（送らない側）に倒す", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    expect(await hasStuckMarker("page-x")).toBe(true);
  });

  it("hasStuckMarker：NOTION_TOKEN未設定なら false（印無し扱い）", async () => {
    delete process.env.NOTION_TOKEN;
    expect(await hasStuckMarker("page-x")).toBe(false);
  });
});

describe("buildStuckText", () => {
  it("引用返信を案内する文言を含む（自由文の返信ではなく引用返信を明示的に求める）", () => {
    const text = buildStuckText(ticket, "理由");
    expect(text).toContain("引用返信（長押し→返信）");
    expect(text).not.toContain("LINEで返信すれば続けます");
  });
});
