import { describe, it, expect } from "vitest";
import { coerceTurn } from "../anthropic";

describe("coerceTurn", () => {
  it("phase=confirmのときticketが埋まる", () => {
    const result = coerceTurn({
      reply: "以下の内容で起票してよろしいですか？",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "改善",
        title: "一覧が表示されない",
        detail: "一覧ページを開くと何も表示されない",
        importance: "中",
      },
    });
    expect(result.phase).toBe("confirm");
    expect(result.ticket).not.toBeNull();
    expect(result.ticket?.system).toBe("プロレポ");
    expect(result.ticket?.type).toBe("改善");
    expect(result.ticket?.title).toBe("一覧が表示されない");
    expect(result.ticket?.importance).toBe("中");
  });

  it("phase=clarifyのときticketはnull", () => {
    const result = coerceTurn({
      reply: "どのような問題が発生していますか？",
      phase: "clarify",
    });
    expect(result.phase).toBe("clarify");
    expect(result.ticket).toBeNull();
  });

  it("phase未指定（不明値）のときclarifyになりticketはnull", () => {
    const result = coerceTurn({
      reply: "詳しく教えてください",
      phase: "unknown",
    });
    expect(result.phase).toBe("clarify");
    expect(result.ticket).toBeNull();
  });

  it("replyが空文字のときthrowする", () => {
    expect(() =>
      coerceTurn({ reply: "", phase: "clarify" })
    ).toThrow();
  });

  it("replyが欠落しているときthrowする", () => {
    expect(() =>
      coerceTurn({ phase: "clarify" })
    ).toThrow();
  });

  it("type=bugはそのまま保持する", () => {
    const result = coerceTurn({
      reply: "バグを起票します",
      phase: "confirm",
      ticket: {
        system: "ステレポ",
        type: "bug",
        title: "エラーが出る",
        detail: "500エラーになる",
        importance: "高",
      },
    });
    expect(result.ticket?.type).toBe("bug");
  });

  it("type=新機能はそのまま保持する", () => {
    const result = coerceTurn({
      reply: "新機能を起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "新機能",
        title: "エクスポート機能",
        detail: "CSVでエクスポートしたい",
        importance: "低",
      },
    });
    expect(result.ticket?.type).toBe("新機能");
  });

  it("typeがbug/新機能以外のとき改善にフォールバックする", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "要望",
        title: "なにか",
        detail: "詳細",
        importance: "中",
      },
    });
    expect(result.ticket?.type).toBe("改善");
  });

  it("importance=高はそのまま保持する", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "bug",
        title: "緊急バグ",
        detail: "詳細",
        importance: "高",
      },
    });
    expect(result.ticket?.importance).toBe("高");
  });

  it("importance=低はそのまま保持する", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "改善",
        title: "小さな改善",
        detail: "詳細",
        importance: "低",
      },
    });
    expect(result.ticket?.importance).toBe("低");
  });

  it("importanceが高/低以外のとき中にフォールバックする", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "改善",
        title: "なにか",
        detail: "詳細",
        importance: "最高",
      },
    });
    expect(result.ticket?.importance).toBe("中");
  });

  it("titleが空のとき改善のご要望になる", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "改善",
        title: "",
        detail: "詳細",
        importance: "中",
      },
    });
    expect(result.ticket?.title).toBe("改善のご要望");
  });

  it("replyの前後空白をtrimする", () => {
    const result = coerceTurn({
      reply: "  確認します  ",
      phase: "clarify",
    });
    expect(result.reply).toBe("確認します");
  });

  it("ticketのtitleが100文字を超える場合100文字にスライスする", () => {
    const longTitle = "あ".repeat(120);
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: {
        system: "プロレポ",
        type: "改善",
        title: longTitle,
        detail: "詳細",
        importance: "中",
      },
    });
    expect(result.ticket?.title.length).toBe(100);
  });

  it("phase=confirmでticketがnullのときデフォルト値で埋める", () => {
    const result = coerceTurn({
      reply: "起票します",
      phase: "confirm",
      ticket: null,
    });
    expect(result.phase).toBe("confirm");
    expect(result.ticket).not.toBeNull();
    expect(result.ticket?.title).toBe("改善のご要望");
    expect(result.ticket?.type).toBe("改善");
    expect(result.ticket?.importance).toBe("中");
  });
});
