// ── 真田システム（mention-hisho）への受け渡し（handoff） ──
// 社長指示 2026-08-12：カイゼンくんが自前でLINE通知を出すのをやめ、用件は真田のシステムへ渡す。
// 真田側は受け取った用件を「真田宛メンションが来た状態」として扱い、既存の真田LINEカード
// （✅OK / ✏️修正 / 🚫却下 / 🛠ClaudeCodeへ送る の4択）を社長へ出す。
//
// 同じ社長指示で、重要度・危険度に関係なく**全チケットが必ず社長のLINE確認を経由する**運用に変更した
// （旧オートパイロット自動着手は廃止・app/api/process/route.ts 参照）。
// この受け渡しは「社長へ届ける唯一の経路」になるため、失敗しても例外は投げず boolean を返し、
// 呼び出し側（process）が false のときだけ従来の pushProposal（自前LINE）へフォールバックする
// ＝社長に何も届かない無音状態を作らない。
import type { TicketRow } from "./tickets";
import { findTarget } from "./targets";

/** 相手側（mention-hisho）の受け口パス。真田側の実装と合わせてある（変更時は両側同時）。 */
const HANDOFF_PATH = "/api/kaizen/handoff";
/** 1回あたりのタイムアウト（ms）。cron内から呼ばれるので長く待たない。 */
const TIMEOUT_MS = 10_000;
/** 試行回数（初回＋リトライ1回）。 */
const ATTEMPTS = 2;

/** 真田システムへ渡すペイロード（相手側と合意済みの固定形式）。 */
export interface HandoffPayload {
  ticketId: string;
  title: string;
  detail: string;
  system: string;
  type: string;
  priority: string;
  reporter: string;
  ticketUrl: string;
  /** 対象システムのGitHubリポ（owner/repo）。未確定なら省略。 */
  repo?: string;
  /** ラボの議論で出た方針。 */
  houshin: string;
  /** ラボの議論で出た改善手順。 */
  steps: string[];
  /**
   * Slack起点チケット（幹部Botへの app_mention から自動起票）だけが持つ、元の投稿の位置。
   *
   * 【バグチェック High-2 修正・2026-08-12】相手側（mention-hisho）は最初から
   * `slackChannel` / `slackThreadTs` を受け取る設計なのに、こちらが**一度も送っていなかった**。
   * その結果 mention-hisho 側は threadTs に合成ts（`kaizen:<ticketId>`）を入れるしかなく、
   * 社長がカードの「✅OK」を押すと chat.postMessage が `invalid_thread_ts` で必ず失敗していた
   * （2026-08-12 実測）。＝「押せるのに必ず失敗するボタン」。
   * Slack起点なら元スレッドへ返せるよう、ここで渡す。
   */
  slackChannel?: string;
  slackThreadTs?: string;
}

/** 受け渡しが有効か（宛先ベースURLが設定されているか）。未設定なら handoff は不活性。 */
export function handoffEnabled(): boolean {
  return Boolean((process.env.MENTION_HISHO_BASE_URL || "").trim());
}

/**
 * 完了報告・詰まり連絡・Merge待ち等の「返信不要のFYI」を真田システムへ渡す（社長指示 2026-08-15）。
 * GO伺い（handoffToSanada）と違い3案生成・ボタンカードは経由しない（相手側 kind="fyi" 分岐）。
 * env未設定・送信失敗時は例外を投げず false を返す（呼び出し側が真田Bot経由のSlack警告へフォールバックする。
 * カイゼンくん自前LINEへは一切フォールバックしない＝社長指示 2026-08-15「カイゼンくんのLINEチャネルに
 * 一切来ない仕組みにして」に合わせ、自前LINE送信経路をゼロにした）。
 *
 * opts.awaitsReply … このFYIが「社長の返信を必要とする」性質のとき true を渡す（詰まり連絡等）。
 * 相手側（mention-hisho）はこのフラグが立った通知だけ、LINE送信後の messageId を控えておき、
 * 社長がその通知を"引用返信"したときに `POST /api/kaizen/reply` へ書き戻す（自由文の通常返信は
 * 真田チャネルのwebhookで全部Claude Code Routine起動に使われるため、引用返信でだけ区別する）。
 */
