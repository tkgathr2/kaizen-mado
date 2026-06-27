/**
 * MarkdownMessage のレンダリング・XSS安全テスト
 *
 * react-dom/server の renderToStaticMarkup を使って
 * ノード環境（jsdom 不要）で HTML 文字列を検証する。
 * JSX を使わず React.createElement で呼び出すことで .ts のまま動作する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vitest は .tsx を transform できるが TS の moduleResolution は .tsx を拡張子として要求しない
import MarkdownMessage from "../MarkdownMessage.tsx";

function render(content: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MarkdownMessage as React.ComponentType<{ content: string }>,
      { content }
    )
  );
}

describe("MarkdownMessage", () => {
  it("太字を <strong> で描画する", () => {
    const html = render("**太字テスト**");
    expect(html).toContain("<strong>");
    expect(html).toContain("太字テスト");
  });

  it("箇条書きを <ul><li> で描画する", () => {
    const html = render("- 項目A\n- 項目B");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("項目A");
    expect(html).toContain("項目B");
  });

  it("番号付きリストを <ol><li> で描画する", () => {
    const html = render("1. 最初\n2. 次");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>");
    expect(html).toContain("最初");
  });

  it("表（GFM）を <table> で描画する", () => {
    const md = `| 名前 | 値 |\n|---|---|\n| foo | bar |`;
    const html = render(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("foo");
    expect(html).toContain("bar");
  });

  it("リンクに target=_blank と rel=noopener noreferrer nofollow を付ける", () => {
    const html = render("[Click](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
    expect(html).toContain("nofollow");
  });

  it("コードブロックを <code> で描画する", () => {
    const html = render("```\nconsole.log('hi')\n```");
    expect(html).toContain("<code>");
  });

  // ---- XSS 安全テスト ----

  it("<script> タグが無害化される（そのまま出力されない）", () => {
    const html = render("<script>alert('xss')</script>");
    // react-markdown は rehype-raw なしだと生 HTML を描画しない
    expect(html).not.toContain("<script>");
  });

  it("onerror 属性付き <img> が実行可能な HTML 要素として出力されない", () => {
    const html = render('<img src="x" onerror="alert(1)">');
    // rehype-raw なしなので生HTML はエスケープされ、実タグ <img ... > は出力されない
    // HTML エスケープ済み（&lt;img ...&gt;）になっているので実行不能 = XSS安全
    expect(html).not.toContain("<img ");
  });

  it("javascript: スキームのリンクが href に残らない", () => {
    // react-markdown はデフォルトで javascript: を除去する
    const html = render("[evil](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("onclick 属性付き <button> が実行可能な HTML 要素として出力されない", () => {
    const html = render('<button onclick="alert(1)">click</button>');
    // rehype-raw なしなので <button> タグはエスケープされ実行不能 = XSS安全
    expect(html).not.toContain("<button");
  });
});
