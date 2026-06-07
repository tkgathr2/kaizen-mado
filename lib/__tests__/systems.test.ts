import { describe, it, expect } from "vitest";
import { resolveSystem, normalizeSystemForTicket } from "../systems";

describe("resolveSystem", () => {
  it("slugで正式名を返す", () => {
    expect(resolveSystem("prorepo")).toBe("プロレポ");
  });

  it("正式名でそのまま返す", () => {
    expect(resolveSystem("プロレポ")).toBe("プロレポ");
  });

  it("slugの大文字小文字を吸収する", () => {
    expect(resolveSystem("PROREPO")).toBe("プロレポ");
    expect(resolveSystem("Prorepo")).toBe("プロレポ");
  });

  it("前後の空白を吸収する", () => {
    expect(resolveSystem("  prorepo  ")).toBe("プロレポ");
  });

  it("他のslugも正しく解決する", () => {
    expect(resolveSystem("sterepo")).toBe("ステレポ");
    expect(resolveSystem("cast-meibo")).toBe("キャスト名簿くん");
    expect(resolveSystem("rakuraku")).toBe("らくらく契約くん");
  });

  it("未知のslugはnullを返す", () => {
    expect(resolveSystem("unknown-system")).toBeNull();
  });

  it("nullはnullを返す", () => {
    expect(resolveSystem(null)).toBeNull();
  });

  it("undefinedはnullを返す", () => {
    expect(resolveSystem(undefined)).toBeNull();
  });

  it("空文字はnullを返す", () => {
    expect(resolveSystem("")).toBeNull();
  });
});

describe("normalizeSystemForTicket", () => {
  it("既知の正式名はそのまま返す", () => {
    expect(normalizeSystemForTicket("プロレポ")).toBe("プロレポ");
    expect(normalizeSystemForTicket("その他")).toBe("その他");
  });

  it("未知の名前はその他を返す", () => {
    expect(normalizeSystemForTicket("謎のシステム")).toBe("その他");
  });

  it("nullはその他を返す", () => {
    expect(normalizeSystemForTicket(null)).toBe("その他");
  });

  it("undefinedはその他を返す", () => {
    expect(normalizeSystemForTicket(undefined)).toBe("その他");
  });

  it("空文字はその他を返す", () => {
    expect(normalizeSystemForTicket("")).toBe("その他");
  });
});
