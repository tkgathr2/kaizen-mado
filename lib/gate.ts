// ── 実行前ゲート（preGate）＝自動で着手してよいか判定する ──
// 設計v0.1 §5/§10：ハイブリッド＝作るのは自動だが、危険なものは「社長案件」へエスカレ。
// 1つでもエスカレ要因があれば mode="escalate"（②本番投入GO＝社長判断で止める）。
// ここで弾けるのは "着手前に分かる" 危険（対象未確定・自動未許可・PII/金額の気配・新機能の大物）。
// diff行数やCI green、禁止パス接触は "コード生成後" にActionsワークフロー側のゲートで判定する。
import type { TicketRow } from "./tickets";
import type { TargetMeta } from "./targets";

export interface GateDecision {
  mode: "auto" | "escalate";
  reasons: string[];
}

// 件名・内容にこれが含まれたら、機微（金額・個人情報・破壊的操作）として人の確認へ。
const SENSITIVE_KEYWORDS = [
  // 金額・課金
  "金額", "支払", "支払い", "請求", "入金", "振込", "決済", "課金", "料金", "返金", "口座", "クレジット",
  "payment", "invoice", "billing", "refund", "charge", "price",
  // 個人情報
  "個人情報", "氏名", "名前", "電話", "住所", "メールアドレス", "マイナンバー", "生年月日",
  "pii", "email", "phone", "personal",
  // 認証・秘密
  "パスワード", "認証", "ログイン", "トークン", "秘密鍵", "apiキー", "クレデンシャル",
  "password", "passwd", "secret", "token", "credential", "apikey", "api key", "auth", "oauth",
  // 破壊的操作・DB
  "削除", "全消し", "消去", "解約", "退会", "本番db", "マイグレーション", "スキーマ変更",
  "delete", "drop", "truncate", "migrate", "migration", "destroy", "wipe",
];

/** 真田自走（オートパイロット）が有効か。
 * ON のとき、preGate=auto の安全な改善は社長にGO伺いせず自動で着手→PR→マージまで進める。
 * 社長を呼ぶのは preGate=escalate（金額/個人情報/認証/破壊/新機能/自動未許可システム）だけ。
 * ＝「社長と真田の関係」と同じ：安全は任せて事後報告、危険だけ確認。 */
export function autopilotEnabled(): boolean {
  const v = (process.env.KAIZEN_AUTOPILOT || "").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/** 着手前ゲート。自動可なら "auto"、危険要因があれば "escalate"（理由つき）。 */
export function preGate(ticket: TicketRow, target: TargetMeta | null): GateDecision {
  const reasons: string[] = [];

  if (!target) {
    reasons.push("対象システムが未定義（マッピングなし）");
    return { mode: "escalate", reasons };
  }
  if (!target.autoEligible) {
    reasons.push(`「${target.system}」は自動実行が未許可（段階リリース・既定OFF）`);
  }
  if (!target.repo) {
    reasons.push(`「${target.system}」のリポジトリが未確定`);
  }
  if (ticket.type === "新機能") {
    reasons.push("新機能は影響範囲が大きいため人の確認を推奨");
  }
  const hay = `${ticket.title}\n${ticket.detail}`.toLowerCase();
  const hit = SENSITIVE_KEYWORDS.find((k) => hay.includes(k.toLowerCase()));
  if (hit) {
    reasons.push(`機微キーワード「${hit}」を含む（金額/個人情報/破壊的操作の可能性）`);
  }

  return reasons.length > 0 ? { mode: "escalate", reasons } : { mode: "auto", reasons: [] };
}
