// ── カイゼン自律ループ 死活監視（ヘルスチェック・読み取り＋極小呼び出しのみ） ──
// 今日、ループが裏で壊れていた（旧モデルで404・対象リポがNodeでないと即死）のに
// 誰も気づけなかった。同種の "silent 故障" を機械が検知するための見張り。
//
// 設計方針：
//  - 各チェックは fail-safe。鍵未設定は "skipped"、例外は "error" として握り、
//    1つのチェックが落ちても他のチェックや全体の応答を巻き込まない。
//  - 監視は読み取り＋極小の Anthropic 呼び出し（max_tokens=1）のみ。
//    本番データを変更しない・自動修正しない（観測専用）。
//  - 「正常」は全チェックが ok/skipped で、かつ滞留チケットが閾値未満のとき。
import { fetchTicketsByState, isStaleImplementing, staleImplementingMinutes } from "./tickets";
import type { TicketRow } from "./tickets";

// ワークフロー(.github/workflows/kaizen-loop.yml の claude-code-base-action)が
// 実際に使うモデル。ここを叩いて「model not found(404)」を事前検知する。
// env ANTHROPIC_MODEL があればそれを優先（ワークフローと食い違わないよう同じ既定）。
export const HEALTH_MODEL_DEFAULT = "claude-sonnet-4-6";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const KNOWHOW_DEFAULT_BASE = "https://knowhow.up.railway.app";
// knowhow 疎通チェックのタイムアウト（監視は素早く・短く）。
const KNOWHOW_HEALTH_TIMEOUT_MS = 4000;

/** 各チェックの状態。
 *  ok      … 疎通・期待どおり
 *  warn    … 動作はするが注意（例：滞留が閾値以上）
 *  error   … 失敗（例：model 404・Notion不通・例外）
 *  skipped … 鍵未設定などで検査せず（異常ではない） */
export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** 人が読む短い説明（404理由・件数など）。 */
  detail: string;
  /** 補助の数値（滞留件数など）。任意。 */
  count?: number;
}

export interface HealthReport {
  /** 全体判定：いずれかのチェックが error/warn なら "unhealthy"、それ以外 "ok"。 */
  ok: boolean;
  /** unhealthy のとき、その理由（チェック名）の配列。GitHub issue タイトル等に使う。 */
  problems: string[];
  checks: CheckResult[];
  checkedAt: string;
}

/** ワークフローが使うモデル名（env 優先）。 */
export function healthModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL || HEALTH_MODEL_DEFAULT;
}

/** 滞留とみなす状態（"実装中"=tickets の reaper 対象。"着手" も同様に長期滞留を見る）。 */
const STALL_STATES = ["実装中", "着手"] as const;

// ── 個別チェック ──

/**
 * AIモデル疎通：ワークフローが使うモデルへ極小の Anthropic 呼び出しを1回試す。
 * 200 なら ok。404（model not found 等）は error で理由を返す（今日の故障の核心）。
 * 鍵未設定は skipped。例外・その他の非200は error として握る（全体は止めない）。
 */
