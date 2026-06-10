import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  lineEnabled,
  isAuthorizedUser,
  verifyLineSignature,
  proposalToken,
  verifyProposalToken,
  parsePostback,
  parseTextCommand,
  buildProposalText,
} from "../line";
import type { TicketRow } from "../tickets";
import type { DiscussResult } from "../discuss";

const SECRET = "test-channel-secret";
const USER = "U1234567890abcdef";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("line（純関数）", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      tok: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      sec: process.env.LINE_CHANNEL_SECRET,
      uid: process.env.LINE_TARGET_USER_ID,
    };
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.LINE_CHANNEL_SECRET = SECRET;
    process.env.LINE_TARGET_USER_ID = USER;
  });

  afterEach(() => {
    for (const [k, envk] of [
      ["tok", "LINE_CHANNEL_ACCESS_TOKEN"],
      ["sec", "LINE_CHANNEL_SECRET"],
      ["uid", "LINE_TARGET_USER_ID"],
    ] as const) {
      if (saved[k] === undefined) delete process.env[envk];
      else process.env[envk] = saved[k]!;
    }
  });

  it("lineEnabled は3鍵が揃ったときだけ true", () => {
    expect(lineEnabled()).toBe(true);
    delete process.env.LINE_TARGET_USER_ID;
    expect(lineEnabled()).toBe(false);
  });

  it("isAuthorizedUser は本人のみ true", () => {
    expect(isAuthorizedUser(USER)).toBe(true);
    expect(isAuthorizedUser("Uother")).toBe(false);
    expect(isAuthorizedUser(null)).toBe(false);
    expect(isAuthorizedUser(undefined)).toBe(false);
  });

  it("verifyLineSignature は正しい署名のみ true", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(body, sign(body))).toBe(true);
    expect(verifyLineSignature(body, sign(body, "wrong-secret"))).toBe(false);
    expect(verifyLineSignature(body, null)).toBe(false);
    expect(verifyLineSignature(body, "garbage")).toBe(false);
  });

  it("proposalToken / verifyProposalToken は往復一致、別pageId・改ざんは false", () => {
    const pid = "page-abc-123";
    const tk = proposalToken(pid);
    expect(tk).toHaveLength(16);
    expect(verifyProposalToken(pid, tk)).toBe(true);
    expect(verifyProposalToken("other-page", tk)).toBe(false);
    expect(verifyProposalToken(pid, tk.slice(0, 15) + "0")).toBe(false);
    expect(verifyProposalToken(pid, "")).toBe(false);
  });

  it("parsePostback は kz/pid/tk を抽出、不正は null", () => {
    const tk = proposalToken("p1");
    expect(parsePostback(`kz=go&pid=p1&tk=${tk}`)).toEqual({ action: "go", pageId: "p1", token: tk });
    expect(parsePostback("kz=fix&pid=p2&tk=x")).toEqual({ action: "fix", pageId: "p2", token: "x" });
    expect(parsePostback("kz=reject&pid=p3&tk=x")?.action).toBe("reject");
    expect(parsePostback("kz=unknown&pid=p1&tk=x")).toBeNull();
    expect(parsePostback("pid=p1&tk=x")).toBeNull(); // kzなし
    expect(parsePostback("kz=go&tk=x")).toBeNull(); // pidなし
    expect(parsePostback(null)).toBeNull();
  });

  it("parseTextCommand：GO/却下/修正を判定、雑談は null", () => {
    expect(parseTextCommand("GO KZ-12")).toEqual({ action: "go", ticketId: "KZ-12" });
    expect(parseTextCommand("ok kz-7")).toEqual({ action: "go", ticketId: "KZ-7" });
    expect(parseTextCommand("却下 KZ-3")).toEqual({ action: "reject", ticketId: "KZ-3" });
    expect(parseTextCommand("修正して")).toEqual({ action: "fix", ticketId: null });
    expect(parseTextCommand("GO")).toEqual({ action: "go", ticketId: null });
    expect(parseTextCommand("今日は寒いね")).toBeNull();
    expect(parseTextCommand("")).toBeNull();
    expect(parseTextCommand(null)).toBeNull();
  });

  it("buildProposalText はID・対象・推奨・返信ガイドを含む", () => {
    const ticket = {
      pageId: "p1",
      ticketId: "KZ-12",
      system: "プロレポ",
      type: "改善",
      importance: "高",
      title: "一覧が重い",
      detail: "...",
      reporter: "現場",
      state: "GO待ち",
      fgsUrl: null,
    } as TicketRow;
    const d: DiscussResult = {
      houshin: "ページングを導入",
      kousuu: "1〜2日",
      risks: ["既存ソート互換"],
      recommendation: "GO推奨",
      goDraft: "...",
      source: "claude",
    };
    const text = buildProposalText(ticket, d);
    expect(text).toContain("KZ-12");
    expect(text).toContain("プロレポ");
    expect(text).toContain("GO推奨");
    expect(text).toContain("GO KZ-12");
  });
});
