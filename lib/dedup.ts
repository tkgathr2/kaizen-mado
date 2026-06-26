// ── 二重起票ガード（サーバ側・冪等チェック） ──
// 現場の非エンジニアは無反応だと連打する。UI側の無効化が間に合わなくても、
// 「同じ起票者＋同じ内容」を短時間に二度受けたら2回目以降を弾く物理的な防波堤。
//
// 純粋ロジック（テスト可能）：時刻を注入できる shouldAccept で判定する。
// 保存は同一サーバプロセス内のメモリ（serverless環境では完璧な重複排除ではないが、
// 連打＝同一インスタンスに連続到達するケースの大半をブロックできる軽量ガード）。
import type { Ticket } from "./types";

// 同一内容とみなす時間窓（ミリ秒）。連打対策が目的なので短く。
export const DEDUP_WINDOW_MS = 10_000;

/** 起票者＋チケット内容から決定的なキーを作る（前後空白・大小は正規化）。 */
export function dedupKey(ticket: Ticket, reporter: string | null): string {
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const who = norm(reporter || "");
  return [
    who,
    norm(ticket.system || ""),
    norm(ticket.type || ""),
    norm(ticket.title || ""),
    norm(ticket.detail || ""),
    norm(ticket.importance || ""),
  ].join("␟"); // 区切りは内容に出にくい記号
}

/**
 * 受理してよいか判定する純粋関数。直近に同一キーがあり時間窓内なら false（重複）。
 * @param seen キー→最終受理時刻(ms) の記録（呼び出し側が保持）
 * @param key dedupKey の結果
 * @param now 現在時刻(ms)
 * @param windowMs 同一とみなす窓
 */
export function shouldAccept(
  seen: Map<string, number>,
  key: string,
  now: number,
  windowMs: number = DEDUP_WINDOW_MS
): boolean {
  // 古い記録を掃除（メモリ肥大防止）。
  for (const [k, t] of seen) {
    if (now - t > windowMs) seen.delete(k);
  }
  const prev = seen.get(key);
  if (prev != null && now - prev <= windowMs) {
    return false; // 窓内の重複＝弾く
  }
  seen.set(key, now);
  return true;
}

// プロセス内の受理記録（モジュールスコープで共有）。
const recentSubmits = new Map<string, number>();

/** reporter が実質空（null/空文字/空白のみ）か。匿名起票の判定に使う。 */
function isAnonymous(reporter: string | null): boolean {
  return !reporter || reporter.trim().length === 0;
}

/** 実運用向けラッパ：同一プロセス内の重複連打を弾く。受理なら true。
 *
 * 匿名（reporter が null/空）のときは dedup をスキップして常に受理する。
 * 理由：起票者キーが空だと「別人の匿名2名が偶然同じ短文」を同一連打と誤認し、
 * 後から送った正当な声を無言で握りつぶしてしまう。連打自体はUI側
 * （inFlightRef＋ボタン無効化）で既に抑止できているため、匿名の取りこぼしを
 * 防ぐ方を優先する（記名起票は従来どおりサーバ側でも重複連打を弾く）。 */
export function acceptSubmit(ticket: Ticket, reporter: string | null, now: number = Date.now()): boolean {
  if (isAnonymous(reporter)) return true;
  return shouldAccept(recentSubmits, dedupKey(ticket, reporter), now);
}
