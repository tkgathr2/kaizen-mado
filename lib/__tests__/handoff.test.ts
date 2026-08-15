import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── lib/handoff.ts：真田システム（mention-hisho）への受け渡しクライアント ──
// 実HTTPは飛ばさず fetch をモックする（vitest.config.ts の方針どおり決定的・オフライン）。

// findTarget は repo 解決に使う。テストごとに戻り値を差し替えられるよう名前付きモックにする。
const findTarget = vi.fn((..._a: unknown[]): unknown => ({
  system: "カイゼンくん本体",
  repo: "tkgathr2/kaizen-mado",
  healthUrl: null,
  forbiddenPaths: [],
  autoEligible: true,
}));
vi.mock("../targets", () => ({ findTarget: (...a: unknown[]) => findTarget(...a) }));

import { handoffToSanada, buildHandoffPayload, handoffEnabled, handoffFyiToSanada } from "../handoff";

function ticket(overrides: Record<string, unknown> = {}): any {
  return {
    pageId: "37b0d980-8b3b-8148-9721-e1fa84498c34",
    ticketId: "KZ-127",
    system: "ほうこちゃん",
    type: "bug",
    importance: "中",
    priority: "高",
    title: "チケット名",
    detail: "チケット内容",
    reporter: "起票者",
    state: "GO待ち",
    fgsUrl: null,
    ...overrides,
  };
}

const discussion = { houshin: "議論で出た方針", steps: ["改善手順1", "改善手順2"] };

function okResponse(body: unknown = { ok: true }) {
  return { ok: true, status: 200, json: async () => body } as any;
}

describe("buildHandoffPayload（受け渡しbodyの組み立て）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findTarget.mockReturnValue({ repo: "tkgathr2/security-report-system" });
  });

  it("合意済みの固定形式で組み立てる", () => {
    const p = buildHandoffPayload(ticket(), discussion);
    expect(p).toEqual({
      ticketId: "KZ-127",
      title: "チケット名",
      detail: "チケット内容",
      system: "ほうこちゃん",
      type: "bug",
      priority: "高",
      reporter: "起票者",
      ticketUrl: "https://www.notion.so/37b0d9808b3b81489721e1fa84498c34",
      repo: "tkgathr2/security-report-system",
      houshin: "議論で出た方針",
      steps: ["改善手順1", "改善手順2"],
    });
  });

  it("ticketUrl は pageId のハイフンを除いて組み立てる", () => {
    const p = buildHandoffPayload(ticket(), discussion);
    expect(p.ticketUrl).toBe("https://www.notion.so/37b0d9808b3b81489721e1fa84498c34");
  });

  it("repo が未確定（null）ならキー自体を省略する", () => {
    findTarget.mockReturnValue({ repo: null });
    const p = buildHandoffPayload(ticket(), discussion);
    expect("repo" in p).toBe(false);
  });

  it("対象システムが未定義（findTarget=null）でも落ちずに repo を省略する", () => {
    findTarget.mockReturnValue(null);
    const p = buildHandoffPayload(ticket(), discussion);
    expect("repo" in p).toBe(false);
    expect(p.ticketId).toBe("KZ-127");
  });

  it("priority が無い旧チケットは importance にフォールバックする", () => {
    const p = buildHandoffPayload(ticket({ priority: undefined, importance: "低" }), discussion);
    expect(p.priority).toBe("低");
  });

  it("議論結果が空でも houshin=\"\" / steps=[] で組み立てる（fail-safe）", () => {
    const p = buildHandoffPayload(ticket(), {} as any);
    expect(p.houshin).toBe("");
    expect(p.steps).toEqual([]);
  });
});

