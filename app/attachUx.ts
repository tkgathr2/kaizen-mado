// ── 添付UXの純粋ヘルパ（クライアント側の弾き・表示用・テスト対象） ──
// サーバ側 lib/attachments.ts が最終防衛（型/サイズ/マジック）を担うが、
// ここはユーザーに「なぜ添付できないか」を即フィードバックするための前段チェック。
// 画像＋ファイル混在を 1ファイル10MB / 合計20MB / 5点 で弾く。純粋関数なので app/ 配下で単体テスト可能。

// クライアントで受け付ける画像 MIME（lib/attachments.ts の ALLOWED_MIMES と一致）。
export const UX_IMAGE_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

// クライアントで受け付けるファイル MIME（lib/attachments.ts の ALLOWED_FILE_MIMES と一致）。
export const UX_FILE_MIMES: readonly string[] = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// 1ファイル上限（10MB）／合計上限（20MB）／点数上限（5）。lib/attachments.ts のファイル経路と一致。
export const UX_MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
export const UX_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const UX_MAX_ATTACHMENTS = 5;

// 拡張子→MIME の補完表（ブラウザが file.type を空で返す .md / .csv 等を救う）。
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// file.type が空・曖昧なとき、ファイル名の拡張子から MIME を推定する。
export function resolveMime(fileType: string, fileName: string): string {
  const t = (fileType || "").toLowerCase().trim();
  if (t && (UX_IMAGE_MIMES.includes(t) || UX_FILE_MIMES.includes(t))) return t;
  // text/markdown を text/plain で返すブラウザがあるので拡張子を優先で見る。
  const m = /\.([a-z0-9]+)$/i.exec(fileName || "");
  if (m) {
    const ext = m[1].toLowerCase();
    if (EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  }
  return t; // 推定不能ならそのまま（呼び出し側で弾かれる）
}

export function isImageMime(mime: string): boolean {
  return UX_IMAGE_MIMES.includes((mime || "").toLowerCase());
}
export function isFileMime(mime: string): boolean {
  return UX_FILE_MIMES.includes((mime || "").toLowerCase());
}

export type AttachUxError =
  | "slots" // 点数オーバー
  | "unsupported" // 種別外
  | "too-large" // 1ファイル上限超過
  | "total"; // 合計上限超過

export interface AttachCheckInput {
  type: string; // file.type（空のこともある）
  name: string; // file.name
  size: number; // バイト数
}
export interface AttachCheckResult {
  ok: boolean;
  error?: AttachUxError;
  mime?: string; // 解決済み MIME（ok のとき）
  kind?: "image" | "file"; // 解決済み種別（ok のとき）
}

/**
 * 1ファイルがいま添付できるかを判定する（純粋関数）。
 * @param file      候補ファイルのメタ情報
 * @param usedCount すでに添付済みの点数
 * @param usedBytes すでに添付済みの合計バイト数
 */
export function checkAttachOne(
  file: AttachCheckInput,
  usedCount: number,
  usedBytes: number
): AttachCheckResult {
  if (usedCount >= UX_MAX_ATTACHMENTS) return { ok: false, error: "slots" };
  const mime = resolveMime(file.type, file.name);
  const image = isImageMime(mime);
  const fileOk = isFileMime(mime);
  if (!image && !fileOk) return { ok: false, error: "unsupported" };
  if (file.size > UX_MAX_BYTES_PER_FILE) return { ok: false, error: "too-large" };
  if (usedBytes + file.size > UX_MAX_TOTAL_BYTES) return { ok: false, error: "total" };
  return { ok: true, mime, kind: image ? "image" : "file" };
}

// エラーコード→ユーザー向け日本語メッセージ。
export function attachErrorMessage(error: AttachUxError): string {
  switch (error) {
    case "slots":
      return `添付は最大${UX_MAX_ATTACHMENTS}点までです`;
    case "unsupported":
      return "対応していない形式です（画像／PDF／CSV／テキスト／Excel／Word）";
    case "too-large":
      return `1ファイル${Math.floor(UX_MAX_BYTES_PER_FILE / (1024 * 1024))}MBまでです`;
    case "total":
      return `合計${Math.floor(UX_MAX_TOTAL_BYTES / (1024 * 1024))}MBまでです`;
  }
}

// HTML の accept 属性（画像＋ファイル）。input[type=file] にそのまま渡す。
export const ATTACH_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp," +
  "application/pdf,.pdf," +
  "text/csv,.csv," +
  "text/plain,.txt," +
  "text/markdown,.md," +
  "application/json,.json," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx";

// ファイル種別に応じた表示用アイコン（非画像はファイル種別が一目で分かる絵文字）。
export function fileIcon(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m === "application/pdf") return "📕";
  if (m === "text/csv" || m.includes("spreadsheetml")) return "📊";
  if (m === "application/json") return "🔧";
  if (m.includes("wordprocessingml")) return "📝";
  return "📄";
}
