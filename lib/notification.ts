/**
 * カイゼン改善 通知の「毎朝ダイジェスト」層（改善⑤：束ね＋静穏時間＋再送抑止）。
 *
 * ★位置づけ（設計方針・2026-07-04 監査対応で配線）
 *  - 即時の判断要求／結末通知（GO伺い・完了・Merge待ち・詰まり・仕組み側不調）は
 *    lib/notify.ts + lib/line.ts が"即時1回"で担う（2026-07-03 社長仕様・本番稼働中）。
 *    本モジュールはそれを一切置き換えない／削らない。
 *  - 本モジュールは「途中経過（着手/PR/完了/エラー/停滞）」を1日ためて、朝8時JSTに
 *    "1通だけ"の"ふりかえりダイジェスト"として送る"追加"の低優先レイヤー。
 *    即時通知と役割が重ならないよう、あくまで日次まとめ（社長が見ていない自動進行の要約）。
 *
 * ★永続化（Vercel serverless 対応）
 *  - serverless はリクエストごとに別インスタンスになり得るため、in-memory キューは
 *    インスタンス跨ぎで共有されない（旧実装のデッドコード化＋機能不全の原因）。
 *  - キュー／送信ログは Notion の専用ページ（KAIZEN_DIGEST_PAGE_ID）の子ブロックに永続化する。
 *    NOTION_TOKEN を再利用し、新規の外部依存（Redis 等）を増やさない。
 *  - ブロックは機械可読プレフィックスで区別する：
 *      ⟦KZQ⟧{json}                … キュー項目（未送信）
 *      ⟦KZS⟧<ticketId>:<type>\t<epochMs> … 送信済みログ（再送抑止・24h）
 *
 * ★安全弁（fail-safe / 本番デフォルト無効）
 *  - KAIZEN_DIGEST_PAGE_ID 未設定 or LINE 未設定なら全機能 no-op（挙動不変）。
 *  - 送信・Notion I/O の失敗はダイジェストの都合で改善ループを止めないよう握り潰す
 *    （cron ハンドラだけは結果を JSON で可視化する）。
 */

import { pushText, truncateForLine, lineEnabled, BOARD_URL, actionBanner } from "@/lib/line";

export interface QueuedNotification {
  id: string; // uuid
  ticketId: string; // KZ-XX
  type: "pr_ready" | "execution_started" | "error" | "completion" | "stalled";
  message: string; // ダイジェスト本文の1行
  errorSummary?: string; // エラー要約（「理由：不明」は禁止）
  createdAt: Date;
}

// Vercel は既定 UTC で動くため getHours() は使えない（静穏時間・朝バッチが9時間ズレる）。
// 必ず JST（Asia/Tokyo）の時・分を明示的に算出する。hourCycle:h23 で 0〜23（深夜0時が"24"にならない）。
export function jstHour(d: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d)
  );
}
export function jstMinute(d: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      minute: "2-digit",
    }).format(d)
  );
}

// ── 通知種別のラベル（ダイジェスト表示用） ──
const TYPE_LABEL: Record<QueuedNotification["type"], string> = {
  pr_ready: "🔍 レビュー待ち",
  execution_started: "🔧 着手",
  error: "⚠️ エラー",
  completion: "✅ 反映済み",
  stalled: "⏸ 停滞",
};

// ── エンコード／デコード（Notion ブロックの plain_text へ格納） ──
const Q_PREFIX = "⟦KZQ⟧";
const S_PREFIX = "⟦KZS⟧";