export async function checkAnthropicModel(
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  const name = "anthropic-model";
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { name, status: "skipped", detail: "ANTHROPIC_API_KEY 未設定" };
  }
  const model = healthModel(env);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      // 極小の呼び出し（課金・負荷を最小化）。応答内容は問わず、到達可否だけ見る。
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (res.ok) {
      return { name, status: "ok", detail: `${model} 疎通OK (200)` };
    }
    const body = await res.text().catch(() => "");
    return {
      name,
      status: "error",
      detail: `${model} エラー ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return { name, status: "error", detail: `疎通失敗: ${(err as Error).message}` };
  }
}

/**
 * Notion 改善チケットDB 読取：1件クエリできるか確認する。
 * 例外（認証未設定・通信失敗）は error として握る。
 */
export async function checkNotionRead(): Promise<CheckResult> {
  const name = "notion-read";
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    return { name, status: "skipped", detail: "NOTION_TOKEN/NOTION_DATABASE_ID 未設定" };
  }
  try {
    // 軽い1件読取（状態=受付 を1件）。0件でも疎通できていれば ok。
    const rows = await fetchTicketsByState("受付", 1);
    return { name, status: "ok", detail: `読取OK（受付 ${rows.length}件取得）` };
  } catch (err) {
    return { name, status: "error", detail: `読取失敗: ${(err as Error).message}` };
  }
}

/**
 * knowhow 疎通（任意・KNOWHOW_ENABLED=true のときのみ）。無効なら skipped。
 *
 * 学習が実際に使う経路（鍵付き recall・読み取りのみ）で「到達性」と「鍵の有効性」を
 * 同時に検証する。recall は副作用が無いので memorize（書き込み）は叩かない。
 *
 * ※ 以前は GET {base}/api/health を叩いていたが、knowhow にその endpoint は無く
 *    恒久 404 → 死活監視が常に unhealthy → autopilot を有効化できず偽 issue を量産する
 *    バグがあった（2026-06-27 修正）。本物の依存＝鍵付き recall を直接見ることで解消。
 */
export async function checkKnowhow(
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  const name = "knowhow";
  if (env.KNOWHOW_ENABLED !== "true") {
    return { name, status: "skipped", detail: "KNOWHOW_ENABLED 無効" };
  }
  const base = env.KNOWHOW_API_BASE || KNOWHOW_DEFAULT_BASE;
  // 鍵が無いと memorize は 401 で握り潰され、学習が"静かに"貯まらない＝本物の異常。
  if (!env.KB_API_KEY) {
    return {
      name,
      status: "error",
      detail: "KB_API_KEY 未設定（学習の書き込みが 401 で無効化される）",
    };
  }
  const projectKey = env.KNOWHOW_PROJECT_KEY || "cto-lab";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KNOWHOW_HEALTH_TIMEOUT_MS);
  try {
    // recall は読み取り（副作用なし）。学習の到達性＋鍵の有効性を同時に検証する。
    const res = await fetch(`${base}/api/devin/recall`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.KB_API_KEY },
      body: JSON.stringify({ project_key: projectKey, query: "health", top_k: 1 }),
      signal: controller.signal,
    });
    if (res.ok) {
      return { name, status: "ok", detail: `${base} recall疎通OK (${res.status})` };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        name,
        status: "error",
        detail: `${base} 認証失敗 ${res.status}（KB_API_KEY が無効）`,
      };
    }
    return { name, status: "error", detail: `${base} エラー ${res.status}` };
  } catch (err) {
    return { name, status: "error", detail: `疎通失敗: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 滞留チェック：「実装中」「着手」のまま長時間（既定30分超）滞留しているチケット数。
 * reaper（取り残し回収）が効いているかの代理指標。閾値以上で warn（異常扱い）。
 * Notion 未設定なら skipped、例外は error。
 * @param thresholdCount これ以上で warn にする件数（既定1）。
 */
export async function checkStalledTickets(
  thresholdCount = 1,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  const name = "stalled-tickets";
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
    return { name, status: "skipped", detail: "NOTION_TOKEN/NOTION_DATABASE_ID 未設定" };
  }
  const minutes = staleImplementingMinutes(env);
  try {
    let stalled: TicketRow[] = [];
    for (const state of STALL_STATES) {
      const rows = await fetchTicketsByState(state, 25);
      // isStaleImplementing は state==="実装中" のみ true を返すため、
      // "着手" の滞留は同じ経過判定ロジックをここで適用する（reaper 観点で同質）。
      stalled = stalled.concat(rows.filter((r) => isStalled(r, now, minutes)));
    }
    const count = stalled.length;
    if (count >= thresholdCount) {
      return {
        name,
        status: "warn",
        detail: `${minutes}分超の滞留チケット ${count}件（reaper未到達の疑い）`,
        count,
      };
    }
    return { name, status: "ok", detail: `滞留なし（${minutes}分超 ${count}件）`, count };
  } catch (err) {
    return { name, status: "error", detail: `滞留チェック失敗: ${(err as Error).message}` };
  }
}

/** 「実装中」/「着手」の滞留判定。
 * 「実装中」は既存 isStaleImplementing をそのまま使う（最終更新からの経過）。
 * 「着手」は同じ経過判定を適用（lastEdited が無ければ滞留扱いしない＝安全側）。 */
export function isStalled(
  row: Pick<TicketRow, "state" | "lastEdited">,
  now: number,
  minutes: number
): boolean {
  if (row.state === "実装中") return isStaleImplementing(row, now, minutes);
  if (row.state === "着手") {
    if (!row.lastEdited) return false;
    const edited = Date.parse(row.lastEdited);
    if (!Number.isFinite(edited)) return false;
    return now - edited >= minutes * 60_000;
  }
  return false;
}

// ── 集計 ──

/** チェック結果配列から HealthReport を組み立てる（純粋関数・テスト容易）。
 *  error / warn を1つでも含めば unhealthy。skipped/ok は正常扱い。 */
export function summarize(checks: CheckResult[], now: number = Date.now()): HealthReport {
  const problems = checks
    .filter((c) => c.status === "error" || c.status === "warn")
    .map((c) => c.name);
  return {
    ok: problems.length === 0,
    problems,
    checks,
    checkedAt: new Date(now).toISOString(),
  };
}

/** 全チェックを並列に走らせて HealthReport を返す。各チェックは個別に fail-safe。 */
export async function runHealthChecks(
  env: NodeJS.ProcessEnv = process.env
): Promise<HealthReport> {
  const now = Date.now();
  const checks = await Promise.all([
    checkAnthropicModel(env),
    checkNotionRead(),
    checkKnowhow(env),
    checkStalledTickets(1, now, env),
  ]);
  return summarize(checks, now);
}
