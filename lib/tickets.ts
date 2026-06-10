// ── Notion 改善チケットDB の読取・更新（第2段=フィードバック改善ループの内部処理） ──
// 起票(lib/notion.ts)の延長。状態遷移・議論ブロック追記・冪等マークを担う。
// 誰にも送信しない（対人送信・課金・本番DB破壊は含めない）。
const NOTION_VERSION = "2022-06-28";

export interface TicketRow {
  pageId: string;
  ticketId: string;
  system: string;
  type: string;
  importance: string;
  title: string;
  detail: string;
  reporter: string;
  state: string;
  fgsUrl: string | null;
}

function getAuth(): { token: string; databaseId: string } {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) throw new Error("NOTION_DATABASE_ID is not set");
  return { token, databaseId };
}

function headers(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

// ── プロパティ抽出ヘルパ ──
function plainFromTitle(prop: any): string {
  const arr = prop?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((r: any) => r?.plain_text ?? "").join("");
}
function plainFromRichText(prop: any): string {
  const arr = prop?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((r: any) => r?.plain_text ?? "").join("");
}
function nameFromSelect(prop: any): string {
  return prop?.select?.name ?? "";
}
function idFromUniqueId(prop: any): string {
  const u = prop?.unique_id;
  if (!u) return "";
  const prefix = u.prefix || "KZ";
  if (u.number == null) return "";
  return `${prefix}-${u.number}`;
}
function valueFromUrl(prop: any): string | null {
  const v = prop?.url;
  return typeof v === "string" && v ? v : null;
}

function parseRow(page: any): TicketRow {
  const props = page?.properties ?? {};
  return {
    pageId: String(page?.id ?? ""),
    ticketId: idFromUniqueId(props["ID"]) || idFromUniqueId(findUniqueId(props)),
    system: nameFromSelect(props["対象システム"]),
    type: nameFromSelect(props["種別"]),
    importance: nameFromSelect(props["重要度"]),
    title: plainFromTitle(props["チケット名"]),
    detail: plainFromRichText(props["内容"]),
    reporter: plainFromRichText(props["起票者"]),
    state: nameFromSelect(props["状態"]),
    fgsUrl: valueFromUrl(props["FGSリンク"]),
  };
}

/** プロパティ名が不定の unique_id を拾う（最初の1つ） */
function findUniqueId(props: any): any {
  for (const key of Object.keys(props || {})) {
    if (props[key]?.type === "unique_id") return props[key];
  }
  return null;
}

async function queryDatabase(filter: any, limit: number): Promise<TicketRow[]> {
  const { token, databaseId } = getAuth();
  const res = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ filter, page_size: limit }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion query error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(parseRow);
}

/** 指定状態のチケットを取得 */
export async function fetchTicketsByState(
  state: string,
  limit = 5
): Promise<TicketRow[]> {
  return queryDatabase(
    { property: "状態", select: { equals: state } },
    limit
  );
}

/** pageIdで1件取得（webhookでGO時に現在状態を確認＝冪等化のため）。無ければnull。 */
export async function fetchTicketByPageId(pageId: string): Promise<TicketRow | null> {
  const { token } = getAuth();
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: headers(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion get error ${res.status}: ${t.slice(0, 300)}`);
  }
  const page = await res.json();
  return parseRow(page);
}

/** ticketId（例 KZ-12）でGO待ちチケットを探す（テキスト返信「GO KZ-12」用）。 */
export async function findGoMachiByTicketId(ticketId: string): Promise<TicketRow | null> {
  const rows = await fetchTicketsByState("GO待ち", 25);
  const norm = ticketId.toUpperCase().replace(/\s/g, "");
  return rows.find((r) => r.ticketId.toUpperCase().replace(/\s/g, "") === norm) ?? null;
}

/** 完了済みかつ未学習（FGSリンク空）のチケットを取得 */
export async function fetchCompletedUnlearned(limit = 10): Promise<TicketRow[]> {
  return queryDatabase(
    {
      and: [
        { property: "状態", select: { equals: "完了" } },
        { property: "FGSリンク", url: { is_empty: true } },
      ],
    },
    limit
  );
}

async function patchPage(pageId: string, properties: any): Promise<void> {
  const { token } = getAuth();
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion update error ${res.status}: ${t.slice(0, 300)}`);
  }
}

/** 状態(select)を更新 */
export async function updateTicketState(
  pageId: string,
  state: string
): Promise<void> {
  await patchPage(pageId, { 状態: { select: { name: state } } });
}

/** FGSリンク(url)を設定（学び還元の冪等マーク用） */
export async function setTicketUrlField(
  pageId: string,
  url: string
): Promise<void> {
  await patchPage(pageId, { FGSリンク: { url } });
}

/** 担当(rich_text)を設定 */
export async function setTicketAssignee(
  pageId: string,
  who: string
): Promise<void> {
  await patchPage(pageId, {
    担当: { rich_text: [{ type: "text", text: { content: who.slice(0, 1900) } }] },
  });
}

/** 議論内容を heading_3 + paragraph ブロックとしてページ末尾に追記 */
export async function appendDiscussionBlocks(
  pageId: string,
  lines: { heading?: string; body?: string }[]
): Promise<void> {
  const { token } = getAuth();
  const children: any[] = [];
  for (const line of lines) {
    if (line.heading) {
      children.push({
        object: "block",
        type: "heading_3",
        heading_3: {
          rich_text: [
            { type: "text", text: { content: line.heading.slice(0, 1900) } },
          ],
        },
      });
    }
    if (line.body) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { type: "text", text: { content: line.body.slice(0, 1900) } },
          ],
        },
      });
    }
  }
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children`,
    {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ children }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion append error ${res.status}: ${t.slice(0, 300)}`);
  }
}
