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
    // 読みやすさ改修（2026-06-12）：返信ガイド1行化＋Notion詳細リンク
    expect(text).toContain("GO KZ-12／修正 KZ-12／却下 KZ-12");
    expect(text).toContain("https://www.notion.so/p1");
  });
});

import { truncateForLine, notionPageUrl } from "../line";

describe("文面ヘルパ", () => {
  it("truncateForLine は改行を潰して max 文字に丸める", () => {
    expect(truncateForLine("あいうえお", 10)).toBe("あいうえお");
    expect(truncateForLine("あい\nうえ  お", 10)).toBe("あい うえ お");
    expect(truncateForLine("あいうえおかきくけこさ", 10)).toBe("あいうえおかきくけ…");
    expect(truncateForLine(null, 5)).toBe("");
  });
  it("notionPageUrl はハイフン無しのURLを返す", () => {
    expect(notionPageUrl("37b0d980-8b3b-8148-9721-e1fa84498c34")).toBe(
      "https://www.notion.so/37b0d9808b3b81489721e1fa84498c34"
    );
  });
});

import { stageBar } from "../line";

describe("工程ステッパー stageBar", () => {
  it("いまの工程を🔵、過去を✅、未来を・で示す（全6工程）", () => {
    const bar = stageBar(4);
    // ①声②提案③GO は完了、④着手がいまここ、⑤PR⑥反映はこれから
    expect(bar).toContain("✅声");
    expect(bar).toContain("✅提案");
    expect(bar).toContain("✅GO");
    expect(bar).toContain("🔵着手");
    expect(bar).toContain("・PR");
    expect(bar).toContain("・反映");
  });
  it("最終工程(6=反映)は全完了の手前まで✅、反映が🔵", () => {
    const bar = stageBar(6);
    expect(bar).toContain("✅PR");
    expect(bar).toContain("🔵反映");
    expect(bar).not.toContain("・");
  });
  it("提案文(stage2)には工程バーと全体像リンクが入る", () => {
    const t = {
      pageId: "p1", ticketId: "KZ-20", system: "プロレポ", type: "改善",
      importance: "低", title: "x", detail: "y", reporter: "現場",
      state: "GO待ち", fgsUrl: null,
    } as TicketRow;
    const d: DiscussResult = { houshin: "a", kousuu: "b", risks: [], recommendation: "GO推奨", goDraft: "", source: "claude" };
    const text = buildProposalText(t, d);
    expect(text).toContain("📍");
    expect(text).toContain("🔵提案");
    expect(text).toContain("/board");
  });
});
