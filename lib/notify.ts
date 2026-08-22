// ── 自分から送るLINE通知の絞り込み（社長承認の新仕様） ──
// カイゼンくんが"自分から"送るLINEは無い。全通知は真田システム（mention-hisho）への
// handoffを経由し、真田専用LINEチャネルから届く（社長指示 2026-08-15「カイゼンくんの
// LINEチャネルに一切来ない仕組みにして。ここに来ること自体がおかしい」）。
//   1) GO伺い（社長が決める案件）… process/route.ts が handoffToSanada を呼ぶ（＝判断要求）。
//      本モジュールでは扱わない。
//   2) 詰まり/困った連絡（人の助けが本当に要る時だけ・連打しない）… ここで実装する。
//
// 着手予告・着手・完了・PR完成 等の「進捗FYI」通知は新仕様で不要のため、各routeから削除済み。
//
// ★ 詰まり連絡の連打防止（de-dup）：
//   同じチケットでは「詰まり連絡」を1回だけ送る。判定は「そのチケットのページに
//   『詰まり通知済み』の印（heading_3ブロック）が既にあるか」で行う。既にあれば送らない、
//   無ければ送ってから印を残す。Notion自体を真実の源にするので、インスタンス跨ぎでも効く。
//
// ★ システム障害との線引き（コメント明記）：
//   今回の callback の failed（実装失敗→差し戻し）は「人の助けが要る詰まり」として
//   1回だけ通知する。真田が裏で直せるシステム故障（モデル切れ等の技術障害）の自動切り分けは
//   将来の死活監視で扱う＝今はスコープ外（ここでは failed をそのまま詰まりとして扱う）。
//
// ★ fail-safe：真田handoff・Slack警告のどちらも未設定なら送らない。読取/送信/追記で例外が
//   出ても握りつぶす（カイゼンくんの改善ループを通知の失敗で止めない）。
import type { TicketRow } from "./tickets";
import { appendDiscussionBlocks, hasDiscussionHeading } from "./tickets";
import {
  lineEnabled,
  notifySlackAlert,
  notifyKuharaCopy,
  buildKuharaStuckText,
  buildKuharaReviewText,
  truncateForLine,
  BOARD_URL,
  msgHead,
  stageBar,
  actionBanner,
} from "./line";
import { handoffEnabled, handoffFyiToSanada } from "./handoff";

/**
 * 真田システム（真田専用LINEチャネル）経由を優先し、失敗時は自前LINEへは送らず、
 * 真田Bot名義のSlack警告（persona-slack-relay・社長＋幹部Botのみのチャンネル）で
 * 「届いていない」ことだけを知らせる（社長指示 2026-08-15：カイゼンくん自前LINEへの
 * フォールバックを全廃し、届かない通知は無音ではなくSlack警告に倒す）。
 *
 * 【バグチェック High-2・2026-08-15修正】戻り値は必ず handoffFyiToSanada の成否だけに従う。
 * Slack警告は「本文が届いていないこと」を知らせるだけの副作用であり、その送信成功を
 * sendFyi自体の成功として返してしまうと、呼び出し元（notifyStuckOnce等）が「本文は届いて
 * いないのにSlack警告だけ届いた」状態を「送信成功」と誤認し、Notionへ「通知済み」マーカーを
 * 記帳してしまう（以後、本文が永久に再送されなくなる）。lib/notification.ts の
 * sendBatchNotifications と同じ方針に統一する。
 */
async function sendFyi(
  ticketId: string,
  text: string,
  opts?: { awaitsReply?: boolean }
): Promise<boolean> {
  const handed = await handoffFyiToSanada(ticketId, text, opts);
  if (!handed) {
    await notifySlackAlert(
      `真田チャネルへのFYI通知（${ticketId}）が送れませんでした。text: ${text.slice(0, 100)}`,
      "⚠️ FYI通知が真田チャネルへ送れませんでした"
    ).catch(() => false);
  }
  return handed;
}

