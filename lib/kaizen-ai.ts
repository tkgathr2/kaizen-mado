/**
 * カイゼン改善 AI ロジック
 * - GO 自動判定（複数チケット候補から最確度のものを推定）
 * - 確度スコア（0.0-1.0）が 0.7 未満なら確認が必要
 */

import type { TicketRow } from "./tickets";

export interface GoDisambiguationResult {
  /** 推定チケット ID */
  ticketId: string;
  /** 推定チケットタイトル */
  title: string;
  /** 確度スコア（0.0-1.0）。0.7 以上で信頼度高 */
  confidence: number;
  /** 推定根拠（1行）。ユーザーに確認を促す時の説明 */
  reason: string;
  /** 複数候補があるか（0.7 以上の候補が 2 件以上） */
  hasMultipleCandidates: boolean;
  /** 複数候補がある場合は一覧（確度順）*/
  candidates?: Array<{ ticketId: string; title: string; confidence: number }>;
}

/**
 * 直前の会話文脈と GO待ちチケット一覧から、LLM で推定対象チケットを決定。
 * @param recentContext 直前の会話（ユーザー最後のメッセージ）
 * @param goWaitingTickets GO待ち中のチケット一覧
 * @returns 推定結果（確度付き）
 */
export async function disambiguateGoTarget(
  recentContext: string,
  goWaitingTickets: TicketRow[]
): Promise<GoDisambiguationResult | null> {
  if (!recentContext || goWaitingTickets.length === 0) return null;

  // 単一候補なら確度 1.0 で返す（推論不要）
  if (goWaitingTickets.length === 1) {
    const t = goWaitingTickets[0];
    return {
      ticketId: t.ticketId,
      title: t.title,
      confidence: 1.0,
      reason: "GO待ちが1件だけ",
      hasMultipleCandidates: false,
    };
  }

  // 複数候補：Claude Haiku で推定
  try {
    const candidateText = goWaitingTickets
      .map((t) => `- ${t.ticketId}: ${t.title} (${t.system})`)
      .join("\n");

    const prompt = `ユーザーの最後のメッセージと GO待ちチケット一覧から、最も確度の高いチケット ID を推定してください。

【ユーザーの直前メッセージ】
${recentContext}

【GO待ち中のチケット】
${candidateText}

【指示】
JSON で以下を返してください：
{
  "ticketId": "KZ-XX",
  "confidence": 0.85,
  "reason": "直前メッセージで「プロレポのバグ」と言及されており、プロレポ関連は ${goWaitingTickets[0].ticketId} のみ"
}

確度スコア：1.0=確実、0.8以上=強気、0.5-0.8=中程度、0.3未満=推定困難（確認必須）`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    const textContent = data?.content?.[0]?.text;
    if (!textContent) throw new Error("No text in response");

    // JSON 抽出（```json ... ``` や素の JSON に対応）
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const parsed = JSON.parse(jsonMatch[0]);
    const estimatedTicket = goWaitingTickets.find((t) => t.ticketId === parsed.ticketId);

    if (!estimatedTicket) {
      throw new Error(`Estimated ticket ${parsed.ticketId} not in candidates`);
    }

    // 複数候補（確度 0.7 以上）を抽出
    const highConfidenceCandidates = goWaitingTickets
      .map((t) => ({
        ticketId: t.ticketId,
        title: t.title,
        confidence: t.ticketId === parsed.ticketId ? parsed.confidence : 0.1, // 簡易版：推定対象を 0.7+、それ以外を 0.1
      }))
      .filter((c) => c.confidence >= 0.7)
      .sort((a, b) => b.confidence - a.confidence);

    return {
      ticketId: parsed.ticketId,
      title: estimatedTicket.title,
      confidence: parsed.confidence,
      reason: parsed.reason || "LLM推定",
      hasMultipleCandidates: highConfidenceCandidates.length > 1,
      ...(highConfidenceCandidates.length > 1 && {
        candidates: highConfidenceCandidates,
      }),
    };
  } catch (error) {
    console.error("GO disambiguation error:", error);
    return null;
  }
}