function key(n: Pick<QueuedNotification, "ticketId" | "type">): string {
  return `${n.ticketId}:${n.type}`;
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  // Math.random は本モジュールの ID 用途（衝突許容・非暗号）にのみ使用。
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export function encodeQueue(n: QueuedNotification): string {
  return (
    Q_PREFIX +
    JSON.stringify({
      i: n.id,
      t: n.ticketId,
      y: n.type,
      m: (n.message || "").slice(0, 300),
      e: n.errorSummary ? n.errorSummary.slice(0, 200) : undefined,
      c: n.createdAt.toISOString(),
    })
  );
}

export function decodeQueue(text: string): QueuedNotification | null {
  if (!text || !text.startsWith(Q_PREFIX)) return null;
  try {
    const o = JSON.parse(text.slice(Q_PREFIX.length));
    if (!o || typeof o.t !== "string" || typeof o.y !== "string") return null;
    if (!(o.y in TYPE_LABEL)) return null;
    const created = new Date(o.c || 0);
    return {
      id: typeof o.i === "string" ? o.i : "",
      ticketId: o.t,
      type: o.y as QueuedNotification["type"],
      message: typeof o.m === "string" ? o.m : "",
      errorSummary: typeof o.e === "string" ? o.e : undefined,
      createdAt: Number.isFinite(created.getTime()) ? created : new Date(0),
    };
  } catch {
    return null;
  }
}

export function encodeSent(k: string, ts: number): string {
  return `${S_PREFIX}${k}\t${ts}`;
}

export function decodeSent(text: string): { key: string; ts: number } | null {
  if (!text || !text.startsWith(S_PREFIX)) return null;
  const rest = text.slice(S_PREFIX.length);
  const i = rest.lastIndexOf("\t");
  if (i < 0) return null;
  const k = rest.slice(0, i);
  const ts = Number(rest.slice(i + 1));
  if (!k || !Number.isFinite(ts)) return null;
  return { key: k, ts };
}

// ── 純粋ロジック（テスト対象） ──

/** 同一 ticketId+type は最新（createdAt が新しい方）だけ残す。 */
export function dedupeLatest(items: QueuedNotification[]): QueuedNotification[] {
  const byKey = new Map<string, QueuedNotification>();
  for (const n of items) {
    const k = key(n);
    const prev = byKey.get(k);
    if (!prev || n.createdAt.getTime() >= prev.createdAt.getTime()) byKey.set(k, n);
  }
  return [...byKey.values()];
}

/** 直近に送信済み（recentKeys）の項目を落とす（再送抑止）。 */
export function filterSuppressed(
  items: QueuedNotification[],
  recentKeys: Set<string>
): QueuedNotification[] {
  return items.filter((n) => !recentKeys.has(key(n)));
}

// LINE の1メッセージ上限は5000字。超えると push が 400 で失敗し、キューが再送保持されて
// 永久に詰まる（混雑日に大量のチケットが積まれた場合）。安全余裕をもって総量を打ち切る。
const MAX_DIGEST_BODY = 4500;

/** ダイジェスト本文（LINE 1通）を組み立てる。チケットIDごとにまとめる。
 * 総量が MAX_DIGEST_BODY を超える分は打ち切り「…ほか N件」に畳む（キューが詰まらないよう保証）。 */
export function buildDigestText(items: QueuedNotification[]): string {
  const groups = new Map<string, QueuedNotification[]>();
  for (const n of items) {
    const arr = groups.get(n.ticketId) ?? [];
    arr.push(n);
    groups.set(n.ticketId, arr);
  }

  const header = [
    actionBanner("fyi", "昨日のまとめ・操作は要りません"),
    "",
    "🌅 カイゼン 昨日のうごき（まとめ）",
    "",
  ];
  const bodyLines: string[] = [];
  let used = header.join("\n").length;
  let omitted = 0; // 予算超過で載せられなかった通知件数
  let cut = false;

  for (const [ticketId, arr] of groups.entries()) {
    const block: string[] = [`● ${ticketId}`];
    for (const n of arr) {
      block.push(`　${TYPE_LABEL[n.type]}：${truncateForLine(n.message, 40)}`);
      if (n.errorSummary) block.push(`　　→ ${truncateForLine(n.errorSummary, 40)}`);
    }
    const blockLen = block.join("\n").length + 1;
    // 一度予算を超えたら以降のチケットは全て畳む（順序保持・件数だけ数える）。
    if (cut || used + blockLen > MAX_DIGEST_BODY) {
      cut = true;
      omitted += arr.length;
      continue;
    }
    bodyLines.push(...block);
    used += blockLen;
  }

  const footer: string[] = [""];
  if (omitted > 0) footer.push(`…ほか ${omitted}件`);
  footer.push(`🗂 全体像 ▶ ${BOARD_URL}`);

  return [...header, ...bodyLines, ...footer].join("\n");
}

// ── 永続ストア（Notion 専用ページ実装／テスト差し替え可） ──

export interface DigestBlock {
  id: string;
  text: string;
}
export interface DigestStore {
  /** ストアが使えるか（KAIZEN_DIGEST_PAGE_ID + NOTION_TOKEN が揃っている）。 */
  enabled(): boolean;
  /** 1ブロック追記。 */
  append(text: string): Promise<void>;
  /** 子ブロック（paragraph）を全件取得。 */
  list(): Promise<DigestBlock[]>;
  /** 指定ブロックを削除（archive）。best-effort。 */
  remove(ids: string[]): Promise<void>;
}

const NOTION_VERSION = "2022-06-28";
function digestPageId(): string | null {
  return process.env.KAIZEN_DIGEST_PAGE_ID || null;
}
function notionToken(): string | null {
  return process.env.NOTION_TOKEN || null;
}

const notionStore: DigestStore = {
  enabled() {
    return Boolean(digestPageId() && notionToken());
  },
  async append(text: string): Promise<void> {
    const pid = digestPageId();
    const token = notionToken();
    if (!pid || !token) return;
    const res = await fetch(`https://api.notion.com/v1/blocks/${pid}/children`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
            },
          },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`digest append ${res.status}: ${t.slice(0, 200)}`);
    }
  },
  async list(): Promise<DigestBlock[]> {
    const pid = digestPageId();
    const token = notionToken();
    if (!pid || !token) return [];
    const out: DigestBlock[] = [];
    let cursor: string | undefined = undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const res = await fetch(
        `https://api.notion.com/v1/blocks/${pid}/children?${qs.toString()}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
          },
        }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`digest list ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      for (const b of results) {
        if (b?.type !== "paragraph") continue;
        const text: string = (b?.paragraph?.rich_text || [])
          .map((r: any) => r?.plain_text ?? "")
          .join("");
        out.push({ id: String(b.id), text });
      }
      cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
    } while (cursor);
    return out;
  },
  async remove(ids: string[]): Promise<void> {
    const token = notionToken();
    if (!token) return;
    for (const id of ids) {
      try {
        await fetch(`https://api.notion.com/v1/blocks/${id}`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
          },
        });
      } catch (e) {
        console.error("[notification] block削除失敗", (e as Error).message);
      }
    }
  },
};

