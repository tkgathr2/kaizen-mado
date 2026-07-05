// ── /board 用：チケットを「状態」ごとのパイプライン列にまとめる純粋ロジック ──
// 副作用なし（Notion読取は app/api/board が担当）。ここはテスト可能な整形だけ。
// 読み取り専用の可視化が目的。内容(detail)など機微情報はカードに含めない。
import type { TicketRow } from "./tickets";

// ── パイプライン状態の正本（single source of truth） ──
// 名前・色・絵文字・ファネル段を1か所にまとめる。board / dashboard / stats は
// ここを import して使い、状態名のズレ（例：「議論」と「議論中」）を二度と起こさない。
// state は app/api/process が実際にチケットへ書く文字列と完全一致させること。
export interface StateMeta {
  /** 絵文字（ボード列・サマリ用）。 */
  emoji: string;
  /** アクセント色（ボード列の上線・ダッシュボードの状態色）。 */
  color: string;
  /** ファネル段（ダッシュボードの「カイゼンの流れ」集計の段）。 */
  funnel: string;
}

// ファネル段の表示順（粗い5段。複数の状態が同じ段に集まる）。
export const FUNNEL_ORDER: string[] = ["受付", "検討・提案中", "改修中", "完了", "見送り"];

// 状態 → メタ情報。キーが実際にチケットへ書かれる状態名（process.route の updateTicketState と一致）。
export const STATE_META: Record<string, StateMeta> = {
  受付: { emoji: "📥", color: "#9a8c7a", funnel: "受付" },
  議論中: { emoji: "💬", color: "#b58a3c", funnel: "検討・提案中" },
  GO待ち: { emoji: "✋", color: "#d97757", funnel: "検討・提案中" },
  着手: { emoji: "🔧", color: "#3d7ab0", funnel: "改修中" },
  実装中: { emoji: "⚙️", color: "#3d7ab0", funnel: "改修中" },
  レビュー: { emoji: "🔍", color: "#7a5db0", funnel: "改修中" },
  完了: { emoji: "✅", color: "#3f7a3f", funnel: "完了" },
  社長確認: { emoji: "🛑", color: "#b4452b", funnel: "検討・提案中" },
  差し戻し: { emoji: "↩️", color: "#b58a3c", funnel: "検討・提案中" },
  却下: { emoji: "🚫", color: "#a0a0a0", funnel: "見送り" },
};

// 未知状態のデフォルト（壊れた表示を避ける）。ファネルは「検討・提案中」へ寄せる。
export const DEFAULT_STATE_META: StateMeta = { emoji: "•", color: "#9a8c7a", funnel: "検討・提案中" };

/** 状態名 → メタ（未知はデフォルト）。 */
export function metaOf(state: string): StateMeta {
  return STATE_META[state] ?? DEFAULT_STATE_META;
}

/** 状態名 → ファネル段（未知は「検討・提案中」）。stats の集計で使う。 */
export function funnelStageOf(state: string): string {
  return (STATE_META[state] ?? DEFAULT_STATE_META).funnel;
}

// 本流パイプライン（左→右に進む）。
export const PIPELINE_STATES: string[] = [
  "受付",
  "議論中",
  "GO待ち",
  "着手",
  "実装中",
  "レビュー",
  "完了",
];

// 本流から外れる状態（人の判断待ち・止まり）。本流の右側にまとめて並べる。
export const SIDE_STATES: string[] = ["社長確認", "差し戻し", "却下"];

// 表示順の基準。未知の状態は末尾に「出現順」で足す。
export const BOARD_ORDER: string[] = [...PIPELINE_STATES, ...SIDE_STATES];

/** 1画面に出す軽量カード（機微情報は持たせない）。 */
export interface BoardCard {
  pageId: string;
  ticketId: string;
  system: string;
  type: string;
  importance: string;
  title: string;
  state: string;
  lastEdited: string;
  /** Notionの該当チケットページ（クリックで全文＝議論結果・PRリンクが見られる）。 */
  url: string;
  // ── 優先度スコアリング（§4.5.1・PIIではないので公開可。旧チケットは undefined＝「—」）──
  urgency?: number;
  importanceScore?: number;
  priority?: string;
  /** 状態が変わった日時（ISO文字列）。完了列の完了日表示用。旧チケットは undefined。 */
  statusChangedAt?: string;
}

