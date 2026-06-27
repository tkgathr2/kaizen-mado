// ── Notion 改善チケットDB への起票（サーバ側のみ） ──
import type { Ticket } from "./types";
import { normalizeSystemForTicket } from "./systems";

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";

export interface SubmitResult {
  ticketId: string; // 例: "KZ-12"
  pageUrl: string;
  pageId: string;
}

function richText(content: string) {
  // Notionのrich_textは2000字/ブロック上限。安全側で切る。
  return [{ type: "text", text: { content: content.slice(0, 1900) } }];
}

/**
 * 改善チケットDBに「状態=受付」で1件起票する。
 * @param ticket 会話から確定したチケット
 * @param reporter 起票者（任意。フォーム入力 or "現場フォーム"）
 */
export async function createTicket(
  ticket: Ticket,
  reporter: string | null
): Promise<SubmitResult> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");

  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) throw new Error("NOTION_DATABASE_ID is not set");

  const system = normalizeSystemForTicket(ticket.system);
  const title = (ticket.title || "改善のご要望").slice(0, 100);

  // 必須プロパティ（既存DBに必ずある想定）。
  const baseProps: Record<string, any> = {
    チケット名: { title: richText(title) },
    対象システム: { select: { name: system } },
    種別: { select: { name: ticket.type } },
    重要度: { select: { name: ticket.importance } },
    状態: { select: { name: "受付" } },
    起票元: { select: { name: "フォーム" } },
    内容: { rich_text: richText(ticket.detail) },
    起票者: { rich_text: richText(reporter?.trim() || "現場フォーム") },
  };

  // ── 優先度スコアリング（§4.5.1）。best-effort で書く。
  // Notion DB に該当プロパティが無くても起票が落ちないよう、別オブジェクトに分け、
  // 付きで失敗したら base のみで再試行する（fail-safe・声を取りこぼさない）。
  const scoringProps = buildScoringProps(ticket);

  const data = await createPage(token, databaseId, baseProps, scoringProps);
  return {
    ticketId: formatTicketId(data),
    pageUrl: data?.url ?? "",
    pageId: data?.id ?? "",
  };
}

/** 優先度スコアリングの Notion プロパティ（点数=number／優先度=select／根拠=rich_text）。
 * 値が無ければ空オブジェクト（旧チケット互換）。 */
function buildScoringProps(ticket: Ticket): Record<string, any> {
  const props: Record<string, any> = {};
  if (typeof ticket.urgency === "number") props["緊急度"] = { number: ticket.urgency };
  if (typeof ticket.importanceScore === "number")
    props["重要度スコア"] = { number: ticket.importanceScore };
  if (ticket.priority) props["優先度"] = { select: { name: ticket.priority } };
  if (ticket.priorityReason) props["優先度根拠"] = { rich_text: richText(ticket.priorityReason) };
  return props;
}

/** Notion ページ作成。スコアリングの追加プロパティ付きで失敗し、かつ追加分があった場合は
 * base のみ（追加分を落として）1回だけ再試行する（プロパティ未定義DBでも起票を通す・fail-safe）。 */
async function createPage(
  token: string,
  databaseId: string,
  baseProps: Record<string, any>,
  scoringProps: Record<string, any>
): Promise<any> {
  const hasScoring = Object.keys(scoringProps).length > 0;
  const res = await postPage(token, databaseId, { ...baseProps, ...scoringProps });
  if (res.ok) return res.json();

  const errText = await res.text().catch(() => "");
  // 追加プロパティを送って失敗したときだけ、base のみで1回再試行（DBに新プロパティが無い等）。
  if (hasScoring) {
    console.error(
      "[notion] create with scoring props failed, retrying without them:",
      `${res.status} ${errText.slice(0, 200)}`
    );
    const retry = await postPage(token, databaseId, baseProps);
    if (retry.ok) return retry.json();
    const retryErr = await retry.text().catch(() => "");
    throw new Error(`Notion API error ${retry.status}: ${retryErr.slice(0, 400)}`);
  }
  throw new Error(`Notion API error ${res.status}: ${errText.slice(0, 400)}`);
}

async function postPage(
  token: string,
  databaseId: string,
  properties: Record<string, any>
): Promise<Response> {
  return fetch(NOTION_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });
}

/** auto_increment_id（unique_id）プロパティから "KZ-12" を組み立てる */
function formatTicketId(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "unique_id" && p.unique_id) {
      const prefix = p.unique_id.prefix || "KZ";
      const num = p.unique_id.number;
      if (num != null) return `${prefix}-${num}`;
    }
  }
  // unique_id が取れない場合はページIDの短縮で代替表示
  const short = String(page?.id ?? "").replace(/-/g, "").slice(0, 6).toUpperCase();
  return short ? `KZ-${short}` : "KZ-受付";
}
