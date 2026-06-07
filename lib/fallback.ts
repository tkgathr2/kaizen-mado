// ── フォールバック会話エンジン ──
// Anthropic API が不通でも会話が破綻しないよう、決め打ちの簡易進行で
// clarify を数ターン回して confirm へ到達させる（仕様書 §6）。
import type { ChatMessage, TurnResult, TicketType, Importance } from "./types";

function guessType(text: string): TicketType {
  const t = text.toLowerCase();
  if (/(バグ|不具合|エラー|落ちる|動かない|直して|おかしい|表示されない|固まる|error|bug)/.test(text + t))
    return "bug";
  if (/(欲しい|追加|新しく|新機能|作って|できるように|機能を|つけて)/.test(text)) return "新機能";
  return "改善";
}

function guessImportance(text: string): Importance {
  if (/(至急|今すぐ|止ま|業務が|使えない|毎回|全員|致命|大至急|困ってい)/.test(text)) return "高";
  if (/(できれば|いつか|余裕|気になる程度|軽微|なくても)/.test(text)) return "低";
  return "中";
}

const userTurns = (history: ChatMessage[]) => history.filter((m) => m.role === "user").length;

/**
 * フォールバックの1ターン。
 * @param system 確定済みの対象システム名（null なら未特定）
 * @param history これまでの全メッセージ（最後は今回のユーザー発話）
 */
export function fallbackTurn(system: string | null, history: ChatMessage[]): TurnResult {
  const turns = userTurns(history);
  const userTexts = history.filter((m) => m.role === "user").map((m) => m.content.trim());
  const lastUser = userTexts[userTexts.length - 1] ?? "";
  const sys = system ?? "ご利用のシステム";

  // 1回目：対象確認＋何が起きているか
  if (turns <= 1) {
    return {
      reply: system
        ? `承知しました。${sys}の件で合っていますか？ どんなことが起きているか、まず一言で教えてください。`
        : `ご連絡ありがとうございます。まず、どのシステムについてのお話か教えていただけますか？（例：プロレポ／ステレポ／ほうこちゃん など）`,
      phase: "clarify",
      ticket: null,
    };
  }

  // 2回目：どの画面・操作で
  if (turns === 2) {
    return {
      reply: `ありがとうございます。それは${sys}のどの画面、またはどの操作のときに起きますか？`,
      phase: "clarify",
      ticket: null,
    };
  }

  // 3回目：どうしたいか（要望）
  if (turns === 3) {
    return {
      reply: `状況わかりました。理想としては、どうなると助かりますか？ 一言で大丈夫です。`,
      phase: "clarify",
      ticket: null,
    };
  }

  // 4回目以降：これまでの発話を束ねて confirm へ
  const combined = userTexts.join(" / ");
  const type = guessType(combined);
  const importance = guessImportance(combined);
  const title =
    (lastUser || userTexts[0] || "改善のご要望").replace(/\s+/g, " ").slice(0, 28) ||
    "改善のご要望";
  const detail = `${sys}についてのご意見。${userTexts
    .map((t, i) => `(${i + 1}) ${t}`)
    .join(" ")}`.slice(0, 1500);

  return {
    reply: `ありがとうございます。内容をまとめました。\n\n【対象】${sys}\n【種別】${type}\n【重要度】${importance}\n【内容】${detail}\n\n最後に、この内容で送りますね。よろしいですか？`,
    phase: "confirm",
    ticket: { system: sys, type, title, detail, importance },
  };
}
