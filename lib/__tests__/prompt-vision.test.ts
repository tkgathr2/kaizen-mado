import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../prompt";
import type { Attachment, ChatMessage } from "../types";

const PNG_DATAURL =
  "data:image/png;base64," +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function att(): Attachment {
  return { dataUrl: PNG_DATAURL, mime: "image/png", bytes: 8 };
}

describe("toAnthropicMessages（画像ブロック組み立て）", () => {
  it("添付なしは従来どおり文字列 content", () => {
    const hist: ChatMessage[] = [
      { role: "user", content: "こんにちは" },
      { role: "assistant", content: "どうしました？" },
      { role: "user", content: "バグです" },
    ];
    const out = toAnthropicMessages(hist);
    expect(out.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("最後の user ターンに添付があればブロック配列（text+image）になる", () => {
    const hist: ChatMessage[] = [
      { role: "assistant", content: "どうしました？" },
      { role: "user", content: "この画面です", attachments: [att()] },
    ];
    const out = toAnthropicMessages(hist);
    const last = out[out.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("この画面です");
    expect(blocks[1].type).toBe("image");
    expect(blocks[1].source.type).toBe("base64");
    expect(blocks[1].source.media_type).toBe("image/png");
  });

  it("テキストが空でも画像があれば text ブロックを補って配列にする", () => {
    const hist: ChatMessage[] = [{ role: "user", content: "", attachments: [att()] }];
    const out = toAnthropicMessages(hist);
    const blocks = out[0].content as any[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text.length).toBeGreaterThan(0);
    expect(blocks[1].type).toBe("image");
  });

  it("過去の user ターンの添付は積まない（最後の user ターンだけ）", () => {
    const hist: ChatMessage[] = [
      { role: "user", content: "前の画像", attachments: [att()] },
      { role: "assistant", content: "確認しました" },
      { role: "user", content: "次の質問" },
    ];
    const out = toAnthropicMessages(hist);
    // 過去ターン（index 0）は文字列のまま（画像を積まない＝トークン肥大対策）
    expect(typeof out[0].content).toBe("string");
    // 最後の user ターンは添付なしなので文字列のまま
    expect(typeof out[2].content).toBe("string");
  });

  it("attachments が空配列なら文字列のまま", () => {
    const hist: ChatMessage[] = [{ role: "user", content: "テキスト", attachments: [] }];
    const out = toAnthropicMessages(hist);
    expect(typeof out[0].content).toBe("string");
  });
});
