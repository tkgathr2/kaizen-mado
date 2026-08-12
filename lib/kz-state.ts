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
  /**
   * 真田システム（mention-hisho）側の Claude Code が実装を担っている状態。
   *
   * 【バグチェック High-1 修正・2026-08-12】社長がLINEカードの「🛠 ClaudeCodeへ送る」を押すと、
   * 真田側が Claude Code セッションを実課金で起動する。旧実装はその直後に
   * `/api/admin/go {action:"go"}` を書き戻して状態を「着手」にしていたため、
   * カイゼンくん側の自動改修（/api/execute → repository_dispatch → kaizen-execute.yml、および
   * kaizen-loop.yml の15分ごとのcron）が**同じチケットを二重に実装**していた
   * （2026-08-12 KZ-132 で実測。Claude Code セッション2本＝二重課金、同一リポへの競合PRリスク）。
   *
   * 「着手」以外の**どのクエリにも拾われない状態**を新設して構造的に断つ。
   * カイゼンくん側で状態名を select で引いているのは以下がすべてであり、
   * この値はそのいずれにも現れない（＝自動改修に拾われる経路は1本も無い）:
   *   - app/api/process        … fetchTicketsByState("受付")
   *   - app/api/execute        … fetchTicketsByState("着手") / fetchStaleImplementing→("実装中")
   *   - app/api/execute        … mode=review-list: fetchTicketsByState("レビュー")
   *   - app/api/admin/go       … findGoMachiByTicketId / fetchTicketsByState("GO待ち")
   *   - app/api/cron/kz-sweep  … fetchNonTerminalTickets（下記で本状態を「リマインドのみ」で追加）
   * ⚠️【2026-08-12 本番実測で判明・重要】「状態」は select プロパティだが、**Notion API は
   *    未登録の選択肢を自動作成しない**（`Invalid select value for property "状態"` の 400 を返す）。
   *    当初この定数のコメントは「patch 時に自動で選択肢が増える」と書いていたが誤りで、
   *    実際に本番DBへ書こうとして 400 を返されて判明した。
   *    → この値は Notion の「🔁 カイゼンくん 改善チケットDB」の「状態」に**選択肢として登録済み**
   *      であることが前提（2026-08-12 登録済み）。DBを作り直す・複製する場合は必ず先に追加すること。
   *      無いと updateTicketState が投げ、GOの書き戻しが 500 になってチケットがGO待ちに取り残される。
   *      （二重実装は起きない＝安全側に倒れるが、チケットは進まない）
   */
  SANADA_IMPLEMENTING: "真田実装中",
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
  /**
   * 真田実装中：48h で社長へリマインド。**自動クローズはしない**。
   * 実装しているのは別システム（真田側 Claude Code）なので、カイゼンくんが勝手に閉じると
   * 向こうが完了報告してきたときに突き合わせ先が消える。放置検知だけ行う。
   */
  SANADA_IMPLEMENTING_REMIND_MS:
    Number(process.env.KZ_SANADA_IMPLEMENTING_REMIND_MS) || 48 * 60 * 60 * 1000,
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
