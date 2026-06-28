// ── WebView判定ユーティリティ ──
// Slack / LINE / Instagram / Facebook 等のアプリ内ブラウザ（in-app WebView）を検知する。
// Google は 2021年以降、WebView 内での OAuth を disallowed_useragent として拒否する。
// 参考: https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html

/**
 * User-Agent 文字列が in-app WebView (Slack/LINE/Instagram 等) かどうかを返す。
 * WebView 内で Google OAuth を試みると "Access blocked: disallowed_useragent" になるため、
 * 外部ブラウザ（Safari / Chrome）への誘導が必要。
 *
 * @param ua  navigator.userAgent の文字列
 * @returns   true = WebView 内（OAuth 不可）、false = 通常ブラウザ
 */
export function isWebView(ua: string): boolean {
  return /FBAN|FBAV|Instagram|Twitter|Line\/|LinkedIn|Snapchat|MicroMessenger|wv\)|GSA\/|FB_IAB|FB4A|FBIOS|FBSS/i.test(
    ua
  );
}
