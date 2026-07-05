// ── /board 滞留判定・要対応サマリー（ヒーローバー）のテスト ──
// isCardStalled / isSameLocalDay / heroSummary は now を引数で受ける純粋関数。
// 正常・境界（ちょうど閾値）・不正ISO・lastEdited無し を網羅する。
import { describe, it, expect } from "vitest";
import {
  isCardStalled,
  isSameLocalDay,
  heroSummary,
  groupByState,
  STALL_ACTIVE_MS,
  STALL_GO_WAIT_MS,
  STALL_ACTIVE_STATES,
} from "../board";
import type { TicketRow } from "../tickets";

// 基準時刻（テスト内固定）。
const NOW = new Date("2026-07-05T12:00:00.000Z").getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function isoBefore(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

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
    lastEdited: p.lastEdited ?? isoBefore(5 * MIN),
    ...(p.statusChangedAt ? { statusChangedAt: p.statusChangedAt } : {}),
  };
}

describe("isCardStalled（着手・実装中＝30分超で停滞）", () => {
  it("定数が仕様どおり（30分・48時間・対象状態）", () => {
    expect(STALL_ACTIVE_MS).toBe(30 * MIN);
    expect(STALL_GO_WAIT_MS).toBe(48 * HOUR);
    expect(STALL_ACTIVE_STATES).toEqual(["着手", "実装中"]);
  });

  it("着手が31分経過 → 停滞（分表示）", () => {
    const r = isCardStalled("着手", isoBefore(31 * MIN), NOW);
    expect(r.stalled).toBe(true);
    if (r.stalled) {
      expect(r.kind).toBe("active");
      expect(r.minutes).toBe(31);
      expect(r.label).toBe("⚠️ 停滞 31分");
    }
  });

  it("実装中も同じ判定対象", () => {
    const r = isCardStalled("実装中", isoBefore(45 * MIN), NOW);
    expect(r.stalled).toBe(true);
    if (r.stalled) expect(r.kind).toBe("active");
  });

  it("境界：ちょうど30分は停滞ではない（30分「超」）", () => {
    expect(isCardStalled("着手", isoBefore(30 * MIN), NOW).stalled).toBe(false);
    // 30分+1msで停滞
    expect(isCardStalled("着手", isoBefore(30 * MIN + 1), NOW).stalled).toBe(true);
  });

  it("60分超は時間表示（例：90分→「1時間」・3時間→「3時間」）", () => {
    const r90 = isCardStalled("着手", isoBefore(90 * MIN), NOW);
    if (r90.stalled) expect(r90.label).toBe("⚠️ 停滞 1時間");
    const r3h = isCardStalled("実装中", isoBefore(3 * HOUR), NOW);
    if (r3h.stalled) expect(r3h.label).toBe("⚠️ 停滞 3時間");
    // ちょうど60分は分表示のまま（60分「超」から時間表示）
    const r60 = isCardStalled("着手", isoBefore(60 * MIN), NOW);
    if (r60.stalled) expect(r60.label).toBe("⚠️ 停滞 60分");
  });

  it("対象外の状態（受付・議論中・レビュー・完了）は経過しても停滞にしない", () => {
    for (const s of ["受付", "議論中", "レビュー", "完了", "却下"]) {
      expect(isCardStalled(s, isoBefore(10 * HOUR), NOW).stalled).toBe(false);
    }
  });

  it("lastEdited 無し（空文字・null・undefined）は停滞にしない", () => {
    expect(isCardStalled("着手", "", NOW).stalled).toBe(false);
    expect(isCardStalled("着手", null, NOW).stalled).toBe(false);
    expect(isCardStalled("着手", undefined, NOW).stalled).toBe(false);
  });

  it("不正ISOは停滞にしない（誤警報より沈黙）", () => {
    expect(isCardStalled("着手", "not-a-date", NOW).stalled).toBe(false);
    expect(isCardStalled("GO待ち", "2026-99-99", NOW).stalled).toBe(false);
  });

  it("未来の lastEdited（時計ズレ）は停滞にしない", () => {
    expect(isCardStalled("着手", new Date(NOW + HOUR).toISOString(), NOW).stalled).toBe(false);
  });

  it("now は Date でも number でも受けられる", () => {
    const iso = isoBefore(31 * MIN);
    expect(isCardStalled("着手", iso, new Date(NOW)).stalled).toBe(true);
    expect(isCardStalled("着手", iso, NOW).stalled).toBe(true);
  });
});

