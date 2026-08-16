// ── 改善チケットストア（Postgres）の読取・更新（第2段=フィードバック改善ループの内部処理） ──
// 起票(lib/notion.ts)の延長。状態遷移・議論ブロック追記・冪等マークを担う。
// 誰にも送信しない（対人送信・課金・本番DB破壊は含めない）。
//
// 【2026-08-16 Notion API → Postgres(Railway) 移行】
// チケットの正本は Notion DB から Postgres（lib/db/schema.ts の tickets /
// ticket_discussion_blocks）へ移した。Notion は「過去記録の読み取り専用アーカイブ」として
// 残すだけで、このファイルからは Notion API を一切呼ばない（読み書きとも）。
// 呼び出し元16ファイルは一切変更しないため、エクスポートする関数名・引数・戻り値の型・
// TicketRow のフィールドはすべて移行前と寸分違わず維持している。中身だけを差し替えた。
//
// ★接続は必ず「関数呼び出し時の遅延接続」にすること。モジュールのトップレベルで
//   getPool() を呼ぶと、DATABASE_URL が無い Vercel のビルド時にビルドが落ちる。
import type { Ticket } from "./types";
import { normalizeForDedup } from "./dedup";
import { normalizeSystemForTicket } from "./systems";
import { KZ_STATUS } from "./kz-state";
import { getPool, ensureSchema } from "./db/pool";

export interface TicketRow {
  pageId: string;
  ticketId: string;
  system: string;
  type: string;
  importance: string;
  title: string;
  detail: string;
  reporter: string;
  state: string;
  fgsUrl: string | null;
  /** レビュー中PRのURL（tickets.pr_url）。execute/callback の review 結果で書き込まれる。
   * PR未作成のチケットは undefined（kz-sweep のレビューリマインドで省略可能な扱い）。 */
  prUrl?: string;
  /** 最終更新時刻（ISO文字列）。tickets.updated_at。/board の並び・stuck判定用。 */
  lastEdited?: string;
  /** 作成時刻（ISO文字列）。tickets.created_at。起票前 冪等チェックの時間窓判定用。 */
  createdTime?: string;
  // ── 優先度スコアリング（§4.5.1・後方互換で任意。旧チケットは undefined＝表示は「—」）──
  urgency?: number; // 緊急度 1〜10
  importanceScore?: number; // 重要度 1〜10
  priority?: string; // 優先度（高/中/低）
  priorityReason?: string; // 算出根拠1行
  /** 状態が変わった日時（ISO文字列）。Phase 1 タイムアウト計測用（tickets.status_changed_at）。
   * 未設定の旧チケットは undefined（タイムアウト判定せず安全側）。 */
  statusChangedAt?: string;
  // ── Slack起点チケット用（幹部Botへの app_mention から自動起票された場合のみ設定） ──
  slackChannelId?: string; // メンションが届いたチャンネルID（完了時の返信先）
  slackThreadTs?: string;  // メンションのスレッドts（完了時の返信先スレッド）
  slackUserId?: string;    // メンションしたユーザーのSlack ID
}

// ────────────────────────────────────────────────────────────────────────────
// pageId の設計（★この移行で最も慎重を要した箇所・変更前に必ずここを読むこと）
// ────────────────────────────────────────────────────────────────────────────
// `pageId` はコードベース全体で「チケット行を一意に指す文字列キー」として使われている。
// Notion 時代はページUUID（32hex）だった。Postgres 化にあたり「内部ID(BIGSERIAL)を
// そのまま id::text で使う」案を検討したが、**採用しなかった**。理由は以下の実測事実：
//
//   app/api/board/proposal-token/route.ts:24 が pageId を
//     /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
//   で検証しており（SSRF/パス注入対策）、UUID形式でない pageId は 400 で弾かれる。
//   ここは /board の「GO」「却下」ボタンがトークンを取りに来る唯一の経路
//   （app/board/page.tsx:127）なので、"42" のような裸の数値IDにすると
//   **新規チケットは全部 /board からGO/却下できなくなる**。
//   呼び出し元は変更しない前提のため、pageId 側をUUID形式に保つのが正しい解。
//
// そこで pageId は「常にUUID形式の文字列」とし、次の優先順で組み立てる：
//   1) notion_page_id がある行（Notionからの移行データ）… その実UUIDをそのまま使う。
//      → 移行前に発行済みのLINEポストバック・署名トークン・既存リンクがそのまま生きる。
//   2) notion_page_id が無い行（Postgres化後の新規チケット）… 内部IDから
//      決定的に合成したUUID形式の文字列 `00000000-0000-4000-8000-<idを12桁hexで0詰め>`。
//      → 逆変換可能（下の internalIdFromPageId）。実在のNotionページIDと衝突しない
//        （先頭20hexが全て0のNotionページIDは事実上存在しない）。
//      → 決定的なので proposalToken のHMAC（pageId+state）も安定する。
//
// 逆引き（fetchTicketByPageId・全ての更新系）は pageIdWhere() 1か所に集約し、
//   ・合成UUID／裸の数値  → tickets.id で直引き
//   ・それ以外のUUID     → tickets.notion_page_id で引く
// の2経路を透過的に扱う。これで移行済みチケットと新規チケットが混在しても壊れない。

