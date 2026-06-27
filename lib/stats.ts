// ── カイゼンくん成長ダッシュボードの集計 ──
// Notion改善チケットDBを全件読み、「声が集まる→直る→学びになる」の現在地を数える。
// 集計は純粋関数（aggregateTickets）に分離し、now注入でテスト可能にする。
// 状態名・ファネル段は lib/board.ts の正本を import（「議論中」等の表記ズレを防ぐ）。
import { funnelStageOf, FUNNEL_ORDER } from "./board";

const NOTION_VERSION = "2022-06-28";

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
  recent: { ticketId: string; title: string; system: string; state: string; reporter: string; createdTime: string }[];
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
    .map(({ ticketId, title, system, state, reporter, createdTime }) => ({
      ticketId,
      title,
      system,
      state,
      reporter,
      createdTime,
    }));

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

// ── Notionから全チケットをページングで取得 ──
function parseStatsRow(page: any): StatsRow {
  const props = page?.properties ?? {};
  const plain = (p: any, key: "title" | "rich_text") =>
    Array.isArray(p?.[key]) ? p[key].map((r: any) => r?.plain_text ?? "").join("") : "";
  let ticketId = "";
  for (const key of Object.keys(props)) {
    const u = props[key];
    if (u?.type === "unique_id" && u.unique_id?.number != null) {
      ticketId = `${u.unique_id.prefix || "KZ"}-${u.unique_id.number}`;
      break;
    }
  }
  return {
    ticketId,
    title: plain(props["チケット名"], "title"),
    system: props["対象システム"]?.select?.name ?? "",
    type: props["種別"]?.select?.name ?? "",
    importance: props["重要度"]?.select?.name ?? "",
    state: props["状態"]?.select?.name ?? "",
    reporter: plain(props["起票者"], "rich_text"),
    createdTime: page?.created_time ?? "",
    learned: typeof props["FGSリンク"]?.url === "string" && !!props["FGSリンク"].url,
  };
}

export async function fetchAllTicketRows(): Promise<StatsRow[]> {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!token || !databaseId) throw new Error("NOTION_TOKEN/NOTION_DATABASE_ID is not set");

  const rows: StatsRow[] = [];
  let cursor: string | undefined;
  // 安全弁：最大10ページ（1000件）まで。超えたら新しい順に十分なので打ち切り。
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
        sorts: [{ timestamp: "created_time", direction: "descending" }],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Notion stats query error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    for (const page of data?.results ?? []) rows.push(parseStatsRow(page));
    if (!data?.has_more || !data?.next_cursor) break;
    cursor = data.next_cursor;
  }
  return rows;
}
