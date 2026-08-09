// ── 起票者名の解決（純粋関数・テスト対象） ──
// カイゼン窓口の「誰からの声か」を決める優先順位を1か所に集約する。
//
// 優先順位：
//   1. reporterParam（widget.js が ?reporter= で渡す、埋め込み元システムのログイン済みユーザー名）
//      ＝embed の文脈が最も確実な本人情報なので最優先。
//   2. sessionName（このサイトで Google ログイン済みなら session.user.name）
//      ＝optional auth でログインしたら自動で名前を引き継ぐ。
//   3. sessionEmail（session.user.name が空のGoogleアカウント向けの救済。
//      サーバ側 /api/submit の解決順（name || email）と一致させる）
//
// 手入力による自称は不可（社長指示）。すべて空なら空文字（匿名＝呼び出し側で拒否する）。
// 前後空白は除去する。
export function resolveReporter(opts: {
  reporterParam?: string | null;
  sessionName?: string | null;
  sessionEmail?: string | null;
}): string {
  const reporterParam = (opts.reporterParam ?? "").trim();
  if (reporterParam) return reporterParam;

  const sessionName = (opts.sessionName ?? "").trim();
  if (sessionName) return sessionName;

  return (opts.sessionEmail ?? "").trim();
}

// 起票者名の無害化（サーバ側・信頼境界での最終防衛）。
// widget埋め込み経由の reporterParam は origin を偽装すれば任意の文字列になり得るため、
// Notion／LINEのGO伺い文面へそのまま流し込まない。改行・タブ・全角スペース等の空白を
// 半角スペース1つに畳み、長さを上限で切る（旧UIの手入力欄が持っていた maxLength=40 を踏襲）。
export function sanitizeReporter(raw: string, maxLength = 40): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
