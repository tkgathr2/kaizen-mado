// ── 自分から送るLINE通知の絞り込み（社長承認の新仕様） ──
// カイゼンくんが"自分から"送るLINEは、即時2種だけに絞る：
//   1) GO伺い（社長が決める案件）… process/route.ts の pushProposal / execute/route.ts の
//      「🛑社長に相談です（社長案件）」がこれ（＝判断要求）。本モジュールでは扱わない。
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
// ★ fail-safe：LINE未設定なら送らない。読取/送信/追記で例外が出ても握りつぶす
//   （カイゼンくんの改善ループを通知の失敗で止めない）。
import type { TicketRow } from "./tickets";
import { appendDiscussionBlocks } from "./tickets";
import { lineEnabled, pushText, truncateForLine, BOARD_URL, msgHead, stageBar } from "./line";

const NOTION_VERSION = "2022-06-28";

/** 詰まり通知の de-dup 用の印（heading_3 の見出し文言）。 */
export const STUCK_MARKER_HEADING = "詰まり通知済み";

/** Merge待ち（レビュー到達）通知の de-dup 用の印。 */
export const REVIEW_MARKER_HEADING = "Merge待ち通知済み";

/** Notion auth（tickets.ts と同じ env を読む）。未設定なら null（fail-safe）。 */
function notionToken(): string | null {
  return process.env.NOTION_TOKEN || null;
}

/**
 * チケットページに既に「詰まり通知済み」の印（heading_3）があるか。
 * ページ直下の子ブロックを最大100件まで見て heading_3 の本文に印文言を含むものを探す。
 * 取得に失敗したら「印は無い」とみなす…のではなく、二重通知を避けるため "true（送らない側）"
 * に倒す（連打防止を優先）。LINE自体は fail-safe で副作用が小さいため、安全側＝送らない。
 */
export async function hasStuckMarker(pageId: string): Promise<boolean> {
  return hasMarker(pageId, STUCK_MARKER_HEADING);
}

/**
 * 指定した印（heading_3 の見出し文言）がページに既にあるか（de-dup の共通実装）。
 * 取得失敗・例外は「ある（＝送らない側）」に倒して連打を防ぐ。
 */
export async function hasMarker(pageId: string, heading: string): Promise<boolean> {
  const token = notionToken();
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
    if (!res.ok) {
      console.error("[notify] 印の確認に失敗（送信を見送り）", res.status);
      return true; // 確認できないときは連打を避けて送らない側に倒す
    }
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
  } catch (e) {
    console.error("[notify] 印の確認で例外（送信を見送り）", (e as Error).message);
    return true; // 例外時も連打を避けて送らない側に倒す
  }
}

/** 詰まり連絡の本文（助けを求める形・素人語・短く）。 */
export function buildStuckText(ticket: TicketRow, reason: string): string {
  return [
    msgHead("🆘", "ちょっと詰まりました", ticket.system, ticket.title),
    `（${ticket.ticketId}）これ、自動で直せず詰まりました。`,
    `必要なこと：${truncateForLine(reason || "詳しい状況を教えてください", 60)}`,
    ``,
    `これを教えてください。LINEで返信すれば続けます。`,
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
  // LINE未設定なら何もしない（印も残さない＝設定後に1回送れるように）。
  if (!lineEnabled()) return false;

  // 既に通知済みなら送らない（連打防止）。
  if (await hasStuckMarker(ticket.pageId)) return false;

  const sent = await pushText(buildStuckText(ticket, reason));
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
  if (!lineEnabled()) return false;
  if (await hasMarker(ticket.pageId, REVIEW_MARKER_HEADING)) return false;

  const sent = await pushText(buildReviewText(ticket, prUrl, detail));
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
    msgHead("✅", "直して反映しました", ticket.system, ticket.title),
    `（${ticket.ticketId}）自動改修→検証→本番反映まで完了しました。`,
    ``,
    ...(prUrl ? [`変更内容 ▶ ${prUrl}`] : []),
    stageBar(5), // ⑥反映まで完了
    `全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}
