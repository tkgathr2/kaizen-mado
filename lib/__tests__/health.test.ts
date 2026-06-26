import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as tickets from "../tickets";
import {
  checkAnthropicModel,
  checkNotionRead,
  checkKnowhow,
  checkStalledTickets,
  isStalled,
  summarize,
  runHealthChecks,
  healthModel,
  HEALTH_MODEL_DEFAULT,
  type CheckResult,
} from "../health";

// クリーンな env を作る（実環境の鍵に依存しないため、必要なものだけ明示する）。
function envWith(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // 実環境の鍵に依存しない最小 env を作る。NODE_ENV は ProcessEnv 型の必須プロパティ。
  const e = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v;
  return e;
}

const NOTION_ENV = { NOTION_TOKEN: "tok", NOTION_DATABASE_ID: "db" };

function rows(...defs: Array<{ state: string; lastEdited?: string }>): tickets.TicketRow[] {
  return defs.map((d, i) => ({
    pageId: `p${i}`,
    ticketId: `KZ-${i}`,
    system: "プロレポ",
    type: "改善",
    importance: "中",
    title: "t",
    detail: "d",
    reporter: "r",
    state: d.state,
    fgsUrl: null,
    lastEdited: d.lastEdited,
  }));
}

describe("healthModel", () => {
  it("ANTHROPIC_MODEL があれば優先", () => {
    expect(healthModel(envWith({ ANTHROPIC_MODEL: "x" }))).toBe("x");
  });
  it("未設定なら既定モデル", () => {
    expect(healthModel(envWith())).toBe(HEALTH_MODEL_DEFAULT);
  });
});

describe("checkAnthropicModel", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("鍵未設定なら skipped（fetchを呼ばない）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await checkAnthropicModel(envWith());
    expect(r.status).toBe("skipped");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("200 なら ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof global.fetch;
    const r = await checkAnthropicModel(envWith({ ANTHROPIC_API_KEY: "k" }));
    expect(r.status).toBe("ok");
  });

  it("404（model not found）なら error で理由を返す", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"error":{"message":"model not found"}}'),
    }) as unknown as typeof global.fetch;
    const r = await checkAnthropicModel(envWith({ ANTHROPIC_API_KEY: "k" }));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("404");
    expect(r.detail).toContain("model not found");
  });

  it("fetch が throw しても error として握る（例外を投げない）", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as unknown as typeof global.fetch;
    const r = await checkAnthropicModel(envWith({ ANTHROPIC_API_KEY: "k" }));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("network");
  });

  it("ワークフローと同じモデル(claude-sonnet-4-6)を既定で叩く", async () => {
    let body = "";
    global.fetch = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
      body = init.body as string;
      return Promise.resolve({ ok: true });
    }) as unknown as typeof global.fetch;
    await checkAnthropicModel(envWith({ ANTHROPIC_API_KEY: "k" }));
    expect(JSON.parse(body).model).toBe("claude-sonnet-4-6");
    expect(JSON.parse(body).max_tokens).toBe(1);
  });
});

describe("checkNotionRead", () => {
  let original: string | undefined;
  let originalDb: string | undefined;
  beforeEach(() => {
    original = process.env.NOTION_TOKEN;
    originalDb = process.env.NOTION_DATABASE_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = original;
    if (originalDb === undefined) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = originalDb;
  });

  it("Notion鍵未設定なら skipped", async () => {
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_DATABASE_ID;
    const spy = vi.spyOn(tickets, "fetchTicketsByState");
    const r = await checkNotionRead();
    expect(r.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("読取成功なら ok", async () => {
    process.env.NOTION_TOKEN = "tok";
    process.env.NOTION_DATABASE_ID = "db";
    vi.spyOn(tickets, "fetchTicketsByState").mockResolvedValue(rows({ state: "受付" }));
    const r = await checkNotionRead();
    expect(r.status).toBe("ok");
  });

  it("読取が throw しても error として握る", async () => {
    process.env.NOTION_TOKEN = "tok";
    process.env.NOTION_DATABASE_ID = "db";
    vi.spyOn(tickets, "fetchTicketsByState").mockRejectedValue(new Error("notion down"));
    const r = await checkNotionRead();
    expect(r.status).toBe("error");
    expect(r.detail).toContain("notion down");
  });
});

describe("checkKnowhow", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("KNOWHOW_ENABLED 無効なら skipped（fetchを呼ばない）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith());
    expect(r.status).toBe("skipped");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("有効だが KB_API_KEY 未設定なら error（fetchを呼ばない＝書き込みが401で死ぬ）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true" }));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("KB_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("有効・鍵付き recall が 200 なら ok（学習が実際に使う経路を叩く）", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true", KB_API_KEY: "k" }));
    expect(r.status).toBe("ok");
    // /api/devin/recall を鍵付き POST で叩いていること（旧 /api/health 依存でない）。
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/devin/recall");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("k");
  });

  it("有効・recall が 401 なら error（鍵が無効）", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true", KB_API_KEY: "bad" }));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("認証失敗");
  });

  it("有効・recall が 403 なら error（鍵が無効）", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true", KB_API_KEY: "bad" }));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("認証失敗");
  });

  it("有効・recall が 500 なら error", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true", KB_API_KEY: "k" }));
    expect(r.status).toBe("error");
  });

  it("有効・throw しても error として握る", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("kh down")) as unknown as typeof global.fetch;
    const r = await checkKnowhow(envWith({ KNOWHOW_ENABLED: "true", KB_API_KEY: "k" }));
    expect(r.status).toBe("error");
  });
});

