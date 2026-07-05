/**
 * ── 監視返信の承認フロー（kaizen-monitor 連携）──
 *
 * kaizen-monitor（#ai_テスト Slack監視・ローカル常駐）は真田宛の投稿を検知すると
 * 社長へ LINE 報告し、その中に「返信案（真田Botでこの内容で返事します）」を同梱する。
 * 本モジュールはその返信案を「保留」としてサーバ側に登録し、社長が LINE で
 * 「これで返事して」と承認した瞬間に persona-slack-relay 経由で真田Bot として
 * 元の Slack スレッドへ投稿する（④承認→⑤返信の無人化・2026-07-05 社長指示）。
 *
 * 永続化: Notion ページ（MONITOR_STATE_PAGE_ID / 既定=ダイジェストページ）の子ブロック
 *   ⟦MPR⟧{json}   … 保留中の返信案
 *   ⟦MPRD⟧{json}  … 承認・投稿済み（再送防止のため書き換えで消費）
 * notification.ts の ⟦KZQ⟧/⟦KZS⟧ と同じパターン。ページは kaizen-mado
 * インテグレーションに接続済み（2026-07-05 実書込テストで確認済）。
 *
 * fail-safe: 鍵（NOTION_TOKEN / PERSONA_RELAY_*）が無ければ全機能 no-op。
 * webhook の通常会話は一切壊さない。
 */

const MPR_PREFIX = "⟦MPR⟧";
const MPR_DONE_PREFIX = "⟦MPRD⟧";
const NOTION_VERSION = "2022-06-28";
// ⑤通知ダイジェストページ（インテグレーション接続済み・KZQ/KZSと同居）
const DEFAULT_STATE_PAGE = "3930d9808b3b8138beccec54fe02e65d";
// 保留の有効期限（これより古い保留は承認対象にしない＝事故防止）
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

export interface PendingReply {
  id: string;
  channelId: string;
  threadTs: string;
  draft: string;
  sourceText?: string;
  createdAt: number;
}

interface PendingBlock {
  blockId: string;
  entry: PendingReply;
}

function statePageId(): string {
  return process.env.MONITOR_STATE_PAGE_ID || DEFAULT_STATE_PAGE;
}

function notionToken(): string | null {
  return process.env.NOTION_TOKEN || null;
}

/** 承認→Slack投稿まで動かせる状態か（登録は NOTION_TOKEN だけで可）。 */
export function monitorReplyEnabled(): boolean {
  return !!(
    notionToken() &&
    process.env.PERSONA_RELAY_URL &&
    process.env.PERSONA_RELAY_SECRET
  );
}

/**
 * 社長の LINE 発言が「監視返信の承認」か判定する。
 * 例: 「これで返事して」「これで返信して」「この内容で送って」「返事して」
 * 誤爆防止のため文頭アンカー＋短文のみ（長文の一部に含まれる場合は通常会話へ）。
 */
export function isMonitorApproval(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 30) return false;
  return /^(これで|この内容で|それで)?\s*(返事|返信)\s*(して|お願いします|お願い|頼む|どうぞ)/.test(t) ||
         /^(これで|この内容で|それで)\s*送って/.test(t);
}

