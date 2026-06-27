import { describe, expect, it } from "vitest";
import { isEmbeddedContext, shouldShowLoginGate } from "@/lib/loginGate";

describe("isEmbeddedContext", () => {
  it("iframe 内なら埋め込みと判定する", () => {
    expect(isEmbeddedContext({ inIframe: true })).toBe(true);
    expect(isEmbeddedContext({ inIframe: true, reporterParam: null })).toBe(true);
  });

  it("reporterParam があれば（widget が本人名を渡している）埋め込みと判定する", () => {
    expect(isEmbeddedContext({ inIframe: false, reporterParam: "高木" })).toBe(true);
    expect(isEmbeddedContext({ inIframe: false, reporterParam: " 脇本 " })).toBe(true);
  });

  it("トップレベルかつ reporterParam 無しは非埋め込み", () => {
    expect(isEmbeddedContext({ inIframe: false })).toBe(false);
    expect(isEmbeddedContext({ inIframe: false, reporterParam: null })).toBe(false);
    expect(isEmbeddedContext({ inIframe: false, reporterParam: "" })).toBe(false);
    expect(isEmbeddedContext({ inIframe: false, reporterParam: "  " })).toBe(false);
  });
});

describe("shouldShowLoginGate", () => {
  it("認証ON・非埋め込み・未ログインのときだけゲートを出す", () => {
    expect(
      shouldShowLoginGate({
        authUiEnabled: true,
        embedded: false,
        authStatus: "unauthenticated",
      })
    ).toBe(true);
  });

  it("認証OFF（既定・鍵未投入）なら絶対に出さない", () => {
    expect(
      shouldShowLoginGate({
        authUiEnabled: false,
        embedded: false,
        authStatus: "unauthenticated",
      })
    ).toBe(false);
  });

  it("埋め込み（iframe）なら絶対に出さない（全社 widget を守る）", () => {
    expect(
      shouldShowLoginGate({
        authUiEnabled: true,
        embedded: true,
        authStatus: "unauthenticated",
      })
    ).toBe(false);
  });

  it("ログイン済み・読み込み中はゲートを出さない（チラつき/回帰防止）", () => {
    expect(
      shouldShowLoginGate({
        authUiEnabled: true,
        embedded: false,
        authStatus: "authenticated",
      })
    ).toBe(false);
    expect(
      shouldShowLoginGate({
        authUiEnabled: true,
        embedded: false,
        authStatus: "loading",
      })
    ).toBe(false);
  });
});
