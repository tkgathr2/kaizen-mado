// ── 統一メモリ層（全体で学習し続ける土台） ──
// カイゼンくんの「進化し続けるAI」の核。開発（直したコード/PR/失敗）も
// やり取り（会話/GO・却下/「違う」）も、別バケットに分けず "同じ1つの記憶"
// （knowhow の同一 project_key）に貯める。タグ（kind）で種別を区別する。
// 使うほど社長専用に賢くなる土台。
//
// 設計の肝：
//  - 開発の学びと会話の学びを別の project_key に分けない＝横断で効く。
//  - record/recall とも fail-safe（knowhow未設定/失敗でも例外を投げない＝no-op）。
//  - knowhowは認証ゼロで全公開 → PIIを必ずマスクしてから送る。
//
// ※ 既存の lib/knowhow.ts（起票連動）・lib/learn.ts（完了還元）・lib/recall.ts
//   （会話recall）は段階的にこの層へ寄せていく。本PRでは memory層の土台 ＋
//   learn.ts の memory層経由化（成功＋失敗の両方を記録）まで。
import { maskPII } from "./pii";

const DEFAULT_BASE = "https://knowhow.up.railway.app";
const RECALL_TIMEOUT_MS = 1500;

/**
 * 学びの種別。開発も会話も同じ記憶に貯め、この kind（＝タグ）で区別する。
 *  - fix_success : 改善/修正が完了した（うまくいった型）
 *  - fix_failed  : 改善/修正が差し戻し・失敗した（同じミスを二度しない＝しくじり先生）
 *  - decision    : 設計・方針の判断（なぜそうしたか）
 *  - correction  : 社長の「違う」「却下」など軌道修正（教師信号）
 *  - conversation: 会話から得た学び（要望の傾向・言い回し等）
 */
export type LearningKind =
  | "fix_success"
  | "fix_failed"
  | "decision"
  | "correction"
  | "conversation";

/** 全体学習に流し込む1イベント。開発・会話どちらの経路からも同じ形で使える。 */
export interface LearningEvent {
  /** 種別（タグで横断検索できるよう区別する） */
  kind: LearningKind;
  /** 対象システム（例: プロレポ / ステレポ / カイゼンくん 本体 等）。不明なら省略可。 */
  system?: string;
  /** 1行サマリ（何が起きたか／何を学んだか）。 */
  summary: string;
  /** 詳細（経緯・原因・対処など）。任意。 */
  detail?: string;
  /** 追加タグ（キーワード等）。kind・system は自動で付くので重複不要。 */
  tags?: string[];
  /** 成否（knowhow status）。既定は kind から推定（fix_failed/correction→failed、他→success）。 */
  status?: "success" | "failed";
}

/** recallLearning のオプション */
export interface RecallOptions {
  /** 取得件数（既定3） */
  topK?: number;
  /** この種別だけに絞りたいとき（任意）。横断で引くなら未指定。 */
  kinds?: LearningKind[];
  /** タイムアウト（ms・既定1500）。会話中から呼ぶので短く。 */
  timeoutMs?: number;
}

/** recall で返る1件 */
export interface MemoryHit {
  content: string;
  score: number;
  tags: string[];
}

/** memory層が有効か（knowhow連動がONか）。既定OFF。 */
export function isMemoryEnabled(): boolean {
  return process.env.KNOWHOW_ENABLED === "true";
}

/** 開発も会話も同じ記憶に貯めるための単一 project_key（横断で効く肝）。 */
function projectKey(): string {
  return process.env.KNOWHOW_PROJECT_KEY || "cto-lab";
}

function baseUrl(): string {
  return process.env.KNOWHOW_API_BASE || DEFAULT_BASE;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.KB_API_KEY) headers["X-API-Key"] = process.env.KB_API_KEY;
  return headers;
}

/** kind から既定の成否を決める（失敗系の学びは status=failed で残す）。 */
function defaultStatus(kind: LearningKind): "success" | "failed" {
  return kind === "fix_failed" || kind === "correction" ? "failed" : "success";
}

/** イベント1件を knowhow が受け取る raw_log（PIIマスク済み）に整形する。 */
function buildRawLog(event: LearningEvent): string {
  const lines = [`【${event.kind}】${maskPII(event.summary)}`];
  if (event.system) lines.push(`対象: ${event.system}`);
  if (event.detail) lines.push(`詳細: ${maskPII(event.detail)}`);
  return lines.join("\n");
}

/**
 * 全体学習に1イベントを記録する（knowhow へ memorize）。
 * - 開発（fix_success/fix_failed/decision）も会話（conversation/correction）も同じ記憶へ。
 * - fail-safe：無効・失敗・例外でも throw せず boolean を返す（呼び出し側は待たなくてよい）。
 * @returns 送信成功なら true。無効/失敗なら false。
 */
export async function recordLearning(event: LearningEvent): Promise<boolean> {
  if (!isMemoryEnabled()) return false;
  // 中身が空なら記録しない（ノイズを貯めない）
  if (!event.summary || !event.summary.trim()) return false;

  const status = event.status ?? defaultStatus(event.kind);
  const tags = ["全体学習", event.kind];
  if (event.system) tags.push(event.system);
  if (event.tags) tags.push(...event.tags);

  const body = {
    project_key: projectKey(),
    tool: "kaizen-memory",
    status,
    raw_log: buildRawLog(event),
    tags,
  };

  try {
    const res = await fetch(`${baseUrl()}/api/devin/memorize`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[memory] record failed ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[memory] record error:", (err as Error).message);
    return false;
  }
}

/**
 * 着手前・会話前に「似た過去の学び」を引く（knowhow recall のラッパ）。
 * 開発時・会話時の両方から使える汎用形。kinds で種別を絞れるが、未指定なら横断で引く
 * （＝開発の学びも会話の学びも一緒に効く）。
 * - fail-safe：無効・タイムアウト・失敗・0件はすべて [] を返す（呼び出しを止めない）。
 */
export async function recallLearning(
  query: string,
  opts: RecallOptions = {}
): Promise<MemoryHit[]> {
  if (!isMemoryEnabled()) return [];
  if (!query || !query.trim()) return [];

  const topK = opts.topK && opts.topK > 0 ? Math.floor(opts.topK) : 3;
  const timeoutMs =
    opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : RECALL_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/api/devin/recall`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        project_key: projectKey(),
        query: query.slice(0, 500),
        top_k: topK,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const hits: MemoryHit[] = results
      .filter((r: any) => typeof r?.content === "string" && r.content.trim())
      .map((r: any) => ({
        content: String(r.content),
        score: Number(r.score) || 0,
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      }));

    // kinds 指定があれば、その kind タグを含むものだけに絞る（横断記憶からの選別）。
    if (opts.kinds && opts.kinds.length) {
      const want = new Set<string>(opts.kinds);
      return hits.filter((h) => h.tags.some((t) => want.has(t)));
    }
    return hits;
  } catch {
    return []; // タイムアウト・通信失敗は無言スキップ（呼び出しを止めない）
  } finally {
    clearTimeout(timer);
  }
}
