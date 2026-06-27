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

  // ── 追加パターン（ハイフン無し携帯・カード番号・マイナンバー）──
  it("ハイフン無し携帯番号(090…)を[電話]に置換する", () => {
    const r = maskPII("緊急時は09012345678へ");
    expect(r).toContain("[電話]");
    expect(r).not.toContain("09012345678");
  });

  it("080/070のハイフン無し携帯も[電話]に置換する", () => {
    expect(maskPII("08011112222")).toContain("[電話]");
    expect(maskPII("07033334444")).toContain("[電話]");
  });

  it("スペース区切りのカード番号を伏字化し、桁の断片を残さない", () => {
    const r = maskPII("カードは4242 4242 4242 4242です");
    expect(r).toContain("[カード番号]");
    expect(r).not.toContain("4242");
  });

  it("ハイフン区切りのカード番号を伏字化する", () => {
    const r = maskPII("4242-4242-4242-4242");
    expect(r).toContain("[カード番号]");
    expect(r).not.toContain("4242");
  });

  it("マイナンバー12桁(スペース区切り)を[個人番号]に置換する", () => {
    const r = maskPII("マイナンバー1234 5678 9012を確認");
    expect(r).toContain("[個人番号]");
    expect(r).not.toContain("1234 5678 9012");
  });

  it("マイナンバー12桁(連続)を[個人番号]に置換する", () => {
    expect(maskPII("123456789012")).toBe("[個人番号]");
  });

  // ── 過剰マスクしないこと（正常な文章を壊さない）──
  it("KZ-12 等のチケットIDは伏字化しない", () => {
    expect(maskPII("KZ-12のボタンが効かない")).toBe("KZ-12のボタンが効かない");
  });

  it("日付(2026-06-26)は伏字化しない", () => {
    expect(maskPII("2026-06-26に発生しました")).toBe("2026-06-26に発生しました");
  });

  it("短い数字・金額・順序は伏字化しない", () => {
    expect(maskPII("金額は12345円")).toBe("金額は12345円");
    expect(maskPII("優先度は3です")).toBe("優先度は3です");
    expect(maskPII("手順1 2 3 4で再現")).toBe("手順1 2 3 4で再現");
  });

  it("既存の電話・郵便番号の挙動は維持される（追加パターン導入後も）", () => {
    expect(maskPII("090-1234-5678")).toContain("[電話]");
    expect(maskPII("〒123-4567")).toContain("[郵便番号]");
    expect(maskPII("口座番号1234567890")).toContain("[番号]");
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