/** 詰まり通知の de-dup 用の印（見出し文言）。 */
export const STUCK_MARKER_HEADING = "詰まり通知済み";

/** Merge待ち（レビュー到達）通知の de-dup 用の印。 */
export const REVIEW_MARKER_HEADING = "Merge待ち通知済み";

/**
 * チケットページに既に「詰まり通知済み」の印があるか。
 *
 * 【DB移行・2026-08-16 bug-check-lab High-1修正】印の書き込みは appendDiscussionBlocks
 * （Postgres ticket_discussion_blocks）に移ったが、この読み取りだけ Notion API を
 * 直接叩いたまま放置されていた（kz-sweep の hasReminderBlock と全く同じ欠陥）。
 * 新規チケット（合成pageId・Notionページ実体なし）では404→送らない側に倒れて
 * 「詰まりました」LINEが永久に届かず、移行済みチケットでは印がPostgres側にしか
 * 積まれないため毎回falseになり同じ通知が再送され続けていた。tickets.ts の
 * hasDiscussionHeading（Postgres版・同じfail-safe方針）へ一本化する。
 */
export async function hasStuckMarker(pageId: string): Promise<boolean> {
  return hasMarker(pageId, STUCK_MARKER_HEADING);
}

/** 指定した印（見出し文言）がページに既にあるか（de-dup の共通実装）。 */
export async function hasMarker(pageId: string, heading: string): Promise<boolean> {
  return hasDiscussionHeading(pageId, heading);
}

