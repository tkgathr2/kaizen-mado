// ── 対象システム → GitHubリポ等のマッピング（実行オーケストレーターが使う） ──
// 「対象システムを実際に直す」ためのメタ情報。安全のため autoEligible は既定で false。
// = どのシステムも、最初は自動実行せず「社長案件（②本番投入GO）」へエスカレする。
// 真田/社長が「このシステムは自動でよい」と確認し、対象リポに実行ワークフローを置いてから
// autoEligible:true に切り替える（段階リリース）。repoが未確定なものも自動不可。
//
// forbiddenPaths：このパスに触れる変更は本番前に必ず人の確認（ゲートで弾く）。
// healthUrl：本番反映後に 200 を確認する先。
export interface TargetMeta {
  /** Notion「対象システム」selectの正式名 */
  system: string;
  /** owner/repo（未確定は null＝自動不可） */
  repo: string | null;
  /** 本番ヘルス確認URL（任意） */
  healthUrl: string | null;
  /** このパスを触る変更は自動マージ禁止＝人の確認へ */
  forbiddenPaths: string[];
  /** 自動実行を許可するか（既定false＝社長案件へエスカレ） */
  autoEligible: boolean;
}

// 共通の禁止パス（秘密情報・認証・課金・マイグレーション・PII）。
const COMMON_FORBIDDEN = [
  ".env",
  "secrets",
  "auth",
  "middleware",
  "migration",
  "migrations",
  "billing",
  "payment",
  "invoice",
  "members.ts",
  "meibo",
];

// repo は確証のあるものだけ記載。未確定は null（=自動不可）。
// autoEligible は全て false スタート（社長/真田が1件ずつ有効化）。
export const TARGETS: TargetMeta[] = [
  { system: "プロレポ", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  // ステレポ（SNS運用・分析）を自走対象に段階解放（2026-06-13）。TSバックエンド＝
  // build:tsc / test:vitest / typecheck:tsc。verifyはリポ自身のscriptsで走る。
  { system: "ステレポ", repo: "tkgathr2/sterepo", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "ほうこちゃん", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  { system: "mfc-invoice-upload", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  { system: "Indeed応募通知", repo: "tkgathr2/recruit", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  { system: "キャスト名簿くん", repo: "tkgathr2/cast-meibo", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  { system: "らくらく契約くん", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  // 見積もりシステム＝MFクラウド請求書(HO-114)。外部SaaSで自前リポなし＝repo:null。
  // autoEligible:false のため、西村さんの改善要望は自動改修せず「社長案件＝真田へエスカレ」へ流す。
  { system: "見積もりシステム", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  // 初回ライブ試走＝カイゼンくん自身（自己改修・最低リスク）。PRレビュー型なのでPRを作るだけ。
  { system: "カイゼンくん本体", repo: "tkgathr2/kaizen-mado", healthUrl: "https://kaizen.takagi.bz", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "AIOダッシュボードくん", repo: "tkgathr2/aio-checker", healthUrl: "https://aio.takagi.bz/api/dashboard", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
  { system: "その他", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: false },
];

/** システム名から対象メタを引く（未知なら null）。 */
export function findTarget(system: string | null | undefined): TargetMeta | null {
  if (!system) return null;
  return TARGETS.find((t) => t.system === system) ?? null;
}
