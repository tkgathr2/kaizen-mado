// ── 画像添付の検証・整形（純粋関数・サーバ/クライアント両用・テスト対象） ──
// 公開・無認証窓口なので、添付は必ずここで型/サイズ/枚数/マジックバイトを検証する。
// 保存方式は base64 data URL を会話履歴で持ち回る最小実装（外部ストレージ非依存）。
// Anthropic へは data URL から {type:"image",source:{type:"base64",...}} ブロックを組む。

import type { Attachment, AttachmentMime } from "./types";

// 対応する画像 MIME（公開窓口なので png/jpeg/gif/webp に限定）。
export const ALLOWED_MIMES: readonly AttachmentMime[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

// 1枚あたり上限（デコード後 5MB）。data URL は base64 で約 4/3 倍に膨らむ点に注意。
export const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
// 合計上限（10MB）。トークン肥大・ペイロード肥大の両方を抑える。
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
// 1ターンあたりの枚数上限。
export const MAX_ATTACHMENTS = 3;

export type ValidationError =
  | "empty"
  | "bad-format"
  | "unsupported-mime"
  | "magic-mismatch"
  | "too-large"
  | "decode-failed";

export interface ValidateOneResult {
  ok: boolean;
  error?: ValidationError;
  attachment?: Attachment;
}

// data URL から MIME と base64 本体を取り出す。
function parseDataUrl(
  dataUrl: string
): { mime: string; base64: string } | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(
    dataUrl.trim()
  );
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, "") };
}

function isAllowedMime(mime: string): mime is AttachmentMime {
  return (ALLOWED_MIMES as readonly string[]).includes(mime);
}

// base64 をデコードしてバイト列（先頭のみで十分）を得る。失敗時は null。
function decodeBase64Head(base64: string): Uint8Array | null {
  try {
    // 先頭 16 バイトだけ判定できれば十分（マジックバイト用）。ただし長さチェックは別途行う。
    const head = base64.slice(0, 64); // 約 48 バイト分
    const bin = atobUniversal(head);
    const len = Math.min(bin.length, 16);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// atob は Node/ブラウザ双方にある（Node18+ でグローバル）。無い環境では Buffer にフォールバック。
function atobUniversal(b64: string): string {
  if (typeof atob === "function") return atob(b64);
  // Node フォールバック（テスト等）。
  return Buffer.from(b64, "base64").toString("binary");
}

// base64 のデコード後バイト数を計算（実デコードせず長さから算出）。
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  if (clean.length === 0) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

// マジックバイト（ファイル先頭）と宣言 MIME の一致を確認する。
// data URL の Content-Type は自己申告なので、実バイトで裏取りする（PDF/exe 偽装を弾く）。
function magicMatches(mime: AttachmentMime, head: Uint8Array): boolean {
  const b = head;
  switch (mime) {
    case "image/png":
      // 89 50 4E 47 0D 0A 1A 0A
      return (
        b.length >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
      );
    case "image/jpeg":
      // FF D8 FF
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      // "GIF87a" / "GIF89a"
      return (
        b.length >= 6 &&
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) &&
        b[5] === 0x61
      );
    case "image/webp":
      // "RIFF" .... "WEBP"
      return (
        b.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
      );
    default:
      return false;
  }
}

/**
 * 添付候補1件を検証して、安全な Attachment に整形する（純粋関数）。
 * - data URL 形式／MIME ホワイトリスト／マジックバイト一致／サイズ上限 を順に確認。
 * - name は表示用にサニタイズ（制御文字・パス区切りを除去・長さ制限）。
 */
export function validateAttachment(input: unknown): ValidateOneResult {
  if (!input || typeof input !== "object") return { ok: false, error: "empty" };
  const rawUrl = (input as any).dataUrl;
  const parsed = parseDataUrl(rawUrl);
  if (!parsed) return { ok: false, error: "bad-format" };
  if (!isAllowedMime(parsed.mime)) return { ok: false, error: "unsupported-mime" };

  const bytes = base64ByteLength(parsed.base64);
  if (bytes <= 0) return { ok: false, error: "empty" };
  if (bytes > MAX_BYTES_PER_IMAGE) return { ok: false, error: "too-large" };

  const head = decodeBase64Head(parsed.base64);
  if (!head) return { ok: false, error: "decode-failed" };
  if (!magicMatches(parsed.mime, head)) return { ok: false, error: "magic-mismatch" };

  const attachment: Attachment = {
    // 検証済みの正規化済み data URL を再構成（余分な空白を除く）。
    dataUrl: `data:${parsed.mime};base64,${parsed.base64}`,
    mime: parsed.mime,
    bytes,
  };
  const name = sanitizeName((input as any).name);
  if (name) attachment.name = name;
  return { ok: true, attachment };
}

/**
 * 添付配列を検証する（枚数・合計サイズの上限を適用）。
 * - 枚数は MAX_ATTACHMENTS まで（超過分は捨てる）。
 * - 各要素を validateAttachment にかけ、不正は捨てる（fail-safe・会話を止めない）。
 * - 合計サイズが MAX_TOTAL_BYTES を超えたら、それ以降を捨てる。
 * 返り値は安全な Attachment[]（最大 MAX_ATTACHMENTS 件）。
 */
export function validateAttachments(input: unknown): Attachment[] {
  if (!Array.isArray(input)) return [];
  const out: Attachment[] = [];
  let total = 0;
  for (const item of input) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const res = validateAttachment(item);
    if (!res.ok || !res.attachment) continue;
    if (total + res.attachment.bytes > MAX_TOTAL_BYTES) continue;
    total += res.attachment.bytes;
    out.push(res.attachment);
  }
  return out;
}

// 表示用ファイル名の最小サニタイズ（パス・制御文字除去・長さ制限）。
function sanitizeName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    // パス区切り・空白を除去（表示用にファイル名の体裁だけ残す）。
    // 文字クラスのレンジ誤解釈を避けるため種類ごとに個別 replace する。
    .replace(/\\/g, "")
    .replace(/\//g, "")
    .replace(/\s+/g, "")
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : undefined;
}

// Anthropic Messages API の画像ブロック（base64 ソース）。
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: AttachmentMime; data: string };
}
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/**
 * Attachment[] を Anthropic の画像ブロック配列へ変換する（純粋関数）。
 * data URL の base64 本体だけを取り出して source.data に入れる。
 * 不正な要素は飛ばす（fail-safe）。
 */
export function buildImageBlocks(
  attachments: Attachment[] | undefined
): AnthropicImageBlock[] {
  if (!Array.isArray(attachments)) return [];
  const blocks: AnthropicImageBlock[] = [];
  for (const a of attachments) {
    const parsed = parseDataUrl(a?.dataUrl ?? "");
    if (!parsed || !isAllowedMime(parsed.mime)) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
    });
  }
  return blocks;
}
