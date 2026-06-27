import { describe, it, expect } from "vitest";
import { isInfraError, buildInfraNoticeText } from "../line";

// KZ-9：基盤エラー（認証/権限/設定系の仕組み側不調）の判定。
// true のときは社長に「直せません」と出さず、状態も差し戻さない（callback/route.ts）。
describe("isInfraError（基盤エラー判定）", () => {
  it("認証/権限/設定系の文言を基盤エラーと判定する", () => {
    const infra = [
      "fatal: could not read Username for 'https://github.com'",
      "remote: Permission to org/repo.git denied to user",
      "permission denied (publickey)",
      "The requested resource is not permitted",
      "HTTP 403 Forbidden",
      "401 Unauthorized",
      "Authentication failed for 'https://github.com'",
      "bad credentials",
      "invalid token",
      "API_KEY is not set",
    ];
    for (const d of infra) {
      expect(isInfraError(d), d).toBe(true);
    }
  });

  it("AI改修そのものの失敗（コード/テスト失敗）は基盤エラーにしない", () => {
    const notInfra = [
      "tests failed: 3 assertions",
      "TypeError: cannot read property of undefined",
      "build failed: type error in app/page.tsx",
      "lint error: unexpected token",
      "could not resolve the requested change",
    ];
    for (const d of notInfra) {
      expect(isInfraError(d), d).toBe(false);
    }
  });

  it("空・未定義は false（保守的）", () => {
    expect(isInfraError("")).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError(undefined)).toBe(false);
  });

  it("基盤エラー文面は「直せません」を出さず再挑戦を伝える", () => {
    const text = buildInfraNoticeText({
      ticketId: "KZ-9",
      system: "カイゼンくん本体",
      title: "テスト",
    });
    expect(text).toContain("KZ-9");
    expect(text).toContain("仕組み側");
    expect(text).toContain("もう一度挑戦");
    expect(text).not.toContain("直せませんでした");
  });
});
