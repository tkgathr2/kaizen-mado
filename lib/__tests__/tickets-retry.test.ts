import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  maxAutoRetries,
  summarizeRetryBlocks,
  getReaperRetryInfo,
  REAPER_RESET_HEADING,
  RETRY_CAP_HEADING,
} from "../tickets";

// reaper の自動リトライ上限（無限リトライ根絶・KZ-17事案）のカウント基盤テスト。
// カウントの真実の源＝Notion議論ブロックの印（REAPER_RESET_HEADING）の数。

function env(value?: string): NodeJS.ProcessEnv {
  return (value === undefined ? {} : { KAIZEN_MAX_RETRIES: value }) as unknown as NodeJS.ProcessEnv;
}

function h3(text: string) {
  return { type: "heading_3", heading_3: { rich_text: [{ plain_text: text }] } };
}
function para(text: string) {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

describe("maxAutoRetries（env KAIZEN_MAX_RETRIES・既定3）", () => {
  const saved = process.env.KAIZEN_MAX_RETRIES;
  afterEach(() => {
    if (saved === undefined) delete process.env.KAIZEN_MAX_RETRIES;
    else process.env.KAIZEN_MAX_RETRIES = saved;
  });

  it("未設定なら既定3", () => {
    delete process.env.KAIZEN_MAX_RETRIES;
    expect(maxAutoRetries()).toBe(3);
  });

  it("envで上書きできる（KAIZEN_MAX_RETRIES=5）", () => {
    expect(maxAutoRetries(env("5"))).toBe(5);
  });

  it("0＝自動リトライ禁止として尊重する", () => {
    expect(maxAutoRetries(env("0"))).toBe(0);
  });

  it("不正値・負値は既定3（安全側）・過大値は20にクランプ", () => {
    expect(maxAutoRetries(env("abc"))).toBe(3);
    expect(maxAutoRetries(env("-1"))).toBe(3);
    expect(maxAutoRetries(env("100"))).toBe(20);
    expect(maxAutoRetries(env("2.9"))).toBe(2);
  });
});

describe("summarizeRetryBlocks（印の数＝リトライ回数・直近失敗理由）", () => {
  it("ブロックが無ければ count=0 / lastFailure=null", () => {
    expect(summarizeRetryBlocks([])).toEqual({ count: 0, lastFailure: null });
  });

  it("stuck回収の印を数える（0→1→2→3）", () => {
    const marker = h3(REAPER_RESET_HEADING);
    for (let n = 0; n <= 3; n++) {
      const blocks = Array.from({ length: n }, () => marker);
      expect(summarizeRetryBlocks(blocks).count).toBe(n);
    }
  });

  it("失敗理由（実装失敗/基盤エラー見出し直後のparagraph）を拾い、最後のものが勝つ", () => {
    const blocks = [
      h3("実装失敗（差し戻し）"),
      para("[IMPL_FAILED] tests failed: 3 assertions"),
      h3(REAPER_RESET_HEADING),
      para("「実装中」のまま30分以上応答が無かったため…"),
      h3("基盤エラー（実装中のまま保持）"),
      para("仕組み側の不調で進めませんでした。\n詳細：401 Unauthorized"),
    ];
    const info = summarizeRetryBlocks(blocks);
    expect(info.count).toBe(1);
    // 「詳細：」以降だけを理由として抽出する（定型文を除いた実エラー文）。
    expect(info.lastFailure).toBe("401 Unauthorized");
  });

  it("関係ない見出し直後のparagraphは失敗理由にしない", () => {
    const blocks = [h3("自動着手"), para("実行ワークフローを起動")];
    expect(summarizeRetryBlocks(blocks).lastFailure).toBeNull();
  });

  it("上限到達（RETRY_CAP_HEADING）以降の印だけ数える＝再GO後は枠が復活", () => {
    const blocks = [
      h3(REAPER_RESET_HEADING),
      h3(REAPER_RESET_HEADING),
      h3(REAPER_RESET_HEADING),
      h3(RETRY_CAP_HEADING),
      para("自動改修を3回試して失敗したため停止しました。"),
      h3(REAPER_RESET_HEADING),
    ];
    expect(summarizeRetryBlocks(blocks).count).toBe(1);
  });
});

describe("getReaperRetryInfo（fail-safe＝失敗時は count=0 で『戻す側』に倒す）", () => {
  const savedToken = process.env.NOTION_TOKEN;
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "test-token";
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = savedToken;
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  it("正常系：ブロックを読み count/lastFailure を返す（ページネーション込み）", async () => {
    const page1 = {
      results: [h3(REAPER_RESET_HEADING), h3(REAPER_RESET_HEADING)],
      has_more: true,
      next_cursor: "c2",
    };
    const page2 = {
      results: [h3("実装失敗（差し戻し）"), para("[IMPL_FAILED] build failed")],
      has_more: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const info = await getReaperRetryInfo("page-1");
    expect(info.count).toBe(2);
    expect(info.lastFailure).toBe("[IMPL_FAILED] build failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 2ページ目は start_cursor 付きで呼ぶ。
    expect(String(fetchMock.mock.calls[1][0])).toContain("start_cursor=c2");
  });

  it("HTTPエラー（res.ok=false）なら count=0 / lastFailure=null", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await getReaperRetryInfo("page-1")).toEqual({ count: 0, lastFailure: null });
  });

  it("fetch例外でも count=0 / lastFailure=null（throwしない）", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    expect(await getReaperRetryInfo("page-1")).toEqual({ count: 0, lastFailure: null });
  });

  it("NOTION_TOKEN未設定・pageId空でも count=0（fail-safe）", async () => {
    delete process.env.NOTION_TOKEN;
    expect(await getReaperRetryInfo("page-1")).toEqual({ count: 0, lastFailure: null });
    process.env.NOTION_TOKEN = "test-token";
    expect(await getReaperRetryInfo("")).toEqual({ count: 0, lastFailure: null });
  });
});
