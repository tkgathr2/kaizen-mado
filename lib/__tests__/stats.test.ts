import { describe, expect, it } from "vitest";
import {
  aggregateTickets,
  maskReporterName,
  maskStatsReporters,
  type StatsRow,
} from "@/lib/stats";

// 固定の「今」：2026-06-11(木) 12:00 JST想定（ローカルタイムで生成）
const NOW = new Date(2026, 5, 11, 12, 0, 0);

function row(over: Partial<StatsRow>): StatsRow {
  return {
    ticketId: "KZ-1",
    title: "テスト",
    system: "ほうこちゃん",
    type: "改善",
    importance: "中",
    state: "受付",
    reporter: "高木",
    createdTime: new Date(2026, 5, 10).toISOString(),
    learned: false,
    ...over,
  };
}

describe("aggregateTickets", () => {
  it("空配列でも落ちず0で埋まる", () => {
    const s = aggregateTickets([], NOW);
    expect(s.total).toBe(0);
    expect(s.doneRate).toBe(0);
    expect(s.weekly).toHaveLength(8);
    expect(s.funnel.map((f) => f.stage)).toEqual([
      "受付",
      "検討・提案中",
      "改修中",
      "完了",
      "見送り",
    ]);
  });

  it("今週・今月・完了率を正しく数える", () => {
    const rows = [
      row({ createdTime: new Date(2026, 5, 9).toISOString(), state: "完了", learned: true }), // 今週(月曜6/8〜)・今月
      row({ createdTime: new Date(2026, 5, 2).toISOString(), state: "着手" }), // 先週・今月
      row({ createdTime: new Date(2026, 4, 20).toISOString(), state: "受付" }), // 先月
      row({ createdTime: new Date(2026, 4, 21).toISOString(), state: "却下" }), // 先月
    ];
    const s = aggregateTickets(rows, NOW);
    expect(s.total).toBe(4);
    expect(s.thisWeek).toBe(1);
    expect(s.thisMonth).toBe(2);
    expect(s.done).toBe(1);
    expect(s.doneRate).toBe(25);
    expect(s.learned).toBe(1);
  });

  it("週次バケットが正しい位置に入る（直近週が末尾）", () => {
    const rows = [
      row({ createdTime: new Date(2026, 5, 9).toISOString() }), // 今週 → 末尾
      row({ createdTime: new Date(2026, 5, 3).toISOString() }), // 先週 → 末尾-1
      row({ createdTime: new Date(2026, 3, 1).toISOString() }), // 8週より前 → どこにも入らない
    ];
    const s = aggregateTickets(rows, NOW);
    expect(s.weekly[7].count).toBe(1);
    expect(s.weekly[6].count).toBe(1);
    expect(s.weekly.reduce((a, w) => a + w.count, 0)).toBe(2);
  });

  it("ファネルは状態を段へ正しく割り付ける（GO待ち/差し戻し=検討・提案中、未知=検討・提案中）", () => {
    const rows = [
      row({ state: "受付" }),
      row({ state: "GO待ち" }),
      row({ state: "差し戻し" }),
      row({ state: "着手" }),
      row({ state: "完了" }),
      row({ state: "却下" }),
      row({ state: "謎の状態" }),
    ];
    const s = aggregateTickets(rows, NOW);
    const byStage = Object.fromEntries(s.funnel.map((f) => [f.stage, f.count]));
    expect(byStage["受付"]).toBe(1);
    expect(byStage["検討・提案中"]).toBe(3);
    expect(byStage["改修中"]).toBe(1);
    expect(byStage["完了"]).toBe(1);
    expect(byStage["見送り"]).toBe(1);
  });

  it("状態名「議論中」が検討・提案中へ集計される（旧バグ：「議論」で拾い漏れていた回帰防止）", () => {
    const rows = [
      row({ state: "議論中" }),
      row({ state: "議論中" }),
      row({ state: "実装中" }), // 改修中に入る（旧 STAGE_OF には無かった状態）
      row({ state: "レビュー" }), // 同上
    ];
    const s = aggregateTickets(rows, NOW);
    const byStage = Object.fromEntries(s.funnel.map((f) => [f.stage, f.count]));
    expect(byStage["検討・提案中"]).toBe(2); // 議論中×2
    expect(byStage["改修中"]).toBe(2); // 実装中＋レビュー
  });

  it("システム別とrecent（新しい順・最大10件）", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        ticketId: `KZ-${i}`,
        system: i % 2 ? "プロレポ" : "ほうこちゃん",
        state: i % 3 === 0 ? "完了" : "受付",
        createdTime: new Date(2026, 5, 1 + (i % 9), i).toISOString(),
      })
    );
    const s = aggregateTickets(rows, NOW);
    expect(s.bySystem.reduce((a, x) => a + x.total, 0)).toBe(12);
    expect(s.recent).toHaveLength(10);
    const times = s.recent.map((r) => Date.parse(r.createdTime));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("起票者(PII)マスキング", () => {
  it("maskReporterName は先頭1文字＋伏字（空は空）", () => {
    expect(maskReporterName("高木 篤宏")).toBe("高***");
    expect(maskReporterName("Wakimoto")).toBe("W***");
    expect(maskReporterName(" 脇本 ")).toBe("脇***"); // 前後空白除去
    expect(maskReporterName("")).toBe("");
    expect(maskReporterName("   ")).toBe("");
  });

  it("maskStatsReporters は recent の reporter だけ伏せ、集計値は不変・非破壊", () => {
    const base = aggregateTickets([
      row({ ticketId: "KZ-1", reporter: "高木 篤宏", createdTime: new Date(2026, 5, 10).toISOString() }),
      row({ ticketId: "KZ-2", reporter: "脇本", state: "完了", createdTime: new Date(2026, 5, 9).toISOString() }),
    ], NOW);
    const masked = maskStatsReporters(base);
    expect(masked.recent.map((r) => r.reporter)).toEqual(["高***", "脇***"]);
    // 集計値（total/done/doneRate）は変わらない。
    expect(masked.total).toBe(base.total);
    expect(masked.done).toBe(base.done);
    expect(masked.doneRate).toBe(base.doneRate);
    // 非破壊：元の base は生のまま。
    expect(base.recent.some((r) => r.reporter.includes("***"))).toBe(false);
  });
});