/** 合成pageIdの固定プレフィクス（先頭20hex）。UUIDv4形式に見えるが実体は内部IDの器。 */
const SYNTHETIC_PAGE_ID_PREFIX = "00000000000040008000";

/** チケットID（表示用）の接頭辞。Notion時代の unique_id prefix "KZ" を踏襲。 */
const TICKET_ID_PREFIX = "KZ";

/** 内部ID(BIGSERIAL) → UUID形式の合成pageId。 */
function syntheticPageId(id: string | number | bigint): string {
  const hex = BigInt(id).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/** pageId が内部IDを表しているならその内部ID(10進文字列)を返す。そうでなければ null。
 * 受け付ける形：合成pageId（ハイフン有無どちらも）／裸の数値文字列（防御的に許容）。 */
function internalIdFromPageId(pageId: string): string | null {
  const raw = (pageId || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (hex.length === 32 && /^[0-9a-f]+$/.test(hex) && hex.startsWith(SYNTHETIC_PAGE_ID_PREFIX)) {
    return BigInt(`0x${hex.slice(SYNTHETIC_PAGE_ID_PREFIX.length)}`).toString();
  }
  return null;
}

/** pageId から WHERE 句（必ず $1 を使う）とバインド値を組み立てる。不正・空なら null。
 * 更新系は `WHERE ${sql}` の後ろに $2 以降を足して使う（params は [param, ...others]）。 */
function pageIdWhere(pageId: string): { sql: string; param: string } | null {
  const raw = (pageId || "").trim();
  if (!raw) return null;
  const id = internalIdFromPageId(raw);
  if (id !== null) return { sql: "id = $1::bigint", param: id };
  return { sql: "notion_page_id = $1", param: raw };
}

/** DB行 → TicketRow。lib/notion.ts の createTicket（INSERT ... RETURNING *）からも使う。 */
export function mapTicketRow(row: any): TicketRow {
  return {
    pageId: pageIdOf(row),
    ticketId: row?.ticket_number == null ? "" : `${TICKET_ID_PREFIX}-${row.ticket_number}`,
    system: text(row?.system),
    type: text(row?.type),
    importance: text(row?.importance),
    title: text(row?.title),
    detail: text(row?.detail),
    reporter: text(row?.reporter),
    state: text(row?.state),
    fgsUrl: text(row?.fgs_url) || null,
    prUrl: text(row?.pr_url) || undefined,
    lastEdited: iso(row?.updated_at) ?? "",
    createdTime: iso(row?.created_at) ?? "",
    urgency: int(row?.urgency),
    importanceScore: int(row?.importance_score),
    priority: text(row?.priority) || undefined,
    priorityReason: text(row?.priority_reason) || undefined,
    statusChangedAt: iso(row?.status_changed_at),
    slackChannelId: text(row?.slack_channel_id) || undefined,
    slackThreadTs: text(row?.slack_thread_ts) || undefined,
    slackUserId: text(row?.slack_user_id) || undefined,
  };
}

/** DB行の pageId（移行データは実Notion UUID、新規は内部IDからの合成UUID）。 */
function pageIdOf(row: any): string {
  const notionPageId = text(row?.notion_page_id).trim();
  if (notionPageId) return notionPageId;
  if (row?.id == null) return "";
  return syntheticPageId(row.id);
}

function text(v: any): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function int(v: any): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** TIMESTAMPTZ(pgはDateで返す) → ISO文字列。null・不正値は undefined。 */
function iso(v: any): string | undefined {
  if (v == null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : undefined;
}

/** limit を必ず 1 以上の整数にする（LIMIT に負値・NaN を渡さない）。 */
function cap(limit: number): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** tickets の全カラム（SELECT で明示・列追加時の暗黙依存を避ける）。 */
const TICKET_COLUMNS = `
  id, ticket_number, system, type, importance, title, detail, reporter, state,
  assignee, fgs_url, pr_url, urgency, importance_score, priority, priority_reason,
  status_changed_at, slack_channel_id, slack_thread_ts, slack_user_id,
  notion_page_id, created_at, updated_at
`;

/** クエリ共通入口。初回だけスキーマを用意する（pool.ts の ensureSchema はメモ化済み）。
 * ★getPool()/ensureSchema() はここでしか呼ばない＝モジュール読込時には接続しない。 */
async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  await ensureSchema();
  const res = await getPool().query(sql, params);
  return (res.rows ?? []) as T[];
}

/** pageId から tickets.id（内部ID）を1回のクエリで解決する。無ければ null。
 * 合成pageIdでも「実在するか」まで確認する（FK違反の分かりにくいエラーを避けるため）。 */
async function resolveTicketId(pageId: string): Promise<string | null> {
  const where = pageIdWhere(pageId);
  if (!where) return null;
  const rows = await query<{ id: string }>(
    `SELECT id FROM tickets WHERE ${where.sql} LIMIT 1`,
    [where.param]
  );
  return rows[0] ? String(rows[0].id) : null;
}

/** 指定状態のチケットを取得 */
export async function fetchTicketsByState(
  state: string,
  limit = 5
): Promise<TicketRow[]> {
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE state = $1 ORDER BY created_at DESC LIMIT $2`,
    [state, cap(limit)]
  );
  return rows.map(mapTicketRow);
}

/** 全チケットを最終更新の新しい順で取得（/board の状況可視化用・読み取り専用）。
 * Notion時代の last_edited_time 降順に相当するのが updated_at 降順。 */
export async function fetchAllTickets(limit = 100): Promise<TicketRow[]> {
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets ORDER BY updated_at DESC LIMIT $1`,
    [cap(limit)]
  );
  return rows.map(mapTicketRow);
}

/** pageIdで1件取得（webhookでGO時に現在状態を確認＝冪等化のため）。無ければnull。 */
export async function fetchTicketByPageId(pageId: string): Promise<TicketRow | null> {
  const where = pageIdWhere(pageId);
  if (!where) return null;
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${where.sql} LIMIT 1`,
    [where.param]
  );
  return rows[0] ? mapTicketRow(rows[0]) : null;
}

// ── 起票前 冪等チェック（インスタンス跨ぎの真の二重起票防止） ──
// lib/dedup.ts のメモリ段は「同一プロセス内」しか効かない。Vercelの
// serverless は連打を別インスタンスで受けうるため、メモリ段をすり抜けた
// 二重起票が2件できる。そこで createTicket の直前にDBを1回問い合わせ、
// 「直近N秒以内・完全同一内容（＋記名なら同一起票者）」の既存チケットがあれば、
// 新規作成せずそれを返す。
//
// ★ fail-safe：このチェックが失敗/タイムアウトしたら null を返し、呼び出し側は
//   通常どおり新規作成する（＝声を絶対に取りこぼさない。迷ったら作る側に倒す）。

/** 起票前 冪等チェックの時間窓（秒）。env KAIZEN_SUBMIT_DEDUP_SECONDS（既定15秒）。
 * 1〜600秒の範囲にクランプ（長すぎる窓は正当な再起票を握りつぶすため）。 */
export function submitDedupSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_SUBMIT_DEDUP_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 15;
  return Math.min(600, Math.max(1, Math.floor(raw)));
}

/** 匿名（reporter空）の時間窓は記名より短くする（別人の正当な短文を消さない安全側）。
 * 既定で記名の半分（最低1秒）。記名は submitDedupSeconds をそのまま使う。 */
export function anonSubmitDedupSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.floor(submitDedupSeconds(env) / 2));
}

/** 「直近window秒以内・完全同一内容」の既存チケットを照合する純粋ロジック。
 * DB側で created_at＋対象システム(＋記名なら起票者)まで絞った候補 rows を受け、
 * title/detail/種別/重要度/起票者を正規化して厳密一致するものを1件返す（無ければnull）。
 * 完全一致のみを重複とみなす＝別内容・別importance は通す（声を取りこぼさない）。 */
export function matchDuplicate(
  rows: TicketRow[],
  ticket: Ticket,
  reporter: string | null,
  anonymous: boolean
): TicketRow | null {
  const norm = normalizeForDedup;
  const wantSystem = norm(normalizeSystemForTicket(ticket.system));
  const wantType = norm(ticket.type || "");
  const wantTitle = norm(ticket.title || "");
  const wantDetail = norm(ticket.detail || "");
  const wantImportance = norm(ticket.importance || "");
  const wantReporter = norm(reporter || "");

  for (const r of rows) {
    if (norm(r.system) !== wantSystem) continue;
    if (norm(r.type) !== wantType) continue;
    if (norm(r.title) !== wantTitle) continue;
    if (norm(r.detail) !== wantDetail) continue;
    if (norm(r.importance) !== wantImportance) continue;
    // 記名のときは起票者も一致を要求（別人の同一内容を誤って弾かない）。
    // 匿名のときは起票者キーが無いので内容完全一致のみで判定する。
    if (!anonymous && norm(r.reporter) !== wantReporter) continue;
    return r;
  }
  return null;
}

/**
 * createTicket 直前に1回呼ぶ「DB側の起票前 冪等チェック」。
 * 直近window秒以内・同一 対象システム（＋記名なら同一起票者）の候補をDBから取り、
 * matchDuplicate で完全同一内容を厳密照合する。ヒットしたらその既存 TicketRow を返す。
 * 失敗（接続エラー/タイムアウト/DATABASE_URL未設定など）は握りつぶして null を返す（fail-safe）。
 */
export async function findRecentDuplicate(
  ticket: Ticket,
  reporter: string | null,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<TicketRow | null> {
  try {
    const anonymous = !reporter || reporter.trim().length === 0;
    const windowSec = anonymous ? anonSubmitDedupSeconds(env) : submitDedupSeconds(env);
    const since = new Date(now - windowSec * 1000).toISOString();
    const system = normalizeSystemForTicket(ticket.system);

    // 絞り込み：作成時刻が窓内 AND 対象システム一致（＋記名なら起票者一致）。
    // title/detail の厳密一致は取得後にアプリ側（matchDuplicate）で正規化照合する。
    const conds = ["created_at >= $1::timestamptz", "system = $2"];
    const params: any[] = [since, system];
    if (!anonymous) {
      conds.push("reporter = $3");
      params.push((reporter || "").trim());
    }

    // 窓内の候補だけ取れば十分（連打は数件）。新しい順で取得。
    const rows = await query(
      `SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC LIMIT 25`,
      params
    );
    return matchDuplicate(rows.map(mapTicketRow), ticket, reporter, anonymous);
  } catch (err) {
    // fail-safe：照合に失敗しても起票は止めない（声を取りこぼさない）。
    console.error(
      "[tickets] findRecentDuplicate failed (fallback to create):",
      (err as Error).message
    );
    return null;
  }
}

/** "KZ-12" 等から連番部分（12）を取り出す。数字が取れなければ null。 */
function ticketNumberOf(ticketId: string): number | null {
  const m = /^\s*[A-Za-z]+-?(\d+)\s*$/.exec(ticketId || "");
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}

/** ticketId（例 KZ-12）でGO待ちチケットを探す（テキスト返信「GO KZ-12」用）。
 * Notion版は「GO待ち」を25件引いてから ticketId 文字列の完全一致で絞っていたので、
 * 表記ゆれ（KZ-012・別prefix）は弾かれていた。その挙動をそのまま保つため、
 * 連番を取り出したうえで "KZ-<連番>" が入力と一致することも確認する。 */
export async function findGoMachiByTicketId(ticketId: string): Promise<TicketRow | null> {
  const normalized = (ticketId || "").toUpperCase().replace(/\s/g, "");
  const num = ticketNumberOf(ticketId);
  if (num === null) return null;
  if (`${TICKET_ID_PREFIX}-${num}`.toUpperCase() !== normalized) return null;
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE ticket_number = $1 AND state = $2 LIMIT 1`,
    [num, KZ_STATUS.AWAITING_GO]
  );
  return rows[0] ? mapTicketRow(rows[0]) : null;
}

