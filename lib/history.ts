// ── 会話履歴のサニタイズ（純粋関数・テスト対象） ──
// /api/chat が受け取る生の messages を、安全な ChatMessage[] に整える。
// 画像添付は withVision=true のときだけ各 user ターンで検証して通す（既定OFF＝回帰ゼロ）。
// ファイル添付は withFiles=true のときだけ通す（PDF/テキスト/xlsx/docx・既定OFF）。
import { validateAttachments, validateAttachmentsMixed } from "./attachments";
import type { ChatMessage } from "./types";

// 後方互換：第2引数は boolean（=withVision）でも、オプションオブジェクトでも受ける。
export interface SanitizeOptions {
  withVision?: boolean;
  withFiles?: boolean;
}

export function sanitizeHistory(
  input: unknown,
  opts: boolean | SanitizeOptions
): ChatMessage[] {
  const withVision = typeof opts === "boolean" ? opts : opts?.withVision === true;
  const withFiles = typeof opts === "boolean" ? false : opts?.withFiles === true;

  if (!Array.isArray(input)) return [];
  // 先頭で末尾31件に絞る（暴走・DoS対策）。
  // ループ内の magic-byte 検証・base64 走査を末尾31件だけに限定し、
  // 10万件送られても O(1) で境界を入れる。
  const trimmed = input.length > 31 ? input.slice(-31) : input;
  const out: ChatMessage[] = [];
  for (const m of trimmed) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content : "";
    // 添付があるターンは content が空でも残す（添付だけ送るケース）。
    // ファイル有効時は画像＋ファイル混在の検証器、画像のみ有効時は従来の画像検証器を使う。
    let attachments: ChatMessage["attachments"] = [];
    if (role === "user") {
      if (withFiles) {
        // ファイル有効：ファイルは常に通し、画像は vision が有効なときだけ通す。
        attachments = validateAttachmentsMixed(m?.attachments, { allowImages: withVision });
      } else if (withVision) {
        attachments = validateAttachments(m?.attachments);
      }
    }
    if (!role) continue;
    if (!content && (!attachments || attachments.length === 0)) continue;
    const msg: ChatMessage = { role, content: content.slice(0, 4000) };
    if (attachments && attachments.length > 0) msg.attachments = attachments;
    out.push(msg);
  }
  // 直近30ターンに制限（暴走・コスト対策）
  return out.slice(-30);
}
