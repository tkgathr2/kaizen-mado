import { describe, it, expect } from "vitest";
import { resolveReporter, sanitizeReporter } from "../reporter";

describe("resolveReporter（起票者名の優先順位。手入力による自称は無い＝社長指示）", () => {
  it("reporterParam（widget）が最優先", () => {
    expect(
      resolveReporter({
        reporterParam: "脇本",
        sessionName: "高木 篤宏",
        sessionEmail: "someone@example.com",
      })
    ).toBe("脇本");
  });

  it("reporterParam が空なら session.user.name を使う", () => {
    expect(
      resolveReporter({ reporterParam: "", sessionName: "高木 篤宏", sessionEmail: "a@b.com" })
    ).toBe("高木 篤宏");
    expect(
      resolveReporter({ reporterParam: null, sessionName: "高木 篤宏", sessionEmail: "a@b.com" })
    ).toBe("高木 篤宏");
  });

  it("reporterParam も sessionName も無ければ sessionEmail を使う（表示名の無いGoogleアカウント救済）", () => {
    expect(
      resolveReporter({ reporterParam: "", sessionName: "", sessionEmail: "atsuhiro@takagi.bz" })
    ).toBe("atsuhiro@takagi.bz");
  });

  it("すべて空なら空文字（匿名＝呼び出し側で拒否する）", () => {
    expect(resolveReporter({})).toBe("");
    expect(resolveReporter({ reporterParam: null, sessionName: null, sessionEmail: null })).toBe("");
    expect(resolveReporter({ reporterParam: "   ", sessionName: "   ", sessionEmail: "   " })).toBe("");
  });

  it("前後の空白を除去する", () => {
    expect(resolveReporter({ reporterParam: "  脇本  " })).toBe("脇本");
    expect(resolveReporter({ sessionName: "  高木  " })).toBe("高木");
    expect(resolveReporter({ sessionEmail: "  a@b.com  " })).toBe("a@b.com");
  });

  it("空白だけの上位はスキップして次の候補に進む", () => {
    expect(resolveReporter({ reporterParam: "   ", sessionName: "高木 篤宏" })).toBe("高木 篤宏");
    expect(
      resolveReporter({ reporterParam: "   ", sessionName: "   ", sessionEmail: "a@b.com" })
    ).toBe("a@b.com");
  });
});

describe("sanitizeReporter（サーバ側の最終防衛・改行/長さの無害化）", () => {
  it("改行・タブを半角スペース1つに畳む", () => {
    expect(sanitizeReporter("田中\n📮 経路：Slack から")).toBe("田中 📮 経路：Slack から");
    expect(sanitizeReporter("a\tb\r\nc")).toBe("a b c");
  });

  it("全角スペース・連続空白も1つに畳む", () => {
    expect(sanitizeReporter("高木　　太郎")).toBe("高木 太郎");
    expect(sanitizeReporter("高木    太郎")).toBe("高木 太郎");
  });

  it("既定で40文字に切る", () => {
    const long = "あ".repeat(60);
    expect(sanitizeReporter(long)).toBe("あ".repeat(40));
  });

  it("maxLength を明示指定できる", () => {
    expect(sanitizeReporter("abcdefgh", 5)).toBe("abcde");
  });

  it("前後の空白を除去する", () => {
    expect(sanitizeReporter("  高木  ")).toBe("高木");
  });
});
