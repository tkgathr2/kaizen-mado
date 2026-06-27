// ── 起票者名の解決（純粋関数・テスト対象） ──
// カイゼン窓口の「誰からの声か」を決める優先順位を1か所に集約する。
//
// 優先順位：
//   1. reporterParam（widget.js が ?reporter= で渡す、埋め込み元システムのログイン済みユーザー名）
//      ＝embed の文脈が最も確実な本人情報なので最優先。
//   2. sessionName（このサイトで Google ログイン済みなら session.user.name）
//      ＝optional auth でログインしたら自動で名前を引き継ぐ。
//   3. manualInput（「お名前（任意）」手入力欄）
//      ＝未ログインでも従来どおり送れるフォールバック。
//
// すべて空なら空文字（匿名）。前後空白は除去する。
export function resolveReporter(opts: {
  reporterParam?: string | null;
  sessionName?: string | null;
  manualInput?: string | null;
}): string {
  const reporterParam = (opts.reporterParam ?? "").trim();
  if (reporterParam) return reporterParam;

  const sessionName = (opts.sessionName ?? "").trim();
  if (sessionName) return sessionName;

  return (opts.manualInput ?? "").trim();
}
