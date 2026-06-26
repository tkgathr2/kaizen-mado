// ── 軽量レート制限（外部依存ゼロ・プロセス内メモリのスライディングウィンドウ）──
// 目的：公開チャット /api/chat は1ターンごとに課金API（Anthropic）を呼ぶ。認証OFF時は完全公開で、
//   スクリプトで叩かれるとコスト爆発・DoS になる。これを「best-effort の第一防衛線」として弾く。
//
// ⚠️ 限界（明記）：Vercel/サーバレスは複数インスタンスに分散し、各インスタンスが独立メモリを持つため
//   この制限は厳密ではない（インスタンス毎カウント）。それでも単一インスタンスに集中する典型的な
//   濫用・暴走スクリプトには有効で、外部KV（鍵が要る）を増やさずに導入できる第一段の防御として置く。
//   厳密な分散レート制限が必要になったら外部KV(Upstash等)へ差し替える前提。
//
// 後方互換・fail-safe：制限値は環境変数で上書き可。例外時はブロックせず通す（degrade-safe）。

export interface RateLimitConfig {
  /** ウィンドウ長（ミリ秒） */
  windowMs: number;
  /** ウィンドウ内に許可する最大リクエスト数 */
  max: number;
}

export interface RateLimitResult {
  /** 許可するなら true。超過なら false。 */
  allowed: boolean;
  /** 現ウィンドウ内のヒット数（許可分を含む現在値） */
  count: number;
  /** 適用された上限 */
  limit: number;
  /** 次に1枠空くまでの秒数（クライアントへの待ち時間ヒント） */
  retryAfterSec: number;
}

const DEFAULT_PER_MIN = 20;
const DEFAULT_PER_HOUR = 100;

/** env から制限値を読む（正の整数のみ採用・不正/未設定は既定）。
 *  KAIZEN_CHAT_RATE_PER_MIN … 1分あたり上限（既定 20）
 *  KAIZEN_CHAT_RATE_PER_HOUR … 1時間あたり上限（既定 100） */
export function rateLimitConfigs(env: NodeJS.ProcessEnv = process.env): RateLimitConfig[] {
  const perMin = positiveIntOr(env.KAIZEN_CHAT_RATE_PER_MIN, DEFAULT_PER_MIN);
  const perHour = positiveIntOr(env.KAIZEN_CHAT_RATE_PER_HOUR, DEFAULT_PER_HOUR);
  return [
    { windowMs: 60_000, max: perMin },
    { windowMs: 3_600_000, max: perHour },
  ];
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// キー → そのキーで観測したリクエスト時刻（ミリ秒）の配列。
// もっとも長いウィンドウより古い記録は都度刈り取り、無制限な肥大を防ぐ。
const hits = new Map<string, number[]>();

// マップ全体の肥大化を防ぐための上限（キー数）。超えたら最も古いキーから間引く。
const MAX_KEYS = 50_000;

/** スライディングウィンドウ判定。複数の窓（分・時）すべてを満たすときのみ allowed=true。
 *  this は副作用あり（許可時のみ now を記録）。超過時は記録せず弾く。 */
export function checkRateLimit(
  key: string,
  configs: RateLimitConfig[] = rateLimitConfigs(),
  now: number = Date.now()
): RateLimitResult {
  if (configs.length === 0) {
    return { allowed: true, count: 0, limit: Infinity, retryAfterSec: 0 };
  }

  const maxWindow = Math.max(...configs.map((c) => c.windowMs));
  const arr = hits.get(key) ?? [];
  // 最長ウィンドウより古い記録を捨てる。
  const recent = arr.filter((t) => now - t < maxWindow);

  // どれか1つでも超過していれば弾く。
  let blocking: { cfg: RateLimitConfig; inWindow: number } | null = null;
  for (const cfg of configs) {
    const inWindow = recent.filter((t) => now - t < cfg.windowMs).length;
    if (inWindow >= cfg.max) {
      blocking = { cfg, inWindow };
      break;
    }
  }

  if (blocking) {
    // 記録は更新しない（超過分でウィンドウを延ばさない）。retryAfter を計算して返す。
    hits.set(key, recent);
    const oldestInWindow = recent
      .filter((t) => now - t < blocking!.cfg.windowMs)
      .sort((a, b) => a - b)[0];
    const retryAfterSec =
      oldestInWindow === undefined
        ? Math.ceil(blocking.cfg.windowMs / 1000)
        : Math.max(1, Math.ceil((oldestInWindow + blocking.cfg.windowMs - now) / 1000));
    return {
      allowed: false,
      count: blocking.inWindow,
      limit: blocking.cfg.max,
      retryAfterSec,
    };
  }

  // 許可：now を記録。
  recent.push(now);
  hits.set(key, recent);
  evictIfNeeded();
  // 代表の上限として最短ウィンドウ（通常は分）の上限を返す。
  const shortest = configs.reduce((a, b) => (a.windowMs <= b.windowMs ? a : b));
  const inShortest = recent.filter((t) => now - t < shortest.windowMs).length;
  return { allowed: true, count: inShortest, limit: shortest.max, retryAfterSec: 0 };
}

function evictIfNeeded(): void {
  if (hits.size <= MAX_KEYS) return;
  // Map は挿入順を保つので、先頭（最も古い）から間引く。
  const overflow = hits.size - MAX_KEYS;
  let removed = 0;
  for (const k of hits.keys()) {
    hits.delete(k);
    if (++removed >= overflow) break;
  }
}

/** テスト用：内部状態をクリアする。 */
export function _resetRateLimit(): void {
  hits.clear();
}

/** リクエストから best-effort のクライアント識別キーを作る。
 *  プロキシ（Vercel）配下では x-forwarded-for の先頭が実IP。無ければ各種ヘッダ→フォールバック。 */
export function clientKeyFromHeaders(
  headers: { get(name: string): string | null },
  fallback = "unknown"
): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const vercelIp = headers.get("x-vercel-forwarded-for");
  if (vercelIp) {
    const first = vercelIp.split(",")[0]?.trim();
    if (first) return first;
  }
  return fallback;
}