export async function handoffFyiToSanada(
  ticketId: string,
  text: string,
  opts?: { awaitsReply?: boolean }
): Promise<boolean> {
  const base = (process.env.MENTION_HISHO_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return false;

  const url = `${base}${HANDOFF_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  const secret = (process.env.KAIZEN_HANDOFF_SECRET || "").trim();
  if (secret) headers["x-kaizen-handoff-secret"] = secret;

  const payload: { kind: "fyi"; ticketId: string; fyiText: string; awaitsReply?: true } = {
    kind: "fyi",
    ticketId,
    fyiText: text,
  };
  if (opts?.awaitsReply === true) payload.awaitsReply = true;
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok === true) return true;
      console.warn(
        `[handoff-fyi] failed (attempt ${attempt}/${ATTEMPTS}):`,
        data?.error ?? `http ${res.status}`
      );
    } catch (err) {
      console.warn(
        `[handoff-fyi] error (attempt ${attempt}/${ATTEMPTS}):`,
        (err as Error).message
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/** NotionチケットページのURL（lib/line.ts の notionPageUrl と同じ組み立て）。
 * kz-sweep（stallペイロード組み立て）からも参照するため export する。 */
export function ticketUrlOf(pageId: string): string {
  return `https://www.notion.so/${(pageId || "").replace(/-/g, "")}`;
}

/**
 * kz-sweep（状態タイムアウト監視）が送る「停滞（stall）」通知の固定形式（相手側と合意済み・2026-08-15）。
 * handoffToSanada（GO伺い）・handoffFyiToSanada（返信不要のFYI）とは別の kind="stall" 分岐で、
 * 相手側（mention-hisho）が種別ごとにFlexカードを出し分ける。
 */
export interface HandoffStallPayload {
  kind: "stall";
  ticketId: string;
  title: string;
  system: string;
  /** どの停滞状態か。Notion「状態」のGO待ち/差し戻し/レビュー/真田実装中に対応。 */
  stallKind: "awaiting_go" | "blocked" | "review" | "sanada_implementing";
  /** リマインド（未クローズ）か、7日超過による自動クローズの事後通知か。 */
  stallPhase: "remind" | "closed";
  /** その状態になってからの経過時間（時間単位・切り捨て）。 */
  elapsedHours: number;
  ticketUrl: string;
  /** 自動クローズまでの残り時間（時間単位）。stallPhase="remind" かつ awaiting_go/blocked のときのみ。 */
  autoCloseInHours?: number;
  /** レビュー中で判明しているPRのURL。stallKind="review" のときのみ。 */
  prUrl?: string;
}

/**
 * kz-sweep のタイムアウト監視通知（stall）を真田システムへ渡す。
 * handoffFyiToSanada と同型：10秒タイムアウト・2試行・例外を投げず boolean を返す。
 * env `MENTION_HISHO_BASE_URL` 未設定なら送らず false（呼び出し側が Slack警告へフォールバックする）。
 *
 * 【後方互換】mention-hisho 側がこの kind="stall" 分岐を未デプロイの間は 400 を返すため、
 * この関数は false を返し、呼び出し側（kz-sweep）は既存の Slack警告フォールバックへ落ちる
 * （無音状態にはならない）。
 */
export async function handoffStallToSanada(
  payload: HandoffStallPayload
): Promise<boolean> {
  const base = (process.env.MENTION_HISHO_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return false;

  const url = `${base}${HANDOFF_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  const secret = (process.env.KAIZEN_HANDOFF_SECRET || "").trim();
  if (secret) headers["x-kaizen-handoff-secret"] = secret;

  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok === true) return true;
      console.warn(
        `[handoff-stall] failed (attempt ${attempt}/${ATTEMPTS}):`,
        data?.error ?? `http ${res.status}`
      );
    } catch (err) {
      console.warn(
        `[handoff-stall] error (attempt ${attempt}/${ATTEMPTS}):`,
        (err as Error).message
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * チケット＋議論結果から、真田システムへ渡す body を組み立てる。
 * priority は新フィールド（高/中/低）を優先し、無ければ旧 importance にフォールバックする。
 * repo は findTarget で引き、未確定（null/未定義システム）なら**キー自体を省略**する。
 */
export function buildHandoffPayload(
  ticket: TicketRow,
  d: { houshin?: string; steps?: string[] }
): HandoffPayload {
  const repo = findTarget(ticket.system)?.repo ?? null;
  const payload: HandoffPayload = {
    ticketId: ticket.ticketId ?? "",
    title: ticket.title ?? "",
    detail: ticket.detail ?? "",
    system: ticket.system ?? "",
    type: ticket.type ?? "",
    priority: ticket.priority || ticket.importance || "",
    reporter: ticket.reporter ?? "",
    ticketUrl: ticketUrlOf(ticket.pageId),
    houshin: d?.houshin ?? "",
    steps: Array.isArray(d?.steps) ? d.steps : [],
  };
  if (repo) payload.repo = repo;
  // Slack起点チケットのときだけ、元スレッドの位置を渡す（両方揃っていないと返信先にならない）。
  if (ticket.slackChannelId && ticket.slackThreadTs) {
    payload.slackChannel = ticket.slackChannelId;
    payload.slackThreadTs = ticket.slackThreadTs;
  }
  return payload;
}

/**
 * 真田システム（mention-hisho）へ用件を受け渡す。
 * - env `MENTION_HISHO_BASE_URL` 未設定なら無効＝false を返して静かにスキップ（fail-safe）。
 * - 認証は env `KAIZEN_HANDOFF_SECRET` を `x-kaizen-handoff-secret` ヘッダで送る。
 * - 10秒タイムアウト・1回リトライ。例外は投げず boolean を返す。
 * - 相手が `{ok:true}` を返したときだけ成功。
 */
export async function handoffToSanada(
  ticket: TicketRow,
  d: { houshin?: string; steps?: string[] }
): Promise<boolean> {
  const base = (process.env.MENTION_HISHO_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return false;

  const url = `${base}${HANDOFF_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  const secret = (process.env.KAIZEN_HANDOFF_SECRET || "").trim();
  if (secret) headers["x-kaizen-handoff-secret"] = secret;

  const body = JSON.stringify(buildHandoffPayload(ticket, d));

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok === true) return true;
      console.warn(
        `[handoff] failed (attempt ${attempt}/${ATTEMPTS}):`,
        data?.error ?? `http ${res.status}`
      );
    } catch (err) {
      console.warn(
        `[handoff] error (attempt ${attempt}/${ATTEMPTS}):`,
        (err as Error).message
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
