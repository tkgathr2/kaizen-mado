import { describe, it, expect } from "vitest";
import {
  resolveMime,
  checkAttachOne,
  attachErrorMessage,
  isImageMime,
  isFileMime,
  fileIcon,
  ATTACH_ACCEPT,
  UX_MAX_ATTACHMENTS,
  UX_MAX_BYTES_PER_FILE,
  UX_MAX_TOTAL_BYTES,
} from "../attachUx";

describe("resolveMime", () => {
  it("画像 MIME はそのまま通す", () => {
    expect(resolveMime("image/png", "a.png")).toBe("image/png");
  });
  it("空の type は拡張子から補完（.md→markdown / .csv→csv）", () => {
    expect(resolveMime("", "log.md")).toBe("text/markdown");
    expect(resolveMime("", "data.csv")).toBe("text/csv");
    expect(resolveMime("", "doc.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });
  it("既に許可済みの type（text/plain）はそのまま通す（拡張子で上書きしない）", () => {
    // text/plain は許可リストにあるので早期に通す（サーバ側も受理する）。
    expect(resolveMime("text/plain", "readme.md")).toBe("text/plain");
  });
  it("未知の拡張子は元の type を返す", () => {
    expect(resolveMime("application/x-foo", "x.foo")).toBe("application/x-foo");
  });
});

describe("isImageMime / isFileMime", () => {
  it("画像とファイルを正しく振り分ける", () => {
    expect(isImageMime("image/jpeg")).toBe(true);
    expect(isFileMime("application/pdf")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isFileMime("image/png")).toBe(false);
  });
});

describe("checkAttachOne", () => {
  it("通常の画像はOK（kind:image）", () => {
    const r = checkAttachOne({ type: "image/png", name: "a.png", size: 1000 }, 0, 0);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("image");
  });
  it("PDF はOK（kind:file）", () => {
    const r = checkAttachOne({ type: "application/pdf", name: "a.pdf", size: 1000 }, 0, 0);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("file");
  });
  it("点数オーバーは slots エラー", () => {
    const r = checkAttachOne(
      { type: "image/png", name: "a.png", size: 10 },
      UX_MAX_ATTACHMENTS,
      0
    );
    expect(r).toEqual({ ok: false, error: "slots" });
  });
  it("種別外は unsupported エラー", () => {
    const r = checkAttachOne({ type: "application/x-msdownload", name: "v.exe", size: 10 }, 0, 0);
    expect(r).toEqual({ ok: false, error: "unsupported" });
  });
  it("1ファイル上限超過は too-large", () => {
    const r = checkAttachOne(
      { type: "application/pdf", name: "big.pdf", size: UX_MAX_BYTES_PER_FILE + 1 },
      0,
      0
    );
    expect(r).toEqual({ ok: false, error: "too-large" });
  });
  it("合計上限超過は total", () => {
    const r = checkAttachOne(
      { type: "application/pdf", name: "b.pdf", size: 5 * 1024 * 1024 },
      0,
      UX_MAX_TOTAL_BYTES - 1
    );
    expect(r).toEqual({ ok: false, error: "total" });
  });
});

describe("attachErrorMessage", () => {
  it("各エラーに日本語メッセージがある", () => {
    for (const e of ["slots", "unsupported", "too-large", "total"] as const) {
      expect(attachErrorMessage(e).length).toBeGreaterThan(0);
    }
  });
});

describe("fileIcon", () => {
  it("PDF は 📕、それ以外も絵文字を返す", () => {
    expect(fileIcon("application/pdf")).toBe("📕");
    expect(fileIcon("text/csv")).toBe("📊");
    expect(fileIcon("text/plain").length).toBeGreaterThan(0);
  });
});

describe("ATTACH_ACCEPT", () => {
  it("画像とファイルの両方の拡張子を含む", () => {
    expect(ATTACH_ACCEPT).toContain("image/png");
    expect(ATTACH_ACCEPT).toContain(".pdf");
    expect(ATTACH_ACCEPT).toContain(".xlsx");
    expect(ATTACH_ACCEPT).toContain(".docx");
    expect(ATTACH_ACCEPT).toContain(".csv");
  });
});
