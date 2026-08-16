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

import {
  handoffToSanada,
  buildHandoffPayload,
  handoffEnabled,
  handoffFyiToSanada,
  handoffStallToSanada,
  ticketUrlOf,
  type HandoffStallPayload,
} from "../handoff";

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
      ticketUrl: "https://kaizen.takagi.bz/board/ticket/37b0d980-8b3b-8148-9721-e1fa84498c34",
      repo: "tkgathr2/security-report-system",
      houshin: "議論で出た方針",
      steps: ["改善手順1", "改善手順2"],
    });
  });

  it("ticketUrl は /board/ticket/<pageId> 形式で組み立てる（DB移行・2026-08-16）", () => {
    const p = buildHandoffPayload(ticket(), discussion);
    expect(p.ticketUrl).toBe("https://kaizen.takagi.bz/board/ticket/37b0d980-8b3b-8148-9721-e1fa84498c34");
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

  it("opts.awaitsReply=true のときだけ body に awaitsReply:true を含める", async () => {
    const ok = await handoffFyiToSanada("KZ-127", "これを教えてください。", {
      awaitsReply: true,
    });
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toEqual({
      kind: "fyi",
      ticketId: "KZ-127",
      fyiText: "これを教えてください。",
      awaitsReply: true,
    });
  });

  it("opts省略・awaitsReply=false のときは body にキー自体を含めない（後方互換）", async () => {
    await handoffFyiToSanada("KZ-127", "直して反映しました。");
    const [, init1] = fetchMock.mock.calls[0] as [string, any];
    expect("awaitsReply" in JSON.parse(init1.body)).toBe(false);

    await handoffFyiToSanada("KZ-127", "直して反映しました。", { awaitsReply: false });
    const [, init2] = fetchMock.mock.calls[1] as [string, any];
    expect("awaitsReply" in JSON.parse(init2.body)).toBe(false);
  });

  it("送信側は1回目がAbortError（タイムアウト相当）で失敗、2回目が成功すると相手へ2回POSTする（無条件リトライの仕様確認）", async () => {
    // handoffToSanada と同じ ATTEMPTS=2 の無条件リトライ構造を handoffFyiToSanada も持つ。
    // 【2026-08-15 bug-check-lab西野→神谷が対応】このリトライ自体は変えていないが、相手側
    // （mention-hisho）の kind="fyi" 分岐に ticketId＋本文ハッシュの冪等化（kaizenFyiTs）を
    // 追加したため、この2回目のPOSTは相手側で deduped:true として弾かれ、実害（社長への
    // 重複配信）は防がれている（tkgathr2/mention-hisho#83）。送信側のリトライ挙動そのものの
    // テストとして残す。
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortError).mockResolvedValueOnce(okResponse());

    const ok = await handoffFyiToSanada("KZ-127", "詰まっています。Notionトークンが必要です。");

    expect(ok).toBe(true);
    // 【再現の核心】呼び出し元からは「成功した」としか見えないが、実際には相手のサーバへ
    // 同一ticketId・同一fyiTextのPOSTが2回届いている。1回目がタイムアウトしただけで
    // 実際には相手に届いていた（＝相手が既に処理済みだった）場合、これがそのまま重複通知になる。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init1] = fetchMock.mock.calls[0] as [string, any];
    const [, init2] = fetchMock.mock.calls[1] as [string, any];
    expect(JSON.parse(init1.body)).toEqual({
      kind: "fyi",
      ticketId: "KZ-127",
      fyiText: "詰まっています。Notionトークンが必要です。",
    });
    // 2回目も全く同じbody＝相手側で内容による重複排除の手がかりが無い限り、区別できない。
    expect(init2.body).toBe(init1.body);
  });
});

describe("handoffStallToSanada（kz-sweep 停滞リマインドの構造化送信）", () => {
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

  function stallPayload(overrides: Partial<HandoffStallPayload> = {}): HandoffStallPayload {
    return {
      kind: "stall",
      ticketId: "KZ-131",
      title: "チケットタイトル",
      system: "対象システム名",
      stallKind: "awaiting_go",
      stallPhase: "remind",
      elapsedHours: 50,
      ticketUrl: "https://www.notion.so/xxx",
      ...overrides,
    };
  }

  it("kind='stall'のペイロードをそのまま宛先URL・認証ヘッダ付きで送る", async () => {
    const payload = stallPayload({ autoCloseInHours: 118 });
    const ok = await handoffStallToSanada(payload);
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://mention-hisho.example.com/api/kaizen/handoff");
    expect(init.method).toBe("POST");
    expect(init.headers["x-kaizen-handoff-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("stallKind='review'でprUrlを含めて送れる", async () => {
    const payload = stallPayload({
      stallKind: "review",
      prUrl: "https://github.com/tkgathr2/kaizen-mado/pull/12",
    });
    await handoffStallToSanada(payload);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toMatchObject({
      stallKind: "review",
      prUrl: "https://github.com/tkgathr2/kaizen-mado/pull/12",
    });
  });

  it("MENTION_HISHO_BASE_URL未設定なら送らず false（呼び出し側がSlack警告へフォールバックできる）", async () => {
    delete process.env.MENTION_HISHO_BASE_URL;
    const ok = await handoffStallToSanada(stallPayload());
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("相手側が kind='stall' 未対応（400等）でも例外を投げず false（後方互換）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "unknown kind" }) } as any);
    const ok = await handoffStallToSanada(stallPayload());
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1回＋リトライ1回
  });

  it("送信失敗（例外）でも投げず false を返す", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(handoffStallToSanada(stallPayload())).resolves.toBe(false);
  });

  it("1回目が例外でも2回目が成功すれば true", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(okResponse());
    const ok = await handoffStallToSanada(stallPayload());
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ticketUrlOf（チケット詳細ページURLの組み立て・DB移行2026-08-16）", () => {
  it("/board/ticket/<pageId> 形式でURLを組み立てる", () => {
    expect(ticketUrlOf("37b0d980-8b3b-8148-9721-e1fa84498c34")).toBe(
      "https://kaizen.takagi.bz/board/ticket/37b0d980-8b3b-8148-9721-e1fa84498c34"
    );
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
