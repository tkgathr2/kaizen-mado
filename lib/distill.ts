// ── Phase 2：完了チケットの蒸留（仕様v2.0 §2） ──
// 完了チケットを LLM で「事象→原因→対処→学び」に構造化し、
// knowhow の"正味の資産"として再利用できる形にする。
// 方針：
//  - プロバイダ優先順：ANTHROPIC_API_KEY → OPENAI_API_KEY(gpt-4o-mini) → GOOGLE_GENERATIVE_AI_API_KEY(gemini-2.0-flash) → null
//  - 失敗したら null を返す（呼び出し側＝learn.ts が従来の固定文面にフォールバック）。
//  - PIIは二重防御：プロンプトで出力禁止を明示＋出力全体に maskPII を再適用。
import { maskPII } from "./pii";
import type { TicketRow } from "./tickets";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_DISTILL_MODEL = "claude-haiku-4-5";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const GEMINI_API_URL_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

export function isDistillEnabled(): boolean {
  return process.env.KAIZEN_DISTILL_ENABLED === "true";
}

/**
 * 使用可能なプロバイダを判定して返す。
 * 優先：anthropic → openai → google → null（キー無し）
 */
export type LLMProvider = "anthropic" | "openai" | "google" | null;

export function resolveDistillProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  return null;
}

// モデルに必ず呼ばせる構造化ツール（Anthropic tool use）
const DISTILL_TOOL = {
  name: "record_learning",
  description: "完了したカイゼンチケットから、横展開できる学びを構造化して記録する。",
  input_schema: {
    type: "object",
    properties: {
      phenomenon: { type: "string", description: "事象：現場で何が起きていたか（1〜2文）" },
      cause: { type: "string", description: "原因：なぜ起きていたか。不明なら『記録なし』（1〜2文）" },
      action: { type: "string", description: "対処：どう直したか。不明なら『記録なし』（1〜2文）" },
      learning: { type: "string", description: "学び：他システム・他現場へ横展開できる普遍的な教訓（1〜2文）" },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "検索用キーワード（3〜5個・日本語）",
      },
    },
    required: ["phenomenon", "cause", "action", "learning"],
  },
} as const;

const SYSTEM_PROMPT = [
  "あなたは高木産業グループの改善ナレッジ編集者。完了したカイゼンチケットを、後から検索・再利用できる「学び」に蒸留する。",
  "制約：",
  "- 個人名・連絡先・取引先名・金額は出力に含めない（役職や「現場スタッフ」などの一般語に置き換える）。",
  "- 推測で事実を作らない。チケットに無い情報は「記録なし」とする。",
  "- 必ず record_learning ツールを1回呼ぶ。",
].join("\n");

// OpenAI/Gemini 向けの JSON 出力指示（tool use が使えないプロバイダ用）
const JSON_SYSTEM_PROMPT = [
  "あなたは高木産業グループの改善ナレッジ編集者。完了したカイゼンチケットを、後から検索・再利用できる「学び」に蒸留する。",
  "制約：",
  "- 個人名・連絡先・取引先名・金額は出力に含めない（役職や「現場スタッフ」などの一般語に置き換える）。",
  "- 推測で事実を作らない。チケットに無い情報は「記録なし」とする。",
  "- 必ず以下のJSONスキーマで回答する。他のテキストは一切出力しない。",
  '{"phenomenon":"事象（1〜2文）","cause":"原因（1〜2文）","action":"対処（1〜2文）","learning":"学び（1〜2文）","keywords":["キーワード1","キーワード2","キーワード3"]}',
].join("\n");

interface Distilled {
  phenomenon: string;
  cause: string;
  action: string;
  learning: string;
  keywords?: string[];
}

