import { describe, it, expect } from "vitest";
import {
  isAuthEnabled,
  isEmailAllowed,
  isOriginAllowed,
  shouldProtectPath,
} from "../authz";

describe("isAuthEnabled", () => {
  it("3鍵すべて非空なら true", () => {
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
        AUTH_SECRET: "authsecret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("AUTH_GOOGLE_ID が無いと false", () => {
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_SECRET: "secret",
        AUTH_SECRET: "authsecret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("AUTH_GOOGLE_SECRET が無いと false", () => {
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_ID: "id",
        AUTH_SECRET: "authsecret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("AUTH_SECRET が無いと false", () => {
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("空文字や空白だけの鍵は非空とみなさない（false）", () => {
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_ID: "",
        AUTH_GOOGLE_SECRET: "secret",
        AUTH_SECRET: "authsecret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isAuthEnabled({
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "   ",
        AUTH_SECRET: "authsecret",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("何も無い env は false（＝従来どおり全公開）", () => {
    expect(isAuthEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("isEmailAllowed", () => {
  it("ドメイン未設定なら email があれば true", () => {
    expect(isEmailAllowed("user@example.com", undefined)).toBe(true);
    expect(isEmailAllowed("user@example.com", null)).toBe(true);
    expect(isEmailAllowed("user@example.com", "")).toBe(true);
    expect(isEmailAllowed("user@example.com", "   ")).toBe(true);
  });

  it("指定ドメインに一致すれば true", () => {
    expect(isEmailAllowed("kei@takagi.bz", "takagi.bz,stepupnext.com")).toBe(true);
    expect(isEmailAllowed("a@stepupnext.com", "takagi.bz,stepupnext.com")).toBe(true);
  });

  it("指定ドメインに不一致なら false", () => {
    expect(isEmailAllowed("user@gmail.com", "takagi.bz,stepupnext.com")).toBe(false);
  });

  it("大文字小文字を無視して一致する", () => {
    expect(isEmailAllowed("USER@TAKAGI.BZ", "takagi.bz")).toBe(true);
    expect(isEmailAllowed("user@takagi.bz", "TAKAGI.BZ")).toBe(true);
  });

  it("前後の空白を吸収する", () => {
    expect(isEmailAllowed("  user@takagi.bz  ", "  takagi.bz  ")).toBe(true);
  });

  it("email が無ければ常に false", () => {
    expect(isEmailAllowed(null, "takagi.bz")).toBe(false);
    expect(isEmailAllowed(undefined, "takagi.bz")).toBe(false);
    expect(isEmailAllowed("", "takagi.bz")).toBe(false);
    expect(isEmailAllowed(null, undefined)).toBe(false);
    expect(isEmailAllowed("   ", undefined)).toBe(false);
  });

  it("@ を含まない不正な email は false", () => {
    expect(isEmailAllowed("notanemail", undefined)).toBe(false);
    expect(isEmailAllowed("user@", "takagi.bz")).toBe(false);
  });

  it("複数@がある場合は最後の@以降をドメインとみなす", () => {
    expect(isEmailAllowed("a@b@takagi.bz", "takagi.bz")).toBe(true);
  });
});

describe("isOriginAllowed", () => {
  it("許可オリジン未設定なら常に true（後方互換・全許可）", () => {
    expect(isOriginAllowed("https://evil.example.com", undefined)).toBe(true);
    expect(isOriginAllowed("https://evil.example.com", null)).toBe(true);
    expect(isOriginAllowed("https://evil.example.com", "")).toBe(true);
    expect(isOriginAllowed("https://evil.example.com", "   ")).toBe(true);
  });

  it("Origin ヘッダ無しは（設定があっても）通す", () => {
    expect(isOriginAllowed(null, "https://kaizen.takagi.bz")).toBe(true);
    expect(isOriginAllowed(undefined, "https://kaizen.takagi.bz")).toBe(true);
    expect(isOriginAllowed("", "https://kaizen.takagi.bz")).toBe(true);
    expect(isOriginAllowed("   ", "https://kaizen.takagi.bz")).toBe(true);
  });

  it("許可リストに一致すれば true", () => {
    expect(
      isOriginAllowed("https://kaizen.takagi.bz", "https://kaizen.takagi.bz")
    ).toBe(true);
    expect(
      isOriginAllowed(
        "https://kaizen.takagi.bz",
        "https://a.example.com,https://kaizen.takagi.bz"
      )
    ).toBe(true);
  });

  it("許可リストに不一致なら false", () => {
    expect(
      isOriginAllowed("https://evil.example.com", "https://kaizen.takagi.bz")
    ).toBe(false);
  });

  it("末尾スラッシュを無視して一致する", () => {
    expect(
      isOriginAllowed("https://kaizen.takagi.bz/", "https://kaizen.takagi.bz")
    ).toBe(true);
    expect(
      isOriginAllowed("https://kaizen.takagi.bz", "https://kaizen.takagi.bz/")
    ).toBe(true);
  });

  it("大文字小文字を無視して一致する", () => {
    expect(
      isOriginAllowed("HTTPS://KAIZEN.TAKAGI.BZ", "https://kaizen.takagi.bz")
    ).toBe(true);
  });

  it("前後の空白を吸収する", () => {
    expect(
      isOriginAllowed("  https://kaizen.takagi.bz  ", "  https://kaizen.takagi.bz  ")
    ).toBe(true);
  });

  it("スキーム/ポート違いは別オリジンとして false", () => {
    expect(
      isOriginAllowed("http://kaizen.takagi.bz", "https://kaizen.takagi.bz")
    ).toBe(false);
    expect(
      isOriginAllowed("https://kaizen.takagi.bz:8443", "https://kaizen.takagi.bz")
    ).toBe(false);
  });
});

describe("shouldProtectPath（optional auth・管理ページだけ強制保護）", () => {
  it("窓口(/)・起票導線は保護しない（false＝embed壁を作らない）", () => {
    expect(shouldProtectPath("/")).toBe(false);
    expect(shouldProtectPath("/api/chat")).toBe(false);
    expect(shouldProtectPath("/api/submit")).toBe(false);
  });

  it("管理ページ(/board・/dashboard)とその配下は保護する（true）", () => {
    expect(shouldProtectPath("/board")).toBe(true);
    expect(shouldProtectPath("/board/")).toBe(true);
    expect(shouldProtectPath("/board/anything")).toBe(true);
    expect(shouldProtectPath("/dashboard")).toBe(true);
    expect(shouldProtectPath("/dashboard/")).toBe(true);
    expect(shouldProtectPath("/dashboard/detail/123")).toBe(true);
  });

  it("大文字小文字を無視して保護する", () => {
    expect(shouldProtectPath("/Board")).toBe(true);
    expect(shouldProtectPath("/DASHBOARD")).toBe(true);
  });

  it("管理ページに前方一致するだけの別パスは保護しない（誤爆防止）", () => {
    expect(shouldProtectPath("/boardroom")).toBe(false);
    expect(shouldProtectPath("/dashboards")).toBe(false);
    expect(shouldProtectPath("/api/board")).toBe(false);
    expect(shouldProtectPath("/api/stats")).toBe(false);
  });

  it("空・null・undefined は保護しない（false）", () => {
    expect(shouldProtectPath("")).toBe(false);
    expect(shouldProtectPath("   ")).toBe(false);
    expect(shouldProtectPath(null)).toBe(false);
    expect(shouldProtectPath(undefined)).toBe(false);
  });
});
