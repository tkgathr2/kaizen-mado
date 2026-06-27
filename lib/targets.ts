// ── 対象システム → GitHubリポ等のマッピング（実行オーケストレーターが使う） ──
// 「対象システムを実際に直す」ためのメタ情報。autoEligible は全システム true
// （社長指示 2026-06-27「全部ONにして／GO＝全自動」）。GOは社長の承認サインなので、
// GO後は対象・機微を問わず自動で最後まで直して反映する。GO後に止まる唯一の条件は
// repo:null（PR先が無く物理的に直せない）。提案(GO伺い)フェーズでは preGate が
// 機微・新機能を見て社長へGO伺いを出す挙動を維持する（execute側の再判定停止だけを外した）。
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
  /** 自動実行を許可するか（現在は全システム true＝GO後は自動で直す。GO後の停止は repo:null のみ） */
  autoEligible: boolean;
}

// 共通の禁止パス（秘密情報・認証・課金・マイグレーション・PII）。
// ワークフロー側ゲートは「概念マッチ（部分一致＋複数形＋拡張子無視）」で判定するため、
// ここは概念キーワードを並べれば members.ts / app/members/ / payments / invoices なども捕捉される。
// ※ ゲートには target に依らず常に守る ALWAYS_FORBIDDEN（authz/cronAuth/gate/targets/.github/
//    prisma/schema 等）が別途あるが、ここでも明示しておき「データ＝forbiddenPaths」だけ見ても
//    意図が分かるようにする（多層防御）。
const COMMON_FORBIDDEN = [
  // 秘密情報・認証・セッション
  ".env",
  "secrets",
  "auth",
  "authz",
  "credential",
  "token",
  "middleware",
  // DBスキーマ・マイグレーション
  "prisma",
  "schema",
  ".sql",
  "migration",
  "migrations",
  // 課金（複数形はゲートが補完するが明示しておく）
  "billing",
  "payment",
  "invoice",
  // PII（個人情報の気配）
  "members",
  "roster",
  "meibo",
  "cast",
  "pii",
  "personal",
];

// PII（個人情報）を恒常的に保有する対象は、共通に加えてより厳しい禁止語を足す。
// 例：キャスト名簿くん（cast-meibo）= 氏名・連絡先等を扱うため、より広く自動改修を止める。
const PII_HEAVY_FORBIDDEN = [
  ...COMMON_FORBIDDEN,
  "user",
  "users",
  "profile",
  "contact",
  "phone",
  "email",
  "address",
  "name",
  "csv",
  "export",
  "import",
];

// repo は確証のあるものだけ記載。未確定は null（=自動不可＝PR先が無いため物理的に直せない）。
// autoEligible は全システム true（社長指示 2026-06-27「全部ONにして」）。
// GOは社長の承認サインなので、GO後は対象・機微を問わず自動で最後まで直して反映する
// （execute側で再判定して止めるのをやめた）。止まるのは repo:null（リポ未設定）のときだけ。
// 提案(GO伺い)フェーズでは preGate が機微・新機能を見て社長にGO伺いを出す挙動は維持。
export const TARGETS: TargetMeta[] = [
  { system: "プロレポ", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // ステレポ（SNS運用・分析）。TSバックエンド＝build:tsc / test:vitest / typecheck:tsc。
  { system: "ステレポ", repo: "tkgathr2/sterepo", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "ほうこちゃん", repo: "tkgathr2/security-report-system", healthUrl: "https://houko-control-production.up.railway.app", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "mfc-invoice-upload", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "Indeed応募通知", repo: "tkgathr2/recruit", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // キャスト名簿くん＝氏名・連絡先等のPIIを恒常保有＝より厳しい PII_HEAVY_FORBIDDEN。
  { system: "キャスト名簿くん", repo: "tkgathr2/cast-meibo", healthUrl: null, forbiddenPaths: PII_HEAVY_FORBIDDEN, autoEligible: true },
  { system: "らくらく契約くん", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // 巡回くん＝Indeed公開ページ巡回ツール（テレアポリスト自動収集・Node.js/Railway）。https://junkai.takagi.bz
  { system: "巡回くん", repo: "tkgathr2/junkai-kun", healthUrl: "https://junkai.takagi.bz", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // 見積もりシステム＝見積もり自動化システム（mitsumori-app・自前Next.jsアプリ）。
  // 2026-06-19 フェーズ1本番化（Vercel）。会社×区分×人数×日数で金額自動計算。
  { system: "見積もりシステム", repo: "tkgathr2/mitsumori-app", healthUrl: "https://mitsumori-app-pied.vercel.app", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // 初回ライブ試走＝カイゼンくん自身（自己改修・最低リスク）。PRレビュー型なのでPRを作るだけ。
  { system: "カイゼンくん本体", repo: "tkgathr2/kaizen-mado", healthUrl: "https://kaizen.takagi.bz", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "AIOダッシュボードくん", repo: "tkgathr2/aio-checker", healthUrl: "https://aio.takagi.bz/api/dashboard", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "採用管理システム", repo: "tkgathr2/daikou", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // メンション秘書くん＝Slack mention検知→早乙女返信案→LINE社長OK→Bot送信。
  { system: "メンション秘書くん", repo: "tkgathr2/mention-hisho", healthUrl: "https://mention.takagi.bz/api/health", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "爆裂リード獲得くん（交通誘導）", repo: "tkgathr2/leadforge", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // かいたくん（物品購入）＝物品購入管理Webアプリ（Next.js+Railway）。https://kaitakun.takagi.bz
  { system: "かいたくん（物品購入）", repo: "tkgathr2/buppin", healthUrl: "https://kaitakun.takagi.bz", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // まもるくん＝SNS投稿リスクチェックWeb（Next.js+Railway）。警備・人材派遣会社向け。
  // 2026-06-27 GitHub/Railway本番化完了。
  { system: "まもるくん", repo: "tkgathr2/mamoru-web", healthUrl: "https://mamoru-web-production.up.railway.app", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // ノウハウキング＝社内ナレッジ基盤（Python・Railway）。
  // autoEligible=true だが Python製のため npm検証が通らず自動マージはされない＝AIがPRを作って止まる（人がレビュー）。
  { system: "ノウハウキング", repo: "tkgathr2/knowhow", healthUrl: "https://knowhow.up.railway.app", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },

  // スケジュール調整くん
  { system: "スケジュール調整くん", repo: "tkgathr2/schedule-relay", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // ミエルカくん（ミエルカWebシステム・Express+Railway）
  { system: "ミエルカくん", repo: "tkgathr2/mieruka-web", healthUrl: "https://mieruka-app-production.up.railway.app", forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // 入退社管理くん（Next.js+Railway）
  { system: "入退社管理くん", repo: "tkgathr2/takagi_iride", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // 簡単日報くん（GAS製・リポなし＝repo:null＝PR先が無いので物理的に直せない）
  { system: "簡単日報くん", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  // Tsunagee（外国人材向け求人検索・Next.js）
  { system: "Tsunagee", repo: "tkgathr2/tsunagee", healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
  { system: "その他", repo: null, healthUrl: null, forbiddenPaths: COMMON_FORBIDDEN, autoEligible: true },
];

/** システム名から対象メタを引く（未知なら null）。 */
export function findTarget(system: string | null | undefined): TargetMeta | null {
  if (!system) return null;
  return TARGETS.find((t) => t.system === system) ?? null;
}