/**
 * ticketId（例 KZ-12）で状態を問わず1件探す。
 * 真田チャネル（mention-hisho）からの引用返信の書き戻し（POST /api/kaizen/reply）用。
 * findGoMachiByTicketId と違い「GO待ち」に絞らない＝差し戻し中の詰まり連絡への回答も拾える。
 * 形式が不正（数字が取れない）なら DBに触れず null。クエリ失敗時は例外を投げる
 * （呼び出し側でハンドリング）。
 */
export async function findTicketByTicketId(ticketId: string): Promise<TicketRow | null> {
  const num = ticketNumberOf(ticketId);
  if (num === null) return null;
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE ticket_number = $1 LIMIT 1`,
    [num]
  );
  return rows[0] ? mapTicketRow(rows[0]) : null;
}

/** Slack thread_ts で既存チケットを探す（Slack引用返信時の重複防止）。
 * 同じスレッド内の複数メンションが複数の app_mention イベント生成・重複起票を防ぐため、
 * 直近に同じ slackThreadTs を持つ「受付」「GO待ち」「議論中」チケットを検索。
 * ヒットしたら既存チケットを返し、新規起票をスキップする。失敗時は null を返す（fail-safe）。
 * Notion版は rich_text の contains（部分一致）だったが、Postgres では列が構造化されている
 * ので完全一致で引く（部分一致による取り違えが起きない分こちらが厳密で安全）。 */
export async function findExistingBySlackThreadTs(
  threadTs: string,
  channelId: string
): Promise<TicketRow | null> {
  if (!threadTs || !channelId) return null;
  try {
    const rows = await query(
      `SELECT ${TICKET_COLUMNS} FROM tickets
       WHERE slack_thread_ts = $1 AND slack_channel_id = $2 AND state = ANY($3)
       ORDER BY created_at DESC LIMIT 1`,
      [threadTs, channelId, [KZ_STATUS.OPEN, KZ_STATUS.AWAITING_GO, KZ_STATUS.DISCUSSING]]
    );
    return rows[0] ? mapTicketRow(rows[0]) : null;
  } catch (err) {
    console.error(
      "[tickets] findExistingBySlackThreadTs failed:",
      (err as Error).message
    );
    return null;
  }
}

/** 「実装中」が一定時間以上滞留したチケット（=stuck）の判定しきい値（分）。
 * implement ジョブ（GitHub Actions）が失敗/タイムアウト/中断で callback に到達しないと、
 * チケットが「実装中」のまま永久滞留する。閾値は env KAIZEN_STUCK_MINUTES（既定30分）。 */
export function staleImplementingMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_STUCK_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** あるチケットが「実装中」かつ最終更新から minutes 分以上経過しているか（stuck判定）。
 * lastEdited（tickets.updated_at）で経過を測る。lastEdited が無い/不正なら
 * 経過判定できないので「stuckではない（false）」とみなす（誤って巻き戻さない安全側）。 */
export function isStaleImplementing(
  row: Pick<TicketRow, "state" | "lastEdited">,
  now: number,
  minutes: number
): boolean {
  if (row.state !== "実装中") return false;
  if (!row.lastEdited) return false;
  const edited = Date.parse(row.lastEdited);
  if (!Number.isFinite(edited)) return false;
  return now - edited >= minutes * 60_000;
}

/** 「実装中」のまま stuck（一定時間以上滞留）しているチケットを取得する。
 * implement ジョブが callback に到達せず取り残されたチケットを回収するための入口。
 * 「実装中」を取得してから lastEdited で経過判定する（Notion時代と同じ二段構え）。 */
export async function fetchStaleImplementing(
  minutes: number = staleImplementingMinutes(),
  limit = 10,
  now: number = Date.now()
): Promise<TicketRow[]> {
  const rows = await fetchTicketsByState("実装中", limit);
  return rows.filter((r) => isStaleImplementing(r, now, minutes));
}

// ── 自動リトライ上限（reaper の無限リトライ根絶・KZ-17事案） ──
// reaper は「実装中」滞留チケットを「着手」へ戻すたびに議論ログへ印（REAPER_RESET_HEADING）を
// 残している。この印の「数」をリトライ回数の真実の源にする（DBが正＝インスタンス跨ぎでも効く・
// tickets 側に専用カラムを増やさずに済む）。
// 上限（env KAIZEN_MAX_RETRIES・既定3）に達したら「着手」へ戻さず「差し戻し」へ落とす。

/** reaper が「実装中→着手」へ戻すとき議論に残す印の見出し（カウント対象）。 */
export const REAPER_RESET_HEADING = "stuck回収（自動リセット）";

/** リトライ上限到達で差し戻したときの見出し。これ「以降」の印だけを数える＝
 * 人が原因を直して再GOしたら、また上限までリトライ枠が復活する（永久封印にしない）。 */
export const RETRY_CAP_HEADING = "自動リトライ上限（差し戻し）";

/** 直近の失敗理由を拾う見出し（callback が残す議論ブロック）。 */
const FAILURE_HEADINGS = ["基盤エラー", "実装失敗"];

/** 自動リトライの上限回数。env KAIZEN_MAX_RETRIES（既定3・0〜20にクランプ）。
 * 0＝自動リトライ禁止（初回stuckで即差し戻し）。不正値・負値は既定3（安全側）。 */
export function maxAutoRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KAIZEN_MAX_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return 3;
  return Math.min(20, Math.floor(raw));
}

export interface ReaperRetryInfo {
  /** これまでに reaper が「着手」へ戻した回数（最後の上限到達以降）。 */
  count: number;
  /** 議論ログに残っている直近の失敗理由（無ければ null）。 */
  lastFailure: string | null;
}

/** 議論ログ1行（ticket_discussion_blocks の1レコード）。
 * Notion時代は heading_3 / paragraph という別々のブロックだったが、Postgres では
 * 「見出し＋本文」を1行に持つ。appendDiscussionBlocks が受ける形と同じ。 */
export interface DiscussionBlock {
  heading?: string | null;
  body?: string | null;
}

/** 議論ログ列から「リトライ回数」と「直近の失敗理由」を数える純粋ロジック。
 * - REAPER_RESET_HEADING を含む見出しを1リトライと数える。
 * - RETRY_CAP_HEADING を見たらカウントをリセット（再GO後は枠が復活）。
 * - FAILURE_HEADINGS（基盤エラー/実装失敗）の見出しに続く本文を失敗理由として拾う
 *   （最後のものが勝つ）。本文に「詳細：」があればその後ろだけを理由として使う
 *   （定型文を除いた実エラー文）。
 * ★Notion blocks 形式から DiscussionBlock 形式へ入力を変えたが、判定ロジックは同一。
 *   1行に heading と body の両方が入る場合も、Notion時代の「見出し→直後の段落」と
 *   同じ順序で評価されるため結果は変わらない。 */
export function summarizeRetryBlocks(blocks: DiscussionBlock[]): ReaperRetryInfo {
  let count = 0;
  let lastFailure: string | null = null;
  let pendingFailureHeading = false;
  for (const b of blocks || []) {
    const heading = (b?.heading ?? "").trim();
    const body = (b?.body ?? "").trim();
    if (heading) {
      if (heading.includes(RETRY_CAP_HEADING)) {
        count = 0; // 上限到達で一区切り。以降（人が再GOした後）の印だけ数える。
      } else if (heading.includes(REAPER_RESET_HEADING)) {
        count++;
      }
      pendingFailureHeading = FAILURE_HEADINGS.some((h) => heading.includes(h));
    }
    if (body && pendingFailureHeading) {
      const idx = body.lastIndexOf("詳細：");
      const reason = (idx >= 0 ? body.slice(idx + "詳細：".length) : body).trim();
      if (reason) lastFailure = reason;
      pendingFailureHeading = false;
    }
  }
  return { count, lastFailure };
}

/**
 * 指定の見出し文字列を含む議論ログ行が既にあるか（kz-sweepの連打防止用）。
 *
 * 【引き継ぎ・重要】Postgres移行前は Notion のページブロックを直接検索していたが、
 * 議論ログの保存先が ticket_discussion_blocks（Postgres）に変わったため、Notion検索の
 * ままだと**新しく積んだリマインド見出しが永久に見つからず、同じリマインドが
 * cron実行のたびに再送され続ける**（社長への通知スパム）。この関数はその置き換え。
 * fail-safe方針は元実装と同じ＝取得失敗・例外時は「既にある」とみなして送らない側に倒す。
 */
export async function hasDiscussionHeading(pageId: string, heading: string): Promise<boolean> {
  try {
    if (!pageId) return true;
    const ticketId = await resolveTicketId(pageId);
    if (ticketId === null) return true;
    const rows = await query<{ heading: string | null }>(
      `SELECT heading FROM ticket_discussion_blocks WHERE ticket_id = $1::bigint AND heading LIKE '%' || $2 || '%'`,
      [ticketId, heading]
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[tickets] hasDiscussionHeading 例外（送らない側の安全側）:", (err as Error).message);
    return true;
  }
}

/** チケットの議論ログを読み、リトライ回数と直近失敗理由を返す。
 * ★ fail-safe：取得失敗・接続不可・例外はすべて { count: 0, lastFailure: null } を返す
 * ＝「数えられないときは従来どおり『着手』へ戻す側」に倒す（誤って差し戻さない安全側）。 */
export async function getReaperRetryInfo(pageId: string): Promise<ReaperRetryInfo> {
  const empty: ReaperRetryInfo = { count: 0, lastFailure: null };
  try {
    if (!pageId) return empty;
    const ticketId = await resolveTicketId(pageId);
    if (ticketId === null) return empty;
    // 追記専用ログなので挿入順＝id昇順が時系列。ここは必ず id ASC で読む。
    const rows = await query<{ heading: string | null; body: string | null }>(
      `SELECT heading, body FROM ticket_discussion_blocks WHERE ticket_id = $1::bigint ORDER BY id ASC`,
      [ticketId]
    );
    return summarizeRetryBlocks(rows);
  } catch (err) {
    console.error(
      "[tickets] getReaperRetryInfo 例外（count=0の安全側）:",
      (err as Error).message
    );
    return empty;
  }
}

/** 完了済みかつ未学習（FGSリンク空）のチケットを取得 */
export async function fetchCompletedUnlearned(limit = 10): Promise<TicketRow[]> {
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets
     WHERE state = $1 AND (fgs_url IS NULL OR fgs_url = '')
     ORDER BY created_at DESC LIMIT $2`,
    [KZ_STATUS.DONE, cap(limit)]
  );
  return rows.map(mapTicketRow);
}

