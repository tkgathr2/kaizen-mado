// public/widget.js（埋め込みウィジェット）の静的検証。
// jsdomを足さず node 環境のまま、「構文が正しい」「壊れやすい約束事が守られている」を機械チェックする。
// （実ブラウザの見た目はPR後に本番URLで目視確認する運用）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../../public/widget.js"), "utf-8");

describe("widget.js", () => {
  it("構文エラーなく関数として評価できる", () => {
    // 実行はしない（DOM不要）。構文チェックのみ。
    expect(() => new Function(src)).not.toThrow();
  });

  it("二重ロードガードがある（同じscriptを2回貼っても1個しか出ない）", () => {
    expect(src).toContain("__kaizenWidgetLoaded");
  });

  it("data-sys を読み、URLエンコードして窓口URLに渡す", () => {
    expect(src).toContain('getAttribute("data-sys")');
    expect(src).toContain("encodeURIComponent(sys)");
    expect(src).toContain("embed=1");
  });

  it("Shadow DOM を使いホストCSSと隔離する（:host{all:initial}）", () => {
    expect(src).toContain("attachShadow");
    expect(src).toContain(":host{all:initial}");
  });

  it("postMessage の close はオリジン検査つき", () => {
    expect(src).toContain("e.origin !== origin");
    expect(src).toContain("kaizen:close");
  });

  it("既定オリジンは kaizen.takagi.bz", () => {
    expect(src).toContain("https://kaizen.takagi.bz");
  });

  it("埋め込み元の window.kaizenUser を reporter として窓口へ引き継ぐ", () => {
    expect(src).toContain("window.kaizenUser");
    expect(src).toContain('"&reporter=" + encodeURIComponent');
  });

  it("マスコット画像（フクロウ博士）は窓口と同じオリジンから読む", () => {
    expect(src).toContain('origin + "/kaizen-kun.png"');
  });

  it("middleware がマスコット画像を認証除外している（埋め込み先でアイコンが消える事故防止）", () => {
    const mw = readFileSync(path.resolve(__dirname, "../../middleware.ts"), "utf-8");
    expect(mw).toContain("kaizen-kun.png");
    expect(mw).toContain("widget.js");
  });

  it("新しいタブで開く導線がある（iframe内で認証が通らない環境のフォールバック）", () => {
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
  });

  it("複数枚設置でも最初の1枚を採用する（currentScript無し環境は先頭scriptへフォールバック）", () => {
    // 古い環境のフォールバックは querySelectorAll の先頭(list[0])を使う＝最初の1枚。
    expect(src).toContain('document.currentScript');
    expect(src).toContain("list[0]");
  });

  it("data-sys 取得失敗時は警告ログを出して安全に窓口を開く", () => {
    expect(src).toContain("console.warn");
    expect(src).toContain("data-sys");
  });

  // ── 発見性の改善（pill・初回コールアウト・パルス・a11y）──

  it("休止状態はラベル付きpill（読めば用途が分かる文言が入っている）", () => {
    // ボタンに「ご意見・改善はこちら」の文言が出る＝何のボタンか一読で分かる。
    expect(src).toContain("ご意見・改善はこちら");
    // 狭い画面用の短いラベルも持つ（はみ出し対策）。
    expect(src).toContain('class="kz-label-short"');
  });

  it("狭い画面(<=480px)ではラベルを短縮し、はみ出さない", () => {
    expect(src).toContain("@media (max-width:480px)");
    // 短いラベルへ切り替えるCSSがある。
    expect(src).toContain(".kz-label-short{display:inline}");
    // pillに最大幅の上限があり画面外へ出ない。
    expect(src).toContain("max-width:calc(100vw - 40px)");
  });

  it("初回コールアウトは localStorage で一度きり（衝突しない固有キー）", () => {
    expect(src).toContain("kaizen-widget:first-visit-callout:v1");
    expect(src).toContain("localStorage");
    expect(src).toContain("shouldShowCallout");
    expect(src).toContain("markCalloutSeen");
  });

  it("初回コールアウトはホバー非依存で自動表示し、×と自動収納(8秒)で閉じる", () => {
    // 文面（送っていいと思える優しい説明）。
    expect(src).toContain("ここから気軽に送れます");
    // 1〜1.5秒後の自動表示と、8秒での自動収納。
    expect(src).toContain("1200");
    expect(src).toContain("8000");
    // ×ボタンで閉じられる。
    expect(src).toContain("この案内を閉じる");
  });

  it("パネルを開いたらコールアウトは即消える", () => {
    // setOpen(true) の経路で hideCallout を呼ぶ。
    expect(src).toContain("hideCallout()");
  });

  it("初回だけパルスし、最初の操作(クリック/フォーカス)で止まる", () => {
    expect(src).toContain("kz-pulse");
    expect(src).toContain("stopPulse");
    // フォーカスでも止める。
    expect(src).toContain('addEventListener("focus", stopPulse)');
  });

  it("prefers-reduced-motion を尊重してパルスを無効化できる", () => {
    expect(src).toContain("prefers-reduced-motion");
    expect(src).toContain("matchMedia");
  });

  it("aria-label とキーボード/フォーカス導線を維持する", () => {
    // ボタンには用途が伝わる aria-label。
    expect(src).toContain('btn.setAttribute("aria-label"');
    // フォーカスでもツールチップが出る（キーボード操作者にも説明が届く）。
    expect(src).toContain(".kz-btn:focus-visible+.kz-tip");
    // Escでパネルを閉じる導線は維持。
    expect(src).toContain('e.key === "Escape"');
  });
});
