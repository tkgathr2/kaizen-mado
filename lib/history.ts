// ── 会話履歴のサニタイズ（純粋関数・テスト対象） ──
// /api/chat が受け取る生の messages を、安全な ChatMessage[] に整える。
// 画像添付は withVision=true のときだけ各 user ターンで検証して通す（既定OFF＝回帰ゼロ）。
import { validateAttachments } from "./attachments";
import type { ChatMessage } from "./types";

export function sanitizeHistory(input: unknown, withVision: boolean): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  // 先頭で末尾31件に絞る（暴走・DoS対策）。
  // ループ内の magic-byte 検証・base64 走査を末尾31件だけに限定し、
  // 10万件送られても O(1) で境界を入れる。
  const trimmed = input.length > 31 ? input.slice(-31) : input;
  const out: ChatMessage[] = [];
  for (const m of trimmed) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content : "";
    // 画像添付があるターンは content が空でも残す（画像だけ送るケース）。
    const attachments =
      withVision && role === "user" ? validateAttachments(m?.attachments) : [];
    if (!role) continue;
    if (!content && attachments.length === 0) continue;
    const msg: ChatMessage = { role, content: content.slice(0, 4000) };
    if (attachments.length > 0) msg.attachments = attachments;
    out.push(msg);
  }
  // 直近30ターンに制限（暴走・コスト対策）
  return out.slice(-30);
}