/** tickets の1カラムを更新する共通処理。updated_at も必ず進める
 * （Notion の last_edited_time が更新のたび進んでいたのと同じ＝stuck判定の基準を保つ）。
 * 該当行が無ければ何もしない（Notion時代の404相当を no-op に倒す）。 */
async function updateTicketColumn(
  pageId: string,
  column: string,
  value: any
): Promise<void> {
  const where = pageIdWhere(pageId);
  if (!where) return;
  await query(
    `UPDATE tickets SET ${column} = $2, updated_at = now() WHERE ${where.sql}`,
    [where.param, value]
  );
}

/** 状態を更新 */
export async function updateTicketState(
  pageId: string,
  state: string
): Promise<void> {
  await updateTicketColumn(pageId, "state", state);
}

/** FGSリンクを設定（学び還元の冪等マーク用） */
export async function setTicketUrlField(
  pageId: string,
  url: string
): Promise<void> {
  await updateTicketColumn(pageId, "fgs_url", url);
}

/** PR URL を設定（レビュー通知の紐付け用・stallカード対応・2026-08-15）。
 * ★Notion時代は「PR URL」プロパティが無いDBだと400で例外を投げる仕様で、呼び出し側
 * （execute/callback route）は catch して握り潰していた。Postgres では pr_url 列が
 * 常に存在するのでこの例外はもう起きない（呼び出し側の catch は無害な保険として残る）。 */
