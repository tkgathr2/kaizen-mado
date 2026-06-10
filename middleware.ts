// ── 認証ミドルウェア（段階リリース fail-safe） ──
// isAuthEnabled() が false の間は一切保護しない＝従来どおり全公開で動く（今と同じ挙動）。
// OAuth鍵(AUTH_GOOGLE_ID/SECRET + AUTH_SECRET)が揃った瞬間に認証がONになる。
//
// matcher で除外：
//   /api/auth/*           … ログインフロー自体（保護すると無限ループ）
//   /api/process /api/learn … cron系（CRON_SECRETで別途保護済。ログイン要求すると通らなくなる）
//   /_next/* favicon 等    … Next静的アセット
// 保護対象：ページ(/) ・ /api/submit ・ /api/chat
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { auth } from "@/auth";
import { isAuthEnabled } from "@/lib/authz";

// 認証ON時のミドルウェア（auth ラッパ）。未ログインはログインへ誘導。
const protectedMw = auth((req) => {
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
  return (protectedMw as unknown as (
    req: NextRequest,
    ev: NextFetchEvent
  ) => ReturnType<typeof protectedMw>)(req, ev);
}

export const config = {
  // 保護対象＝ページとユーザー操作API。cron系・auth系・静的は除外。
  // widget.js / kaizen-kun.png は他システムのページから読まれる埋め込みウィジェット本体と
  // マスコット画像。認証ON時にリダイレクトされると全システムでアイコンが消えるため必ず除外する。
  matcher: [
    "/((?!api/auth|api/process|api/learn|widget.js|kaizen-kun.png|_next/static|_next/image|favicon.ico).*)",
  ],
};
