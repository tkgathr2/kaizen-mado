// Content-Length ガードのロジックを純粋関数として単体テスト。
// route.ts の CONTENT_LENGTH_LIMIT 定数と同じ値（20MB）を使い、
// 境界値・欠落・非数値の各ケースを網羅する。

import { describe, it, expect } from "vitest";

// ── テスト対象：Content-Length を評価して 413 を返すかどうか ──
// route.ts のガードと完全に同じロジックを抽出した純粋関数。
const CONTENT_LENGTH_LIMIT = 20 * 1024 * 1024; // 20MB

function shouldReject413(contentLengthHeader: string | null): boolean {
  if (contentLengthHeader === null) return false; // ヘッダ欠落はスルー
  const cl = parseInt(contentLengthHeader, 10);
  if (isNaN(cl)) return false; // 非数値はスルー（後段に委ねる）
  return cl > CONTENT_LENGTH_LIMIT;
}

describe("Content-Length 413 ガード（DoS 早期排除）", () => {
  it("20MB 以内は通す（境界値 = 許容）", () => {
    expect(shouldReject413(String(CONTENT_LENGTH_LIMIT))).toBe(false);
  });

  it("20MB+1 byte は 413（境界値 + 1 = 拒否）", () => {
    expect(shouldReject413(String(CONTENT_LENGTH_LIMIT + 1))).toBe(true);
  });

  it("明らかに巨大なペイロードは拒否", () => {
    expect(shouldReject413("999999999")).toBe(true); // ~953MB
  });

  it("Content-Length ヘッダが無い場合はスルー（chunked 転送対応）", () => {
    expect(shouldReject413(null)).toBe(false);
  });

  it("Content-Length が非数値の場合はスルー（不正ヘッダは後段に委ねる）", () => {
    expect(shouldReject413("abc")).toBe(false);
    expect(shouldReject413("")).toBe(false);
  });

  it("0 は通す（空ボディ）", () => {
    expect(shouldReject413("0")).toBe(false);
  });

  it("1 は通す（最小ペイロード）", () => {
    expect(shouldReject413("1")).toBe(false);
  });
});
