import { describe, it, expect } from "vitest";
import {
  validateAttachment,
  validateAttachments,
  buildImageBlocks,
  base64ByteLength,
  MAX_ATTACHMENTS,
  MAX_BYTES_PER_IMAGE,
  MAX_TOTAL_BYTES,
} from "../attachments";
import type { Attachment } from "../types";

// ── マジックバイト付きの最小 base64 を組み立てるヘルパ ──
function b64FromBytes(bytes: number[]): string {
  // Buffer はテスト(Node)で常に使える。
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}
function dataUrl(mime: string, bytes: number[]): string {
  return `data:${mime};base64,${b64FromBytes(bytes)}`;
}

// 各形式の正しいマジックバイト（先頭）。
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0]; // "%PDF-"

describe("validateAttachment（1件の検証）", () => {
  it("png/jpeg/gif/webp は通る", () => {
    expect(validateAttachment({ dataUrl: dataUrl("image/png", PNG) }).ok).toBe(true);
    expect(validateAttachment({ dataUrl: dataUrl("image/jpeg", JPEG) }).ok).toBe(true);
    expect(validateAttachment({ dataUrl: dataUrl("image/gif", GIF) }).ok).toBe(true);
    expect(validateAttachment({ dataUrl: dataUrl("image/webp", WEBP) }).ok).toBe(true);
  });

  it("対応外 MIME（svg）は弾く", () => {
    const r = validateAttachment({ dataUrl: dataUrl("image/svg+xml", PNG) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsupported-mime");
  });

  it("MIME 偽装（png 宣言 × PDF バイト）はマジック不一致で弾く", () => {
    const r = validateAttachment({ dataUrl: dataUrl("image/png", PDF) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("magic-mismatch");
  });

  it("data URL でない文字列は bad-format", () => {
    expect(validateAttachment({ dataUrl: "https://evil/x.png" }).error).toBe("bad-format");
    expect(validateAttachment({ dataUrl: "not a url" }).error).toBe("bad-format");
  });

  it("オブジェクトでない/空は empty", () => {
    expect(validateAttachment(null).error).toBe("empty");
    expect(validateAttachment("x").error).toBe("empty");
  });

  it("5MB 超は too-large で弾く（境界）", () => {
    // 上限ちょうどは通り、+1 バイトで弾く。マジックバイトは png。
    const okBytes = [...PNG, ...new Array(MAX_BYTES_PER_IMAGE - PNG.length).fill(0)];
    expect(validateAttachment({ dataUrl: dataUrl("image/png", okBytes) }).ok).toBe(true);
    const overBytes = [...PNG, ...new Array(MAX_BYTES_PER_IMAGE - PNG.length + 1).fill(0)];
    const over = validateAttachment({ dataUrl: dataUrl("image/png", overBytes) });
    expect(over.ok).toBe(false);
    expect(over.error).toBe("too-large");
  });

  it("0 バイト（base64 空）は empty", () => {
    expect(validateAttachment({ dataUrl: "data:image/png;base64," }).error).toBe("empty");
  });

  it("name はパス区切り・空白を除去して保持する", () => {
    const r = validateAttachment({ dataUrl: dataUrl("image/png", PNG), name: "../etc/p w.png" });
    expect(r.ok).toBe(true);
    // "/"、" "、"-"、"\\" を除去 → "..etcpw.png"
    expect(r.attachment?.name).toBe("..etcpw.png");
  });
});

describe("validateAttachments（配列・枚数/合計）", () => {
  it("枚数上限を超えたら切り捨てる", () => {
    const one = { dataUrl: dataUrl("image/png", PNG) };
    const arr = new Array(MAX_ATTACHMENTS + 2).fill(one);
    expect(validateAttachments(arr).length).toBe(MAX_ATTACHMENTS);
  });

  it("不正な要素は捨て、正しいものだけ残す", () => {
    const ok = { dataUrl: dataUrl("image/png", PNG) };
    const bad = { dataUrl: "nope" };
    expect(validateAttachments([bad, ok, bad]).length).toBe(1);
  });

  it("合計サイズが上限を超える要素はスキップする", () => {
    // 各 ~4MB の画像を3枚 → 合計 12MB > MAX_TOTAL_BYTES(10MB) なので最後はスキップ。
    const big = [...PNG, ...new Array(4 * 1024 * 1024 - PNG.length).fill(0)];
    const item = { dataUrl: dataUrl("image/png", big) };
    const out = validateAttachments([item, item, item]);
    const total = out.reduce((s, a) => s + a.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(out.length).toBe(2);
  });

  it("配列でなければ空配列", () => {
    expect(validateAttachments(null)).toEqual([]);
    expect(validateAttachments("x")).toEqual([]);
  });

  it("無効要素が大量でも上限は入力インデックス基準で効く（増幅DoS対策）", () => {
    // 1万件の無効添付を渡しても、走査は先頭 MAX_ATTACHMENTS 件で打ち切られる。
    // 成功件数基準だと無効要素で out.length が増えず全件走査されてしまう。
    // dataUrl ゲッターのアクセス回数で「実際に検証された件数」を観測する。
    let accessed = 0;
    const evil = Object.defineProperty({}, "dataUrl", {
      get() {
        accessed++;
        return "nope"; // 必ず無効（bad-format）。
      },
      enumerable: true,
    });
    const arr = new Array(10000).fill(evil);
    const out = validateAttachments(arr);
    expect(out.length).toBe(0);
    // 先頭 MAX_ATTACHMENTS 件しか触らない（10000件ではない）。
    expect(accessed).toBeLessThanOrEqual(MAX_ATTACHMENTS);
  });

  it("無効要素を挟んでも有効分はちゃんと残る（上限内）", () => {
    const ok = { dataUrl: dataUrl("image/png", PNG) };
    const bad = { dataUrl: "nope" };
    // 先頭 MAX_ATTACHMENTS 件に有効と無効が混在 → 有効分だけ残る。
    const out = validateAttachments([ok, bad, ok]);
    expect(out.length).toBe(2);
  });
});

describe("buildImageBlocks（Anthropic ブロック組み立て）", () => {
  it("base64 ソースの image ブロックを作る", () => {
    const att: Attachment = {
      dataUrl: dataUrl("image/jpeg", JPEG),
      mime: "image/jpeg",
      bytes: 8,
    };
    const blocks = buildImageBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].source.type).toBe("base64");
    expect(blocks[0].source.media_type).toBe("image/jpeg");
    expect(blocks[0].source.data).toBe(b64FromBytes(JPEG));
  });

  it("undefined/空は空配列", () => {
    expect(buildImageBlocks(undefined)).toEqual([]);
    expect(buildImageBlocks([])).toEqual([]);
  });
});

describe("base64ByteLength", () => {
  it("パディングを考慮してバイト数を返す", () => {
    expect(base64ByteLength(Buffer.from([1, 2, 3]).toString("base64"))).toBe(3);
    expect(base64ByteLength(Buffer.from([1, 2, 3, 4]).toString("base64"))).toBe(4);
    expect(base64ByteLength("")).toBe(0);
  });
});
