import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "カイゼン窓口｜高木産業グループ",
  description: "高木産業グループ カイゼンくん｜気づき・改善・困りごとを受け付ける窓口",
};

// アクセシビリティ：弱視・高齢の現場スタッフがピンチで拡大できるようにする。
// maximumScale:1 / userScalable:false は拡大を禁じてしまうため、最大5倍まで許可。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
