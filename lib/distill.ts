// ── Phase 2：完了チケットの蒸留（仕様v2.0 §2） ──
// 完了チケットを Claude(haiku) で「事象→原因→対処→学び」に構造化し、
// knowhow の"正味の資産"として再利用できる形にする。
// 方針：
//  - 失敗したら null を返す（呼び出し側＝learn.ts が従来の固定文面にフォールバック）。
//  - PIIは二重防御：プロンプトで出力禁止を明示＋出力全体に maskPII を再適用。
//  - モデルは既定 haiku（蒸留は軽作業・コスト最小。真田裁定 2026-06-11）。
import { maskPII } from "./pii";
import type { TicketRow } from "./tickets";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_DISTILL_MODEL = "claude-haiku-4-5";

export function isDistillEnabled(): boolean {
  return process.env.KAIZEN_DISTILL_ENABLED === "true";
}

// モデルに必ず呼ばせる構造化ツール。input がそのまま蒸留結果になる。
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

interface Distilled {
  phenomenon: string;
  cause: string;
  action: string;
  learning: string;
  keywords?: string[];
}

/**
 * チケットを蒸留して knowhow 用の raw_log テキストを返す。
 * 失敗（キー未設定・通信・想定外応答）は null（呼び出し側がフォールバック）。
 */
export async function distillTicket(ticket: TicketRow): Promise<{
  rawLog: string;
  keywords: string[];
} | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.KAIZEN_DISTILL_MODEL || DEFAULT_DISTILL_MODEL;
  const userText = [
    `対象システム: ${ticket.system || "未指定"}`,
    `種別: ${ticket.type} / 重要度: ${ticket.importance}`,
    `件名: ${maskPII(ticket.title)}`,
    `内容: ${maskPII(ticket.detail)}`,
  ].join("\n");

  try {
    const res = await fetch(API_URL, {
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
    if (!d?.phenomenon || !d?.learning) return null;

    // 出力にも maskPII を再適用（二重防御）
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
  } catch (err) {
    console.error("[distill] error:", (err as Error).message);
    return null;
  }
}
