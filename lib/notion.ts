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

  const body = {
    parent: { database_id: databaseId },
    properties: {
      チケット名: { title: richText(title) },
      対象システム: { select: { name: system } },
      種別: { select: { name: ticket.type } },
      重要度: { select: { name: ticket.importance } },
      状態: { select: { name: "受付" } },
      起票元: { select: { name: "フォーム" } },
      内容: { rich_text: richText(ticket.detail) },
      起票者: { rich_text: richText(reporter?.trim() || "現場フォーム") },
    },
  };

  const res = await fetch(NOTION_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Notion API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  return {
    ticketId: formatTicketId(data),
    pageUrl: data?.url ?? "",
    pageId: data?.id ?? "",
  };
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