function buildRawLog(ticket: TicketRow, d: Distilled): { rawLog: string; keywords: string[] } {
  const rawLog = maskPII(
    [
      `【カイゼンの学び】${ticket.ticketId}`,
      `対象: ${ticket.system || "未指定"} / 種別: ${ticket.type} / 重要度: ${ticket.importance}`,
      `事象: ${d.phenomenon}`,
      `原因: ${d.cause || "記録なし"}`,
      `対処: ${d.action || "記録なし"}`,
      `学び: ${d.learning}`,
    ].join("\n")
  );
  const keywords = Array.isArray(d.keywords)
    ? d.keywords.filter((k) => typeof k === "string").slice(0, 5).map((k) => maskPII(k))
    : [];
  return { rawLog, keywords };
}

function isValidDistilled(d: unknown): d is Distilled {
  return (
    typeof (d as any)?.phenomenon === "string" &&
    (d as any).phenomenon.length > 0 &&
    typeof (d as any)?.learning === "string" &&
    (d as any).learning.length > 0
  );
}

// ── Anthropic ──
async function distillWithAnthropic(
  ticket: TicketRow,
  userText: string
): Promise<{ rawLog: string; keywords: string[] } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.KAIZEN_DISTILL_MODEL || DEFAULT_DISTILL_MODEL;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
      tools: [DISTILL_TOOL],
      tool_choice: { type: "tool", name: "record_learning" },
    }),
  });

  if (!res.ok) {
    console.error(`[distill] anthropic error ${res.status}`);
    return null;
  }
  const data = await res.json();
  const toolUse = (data?.content ?? []).find((c: any) => c?.type === "tool_use");
  const d = toolUse?.input as Distilled | undefined;
  if (!isValidDistilled(d)) return null;
  return buildRawLog(ticket, d);
}

// ── OpenAI ──
async function distillWithOpenAI(
  ticket: TicketRow,
  userText: string
): Promise<{ rawLog: string; keywords: string[] } | null> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const model = process.env.KAIZEN_DISTILL_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!res.ok) {
    console.error(`[distill] openai error ${res.status}`);
    return null;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;

  let d: unknown;
  try {
    d = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isValidDistilled(d)) return null;
  return buildRawLog(ticket, d as Distilled);
}

// ── Google Gemini ──
async function distillWithGemini(
  ticket: TicketRow,
  userText: string
): Promise<{ rawLog: string; keywords: string[] } | null> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY!;
  const model = process.env.KAIZEN_DISTILL_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `${GEMINI_API_URL_BASE}/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${JSON_SYSTEM_PROMPT}\n\n---\n${userText}` }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 700,
      },
    }),
  });

  if (!res.ok) {
    console.error(`[distill] gemini error ${res.status}`);
    return null;
  }
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== "string") return null;

  let d: unknown;
  try {
    d = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isValidDistilled(d)) return null;
  return buildRawLog(ticket, d as Distilled);
}

/**
 * チケットを蒸留して knowhow 用の raw_log テキストを返す。
 * プロバイダ優先順：ANTHROPIC_API_KEY → OPENAI_API_KEY(gpt-4o-mini) → GOOGLE_GENERATIVE_AI_API_KEY(gemini-2.0-flash)
 * どのキーも無い・失敗の場合は null（呼び出し側がフォールバック）。
 */
export async function distillTicket(ticket: TicketRow): Promise<{
  rawLog: string;
  keywords: string[];
} | null> {
  const provider = resolveDistillProvider();
  if (!provider) return null;

  const userText = [
    `対象システム: ${ticket.system || "未指定"}`,
    `種別: ${ticket.type} / 重要度: ${ticket.importance}`,
    `件名: ${maskPII(ticket.title)}`,
    `内容: ${maskPII(ticket.detail)}`,
  ].join("\n");

  try {
    if (provider === "anthropic") return await distillWithAnthropic(ticket, userText);
    if (provider === "openai") return await distillWithOpenAI(ticket, userText);
    if (provider === "google") return await distillWithGemini(ticket, userText);
    return null;
  } catch (err) {
    console.error("[distill] error:", (err as Error).message);
    return null;
  }
}
