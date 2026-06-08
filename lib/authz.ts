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

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