export async function setPrUrl(pageId: string, url: string): Promise<void> {
  await updateTicketColumn(pageId, "pr_url", url);
}

/** 担当を設定 */
export async function setTicketAssignee(
  pageId: string,
  who: string
): Promise<void> {
  // Notion時代の .slice(0, 1900) は rich_text の2000字上限に合わせた措置。
  // Postgres の TEXT に長さ制限は無いので切り詰めない（情報を落とさない）。
  await updateTicketColumn(pageId, "assignee", who);
}

/** 議論内容を「見出し＋本文」の追記専用ログとして末尾に追記する。
 * ★挿入順（id昇順）が時系列＝getReaperRetryInfo のリトライ集計の前提なので、
 *   1回のINSERT文に複数VALUESを並べて順序を確定させる（並列INSERTで順序が崩れない）。
 * 該当チケットが無ければ例外（Notion時代に404で例外だったのと同じ挙動）。 */
export async function appendDiscussionBlocks(
  pageId: string,
  lines: { heading?: string; body?: string }[]
): Promise<void> {
  const rows = (lines || []).filter((l) => l && (l.heading || l.body));
  if (rows.length === 0) return;

  const ticketId = await resolveTicketId(pageId);
  if (ticketId === null) {
    throw new Error(`[tickets] appendDiscussionBlocks: チケットが見つかりません pageId=${pageId}`);
  }

  const params: any[] = [ticketId];
  const values: string[] = [];
  for (const line of rows) {
    params.push(line.heading ?? null, line.body ?? null);
    values.push(`($1::bigint, $${params.length - 1}, $${params.length})`);
  }
  await query(
    `INSERT INTO ticket_discussion_blocks (ticket_id, heading, body) VALUES ${values.join(", ")}`,
    params
  );

  // 議論の追記も「更新」なので updated_at を進める（Notionでブロック追記が
  // last_edited_time を進めていたのと同じ＝stuck判定・/board の並びを保つ）。
  await query(`UPDATE tickets SET updated_at = now() WHERE id = $1::bigint`, [ticketId]);
}

