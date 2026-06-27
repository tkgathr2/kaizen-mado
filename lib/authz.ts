// ── 認証の有効化判定・許可ドメイン判定（純粋関数・テスト対象） ──
// 段階リリース(fail-safe)の心臓部。OAuth鍵が揃っている時だけ認証をONにする。
// ここを純粋関数に切り出すことで、middleware の挙動を決定的にテストできる。

/**
 * 認証が有効かどうか。
 * AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / AUTH_SECRET がすべて非空なら true。
 * 1つでも欠ければ false（＝middlewareは何も保護せず、従来どおり全公開で動く）。
 * 鍵が入った瞬間に認証がONになる。
 */
export function isAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    nonEmpty(env.AUTH_GOOGLE_ID) &&
    nonEmpty(env.AUTH_GOOGLE_SECRET) &&
    nonEmpty(env.AUTH_SECRET)
  );
}

/**
 * email がログイン許可ドメインに該当するか。
 * domainsCsv が空/未設定なら、email があるかぎり true（全Googleアカウント許可・本人特定はする）。
 * 指定時は email の "@" 以降のドメインがいずれかに一致すれば true。
 * email 無しは常に false。大文字小文字無視・前後空白除去で判定する。
 */
export function isEmailAllowed(
  email: string | null | undefined,
  domainsCsv: string | null | undefined
): boolean {
  const normalizedEmail = (email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const at = normalizedEmail.lastIndexOf("@");
  if (at < 0 || at === normalizedEmail.length - 1) return false;
  const emailDomain = normalizedEmail.slice(at + 1);

  const allowed = (domainsCsv ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  // 許可ドメイン未設定＝全Googleアカウント許可（email があるので true）
  if (allowed.length === 0) return true;

  return allowed.includes(emailDomain);
}

/**
 * 公開POST（誰でも叩ける起票API）のCSRF/オリジン安全化用の純粋判定。
 * 受信リクエストの Origin ヘッダ値が、許可オリジンに該当するかを返す。
 *
 * fail-safe（後方互換）：originsCsv が空/未設定なら常に true
 *   ＝従来どおり全許可。社長が掲示中の窓口を止めない。
 * 設定時の挙動：
 *   - Origin ヘッダが無い（null/空）リクエストは true で通す
 *     （同一オリジンの fetch や一部クライアントは Origin を送らないため、
 *      ここで弾くと正規の窓口まで壊す。CSRF の主目的は「他サイトからの
 *      クロスオリジン強制送信」を弾くことなので、明示された別オリジンだけ拒否する）。
 *   - Origin が許可リストのいずれかに一致すれば true、不一致なら false。
 * 比較は前後空白を除去し、末尾スラッシュを無視、大文字小文字を無視して行う。
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  originsCsv: string | null | undefined
): boolean {
  const allowed = (originsCsv ?? "")
    .split(",")
    .map((o) => normalizeOrigin(o))
    .filter((o) => o.length > 0);

  // 許可オリジン未設定＝全許可（後方互換・窓口を止めない）
  if (allowed.length === 0) return true;

  // Origin ヘッダ無しは通す（同一オリジン fetch 等は Origin を送らない）
  const normalizedOrigin = normalizeOrigin(origin ?? "");
  if (!normalizedOrigin) return true;

  return allowed.includes(normalizedOrigin);
}

/**
 * 認証ON時に「強制ログイン保護」をかけるパスかどうか（純粋関数・テスト対象）。
 *
 * 設計：カイゼン窓口(/) は社内各システムから widget.js(iframe) で embed される“公開・無認証”の入口。
 *   ここを保護するとログイン壁になり、全システムでウィジェットが壊れる。
 *   起票導線（/・/api/chat・/api/submit）は optional auth（ログインは任意・強制しない）にし、
 *   保護は「中の人だけが見る管理ページ（/board・/dashboard）」に最小限で限定する。
 *
 * 保護対象（true）：/board /dashboard とその配下のみ。
 * 公開（false）：窓口(/)・/api/*（chat/submit 含む）・静的アセット・その他すべて。
 * 比較は前後空白除去・大文字小文字無視。末尾スラッシュは無視。
 */
const PROTECTED_PREFIXES = ["/board", "/dashboard"] as const;

export function shouldProtectPath(pathname: string | null | undefined): boolean {
  const p = (pathname ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (!p) return false;
  return PROTECTED_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/")
  );
}

function normalizeOrigin(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
