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

  it("真田handoffが失敗したら、カイゼンくん自前LINEへは送らずSlack警告へ倒す（本文は届いていないので送信失敗扱い・印は記帳しない）", async () => {
    // 【バグ2修正・2026-08-15】Slack警告はあくまで「届いていないことを知らせる」副作用であり、
    // 本文（handoffFyiToSanada）が失敗した以上、sendFyi/notifyStuckOnce の戻り値は false でなければ
    // ならない（true を返すと、本文が届いていないのに「通知済み」マーカーが記帳され、二度と
    // 再送されなくなる＝バグ本体）。
    handoffFyiToSanada.mockResolvedValue(false);
    notifySlackAlert.mockResolvedValue(true);
    global.fetch = mockFetchReturningBlocks([]);

    const sent = await notifyStuckOnce(ticket, "理由");

    expect(sent).toBe(false);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
    // Slack警告は副作用として呼ばれるが、その成功は戻り値に影響しない。
    expect(notifySlackAlert).toHaveBeenCalledTimes(1);
    const [detail] = notifySlackAlert.mock.calls[0] as [string];
    expect(detail).toContain("KZ-9");
    // 本文が届いていないので、印（詰まり通知済み）は記帳しない＝次回再試行できる。
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();
  });

  it("【バグ3修正確認・High・bug-check-lab堀内逆検証／西野実走】handoffFyiToSanada失敗時はnotifySlackAlertが成功してもsendFyi/notifyStuckOnceはfalseを返し、印を記帳しない→handoffが直った次回は正しく送信・記帳できる", async () => {
    // 【修正前の欠陥（記録として残す）】lib/notify.ts の sendFyi は、handoffFyiToSanada
    // （＝実際に社長のLINEへ本文が届く経路）が失敗したときのフォールバックとして notifySlackAlert
    // （真田Bot名義の"社内向け"Slack警告＝「届いていません」という管理者通知）を呼んでいたが、
    // その戻り値（Slack警告の送信成功/失敗）をそのまま sendFyi 自体の成功/失敗として返して
    // しまっていた。notifyStuckOnce はこの戻り値だけを見て「送れた」と判断し、hasStuckMarker の
    // 印（STUCK_MARKER_HEADING）をNotionページへ記帳してしまい、社長のLINEには本文が一切
    // 届いていないのに、以後 notifyStuckOnce は「既に通知済み」として二度と再送を試みなくなる
    // バグがあった。
    //
    // 【修正後】sendFyi の戻り値は handoffFyiToSanada の成否だけに従う（Slack警告は副作用）。
    // よって本文が届いていない1回目は false を返し印を記帳しない＝次回に再試行できる。
    handoffFyiToSanada.mockResolvedValue(false);
    notifySlackAlert.mockResolvedValue(true);
    global.fetch = mockFetchReturningBlocks([]); // 1回目：まだ印は無い

    const sent = await notifyStuckOnce(ticket, "Notionトークンが必要です");

    // 本文は社長に届いていない（handoffFyiToSanadaは失敗）ので false を返す。
    expect(sent).toBe(false);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
    // Slack警告は「届いていない」ことを知らせる副作用として呼ばれる（戻り値には影響しない）。
    expect(notifySlackAlert).toHaveBeenCalledTimes(1);
    // 印は記帳しない＝次回スキャンで再試行できる。
    expect(appendDiscussionBlocks).not.toHaveBeenCalled();

    // 2回目：印は記帳されていないため、Notion側にも印は無い状態のまま
    //（1回目で修正前バグのように誤って印が付いていないことを確認する）。
    vi.clearAllMocks();
    handoffEnabled.mockReturnValue(true);
    handoffFyiToSanada.mockResolvedValue(true); // 今度はhandoffが直った
    global.fetch = mockFetchReturningBlocks([]); // 印はまだ無い（1回目で記帳されていないため）

    const sentAgain = await notifyStuckOnce(ticket, "Notionトークンが必要です");

    // handoffが直っていれば、印が無いので正しく再試行され、今度こそ本文が届いて印が記帳される。
    expect(sentAgain).toBe(true);
    expect(handoffFyiToSanada).toHaveBeenCalledTimes(1);
    expect(appendDiscussionBlocks).toHaveBeenCalledTimes(1);
    const args = appendDiscussionBlocks.mock.calls[0] as unknown as [string, { heading?: string }[]];
    expect(args[1][0].heading).toBe(STUCK_MARKER_HEADING);
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
