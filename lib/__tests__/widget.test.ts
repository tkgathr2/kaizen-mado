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
});
