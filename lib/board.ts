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
