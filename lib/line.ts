// ── LINE Messaging API クライアント（GO伺いの送信＋webhook署名検証） ──
// 依存軽量化のため素のfetch + node:crypto で実装（line-notify-ai の line.ts を踏襲）。
// 秘密情報は process.env から読む。LINE鍵が未設定なら lineEnabled()=false で「送らない」=fail-safe。
// このモジュール自体は対人送信を行うが、宛先は LINE_TARGET_USER_ID（高木さん本人）に限定する。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TicketRow } from "./tickets";
import type { DiscussResult } from "./discuss";

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// ── env ヘルパ ──
function accessToken(): string {
  const v = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!v) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return v;
}
function channelSecret(): string {
  const v = process.env.LINE_CHANNEL_SECRET;
  if (!v) throw new Error("LINE_CHANNEL_SECRET is not set");
  return v;
}
function targetUserId(): string {
  const v = process.env.LINE_TARGET_USER_ID;
  if (!v) throw new Error("LINE_TARGET_USER_ID is not set");
  return v;
}

/** LINE連携が有効か（3鍵すべて揃ったときだけ送信する。未設定なら静かにスキップ）。 */
export function lineEnabled(): boolean {
  return Boolean(
    process.env.LINE_CHANNEL_ACCESS_TOKEN &&
      process.env.LINE_CHANNEL_SECRET &&
      process.env.LINE_TARGET_USER_ID
  );
}

