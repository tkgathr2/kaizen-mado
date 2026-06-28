import { describe, expect, it } from "vitest";
import { isWebView, detectWebViewApp, hasOpenExternalBrowserParam } from "@/lib/webview";

// 実機で採取した代表的な UA 文字列
const UA_LINE_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 Line/13.6.0";
const UA_LINE_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Line/13.6.0";
const UA_SLACK_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 Slack/23.08.10";
const UA_SLACK_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36 (Slack)";
const UA_INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile Instagram 302.0.0.33.118";
const UA_FACEBOOK = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FBAN/FBIOS FBDV/iPhone16,1 FBMD/iPhone FBSN/iOS FBSV/17.0";
const UA_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const UA_TWITTER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile Twitter/9.80.0";
const UA_WECHAT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile MicroMessenger/8.0.0";
const UA_ANDROID_WV = "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 (wv)";

describe("isWebView", () => {
  it("LINE iOS を WebView と判定する", () => {
    expect(isWebView(UA_LINE_IOS)).toBe(true);
  });
  it("LINE Android を WebView と判定する", () => {
    expect(isWebView(UA_LINE_ANDROID)).toBe(true);
  });
  it("Slack iOS を WebView と判定する", () => {
    expect(isWebView(UA_SLACK_IOS)).toBe(true);
  });
  it("Slack Android を WebView と判定する", () => {
    expect(isWebView(UA_SLACK_ANDROID)).toBe(true);
  });
  it("Instagram を WebView と判定する", () => {
    expect(isWebView(UA_INSTAGRAM)).toBe(true);
  });
  it("Facebook を WebView と判定する", () => {
    expect(isWebView(UA_FACEBOOK)).toBe(true);
  });
  it("Twitter を WebView と判定する", () => {
    expect(isWebView(UA_TWITTER)).toBe(true);
  });
  it("WeChat (MicroMessenger) を WebView と判定する", () => {
    expect(isWebView(UA_WECHAT)).toBe(true);
  });
  it("Android 汎用 WebView (wv) を WebView と判定する", () => {
    expect(isWebView(UA_ANDROID_WV)).toBe(true);
  });
  it("Safari は通常ブラウザと判定する", () => {
    expect(isWebView(UA_SAFARI)).toBe(false);
  });
  it("Chrome Android は通常ブラウザと判定する", () => {
    expect(isWebView(UA_CHROME_ANDROID)).toBe(false);
  });
  it("空文字列は false", () => {
    expect(isWebView("")).toBe(false);
  });
});

describe("detectWebViewApp", () => {
  it("LINE UA を 'line' と判定する", () => {
    expect(detectWebViewApp(UA_LINE_IOS)).toBe("line");
    expect(detectWebViewApp(UA_LINE_ANDROID)).toBe("line");
  });
  it("Slack UA を 'slack' と判定する", () => {
    expect(detectWebViewApp(UA_SLACK_IOS)).toBe("slack");
    expect(detectWebViewApp(UA_SLACK_ANDROID)).toBe("slack");
  });
  it("Instagram UA を 'other' と判定する", () => {
    expect(detectWebViewApp(UA_INSTAGRAM)).toBe("other");
  });
  it("Safari UA を 'other' と判定する", () => {
    expect(detectWebViewApp(UA_SAFARI)).toBe("other");
  });
});

describe("hasOpenExternalBrowserParam", () => {
  it("openExternalBrowser=1 を検知する", () => {
    expect(hasOpenExternalBrowserParam("?openExternalBrowser=1")).toBe(true);
    expect(hasOpenExternalBrowserParam("openExternalBrowser=1")).toBe(true);
    expect(hasOpenExternalBrowserParam("?foo=bar&openExternalBrowser=1")).toBe(true);
  });
  it("値が 1 以外は false", () => {
    expect(hasOpenExternalBrowserParam("?openExternalBrowser=0")).toBe(false);
    expect(hasOpenExternalBrowserParam("?openExternalBrowser=true")).toBe(false);
  });
  it("パラメータが無い場合は false", () => {
    expect(hasOpenExternalBrowserParam("")).toBe(false);
    expect(hasOpenExternalBrowserParam("?foo=bar")).toBe(false);
  });
});
