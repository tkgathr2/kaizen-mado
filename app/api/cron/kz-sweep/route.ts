// ── GET /api/cron/kz-sweep ── 状態タイムアウト監視（Phase 1 止血フェーズ） ──
// 毎時1回 Vercel Cron が叩く。非終端チケット（GO待ち・差し戻し・レビュー）を全件取得し、
// 各チケットの「状態変更日時」（または lastEdited）と現在時刻を比較してタイムアウトを判定する。
//
// タイムアウトアクション:
//   GO待ち  48h超 → LINE通知（リマインド）
//   GO待ち   7d超 → クローズ + LINE通知
//   差し戻し 48h超 → LINE通知（リマインド）
//   差し戻し  7d超 → クローズ + LINE通知
//   レビュー  7d超 → LINE通知（リマインド）
//
// 着手/実装中のreaper は既存 execute route が担う（ここでは扱わない）。
// CRON_SECRET 認証必須。LINE未設定なら通知をスキップ（状態遷移は実施）。
import { NextRequest, NextResponse } from "next/server";
import {
  fetchNonTerminalTickets,
  updateTicketState,
  appendDiscussionBlocks,
  setStatusChangedAt,
} from "@/lib/tickets";
import type { TicketRow } from "@/lib/tickets";
import { checkCronSecret } from "@/lib/cronAuth";
import { TIMEOUTS, KZ_STATUS } from "@/lib/kz-state";
import { lineEnabled, pushText } from "@/lib/line";
import { enqueueNotification } from "@/lib/notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron は GET で叩く。手動は POST でも可。
export async function GET(req: NextRequest) {
  return handler(req);
}
export async function POST(req: NextRequest) {
  return handler(req);
}

// ── タイムアウト起点（状態変更日時 > lastEdited の順でフォールバック）──
// statusChangedAt が無い旧チケットは lastEdited で代替する（安全側＝誤クローズなし）。
function getAnchor(row: TicketRow): number | null {
  if (row.statusChangedAt) {
    const t = Date.parse(row.statusChangedAt);
    if (Number.isFinite(t)) return t;
  }
  if (row.lastEdited) {
    const t = Date.parse(row.lastEdited);
    if (Number.isFinite(t)) return t;
  }
  return null; // 計測不能 → タイムアウト判定しない（安全側）
}

// ── LINE通知（fail-safe: LINE未設定・失敗なら握り潰す）──
async function notify(text: string): Promise<void> {
  if (!lineEnabled()) return;
  await pushText(text).catch((e) => {
    console.error("[kz-sweep] LINE通知失敗:", (e as Error).message);
  });
}

// ── 1チケットの処理 ──
interface SweepResult {
  ticketId: string;
  state: string;
  action: "none" | "reminded" | "closed";
  reason?: string;
}