export interface BoardColumn {
  state: string;
  cards: BoardCard[];
}

/** pageId（ダッシュ有無どちらでも）から Notion ページURLを作る。 */
export function notionUrlFromPageId(pageId: string): string {
  const id = String(pageId || "").replace(/-/g, "");
  return id ? `https://www.notion.so/${id}` : "";
}

/** TicketRow → BoardCard（detail等の機微情報は落とす）。 */
export function toBoardCard(t: TicketRow): BoardCard {
  return {
    pageId: t.pageId,
    ticketId: t.ticketId || "",
    system: t.system || "未特定",
    type: t.type || "",
    importance: t.importance || "",
    title: t.title || "(件名なし)",
    state: t.state || "未設定",
    lastEdited: t.lastEdited || "",
    url: notionUrlFromPageId(t.pageId),
    // 優先度スコアリング（任意・PIIではない）。旧チケットは undefined。
    ...(typeof t.urgency === "number" ? { urgency: t.urgency } : {}),
    ...(typeof t.importanceScore === "number" ? { importanceScore: t.importanceScore } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.statusChangedAt ? { statusChangedAt: t.statusChangedAt } : {}),
  };
}

/**
 * チケット配列を状態ごとの列へまとめる。
 * - 列の並びは BOARD_ORDER。未知状態は末尾に出現順で追加。
 * - 各列のカードは最終更新の新しい順（入力が新しい順なら維持）。
 * - includeEmpty=true なら BOARD_ORDER の空列も残す（パイプラインの形を常に見せる）。
 */
export function groupByState(
  tickets: TicketRow[],
  opts: { order?: string[]; includeEmpty?: boolean } = {}
): BoardColumn[] {
  const order = opts.order ?? BOARD_ORDER;
  const includeEmpty = opts.includeEmpty ?? true;

  const buckets = new Map<string, BoardCard[]>();
  const seenOrder: string[] = [];
  const ensure = (state: string) => {
    if (!buckets.has(state)) {
      buckets.set(state, []);
      seenOrder.push(state);
    }
    return buckets.get(state)!;
  };

  if (includeEmpty) {
    for (const s of order) ensure(s);
  }

  // 新しい順を保つため、入力順のままpush（呼び出し側で last_edited desc 済み）。
  for (const t of tickets) {
    const card = toBoardCard(t);
    ensure(card.state).push(card);
  }

  // 並び：order に載っている状態を先に、未知は出現順で後ろに。
  const ordered: string[] = [];
  for (const s of order) if (buckets.has(s)) ordered.push(s);
  for (const s of seenOrder) if (!ordered.includes(s)) ordered.push(s);

  return ordered.map((state) => ({ state, cards: buckets.get(state) ?? [] }));
}

/** 件数サマリ（ヘッダー表示用）。 */
export function countByState(columns: BoardColumn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of columns) out[c.state] = c.cards.length;
  return out;
}

// ── 滞留（止まってるかも）判定 ──
// 「開発が止まった場合に気づけるか」が社長の関心事。閾値は仕様固定：
// - 着手・実装中: lastEdited から 30分超 → 停滞
// - GO待ち: lastEdited から 48時間超 → 返答待ちアラート
// ここは純粋関数（now を引数で受ける）にしてテスト可能に保つ。

/** 停滞判定の対象となる「作業中」状態。 */
export const STALL_ACTIVE_STATES: string[] = ["着手", "実装中"];
/** 着手・実装中の停滞閾値（30分）。 */
export const STALL_ACTIVE_MS = 30 * 60 * 1000;
/** GO待ちの返答待ち閾値（48時間）。 */
export const STALL_GO_WAIT_MS = 48 * 60 * 60 * 1000;

