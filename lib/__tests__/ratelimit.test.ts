import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  rateLimitConfigs,
  clientKeyFromHeaders,
  _resetRateLimit,
  type RateLimitConfig,
} from "@/lib/ratelimit";

beforeEach(() => {
  _resetRateLimit();
});

const oneWin: RateLimitConfig[] = [{ windowMs: 1000, max: 3 }];

describe("checkRateLimit スライディングウィンドウ", () => {
  it("上限内は通す", () => {
    const now = 1_000_000;
    expect(checkRateLimit("k", oneWin, now).allowed).toBe(true);
    expect(checkRateLimit("k", oneWin, now).allowed).toBe(true);
    expect(checkRateLimit("k", oneWin, now).allowed).toBe(true);
  });

  it("ウィンドウ超過で弾く（4回目）", () => {
    const now = 1_000_000;
    checkRateLimit("k", oneWin, now);
    checkRateLimit("k", oneWin, now);
    checkRateLimit("k", oneWin, now);
    const r = checkRateLimit("k", oneWin, now);
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe(3);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("超過分はカウントを延ばさない＝古い記録が窓から外れれば再び通る", () => {
    const t0 = 1_000_000;
    checkRateLimit("k", oneWin, t0);
    checkRateLimit("k", oneWin, t0);
    checkRateLimit("k", oneWin, t0);
    // 同時刻の4回目は弾かれる
    expect(checkRateLimit("k", oneWin, t0).allowed).toBe(false);
    // 1001ms 後＝最初の3件が窓(1000ms)から外れるので通る
    expect(checkRateLimit("k", oneWin, t0 + 1001).allowed).toBe(true);
  });

  it("キーが違えばカウントは分離される", () => {
    const now = 1_000_000;
    checkRateLimit("a", oneWin, now);
    checkRateLimit("a", oneWin, now);
    checkRateLimit("a", oneWin, now);
    expect(checkRateLimit("a", oneWin, now).allowed).toBe(false);
    // 別キーは独立して通る
    expect(checkRateLimit("b", oneWin, now).allowed).toBe(true);
  });

  it("複数ウィンドウ：短い窓は通っても長い窓の上限で弾く", () => {
    const cfg: RateLimitConfig[] = [
      { windowMs: 1000, max: 100 }, // 分相当（ゆるい）
      { windowMs: 10_000, max: 2 }, // 時相当（きつい）
    ];
    const now = 5_000_000;
    expect(checkRateLimit("k", cfg, now).allowed).toBe(true);
    expect(checkRateLimit("k", cfg, now).allowed).toBe(true);
    // 長い窓 max=2 を超過
    expect(checkRateLimit("k", cfg, now).allowed).toBe(false);
  });

  it("configs が空なら常に通す（fail-safe）", () => {
    const r = checkRateLimit("k", [], 1);
    expect(r.allowed).toBe(true);
  });
});

describe("rateLimitConfigs env 上書き", () => {
  it("未設定なら既定（分20・時100）", () => {
    const c = rateLimitConfigs({} as NodeJS.ProcessEnv);
    expect(c[0]).toEqual({ windowMs: 60_000, max: 20 });
    expect(c[1]).toEqual({ windowMs: 3_600_000, max: 100 });
  });

  it("env で上書きできる", () => {
    const c = rateLimitConfigs({
      KAIZEN_CHAT_RATE_PER_MIN: "5",
      KAIZEN_CHAT_RATE_PER_HOUR: "30",
    } as unknown as NodeJS.ProcessEnv);
    expect(c[0].max).toBe(5);
    expect(c[1].max).toBe(30);
  });

  it("不正値（0・負・非数）は既定にフォールバック", () => {
    expect(rateLimitConfigs({ KAIZEN_CHAT_RATE_PER_MIN: "0" } as any)[0].max).toBe(20);
    expect(rateLimitConfigs({ KAIZEN_CHAT_RATE_PER_MIN: "-3" } as any)[0].max).toBe(20);
    expect(rateLimitConfigs({ KAIZEN_CHAT_RATE_PER_MIN: "abc" } as any)[0].max).toBe(20);
  });
});

describe("clientKeyFromHeaders", () => {
  function hdr(map: Record<string, string>) {
    return { get: (n: string) => map[n.toLowerCase()] ?? null };
  }

  it("x-forwarded-for の先頭IPを使う", () => {
    expect(clientKeyFromHeaders(hdr({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("x-real-ip にフォールバック", () => {
    expect(clientKeyFromHeaders(hdr({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("何も無ければ fallback", () => {
    expect(clientKeyFromHeaders(hdr({}), "anon")).toBe("anon");
  });
});
