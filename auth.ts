// ── Auth.js v5 (next-auth@beta) ルート設定 ──
// AUTH_SECRET / AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET は Auth.js v5 の規約名で自動参照される。
// コードに鍵は書かない。鍵が無い間は middleware が保護をかけないため、窓口は従来どおり全公開で動く。
//
// CredentialsProvider（パスフレーズ認証）：
//   WebView（LINE/Slack）では Google OAuth が disallowed_useragent でブロックされる。
//   env ADMIN_PASSPHRASE を設定すると、パスフレーズ入力でログインできる代替手段が有効になる。
//   env ADMIN_EMAIL があれば管理者メールを設定（省略時は admin@kaizen.local）。
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { isEmailAllowed } from "@/lib/authz";

// 社長決定：セッション90日（3ヶ月は再認証不要）
const NINETY_DAYS = 60 * 60 * 24 * 90;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google,
    Credentials({
      credentials: {
        passphrase: { label: "パスフレーズ", type: "password" },
      },
      authorize(credentials) {
        const pass = process.env.ADMIN_PASSPHRASE;
        // ADMIN_PASSPHRASE 未設定 or 不一致なら null（拒否）
        if (!pass || credentials.passphrase !== pass) return null;
        // 管理者ユーザーを返す（email は env ADMIN_EMAIL があればそれを使う）
        return {
          id: "passphrase-admin",
          name: "管理者",
          email: process.env.ADMIN_EMAIL ?? "admin@kaizen.local",
        };
      },
    }),
  ],
  // Vercel本番＋カスタムドメイン(kaizen.takagi.bz)で動かすため host を信頼する。
  // （Vercelは自動trustだが、カスタムドメイン運用の明示化として固定）
  trustHost: true,
  session: { strategy: "jwt", maxAge: NINETY_DAYS },
  jwt: { maxAge: NINETY_DAYS },
  callbacks: {
    async signIn({ profile, account }) {
      // CredentialsProvider（パスフレーズ）は常に許可（authorize() が null を返せば拒否済み）
      if (account?.provider === "credentials") return true;
      // Google は従来通りドメインチェック
      // 会社ドメイン制限（任意・env KAIZEN_ALLOWED_DOMAINS）。
      // 未設定なら全Googleアカウント許可（本人特定はする）。判定は純粋関数に委譲。
      return isEmailAllowed(profile?.email, process.env.KAIZEN_ALLOWED_DOMAINS);
    },
  },
});
