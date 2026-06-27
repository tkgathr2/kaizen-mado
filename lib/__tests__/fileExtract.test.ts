import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  extractDocxText,
  extractXlsxText,
  extractOfficeText,
  MAX_EXTRACT_CHARS,
} from "../fileExtract";

// ── 最小の docx を組み立てる（word/document.xml だけあれば本文は取れる） ──
function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  const xml =
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

// ── 最小の xlsx を組み立てる（sharedStrings + 1シート） ──
function makeXlsx(rows: string[][], sheetName = "データ"): Uint8Array {
  // 共有文字列テーブル
  const uniq: string[] = [];
  const idx = (s: string) => {
    let i = uniq.indexOf(s);
    if (i < 0) {
      i = uniq.length;
      uniq.push(s);
    }
    return i;
  };
  const rowXml = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = String.fromCharCode(65 + ci) + (ri + 1);
          return `<c r="${ref}" t="s"><v>${idx(v)}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const sheetXml =
    `<?xml version="1.0"?><worksheet xmlns="x"><sheetData>${rowXml}</sheetData></worksheet>`;
  const sst =
    `<?xml version="1.0"?><sst xmlns="x">` +
    uniq.map((s) => `<si><t>${s}</t></si>`).join("") +
    `</sst>`;
  const workbook =
    `<?xml version="1.0"?><workbook xmlns="x"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return zipSync({
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/sharedStrings.xml": strToU8(sst),
    "xl/workbook.xml": strToU8(workbook),
  });
}

describe("extractDocxText", () => {
  it("段落本文を抽出する", () => {
    const buf = makeDocx(["こんにちは", "二行目です"]);
    const text = extractDocxText(buf);
    expect(text).toContain("こんにちは");
    expect(text).toContain("二行目です");
  });

  it("XML エスケープを戻す", () => {
    const buf = makeDocx(["A &amp; B &lt;tag&gt;"]);
    const text = extractDocxText(buf);
    expect(text).toContain("A & B <tag>");
  });

  it("zip でない不正バイトは null", () => {
    expect(extractDocxText(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("document.xml が無い zip は null", () => {
    const buf = zipSync({ "other.xml": strToU8("<x/>") });
    expect(extractDocxText(buf)).toBeNull();
  });
});

describe("extractXlsxText", () => {
  it("シート名＋セル値を CSV 様で抽出する", () => {
    const buf = makeXlsx([
      ["氏名", "部署"],
      ["田中", "開発"],
    ]);
    const text = extractXlsxText(buf) ?? "";
    expect(text).toContain("【データ】");
    expect(text).toContain("氏名,部署");
    expect(text).toContain("田中,開発");
  });

  it("カンマを含むセルは CSV エスケープする", () => {
    const buf = makeXlsx([["a,b", "c"]]);
    const text = extractXlsxText(buf) ?? "";
    expect(text).toContain('"a,b",c');
  });

  it("zip でない不正バイトは null", () => {
    expect(extractXlsxText(new Uint8Array([0, 0, 0]))).toBeNull();
  });
});

describe("extractOfficeText（ディスパッチ）", () => {
  it("xlsx MIME は xlsx 抽出へ", () => {
    const buf = makeXlsx([["x", "y"]]);
    const text = extractOfficeText(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buf
    );
    expect(text).toContain("x,y");
  });

  it("docx MIME は docx 抽出へ", () => {
    const buf = makeDocx(["本文テスト"]);
    const text = extractOfficeText(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buf
    );
    expect(text).toContain("本文テスト");
  });

  it("対応外 MIME は null", () => {
    expect(extractOfficeText("application/pdf", new Uint8Array([1]))).toBeNull();
  });
});

describe("抽出上限", () => {
  it("MAX_EXTRACT_CHARS を超えると省略される", () => {
    const big = "あ".repeat(MAX_EXTRACT_CHARS + 5000);
    const buf = makeDocx([big]);
    const text = extractDocxText(buf) ?? "";
    expect(text.length).toBeLessThanOrEqual(MAX_EXTRACT_CHARS + 20);
    expect(text).toContain("（以下省略）");
  });
});

describe("zip 爆弾（zip bomb）対策", () => {
  it("高圧縮率で巨大展開する docx は展開せず null（OOMを許さない）", () => {
    // 高圧縮率：同一バイトの繰り返し（deflate が極端に縮む）。
    // 展開後 ~60MB > 累積上限(30MB) なので filter で弾かれて null になる。
    const huge = strToU8("A".repeat(60 * 1024 * 1024));
    const buf = zipSync({ "word/document.xml": huge });
    // zip 自体は小さい（圧縮後は数十KB程度）ことを確認しておく。
    expect(buf.length).toBeLessThan(10 * 1024 * 1024);
    expect(extractDocxText(buf)).toBeNull();
  });

  it("高圧縮率で巨大展開する xlsx シートも null", () => {
    const hugeSheet = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="x"><sheetData>` +
        "<row><c><v>0</v></c></row>".repeat(0) +
        "B".repeat(60 * 1024 * 1024) +
        `</sheetData></worksheet>`
    );
    const buf = zipSync({
      "xl/worksheets/sheet1.xml": hugeSheet,
      "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst xmlns="x"/>`),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0"?><workbook xmlns="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
      ),
    });
    expect(buf.length).toBeLessThan(10 * 1024 * 1024);
    expect(extractXlsxText(buf)).toBeNull();
  });

  it("OOXML 期待エントリの無い zip は docx として null", () => {
    const buf = zipSync({
      "evil/payload.bin": strToU8("x".repeat(1000)),
      "readme.txt": strToU8("not an ooxml file"),
    });
    expect(extractDocxText(buf)).toBeNull();
  });

  it("OOXML 期待エントリの無い zip は xlsx として null", () => {
    const buf = zipSync({
      "evil/payload.bin": strToU8("x".repeat(1000)),
      "xl/calcChain.xml": strToU8("<calcChain/>"), // sheet ではない
    });
    expect(extractXlsxText(buf)).toBeNull();
  });

  it("正常な docx/xlsx は従来どおり抽出できる（回帰なし）", () => {
    const docx = makeDocx(["回帰テスト本文"]);
    expect(extractDocxText(docx)).toContain("回帰テスト本文");

    const xlsx = makeXlsx([["列A", "列B"]], "回帰");
    const text = extractXlsxText(xlsx) ?? "";
    expect(text).toContain("【回帰】");
    expect(text).toContain("列A,列B");
  });
});
