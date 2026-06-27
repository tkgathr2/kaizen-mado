import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkCronSecret } from "../cronAuth";
import type { NextRequest } from "next/server";

// headers.get だけ使う最小のリクエストを作る。
function reqWith(headers: Record<string, string>): NextRequest {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

describe("checkCronSecret", () => {
  let savedSecret: string | undefined;
  let savedEnv: string | undefined;
  let savedAllow: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.CRON_SECRET;
    savedEnv = process.env.NODE_ENV;
    savedAllow = process.env.ALLOW_INSECURE_CRON;
    // 既定はフラグ無しの状態でテストする
    delete process.env.ALLOW_INSECURE_CRON;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedEnv === undefined) delete (process.env as any).NODE_ENV;
    else (process.env as any).NODE_ENV = savedEnv;
    if (savedAllow === undefined) delete process.env.ALLOW_INSECURE_CRON;
    else process.env.ALLOW_INSECURE_CRON = savedAllow;
  });

  it("CRON_SECRET設定時、x-cron-secret 一致で true", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(checkCronSecret(reqWith({ "x-cron-secret": "s3cret" }))).toBe(true);
    expect(checkCronSecret(reqWith({ "x-cron-secret": "wrong" }))).toBe(false);
  });

  it("Vercel Cron の Authorization: Bearer 一致で true", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(checkCronSecret(reqWith({ authorization: "Bearer s3cret" }))).toBe(true);
    expect(checkCronSecret(reqWith({ authorization: "Bearer nope" }))).toBe(false);
    expect(checkCronSecret(reqWith({ authorization: "s3cret" }))).toBe(false); // Bearer無し
  });

  it("ヘッダ無しは false", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(checkCronSecret(reqWith({}))).toBe(false);
  });

  it("本番でCRON_SECRET未設定は fail-closed(false)", () => {
    delete process.env.CRON_SECRET;
    (process.env as any).NODE_ENV = "production";
    expect(checkCronSecret(reqWith({ "x-cron-secret": "anything" }))).toBe(false);
  });

  it("CRON_SECRET未設定は環境に関わらず拒否(false)＝fail-closed", () => {
    delete process.env.CRON_SECRET;
    // 開発でもフラグ無しなら拒否（preview/誤設定で内部APIが開かないように）
    (process.env as any).NODE_ENV = "development";
    expect(checkCronSecret(reqWith({}))).toBe(false);
    (process.env as any).NODE_ENV = "preview";
    expect(checkCronSecret(reqWith({ "x-cron-secret": "anything" }))).toBe(false);
  });

  it("CRON_SECRET未設定でも ALLOW_INSECURE_CRON=1 のときだけ通す(true)", () => {
    delete process.env.CRON_SECRET;
    process.env.ALLOW_INSECURE_CRON = "1";
    (process.env as any).NODE_ENV = "development";
    expect(checkCronSecret(reqWith({}))).toBe(true);
    // 値が"1"以外なら通さない
    process.env.ALLOW_INSECURE_CRON = "true";
    expect(checkCronSecret(reqWith({}))).toBe(false);
  });

  it("本番でCRON_SECRET設定済みの挙動は不変（フラグの影響を受けない）", () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.ALLOW_INSECURE_CRON = "1"; // 設定されていても secret 優先
    (process.env as any).NODE_ENV = "production";
    expect(checkCronSecret(reqWith({ "x-cron-secret": "s3cret" }))).toBe(true);
    expect(checkCronSecret(reqWith({ "x-cron-secret": "wrong" }))).toBe(false);
    expect(checkCronSecret(reqWith({}))).toBe(false);
  });
});
