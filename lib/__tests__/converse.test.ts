import { describe, it, expect } from "vitest";
import {
  extractTicketId,
  guessSystem,
  guessType,
  guessImportance,
  makeTitle,
  classifyIntent,
  resolveTicket,
  requestToTicket,
  summarizeStatus,
  type ResolveContext,
} from "../converse";
import type { TicketRow } from "../tickets";

function row(over: Partial<TicketRow>): TicketRow {
  return {
    pageId: "page-" + Math.random().toString(36).slice(2),
    ticketId: "KZ-1",
    system: "プロレポ",
    type: "改善",
    importance: "中",
    title: "タイトル",
    detail: "詳細",
    reporter: "現場",
    state: "GO待ち",
    fgsUrl: null,
    ...over,
  };
}

describe("extractTicketId", () => {
  it("KZ-5 をそのまま拾う", () => {
    expect(extractTicketId("GO KZ-5 で")).toBe("KZ-5");
  });
  it("表記ゆれ（KZ5 / KZ－5 / KZ 5）を正規化", () => {
    expect(extractTicketId("KZ5の件")).toBe("KZ-5");
    expect(extractTicketId("KZ－12 却下")).toBe("KZ-12");
    expect(extractTicketId("kz 7 進めて")).toBe("KZ-7");
  });
  it("IDが無ければ null", () => {
    expect(extractTicketId("ステレポのやつ")).toBeNull();
    expect(extractTicketId("")).toBeNull();
    expect(extractTicketId(null)).toBeNull();
  });
});

describe("guessSystem", () => {
  it("正式名で一致", () => {
    expect(guessSystem("ステレポが重い")).toBe("ステレポ");
  });
  it("slug で一致", () => {
    expect(guessSystem("prorepo が遅い")).toBe("プロレポ");
  });
  it("別名・ひらがなで一致", () => {
    expect(guessSystem("ほうこの報告書がおかしい")).toBe("ほうこちゃん");
    expect(guessSystem("見積の金額がずれる")).toBe("見積もりシステム");
  });
  it("特定できなければ null", () => {
    expect(guessSystem("なんかおかしい")).toBeNull();
  });
});

describe("guessType / guessImportance", () => {
  it("バグ語は bug", () => {
    expect(guessType("エラーが出て落ちる")).toBe("bug");
  });
  it("新機能語は 新機能", () => {
    expect(guessType("ボタンを追加して")).toBe("新機能");
  });
  it("既定は 改善", () => {
    expect(guessType("もっと使いやすくして")).toBe("改善");
  });
  it("緊急語は 高", () => {
    expect(guessImportance("至急直して、使えない")).toBe("高");
  });
  it("控えめ語は 低", () => {
    expect(guessImportance("いつか余裕があれば")).toBe("低");
  });
  it("既定は 中", () => {
    expect(guessImportance("これ直して")).toBe("中");
  });
});

describe("makeTitle", () => {
  it("最初の文を件名にする", () => {
    expect(makeTitle("一覧が重い。あとログインも遅い")).toBe("一覧が重い");
  });
  it("長文は40字で切る", () => {
    const long = "あ".repeat(60);
    expect(makeTitle(long).length).toBe(40);
  });
  it("空なら既定文言", () => {
    expect(makeTitle("")).toBe("改善のご要望");
  });
});

describe("classifyIntent", () => {
  it("ID付きGOは command/go", () => {
    const r = classifyIntent("KZ-5 進めて");
    expect(r.intent).toBe("command");
    expect(r.refAction).toBe("go");
    expect(r.ticketId).toBe("KZ-5");
  });
  it("参照語付き却下は command/reject（ID無し）", () => {
    const r = classifyIntent("さっきのやつ却下で");
    expect(r.intent).toBe("command");
    expect(r.refAction).toBe("reject");
    expect(r.ticketId).toBeNull();
  });
  it("システム名付き修正指示は command/fix", () => {
    const r = classifyIntent("ステレポのやつ修正して");
    expect(r.intent).toBe("command");
    expect(r.refAction).toBe("fix");
  });
  it("状況質問は status", () => {
    expect(classifyIntent("今どうなってる？").intent).toBe("status");
    expect(classifyIntent("詰まってるのある？").intent).toBe("status");
  });
  it("要望は request で抽出が埋まる", () => {
    const r = classifyIntent("ステレポの一覧が重いので直して");
    expect(r.intent).toBe("request");
    expect(r.request?.system).toBe("ステレポ");
    expect(r.request?.type).toBe("改善");
    expect(r.request?.title).toContain("ステレポ");
  });
  it("バグ要望は type=bug", () => {
    const r = classifyIntent("プロレポでエラーが出て落ちる");
    expect(r.intent).toBe("request");
    expect(r.request?.type).toBe("bug");
  });
  it("参照語の無い裸のGO（go単体）は command にしない＝雑談扱い", () => {
    // 「ok」だけ等、何を指すか不明なものは勝手に進めない（誤爆防止）。
    const r = classifyIntent("おはよう");
    expect(r.intent).toBe("chat");
  });
  it("ID+状況語は status（操作と取り違えない）", () => {
    const r = classifyIntent("KZ-3 ってどうなってる？");
    expect(r.intent).toBe("status");
    expect(r.ticketId).toBe("KZ-3");
  });
});

