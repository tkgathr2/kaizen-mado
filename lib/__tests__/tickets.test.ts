import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTicketsByState,
  fetchAllTickets,
  fetchCompletedUnlearned,
  updateTicketState,
  setTicketUrlField,
  appendDiscussionBlocks,
  isStaleImplementing,
  staleImplementingMinutes,
  fetchStaleImplementing,
  submitDedupSeconds,
  anonSubmitDedupSeconds,
  matchDuplicate,
  findRecentDuplicate,
  type TicketRow,
} from "../tickets";
import type { Ticket } from "../types";

// 指定件数ぶんのダミー結果ページを生成（has_more / next_cursor 制御つき）。
function page(count: number, hasMore: boolean, cursor?: string) {
  const results = Array.from({ length: count }, (_, i) => ({
    id: `page-${cursor ?? "first"}-${i}`,
    properties: {
      ID: { type: "unique_id", unique_id: { prefix: "KZ", number: i + 1 } },
      対象システム: { type: "select", select: { name: "プロレポ" } },
      種別: { type: "select", select: { name: "改善" } },
      重要度: { type: "select", select: { name: "中" } },
      チケット名: { type: "title", title: [{ plain_text: `t${i}` }] },
      内容: { type: "rich_text", rich_text: [] },
      起票者: { type: "rich_text", rich_text: [] },
      状態: { type: "select", select: { name: "完了" } },
      FGSリンク: { type: "url", url: null },
    },
  }));
  return {
    ok: true,
    json: async () => ({ results, has_more: hasMore, next_cursor: hasMore ? (cursor ?? "cur-1") : null }),
  };
}

// query 応答のダミー（properties一式入り1件）
function queryResponse() {
  return {
    ok: true,
    json: async () => ({
      results: [
        {
          id: "page-abc-123",
          properties: {
            ID: { type: "unique_id", unique_id: { prefix: "KZ", number: 12 } },
            対象システム: { type: "select", select: { name: "プロレポ" } },
            種別: { type: "select", select: { name: "改善" } },
            重要度: { type: "select", select: { name: "高" } },
            チケット名: {
              type: "title",
              title: [{ plain_text: "一覧が" }, { plain_text: "表示されない" }],
            },
            内容: {
              type: "rich_text",
              rich_text: [{ plain_text: "一覧ページが空になる" }],
            },
            起票者: {
              type: "rich_text",
              rich_text: [{ plain_text: "現場フォーム" }],
            },
            状態: { type: "select", select: { name: "受付" } },
            FGSリンク: { type: "url", url: null },
          },
        },
      ],
    }),
  };
}

