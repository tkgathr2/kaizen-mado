// ── カイゼンくん 状態機械の型定義（Phase 1 止血フェーズ） ──
// 既存コードの日本語状態名（Notionのselect値）と完全一致させる。
// 新しい状態を追加するときはここと Notion DB の両方を更新する。

// Notion の「状態」selectに存在する値の全集合。
// 既存コードは文字列リテラルで直書きしていたが、ここで一元定義する。
export const KZ_STATUS = {
  OPEN: "受付",
  DISCUSSING: "議論中",
  AWAITING_GO: "GO待ち",
  IN_PROGRESS: "着手",
  IMPLEMENTING: "実装中",
  REVIEW: "レビュー",
  BLOCKED: "差し戻し",
  DONE: "完了",
  CLOSED: "クローズ", // タイムアウト自動クローズ用（Phase 1 新設）
} as const;

export type KZStatus = (typeof KZ_STATUS)[keyof typeof KZ_STATUS];

/** 終端状態（タイムアウトスキャンの対象外）。 */
export const TERMINAL_STATUSES: KZStatus[] = [KZ_STATUS.DONE, KZ_STATUS.CLOSED];

/** 非終端状態（タイムアウトスキャン対象）。 */
export function isTerminal(state: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(state);
}

// ── タイムアウト定義（ミリ秒） ──
// env で上書き可能にしておく（将来の調整を容易に）。
export const TIMEOUTS = {
  /** GO待ち：48h で社長へリマインド。 */
  AWAITING_GO_REMIND_MS:
    Number(process.env.KZ_AWAITING_GO_REMIND_MS) || 48 * 60 * 60 * 1000,
  /** GO待ち：7日で自動CLOSED。 */
  AWAITING_GO_AUTO_CLOSE_MS:
    Number(process.env.KZ_AWAITING_GO_AUTO_CLOSE_MS) || 7 * 24 * 60 * 60 * 1000,
  /** 差し戻し（BLOCKED）：48h で社長へリマインド。 */
  BLOCKED_REMIND_MS:
    Number(process.env.KZ_BLOCKED_REMIND_MS) || 48 * 60 * 60 * 1000,
  /** 差し戻し（BLOCKED）：7日で自動CLOSED。 */
  BLOCKED_AUTO_CLOSE_MS:
    Number(process.env.KZ_BLOCKED_AUTO_CLOSE_MS) || 7 * 24 * 60 * 60 * 1000,
  /** 着手/実装中：30分 stuckとみなしてログ記録（reaper は execute 既存実装で対応）。 */
  IN_PROGRESS_STUCK_MS:
    Number(process.env.KZ_IN_PROGRESS_STUCK_MS) || 30 * 60 * 1000,
  /** レビュー：7日で社長へリマインド。 */
  REVIEW_REMIND_MS:
    Number(process.env.KZ_REVIEW_REMIND_MS) || 7 * 24 * 60 * 60 * 1000,
} as const;

// ── failureClass（callback のフェイル分類）──
// callback POST body で `result=failed` のときに必須となる分類。
export const FAILURE_CLASSES = [
  "IMPL_FAILED",    // AI改修そのものの失敗
  "ENV_ERROR",      // 認証/権限/設定系の基盤エラー
  "PERM_BLOCKED",   // 権限不足でブロック
  "TIMEOUT",        // 実行タイムアウト
  "UNKNOWN",        // 不明（evidenceLog 必須）
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** failureClass が有効値か検証する。 */
export function isValidFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && (FAILURE_CLASSES as readonly string[]).includes(v);
}