// ── Phase 1 追加関数 ──

/**
 * 状態変更日時を現在時刻で更新する。
 * `updateTicketState` と一緒に呼ぶことで、タイムアウト計測の起点を記録する。
 * ★Notion時代は「状態変更日時」プロパティが無いDBだと400になるため try-catch で
 *   握り潰していた。Postgres では status_changed_at 列が常に存在するのでこの例外は
 *   実質発火しない。接続断など想定外の失敗でも状態遷移本体を巻き添えにしないよう
 *   fail-safe だけは残す。
 */
export async function setStatusChangedAt(
  pageId: string,
  now: Date = new Date()
): Promise<void> {
  try {
    await updateTicketColumn(pageId, "status_changed_at", now.toISOString());
  } catch (err) {
    // タイムアウト計測できないだけで本筋の状態遷移は止めない。
    console.warn("[tickets] setStatusChangedAt skipped:", (err as Error).message);
  }
}

/**
 * 終端でない全チケットを取得する（kz-sweep cron 用）。
 * 対象状態: GO待ち・差し戻し・レビュー・真田実装中（タイムアウト監視対象）。
 * 着手/実装中は既存 execute の reaper が担うためここでは除外する。
 * Notion時代は状態ごとに件数を按分して複数回クエリしていたが、Postgres では
 * 1クエリ（state = ANY）でまとめて取れるので按分は不要。
 */
