// ── CTO Agent Lab 議論の自動化（LLM構造化出力 / tool use 強制） ──
// 改善チケットを「議論」して方針・工数・リスク・GO可否の推奨・GO伺いドラフトを出す。
// このルートは誰にも送信しない。GO伺いドラフトは"送信用の下書き"であり実送信しない。
// キー未設定・通信失敗時は fallback（throwしない）。
import type { TicketRow } from "./tickets";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export type Recommendation = "GO推奨" | "要検討" | "非推奨";

export interface DiscussResult {
  houshin: string;
  kousuu: string;
  risks: string[];
  recommendation: Recommendation;
  goDraft: string;
  source: "claude" | "fallback";
}

const SYSTEM_PROMPT =
  "あなたは高木産業グループ CTO Agent Lab。改善チケットについて方針・工数見積・リスク・GO可否の推奨・社長へのGO伺いドラフトを簡潔に出す。GO伺いドラフトは\"送信用の下書き\"であり実送信はしない。";

const DISCUSS_TOOL = {
  name: "record_discussion",
  description:
    "改善チケットの議論結果を記録する。方針・工数見積・リスク・推奨・GO伺いドラフトを構造化して返す。",
  input_schema: {
    type: "object",
    properties: {
      houshin: { type: "string", description: "対応方針（2〜4文）" },
      kousuu: { type: "string", description: "工数見積（例: 半日 / 2〜3日 など）" },
      risks: {
        type: "array",
        items: { type: "string" },
        description: "想定リスク（箇条書き）",
      },
      recommendation: {
        type: "string",
        enum: ["GO推奨", "要検討", "非推奨"],
        description: "GO可否の推奨",
      },
      go_ukagai_draft: {
        type: "string",
        description: "社長へのGO伺いドラフト（送信用下書き・実送信はしない）",
      },
    },
    required: ["houshin", "kousuu", "risks", "recommendation", "go_ukagai_draft"],
  },
} as const;

function coerceRecommendation(v: unknown): Recommendation {
  return v === "GO推奨" || v === "非推奨" ? v : "要検討";
}

/** ツール入力（または任意のオブジェクト）を安全に整形する */
export function coerceDiscussion(obj: any): Omit<DiscussResult, "source"> {
  const houshin = typeof obj?.houshin === "string" ? obj.houshin.trim() : "";
  const kousuu = typeof obj?.kousuu === "string" ? obj.kousuu.trim() : "";
  const risks = Array.isArray(obj?.risks)
    ? obj.risks.filter((r: unknown) => typeof r === "string" && r.trim()).map((r: string) => r.trim())
    : [];
  const recommendation = coerceRecommendation(obj?.recommendation);
  const goDraft =
    typeof obj?.go_ukagai_draft === "string"
      ? obj.go_ukagai_draft.trim()
      : typeof obj?.goDraft === "string"
        ? obj.goDraft.trim()
        : "";
  return { houshin, kousuu, risks, recommendation, goDraft };
}

/** APIキー未設定・失敗時に使う定型の議論結果を生成する */
function fallbackDiscussion(ticket: TicketRow): DiscussResult {
  const type = ticket.type || "改善";
  const importance = ticket.importance || "中";

  let recommendation: Recommendation = "要検討";
  if (importance === "高") recommendation = "GO推奨";
  else if (importance === "低") recommendation = "要検討";

  const kousuu =
    type === "新機能" ? "2〜5日（要見積）" : type === "bug" ? "半日〜1日" : "1〜2日";

  const risks: string[] = [];
  if (type === "bug") risks.push("再発防止のための回帰テストが必要");
  if (type === "新機能") risks.push("既存機能への影響範囲の確認が必要");
  risks.push("詳細要件のヒアリングが追加で必要な可能性");

  const houshin = `「${ticket.title || "改善のご要望"}」（${ticket.system || "対象未特定"} / ${type} / 重要度${importance}）について対応方針を検討する。まず内容を精査し、影響範囲と優先度を確認のうえ着手判断を行う。`;

  const goDraft = `【GO伺い（下書き・未送信）】\n対象: ${ticket.system || "未特定"}\n件名: ${ticket.title || "改善のご要望"}\n種別/重要度: ${type} / ${importance}\n推奨: ${recommendation}\n工数見積: ${kousuu}\n上記内容で着手してよろしいでしょうか。`;

  return { houshin, kousuu, risks, recommendation, goDraft, source: "fallback" };
}

/**
 * チケットを議論して DiscussResult を返す。
 * キー未設定・通信失敗・想定外応答時は fallback に落とす（throwしない）。
 */
export async function discussTicket(ticket: TicketRow): Promise<DiscussResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackDiscussion(ticket);

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const userContent = [
    `対象システム: ${ticket.system || "未特定"}`,
    `種別: ${ticket.type || "改善"}`,
    `重要度: ${ticket.importance || "中"}`,
    `件名: ${ticket.title || "改善のご要望"}`,
    `内容: ${ticket.detail || "(内容なし)"}`,
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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [DISCUSS_TOOL],
        tool_choice: { type: "tool", name: DISCUSS_TOOL.name },
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) return fallbackDiscussion(ticket);

    const data = await res.json();
    const toolUse = Array.isArray(data?.content)
      ? data.content.find(
          (b: any) => b?.type === "tool_use" && b?.name === DISCUSS_TOOL.name
        )
      : null;
    if (!toolUse?.input) return fallbackDiscussion(ticket);

    return { ...coerceDiscussion(toolUse.input), source: "claude" };
  } catch {
    return fallbackDiscussion(ticket);
  }
}
