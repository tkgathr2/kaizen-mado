// ── カイゼンくん成長ダッシュボードの集計 ──
// 改善チケットDB（Postgres）を全件読み、「声が集まる→直る→学びになる」の現在地を数える。
// 集計は純粋関数（aggregateTickets）に分離し、now注入でテスト可能にする。
// 状態名・ファネル段は lib/board.ts の正本を import（「議論中」等の表記ズレを防ぐ）。
//
// 【bug-check-lab Medium-3修正・2026-08-16】DB移行後もfetchAllTicketRowsがNotion API
// を直接叩いたまま放置されており、/api/stats・/dashboard が移行日時点の値で固まる
// リグレッションがあった。lib/tickets.tsのfetchAllTickets（Postgres）へ差し替える。
import { funnelStageOf, FUNNEL_ORDER } from "./board";
import { fetchAllTickets } from "./tickets";

export interface StatsRow {
  ticketId: string;
  title: string;
  system: string;
  type: string;
  importance: string;
  state: string;
  reporter: string;
  createdTime: string; // ISO
  learned: boolean; // FGSリンク有り＝学びDB還元済み
  // 優先度スコアリング（任意・旧チケットは undefined＝表示は「—」）。
  urgency?: number;
  importanceScore?: number;
  priority?: string;
}

export interface WeekPoint {
  label: string; // "6/8〜" 週初め（月曜）表記
  count: number;
}

export interface KaizenStats {
  total: number;
  thisWeek: number;
  thisMonth: number;
  done: number;
  doneRate: number; // 0-100
  learned: number;
  funnel: { stage: string; count: number }[];
  byState: { name: string; count: number }[];
  bySystem: { name: string; total: number; done: number }[];
  weekly: WeekPoint[]; // 直近8週（古→新）
  recent: {
    ticketId: string;
    title: string;
    system: string;
    state: string;
    reporter: string;
    createdTime: string;
    urgency?: number;
    importanceScore?: number;
    priority?: string;
  }[];
  generatedAt: string;
}

// 状態→ファネル段の対応（現在状態しか持たないため「今どの段にいるか」を数える）。
// 対応表は lib/board.ts の STATE_META に集約済み。ここでは段の表示順だけ別名で持つ。
const STAGE_ORDER = FUNNEL_ORDER;

function startOfWeek(d: Date): Date {
  // 月曜はじまり（現場の週感覚に合わせる）
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function aggregateTickets(rows: StatsRow[], now: Date = new Date()): KaizenStats {
  const total = rows.length;
  const weekStart = startOfWeek(now).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let thisWeek = 0;
  let thisMonth = 0;
  let done = 0;
  let learned = 0;
  const stateCount = new Map<string, number>();
  const systemCount = new Map<string, { total: number; done: number }>();
  const stageCount = new Map<string, number>();

  // 週次バケット（直近8週・古→新）
  const weekStarts: number[] = [];
  for (let i = 7; i >= 0; i--) {
    const w = startOfWeek(now);
    w.setDate(w.getDate() - i * 7);
    weekStarts.push(w.getTime());
  }
  const weekly = weekStarts.map((t) => {
    const d = new Date(t);
    return { label: `${d.getMonth() + 1}/${d.getDate()}〜`, count: 0 };
  });

  for (const r of rows) {
    const t = Date.parse(r.createdTime);
    if (!Number.isNaN(t)) {
      if (t >= weekStart) thisWeek++;
      if (t >= monthStart) thisMonth++;
      for (let i = weekStarts.length - 1; i >= 0; i--) {
        if (t >= weekStarts[i]) {
          if (i === weekStarts.length - 1 || t < weekStarts[i + 1]) weekly[i].count++;
          else weekly[weekStarts.length - 1].count++;
          break;
        }
      }
    }
    if (r.state === "完了") done++;
    if (r.learned) learned++;
    stateCount.set(r.state || "不明", (stateCount.get(r.state || "不明") ?? 0) + 1);
    const sys = r.system || "未指定";
    const s = systemCount.get(sys) ?? { total: 0, done: 0 };
    s.total++;
    if (r.state === "完了") s.done++;
    systemCount.set(sys, s);
    const stage = funnelStageOf(r.state);
    stageCount.set(stage, (stageCount.get(stage) ?? 0) + 1);
  }

  const recent = [...rows]
    .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
    .slice(0, 10)
    .map(
      ({
        ticketId,
        title,
        system,
        state,
        reporter,
        createdTime,
        urgency,
        importanceScore,
        priority,
      }) => ({
        ticketId,
        title,
        system,
        state,
        reporter,
        createdTime,
        ...(typeof urgency === "number" ? { urgency } : {}),
        ...(typeof importanceScore === "number" ? { importanceScore } : {}),
        ...(priority ? { priority } : {}),
      })
    );

  return {
    total,
    thisWeek,
    thisMonth,
    done,
    doneRate: total ? Math.round((done / total) * 100) : 0,
    learned,
    funnel: STAGE_ORDER.map((stage) => ({ stage, count: stageCount.get(stage) ?? 0 })),
    byState: [...stateCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    bySystem: [...systemCount.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total),
    weekly,
    recent,
    generatedAt: now.toISOString(),
  };
}


// ── 起票者名(PII)のマスキング ──
// /api/stats は認証OFFの間（OAuth鍵未投入時）middleware に保護されず公開で叩ける。
// その状態で起票者（社員氏名＝個人情報）を素のまま返すと第三者に漏れる。
// 未認証アクセスでは起票者名を伏せる（集計値は維持）。日本語/英語の氏名を想定し、
// 先頭1文字＋伏字にする（空は空のまま）。1文字の場合はそのまま伏字1個。
export function maskReporterName(name: string): string {
  const s = (name ?? "").trim();
  if (!s) return "";
  const head = Array.from(s)[0];
  return `${head}***`;
}

/** KaizenStats の recent[].reporter をマスクした新オブジェクトを返す（非破壊）。 */
export function maskStatsReporters(stats: KaizenStats): KaizenStats {
  return {
    ...stats,
    recent: stats.recent.map((r) => ({ ...r, reporter: maskReporterName(r.reporter) })),
  };
}

/** 安全弁：ダッシュボード集計が対象とする最大件数。超えた分は新しい順で切り捨てる。 */
const STATS_MAX_ROWS = 5000;

export async function fetchAllTicketRows(): Promise<StatsRow[]> {
  const tickets = await fetchAllTickets(STATS_MAX_ROWS);
  return tickets.map((t) => ({
    ticketId: t.ticketId,
    title: t.title,
    system: t.system,
    type: t.type,
    importance: t.importance,
    state: t.state,
    reporter: t.reporter,
    createdTime: t.createdTime ?? "",
    // FGSリンク有り＝学びDB還元済み（旧Notion「FGSリンク」プロパティと同じ判定）。
    learned: !!t.fgsUrl,
    urgency: t.urgency,
    importanceScore: t.importanceScore,
    priority: t.priority,
  }));
}
