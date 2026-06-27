import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  validateFileAttachment,
  validateAttachmentsMixed,
  buildFileBlocks,
  isFileAttachment,
  MAX_BYTES_PER_FILE,
  MAX_FILE_ATTACHMENTS,
} from "../attachments";
import type { Attachment } from "../types";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function b64(bytes: number[] | Uint8Array): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}
function dataUrl(mime: string, bytes: number[] | Uint8Array): string {
  return `data:${mime};base64,${b64(bytes)}`;
}
function textDataUrl(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text, "utf-8").toString("base64")}`;
}

// マジックバイト
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // "%PDF-1.4"
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]; // "PK\x03\x04"

function makeDocxBytes(text: string): Uint8Array {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

describe("validateFileAttachment", () => {
  it("PDF（%PDF マジック）は通る", () => {
    const r = validateFileAttachment({ dataUrl: dataUrl("application/pdf", PDF) });
    expect(r.ok).toBe(true);
    expect(r.attachment?.kind).toBe("file");
    expect(r.attachment?.mime).toBe("application/pdf");
  });

  it("テキスト系（csv/txt/md/json）は通る", () => {
    expect(validateFileAttachment({ dataUrl: textDataUrl("text/csv", "a,b\n1,2") }).ok).toBe(true);
    expect(validateFileAttachment({ dataUrl: textDataUrl("text/plain", "hi") }).ok).toBe(true);
    expect(validateFileAttachment({ dataUrl: textDataUrl("text/markdown", "# h") }).ok).toBe(true);
    expect(validateFileAttachment({ dataUrl: textDataUrl("application/json", "{}") }).ok).toBe(true);
  });

  it("xlsx/docx（PK zip マジック）は通る", () => {
    expect(validateFileAttachment({ dataUrl: dataUrl(XLSX_MIME, ZIP) }).ok).toBe(true);
    expect(validateFileAttachment({ dataUrl: dataUrl(DOCX_MIME, ZIP) }).ok).toBe(true);
  });

  it("MIME 偽装：PDF 宣言 × PNG バイトはマジック不一致で弾く", () => {
    const r = validateFileAttachment({ dataUrl: dataUrl("application/pdf", PNG) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("magic-mismatch");
  });

  it("MIME 偽装：xlsx 宣言 × PDF バイト（zip でない）は弾く", () => {
    const r = validateFileAttachment({ dataUrl: dataUrl(XLSX_MIME, PDF) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("magic-mismatch");
  });

  it("対応外 MIME（exe）は unsupported-mime", () => {
    const r = validateFileAttachment({ dataUrl: dataUrl("application/x-msdownload", PDF) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsupported-mime");
  });

  it("画像 MIME はファイル検証では弾く（画像は別経路）", () => {
    const r = validateFileAttachment({ dataUrl: dataUrl("image/png", PNG) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsupported-mime");
  });

  it("10MB 超は too-large（境界）", () => {
    const over = [...PDF, ...new Array(MAX_BYTES_PER_FILE - PDF.length + 1).fill(0)];
    const r = validateFileAttachment({ dataUrl: dataUrl("application/pdf", over) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("too-large");
  });
});

describe("validateAttachmentsMixed", () => {
  it("ファイルは通し、画像は allowImages=false で落とす（既定）", () => {
    const pdf = { dataUrl: dataUrl("application/pdf", PDF) };
    const img = { dataUrl: dataUrl("image/png", PNG) };
    const out = validateAttachmentsMixed([pdf, img]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("file");
  });

  it("allowImages=true なら画像も通す", () => {
    const pdf = { dataUrl: dataUrl("application/pdf", PDF) };
    const img = { dataUrl: dataUrl("image/png", PNG) };
    const out = validateAttachmentsMixed([pdf, img], { allowImages: true });
    expect(out).toHaveLength(2);
  });

  it("点数上限（5点）を超えたら切り捨てる", () => {
    const pdf = { dataUrl: dataUrl("application/pdf", PDF) };
    const arr = new Array(MAX_FILE_ATTACHMENTS + 3).fill(pdf);
    expect(validateAttachmentsMixed(arr).length).toBe(MAX_FILE_ATTACHMENTS);
  });

  it("配列でなければ空配列", () => {
    expect(validateAttachmentsMixed(null)).toEqual([]);
  });
});

describe("buildFileBlocks", () => {
  it("PDF は document ブロックになる", () => {
    const att: Attachment = {
      kind: "file",
      dataUrl: dataUrl("application/pdf", PDF),
      mime: "application/pdf",
      bytes: PDF.length,
    };
    const blocks = buildFileBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("document");
    expect((blocks[0] as any).source.media_type).toBe("application/pdf");
  });

  it("テキスト系は中身を text ブロックに連結する", () => {
    const att: Attachment = {
      kind: "file",
      dataUrl: textDataUrl("text/csv", "氏名,部署\n田中,開発"),
      mime: "text/csv",
      bytes: 10,
      name: "list.csv",
    };
    const blocks = buildFileBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    const text = (blocks[0] as any).text as string;
    expect(text).toContain("【添付ファイル: list.csv】");
    expect(text).toContain("田中,開発");
  });

  it("xlsx は抽出テキストを text ブロックに連結する", () => {
    const xlsxXml = `<?xml version="1.0"?><worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>セル値</t></is></c></row></sheetData></worksheet>`;
    const bytes = zipSync({ "xl/worksheets/sheet1.xml": strToU8(xlsxXml) });
    const att: Attachment = {
      kind: "file",
      dataUrl: dataUrl(XLSX_MIME, bytes),
      mime: XLSX_MIME as Attachment["mime"],
      bytes: bytes.length,
      name: "book.xlsx",
    };
    const blocks = buildFileBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toContain("セル値");
  });

  it("docx は本文を text ブロックに連結する", () => {
    const bytes = makeDocxBytes("ワード本文");
    const att: Attachment = {
      kind: "file",
      dataUrl: dataUrl(DOCX_MIME, bytes),
      mime: DOCX_MIME as Attachment["mime"],
      bytes: bytes.length,
      name: "doc.docx",
    };
    const blocks = buildFileBlocks([att]);
    expect((blocks[0] as any).text).toContain("ワード本文");
  });

  it("抽出不能な office は『読めませんでした』プレースホルダ（落とさない）", () => {
    const bogus = new Uint8Array([1, 2, 3, 4, 5, 6]); // zip ではない
    const att: Attachment = {
      kind: "file",
      dataUrl: dataUrl(XLSX_MIME, bogus),
      mime: XLSX_MIME as Attachment["mime"],
      bytes: bogus.length,
      name: "broken.xlsx",
    };
    const blocks = buildFileBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toContain("読めませんでした");
  });

  it("空/undefined は空配列", () => {
    expect(buildFileBlocks(undefined)).toEqual([]);
    expect(buildFileBlocks([])).toEqual([]);
  });
});

describe("isFileAttachment", () => {
  it("kind:'file' は true", () => {
    expect(isFileAttachment({ kind: "file", dataUrl: "x", mime: "text/csv", bytes: 1 })).toBe(true);
  });
  it("kind:'image' は false", () => {
    expect(isFileAttachment({ kind: "image", dataUrl: "x", mime: "image/png", bytes: 1 })).toBe(false);
  });
  it("kind 省略（旧データ）は MIME から推定", () => {
    expect(isFileAttachment({ dataUrl: dataUrl("application/pdf", PDF), mime: "application/pdf", bytes: 8 })).toBe(true);
    expect(isFileAttachment({ dataUrl: dataUrl("image/png", PNG), mime: "image/png", bytes: 8 })).toBe(false);
  });
});
