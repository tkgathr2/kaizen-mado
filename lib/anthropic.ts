// ── Anthropic API 呼び出し（サーバ側のみ。キーはクライアントへ出さない） ──
// LLMのフリーテキストJSONをパースすると壊れやすいため、tool use（構造化出力）を
// 強制して、モデルには検証済みのオブジェクトを直接返させる。文字列パースに依存しない。
import type { TurnResult, Ticket, Phase, TicketType, Importance } from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

// モデルに必ず呼ばせるツール。input がそのまま TurnResult になる。
const TURN_TOOL = {
  name: "record_turn",
  description:
    "今回のターンの応答を記録する。reply は利用者に見せる文章。phase が confirm のときは ticket を必ず埋める。",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "利用者に見せる返答（地の文で2〜4文）" },
      phase: {
        type: "string",
        enum: ["clarify", "confirm"],
        description: "深掘り中なら clarify、要約確認に進むなら confirm",
      },
      ticket: {
        type: ["object", "null"],
        description: "confirm のときのみ必須。clarify のときは null。",
        properties: {
          system: { type: "string" },
          type: { type: "string", enum: ["bug", "改善", "新機能"] },
          title: { type: "string", description: "短い件名（30字程度）" },
          detail: { type: "string", description: "背景・困りごと・要望を3〜6文で" },
          importance: { type: "string", enum: ["高", "中", "低"] },
        },
        required: ["system", "type", "title", "detail", "importance"],
      },
    },
    required: ["reply", "phase"],
  },
} as const;

/**
 * Claudeに1ターン投げて TurnResult を得る。
 * キー未設定や通信失敗・想定外応答時は例外を投げる（呼び出し側がフォールバックに切替）。
 */
export async function callClaude(
  system: string,
  messages: AnthropicMessage[]
): Promise<TurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      tools: [TURN_TOOL],
      tool_choice: { type: "tool", name: TURN_TOOL.name },
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const toolUse = Array.isArray(data?.content)
    ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === TURN_TOOL.name)
    : null;

  if (!toolUse?.input) {
    throw new Error("model did not return a tool_use block");
  }
  return coerceTurn(toolUse.input);
}

/** ツール入力（または任意のオブジェクト）を安全に TurnResult へ整える */
export function coerceTurn(obj: any): TurnResult {
  const phase: Phase = obj?.phase === "confirm" ? "confirm" : "clarify";
  const reply = typeof obj?.reply === "string" ? obj.reply.trim() : "";
  if (!reply) throw new Error("reply missing in model output");

  let ticket: Ticket | null = null;
  if (phase === "confirm") {
    const t = obj?.ticket ?? {};
    ticket = {
      system: String(t.system ?? ""),
      type: coerceType(t.type),
      title: String(t.title ?? "").slice(0, 100) || "改善のご要望",
      detail: String(t.detail ?? "").slice(0, 1800),
      importance: coerceImportance(t.importance),
    };
  }
  return { reply, phase, ticket };
}

function coerceType(v: unknown): TicketType {
  return v === "bug" || v === "新機能" ? v : "改善";
}
function coerceImportance(v: unknown): Importance {
  return v === "高" || v === "低" ? v : "中";
}
