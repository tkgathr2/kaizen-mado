import { describe, it, expect } from "vitest";
import { selectOverdue, buildGoWaitAlertText } from "../goWaitAlert";
import type { TicketRow } from "../tickets";

function row(p: Partial<TicketRow>): TicketRow {
  return {
    pageId: p.pageId ?? "37b0d980-8b3b-8148-9721-e1fa84498c34",
    ticketId: p.ticketId ?? "KZ-1",
    system: p.system ?? "カイゼンくん本体",
    type: p.type ?? "改善",
    importance: p.importance ?? "中",
    title: p.title ?? "件名",
    detail: p.detail ?? "内容",
    reporter: p.reporter ?? "現場フォーム",
    state: p.state ?? "GO待ち",
    fgsUrl: p.fgsUrl ?? null,
    ...p,
  };
}

const NOW = Date.parse("2026-07-08T00:00:00.000Z");

describe("goWaitAlert.selectOverdue", () => {
  it("statusChangedAtが24時間超過なら抽出する", () => {
    const rows = [
      row({ ticketId: "KZ-1", statusChangedAt: "2026-07-06T00:00:00.000Z" }), // 48h
    ];
    const out = selectOverdue(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].ticket.ticketId).toBe("KZ-1");
    expect(out[0].waitHours).toBe(48);
  });

  it("24時間未満は除外する", () => {
    const rows = [
      row({ ticketId: "KZ-2", statusChangedAt: "2026-07-07T12:00:00.000Z" }), // 12h
    ];
    expect(selectOverdue(rows, NOW)).toHaveLength(0);
  });

  it("statusChangedAt未設定はcreatedTime→lastEditedへフォールバックする", () => {
    const rows = [
      row({ ticketId: "KZ-3", createdTime: "2026-07-05T00:00:00.000Z" }), // 72h
      row({ ticketId: "KZ-4", lastEdited: "2026-07-06T00:00:00.000Z" }), // 48h
    ];
    const out = selectOverdue(rows, NOW);
    expect(out.map((o) => o.ticket.ticketId)).toEqual(["KZ-3", "KZ-4"]);
  });

  it("起点が一切無ければ判定せず除外する（安全側）", () => {
    const rows = [row({ ticketId: "KZ-5" })];
    expect(selectOverdue(rows, NOW)).toHaveLength(0);
  });

  it("待機時間の長い順にソートする", () => {
    const rows = [
      row({ ticketId: "KZ-A", statusChangedAt: "2026-07-06T00:00:00.000Z" }), // 48h
      row({ ticketId: "KZ-B", statusChangedAt: "2026-07-04T00:00:00.000Z" }), // 96h
    ];
    const out = selectOverdue(rows, NOW);
    expect(out.map((o) => o.ticket.ticketId)).toEqual(["KZ-B", "KZ-A"]);
  });
});

describe("goWaitAlert.buildGoWaitAlertText", () => {
  it("空なら空文字を返す（投稿しない合図）", () => {
    expect(buildGoWaitAlertText([])).toBe("");
  });

  it("件数・重要度・待機時間・NotionリンクをSlack本文に含める", () => {
    const text = buildGoWaitAlertText([
      { ticket: row({ ticketId: "KZ-9", importance: "高" }), waitHours: 30 },
    ]);
    expect(text).toContain("1件");
    expect(text).toContain("KZ-9");
    expect(text).toContain("重要度:高");
    expect(text).toContain("待機30h");
    expect(text).toContain("https://www.notion.so/37b0d9808b3b81489721e1fa84498c34");
  });

  it("氏名っぽいタイトルはPIIマスクされる", () => {
    const text = buildGoWaitAlertText([
      { ticket: row({ title: "田中太郎さんから連絡" }), waitHours: 25 },
    ]);
    expect(text).not.toContain("田中太郎さん");
    expect(text).toContain("[氏名]");
  });
});
