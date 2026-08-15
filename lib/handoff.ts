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
 * env未設定・送信失敗時は例外を投げず false を返す（呼び出し側が自前LINEへフォールバックする）。
 */
export async function handoffFyiToSanada(ticketId: string, text: string): Promise<boolean> {
  const base = (process.env.MENTION_HISHO_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return false;

  const url = `${base}${HANDOFF_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  const secret = (process.env.KAIZEN_HANDOFF_SECRET || "").trim();
  if (secret) headers["x-kaizen-handoff-secret"] = secret;

  const body = JSON.stringify({ kind: "fyi", ticketId, fyiText: text });

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

/** NotionチケットページのURL（lib/line.ts の notionPageUrl と同じ組み立て）。 */
function ticketUrlOf(pageId: string): string {
  return `https://www.notion.so/${(pageId || "").replace(/-/g, "")}`;
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