describe("tickets", () => {
  let originalToken: string | undefined;
  let originalDbId: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalToken = process.env.NOTION_TOKEN;
    originalDbId = process.env.NOTION_DATABASE_ID;
    originalFetch = global.fetch;
    process.env.NOTION_TOKEN = "test-token";
    process.env.NOTION_DATABASE_ID = "test-db";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    if (originalDbId === undefined) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = originalDbId;
    global.fetch = originalFetch;
  });

  it("fetchTicketsByState がプロパティを TicketRow に正しくマップする", async () => {
    global.fetch = vi.fn().mockResolvedValue(queryResponse());

    const rows = await fetchTicketsByState("受付", 5);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.pageId).toBe("page-abc-123");
    expect(r.ticketId).toBe("KZ-12");
    expect(r.system).toBe("プロレポ");
    expect(r.type).toBe("改善");
    expect(r.importance).toBe("高");
    expect(r.title).toBe("一覧が表示されない");
    expect(r.detail).toBe("一覧ページが空になる");
    expect(r.reporter).toBe("現場フォーム");
    expect(r.state).toBe("受付");
    expect(r.fgsUrl).toBeNull();
  });

  it("fetchTicketsByState は query エンドポイントへ正しい filter/page_size で POST する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(queryResponse());
    });

    await fetchTicketsByState("受付", 3);
    expect(capturedUrl).toBe(
      "https://api.notion.com/v1/databases/test-db/query"
    );
    expect(capturedInit.method).toBe("POST");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.filter).toEqual({ property: "状態", select: { equals: "受付" } });
    expect(body.page_size).toBe(3);
  });

  it("updateTicketState は page を PATCH し状態 select を更新する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await updateTicketState("page-xyz", "GO待ち");
    expect(capturedUrl).toBe("https://api.notion.com/v1/pages/page-xyz");
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.状態).toEqual({ select: { name: "GO待ち" } });
  });

  it("setTicketUrlField は FGSリンク url を PATCH する", async () => {
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await setTicketUrlField("page-xyz", "knowhow://memorized");
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.properties.FGSリンク).toEqual({ url: "knowhow://memorized" });
  });

  it("appendDiscussionBlocks は blocks/children へ heading_3 と paragraph を PATCH する", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await appendDiscussionBlocks("page-xyz", [
      { heading: "方針", body: "対応します" },
    ]);
    expect(capturedUrl).toBe(
      "https://api.notion.com/v1/blocks/page-xyz/children"
    );
    expect(capturedInit.method).toBe("PATCH");
    const body = JSON.parse(capturedInit.body as string);
    expect(body.children).toHaveLength(2);
    expect(body.children[0].type).toBe("heading_3");
    expect(body.children[1].type).toBe("paragraph");
    expect(body.children[0].heading_3.rich_text[0].text.content).toBe("方針");
    expect(body.children[1].paragraph.rich_text[0].text.content).toBe("対応します");
  });

  it("token 未設定のとき throw する", async () => {
    delete process.env.NOTION_TOKEN;
    global.fetch = vi.fn();
    await expect(fetchTicketsByState("受付")).rejects.toThrow();
  });

  it("query 応答が ok=false のとき throw する", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => "err" });
    await expect(fetchTicketsByState("受付")).rejects.toThrow(/Notion query error/);
  });

  // ── ページネーション（has_more / next_cursor）対応 ──
  it("fetchAllTickets は has_more の間 start_cursor を付けて全件取得する", async () => {
    const captured: any[] = [];
    let call = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured.push(JSON.parse(init.body as string));
      call++;
      // 1ページ目: 100件 has_more=true、2ページ目: 30件 has_more=false。
      return Promise.resolve(call === 1 ? page(100, true, "cur-1") : page(30, false));
    });

    const rows = await fetchAllTickets(500);
    expect(rows).toHaveLength(130); // 100 + 30 を取りこぼさず合算
    expect(captured).toHaveLength(2);
    expect(captured[0].start_cursor).toBeUndefined(); // 1回目はカーソルなし
    expect(captured[1].start_cursor).toBe("cur-1"); // 2回目は前回のnext_cursor
    expect(captured[0].sorts).toBeTruthy(); // ボードはsorts付き
  });

  it("fetchAllTickets は limit に達したら has_more でも止める", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(page(100, true, "cur-1"));
    });
    const rows = await fetchAllTickets(100);
    expect(rows).toHaveLength(100);
    expect(call).toBe(1); // limitちょうどで2ページ目を引かない
  });

  it("fetchCompletedUnlearned もページネーションで全件取得する", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(call === 1 ? page(100, true, "cur-1") : page(5, false));
    });
    const rows = await fetchCompletedUnlearned(1000);
    expect(rows).toHaveLength(105);
    expect(call).toBe(2);
  });

  // ── stuck回収（reaper）：実装中の滞留判定・取得 ──
  it("fetchStaleImplementing は『実装中』を取得し lastEdited が閾値超のものだけ返す", async () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const mk = (id: string, editedIso: string) => ({
      id,
      last_edited_time: editedIso,
      properties: {
        ID: { type: "unique_id", unique_id: { prefix: "KZ", number: 1 } },
        対象システム: { type: "select", select: { name: "カイゼンくん本体" } },
        種別: { type: "select", select: { name: "改善" } },
        重要度: { type: "select", select: { name: "中" } },
        チケット名: { type: "title", title: [{ plain_text: id }] },
        内容: { type: "rich_text", rich_text: [] },
        起票者: { type: "rich_text", rich_text: [] },
        状態: { type: "select", select: { name: "実装中" } },
        FGSリンク: { type: "url", url: null },
      },
    });
    let capturedBody: any = null;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            mk("fresh", "2026-06-26T11:50:00.000Z"), // 10分前＝閾値未満（残す対象でない）
            mk("stuck", "2026-06-26T11:20:00.000Z"), // 40分前＝閾値超（回収対象）
          ],
        }),
      });
    });

    const rows = await fetchStaleImplementing(30, 10, now);
    // 「実装中」でフィルタしてクエリしている
    expect(capturedBody.filter).toEqual({ property: "状態", select: { equals: "実装中" } });
    // 40分前の1件だけが stuck として返る
    expect(rows.map((r) => r.title)).toEqual(["stuck"]);
  });

  it("staleImplementingMinutes は env 既定30・正の数のみ採用", () => {
    expect(staleImplementingMinutes({} as NodeJS.ProcessEnv)).toBe(30);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "45" } as any)).toBe(45);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "0" } as any)).toBe(30); // 0は不採用→既定
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "-5" } as any)).toBe(30);
    expect(staleImplementingMinutes({ KAIZEN_STUCK_MINUTES: "abc" } as any)).toBe(30);
  });
});

