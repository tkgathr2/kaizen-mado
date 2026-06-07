// ── カイゼン窓口 会話契約の型（仕様書 §7 と同一） ──

export type Phase = "clarify" | "confirm";
export type TicketType = "bug" | "改善" | "新機能";
export type Importance = "高" | "中" | "低";

export interface Ticket {
  system: string;
  type: TicketType;
  title: string;
  detail: string;
  importance: Importance;
}

// AIが毎ターン返すJSON（confirm時はticketを必ず埋める）
export interface TurnResult {
  reply: string;
  phase: Phase;
  ticket: Ticket | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