// ストアはテストで差し替え可能にする（DI）。既定は Notion 実装。
let _store: DigestStore | null = null;
function store(): DigestStore {
  return _store ?? notionStore;
}
/** テスト専用：ストアを差し替える（null で既定へ戻す）。 */
export function __setDigestStoreForTest(s: DigestStore | null): void {
  _store = s;
}

/** ダイジェスト機能が有効か（ストア有効＋LINE有効）。どちらか欠けたら no-op。 */
export function digestEnabled(): boolean {
  return store().enabled() && lineEnabled();
}

/**
 * 通知をダイジェストキューに積む（即座には送らない）。
 * - 未設定（KAIZEN_DIGEST_PAGE_ID / LINE）なら no-op（本番デフォルト無効・挙動不変）。
 * - error 種別で要約が空 or 「不明」を含むなら積まない（「理由：不明」の禁止）。
 * - I/O 失敗は握り潰す（改善ループをダイジェストの都合で止めない）。
 */
export async function enqueueNotification(
  ticketId: string,
  type: QueuedNotification["type"],
  message: string,
  errorSummary?: string
): Promise<void> {
  if (type === "error" && (!errorSummary || errorSummary.includes("不明"))) {
    console.warn(
      `[notification] ${ticketId} のエラー要約が不明瞭のためダイジェストに積みません（実エラー文を入れてください）。`
    );
    return;
  }
  if (!digestEnabled()) return;

  const n: QueuedNotification = {
    id: genId(),
    ticketId,
    type,
    message,
    errorSummary,
    createdAt: new Date(),
  };
  try {
    await store().append(encodeQueue(n));
    console.log(`[notification] enqueued: ${ticketId} (${type})`);
  } catch (e) {
    console.error("[notification] enqueue失敗（握り潰し）", (e as Error).message);
  }
}

/** ダイジェストを LINE で1通送る。LINE 未設定なら false（fail-safe）。 */
export async function sendBatchNotifications(
  items: QueuedNotification[]
): Promise<boolean> {
  if (items.length === 0) return true;
  // buildDigestText で総量は予算内に畳んでいるが、最終防波堤として 4900 で hard cap
  //（LINE 5000字上限で 400 になるのを絶対に避ける）。
  const body = buildDigestText(items).slice(0, 4900);
  console.log(`[notification] digest送信 (${items.length}件)`);
  return await pushText(body);
}

