import { describe, it, expect } from "vitest";
import { resolveReporter } from "../reporter";

describe("resolveReporter（起票者名の優先順位）", () => {
  it("reporterParam（widget）が最優先", () => {
    expect(
      resolveReporter({
        reporterParam: "脇本",
        sessionName: "高木 篤宏",
        manualInput: "誰か",
      })
    ).toBe("脇本");
  });

  it("reporterParam が空なら session.user.name を使う", () => {
    expect(
      resolveReporter({
        reporterParam: "",
        sessionName: "高木 篤宏",
        manualInput: "誰か",
      })
    ).toBe("高木 篤宏");
    expect(
      resolveReporter({
        reporterParam: null,
        sessionName: "高木 篤宏",
        manualInput: "誰か",
      })
    ).toBe("高木 篤宏");
  });

  it("reporterParam も session も無ければ手入力を使う", () => {
    expect(
      resolveReporter({
        reporterParam: "",
        sessionName: "",
        manualInput: "高木",
      })
    ).toBe("高木");
  });

  it("すべて空なら空文字（匿名）", () => {
    expect(resolveReporter({})).toBe("");
    expect(
      resolveReporter({
        reporterParam: null,
        sessionName: null,
        manualInput: null,
      })
    ).toBe("");
    expect(
      resolveReporter({
        reporterParam: "   ",
        sessionName: "   ",
        manualInput: "   ",
      })
    ).toBe("");
  });

  it("前後の空白を除去する", () => {
    expect(resolveReporter({ reporterParam: "  脇本  " })).toBe("脇本");
    expect(resolveReporter({ sessionName: "  高木  " })).toBe("高木");
    expect(resolveReporter({ manualInput: "  誰か  " })).toBe("誰か");
  });

  it("空白だけの上位はスキップして次の候補に進む", () => {
    expect(
      resolveReporter({
        reporterParam: "   ",
        sessionName: "高木 篤宏",
      })
    ).toBe("高木 篤宏");
    expect(
      resolveReporter({
        reporterParam: "   ",
        sessionName: "   ",
        manualInput: "高木",
      })
    ).toBe("高木");
  });
});
