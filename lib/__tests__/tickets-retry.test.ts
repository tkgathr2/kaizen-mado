import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Postgres プールをモックする（Notion blocks API fetch のモックから移行・2026-08-16）。
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db/pool", () => ({
  getPool: () => ({ query: (...args: any[]) => queryMock(...args) }),
  ensureSchema: async () => undefined,
}));

import {
  maxAutoRetries,
  summarizeRetryBlocks,
  getReaperRetryInfo,
  REAPER_RESET_HEADING,
  RETRY_CAP_HEADING,
} from "../tickets";

// reaper の自動リトライ上限（無限リトライ根絶・KZ-17事案）のカウント基盤テスト。
// カウントの真実の源＝ticket_discussion_blocks に残る印（REAPER_RESET_HEADING）の数。

function env(value?: string): NodeJS.ProcessEnv {
  return (value === undefined ? {} : { KAIZEN_MAX_RETRIES: value }) as unknown as NodeJS.ProcessEnv;
}

/** 議論ログ1行（見出しのみ） */
function h(heading: string) {
  return { heading, body: null };
}
/** 議論ログ1行（本文のみ） */
function p(body: string) {
  return { heading: null, body };
}

function queueRows(...batches: any[][]) {
  queryMock.mockReset();
  for (const b of batches) queryMock.mockResolvedValueOnce({ rows: b });
  queryMock.mockResolvedValue({ rows: [] });
}

beforeEach(() => queueRows());

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
    for (let n = 0; n <= 3; n++) {
      const blocks = Array.from({ length: n }, () => h(REAPER_RESET_HEADING));
      expect(summarizeRetryBlocks(blocks).count).toBe(n);
    }
  });

  it("失敗理由（実装失敗/基盤エラー見出しに続く本文）を拾い、最後のものが勝つ", () => {
    const blocks = [
      h("実装失敗（差し戻し）"),
      p("[IMPL_FAILED] tests failed: 3 assertions"),
      h(REAPER_RESET_HEADING),
      p("「実装中」のまま30分以上応答が無かったため…"),
      h("基盤エラー（実装中のまま保持）"),
      p("仕組み側の不調で進めませんでした。\n詳細：401 Unauthorized"),
    ];
    const info = summarizeRetryBlocks(blocks);
    expect(info.count).toBe(1);
    // 「詳細：」以降だけを理由として抽出する（定型文を除いた実エラー文）。
    expect(info.lastFailure).toBe("401 Unauthorized");
  });

  it("見出しと本文が同じ1行に入っていても同じ判定になる（Postgres版の実データ形）", () => {
    const blocks = [
      { heading: "実装失敗（差し戻し）", body: "詳細：build failed" },
      { heading: REAPER_RESET_HEADING, body: "自動リセットしました" },
    ];
    const info = summarizeRetryBlocks(blocks);
    expect(info.count).toBe(1);
    expect(info.lastFailure).toBe("build failed");
  });

  it("関係ない見出しに続く本文は失敗理由にしない", () => {
    expect(summarizeRetryBlocks([h("自動着手"), p("実行ワークフローを起動")]).lastFailure).toBeNull();
  });

  it("上限到達（RETRY_CAP_HEADING）以降の印だけ数える＝再GO後は枠が復活", () => {
    const blocks = [
      h(REAPER_RESET_HEADING),
      h(REAPER_RESET_HEADING),
      h(REAPER_RESET_HEADING),
      h(RETRY_CAP_HEADING),
      p("自動改修を3回試して失敗したため停止しました。"),
      h(REAPER_RESET_HEADING),
    ];
    expect(summarizeRetryBlocks(blocks).count).toBe(1);
  });
});

describe("getReaperRetryInfo（fail-safe＝失敗時は count=0 で『戻す側』に倒す）", () => {
  it("正常系：議論ログを挿入順(id昇順)で読み count/lastFailure を返す", async () => {
    queueRows(
      [{ id: "5" }], // pageId → 内部ID 解決
      [
        h(REAPER_RESET_HEADING),
        h(REAPER_RESET_HEADING),
        h("実装失敗（差し戻し）"),
        p("[IMPL_FAILED] build failed"),
      ]
    );

    const info = await getReaperRetryInfo("00000000-0000-4000-8000-000000000005");
    expect(info.count).toBe(2);
    expect(info.lastFailure).toBe("[IMPL_FAILED] build failed");

    // 時系列＝挿入順なので必ず id ASC で読む（ここが崩れるとリトライ集計が壊れる）。
    const sql = String(queryMock.mock.calls[1][0]).replace(/\s+/g, " ").trim();
    expect(sql).toContain("FROM ticket_discussion_blocks WHERE ticket_id = $1::bigint");
    expect(sql).toContain("ORDER BY id ASC");
    expect(queryMock.mock.calls[1][1]).toEqual(["5"]);
  });

  it("該当チケットが無ければ count=0 / lastFailure=null", async () => {
    queueRows([]);
    expect(await getReaperRetryInfo("00000000-0000-4000-8000-0000000000ff")).toEqual({
      count: 0,
      lastFailure: null,
    });
  });

  it("DB例外でも count=0 / lastFailure=null（throwしない）", async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error("connection refused"));
    expect(await getReaperRetryInfo("00000000-0000-4000-8000-000000000005")).toEqual({
      count: 0,
      lastFailure: null,
    });
  });

  it("pageId が空なら count=0（fail-safe・DBに触れない）", async () => {
    expect(await getReaperRetryInfo("")).toEqual({ count: 0, lastFailure: null });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
