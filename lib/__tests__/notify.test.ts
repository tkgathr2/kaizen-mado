import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// lib/notify.ts の検証：
//  - 詰まり連絡は「同じチケットで1回だけ」送る（de-dup）。
//    判定は Notion ページ直下に heading_3「詰まり通知済み」があるか。
//  - LINE未設定なら送らない（fail-safe）。
//  - 送れたときだけ印（heading_3 + 理由）をページへ追記する。

// LINE 送信は名前付きモックで差し替え（呼ばれた/呼ばれてないを検証）。
const lineEnabled = vi.fn(() => true);
const pushText = vi.fn(async () => true);
vi.mock("@/lib/line", () => ({
  lineEnabled: () => lineEnabled(),
  pushText: (...a: unknown[]) => pushText(...(a as [])),
  truncateForLine: (s: string, max: number) => (s || "").slice(0, max),
  BOARD_URL: "https://kaizen.takagi.bz/board",
  msgHead: () => "HEAD",
  stageBar: () => "STAGE",
}));

// 印の追記（appendDiscussionBlocks）も差し替えて、呼ばれた回数・引数を検証。
const appendDiscussionBlocks = vi.fn(async () => undefined);
vi.mock("@/lib/tickets", () => ({
  appendDiscussionBlocks: (...a: unknown[]) => appendDiscussionBlocks(...(a as [])),
}));

import { notifyStuckOnce, hasStuckMarker, STUCK_MARKER_HEADING } from "../notify";
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
    pushText.mockResolvedValue(true);
    process.env.NOTION_TOKEN = "tok";
  });
  afterEach(() => {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = savedToken;
  });

  it("印が無ければ送信し、印（詰まり通知済み）を追記する", async () => {
    global.fetch = mockFetchReturningBlocks([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: "実装失敗（差し戻し）" }] } },
    ]);

    const sent = await notifyStuckOnce(ticket, "Notionトークンが必要です");

    expect(sent).toBe(true);
    expect(pushText).toHaveBeenCalledTimes(1);
    // 送れたら印を残す。
    expect(appendDiscussionBlocks).toHaveBeenCalledTimes(1);
    const args = appendDiscussionBlocks.mock.calls[0] as unknown as [string, { heading?: string }[]];
    expect(args[0]).toBe("page-x");
    expect(args[1][0].heading).toBe(STUCK_MARKER_HEADING);
  });

  it("既に印があれば送らない（連打防止）", async () => {
    global.fetch = mockFetchReturningBlocks([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: STUCK_MARKER_HEADING }] } },
    ]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(pushText).not.toHaveBeenCalled();
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("LINE未設定なら送らない（fail-safe）", async () => {
    lineEnabled.mockReturnValue(false);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(pushText).not.toHaveBeenCalled();
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("送信に失敗したら印を残さない（次回再試行できるように）", async () => {
    global.fetch = mockFetchReturningBlocks([]);
    pushText.mockResolvedValue(false);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(pushText).toHaveBeenCalledTimes(1);
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
