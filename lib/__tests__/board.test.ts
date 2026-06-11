import { describe, it, expect } from "vitest";
import {
  groupByState,
  toBoardCard,
  notionUrlFromPageId,
  countByState,
  BOARD_ORDER,
  PIPELINE_STATES,
} from "../board";
import type { TicketRow } from "../tickets";

function row(p: Partial<TicketRow>): TicketRow {
  return {
    pageId: p.pageId ?? "page-1",
    ticketId: p.ticketId ?? "KZ-1",
    system: p.system ?? "カイゼンくん本体",
    type: p.type ?? "改善",
    importance: p.importance ?? "中",
    title: p.title ?? "件名",
    detail: p.detail ?? "内容（機微）",
    reporter: p.reporter ?? "現場フォーム",
    state: p.state ?? "受付",
    fgsUrl: p.fgsUrl ?? null,
    lastEdited: p.lastEdited ?? "2026-06-11T00:00:00.000Z",
  };
}

describe("board", () => {
  it("notionUrlFromPageId はダッシュを除去してURL化する", () => {
    expect(notionUrlFromPageId("37b0d980-8b3b-8148-9721-e1fa84498c34")).toBe(
      "https://www.notion.so/37b0d9808b3b81489721e1fa84498c34"
    );
    expect(notionUrlFromPageId("")).toBe("");
  });

  it("toBoardCard は機微情報(detail)を持たせない", () => {
    const c = toBoardCard(row({ detail: "電話 090-1234-5678" }));
    expect(c).not.toHaveProperty("detail");
    expect(JSON.stringify(c)).not.toContain("090-1234-5678");
    expect(c.ticketId).toBe("KZ-1");
    expect(c.url).toContain("notion.so");
  });

  it("toBoardCard は欠損値をフォールバックする", () => {
    const c = toBoardCard(row({ system: "", title: "", state: "" }));
    expect(c.system).toBe("未特定");
    expect(c.title).toBe("(件名なし)");
    expect(c.state).toBe("未設定");
  });

  it("groupByState は BOARD_ORDER 順で列を返し、空列も残す(includeEmpty)", () => {
    const cols = groupByState([row({ state: "完了" }), row({ state: "受付" })]);
    const states = cols.map((c) => c.state);
    // 先頭は受付（パイプライン順）。完了は受付より後ろ。
    expect(states.indexOf("受付")).toBeLessThan(states.indexOf("完了"));
    // 空のGO待ち列も存在する
    expect(states).toContain("GO待ち");
    expect(cols.find((c) => c.state === "GO待ち")!.cards).toHaveLength(0);
  });

  it("groupByState は同一状態のチケットを同じ列に入力順で積む", () => {
    const cols = groupByState([
      row({ pageId: "a", state: "着手", ticketId: "KZ-1" }),
      row({ pageId: "b", state: "着手", ticketId: "KZ-2" }),
    ]);
    const col = cols.find((c) => c.state === "着手")!;
    expect(col.cards.map((c) => c.ticketId)).toEqual(["KZ-1", "KZ-2"]);
  });

  it("未知の状態は末尾に出現順で追加される", () => {
    const cols = groupByState([row({ state: "謎ステート" })]);
    const states = cols.map((c) => c.state);
    expect(states[states.length - 1]).toBe("謎ステート");
    // 既知の本流より後ろ
    expect(states.indexOf("謎ステート")).toBeGreaterThan(states.indexOf("完了"));
  });

  it("includeEmpty=false なら中身のある列だけ返す", () => {
    const cols = groupByState([row({ state: "GO待ち" })], { includeEmpty: false });
    expect(cols).toHaveLength(1);
    expect(cols[0].state).toBe("GO待ち");
  });

  it("countByState は列ごとの件数を返す", () => {
    const cols = groupByState(
      [row({ state: "着手" }), row({ state: "着手" }), row({ state: "完了" })],
      { includeEmpty: false }
    );
    const counts = countByState(cols);
    expect(counts["着手"]).toBe(2);
    expect(counts["完了"]).toBe(1);
  });

  it("BOARD_ORDER はパイプライン7状態を先頭に含む", () => {
    expect(BOARD_ORDER.slice(0, PIPELINE_STATES.length)).toEqual(PIPELINE_STATES);
    expect(PIPELINE_STATES).toEqual([
      "受付",
      "議論中",
      "GO待ち",
      "着手",
      "実装中",
      "レビュー",
      "完了",
    ]);
  });
});
