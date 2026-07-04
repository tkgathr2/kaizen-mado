// ── 鍵未投入（認証OFF）時の fail-close 検証 ──
// 監査 2026-07-04 HIGH: 以前は isAuthEnabled()=false のとき一律 next() で管理系まで
// 無認証全公開に落ちていた。修正後は「公開窓口は素通し／管理系は 503」で閉じることを固定する。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// @/auth（next-auth 初期化）は重いのでモック。鍵未投入分岐は auth ラッパに触れないため、
// このモックが呼ばれないこと自体も暗黙の検証になる。
vi.mock("@/auth", () => ({
  auth: (handler: unknown) => handler,
}));

import middleware from "../../middleware";

const OLD_ENV = process.env;

function reqFor(path: string): NextRequest {
  return new NextRequest(new URL(`https://kaizen.takagi.bz${path}`));
}

const ev = {} as never;

describe("middleware：鍵未投入（認証OFF）時の fail-close", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    // 3鍵をすべて空にして認証OFF状態を作る
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_SECRET;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("管理ページ /dashboard は 503 で閉じる（無認証公開しない）", async () => {
    const res = await middleware(reqFor("/dashboard"), ev);
    expect(res?.status).toBe(503);
  });

  it("管理ページ /board も 503 で閉じる", async () => {
    const res = await middleware(reqFor("/board"), ev);
    expect(res?.status).toBe(503);
  });

  it("管理データAPI /api/board・/api/stats も 503 で閉じる", async () => {
    expect((await middleware(reqFor("/api/board"), ev))?.status).toBe(503);
    expect((await middleware(reqFor("/api/stats"), ev))?.status).toBe(503);
  });

  it("社長のLINE会話を返す /api/kaizen/ticket・context も 503 で閉じる", async () => {
    expect(
      (await middleware(reqFor("/api/kaizen/ticket/abc"), ev))?.status
    ).toBe(503);
    expect(
      (await middleware(reqFor("/api/kaizen/context/KZ-1"), ev))?.status
    ).toBe(503);
  });

  it("公開窓口 / は素通し（掲示中の窓口を止めない）", async () => {
    const res = await middleware(reqFor("/"), ev);
    // NextResponse.next() は 200 相当（x-middleware-next ヘッダ付き）
    expect(res?.status).toBe(200);
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("起票導線 /api/chat・/api/submit も素通し", async () => {
    const chat = await middleware(reqFor("/api/chat"), ev);
    const submit = await middleware(reqFor("/api/submit"), ev);
    expect(chat?.headers.get("x-middleware-next")).toBe("1");
    expect(submit?.headers.get("x-middleware-next")).toBe("1");
  });
});
