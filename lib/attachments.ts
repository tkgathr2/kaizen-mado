// ── 画像添付の検証・整形（純粋関数・サーバ/クライアント両用・テスト対象） ──
// 公開・無認証窓口なので、添付は必ずここで型/サイズ/枚数/マジックバイトを検証する。
// 保存方式は base64 data URL を会話履歴で持ち回る最小実装（外部ストレージ非依存）。
// Anthropic へは data URL から {type:"image",source:{type:"base64",...}} ブロックを組む。

import type { Attachment, AttachmentMime, FileMime } from "./types";
import { extractOfficeText } from "./fileExtract";

// 対応する画像 MIME（公開窓口なので png/jpeg/gif/webp に限定）。
export const ALLOWED_MIMES: readonly AttachmentMime[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

// 対応するファイル MIME（PDF＋テキスト系＋xlsx/docx）。
export const ALLOWED_FILE_MIMES: readonly FileMime[] = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

// 抽出してテキスト連結する系（base64→text）。
const TEXT_FILE_MIMES: readonly FileMime[] = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
] as const;

// 1枚あたり上限（デコード後 5MB）。data URL は base64 で約 4/3 倍に膨らむ点に注意。
export const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
// ファイル1点あたり上限（デコード後 10MB）。
export const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
// 合計上限（10MB）。トークン肥大・ペイロード肥大の両方を抑える（画像のみ経路の既定）。
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
// ファイル添付を含む経路の合計上限（20MB）。
export const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
// 1ターンあたりの点数上限（画像のみ経路）。
export const MAX_ATTACHMENTS = 3;
// ファイル添付を含む経路の点数上限。
export const MAX_FILE_ATTACHMENTS = 5;
// テキスト系を text ブロックに連結するときの 1 ファイルあたり文字数上限（1.5万字）。
export const MAX_TEXT_CHARS = 15000;

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

function isAllowedFileMime(mime: string): mime is FileMime {
  return (ALLOWED_FILE_MIMES as readonly string[]).includes(mime);
}

function isTextFileMime(mime: string): boolean {
  return (TEXT_FILE_MIMES as readonly string[]).includes(mime);
}

function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}

