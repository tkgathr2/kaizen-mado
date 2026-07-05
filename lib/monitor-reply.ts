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

import { pushTextReturningId } from "@/lib/line";

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
  /** 元Slack投稿の送信者（自由文返信時のメンション先） */
  senderId?: string;
  /** この保留を提示したLINE報告メッセージのID（引用返信での対象特定に使う） */
  lineMessageId?: string;
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

/**
 * 「監視返信の取り下げ」か判定する（引用返信時のみ有効）。
 * 例: 「やめて」「送らないで」「返信しないで」「キャンセル」「却下」
 */
export function isMonitorCancel(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 20) return false;
  return /^(やめて|やめておいて|送らないで|返信しないで|返事しないで|キャンセル|取り下げ|却下|なし)/.test(t);
}

// ── 引用返信の意図判定（LLM）──
// 「これで返事して」「そのまま返して」「OK」…承認の言い回しは無限にあり、正規表現の
// 追いかけっこでは社長の日本語を取りこぼす（2026-07-05「そのまま返して」が自由文扱いに
// なり、その文字列がそのままSlackへ投稿された事故）。以後、明白な定型だけ高速パスで
// 判定し、残りは LLM に意図を聞く。LLM不通時は控えめフォールバック（誤投稿より確認）。
export type MonitorReplyIntent = "approve" | "cancel" | "custom" | "unclear";

const INTENT_TOOL = {
  name: "classify_intent",
  description: "社長の引用返信の意図を分類する",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["approve", "cancel", "custom"],
        description:
          "approve=用意済みの返信案をそのまま送ってよいという承認（例:これで返事して/そのまま返して/OK/いいよ/送って/お願い/承認）。" +
          "cancel=返信を送らない・取り下げ（例:やめて/送らないで/却下）。" +
          "custom=このメッセージ自体が返信本文（実際に相手へ送る文章が書かれている）。",
      },
    },
    required: ["intent"],
  },
} as const;

/** 引用返信テキストの意図を判定する。定型は正規表現の高速パス、それ以外は LLM。
 *  draft（提示済みの返信案）を渡すと LLM が文脈込みで判定できる（精度向上）。 */
export async function classifyMonitorReplyIntent(
  text: string,
  draft?: string
): Promise<MonitorReplyIntent> {
  const t = (text || "").trim();
  if (!t) return "unclear";
  // 高速パス（明白な定型のみ・API代ゼロ）
  if (isMonitorApproval(t)) return "approve";
  if (isMonitorCancel(t)) return "cancel";
  if (/^(そのまま|それ)(返して|送って|で(いい|OK|オッケー|お願い))/.test(t)) return "approve";
  if (t.length <= 10 && /^(ok|okay|オッケー|おっけー|おけ|了解|りょ|いいよ|良い|はい|お願い|頼む|承認|GO|ゴー)[。．!！~〜]*$/i.test(t)) return "approve";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return heuristicIntent(t);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        system:
          "背景：Slack投稿への返信案をLINEで社長に提示し、社長がそれに引用返信した。社長のメッセージを分類する。\n" +
          "- approve：提示済みの案を**そのまま送れ**という承認・同意。案の内容に言及せず GO だけを伝える言葉（例：これで返事して／そのまま返して／OK／いいよ／それでいこう）。\n" +
          "- custom：社長自身が書いた**返信文そのもの**。Slackの相手に宛てたメッセージとして成立する文章（挨拶・状況説明・対応の約束・具体的内容を含む）。案の代わりにこれを送る。\n" +
          "- cancel：送らない・取り下げ。\n" +
          "判定基準：そのメッセージをそのままSlackの相手に送って意味が通るなら custom。案への同意・指示なら approve。承諾の挨拶で始まっていても、具体的な対応内容や約束が書かれていれば custom。",
        messages: [
          {
            role: "user",
            content:
              (draft ? `【提示済みの返信案】\n${draft.slice(0, 500)}\n\n` : "") +
              `【社長の引用返信】\n${t}`,
          },
        ],
        tools: [INTENT_TOOL],
        tool_choice: { type: "tool", name: "classify_intent" },
      }),
    });
    if (!res.ok) return heuristicIntent(t);
    const data = (await res.json()) as {
      content?: Array<{ type: string; input?: { intent?: string } }>;
    };
    const tu = (data.content || []).find((c) => c.type === "tool_use");
    const intent = tu?.input?.intent;
    if (intent === "approve" || intent === "cancel" || intent === "custom") return intent;
    return heuristicIntent(t);
  } catch {
    return heuristicIntent(t);
  }
}

/** LLM不通時の控えめフォールバック。短文を誤って本文投稿する事故を避け、
 *  相手に向けた文章と思える長文だけ custom、短文は unclear（聞き直し）。 */
function heuristicIntent(t: string): MonitorReplyIntent {
  return t.length >= 20 ? "custom" : "unclear";
}

// ── 意図判定の成長エンジン ──
// 社長の引用返信パターンを全件ログ → 定期分析 → 新パターン自動提案の閉路。
// intent判定ログ: ⟦MILOG⟧{json}
const MILOG_PREFIX = "⟦MILOG⟧";

interface IntentLog {
  text: string;
  intent: MonitorReplyIntent;
  timestamp: number;
  draftPreview?: string; // 意思決定のコンテキスト（返信案を見て判定したか）
}

