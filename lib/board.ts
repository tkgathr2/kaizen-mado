// ── /board 用：チケットを「状態」ごとのパイプライン列にまとめる純粋ロジック ──
// 副作用なし（Notion読取は app/api/board が担当）。ここはテスト可能な整形だけ。
// 読み取り専用の可視化が目的。内容(detail)など機微情報はカードに含めない。
import type { TicketRow } from "./tickets";

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
