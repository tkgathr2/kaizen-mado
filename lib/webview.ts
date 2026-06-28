// ── WebView判定ユーティリティ ──
// Slack / LINE / Instagram / Facebook 等のアプリ内ブラウザ（in-app WebView）を検知する。
// Google は 2021年以降、WebView 内での OAuth を disallowed_useragent として拒否する。

/**
 * User-Agent 文字列が in-app WebView (Slack/LINE/Instagram 等) かどうかを返す。
 * WebView 内で Google OAuth を試みると "Access blocked: disallowed_useragent" になるため、
 * 外部ブラウザ（Safari / Chrome）への誘導が必要。
 *
 * カバー対象: Slack (iOS: "Slack/<ver>", Android: "(Slack)"), LINE, Instagram, Facebook,
 *             Twitter, LinkedIn, Snapchat, WeChat (MicroMessenger), GSA (Google Search App),
 *             汎用 Android WebView (wv), KAKAOTALK
 *
 * @param ua  navigator.userAgent の文字列
 * @returns   true = WebView 内（OAuth 不可）、false = 通常ブラウザ
 */
export function isWebView(ua: string): boolean {
  return /FBAN|FBAV|FB_IAB|FB4A|FBIOS|FBSS|Instagram|Twitter|Line\/|LinkedIn|Snapchat|MicroMessenger|KAKAOTALK|wv\)|GSA\/|Slack\/|\(Slack\)/i.test(
    ua
  );
}

/**
 * LINE / Slack のどちらの WebView かを判定する（UIの出し分け用）。
 * isWebView() が true のときだけ意味を持つ。
 */
export function detectWebViewApp(ua: string): "line" | "slack" | "other" {
  if (/Line\//i.test(ua)) return "line";
  if (/Slack\/|\(Slack\)/i.test(ua)) return "slack";
  return "other";
}

/**
 * URL に LINE の openExternalBrowser=1 パラメータが付いているかどうか。
 * LINE アプリは URL に ?openExternalBrowser=1 が付いていると Safari/Chrome で開く。
 * このパラメータ経由で来たリクエストは外部ブラウザなので WebView ブロックを外す。
 *
 * @param searchParams  URL のクエリ文字列（例: "?openExternalBrowser=1&foo=bar"）
 */
export function hasOpenExternalBrowserParam(searchParams: string): boolean {
  try {
    const params = new URLSearchParams(searchParams.startsWith("?") ? searchParams.slice(1) : searchParams);
    return params.get("openExternalBrowser") === "1";
  } catch {
    return false;
  }
}
