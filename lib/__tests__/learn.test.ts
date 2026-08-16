import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// チケット取得元が Notion API → Postgres へ移行したため（2026-08-16）、
// このテストも「Notionのquery応答モック」から「pgプールのモック」へ切り替えた。
// knowhow（/api/devin/memorize）側は従来どおり global.fetch のモックで検証する。
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db/pool", () => ({
  getPool: () => ({ query: (...args: any[]) => queryMock(...args) }),
  ensureSchema: async () => undefined,
}));

import {
  returnLearningFromCompleted,
  returnLearningFromFailed,
} from "../learn";

const T0 = new Date("2026-06-26T12:00:00.000Z");

function dbRow(over: Record<string, any> = {}) {
  return {
    id: "1",
    ticket_number: 5,
    system: "プロレポ",
    type: "bug",
    importance: "高",
    title: "エラー修正",
    detail: "500が出る",
    reporter: "現場フォーム",
    state: "完了",
    assignee: "",
    fgs_url: null,
    pr_url: null,
    urgency: null,
    importance_score: null,
    priority: null,
    priority_reason: null,
    status_changed_at: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    slack_user_id: null,
    notion_page_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** tickets テーブルの応答を仕込む。UPDATE は素通し（呼ばれたことだけ検証する）。 */
function installDb(opts: { completed?: any[]; byState?: Record<string, any[]> } = {}) {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s.startsWith("UPDATE tickets")) return { rows: [] };
    // fetchCompletedUnlearned（完了 かつ FGSリンク空）
    if (s.includes("fgs_url IS NULL OR fgs_url = ''")) {
      return { rows: opts.completed ?? [] };
    }
    // fetchTicketsByState
    if (s.includes("WHERE state = $1")) {
      return { rows: (opts.byState ?? {})[params[0]] ?? [] };
    }
    return { rows: [] };
  });
}

/** FGSリンクへの冪等マーク UPDATE 呼び出しを拾う。 */
function markCalls() {
  return queryMock.mock.calls.filter((c) =>
    String(c[0]).replace(/\s+/g, " ").includes("SET fgs_url = $2")
  );
}

describe("returnLearningFromCompleted", () => {
  let originalEnabled: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnabled = process.env.KNOWHOW_ENABLED;
    originalFetch = global.fetch;
    installDb();
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.KNOWHOW_ENABLED;
    else process.env.KNOWHOW_ENABLED = originalEnabled;
    global.fetch = originalFetch;
  });

  it("KNOWHOW_ENABLED 未設定なら {memorized:0, skipped:'disabled'}（DBにもfetchにも触れない）", async () => {
    delete process.env.KNOWHOW_ENABLED;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await returnLearningFromCompleted();
    expect(result).toEqual({ memorized: 0, skipped: "disabled" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("有効化＋完了チケット1件で memorized:1 を返し、冪等マークが書かれる", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    installDb({ completed: [dbRow({ id: "77" })] });

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromCompleted();
    expect(result.memorized).toBe(1);

    // memorize 送信があり PIIマスク対象のraw_logが入っている
    const memorizeCall = calls.find((c) => c.url.includes("/api/devin/memorize"));
    expect(memorizeCall).toBeDefined();
    const memBody = JSON.parse(memorizeCall!.init.body as string);
    // 全体学習の土台（memory層）経由＝種別タグ kind=fix_success で記録される
    expect(memBody.raw_log).toContain("【fix_success】");
    expect(memBody.tags).toContain("fix_success");
    expect(memBody.tags).toContain("全体学習");

    // FGSリンクへの冪等マーク UPDATE が、その行の内部IDに対して書かれる
    const marks = markCalls();
    expect(marks).toHaveLength(1);
    expect(marks[0][1]).toEqual(["77", "knowhow://memorized"]);
  });

  it("memorize が ok=false ならマークせず memorized:0", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    installDb({ completed: [dbRow()] });

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/devin/memorize")) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromCompleted();
    expect(result.memorized).toBe(0);
    expect(markCalls()).toHaveLength(0);
  });
});

describe("returnLearningFromFailed（しくじり先生：失敗からの学習）", () => {
  let originalEnabled: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnabled = process.env.KNOWHOW_ENABLED;
    originalFetch = global.fetch;
    installDb();
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.KNOWHOW_ENABLED;
    else process.env.KNOWHOW_ENABLED = originalEnabled;
    global.fetch = originalFetch;
  });

  const failedRow = (state: string, fgsUrl: string | null = null) =>
    dbRow({
      id: `9${state.length}`,
      ticket_number: 9,
      system: "ステレポ",
      type: "新機能",
      importance: "中",
      title: "一括出力",
      detail: "CSVで出したい",
      state,
      fgs_url: fgsUrl,
    });

  it("KNOWHOW_ENABLED 未設定なら {memorized:0, skipped:'disabled'}（DBにもfetchにも触れない）", async () => {
    delete process.env.KNOWHOW_ENABLED;
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const result = await returnLearningFromFailed();
    expect(result).toEqual({ memorized: 0, skipped: "disabled" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("差し戻し1件を失敗の学び(kind=fix_failed)として記録し、冪等マークする", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    installDb({ byState: { 差し戻し: [failedRow("差し戻し")] } });

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromFailed();
    expect(result.memorized).toBe(1);

    const memorizeCall = calls.find((c) => c.url.includes("/api/devin/memorize"));
    expect(memorizeCall).toBeDefined();
    const memBody = JSON.parse(memorizeCall!.init.body as string);
    expect(memBody.raw_log).toContain("【fix_failed】");
    expect(memBody.status).toBe("failed");
    expect(memBody.tags).toContain("差し戻し");

    // 冪等マーク（FGSリンク）が付く
    expect(markCalls()).toHaveLength(1);
  });

  it("却下は kind=correction（軌道修正）として記録される", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    installDb({ byState: { 却下: [failedRow("却下")] } });

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromFailed();
    expect(result.memorized).toBe(1);
    const memorizeCall = calls.find((c) => c.url.includes("/api/devin/memorize"));
    const memBody = JSON.parse(memorizeCall!.init.body as string);
    expect(memBody.raw_log).toContain("【correction】");
    expect(memBody.tags).toContain("却下");
  });

  it("既に学習済み（FGSリンクあり）は再記録しない（二重防止）", async () => {
    process.env.KNOWHOW_ENABLED = "true";
    installDb({
      byState: { 差し戻し: [failedRow("差し戻し", "knowhow://memorized")] },
    });

    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const result = await returnLearningFromFailed();
    expect(result.memorized).toBe(0);
    expect(calls.find((c) => c.url.includes("/api/devin/memorize"))).toBeUndefined();
    expect(markCalls()).toHaveLength(0);
  });
});