describe("resolveTicket", () => {
  const goA = row({ ticketId: "KZ-5", system: "ステレポ", pageId: "p-a" });
  const goB = row({ ticketId: "KZ-6", system: "プロレポ", pageId: "p-b" });
  const recentC = row({ ticketId: "KZ-2", system: "ほうこちゃん", state: "完了", pageId: "p-c" });

  const ctx: ResolveContext = { goMachi: [goA, goB], recent: [goA, goB, recentC] };

  it("① ID一致が最優先", () => {
    const r = resolveTicket("KZ-6 却下", "KZ-6", ctx);
    expect(r.via).toBe("id");
    expect(r.ticket?.ticketId).toBe("KZ-6");
  });

  it("② quotedMessageId で特定", () => {
    const r = resolveTicket("これ却下", null, { ...ctx, quotedMap: { msg99: "KZ-5" } }, "msg99");
    expect(r.via).toBe("quoted");
    expect(r.ticket?.ticketId).toBe("KZ-5");
  });

  it("③ システム名で一意に特定", () => {
    const r = resolveTicket("ステレポのやつGO", null, ctx);
    expect(r.via).toBe("system");
    expect(r.ticket?.ticketId).toBe("KZ-5");
  });

  it("③ 同システム複数なら ambiguous（確認候補）", () => {
    const dupSys: ResolveContext = {
      goMachi: [row({ ticketId: "KZ-5", system: "ステレポ", pageId: "x" }), row({ ticketId: "KZ-8", system: "ステレポ", pageId: "y" })],
      recent: [],
    };
    const r = resolveTicket("ステレポのやつ却下", null, dupSys);
    expect(r.ticket).toBeNull();
    expect(r.ambiguous?.ticketId).toBe("KZ-5");
  });

  it("④ 参照語のみ＋GO待ち1件ならそれに当てる", () => {
    const one: ResolveContext = { goMachi: [goA], recent: [goA] };
    const r = resolveTicket("さっきのやつGO", null, one);
    expect(r.via).toBe("single");
    expect(r.ticket?.ticketId).toBe("KZ-5");
  });

  it("④ 参照語のみ＋GO待ち複数なら ambiguous", () => {
    const r = resolveTicket("さっきの却下", null, ctx);
    expect(r.ticket).toBeNull();
    expect(r.ambiguous).not.toBeNull();
  });

  it("特定不能なら via=none", () => {
    const r = resolveTicket("なんとなく", null, { goMachi: [], recent: [] });
    expect(r.via).toBe("none");
    expect(r.ticket).toBeNull();
  });

  it("quotedMap がヒットしなければ後続にフォールバック（システム名）", () => {
    const r = resolveTicket("ステレポGO", null, { ...ctx, quotedMap: { other: "KZ-6" } }, "missing");
    expect(r.via).toBe("system");
    expect(r.ticket?.ticketId).toBe("KZ-5");
  });
});

describe("requestToTicket", () => {
  it("未知システムは『その他』に丸める", () => {
    const t = requestToTicket({ system: "謎システム", title: "件名", detail: "詳細", type: "改善", importance: "中" });
    expect(t.system).toBe("その他");
  });
  it("既知システムはそのまま", () => {
    const t = requestToTicket({ system: "ステレポ", title: "件名", detail: "詳細", type: "bug", importance: "高" });
    expect(t.system).toBe("ステレポ");
    expect(t.type).toBe("bug");
    expect(t.importance).toBe("高");
  });
  it("system=null は『その他』", () => {
    const t = requestToTicket({ system: null, title: "x", detail: "y", type: "改善", importance: "中" });
    expect(t.system).toBe("その他");
  });
});

describe("summarizeStatus", () => {
  it("GO待ちと最近の案件を文章化", () => {
    const ctx: ResolveContext = {
      goMachi: [row({ ticketId: "KZ-5", system: "ステレポ", title: "一覧が重い", pageId: "g1" })],
      recent: [
        row({ ticketId: "KZ-5", system: "ステレポ", pageId: "g1" }),
        row({ ticketId: "KZ-2", system: "ほうこちゃん", state: "完了", title: "PDF崩れ", pageId: "r1" }),
      ],
    };
    const s = summarizeStatus(ctx);
    expect(s).toContain("GO待ち（社長の判断待ち）が1件");
    expect(s).toContain("KZ-5");
    expect(s).toContain("最近動いた案件");
    expect(s).toContain("KZ-2");
    // GO待ちは「最近」側で重複表示しない
    expect(s.match(/KZ-5/g)?.length).toBe(1);
  });
  it("GO待ちゼロのとき明示", () => {
    const s = summarizeStatus({ goMachi: [], recent: [] });
    expect(s).toContain("GO待ち（社長の判断待ち）はありません");
  });
});