/** 送信元userIdが通知先（高木さん本人）か。webhookで他人の操作を弾く。 */
export function isAuthorizedUser(userId: string | undefined | null): boolean {
  if (!userId) return false;
  const expected = process.env.LINE_TARGET_USER_ID;
  if (!expected) return false;
  const a = Buffer.from(userId);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Webhook署名検証。body生文字列を channel secret で HMAC-SHA256 → base64 し、
 * x-line-signature と timing-safe に比較する。
 */
export function verifyLineSignature(
  body: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;
  let secret: string;
  try {
    secret = channelSecret();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── GO伺いの照合トークン（誤爆・なりすまし対策） ──
// postbackのdataは利用者が改ざんできないが、署名済みwebhookでも「どのチケットへの操作か」を
// 確実に結びつけるため、pageIdからchannel secretでHMACした短いトークンを付ける。
// 我々が送ったボタン以外（偽postback）を弾く。
export function proposalToken(pageId: string): string {
  let secret: string;
  try {
    secret = channelSecret();
  } catch {
    return "";
  }
  return createHmac("sha256", secret).update(`kz:${pageId}`, "utf8").digest("hex").slice(0, 16);
}

/** トークンを timing-safe に検証する。 */
export function verifyProposalToken(pageId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = proposalToken(pageId);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GoAction = "go" | "fix" | "reject";

/** GO/修正/却下 の quick reply（postback）を組み立てる。dataにチケットpageIdと照合トークンを埋める。 */
function goQuickReply(pageId: string) {
  const tk = proposalToken(pageId);
  const mk = (act: GoAction, label: string, displayText: string) => ({
    type: "action" as const,
    action: {
      type: "postback" as const,
      label,
      data: `kz=${act}&pid=${encodeURIComponent(pageId)}&tk=${tk}`,
      displayText,
    },
  });
  return {
    items: [
      mk("go", "✅ GO（着手）", "GO"),
      mk("fix", "✏️ 修正", "修正"),
      mk("reject", "🚫 却下", "却下"),
    ],
  };
}

/** postback の data 文字列を {action,pageId,token} にパースする。 */
export function parsePostback(
  data: string | undefined | null
): { action: GoAction; pageId: string; token: string } | null {
  if (!data) return null;
  const params = new URLSearchParams(data);
  const act = params.get("kz");
  if (act !== "go" && act !== "fix" && act !== "reject") return null;
  const pageId = params.get("pid") || "";
  if (!pageId) return null;
  return { action: act, pageId, token: params.get("tk") || "" };
}

// テキスト返信からGO/修正/却下＋チケットIDを読む（ボタンを使わず「GO KZ-12」と打つ場合）。
const TEXT_GO = /^(go|ok|ゴー|ごー|オーケー|承認|よし)/i;
const TEXT_REJECT = /^(却下|ng|やめ|中止|なし)/i;
const TEXT_FIX = /^(修正|なおして|直して|やり直し)/;
const TICKET_ID_RE = /\b(KZ[-－]?\d+)\b/i;

/** 自由文から {action, ticketId?} を読む。判定不能なら null（誤爆防止）。 */
export function parseTextCommand(
  text: string | undefined | null
): { action: GoAction; ticketId: string | null } | null {
  if (!text) return null;
  const t = text.trim();
  let action: GoAction | null = null;
  if (TEXT_REJECT.test(t)) action = "reject";
  else if (TEXT_FIX.test(t)) action = "fix";
  else if (TEXT_GO.test(t)) action = "go";
  if (!action) return null;
  const m = t.match(TICKET_ID_RE);
  const ticketId = m ? m[1].toUpperCase().replace("－", "-").replace(/KZ(\d)/, "KZ-$1") : null;
  return { action, ticketId };
}

// ── 送信系（失敗してもthrowしない：呼び出し元の改善ループを止めないため fail-safe） ──
async function postLine(endpoint: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken()}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[line] post失敗", { endpoint, status: res.status, detail: detail.slice(0, 200) });
      return false;
    }
    return true;
  } catch (e) {
    console.error("[line] post例外", { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** 任意テキストを高木さん宛にpushする（完了報告・警告等）。 */
export async function pushText(text: string): Promise<boolean> {
  if (!lineEnabled()) return false;
  return postLine(LINE_PUSH_ENDPOINT, {
    to: targetUserId(),
    messages: [{ type: "text", text }],
  });
}

/** postback応答用の簡易reply（「着手します」等の受領返信）。 */
export async function replyText(replyToken: string, text: string): Promise<boolean> {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return false;
  return postLine(LINE_REPLY_ENDPOINT, {
    replyToken,
    messages: [{ type: "text", text }],
  });
}

/** GO伺い本文を組み立てる（チケット＋議論結果から）。
 * 複数提案が連続で届いてもLINEのquick replyボタンは"最新メッセージ"にしか付かないため、
 * 各提案を「ID付きテキスト返信（GO KZ-3 等）」で個別に答えられる形にする（前の提案にも返信可）。 */
export function buildProposalText(ticket: TicketRow, d: DiscussResult): string {
  const risks = d.risks.length ? d.risks.map((r) => `・${r}`).join("\n") : "・特になし";
  const id = ticket.ticketId;
  return (
    `🔁 カイゼン提案 ${id}\n` +
    `━━━━━━━━━━\n` +
    `対象：${ticket.system || "未特定"}（${ticket.type || "改善"}・重要度${ticket.importance || "中"}）\n` +
    `件名：${ticket.title || "改善のご要望"}\n` +
    `\n` +
    `方針：${d.houshin}\n` +
    `工数：${d.kousuu}\n` +
    `リスク：\n${risks}\n` +
    `推奨：${d.recommendation}\n` +
    `━━━━━━━━━━\n` +
    `▼ 返信でお答えください（複数届いてもIDで区別できます）\n` +
    `　✅ 着手 → 「GO ${id}」\n` +
    `　✏️ 修正 → 「修正 ${id}」\n` +
    `　🚫 却下 → 「却下 ${id}」\n` +
    `※下の3ボタンは“最新の提案”だけに付きます。前の提案にはこの「GO ${id}」のようにIDで返信してください。`
  );
}

/** GO待ちチケットの提案を高木さん宛にpushする。GO/修正/却下のquick reply付き。 */
export async function pushProposal(ticket: TicketRow, d: DiscussResult): Promise<boolean> {
  if (!lineEnabled()) return false;
  return postLine(LINE_PUSH_ENDPOINT, {
    to: targetUserId(),
    messages: [
      {
        type: "text",
        text: buildProposalText(ticket, d),
        quickReply: goQuickReply(ticket.pageId),
      },
    ],
  });
}
