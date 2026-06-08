import { describe, it, expect } from "vitest";
import { isAuthEnabled, isEmailAllowed } from "../authz";

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