/** 引用返信の意図判定ログを記録する（成長エンジン向け学習データ蓄積）。
 *  fail-safe: NOTION_TOKEN なしでも何もしない（webhook壊さない）。 */
export async function recordIntentClassification(
  text: string,
  intent: MonitorReplyIntent,
  draftPreview?: string
): Promise<void> {
  const token = notionToken();
  if (!token) return;
  const entry: IntentLog = {
    text: text.slice(0, 200),
    intent,
    timestamp: Date.now(),
    draftPreview: draftPreview ? draftPreview.slice(0, 80) : undefined,
  };
  await fetch(
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
                  text: { content: MILOG_PREFIX + JSON.stringify(entry) },
                },
              ],
            },
          },
        ],
      }),
    }
  ).catch(() => {});
}

/** 保留を登録する（B スクリプトが LINE 報告直後に呼ぶ）。 */
export async function registerPendingReply(input: {
  channelId: string;
  threadTs: string;
  draft: string;
  sourceText?: string;
  senderId?: string;
  lineMessageId?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = notionToken();
  if (!token) return { ok: false, error: "NOTION_TOKEN not set" };
  const entry: PendingReply = {
    id: Math.random().toString(36).slice(2, 10),
    channelId: input.channelId,
    threadTs: input.threadTs,
    draft: input.draft,
    sourceText: (input.sourceText || "").slice(0, 300),
    senderId: input.senderId,
    lineMessageId: input.lineMessageId,
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

/**
 * LINE報告を送信し、返ってきた sentMessages[].id を保留に紐付けて登録する（原子的な1操作）。
 * これにより社長がそのLINE報告を「引用返信」したとき quotedMessageId で保留を特定できる。
 * kaizen-monitor（B スクリプト）はこの1コールだけで報告＋保留登録が完了する。
 */
export async function sendMonitorReportAndRegister(input: {
  reportText: string;
  channelId: string;
  threadTs: string;
  draft: string;
  sourceText?: string;
  senderId?: string;
}): Promise<{ ok: boolean; id?: string; lineMessageId?: string; error?: string }> {
  const sent = await pushTextReturningId(input.reportText);
  if (!sent.ok) return { ok: false, error: "LINE push failed" };
  const reg = await registerPendingReply({
    channelId: input.channelId,
    threadTs: input.threadTs,
    draft: input.draft,
    sourceText: input.sourceText,
    senderId: input.senderId,
    lineMessageId: sent.messageId,
  });
  if (!reg.ok) return { ok: false, error: reg.error };
  return { ok: true, id: reg.id, lineMessageId: sent.messageId };
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
  reason?: "no_pending" | "multiple_pending" | "relay_failed" | "not_configured";
  error?: string;
  permalink?: string;
  entry?: PendingReply;
  /** multiple_pending のとき、保留の件数 */
  pendingCount?: number;
}

/** 保留1件を実行する共通処理：Slackへ真田Bot投稿→保留を消費→permalink。
 *  overrideText があれば AI 案の代わりにその文面（社長の自由文）を送る。 */
async function executePending(
  pb: PendingBlock,
  overrideText?: string
): Promise<ApprovalResult> {
  let text = overrideText?.trim() || pb.entry.draft;
  // 自由文のときも元投稿者への冒頭メンションを保証（draft には B が付与済み）
  if (overrideText && pb.entry.senderId && !text.includes(`<@${pb.entry.senderId}>`)) {
    text = `<@${pb.entry.senderId}> ${text}`;
  }
  const posted = await postSanadaReply(pb.entry.channelId, pb.entry.threadTs, text);
  if (!posted.ok) {
    return { ok: false, reason: "relay_failed", error: posted.error };
  }
  await consumePending(pb);
  return {
    ok: true,
    entry: pb.entry,
    permalink: posted.ts
      ? threadPermalink(pb.entry.channelId, posted.ts, pb.entry.threadTs)
      : undefined,
  };
}

/** LINEの引用メッセージIDから保留を特定する（引用返信での対象特定）。 */
export async function findPendingByLineMessageId(
  lineMessageId: string
): Promise<{ found: boolean; execute: (overrideText?: string) => Promise<ApprovalResult>; cancel: () => Promise<void>; entry?: PendingReply }> {
  const pending = await listPending();
  const hit = pending.find((p) => p.entry.lineMessageId === lineMessageId);
  if (!hit) {
    return {
      found: false,
      execute: async () => ({ ok: false, reason: "no_pending" }),
      cancel: async () => {},
    };
  }
  return {
    found: true,
    entry: hit.entry,
    execute: (overrideText?: string) => executePending(hit, overrideText),
    cancel: () => consumePending(hit),
  };
}

/**
 * 保留返信を承認・実行する（引用なしの「これで返事して」から呼ばれる）。
 * 保留が1件だけならそれを実行。複数あるときは誤爆防止のため実行せず
 * multiple_pending を返す（呼び出し側が「引用して返信して」と促す）。
 */
export async function approveLatestPendingReply(): Promise<ApprovalResult> {
  if (!monitorReplyEnabled()) return { ok: false, reason: "not_configured" };
  const pending = await listPending();
  if (pending.length === 0) return { ok: false, reason: "no_pending" };
  if (pending.length > 1) {
    return { ok: false, reason: "multiple_pending", pendingCount: pending.length };
  }
  return executePending(pending[0]);
}