describe("isCardStalled（GO待ち＝48時間超で返答待ち）", () => {
  it("49時間経過 → 返答待ちアラート", () => {
    const r = isCardStalled("GO待ち", isoBefore(49 * HOUR), NOW);
    expect(r.stalled).toBe(true);
    if (r.stalled) {
      expect(r.kind).toBe("goWait");
      expect(r.label).toBe("⏰ 48h超・返答待ち");
    }
  });

  it("境界：ちょうど48時間はアラートしない（48時間「超」）", () => {
    expect(isCardStalled("GO待ち", isoBefore(48 * HOUR), NOW).stalled).toBe(false);
    expect(isCardStalled("GO待ち", isoBefore(48 * HOUR + 1), NOW).stalled).toBe(true);
  });

  it("GO待ちは30分経過では停滞にならない（閾値は48時間）", () => {
    expect(isCardStalled("GO待ち", isoBefore(31 * MIN), NOW).stalled).toBe(false);
  });
});

describe("isSameLocalDay（今日完了の判定）", () => {
  it("同じ日ならtrue・前日ならfalse", () => {
    expect(isSameLocalDay(new Date(NOW - 1 * MIN).toISOString(), NOW)).toBe(true);
    expect(isSameLocalDay(new Date(NOW - 25 * HOUR).toISOString(), NOW)).toBe(false);
  });

  it("空・不正ISOはfalse", () => {
    expect(isSameLocalDay("", NOW)).toBe(false);
    expect(isSameLocalDay(null, NOW)).toBe(false);
    expect(isSameLocalDay(undefined, NOW)).toBe(false);
    expect(isSameLocalDay("not-a-date", NOW)).toBe(false);
  });
});

describe("heroSummary（要対応ヒーローバー集計）", () => {
  it("GO待ち件数・48h超・停滞・今日完了を正しく数える", () => {
    const cols = groupByState([
      // GO待ち2件（うち1件が48h超）
      row({ pageId: "g1", state: "GO待ち", lastEdited: isoBefore(1 * HOUR) }),
      row({ pageId: "g2", state: "GO待ち", lastEdited: isoBefore(50 * HOUR) }),
      // 着手1件停滞・実装中1件は元気
      row({ pageId: "a1", state: "着手", lastEdited: isoBefore(40 * MIN) }),
      row({ pageId: "a2", state: "実装中", lastEdited: isoBefore(5 * MIN) }),
      // 完了：今日1件・昨日1件
      row({
        pageId: "d1",
        state: "完了",
        statusChangedAt: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      row({
        pageId: "d2",
        state: "完了",
        statusChangedAt: new Date(NOW - 30 * HOUR).toISOString(),
      }),
    ]);
    const h = heroSummary(cols, NOW);
    expect(h.goWait).toBe(2);
    expect(h.goWaitOver).toBe(1);
    expect(h.stalledActive).toBe(1);
    expect(h.firstStalledState).toBe("着手");
    expect(h.doneToday).toBe(1);
    expect(h.allClear).toBe(false);
  });

  it("要対応ゼロなら allClear=true（完了だけあってもOK扱い）", () => {
    const cols = groupByState([
      row({ pageId: "d1", state: "完了", statusChangedAt: new Date(NOW).toISOString() }),
      row({ pageId: "r1", state: "受付", lastEdited: isoBefore(10 * HOUR) }),
    ]);
    const h = heroSummary(cols, NOW);
    expect(h.allClear).toBe(true);
    expect(h.doneToday).toBe(1);
    expect(h.firstStalledState).toBeNull();
  });

  it("空ボードでも落ちずに allClear", () => {
    const h = heroSummary(groupByState([]), NOW);
    expect(h.allClear).toBe(true);
    expect(h.goWait).toBe(0);
    expect(h.doneToday).toBe(0);
  });

  it("statusChangedAt が無い旧完了チケットは今日完了に数えない", () => {
    const cols = groupByState([row({ pageId: "d1", state: "完了" })]);
    expect(heroSummary(cols, NOW).doneToday).toBe(0);
  });
});