describe("isStaleImplementing（stuck判定の純粋ロジック）", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const base = { state: "実装中" as const };

  it("実装中＋閾値以上の経過は stuck（true）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:20:00.000Z" }, now, 30)).toBe(true); // 40分前
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:30:00.000Z" }, now, 30)).toBe(true); // ちょうど30分前（>=）
  });

  it("実装中でも閾値未満なら stuck でない（false）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: "2026-06-26T11:45:00.000Z" }, now, 30)).toBe(false); // 15分前
  });

  it("状態が実装中でなければ常に false（巻き戻さない）", () => {
    expect(isStaleImplementing({ state: "着手", lastEdited: "2026-06-26T10:00:00.000Z" }, now, 30)).toBe(false);
    expect(isStaleImplementing({ state: "完了", lastEdited: "2026-06-26T10:00:00.000Z" }, now, 30)).toBe(false);
  });

  it("lastEdited が無い/不正なら経過判定できず false（安全側）", () => {
    expect(isStaleImplementing({ ...base, lastEdited: undefined }, now, 30)).toBe(false);
    expect(isStaleImplementing({ ...base, lastEdited: "" }, now, 30)).toBe(false);
    expect(isStaleImplementing({ ...base, lastEdited: "not-a-date" }, now, 30)).toBe(false);
  });
});

// ── 起票前 冪等チェック（インスタンス跨ぎの真の二重起票防止） ──
describe("submitDedupSeconds / anonSubmitDedupSeconds（時間窓）", () => {
  it("既定15秒・正の数のみ採用・1〜600にクランプ", () => {
    expect(submitDedupSeconds({} as NodeJS.ProcessEnv)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "30" } as any)).toBe(30);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "0" } as any)).toBe(15); // 0は不採用→既定
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "-5" } as any)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "abc" } as any)).toBe(15);
    expect(submitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "9999" } as any)).toBe(600); // 上限クランプ
  });

  it("匿名の窓は記名の半分（最低1秒）", () => {
    expect(anonSubmitDedupSeconds({} as NodeJS.ProcessEnv)).toBe(7); // 15/2=7.5→7
    expect(anonSubmitDedupSeconds({ KAIZEN_SUBMIT_DEDUP_SECONDS: "1" } as any)).toBe(1); // 1/2→最低1
  });
});

describe("matchDuplicate（完全同一内容の厳密照合）", () => {
  const tk = (over: Partial<Ticket> = {}): Ticket => ({
    system: "ほうこちゃん",
    type: "改善",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    importance: "中",
    ...over,
  });
  const row = (over: Partial<TicketRow> = {}): TicketRow => ({
    pageId: "p-1",
    ticketId: "KZ-1",
    system: "ほうこちゃん",
    type: "改善",
    importance: "中",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    reporter: "高木",
    state: "受付",
    fgsUrl: null,
    ...over,
  });

  it("記名：完全同一内容＋同一起票者はヒット（正規化・全半角/大小/空白吸収）", () => {
    const rows = [row({ title: "  写真が横倒し " })];
    expect(matchDuplicate(rows, tk(), "高木", false)?.pageId).toBe("p-1");
  });

  it("記名：起票者が違えばヒットしない（別人の同一内容は通す）", () => {
    const rows = [row({ reporter: "脇本" })];
    expect(matchDuplicate(rows, tk(), "高木", false)).toBeNull();
  });

  it("内容（detail）が違えばヒットしない（正当な別の声は通す）", () => {
    const rows = [row({ detail: "別の不具合" })];
    expect(matchDuplicate(rows, tk(), "高木", false)).toBeNull();
  });

  it("重要度が違えばヒットしない", () => {
    const rows = [row({ importance: "高" })];
    expect(matchDuplicate(rows, tk(), "高木", false)).toBeNull();
  });

  it("匿名：起票者を見ず内容完全一致のみでヒット", () => {
    const rows = [row({ reporter: "現場フォーム" })];
    expect(matchDuplicate(rows, tk(), null, true)?.pageId).toBe("p-1");
  });
});