function isOfficeMime(mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
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

// base64 全体をデコードして Uint8Array を得る（office 抽出・テキスト復号用）。失敗時 null。
export function decodeBase64Full(base64: string): Uint8Array | null {
  const clean = base64.replace(/\s+/g, "");
  if (clean.length === 0) return null;
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(clean, "base64"));
    }
    const bin = atobUniversal(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// バイト列を UTF-8 文字列へ。失敗時 null。
function bytesToUtf8(bytes: Uint8Array): string | null {
  try {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    return Buffer.from(bytes).toString("utf-8");
  } catch {
    return null;
  }
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

// ファイル系のマジックバイト一致判定（PDF=%PDF / xlsx・docx=PKzip）。
// テキスト系（csv/txt/md/json）は固有のマジックが無いので、宣言 MIME のみで通す。
function fileMagicMatches(mime: FileMime, head: Uint8Array): boolean {
  const b = head;
  if (isPdfMime(mime)) {
    // "%PDF" = 25 50 44 46
    return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  }
  if (isOfficeMime(mime)) {
    // ZIP ローカルファイルヘッダ "PK\x03\x04"（空 zip 等の "PK\x05\x06"/"PK\x07\x08" も許容）。
    return (
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) &&
      (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)
    );
  }
  // テキスト系はマジック検証なし（宣言 MIME と許可リストで担保）。
  return isTextFileMime(mime);
}

/**
 * ファイル添付候補1件を検証して安全な Attachment（kind:"file"）に整形する。
 * - data URL 形式／ファイル MIME ホワイトリスト／マジックバイト／サイズ上限。
 * - PDF・office・テキスト系を許可。画像は validateAttachment 側で扱う。
 */
export function validateFileAttachment(input: unknown): ValidateOneResult {
  if (!input || typeof input !== "object") return { ok: false, error: "empty" };
  const parsed = parseDataUrl((input as any).dataUrl);
  if (!parsed) return { ok: false, error: "bad-format" };
  if (!isAllowedFileMime(parsed.mime)) return { ok: false, error: "unsupported-mime" };

  const bytes = base64ByteLength(parsed.base64);
  if (bytes <= 0) return { ok: false, error: "empty" };
  if (bytes > MAX_BYTES_PER_FILE) return { ok: false, error: "too-large" };

  // バイナリ（PDF/office）はマジックバイトで裏取り。テキスト系は head を取れれば良い。
  const head = decodeBase64Head(parsed.base64);
  if (!head) return { ok: false, error: "decode-failed" };
  if (!fileMagicMatches(parsed.mime as FileMime, head)) {
    return { ok: false, error: "magic-mismatch" };
  }

  const attachment: Attachment = {
    kind: "file",
    dataUrl: `data:${parsed.mime};base64,${parsed.base64}`,
    mime: parsed.mime as FileMime,
    bytes,
  };
  const name = sanitizeName((input as any).name);
  if (name) attachment.name = name;
  return { ok: true, attachment };
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
 *
 * DoS 対策（増幅DoS）：上限は「入力インデックス基準」で切る。
 * 無効添付は continue で out.length が増えないため、成功件数基準だと break が
 * 発火せず、大量の無効添付に対して全件 regex/atob 走査が走る（増幅DoS）。
 * 先頭 MAX_ATTACHMENTS 件だけを走査対象にして O(上限) で打ち切る。
 */
export function validateAttachments(input: unknown): Attachment[] {
  if (!Array.isArray(input)) return [];
  const out: Attachment[] = [];
  let total = 0;
  // 入力インデックス基準で上限を切る（無効要素でも走査を増幅させない）。
  for (const item of input.slice(0, MAX_ATTACHMENTS)) {
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

// Anthropic の document（PDF）ブロック。
export interface AnthropicDocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
}

export type AnthropicContentBlock =
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicTextBlock;

// 添付が画像 or ファイルかを判定（kind 省略の旧データは MIME から推定）。
export function isFileAttachment(a: Attachment): boolean {
  if (a?.kind === "file") return true;
  if (a?.kind === "image") return false;
  // 旧データ（kind 省略）は MIME で判定（既存は画像のみ）。
  const parsed = parseDataUrl(a?.dataUrl ?? "");
  return parsed ? isAllowedFileMime(parsed.mime) : false;
}

/**
 * ファイル添付（PDF / テキスト系 / xlsx・docx）を Anthropic のブロック配列へ変換する。
 * - PDF：document ブロック（base64）。
 * - テキスト系：base64→UTF-8 復号し「【添付ファイル: name】\n<中身(上限)>」を text ブロックに。
 * - xlsx/docx：extractOfficeText でサーバ側抽出 → text ブロックに。失敗時はプレースホルダ。
 * 不正・抽出失敗は会話を止めず握りつぶす（fail-safe）。
 */
export function buildFileBlocks(
  attachments: Attachment[] | undefined
): AnthropicContentBlock[] {
  if (!Array.isArray(attachments)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const a of attachments) {
    const parsed = parseDataUrl(a?.dataUrl ?? "");
    if (!parsed || !isAllowedFileMime(parsed.mime)) continue;
    const mime = parsed.mime as FileMime;
    const label = a?.name ? a.name : "ファイル";

    if (isPdfMime(mime)) {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: parsed.base64 },
      });
      continue;
    }

    if (isTextFileMime(mime)) {
      const bytes = decodeBase64Full(parsed.base64);
      const text = bytes ? bytesToUtf8(bytes) : null;
      const body = text != null ? clampText(text) : null;
      blocks.push({
        type: "text",
        text:
          body != null
            ? `【添付ファイル: ${label}】\n${body}`
            : `（中身を読めませんでした: ${label}）`,
      });
      continue;
    }

    if (isOfficeMime(mime)) {
      const bytes = decodeBase64Full(parsed.base64);
      const extracted = bytes ? extractOfficeText(mime, bytes) : null;
      blocks.push({
        type: "text",
        text:
          extracted != null && extracted.length > 0
            ? `【添付ファイル: ${label}】\n${clampText(extracted)}`
            : `（中身を読めませんでした: ${label}）`,
      });
      continue;
    }
  }
  return blocks;
}

function clampText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? text.slice(0, MAX_TEXT_CHARS) + "\n…（以下省略）"
    : text;
}

/**
 * 画像とファイルが混在した添付配列を検証する（withFiles=true の経路用）。
 * - 各要素を画像 or ファイルとして検証（kind / MIME で振り分け）。
 * - 点数 MAX_FILE_ATTACHMENTS・合計 MAX_TOTAL_FILE_BYTES の上限を適用。
 * - allowImages=false（既定）のとき画像は通さない（画像は KAIZEN_VISION_ENABLED で別管理）。
 * 返り値は安全な Attachment[]（画像は kind 省略のまま＝後方互換、ファイルは kind:"file"）。
 */
export function validateAttachmentsMixed(
  input: unknown,
  opts: { allowImages?: boolean } = {}
): Attachment[] {
  if (!Array.isArray(input)) return [];
  const allowImages = opts.allowImages === true;
  const out: Attachment[] = [];
  let total = 0;
  // 入力インデックス基準で上限を切る（無効要素でも走査を増幅させない＝増幅DoS対策）。
  // 成功件数基準だと無効添付で out.length が増えず break が発火せず、
  // 大量の無効添付で全件 regex/atob 走査が走ってしまう。
  for (const item of input.slice(0, MAX_FILE_ATTACHMENTS)) {
    // MIME から画像かファイルかを見て、適切な検証器に回す。
    const parsed = parseDataUrl((item as any)?.dataUrl);
    let res: ValidateOneResult;
    if (parsed && isAllowedFileMime(parsed.mime)) {
      res = validateFileAttachment(item);
    } else if (allowImages) {
      res = validateAttachment(item);
    } else {
      continue; // 画像は許可されていない（ファイル経路のみ）。
    }
    if (!res.ok || !res.attachment) continue;
    if (total + res.attachment.bytes > MAX_TOTAL_FILE_BYTES) continue;
    total += res.attachment.bytes;
    out.push(res.attachment);
  }
  return out;
}
