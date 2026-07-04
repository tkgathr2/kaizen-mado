/**
 * カイゼン改善 Notion DB 操作
 * - Notion チケットの `lineChat` フィールド（rich_text）に LINE 往復を追記
 * - チケット特定 → 会話履歴抽出
 */

import type { TicketRow } from "./tickets";

const NOTION_VERSION = "2022-06-28";

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

/**
 * チケットの `lineChat` フィールドに LINE 往復を追記。
 * @param pageId チケット Notion ページ ID
 * @param chatLine 追記する 1 行（「HH:MM ユーザー: メッセージ」形式）
 */
export async function appendLineChat(pageId: string, chatLine: string): Promise<boolean> {
  const { token } = getAuth();
  if (!pageId || !chatLine) return false;

  try {
    // ページの現在の lineChat を取得
    const pageResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "GET",
      headers: headers(token),
    });

    if (!pageResp.ok) {
      console.error(`Failed to fetch page: ${pageResp.statusText}`);
      return false;
    }

    const page = (await pageResp.json()) as any;
    const existingChat = page?.properties?.lineChat?.rich_text || [];
    const existingText = existingChat.map((rt: any) => rt?.plain_text || "").join("");

    // 新規テキスト = 既存 + 改行 + 新規行
    const newText = existingText ? `${existingText}\n${chatLine}` : chatLine;

    // 新規 lineChat を設定
    const updateResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({
        properties: {
          lineChat: {
            rich_text: [
              {
                type: "text",
                text: { content: newText },
              },
            ],
          },
        },
      }),
    });

    if (!updateResp.ok) {
      console.error(`Failed to update lineChat: ${updateResp.statusText}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("appendLineChat error:", error);
    return false;
  }
}

/**
 * チケットから lineChat フィールドの内容を取得。
 * @param pageId チケット Notion ページ ID
 * @returns 改行区切りの会話ログ（複数行テキスト）
 */
export async function getLineChat(pageId: string): Promise<string> {
  const { token } = getAuth();
  if (!pageId) return "";

  try {
    const pageResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "GET",
      headers: headers(token),
    });

    if (!pageResp.ok) {
      console.error(`Failed to fetch page: ${pageResp.statusText}`);
      return "";
    }

    const page = (await pageResp.json()) as any;
    const lineChat = page?.properties?.lineChat?.rich_text || [];
    return lineChat.map((rt: any) => rt?.plain_text || "").join("");
  } catch (error) {
    console.error("getLineChat error:", error);
    return "";
  }
}

/**
 * Notion チケット DB にチケット作成時に lineChat フィールドを初期化（空テキスト）。
 * 既存コード（lib/notion.ts の createTicket）で使用。
 * ここは新規チケット作成時は不要（デフォルト空）だが、既存チケット互換のため用意。
 */
export async function ensureLineChatField(pageId: string): Promise<boolean> {
  const { token } = getAuth();
  if (!pageId) return false;

  try {
    const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({
        properties: {
          lineChat: {
            rich_text: [
              {
                type: "text",
                text: { content: "" },
              },
            ],
          },
        },
      }),
    });
    return resp.ok;
  } catch (error) {
    console.error("ensureLineChatField error:", error);
    return false;
  }
}
