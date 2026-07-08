import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  slackEnabled,
  slackAvailableForSystem,
  readSlackForSystem,
  resolveReporterDisplay,
} from "../slack";

const RECRUIT = "Indeed応募通知";

describe("slack reader（スコープ限定・読み取り専用・PIIマスク・既定OFF）", () => {
  let originalFetch: typeof global.fetch;
  const ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_CH_RECRUIT"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalFetch = global.fetch;
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("トークン未設定なら slackEnabled は false、読んでも空（fetchを呼ばない）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    expect(slackEnabled()).toBe(false);
    const r = await readSlackForSystem(RECRUIT);
    expect(r.channels).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("トークンはあるが許可チャンネル未設定なら、そのシステムは読めない（空・fetch無し）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    expect(slackEnabled()).toBe(true);
    expect(slackAvailableForSystem(RECRUIT)).toBe(false); // 許可チャンネル未設定
    const r = await readSlackForSystem(RECRUIT);
    expect(r.channels).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("トークン＋許可チャンネルありなら available=true、許可チャンネルだけを読む", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    expect(slackAvailableForSystem(RECRUIT)).toBe(true);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, messages: [{ text: "BotError: connection refused" }] }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await readSlackForSystem(RECRUIT);
    expect(r.channels.length).toBe(1);
    expect(r.channels[0].messages[0]).toContain("connection refused");
    // 許可リストの channelId(C123) を叩いていること
    const calledUrl = String(mockFetch.mock.calls[0][0]);
    expect(calledUrl).toContain("channel=C123");
    expect(calledUrl).toContain("conversations.history");
  });

  it("許可リストに無いシステムは読めない（空・fetch無し）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    expect(slackAvailableForSystem("プロレポ")).toBe(false);
    const r = await readSlackForSystem("プロレポ");
    expect(r.channels).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("診断行に含まれる氏名・電話はマスクして返す（公開窓口の最終防御）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        // エラー行（診断対象）だが氏名・電話を含む → 行は通すが氏名/電話はマスク
        messages: [{ text: "Error: 山田太郎さん(090-1234-5678)への通知送信に失敗" }],
      }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await readSlackForSystem(RECRUIT);
    const text = r.channels[0].messages[0];
    expect(text).toBeTruthy();
    expect(text).not.toContain("090-1234-5678");
    expect(text).not.toContain("山田太郎");
  });

  it("診断に無関係な応募者通知（PIIのみ）の行は構造的に落とす（匿名に見せない）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [
          { text: "新規応募：山田太郎さん 東京都… 応募職種：警備" }, // 非診断＝落とす
          { text: "BotError: connection refused" }, // 診断＝残す
        ],
      }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await readSlackForSystem(RECRUIT);
    expect(r.channels[0].messages.length).toBe(1);
    expect(r.channels[0].messages[0]).toContain("connection refused");
    expect(r.channels[0].messages.join("\n")).not.toContain("山田太郎");
  });

  it("limit はサーバ側で 15 件に丸める（暴走防止）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, messages: [] }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    await readSlackForSystem(RECRUIT, 999);
    expect(String(mockFetch.mock.calls[0][0])).toContain("limit=15");
  });

  it("Slack API が ok:false を返してもエラーを握って空配列＋errorを返す", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await readSlackForSystem(RECRUIT);
    expect(r.channels[0].messages).toEqual([]);
    expect(r.channels[0].error).toContain("channel_not_found");
  });
});

describe("resolveReporterDisplay（起票者の表示名解決・2026-07-08 社長要望対応）", () => {
  let originalFetch: typeof global.fetch;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalFetch = global.fetch;
    saved.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (saved.SLACK_BOT_TOKEN === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved.SLACK_BOT_TOKEN;
  });

  it("既に読める形式（メール・氏名）はそのまま返す（API不要）", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    expect(await resolveReporterDisplay("nishimura@kotsuyudo.com")).toBe(
      "nishimura@kotsuyudo.com"
    );
    expect(await resolveReporterDisplay("現場フォーム")).toBe("現場フォーム");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("空・未設定は「不明」を返す", async () => {
    expect(await resolveReporterDisplay("")).toBe("不明");
    expect(await resolveReporterDisplay(null)).toBe("不明");
    expect(await resolveReporterDisplay(undefined)).toBe("不明");
  });

  it("Slackメンション形式はトークン未設定なら元の文字列にフォールバック", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await resolveReporterDisplay("Slack:<@U0AR8F63YBA>");
    expect(r).toBe("Slack:<@U0AR8F63YBA>");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Slackメンション形式はusers.infoで表示名に解決する", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        user: { profile: { real_name: "西村克人" } },
      }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await resolveReporterDisplay("Slack:<@U0AR8F63YBA>");
    expect(r).toBe("西村克人");
    expect(String(mockFetch.mock.calls[0][0])).toContain("users.info");
    expect(String(mockFetch.mock.calls[0][0])).toContain("U0AR8F63YBA");
  });

  it("users.info が失敗してもフォールバックして通知を止めない", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, error: "user_not_found" }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await resolveReporterDisplay("Slack:<@U0AR8F63YBA>");
    expect(r).toBe("Slack:<@U0AR8F63YBA>");
  });

  it("users.info が例外を投げてもフォールバックして通知を止めない", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof global.fetch;
    const r = await resolveReporterDisplay("Slack:<@U0AR8F63YBA>");
    expect(r).toBe("Slack:<@U0AR8F63YBA>");
  });
});
