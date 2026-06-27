import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callClaude, callClaudeWithSlack } from "../anthropic";

// Anthropic応答（record_turn ブロック）を組み立てるヘルパ。
function recordTurn(reply = "確認しました。") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "tool_use", name: "record_turn", input: { reply, phase: "clarify" }, id: "tu_1" }],
    }),
  };
}
function readSlack(id = "tu_s") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "tool_use", name: "read_slack", input: {}, id }] }),
  };
}
function slackHistory() {
  return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }) };
}

const SYS = "system";
const HISTORY = [{ role: "user" as const, content: "テスト" }];

describe("Anthropic fetch のタイムアウト/中断（H5・DoS対策）", () => {
  let originalFetch: typeof global.fetch;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "SLACK_BOT_TOKEN", "SLACK_CH_RECRUIT"] as const;

  beforeEach(() => {
    originalFetch = global.fetch;
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("callClaude は fetch に AbortSignal を渡す（タイムアウト配線）", async () => {
    let seenSignal: unknown = "NONE";
    const fetchMock = vi.fn(async (_url: string, init?: any) => {
      seenSignal = init?.signal;
      return recordTurn() as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const r = await callClaude(SYS, HISTORY);
    expect(r.phase).toBe("clarify");
    // signal が undefined ではなく AbortSignal であること。
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("callClaude に abort 済み signal を渡すと fetch が中断され throw する", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: any) => {
      const sig: AbortSignal | undefined = init?.signal;
      // 実 fetch は abort 済み signal で即 reject する。それを模倣。
      if (sig?.aborted) {
        const e = new Error("aborted");
        (e as any).name = "AbortError";
        throw e;
      }
      return recordTurn() as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const ac = new AbortController();
    ac.abort();
    await expect(callClaude(SYS, HISTORY, ac.signal)).rejects.toThrow();
  });

  it("callClaudeWithSlack も fetch に AbortSignal を渡す", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    let seenSignal: unknown = "NONE";
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (String(url).includes("api.anthropic.com")) {
        seenSignal = init?.signal;
        return recordTurn() as any;
      }
      return slackHistory() as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await callClaudeWithSlack(SYS, HISTORY, "Indeed応募通知", new AbortController().signal);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("callClaudeWithSlack はループ途中で abort されると次反復に入らず throw する", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
    const ac = new AbortController();
    let anthropicCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("api.anthropic.com")) {
        anthropicCalls++;
        // 1反復目は read_slack を返す → tool_result 後の2反復目に入る前に abort 済み。
        if (anthropicCalls === 1) {
          ac.abort(); // クライアント切断を模倣（1反復目の後に効く）。
          return readSlack() as any;
        }
        return recordTurn() as any;
      }
      return slackHistory() as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(
      callClaudeWithSlack(SYS, HISTORY, "Indeed応募通知", ac.signal)
    ).rejects.toThrow();
    // 2反復目の fetch には入らない（abort で打ち切り）。
    expect(anthropicCalls).toBe(1);
  });
});