describe("findRecentDuplicate（Notion段の起票前 冪等チェック）", () => {
  let originalToken: string | undefined;
  let originalDbId: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalToken = process.env.NOTION_TOKEN;
    originalDbId = process.env.NOTION_DATABASE_ID;
    originalFetch = global.fetch;
    process.env.NOTION_TOKEN = "test-token";
    process.env.NOTION_DATABASE_ID = "test-db";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    if (originalDbId === undefined) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = originalDbId;
    global.fetch = originalFetch;
  });

  const tk: Ticket = {
    system: "ほうこちゃん",
    type: "改善",
    title: "写真が横倒し",
    detail: "PDFで回転する",
    importance: "中",
  };

  // Notion query 応答（1件・指定内容）を作る
  function notionRow(over: { title?: string; detail?: string; reporter?: string; system?: string } = {}) {
    return {
      id: "page-dup-1",
      created_time: "2026-06-26T12:00:00.000Z",
      properties: {
        ID: { type: "unique_id", unique_id: { prefix: "KZ", number: 7 } },
        対象システム: { type: "select", select: { name: over.system ?? "ほうこちゃん" } },
        種別: { type: "select", select: { name: "改善" } },
        重要度: { type: "select", select: { name: "中" } },
        チケット名: { type: "title", title: [{ plain_text: over.title ?? "写真が横倒し" }] },
        内容: { type: "rich_text", rich_text: [{ plain_text: over.detail ?? "PDFで回転する" }] },
        起票者: { type: "rich_text", rich_text: [{ plain_text: over.reporter ?? "高木" }] },
        状態: { type: "select", select: { name: "受付" } },
        FGSリンク: { type: "url", url: null },
      },
    };
  }

  it("メモリ段をすり抜けた同一内容を Notion 段で検出して既存を返す（記名）", async () => {
    let capturedBody: any = null;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({ ok: true, json: async () => ({ results: [notionRow()] }) });
    });
    const hit = await findRecentDuplicate(tk, "高木");
    expect(hit?.ticketId).toBe("KZ-7");
    // created_time 窓＋対象システム＋起票者で絞っている
    const and = capturedBody.filter.and;
    expect(and[0].timestamp).toBe("created_time");
    expect(and[0].created_time.on_or_after).toBeTruthy();
    expect(and[1]).toEqual({ property: "対象システム", select: { equals: "ほうこちゃん" } });
    expect(and[2]).toEqual({ property: "起票者", rich_text: { equals: "高木" } });
  });

  it("別内容は弾かない（null＝通常作成にフォールバック）", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [notionRow({ detail: "全く別の不具合" })] }),
    });
    expect(await findRecentDuplicate(tk, "高木")).toBeNull();
  });

  it("匿名は起票者フィルタを付けず内容完全一致のみで検出する", async () => {
    let capturedBody: any = null;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({ ok: true, json: async () => ({ results: [notionRow({ reporter: "現場フォーム" })] }) });
    });
    const hit = await findRecentDuplicate(tk, null);
    expect(hit?.ticketId).toBe("KZ-7");
    // 起票者フィルタは付かない（and は2要素＝窓＋システムのみ）
    expect(capturedBody.filter.and).toHaveLength(2);
  });

  it("Notion クエリ失敗時は握りつぶして null（起票を止めない＝声を取りこぼさない）", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    expect(await findRecentDuplicate(tk, "高木")).toBeNull();
  });

  it("認証未設定でも throw せず null（fail-safe）", async () => {
    delete process.env.NOTION_TOKEN;
    global.fetch = vi.fn();
    expect(await findRecentDuplicate(tk, "高木")).toBeNull();
  });
});
