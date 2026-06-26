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
// 日本語キーワードは部分一致（CJKに単語境界がないため includes でよい）。
const SENSITIVE_KEYWORDS_JA = [
  // 金額・課金
  "金額", "支払", "支払い", "請求", "入金", "振込", "決済", "課金", "料金", "返金", "口座", "クレジット",
  // 個人情報
  "個人情報", "氏名", "名前", "電話", "住所", "メールアドレス", "マイナンバー", "生年月日",
  // 認証・秘密
  "パスワード", "認証", "ログイン", "トークン", "秘密鍵", "apiキー", "クレデンシャル",
  // 破壊的操作・DB
  "削除", "全消し", "消去", "解約", "退会", "本番db", "マイグレーション", "スキーマ変更",
];

// 英語キーワードは単語境界(\b)で判定する。部分一致だと "auth"→author、"price"→enterprise、
// "charge"→supercharge のような無関係語を誤検知し、過剰にescalateしていた（誤爆）。
// 単語境界化は無関係語のヒットを減らすだけで、本物の機微語は依然ヒットする＝安全側を維持。
// 複数語（"api key"）は語間の空白を許容して 1 つの正規表現にする。
const SENSITIVE_KEYWORDS_EN = [
  // 金額・課金
  "payment", "invoice", "billing", "refund", "charge", "price",
  // 個人情報
  "pii", "email", "phone", "personal",
  // 認証・秘密
  "password", "passwd", "secret", "token", "credential", "apikey", "api key", "auth", "oauth",
  // 破壊的操作・DB
  "delete", "drop", "truncate", "migrate", "migration", "destroy", "wipe",
];

// 英語キーワードを単語境界つき正規表現にコンパイル（小文字化済みテキストに対して判定）。
const SENSITIVE_EN_REGEXES = SENSITIVE_KEYWORDS_EN.map((kw) => {
  // 正規表現メタ文字をエスケープし、語間の空白は \s+ で許容（"api key" → /api\s+key/）。
  const pattern = kw
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  // 末尾は屈折形（複数形・過去/進行形）を許容：payment→payments, charge→charged,
  // refund→refunded, delete→deleted, invoice→invoices 等も機微語として捕捉する。
  // 先頭の \b は維持するので author(auth)・enterprise(price)・supercharge(charge) は誤検知しない。
  return { kw, re: new RegExp(`\\b${pattern}(?:s|es|d|ed|ing)?\\b`, "i") };
});

/** 真田自走（オートパイロット）が有効か。
 * ON のとき、preGate=auto の安全な改善は社長にGO伺いせず自動で着手→PR→マージまで進める。
 * 社長を呼ぶのは preGate=escalate（金額/個人情報/認証/破壊/新機能/自動未許可システム）だけ。
 * ＝「社長と真田の関係」と同じ：安全は任せて事後報告、危険だけ確認。
 *
 * 既定ON（社長指示2026-06-13「いちいち聞くの面倒・真田との関係と同じに」）。
 * 影響範囲は autoEligible なシステム（現状カイゼンくん本体のみ）に限定され、さらに
 * GO推奨＋ジョブ内実検証(tsc/test/build)緑のときだけ自動マージするため安全。
 * 全停止したいときだけ env KAIZEN_AUTOPILOT=off|0|false を設定（キルスイッチ）。 */
export function autopilotEnabled(): boolean {
  const v = (process.env.KAIZEN_AUTOPILOT || "").toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return true;
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
  // detail が undefined のとき "undefined" という文字列が混ざらないよう ?? "" で握りつぶす。
  const hay = `${ticket.title ?? ""}\n${ticket.detail ?? ""}`.toLowerCase();
  // 日本語＝部分一致、英語＝単語境界。どちらか1つでも当たれば機微としてescalate（安全側）。
  const hitJa = SENSITIVE_KEYWORDS_JA.find((k) => hay.includes(k.toLowerCase()));
  const hitEn = SENSITIVE_EN_REGEXES.find(({ re }) => re.test(hay))?.kw;
  const hit = hitJa || hitEn;
  if (hit) {
    reasons.push(`機微キーワード「${hit}」を含む（金額/個人情報/破壊的操作の可能性）`);
  }

  return reasons.length > 0 ? { mode: "escalate", reasons } : { mode: "auto", reasons: [] };
}
