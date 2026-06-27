import { describe, it, expect } from "vitest";
import { sanitizeHistory } from "../history";

const PDF_DATAURL =
  "data:application/pdf;base64," +
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).toString("base64");
const PNG_DATAURL =
  "data:image/png;base64," +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const CSV_DATAURL =
  "data:text/csv;base64," + Buffer.from("a,b\n1,2", "utf-8").toString("base64");

describe("sanitizeHistory（ファイルゲート）", () => {
  it("ファイル OFF（boolean 旧API）のとき file 添付を捨てる（回帰ゼロ）", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "見て", attachments: [{ dataUrl: PDF_DATAURL }] }],
      false
    );
    expect(out).toHaveLength(1);
    expect(out[0].attachments).toBeUndefined();
  });

  it("withFiles=true のとき PDF/CSV を通す", () => {
    const out = sanitizeHistory(
      [
        {
          role: "user",
          content: "見て",
          attachments: [{ dataUrl: PDF_DATAURL }, { dataUrl: CSV_DATAURL }],
        },
      ],
      { withFiles: true }
    );
    expect(out[0].attachments).toHaveLength(2);
    expect(out[0].attachments?.[0].kind).toBe("file");
  });

  it("withFiles=true・withVision=false のとき画像は通さない", () => {
    const out = sanitizeHistory(
      [
        {
          role: "user",
          content: "x",
          attachments: [{ dataUrl: PDF_DATAURL }, { dataUrl: PNG_DATAURL }],
        },
      ],
      { withFiles: true, withVision: false }
    );
    expect(out[0].attachments).toHaveLength(1);
    expect(out[0].attachments?.[0].mime).toBe("application/pdf");
  });

  it("withFiles=true・withVision=true のとき画像もファイルも通す", () => {
    const out = sanitizeHistory(
      [
        {
          role: "user",
          content: "x",
          attachments: [{ dataUrl: PDF_DATAURL }, { dataUrl: PNG_DATAURL }],
        },
      ],
      { withFiles: true, withVision: true }
    );
    expect(out[0].attachments).toHaveLength(2);
  });

  it("ファイルだけ（テキスト空）のターンも withFiles で残す", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "", attachments: [{ dataUrl: PDF_DATAURL }] }],
      { withFiles: true }
    );
    expect(out).toHaveLength(1);
    expect(out[0].attachments).toHaveLength(1);
  });

  it("旧 boolean API（vision のみ）は従来通り画像を通す", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "x", attachments: [{ dataUrl: PNG_DATAURL }] }],
      true
    );
    expect(out[0].attachments).toHaveLength(1);
    expect(out[0].attachments?.[0].mime).toBe("image/png");
  });
});