/** 滞留判定の結果。stalled=false 以外は表示用ラベルまで組み立てて返す。 */
export type StallInfo =
  | { stalled: false }
  | {
      stalled: true;
      /** active=着手/実装中の停滞、goWait=GO待ち48h超。 */
      kind: "active" | "goWait";
      /** 経過分数（切り捨て）。 */
      minutes: number;
      /** カードバッジにそのまま出せるラベル。 */
      label: string;
    };

const NOT_STALLED: StallInfo = { stalled: false };

function toEpochMs(now: number | Date): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * カードが「止まってるかも」かを判定する純粋関数。
 * - state が対象外／lastEdited 無し／不正ISO → stalled:false（誤警報より沈黙を選ぶ）
 * - 着手・実装中: 30分超で停滞（60分超は時間表示）
 * - GO待ち: 48時間超で返答待ちアラート
 */
export function isCardStalled(
  state: string,
  lastEditedIso: string | null | undefined,
  now: number | Date = Date.now()
): StallInfo {
  if (!lastEditedIso) return NOT_STALLED;
  const edited = new Date(lastEditedIso).getTime();
  if (Number.isNaN(edited)) return NOT_STALLED;
  const elapsed = toEpochMs(now) - edited;
  if (elapsed <= 0) return NOT_STALLED;

  if (STALL_ACTIVE_STATES.includes(state)) {
    if (elapsed <= STALL_ACTIVE_MS) return NOT_STALLED;
    const minutes = Math.floor(elapsed / 60000);
    const label =
      minutes > 60 ? `⚠️ 停滞 ${Math.floor(minutes / 60)}時間` : `⚠️ 停滞 ${minutes}分`;
    return { stalled: true, kind: "active", minutes, label };
  }

  if (state === "GO待ち") {
    if (elapsed <= STALL_GO_WAIT_MS) return NOT_STALLED;
    const minutes = Math.floor(elapsed / 60000);
    return { stalled: true, kind: "goWait", minutes, label: "⏰ 48h超・返答待ち" };
  }

  return NOT_STALLED;
}

/** iso が now と同じローカル日付（年月日一致）か。「今日完了」の判定に使う。 */
export function isSameLocalDay(
  iso: string | null | undefined,
  now: number | Date = Date.now()
): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date(toEpochMs(now));
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

/** 要対応ヒーローバー用の集計。 */
export interface HeroSummary {
  /** GO待ちの件数。 */
  goWait: number;
  /** GO待ちのうち lastEdited が48時間超のもの。 */
  goWaitOver: number;
  /** 着手・実装中で30分超停滞しているカード数。 */
  stalledActive: number;
  /** 停滞カードを含む最初の列名（ジャンプ先）。無ければ null。 */
  firstStalledState: string | null;
  /** statusChangedAt が今日の「完了」カード数。 */
  doneToday: number;
  /** 要対応（GO待ち＋停滞）がゼロか。 */
  allClear: boolean;
}

/** 列データから要対応サマリーを集計する純粋関数。 */
export function heroSummary(
  columns: BoardColumn[],
  now: number | Date = Date.now()
): HeroSummary {
  let goWait = 0;
  let goWaitOver = 0;
  let stalledActive = 0;
  let firstStalledState: string | null = null;
  let doneToday = 0;

  for (const col of columns) {
    for (const card of col.cards) {
      const stall = isCardStalled(card.state, card.lastEdited, now);
      if (col.state === "GO待ち") {
        goWait++;
        if (stall.stalled && stall.kind === "goWait") goWaitOver++;
      }
      if (stall.stalled && stall.kind === "active") {
        stalledActive++;
        if (!firstStalledState) firstStalledState = col.state;
      }
      if (col.state === "完了" && isSameLocalDay(card.statusChangedAt, now)) doneToday++;
    }
  }

  return {
    goWait,
    goWaitOver,
    stalledActive,
    firstStalledState,
    doneToday,
    allClear: goWait === 0 && stalledActive === 0,
  };
}