export interface BatchResult {
  ok: boolean;
  sent: number;
  considered: number;
  skipped?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * 定時タスク：毎朝 08:00 JST に cron から呼ぶ（/api/cron/notification-batch）。
 * ① Notion からキュー＋送信ログを取得
 * ② 同一 ticketId+type の重複を最新へ畳み、直近24hに送信済みのものは再送抑止
 * ③ 残りを1通のダイジェストとして LINE 送信
 * ④ 成功時：送信ログを積み（冪等ガード）→ 消費したキューを削除 → 48h超の古いログを掃除
 *
 * @param opts.force cron スケジュール自体を「時刻の権威」として時刻ガードを飛ばす。
 *   force=false のときだけ 08:00-08:29 JST の自己ガードを適用（汎用スケジューラ用の保険）。
 */
export async function runDailyNotificationBatch(
  opts: { force?: boolean } = {}
): Promise<BatchResult> {
  const s = store();
  if (!s.enabled()) return { ok: true, sent: 0, considered: 0, skipped: "disabled" };

  if (!opts.force) {
    const h = jstHour();
    const m = jstMinute();
    if (h !== 8 || m >= 30) {
      return { ok: true, sent: 0, considered: 0, skipped: `not-scheduled ${h}:${m}` };
    }
  }

  let blocks: DigestBlock[];
  try {
    blocks = await s.list();
  } catch (e) {
    return { ok: false, sent: 0, considered: 0, skipped: `list-failed: ${(e as Error).message}` };
  }

  const queue: { n: QueuedNotification; id: string }[] = [];
  const markers: { key: string; ts: number; id: string }[] = [];
  for (const b of blocks) {
    const q = decodeQueue(b.text);
    if (q) {
      queue.push({ n: q, id: b.id });
      continue;
    }
    const mk = decodeSent(b.text);
    if (mk) markers.push({ ...mk, id: b.id });
  }

  const now = Date.now();
  // 48h超の古い送信ログは、送信の成否に関わらず"毎回必ず"掃除する。
  // 送信失敗が続く日（LINE障害等）でもページが膨れ続けないようにするため、
  // 後続の early-return より前に一度だけ実行する（送信経路の分岐に依存させない）。
  const staleMarkerIds = markers.filter((m) => now - m.ts > MARKER_TTL_MS).map((m) => m.id);
  if (staleMarkerIds.length) await s.remove(staleMarkerIds).catch(() => {});

  if (queue.length === 0) {
    return { ok: true, sent: 0, considered: 0, skipped: "empty" };
  }

  const consumedQueueIds = queue.map((x) => x.id);

  // LINE 未設定：積まれたキューが無限に溜まらないよう消費だけして終える。
  if (!lineEnabled()) {
    await s.remove(consumedQueueIds).catch(() => {});
    return { ok: true, sent: 0, considered: queue.length, skipped: "line-disabled" };
  }

  const recentKeys = new Set(
    markers.filter((m) => now - m.ts < DAY_MS).map((m) => m.key)
  );
  const deduped = dedupeLatest(queue.map((x) => x.n));
  const fresh = filterSuppressed(deduped, recentKeys);

  if (fresh.length === 0) {
    // 送るものは無いが、重複／抑止で読んだキューは処理済み扱いで掃除する。
    await s.remove(consumedQueueIds).catch(() => {});
    return { ok: true, sent: 0, considered: deduped.length, skipped: "all-suppressed" };
  }

  const ok = await sendBatchNotifications(fresh);
  if (!ok) {
    // 送信失敗：キューを残して次回リトライ（消さない・送信ログも積まない）。
    return { ok: false, sent: 0, considered: fresh.length, skipped: "send-failed" };
  }

  // 成功：先に送信ログを積む（インスタンス跨ぎ／削除失敗時の再送を防ぐ冪等ガード）。
  for (const n of fresh) {
    try {
      await s.append(encodeSent(key(n), now));
    } catch (e) {
      console.error("[notification] 送信ログ追記失敗", (e as Error).message);
    }
  }
  await s.remove(consumedQueueIds).catch(() => {});

  return { ok: true, sent: fresh.length, considered: fresh.length };
}
