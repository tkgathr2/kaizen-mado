/**
 * カイゼン改善 通知管理
 * - 22:00-07:00 の送信を保留
 * - 08:00 にまとめて1通 LINE 送信
 * - 同一KZ・同種通知は再送抑止
 * - 実エラー要約を必須（「理由：不明」は禁止）
 */

import { replyText } from "@/lib/line";
import { fetchAllTickets, fetchTicketByPageId } from "@/lib/tickets";
import type { TicketRow } from "./tickets";

export interface QueuedNotification {
  id: string; // uuid
  ticketId: string; // KZ-XX
  type: "pr_ready" | "execution_started" | "error" | "completion" | "stalled";
  message: string; // LINE メッセージ本文
  errorSummary?: string; // エラー要約（「理由：不明」は禁止）
  createdAt: Date;
  shouldSendAt?: Date; // 次の送信候補時刻
}

const QUEUE: QueuedNotification[] = []; // インメモリ（本番は Redis）
const SENT_LOG = new Map<string, Date>(); // ticketId+type → 最後の送信時刻（再送抑止用）

/**
 * 通知をキューに追加（即座には送信しない）。
 * @param ticketId チケット ID
 * @param type 通知種別
 * @param message LINE メッセージ本文
 * @param errorSummary エラー要約（必須でない場合は undefined）
 */
export async function enqueueNotification(
  ticketId: string,
  type: QueuedNotification["type"],
  message: string,
  errorSummary?: string
): Promise<void> {
  // 「理由：不明」の禁止チェック
  if (type === "error" && (!errorSummary || errorSummary.includes("不明"))) {
    console.warn(`[notification] ticketId=${ticketId} のエラー要約が不明瞭。実エラーメッセージを入れてください。`);
    // 不明瞭なら送信保留（スキップ）
    return;
  }

  // 再送抑止：同じ ticketId+type が直近24時間に送信済みならスキップ
  const key = `${ticketId}:${type}`;
  const lastSent = SENT_LOG.get(key);
  if (lastSent) {
    const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      console.log(`[notification] ${key} は直近24時間に送信済み。再送抑止。`);
      return;
    }
  }

  const notification: QueuedNotification = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    ticketId,
    type,
    message,
    errorSummary,
    createdAt: new Date(),
  };

  QUEUE.push(notification);
  console.log(`[notification] enqueued: ${ticketId} (${type})`);
}

/**
 * キューから送信対象を取得・フィルタ（現在時刻が静穏時間外か判定）。
 * 22:00-07:00 は保留、08:00-21:59 は送信対象。
 */
export function getReadyNotifications(): QueuedNotification[] {
  const now = new Date();
  const hour = now.getHours();
  // 静穏時間: 22:00-06:59（22-23, 0-6）
  const isQuietHour = hour >= 22 || hour < 7;

  if (isQuietHour) {
    // 静穏時間 → 送信しない（次の 08:00 まで待つ）
    console.log(`[notification] 静穏時間中（${hour}:00）。次の 08:00 まで保留。`);
    return [];
  }

  // 08:00-21:59 なら送信対象を返す
  return QUEUE.splice(0, QUEUE.length); // 全キューを取得して空にする
}

/**
 * キューから取得した通知をまとめて LINE で社長に送信（1通のメッセージ）。
 * 本番は LINE replyToken ではなく社長への直接送信を使う（BOT API / Push Message）。
 * ここでは簡易実装で log のみ（実装後に LINE Bot SDK 統合）。
 */
export async function sendBatchNotifications(notifications: QueuedNotification[]): Promise<void> {
  if (notifications.length === 0) return;

  // まとめて1通に
  const lines: string[] = ["📢 カイゼン改善 通知（一括）"];
  const ticketGroups = new Map<string, QueuedNotification[]>();
  for (const n of notifications) {
    if (!ticketGroups.has(n.ticketId)) {
      ticketGroups.set(n.ticketId, []);
    }
    ticketGroups.get(n.ticketId)!.push(n);
  }

  // チケット ID ごとに整理
  for (const [ticketId, items] of ticketGroups.entries()) {
    lines.push(`\n${ticketId}:`);
    for (const n of items) {
      const typeLabel = {
        pr_ready: "🔍 PR レビュー待ち",
        execution_started: "🔧 着手開始",
        error: "⚠️ エラー発生",
        completion: "✅ 完了",
        stalled: "⏸ 停滞（7日以上）",
      }[n.type];
      lines.push(`  ${typeLabel}: ${n.message}`);
      if (n.errorSummary) {
        lines.push(`    → ${n.errorSummary}`);
      }
    }
  }

  const body = lines.join("\n");
  console.log(`[notification] batch send (${notifications.length} 件):\n${body}`);

  // 本番実装：LINE Bot API に POST
  // const resp = await fetch("https://api.line.biz/...", { ... });
  // if (resp.ok) {
  //   for (const n of notifications) {
  //     SENT_LOG.set(`${n.ticketId}:${n.type}`, new Date());
  //   }
  // }

  // 簡易実装：ログと SENT_LOG だけ更新
  for (const n of notifications) {
    SENT_LOG.set(`${n.ticketId}:${n.type}`, new Date());
  }
}

/**
 * 定時タスク：毎朝 08:00 に呼ぶ。
 * ① キューから送信対象を取得
 * ② LINE でまとめて送信
 * ③ SENT_LOG を更新
 */
export async function runDailyNotificationBatch(): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const minutes = now.getMinutes();

  // 08:00-08:30 の間に走る想定（CronJob / ScheduledTask）
  if (hour !== 8 || minutes >= 30) {
    console.log(`[notification] 定時ではない時刻（${hour}:${minutes}）。スキップ。`);
    return;
  }

  const notifications = getReadyNotifications();
  if (notifications.length > 0) {
    await sendBatchNotifications(notifications);
  } else {
    console.log("[notification] 通知なし。");
  }
}

/**
 * テスト/開発用：キューの状態を表示。
 */
export function debugQueue(): {
  queued: number;
  oldest?: QueuedNotification;
  sentLogSize: number;
} {
  return {
    queued: QUEUE.length,
    oldest: QUEUE.length > 0 ? QUEUE[0] : undefined,
    sentLogSize: SENT_LOG.size,
  };
}
