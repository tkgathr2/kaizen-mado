import { describe, it, expect } from "vitest";
import { maskPII, looksLikePII } from "../pii";

describe("maskPII", () => {
  it("メールアドレスを[メール]に置換する", () => {
    expect(maskPII("連絡先はtest@example.comです")).toBe("連絡先は[メール]です");
  });

  it("市外局番形式の電話番号を[電話]に置換する", () => {
    expect(maskPII("TEL: 03-1234-5678")).toContain("[電話]");
  });

  it("携帯電話番号を[電話]に置換する", () => {
    expect(maskPII("090-1234-5678に連絡")).toContain("[電話]");
  });

  it("フリーダイヤルを[電話]に置換する", () => {
    expect(maskPII("0120-123-456まで")).toContain("[電話]");
  });

  it("10桁以上の連続数字を[番号]に置換する", () => {
    expect(maskPII("口座番号1234567890です")).toContain("[番号]");
  });

  it("9桁以下の連続数字はそのまま", () => {
    expect(maskPII("123456789")).toBe("123456789");
  });

  it("〒付き郵便番号を[郵便番号]に置換する", () => {
    expect(maskPII("〒123-4567 大阪市")).toContain("[郵便番号]");
  });

  it("〒なし郵便番号形式を[郵便番号]に置換する", () => {
    expect(maskPII("郵便番号は123-4567です")).toContain("[郵便番号]");
  });

  it("無害な文字列は変化しない", () => {
    const safe = "プロレポの一覧ページが表示されません";
    expect(maskPII(safe)).toBe(safe);
  });

  it("メールと電話が混在する複合文字列を両方マスクする", () => {
    const input = "田中さん(tanaka@example.com / 090-9999-8888)から問い合わせ";
    const result = maskPII(input);
    expect(result).toContain("[メール]");
    expect(result).toContain("[電話]");
    expect(result).not.toContain("tanaka@example.com");
    expect(result).not.toContain("090-9999-8888");
  });

  it("空文字はそのまま返す", () => {
    expect(maskPII("")).toBe("");
  });
});

describe("looksLikePII", () => {
  it("メールアドレスを含む場合はtrue", () => {
    expect(looksLikePII("foo@bar.com")).toBe(true);
  });

  it("電話番号を含む場合はtrue", () => {
    expect(looksLikePII("03-1234-5678")).toBe(true);
  });

  it("10桁以上の数字を含む場合はtrue", () => {
    expect(looksLikePII("1234567890")).toBe(true);
  });

  it("無害な文字列はfalse", () => {
    expect(looksLikePII("画面が真っ白になります")).toBe(false);
  });

  it("空文字はfalse", () => {
    expect(looksLikePII("")).toBe(false);
  });
});