/** 詰まり連絡の本文（助けを求める形・素人語・短く）。 */
export function buildStuckText(ticket: TicketRow, reason: string): string {
  return [
    actionBanner("reply", "教えてほしいことがあります"),
    ``,
    msgHead("🆘", "ちょっと詰まりました", ticket.system, ticket.title),
    `（${ticket.ticketId}）これ、自動で直せず詰まりました。`,
    `必要なこと：${truncateForLine(reason || "詳しい状況を教えてください", 60)}`,
    ``,
    `これを教えてください。このメッセージを引用返信（長押し→返信）で答えてください。`,
    stageBar(4), // ④着手で詰まり
    `全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}

/**
 * 詰まり/困った連絡を「同じチケットで1回だけ」LINEへ送る。
 * - LINE未設定なら送らない（fail-safe）。
 * - 既に「詰まり通知済み」の印があれば送らない（連打防止）。
 * - 送ったら印（heading_3 + 理由）をページへ追記して次回以降の連打を止める。
 * 返り値：実際に送ったら true、送らなかった（未設定/既通知/失敗）なら false。
 */
export async function notifyStuckOnce(
  ticket: TicketRow,
  reason: string
): Promise<boolean> {
  // 【再修正・2026-08-15】詰まり連絡を再び真田システムへのhandoff（sendFyi→handoffFyiToSanada）
  // 経由に戻す。旧修正（bug-check-lab）は「詰まり連絡が社長へ"LINEで返信"を求めるが、真田専用
  // LINEチャネルのwebhookは受信テキストを案件照合なしで無条件にClaude Code Routineへ直行させる」
  // という誤爆を避けるため、詰まり連絡だけ自前LINE直送に倒していた。だが社長指示 2026-08-15
  // 「カイゼンくんのLINEチャネルに一切来ない仕組みにして」により自前LINE送信そのものを廃止した
  // ため、代わりに sendFyi 呼び出しへ awaitsReply:true を渡す。相手側（mention-hisho）はこの
  // フラグが立った通知だけLINE送信後のmessageIdを控え、社長がその通知を"引用返信"したときに
  // 限って `POST /api/kaizen/reply` へ書き戻す（自由文の通常返信は従来どおりRoutine起動に使う）。
  // これにより「自由文かどうか」ではなく「引用返信かどうか」で区別できるため、誤爆せずhandoff
  // 経由に統一できる。
  if (!lineEnabled() && !handoffEnabled()) return false;

  // 既に通知済みなら送らない（連打防止）。
  if (await hasStuckMarker(ticket.pageId)) return false;

  // 久原さん複製投稿（ベストエフォート・失敗しても本来のLINE/handoff通知には一切影響しない）。
  await notifyKuharaCopy("詰まり連絡", buildKuharaStuckText(ticket, reason)).catch(() => false);

  const sent = await sendFyi(ticket.ticketId, buildStuckText(ticket, reason), {
    awaitsReply: true,
  });
  if (!sent) return false;

  // 送れたときだけ印を残す（送信失敗なら印を残さず、次回再試行できるようにする）。
  await appendDiscussionBlocks(ticket.pageId, [
    {
      heading: STUCK_MARKER_HEADING,
      body: `詰まり連絡をLINEで1回送信しました。理由：${truncateForLine(reason || "不明", 100)}`,
    },
  ]).catch((e) => {
    console.error("[notify] 印の追記に失敗", (e as Error).message);
  });

  return true;
}

/** Merge待ち連絡の本文（社長のアクション＝Mergeボタン1タップを求める形・素人語）。 */
export function buildReviewText(ticket: TicketRow, prUrl: string, detail: string): string {
  return [
    actionBanner("tap", "Mergeボタンを1回タップ"),
    ``,
    msgHead("✋", "Merge待ちです", ticket.system, ticket.title),
    `（${ticket.ticketId}）直すコードはできました。自動反映の条件を満たさなかったため、`,
    `社長のMerge1タップで本番に反映されます。`,
    `理由：${truncateForLine(detail || "自動マージ条件を満たさず", 60)}`,
    ``,
    `PR ▶ ${prUrl}`,
    stageBar(5), // ⑤PRまで完了・反映待ち
    `全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}

/**
 * Merge待ち（レビュー到達）連絡を「同じチケットで1回だけ」LINEへ送る。
 * GO済み案件が自動マージできず止まったとき、無音で放置されるのを防ぐ
 * （社長指摘 2026-07-03「GOしても完了しない・止まっても連絡がない」対策）。
 * de-dup・fail-safe の方針は notifyStuckOnce と同じ。
 */
export async function notifyReviewOnce(
  ticket: TicketRow,
  prUrl: string,
  detail: string
): Promise<boolean> {
  if (!lineEnabled() && !handoffEnabled()) return false;
  if (await hasMarker(ticket.pageId, REVIEW_MARKER_HEADING)) return false;

  // 久原さん複製投稿（ベストエフォート・失敗しても本来のLINE/handoff通知には一切影響しない）。
  await notifyKuharaCopy(
    "Merge待ち",
    buildKuharaReviewText(ticket, prUrl, detail)
  ).catch(() => false);

  const sent = await sendFyi(ticket.ticketId, buildReviewText(ticket, prUrl, detail));
  if (!sent) return false;

  await appendDiscussionBlocks(ticket.pageId, [
    {
      heading: REVIEW_MARKER_HEADING,
      body: `Merge待ち連絡をLINEで1回送信しました。PR：${truncateForLine(prUrl, 100)}`,
    },
  ]).catch((e) => {
    console.error("[notify] 印の追記に失敗", (e as Error).message);
  });

  return true;
}

/** 完了連絡の本文（GO案件が本番反映まで完走したことを短く報告）。 */
export function buildMergedText(ticket: TicketRow, prUrl: string): string {
  return [
    actionBanner("fyi", "済みのご報告・操作は要りません"),
    ``,
    msgHead("✅", "直して反映しました", ticket.system, ticket.title),
    `（${ticket.ticketId}）自動改修→検証→本番反映まで完了しました。`,
    ``,
    ...(prUrl ? [`変更内容 ▶ ${prUrl}`] : []),
    stageBar(5), // ⑥反映まで完了
    `全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}
