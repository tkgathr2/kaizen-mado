import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { slackEnabled, slackAvailableForSystem, readSlackForSystem } from "../slack";

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

  it("メッセージ本文はPIIマスクを通してから返す（電話番号がマスクされる）", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [{ text: "応募者の電話は090-1234-5678です" }],
      }),
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;
    const r = await readSlackForSystem(RECRUIT);
    const text = r.channels[0].messages[0];
    expect(text).not.toContain("090-1234-5678");
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
