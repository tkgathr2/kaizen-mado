// ── 認証ミドルウェア（optional auth・段階リリース fail-safe） ──
// isAuthEnabled() が false の間は一切保護しない＝従来どおり全公開で動く（今と同じ挙動）。
// OAuth鍵(AUTH_GOOGLE_ID/SECRET + AUTH_SECRET)が揃った瞬間に認証がONになる。
//
// 【重要・optional auth】カイゼン窓口(/) は社内各システムから widget.js(iframe) で embed される
//   "公開・無認証"の入口。窓口(/)・/api/chat・/api/submit を強制ログイン保護すると全システムで
//   ウィジェットがログイン壁になり壊れる。よって認証ONでも、これらは強制保護しない（ログインは任意）。
//   起票者名は「ログインしたら自動で引き継ぐ・しなくても手入力で送れる」optional auth とする。
//   強制ログイン保護をかけるのは shouldProtectPath() が true を返す管理ページ（/board・/dashboard）だけ。
//
// 【WebView ブロック対策】
//   LINE / Slack 等の in-app WebView から保護ページへ来た場合、
//   /api/auth/signin（Google OAuth）を踏ませると disallowed_useragent になる。
//   これをサーバーサイドで検知し、/open-in-browser へリダイレクトする。
//   - 判定は User-Agent ヘッダで行う（クライアントサイドより確実）
//   - LINE の openExternalBrowser=1 パラメータ経由なら外部ブラウザ＝通常フロー
//   - /open-in-browser・/_next・/api・/widget.js・favicon は除外（無限ループ防止）
//
// matcher で除外（そもそも middleware を走らせない）：
//   /api/auth/*           … ログインフロー自体（保護すると無限ループ）
//   /api/process /api/learn … cron系（CRON_SECRETで別途保護済）
//   /api/execute /api/admin … cron系（CRON_SECRET/署名で別途保護済。改修パイプラインの内部API）
//   /api/health           … 死活監視（CRON_SECRETで別途保護済）
//   /api/line             … LINE webhook（x-line-signatureで別途保護済）
//   /_next/* favicon 等    … Next静的アセット
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { auth } from "@/auth";
import { isAuthEnabled, shouldProtectPath } from "@/lib/authz";
import { isWebView, hasOpenExternalBrowserParam } from "@/lib/webview";

// WebView からの保護ページアクセスを /open-in-browser へリダイレクトする。
// - 保護対象パス（/board・/dashboard）かつ WebView UA の場合のみ。
// - openExternalBrowser=1 付きは外部ブラウザなのでスルー。
// - /open-in-browser 自体は除外（無限ループ防止）。
function redirectWebViewIfNeeded(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;

  // /open-in-browser は絶対に除外（無限ループ防止）
  if (pathname.startsWith("/open-in-browser")) return null;

  // 保護パス以外は WebView でも問題なし（窓口は公開・未ログインで使える）
  if (!shouldProtectPath(pathname)) return null;

  // LINE の openExternalBrowser=1 経由は外部ブラウザ→通常フロー
  if (hasOpenExternalBrowserParam(req.nextUrl.search)) return null;

  const ua = req.headers.get("user-agent") ?? "";
  if (!isWebView(ua)) return null;

  // WebView 検知: /open-in-browser?from=<現在URL> へリダイレクト
  const redirectUrl = new URL("/open-in-browser", req.nextUrl.origin);
  redirectUrl.searchParams.set("from", req.nextUrl.href);
  return NextResponse.redirect(redirectUrl);
}

// 認証ON時のミドルウェア（auth ラッパ）。
// 管理ページ（/board・/dashboard）だけ未ログインをログインへ誘導し、それ以外は素通し（optional auth）。
const protectedMw = auth((req) => {
  // WebView 検知は最優先（Google OAuth に誘導する前にブロック）
  const webViewRedirect = redirectWebViewIfNeeded(req);
  if (webViewRedirect) return webViewRedirect;

  // 窓口(/)・/api/chat・/api/submit など公開導線はログインを強制しない（embed壁を作らない）。
  if (!shouldProtectPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

// 鍵が未投入なら auth ラッパに一切触れず素通し＝本番窓口を止めない fail-safe。
// （auth ラッパを呼ぶと鍵未設定でも UntrustedHost 等のノイズが出るため、無効時は完全に回避する）
export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  if (!isAuthEnabled()) return NextResponse.next();

  // 認証ONの場合でも WebView リダイレクトは先に実行する
  // （protectedMw 内でも呼ぶが、auth ラッパ起動前に確実に拾う）
  const webViewRedirect = redirectWebViewIfNeeded(req);
  if (webViewRedirect) return webViewRedirect;

  return (protectedMw as unknown as (
    req: NextRequest,
    ev: NextFetchEvent
  ) => ReturnType<typeof protectedMw>)(req, ev);
}

export const config = {
  // middleware を走らせる範囲。cron系・auth系・静的は除外（実際の保護判定は protectedMw 内の
  // shouldProtectPath で管理ページに限定する＝optional auth）。
  // widget.js / kaizen-kun.png は他システムのページから読まれる埋め込みウィジェット本体と
  // マスコット画像。認証ON時にリダイレクトされると全システムでアイコンが消えるため必ず除外する。
  matcher: [
    "/((?!api/auth|api/process|api/learn|api/execute|api/line|api/admin|api/health|widget.js|kaizen-kun.png|_next/static|_next/image|favicon.ico).*)",
  ],
};
