import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../prompt";
import type { Attachment, ChatMessage } from "../types";

const PDF_DATAURL =
  "data:application/pdf;base64," +
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).toString("base64");
const PNG_DATAURL =
  "data:image/png;base64," +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function pdfAtt(): Attachment {
  return { kind: "file", dataUrl: PDF_DATAURL, mime: "application/pdf", bytes: 6 };
}
function imgAtt(): Attachment {
  return { kind: "image", dataUrl: PNG_DATAURL, mime: "image/png", bytes: 8 };
}

describe("toAnthropicMessages（ファイルブロック）", () => {
  it("最後の user ターンに PDF があれば document ブロックが付く", () => {
    const hist: ChatMessage[] = [
      { role: "user", content: "この資料です", attachments: [pdfAtt()] },
    ];
    const out = toAnthropicMessages(hist);
    const blocks = out[0].content as any[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("この資料です");
    expect(blocks.some((b) => b.type === "document")).toBe(true);
  });

  it("画像とファイルが混在しても両方ブロック化する", () => {
    const hist: ChatMessage[] = [
      { role: "user", content: "", attachments: [imgAtt(), pdfAtt()] },
    ];
    const out = toAnthropicMessages(hist);
    const blocks = out[0].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.type === "image")).toBe(true);
    expect(blocks.some((b) => b.type === "document")).toBe(true);
  });

  it("過去ターンのファイルは積まない（最後の user ターンだけ）", () => {
    const hist: ChatMessage[] = [
      { role: "user", content: "前の資料", attachments: [pdfAtt()] },
      { role: "assistant", content: "確認しました" },
      { role: "user", content: "次の質問" },
    ];
    const out = toAnthropicMessages(hist);
    expect(typeof out[0].content).toBe("string");
    expect(typeof out[2].content).toBe("string");
  });

  it("添付なしは従来どおり文字列のまま（回帰ゼロ）", () => {
    const hist: ChatMessage[] = [{ role: "user", content: "ふつうの質問" }];
    const out = toAnthropicMessages(hist);
    expect(typeof out[0].content).toBe("string");
  });
});