describe("isStalled", () => {
  const now = Date.parse("2026-06-26T12:00:00Z");
  const old = "2026-06-26T11:00:00Z"; // 60分前
  const recent = "2026-06-26T11:55:00Z"; // 5分前

  it("実装中で閾値超なら滞留", () => {
    expect(isStalled({ state: "実装中", lastEdited: old }, now, 30)).toBe(true);
  });
  it("実装中でも閾値内なら滞留でない", () => {
    expect(isStalled({ state: "実装中", lastEdited: recent }, now, 30)).toBe(false);
  });
  it("着手で閾値超なら滞留", () => {
    expect(isStalled({ state: "着手", lastEdited: old }, now, 30)).toBe(true);
  });
  it("着手で lastEdited 無しは滞留でない（安全側）", () => {
    expect(isStalled({ state: "着手", lastEdited: undefined }, now, 30)).toBe(false);
  });
  it("無関係な状態は滞留でない", () => {
    expect(isStalled({ state: "GO待ち", lastEdited: old }, now, 30)).toBe(false);
  });
});

describe("checkStalledTickets", () => {
  const now = Date.parse("2026-06-26T12:00:00Z");
  const old = "2026-06-26T11:00:00Z";
  afterEach(() => vi.restoreAllMocks());

  it("Notion鍵未設定なら skipped", async () => {
    const spy = vi.spyOn(tickets, "fetchTicketsByState");
    const r = await checkStalledTickets(1, now, envWith());
    expect(r.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("滞留が閾値以上なら warn（件数つき）", async () => {
    vi.spyOn(tickets, "fetchTicketsByState").mockImplementation(async (state: string) => {
      if (state === "実装中") return rows({ state: "実装中", lastEdited: old });
      if (state === "着手") return rows({ state: "着手", lastEdited: old });
      return [];
    });
    const r = await checkStalledTickets(1, now, envWith(NOTION_ENV));
    expect(r.status).toBe("warn");
    expect(r.count).toBe(2);
  });

  it("滞留なしなら ok", async () => {
    vi.spyOn(tickets, "fetchTicketsByState").mockResolvedValue([]);
    const r = await checkStalledTickets(1, now, envWith(NOTION_ENV));
    expect(r.status).toBe("ok");
    expect(r.count).toBe(0);
  });

  it("クエリが throw しても error として握る", async () => {
    vi.spyOn(tickets, "fetchTicketsByState").mockRejectedValue(new Error("query fail"));
    const r = await checkStalledTickets(1, now, envWith(NOTION_ENV));
    expect(r.status).toBe("error");
  });
});

describe("summarize", () => {
  const at = Date.parse("2026-06-26T00:00:00Z");
  function c(name: string, status: CheckResult["status"]): CheckResult {
    return { name, status, detail: "" };
  }

  it("全部 ok/skipped なら ok=true・problems空", () => {
    const r = summarize([c("a", "ok"), c("b", "skipped")], at);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("error があれば unhealthy・problemsに名前", () => {
    const r = summarize([c("a", "ok"), c("model", "error")], at);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("model");
  });

  it("warn があれば unhealthy", () => {
    const r = summarize([c("stall", "warn")], at);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("stall");
  });

  it("checkedAt は ISO 文字列", () => {
    const r = summarize([c("a", "ok")], at);
    expect(r.checkedAt).toBe(new Date(at).toISOString());
  });
});

describe("runHealthChecks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("全チェックが回り HealthReport を返す（鍵なし環境＝全 skipped で ok）", async () => {
    // fetch を使うチェックは鍵未設定で skipped に倒れる。Notion系も spy で空に。
    vi.spyOn(tickets, "fetchTicketsByState").mockResolvedValue([]);
    const r = await runHealthChecks(envWith());
    expect(r.checks).toHaveLength(4);
    expect(r.ok).toBe(true);
    // チェック名が揃っている
    const names = r.checks.map((x) => x.name).sort();
    expect(names).toEqual(
      ["anthropic-model", "knowhow", "notion-read", "stalled-tickets"].sort()
    );
  });
});