describe("handoffToSanada（送信）", () => {
  const savedBase = process.env.MENTION_HISHO_BASE_URL;
  const savedSecret = process.env.KAIZEN_HANDOFF_SECRET;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    findTarget.mockReturnValue({ repo: "tkgathr2/security-report-system" });
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    process.env.MENTION_HISHO_BASE_URL = "https://mention-hisho.example.com";
    process.env.KAIZEN_HANDOFF_SECRET = "s3cret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedBase === undefined) delete process.env.MENTION_HISHO_BASE_URL;
    else process.env.MENTION_HISHO_BASE_URL = savedBase;
    if (savedSecret === undefined) delete process.env.KAIZEN_HANDOFF_SECRET;
    else process.env.KAIZEN_HANDOFF_SECRET = savedSecret;
  });

  it("宛先URL・認証ヘッダ・bodyを正しく送る", async () => {
    const ok = await handoffToSanada(ticket(), discussion);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://mention-hisho.example.com/api/kaizen/handoff");
    expect(init.method).toBe("POST");
    expect(init.headers["x-kaizen-handoff-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toMatchObject({
      ticketId: "KZ-127",
      system: "ほうこちゃん",
      repo: "tkgathr2/security-report-system",
      houshin: "議論で出た方針",
      steps: ["改善手順1", "改善手順2"],
    });
  });

  it("ベースURLの末尾スラッシュを正規化する", async () => {
    process.env.MENTION_HISHO_BASE_URL = "https://mention-hisho.example.com/";
    await handoffToSanada(ticket(), discussion);
    const [url] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://mention-hisho.example.com/api/kaizen/handoff");
  });

  it("MENTION_HISHO_BASE_URL 未設定なら送らず false（静かにスキップ）", async () => {
    delete process.env.MENTION_HISHO_BASE_URL;
    const ok = await handoffToSanada(ticket(), discussion);
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("シークレット未設定なら認証ヘッダを付けない（送信自体は行う）", async () => {
    delete process.env.KAIZEN_HANDOFF_SECRET;
    await handoffToSanada(ticket(), discussion);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.headers["x-kaizen-handoff-secret"]).toBeUndefined();
  });

  it("HTTPエラーなら1回リトライして、それでも駄目なら false", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as any);
    const ok = await handoffToSanada(ticket(), discussion);
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("200でも {ok:true} でなければ失敗扱い", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: false, error: "bad secret" }));
    const ok = await handoffToSanada(ticket(), discussion);
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("1回目が例外でも2回目が成功すれば true（例外は投げない）", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(okResponse());
    const ok = await handoffToSanada(ticket(), discussion);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("常に例外を投げず boolean を返す（fail-safe）", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(handoffToSanada(ticket(), discussion)).resolves.toBe(false);
  });

  it("タイムアウト用の AbortSignal を渡している", async () => {
    await handoffToSanada(ticket(), discussion);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.signal).toBeDefined();
    expect(init.signal.aborted).toBe(false);
  });
});

describe("handoffFyiToSanada（完了報告・詰まり・Merge待ち等のFYI送信）", () => {
  const savedBase = process.env.MENTION_HISHO_BASE_URL;
  const savedSecret = process.env.KAIZEN_HANDOFF_SECRET;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    process.env.MENTION_HISHO_BASE_URL = "https://mention-hisho.example.com";
    process.env.KAIZEN_HANDOFF_SECRET = "s3cret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedBase === undefined) delete process.env.MENTION_HISHO_BASE_URL;
    else process.env.MENTION_HISHO_BASE_URL = savedBase;
    if (savedSecret === undefined) delete process.env.KAIZEN_HANDOFF_SECRET;
    else process.env.KAIZEN_HANDOFF_SECRET = savedSecret;
  });

  it("kind='fyi'でticketId・fyiTextを送る（houshin/steps等の提案専用フィールドは含めない）", async () => {
    const ok = await handoffFyiToSanada("KZ-127", "直して反映しました。");
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://mention-hisho.example.com/api/kaizen/handoff");
    expect(JSON.parse(init.body)).toEqual({
      kind: "fyi",
      ticketId: "KZ-127",
      fyiText: "直して反映しました。",
    });
  });

  it("MENTION_HISHO_BASE_URL未設定なら送らず false（呼び出し側が自前LINEへフォールバックできる）", async () => {
    delete process.env.MENTION_HISHO_BASE_URL;
    const ok = await handoffFyiToSanada("KZ-127", "text");
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送信失敗（例外）でも投げず false を返す", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(handoffFyiToSanada("KZ-127", "text")).resolves.toBe(false);
  });
});

describe("handoffEnabled", () => {
  const savedBase = process.env.MENTION_HISHO_BASE_URL;
  afterEach(() => {
    if (savedBase === undefined) delete process.env.MENTION_HISHO_BASE_URL;
    else process.env.MENTION_HISHO_BASE_URL = savedBase;
  });

  it("宛先未設定・空文字なら false", () => {
    delete process.env.MENTION_HISHO_BASE_URL;
    expect(handoffEnabled()).toBe(false);
    process.env.MENTION_HISHO_BASE_URL = "   ";
    expect(handoffEnabled()).toBe(false);
  });

  it("宛先設定済みなら true", () => {
    process.env.MENTION_HISHO_BASE_URL = "https://mention-hisho.example.com";
    expect(handoffEnabled()).toBe(true);
  });
});
