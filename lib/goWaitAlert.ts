// ── GO待ち24時間超過アラート（Slack #カイゼンくん・毎朝8時JST）──
// 社長向けLINEダイジェスト（lib/notification.ts）とは別レイヤー：開発チーム向けにSlackへ、
// GO待ちのまま24時間を超えた案件だけを一覧通知する。GO待ちはstageBar上「🔵提案」表示
// （lib/line.ts の stageBar(2) 呼び出し箇所を参照）。
// PII保護：タイトルは lib/slack.ts の sanitizeSlackText で伏字化してから送る。
// fail-safe：SLACK_BOT_TOKEN / SLACK_CH_KAIZEN_ALERT 未設定・失敗時は例外を投げず結果で報告する。
import { fetchTicketsByState } from "./tickets";
import type { TicketRow } from "./tickets";
import { notionPageUrl } from "./line";
import { sanitizeSlackText, slackEnabled } from "./slack";

const WAIT_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const POST_TIMEOUT_MS = 8000;
/** 失敗時の簡潔なリトライ回数（合計試行回数）。 */
const POST_ATTEMPTS = 2;

/** タイムアウト計測の起点。状態変更日時→作成時刻→最終更新の順でフォールバック（安全側）。 */
function anchorMs(row: TicketRow): number | null {
  for (const raw of [row.statusChangedAt, row.createdTime, row.lastEdited]) {
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export interface GoWaitAlertItem {
  ticket: TicketRow;
  waitHours: number;
}

/** GO待ちのうち24時間超過している案件を、待機時間の長い順で抽出する（純粋ロジック）。 */
export function selectOverdue(
  rows: TicketRow[],
  now: number = Date.now()
): GoWaitAlertItem[] {
  const items: GoWaitAlertItem[] = [];
  for (const row of rows) {
    const anchor = anchorMs(row);
    if (anchor === null) continue;
    const elapsed = now - anchor;
    if (elapsed >= WAIT_THRESHOLD_MS) {
      items.push({ ticket: row, waitHours: Math.floor(elapsed / (60 * 60 * 1000)) });
    }
  }
  return items.sort((a, b) => b.waitHours - a.waitHours);
}

/** Slack投稿本文を組み立てる（PIIはsanitizeSlackTextで伏字化済み）。空なら投稿しない合図で ""。 */
export function buildGoWaitAlertText(items: GoWaitAlertItem[]): string {
  if (items.length === 0) return "";
  const lines = [`🔔 GO待ち 24時間超過（🔵提案のまま）：${items.length}件`, ``];
  for (const { ticket, waitHours } of items) {
    const title = sanitizeSlackText(ticket.title || "（無題）").slice(0, 60);
    lines.push(
      `・${ticket.ticketId || "(ID不明)"}｜重要度:${ticket.importance || "—"}｜待機${waitHours}h`
    );
    lines.push(`　${ticket.system || "システム不明"} - ${title}`);
    lines.push(`　▶ ${notionPageUrl(ticket.pageId)}`);
  }
  return lines.join("\n");
}

/** Slackチャンネルへ新規メッセージ投稿（スレッド無し）。簡潔な1回リトライ付き。 */
async function postChannelMessageWithRetry(
  channelId: string,
  text: string
): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return false;
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(SLACK_POST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ channel: channelId, text }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) return true;
      console.warn(
        `[goWaitAlert] slack post failed (attempt ${attempt}/${POST_ATTEMPTS}):`,
        data?.error ?? `http ${res.status}`
      );
    } catch (err) {
      console.warn(
        `[goWaitAlert] slack post error (attempt ${attempt}/${POST_ATTEMPTS}):`,
        (err as Error).message
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

export interface GoWaitAlertResult {
  ok: boolean;
  overdueCount: number;
  posted: boolean;
  reason?: string;
}

/**
 * GO待ち24時間超過アラートを実行する（cronから呼ぶ本体）。
 * SLACK_BOT_TOKEN / SLACK_CH_KAIZEN_ALERT のどちらか未設定なら no-op（fail-safe）。
 */
export async function runGoWaitAlert(): Promise<GoWaitAlertResult> {
  const channelId = process.env.SLACK_CH_KAIZEN_ALERT?.trim();
  if (!slackEnabled() || !channelId) {
    return { ok: true, overdueCount: 0, posted: false, reason: "slack未設定" };
  }
  try {
    const rows = await fetchTicketsByState("GO待ち", 100);
    const overdue = selectOverdue(rows);
    if (overdue.length === 0) {
      return { ok: true, overdueCount: 0, posted: false, reason: "対象なし" };
    }
    const text = buildGoWaitAlertText(overdue);
    const posted = await postChannelMessageWithRetry(channelId, text);
    return { ok: posted, overdueCount: overdue.length, posted };
  } catch (err) {
    console.error("[goWaitAlert] 実行失敗:", (err as Error).message);
    return { ok: false, overdueCount: 0, posted: false, reason: (err as Error).message };
  }
}
