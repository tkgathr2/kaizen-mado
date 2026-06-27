// ── カイゼン窓口 会話契約の型（仕様書 §7 と同一） ──

export type Phase = "clarify" | "confirm";
export type TicketType = "bug" | "改善" | "新機能";
export type Importance = "高" | "中" | "低";
// 優先度（高/中/低）。緊急度×重要度から本人（AI）が算出する（仕様書 §4.5.1）。
// Importance（旧・高/中/低の主観重要度）とは別概念だが値域は同じ。
export type Priority = "高" | "中" | "低";

export interface Ticket {
  system: string;
  type: TicketType;
  title: string;
  detail: string;
  // 旧フィールド（主観重要度・高/中/低）。後方互換で残す。新規は priority を主に使う。
  importance: Importance;
  // ── 優先度スコアリング（仕様書 §4.5.1・WEB申請=Phase1で追加） ──
  // AIがヒアリング内容から各1〜10で自動算出（ユーザーに優先度は聞かない）。
  // 後方互換：旧チケット（点数なし）は undefined。表示側は「—」にフォールバックする。
  urgency?: number; // 緊急度 1〜10（9-10=業務停止／5-6=回避策あり／1-2=軽微）
  importanceScore?: number; // 重要度 1〜10（9-10=売上採用法令安全直結／5-6=一部業務／1-2=nice-to-have）
  priority?: Priority; // 高=どちらか8以上かつ合計14以上／中=合計8-13／低=合計≤7
  priorityReason?: string; // 算出根拠を1行
}

// AIが毎ターン返すJSON（confirm時はticketを必ず埋める）
export interface TurnResult {
  reply: string;
  phase: Phase;
  ticket: Ticket | null;
}

// ── 画像添付（Phase 2・base64 最小実装） ──
// 公開窓口なので外部ストレージ（Blob 等）を増やさず、base64 を会話履歴で持ち回る。
// API へ渡すのは直近の user ターンの画像だけに絞り（lib/prompt.ts）、トークン肥大を防ぐ。
// Notion/チケットには生画像を入れず「画像添付あり」程度に丸める（PII 観点・lib/notion.ts）。
export type AttachmentMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface Attachment {
  // data URL（"data:image/png;base64,...."）。表示・Anthropic への受け渡しに使う。
  dataUrl: string;
  mime: AttachmentMime;
  bytes: number; // デコード後のバイト数（上限チェック用）
  name?: string; // 元ファイル名（サニタイズ済み・表示用・任意）
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // 画像添付（user ターンのみ・任意・後方互換）。assistant では使わない。
  attachments?: Attachment[];
}
