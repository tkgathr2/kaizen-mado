// カイゼンくんチケットDB移行：Notion側の読み取りロジック（app/api/admin/migrate-tickets と
// 一時検証エンドポイントの両方から使う共通部分）。
const NOTION_VERSION = "2022-06-28";

function notionHeaders(token: string) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function plainFromTitle(prop: any): string {
  const arr = prop?.title;
  return Array.isArray(arr) ? arr.map((r: any) => r?.plain_text ?? "").join("") : "";
}
function plainFromRichText(prop: any): string {
  const arr = prop?.rich_text;
  return Array.isArray(arr) ? arr.map((r: any) => r?.plain_text ?? "").join("") : "";
}
function nameFromSelect(prop: any): string {
  return prop?.select?.name ?? "";
}
function numberFromProp(prop: any): number | null {
  const n = prop?.number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function urlFromProp(prop: any): string | null {
  const v = prop?.url;
  return typeof v === "string" && v ? v : null;
}
function dateFromProp(prop: any): string | null {
  const d = prop?.date?.start;
  return typeof d === "string" && d ? d : null;
}
function findUniqueId(props: any): any {
  for (const key of Object.keys(props || {})) {
    if (props[key]?.type === "unique_id") return props[key];
  }
  return null;
}
function ticketNumberFromProps(props: any): number | null {
  const u = props["ID"]?.type === "unique_id" ? props["ID"] : findUniqueId(props);
  const n = u?.number;
  return typeof n === "number" ? n : null;
}

export interface ParsedTicket {
  notionPageId: string;
  ticketNumber: number | null;
  system: string;
  type: string;
  importance: string;
  title: string;
  detail: string;
  reporter: string;
  state: string;
  assignee: string;
  fgsUrl: string | null;
  prUrl: string | null;
  urgency: number | null;
  importanceScore: number | null;
  priority: string | null;
  priorityReason: string | null;
  statusChangedAt: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  createdTime: string | null;
  lastEdited: string | null;
}

export function parseNotionPage(page: any): ParsedTicket {
  const props = page?.properties ?? {};
  return {
    notionPageId: String(page?.id ?? ""),
    ticketNumber: ticketNumberFromProps(props),
    system: nameFromSelect(props["対象システム"]),
    type: nameFromSelect(props["種別"]),
    importance: nameFromSelect(props["重要度"]),
    title: plainFromTitle(props["チケット名"]),
    detail: plainFromRichText(props["内容"]),
    reporter: plainFromRichText(props["起票者"]),
    state: nameFromSelect(props["状態"]),
    assignee: plainFromRichText(props["担当"]),
    fgsUrl: urlFromProp(props["FGSリンク"]),
    prUrl: urlFromProp(props["PR URL"]),
    urgency: numberFromProp(props["緊急度"]),
    importanceScore: numberFromProp(props["重要度スコア"]),
    priority: nameFromSelect(props["優先度"]) || null,
    priorityReason: plainFromRichText(props["優先度根拠"]) || null,
    statusChangedAt: dateFromProp(props["状態変更日時"]),
    slackChannelId: plainFromRichText(props["Slack Channel ID"]) || null,
    slackThreadTs: plainFromRichText(props["Slack Thread TS"]) || null,
    slackUserId: plainFromRichText(props["Slack User ID"]) || null,
    createdTime: typeof page?.created_time === "string" ? page.created_time : null,
    lastEdited: typeof page?.last_edited_time === "string" ? page.last_edited_time : null,
  };
}

export async function fetchAllNotionTickets(token: string, databaseId: string): Promise<ParsedTicket[]> {
  const rows: ParsedTicket[] = [];
  let cursor: string | undefined;
  do {
    const payload: any = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Notion query error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const page of results) rows.push(parseNotionPage(page));
    cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

export interface BlockEntry {
  heading: string | null;
  body: string | null;
  createdTime: string | null;
}

export async function fetchDiscussionBlocks(token: string, notionPageId: string): Promise<BlockEntry[]> {
  const entries: BlockEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${notionPageId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const res = await fetch(url.toString(), { method: "GET", headers: notionHeaders(token) });
    if (!res.ok) return entries;
    const data = await res.json();
    const blocks = Array.isArray(data?.results) ? data.results : [];
    for (const b of blocks) {
      if (b?.type === "heading_3") {
        const text = (b.heading_3?.rich_text || []).map((r: any) => r?.plain_text ?? "").join("");
        entries.push({ heading: text || null, body: null, createdTime: b.created_time || null });
      } else if (b?.type === "paragraph") {
        const text = (b.paragraph?.rich_text || []).map((r: any) => r?.plain_text ?? "").join("");
        entries.push({ heading: null, body: text || null, createdTime: b.created_time || null });
      }
    }
    cursor = data?.has_more && data?.next_cursor ? data.next_cursor : undefined;
  } while (cursor && ++pages < 10);
  return entries;
}
