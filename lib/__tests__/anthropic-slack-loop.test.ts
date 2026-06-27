import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callClaudeWithSlack } from "../anthropic";

// Anthropic応答（tool_use ブロック）を組み立てるヘルパ。
function anthropicToolUse(name: string, input: unknown, id = "tu_1") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "tool_use", name, input, id }] }),
  };
}
function slackHistory(messages: Array<{ text: string }>) {
  return { ok: true, status: 200, json: async () => ({ ok: true, messages }) };
}

const SYS_PROMPT = "system";
const HISTORY = [{ role: "user" as const, content: "応募通知ボットがエラー。Slackを見て" }];

describe("callClaudeWithSlack（tool useループ）", () => {
  let originalFetch: typeof global.fetch;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "SLACK_BOT_TOKEN", "SLACK_CH_RECRUIT"] as const;

  beforeEach(() => {
    originalFetch = global.fetch;
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CH_RECRUIT = "C123";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("モデルが read_slack→record_turn と進むと、Slackを読んでから TurnResult を返す", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("api.anthropic.com")) {
        // 1回目: read_slack を呼ぶ / 2回目: record_turn を返す
        const anthropicCalls = calls.filter((c) => c.includes("api.anthropic.com")).length;
        if (anthropicCalls === 1) return anthropicToolUse("read_slack", { limit: 10 }) as any;
        return anthropicToolUse("record_turn", {
          reply: "Slackを確認したところ接続エラーが出ていました。改善チケットにします。",
          phase: "confirm",
          ticket: {
            system: "Indeed応募通知",
            type: "bug",
            title: "応募通知ボットの接続エラー",
            detail: "Slackで connection refused を確認",
            importance: "高",
          },
        }) as any;
      }
      // Slack 履歴
      return slackHistory([{ text: "BotError: connection refused" }]) as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const r = await callClaudeWithSlack(SYS_PROMPT, HISTORY, "Indeed応募通知");
    expect(r.phase).toBe("confirm");
    expect(r.ticket?.type).toBe("bug");
    // Slack（conversations.history）が実際に呼ばれていること
    expect(calls.some((c) => c.includes("conversations.history") && c.includes("C123"))).toBe(true);
    // Anthropic は2回（read_slack→record_turn）
    expect(calls.filter((c) => c.includes("api.anthropic.com")).length).toBe(2);
  });

  it("モデルが最初から record_turn を返せば Slack は読まない", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("api.anthropic.com")) {
        return anthropicToolUse("record_turn", {
          reply: "どのシステムの件か教えてください。",
          phase: "clarify",
        }) as any;
      }
      return slackHistory([]) as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const r = await callClaudeWithSlack(SYS_PROMPT, HISTORY, "Indeed応募通知");
    expect(r.phase).toBe("clarify");
    expect(calls.some((c) => c.includes("conversations.history"))).toBe(false);
  });

  it("ANTHROPIC_API_KEY 未設定なら throw（呼び出し側がフォールバックへ）", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaudeWithSlack(SYS_PROMPT, HISTORY, "Indeed応募通知")).rejects.toThrow();
  });

  it("最終反復は record_turn を強制する（read_slack→read_slack→強制ターンで完了）", async () => {
    let anthropicCalls = 0;
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        anthropicCalls++;
        bodies.push(JSON.parse(init.body));
        // iter0,1: read_slack を返す / iter2（強制ターン）: record_turn を返す
        if (anthropicCalls <= 2) return anthropicToolUse("read_slack", {}, `tu_${anthropicCalls}`) as any;
        return anthropicToolUse("record_turn", { reply: "確認しました。", phase: "clarify" }) as any;
      }
      return slackHistory([{ text: "Error: timeout" }]) as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const r = await callClaudeWithSlack(SYS_PROMPT, HISTORY, "Indeed応募通知");
    expect(r.phase).toBe("clarify");
    expect(anthropicCalls).toBe(3); // 2回read_slack + 1回強制ターン
    // 強制ターン（3回目）は tool_choice が record_turn 固定であること
    expect(bodies[2].tool_choice.type).toBe("tool");
    expect(bodies[2].tool_choice.name).toBe("record_turn");
  });

  it("最終反復でも record_turn を返さなければ throw（→呼び出し側フォールバック）", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      // 常に read_slack を返す＝record_turn を一度も返さない異常系
      if (u.includes("api.anthropic.com")) return anthropicToolUse("read_slack", {}) as any;
      return slackHistory([{ text: "Error: timeout" }]) as any;
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await expect(
      callClaudeWithSlack(SYS_PROMPT, HISTORY, "Indeed応募通知")
    ).rejects.toThrow();
  });
});
