// ── Auth.js v5 (next-auth@beta) ルート設定 ──
// AUTH_SECRET / AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET は Auth.js v5 の規約名で自動参照される。
// コードに鍵は書かない。鍵が無い間は middleware が保護をかけないため、窓口は従来どおり全公開で動く。
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isEmailAllowed } from "@/lib/authz";

// 社長決定：セッション90日（3ヶ月は再認証不要）
const NINETY_DAYS = 60 * 60 * 24 * 90;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  // Vercel本番＋カスタムドメイン(kaizen.takagi.bz)で動かすため host を信頼する。
  // （Vercelは自動trustだが、カスタムドメイン運用の明示化として固定）
  trustHost: true,
  session: { strategy: "jwt", maxAge: NINETY_DAYS },
  jwt: { maxAge: NINETY_DAYS },
  callbacks: {
    async signIn({ profile }) {
      // 会社ドメイン制限（任意・env KAIZEN_ALLOWED_DOMAINS）。
      // 未設定なら全Googleアカウント許可（本人特定はする）。判定は純粋関数に委譲。
      return isEmailAllowed(profile?.email, process.env.KAIZEN_ALLOWED_DOMAINS);
    },
  },
});
