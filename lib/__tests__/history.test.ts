import { describe, it, expect } from "vitest";
import { sanitizeHistory } from "../history";

const PNG_DATAURL =
  "data:image/png;base64," +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe("sanitizeHistory（画像ゲート）", () => {
  it("vision OFF のとき attachments を捨てる（回帰ゼロ）", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "これ見て", attachments: [{ dataUrl: PNG_DATAURL }] }],
      false
    );
    expect(out).toHaveLength(1);
    expect(out[0].attachments).toBeUndefined();
    expect(out[0].content).toBe("これ見て");
  });

  it("vision ON のとき検証済み attachments を通す", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "これ見て", attachments: [{ dataUrl: PNG_DATAURL }] }],
      true
    );
    expect(out[0].attachments).toHaveLength(1);
    expect(out[0].attachments?.[0].mime).toBe("image/png");
  });

  it("vision ON でも不正な添付は除去される", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "x", attachments: [{ dataUrl: "https://evil/x.png" }] }],
      true
    );
    expect(out[0].attachments).toBeUndefined();
  });

  it("vision ON で画像だけ（テキスト空）のターンも残す", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "", attachments: [{ dataUrl: PNG_DATAURL }] }],
      true
    );
    expect(out).toHaveLength(1);
    expect(out[0].attachments).toHaveLength(1);
  });

  it("vision OFF で画像だけ（テキスト空）のターンは捨てる（残すべき内容が無い）", () => {
    const out = sanitizeHistory(
      [{ role: "user", content: "", attachments: [{ dataUrl: PNG_DATAURL }] }],
      false
    );
    expect(out).toHaveLength(0);
  });

  it("assistant ターンには attachments を付けない", () => {
    const out = sanitizeHistory(
      [{ role: "assistant", content: "はい", attachments: [{ dataUrl: PNG_DATAURL }] }],
      true
    );
    expect(out[0].attachments).toBeUndefined();
  });

  it("従来どおり content は 4000 字でスライスされ、配列でなければ空", () => {
    const long = "あ".repeat(5000);
    const out = sanitizeHistory([{ role: "user", content: long }], false);
    expect(out[0].content.length).toBe(4000);
    expect(sanitizeHistory(null, true)).toEqual([]);
  });

  it("10万件送られても末尾30件しか結果に残らない（早期 slice DoS 対策）", () => {
    // 10万件の messages を生成 → sanitizeHistory は内部で slice(-31) してからループするので
    // 最終出力は最大 30 件（slice(-30) 後）に収まる。
    const many = Array.from({ length: 100_000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg${i}`,
    }));
    const out = sanitizeHistory(many, false);
    expect(out.length).toBeLessThanOrEqual(30);
    // 末尾側のメッセージが残っていることを確認（先頭が切られている）。
    expect(out[out.length - 1].content).toBe("msg99999");
  });
});