async function processTicket(row: TicketRow, now: number): Promise<SweepResult> {
  const anchor = getAnchor(row);
  const base: Pick<SweepResult, "ticketId" | "state"> = {
    ticketId: row.ticketId,
    state: row.state,
  };

  // anchor が取れない場合はスキップ（誤クローズを絶対に起こさない）。
  if (anchor === null) {
    return { ...base, action: "none", reason: "anchor not found" };
  }

  const elapsedMs = now - anchor;

  // ── GO待ち ──
  if (row.state === KZ_STATUS.AWAITING_GO) {
    if (elapsedMs >= TIMEOUTS.AWAITING_GO_AUTO_CLOSE_MS) {
      // 7日超 → 自動クローズ
      await updateTicketState(row.pageId, KZ_STATUS.CLOSED);
      await setStatusChangedAt(row.pageId);
      await appendDiscussionBlocks(row.pageId, [
        {
          heading: "自動クローズ（GO待ちタイムアウト）",
          body: `GO待ちのまま7日間経過したため自動クローズしました。再検討の際は新しくカイゼン要望を送ってください。`,
        },
      ]);
      await notify(
        `📋 ${row.ticketId}「${row.title}」\nGO待ちのまま7日間経過したため自動クローズしました。\n対象: ${row.system}`
      );
      return { ...base, action: "closed", reason: "AWAITING_GO 7d timeout" };
    }
    if (elapsedMs >= TIMEOUTS.AWAITING_GO_REMIND_MS) {
      // 48h超 → リマインド（Notionに印を付けて連打しない）
      const alreadyReminded = await hasReminderBlock(row.pageId, "GO待ちリマインド");
      if (!alreadyReminded) {
        await appendDiscussionBlocks(row.pageId, [
          {
            heading: "GO待ちリマインド",
            body: `GO待ちになってから48時間以上経過しています。ご確認をお願いします。`,
          },
        ]);
        await notify(
          `⏰ ${row.ticketId}「${row.title}」\nGO待ちになってから48時間以上経過しています。ご確認をお願いします。\n対象: ${row.system}`
        );
        await enqueueNotification(
          row.ticketId,
          "stalled",
          `「${row.title}」がGO待ちのまま48時間以上（${row.system}）`
        ).catch(() => {});
        return { ...base, action: "reminded", reason: "AWAITING_GO 48h remind" };
      }
    }
    return { ...base, action: "none" };
  }

  // ── 差し戻し（BLOCKED）──
  if (row.state === KZ_STATUS.BLOCKED) {
    if (elapsedMs >= TIMEOUTS.BLOCKED_AUTO_CLOSE_MS) {
      // 7日超 → 自動クローズ
      await updateTicketState(row.pageId, KZ_STATUS.CLOSED);
      await setStatusChangedAt(row.pageId);
      await appendDiscussionBlocks(row.pageId, [
        {
          heading: "自動クローズ（差し戻しタイムアウト）",
          body: `差し戻しのまま7日間経過したため自動クローズしました。対応される場合は新しくカイゼン要望を送ってください。`,
        },
      ]);
      await notify(
        `📋 ${row.ticketId}「${row.title}」\n差し戻しのまま7日間経過したため自動クローズしました。\n対象: ${row.system}`
      );
      return { ...base, action: "closed", reason: "BLOCKED 7d timeout" };
    }
    if (elapsedMs >= TIMEOUTS.BLOCKED_REMIND_MS) {
      const alreadyReminded = await hasReminderBlock(row.pageId, "差し戻しリマインド");
      if (!alreadyReminded) {
        await appendDiscussionBlocks(row.pageId, [
          {
            heading: "差し戻しリマインド",
            body: `差し戻しになってから48時間以上経過しています。対応をお願いします。`,
          },
        ]);
        await notify(
          `⏰ ${row.ticketId}「${row.title}」\n差し戻しになってから48時間以上経過しています。\n対象: ${row.system}`
        );
        await enqueueNotification(
          row.ticketId,
          "stalled",
          `「${row.title}」が差し戻しのまま48時間以上（${row.system}）`
        ).catch(() => {});
        return { ...base, action: "reminded", reason: "BLOCKED 48h remind" };
      }
    }
    return { ...base, action: "none" };
  }

  // ── レビュー ──
  if (row.state === KZ_STATUS.REVIEW) {
    if (elapsedMs >= TIMEOUTS.REVIEW_REMIND_MS) {
      const alreadyReminded = await hasReminderBlock(row.pageId, "レビューリマインド");
      if (!alreadyReminded) {
        await appendDiscussionBlocks(row.pageId, [
          {
            heading: "レビューリマインド",
            body: `レビュー待ちになってから7日以上経過しています。PRのマージをご確認ください。`,
          },
        ]);
        await notify(
          `⏰ ${row.ticketId}「${row.title}」\nレビュー待ちになってから7日以上経過しています。\n対象: ${row.system}`
        );
        await enqueueNotification(
          row.ticketId,
          "stalled",
          `「${row.title}」がレビュー待ちのまま7日以上（${row.system}）`
        ).catch(() => {});
        return { ...base, action: "reminded", reason: "REVIEW 7d remind" };
      }
    }
    return { ...base, action: "none" };
  }

  return { ...base, action: "none" };
}

// ── 連打防止：指定の見出し文字列を含むブロックが既にあるか ──
// Notionの子ブロックを最大100件まで見て heading_3 の本文を検索する。
// 取得失敗時は「既にある」とみなして送らない（notify.ts の hasStuckMarker と同方針）。
const NOTION_VERSION = "2022-06-28";
async function hasReminderBlock(pageId: string, heading: string): Promise<boolean> {
  const token = process.env.NOTION_TOKEN;
  if (!token || !pageId) return false;
  try {
    const res = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      }
    );
    if (!res.ok) return true; // 確認できない時は送らない側に倒す
    const data = await res.json();
    const blocks: any[] = Array.isArray(data?.results) ? data.results : [];
    for (const b of blocks) {
      if (b?.type !== "heading_3") continue;
      const text: string = (b?.heading_3?.rich_text || [])
        .map((r: any) => r?.plain_text ?? "")
        .join("");
      if (text.includes(heading)) return true;
    }
    return false;
  } catch {
    return true; // 例外時も送らない側に倒す
  }
}

// ── メインハンドラ ──
async function handler(req: NextRequest): Promise<NextResponse> {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const results: SweepResult[] = [];
  const errors: { ticketId: string; error: string }[] = [];

  let tickets;
  try {
    tickets = await fetchNonTerminalTickets(50);
  } catch (err) {
    console.error("[kz-sweep] チケット取得失敗:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "チケット取得に失敗しました" },
      { status: 502 }
    );
  }

  for (const ticket of tickets) {
    try {
      const result = await processTicket(ticket, now);
      results.push(result);
    } catch (err) {
      console.error("[kz-sweep] チケット処理失敗:", ticket.ticketId, (err as Error).message);
      errors.push({ ticketId: ticket.ticketId, error: (err as Error).message });
    }
  }

  const reminded = results.filter((r) => r.action === "reminded").length;
  const closed = results.filter((r) => r.action === "closed").length;

  console.log(
    `[kz-sweep] 完了: scanned=${tickets.length} reminded=${reminded} closed=${closed} errors=${errors.length}`
  );

  return NextResponse.json({
    ok: true,
    scanned: tickets.length,
    reminded,
    closed,
    results,
    ...(errors.length ? { errors } : {}),
  });
}