export async function fetchNonTerminalTickets(limit = 50): Promise<TicketRow[]> {
  // 「真田実装中」は自動改修の対象外（kz-state.ts SANADA_IMPLEMENTING）だが、放置検知の対象には
  // 入れる。監視対象から外すと、真田側のセッションが落ちたチケットが誰にも気付かれず永久に残る。
  // 自動クローズはせずリマインドのみ（kz-sweep 側で分岐）。
  const states = ["GO待ち", "差し戻し", "レビュー", KZ_STATUS.SANADA_IMPLEMENTING];
  const rows = await query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE state = ANY($1)
     ORDER BY created_at DESC LIMIT $2`,
    [states, cap(limit)]
  );
  return rows.map(mapTicketRow);
}

// ── 社長⇔カイゼンくんのLINE往復ログ（旧 lib/kaizen-notion.ts の Postgres移行版） ──
// 【DB移行・2026-08-16】旧実装は Notion「lineChat」rich_textプロパティに改行区切りで
// 追記していた。tickets.line_chat 列（TEXT）へ同じ形式のまま移す。呼び出し元
// （lib/kaizen-notion.ts が薄いラッパーとして再エクスポート）は変更不要。

/** チケットのLINE往復ログへ1行追記する（「HH:MM ユーザー: メッセージ」形式）。 */
export async function appendLineChat(pageId: string, chatLine: string): Promise<boolean> {
  if (!pageId || !chatLine) return false;
  try {
    const ticketId = await resolveTicketId(pageId);
    if (ticketId === null) return false;
    await query(
      `UPDATE tickets SET line_chat = CASE WHEN line_chat = '' THEN $2 ELSE line_chat || E'\n' || $2 END,
       updated_at = now() WHERE id = $1::bigint`,
      [ticketId, chatLine]
    );
    return true;
  } catch (err) {
    console.error("[tickets] appendLineChat error:", (err as Error).message);
    return false;
  }
}

/** チケットのLINE往復ログ全文を取得する（改行区切り）。 */
export async function getLineChat(pageId: string): Promise<string> {
  if (!pageId) return "";
  try {
    const ticketId = await resolveTicketId(pageId);
    if (ticketId === null) return "";
    const rows = await query<{ line_chat: string }>(
      `SELECT line_chat FROM tickets WHERE id = $1::bigint`,
      [ticketId]
    );
    return rows[0]?.line_chat ?? "";
  } catch (err) {
    console.error("[tickets] getLineChat error:", (err as Error).message);
    return "";
  }
}

/** LINE往復ログ列の初期化。Postgresでは列自体がDEFAULT ''で常に初期化済みのため実質no-op
 * （既存呼び出し元との互換のためインターフェースだけ残す）。 */
export async function ensureLineChatField(pageId: string): Promise<boolean> {
  if (!pageId) return false;
  const ticketId = await resolveTicketId(pageId).catch(() => null);
  return ticketId !== null;
}
