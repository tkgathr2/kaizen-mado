// ── 対象システムのマスタ（改善チケットDBの select 選択肢と一致させる） ──
// slug（URLの ?sys= で使う短い識別子）→ 正式名（Notionの「対象システム」selectの値）

export const SYSTEMS: { slug: string; name: string }[] = [
  { slug: "rirekimeka", name: "履歴書メーカー" },
  { slug: "prorepo", name: "プロレポ" },
  { slug: "sterepo", name: "ステレポ" },
  { slug: "houko", name: "ほうこちゃん" },
  { slug: "mfc-invoice-upload", name: "mfc-invoice-upload" },
  { slug: "indeed", name: "Indeed応募通知" },
  { slug: "recruit", name: "Indeed応募通知" },  // alias（応募通知ボット＝tkgathr2/recruit。Indeed/ジモティーの応募通知）
  { slug: "ouboe-tsuchi", name: "Indeed応募通知" },  // alias（応募通知ボットの分かりやすいスラグ）
  { slug: "cast-meibo", name: "キャスト名簿くん" },
  { slug: "rakuraku", name: "らくらく契約くん" },
  { slug: "mitsumori", name: "見積もりシステム" },
  { slug: "seiko", name: "seiko" },
  { slug: "junkai", name: "巡回くん" },
  { slug: "kaizen", name: "カイゼンくん本体" },
  { slug: "aio-checker", name: "AIOダッシュボードくん" },
  { slug: "saiyo-kanri", name: "採用管理システム" },
  { slug: "mention-hisho", name: "メンション秘書くん" },
  { slug: "leadforge-ky", name: "爆裂リード獲得くん（交通誘導）" },
  { slug: "buppin", name: "かいたくん（物品購入）" },
  { slug: "mamoru", name: "まもるくん" },
  { slug: "knowhow", name: "ノウハウキング" },
  { slug: "daikou", name: "採用管理システム" },  // alias（saiyo-kanri の追加スラグ）
  { slug: "rakuraku-contract", name: "らくらく契約くん" },  // alias（rakuraku の追加スラグ）
  { slug: "schedule-relay", name: "スケジュール調整くん" },
  { slug: "mieruka", name: "ミエルカくん" },
  { slug: "iride", name: "入退社管理くん" },
  { slug: "daily-report", name: "簡単日報くん" },
  { slug: "tsunagee", name: "Tsunagee" },
  { slug: "brainos", name: "BrainOS" },
  { slug: "tsunagun", name: "つなぐん" },
  { slug: "smartkyuyo", name: "smartkyuyo（給与計算）" },
  { slug: "meeting-hub", name: "会議ハブ" },
  { slug: "other", name: "その他" },
];

// Notion「対象システム」selectで許可される正式名（これ以外は「その他」に丸める）
export const SYSTEM_NAMES = SYSTEMS.map((s) => s.name);

/**
 * ?sys= の値を正式なシステム名へ解決する。
 * - slug（prorepo 等）でも正式名（プロレポ 等）でも受ける。
 * - 大文字小文字・前後空白を吸収。
 * - 不明・未指定なら null（会話で特定する）。
 */
export function resolveSystem(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = decodeURIComponent(String(raw)).trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  // slug 一致
  const bySlug = SYSTEMS.find((s) => s.slug.toLowerCase() === lower);
  if (bySlug) return bySlug.name;
  // 正式名 一致
  const byName = SYSTEMS.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName.name;
  return null;
}

/** 起票直前に、Notion select で確実に通る値へ正規化（未知は「その他」） */
export function normalizeSystemForTicket(name: string | null | undefined): string {
  if (!name) return "その他";
  const hit = SYSTEM_NAMES.find((n) => n === name);
  return hit ?? "その他";
}