/** 保留を登録する（B スクリプトが LINE 報告直後に呼ぶ）。 */
export async function registerPendingReply(input: {
  channelId: string;
  threadTs: string;
  draft: string;
  sourceText?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = notionToken();
  if (!token) return { ok: false, error: "NOTION_TOKEN not set" };
  const entry: PendingReply = {
    id: Math.random().toString(36).slice(2, 10),
    channelId: input.channelId,
    threadTs: input.threadTs,
    draft: input.draft,
    sourceText: (input.sourceText || "").slice(0, 300),
    createdAt: Date.now(),
  };
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${statePageId()}/children`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: { content: MPR_PREFIX + JSON.stringify(entry) },
                },
              ],
            },
          },
        ],
      }),
    }
  );
  if (!res.ok) return { ok: false, error: `notion ${res.status}` };
  return { ok: true, id: entry.id };
}

/** ページの子ブロックから保留（⟦MPR⟧・TTL内）を新しい順で返す。 */
async function listPending(): Promise<PendingBlock[]> {
  const token = notionToken();
  if (!token) return [];
  const out: PendingBlock[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const res = await fetch(
      `https://api.notion.com/v1/blocks/${statePageId()}/children?${qs.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      }
    );
    if (!res.ok) break;
    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        type?: string;
        paragraph?: { rich_text?: Array<{ plain_text?: string }> };
      }>;
      has_more?: boolean;
      next_cursor?: string;
    };
    for (const b of data.results || []) {
      if (b.type !== "paragraph") continue;
      const text = (b.paragraph?.rich_text || [])
        .map((r) => r.plain_text || "")
        .join("");
      if (!text.startsWith(MPR_PREFIX)) continue;
      try {
        const entry = JSON.parse(text.slice(MPR_PREFIX.length)) as PendingReply;
        if (
          entry.channelId &&
          entry.threadTs &&
          entry.draft &&
          Date.now() - entry.createdAt < PENDING_TTL_MS
        ) {
          out.push({ blockId: b.id, entry });
        }
      } catch {
        // 壊れたブロックは無視（fail-safe）
      }
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out.sort((a, b) => b.entry.createdAt - a.entry.createdAt);
}

/** 保留ブロックを ⟦MPRD⟧ に書き換えて消費する（再送防止）。 */
async function consumePending(pb: PendingBlock): Promise<void> {
  const token = notionToken();
  if (!token) return;
  await fetch(`https://api.notion.com/v1/blocks/${pb.blockId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content:
                MPR_DONE_PREFIX +
                JSON.stringify({ ...pb.entry, approvedAt: Date.now() }),
            },
          },
        ],
      },
    }),
  }).catch(() => {});
}

/** persona-slack-relay 経由で真田Bot としてスレッド返信する。 */
async function postSanadaReply(
  channelId: string,
  threadTs: string,
  text: string
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const url = process.env.PERSONA_RELAY_URL;
  const secret = process.env.PERSONA_RELAY_SECRET;
  if (!url || !secret) return { ok: false, error: "relay not configured" };
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-relay-secret": secret,
      },
      body: JSON.stringify({
        persona: "sanada",
        channel: channelId,
        text,
        thread_ts: threadTs,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `relay ${res.status}` };
    }
    return { ok: true, ts: data.ts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** スレッド返信の純正 permalink を組み立てる。 */
function threadPermalink(channelId: string, ts: string, threadTs: string): string {
  const p = ts.replace(".", "");
  return `https://takagisangyou.slack.com/archives/${channelId}/p${p}?thread_ts=${threadTs}&cid=${channelId}`;
}

export interface ApprovalResult {
  ok: boolean;
  reason?: "no_pending" | "relay_failed" | "not_configured";
  error?: string;
  permalink?: string;
  entry?: PendingReply;
}

/**
 * 最新の保留返信を承認・実行する（LINE「これで返事して」から呼ばれる本体）。
 * 成功: Slackへ真田Bot投稿→保留を消費→permalink を返す。
 */
export async function approveLatestPendingReply(): Promise<ApprovalResult> {
  if (!monitorReplyEnabled()) return { ok: false, reason: "not_configured" };
  const pending = await listPending();
  if (pending.length === 0) return { ok: false, reason: "no_pending" };
  const latest = pending[0];
  const posted = await postSanadaReply(
    latest.entry.channelId,
    latest.entry.threadTs,
    latest.entry.draft
  );
  if (!posted.ok) {
    return { ok: false, reason: "relay_failed", error: posted.error };
  }
  await consumePending(latest);
  return {
    ok: true,
    entry: latest.entry,
    permalink: posted.ts
      ? threadPermalink(latest.entry.channelId, posted.ts, latest.entry.threadTs)
      : undefined,
  };
}
