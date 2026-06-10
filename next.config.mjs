/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        // 埋め込みウィジェット本体。各システムのページから <script src> で読まれる。
        // 5分キャッシュ＋SWRで「配布後すぐ直せる」と「埋め込み先を重くしない」を両立。
        source: "/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=600" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      // 窓口ページ自体は X-Frame-Options / frame-ancestors を意図的に設定しない：
      // プロレポ等のドメインが多様（vercel.app / railway.app / takagi.bz）で列挙保守が割に合わず、
      // 窓口は閲覧・起票のみでクリックジャッキングの実害が薄いため（社内向けフィードバック窓口）。
    ];
  },
};

export default nextConfig;
