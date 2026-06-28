"use client";

// ── アプリ内ブラウザ（WebView）で開いた場合の誘導ページ ──
// LINE / Slack 等の WebView からカイゼン窓口へアクセスすると、
// Google OAuth が "disallowed_useragent" エラーになる。
// middleware.ts がサーバーサイドでこのページへリダイレクトする。
//
// 方法①（推奨）：パスフレーズを入力してそのままログイン（WebViewのまま使える）。
// 方法②：Safari / Chrome で開く（Google OAuth が必要な場合）。

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { signIn } from "next-auth/react";
import { detectWebViewApp } from "@/lib/webview";

function OpenInBrowserContent() {
  const params = useSearchParams();
  // middleware が ?from=<元のURL> で渡す（無い場合はトップへ）
  const fromParam = params.get("from") ?? "/";

  // ── パスフレーズ認証 ──
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");

  async function handlePassphraseLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || submitting) return;
    setSubmitting(true);
    setAuthError("");
    try {
      const result = await signIn("credentials", {
        passphrase,
        redirect: false,
      });
      if (result?.error) {
        setAuthError("パスフレーズが正しくありません");
      } else {
        // 成功：元のページへ遷移（セッション取得後）
        window.location.href = fromParam;
      }
    } catch {
      setAuthError("ログインに失敗しました。もう一度お試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  // 元のURLに openExternalBrowser=1 を追加した LINE 専用リンク
  const [lineUrl, setLineUrl] = useState<string>("");
  // 元のURL（コピー用）
  const [copyUrl, setCopyUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  // どのアプリの WebView かを検知（UI出し分け）
  const [appType, setAppType] = useState<"line" | "slack" | "other">("other");

  useEffect(() => {
    const ua = navigator.userAgent;
    setAppType(detectWebViewApp(ua));

    // コピー・LINE用リンク生成
    try {
      const base = new URL(fromParam, window.location.origin);
      setCopyUrl(base.href);
      // LINE の外部ブラウザ強制パラメータ
      base.searchParams.set("openExternalBrowser", "1");
      setLineUrl(base.href);
    } catch {
      setCopyUrl(window.location.origin);
      setLineUrl(window.location.origin + "?openExternalBrowser=1");
    }
  }, [fromParam]);

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(copyUrl || window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // フォールバック：古い環境
      const ta = document.createElement("textarea");
      ta.value = copyUrl || window.location.origin;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="oib-wrap">
      <div className="oib-card">
        {/* アイコン */}
        <div className="oib-icon" aria-hidden="true">🔑</div>

        <h1 className="oib-title">
          パスフレーズでログイン
        </h1>

        <p className="oib-lead">
          このままログインできます。
          <br />
          パスフレーズを入力してください。
        </p>

        {/* 方法①：パスフレーズ認証（WebViewのままログイン・推奨） */}
        <div className="oib-section">
          <p className="oib-section-title">方法①　パスフレーズでこのままログイン（推奨）</p>
          <form onSubmit={handlePassphraseLogin} className="oib-pass-form">
            <input
              type="password"
              className="oib-pass-input"
              placeholder="パスフレーズを入力"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="current-password"
              disabled={submitting}
            />
            <button
              type="submit"
              className="oib-pass-btn"
              disabled={submitting || !passphrase}
            >
              {submitting ? "…" : "ログイン"}
            </button>
          </form>
          {authError && (
            <p className="oib-auth-error" role="alert">{authError}</p>
          )}
        </div>

        {/* 区切り */}
        <div className="oib-divider">
          <span>ログインできない場合</span>
        </div>

        {/* LINE 専用：openExternalBrowser=1 リンク */}
        {appType === "line" && lineUrl && (
          <div className="oib-section">
            <p className="oib-section-title">方法②　Safariで開く（LINE専用）</p>
            <a
              href={lineUrl}
              className="oib-primary-btn"
              target="_blank"
              rel="noopener noreferrer"
            >
              Safariで開く
            </a>
            <p className="oib-note">
              タップするとSafariでこのページが開き、Googleログインできます
            </p>
          </div>
        )}

        {/* Slack 専用：右上メニューの案内 */}
        {appType === "slack" && (
          <div className="oib-section">
            <p className="oib-section-title">方法②　Slackの右上メニューから開く</p>
            <div className="oib-steps">
              <div className="oib-step">
                <span className="oib-step-num">1</span>
                <span>右上の <strong>…</strong>（メニュー）をタップ</span>
              </div>
              <div className="oib-step">
                <span className="oib-step-num">2</span>
                <span><strong>デフォルトのブラウザで開く</strong> を選択</span>
              </div>
            </div>
          </div>
        )}

        {/* 共通：URLコピー */}
        <div className="oib-section">
          <p className="oib-section-title">
            {appType === "line" ? "方法③　URLをコピーしてSafariに貼る" : "方法②　URLをコピーして外部ブラウザで開く"}
          </p>
          <div className="oib-url-row">
            <span className="oib-url-text">{copyUrl || "https://kaizen.takagi.bz/"}</span>
            <button
              type="button"
              className="oib-copy-btn"
              onClick={copyToClipboard}
            >
              {copied ? "✓ コピー済" : "コピー"}
            </button>
          </div>
          <p className="oib-note">
            コピーしたURLをSafari／Chromeのアドレスバーに貼り付けて開いてください
          </p>
        </div>
      </div>

      <style>{`
        .oib-wrap {
          min-height: 100dvh;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 24px 16px 40px;
          background: var(--bg, #faf9f5);
        }
        .oib-card {
          width: 100%;
          max-width: 420px;
          background: #fff;
          border: 1px solid var(--line, #e7e3d9);
          border-radius: 20px;
          padding: 32px 24px;
          box-shadow: 0 1px 2px rgba(60,50,35,0.04), 0 8px 24px rgba(60,50,35,0.06);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0;
          text-align: center;
        }
        .oib-icon {
          font-size: 48px;
          margin-bottom: 12px;
          line-height: 1;
        }
        .oib-title {
          font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif;
          font-size: 20px;
          font-weight: 600;
          color: var(--ink, #2b2924);
          margin: 0 0 16px;
          line-height: 1.4;
        }
        .oib-lead {
          font-size: 14.5px;
          color: var(--ink, #2b2924);
          line-height: 1.7;
          margin: 0 0 24px;
        }
        .oib-section {
          width: 100%;
          background: #faf9f5;
          border: 1px solid var(--line, #e7e3d9);
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 12px;
          text-align: left;
        }
        .oib-section-title {
          font-size: 12.5px;
          font-weight: 700;
          color: var(--muted, #83807a);
          margin: 0 0 10px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .oib-primary-btn {
          display: block;
          width: 100%;
          padding: 14px;
          background: var(--brand, #d97757);
          color: #fff;
          font-size: 16px;
          font-weight: 700;
          text-align: center;
          border-radius: 12px;
          text-decoration: none;
          margin-bottom: 8px;
          transition: background 0.15s;
        }
        .oib-primary-btn:hover {
          background: var(--brand-hover, #c45f3f);
        }
        .oib-steps {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .oib-step {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          font-size: 14px;
          color: var(--ink, #2b2924);
          line-height: 1.5;
        }
        .oib-step-num {
          flex: none;
          width: 22px;
          height: 22px;
          background: var(--brand, #d97757);
          color: #fff;
          border-radius: 50%;
          font-size: 12px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 1px;
        }
        .oib-url-row {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #fff;
          border: 1px solid var(--line, #e7e3d9);
          border-radius: 8px;
          padding: 8px 12px;
          margin-bottom: 8px;
        }
        .oib-url-text {
          flex: 1;
          font-size: 12px;
          color: var(--muted, #83807a);
          word-break: break-all;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .oib-copy-btn {
          flex: none;
          padding: 6px 14px;
          background: var(--brand, #d97757);
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
          white-space: nowrap;
        }
        .oib-copy-btn:hover {
          background: var(--brand-hover, #c45f3f);
        }
        .oib-note {
          font-size: 12px;
          color: var(--muted, #83807a);
          margin: 0;
          line-height: 1.6;
        }
        .oib-pass-form {
          display: flex;
          gap: 8px;
          margin-bottom: 8px;
        }
        .oib-pass-input {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid var(--line, #e7e3d9);
          border-radius: 8px;
          font-size: 15px;
          background: #fff;
          color: var(--ink, #2b2924);
          outline: none;
        }
        .oib-pass-input:focus {
          border-color: var(--brand, #d97757);
          box-shadow: 0 0 0 2px rgba(217,119,87,0.15);
        }
        .oib-pass-btn {
          flex: none;
          padding: 10px 18px;
          background: var(--brand, #d97757);
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.15s;
          white-space: nowrap;
        }
        .oib-pass-btn:hover:not(:disabled) {
          background: var(--brand-hover, #c45f3f);
        }
        .oib-pass-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .oib-auth-error {
          font-size: 13px;
          color: #c0392b;
          margin: 0;
          padding: 6px 0 0;
        }
        .oib-divider {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 4px 0 8px;
          color: var(--muted, #83807a);
          font-size: 12px;
        }
        .oib-divider::before,
        .oib-divider::after {
          content: "";
          flex: 1;
          height: 1px;
          background: var(--line, #e7e3d9);
        }
      `}</style>
    </div>
  );
}

export default function OpenInBrowserPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span>読み込み中...</span>
      </div>
    }>
      <OpenInBrowserContent />
    </Suspense>
  );
}
