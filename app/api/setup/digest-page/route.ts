/**
 * ── POST /api/setup/digest-page ──
 * 初回セットアップ：カイゼンダイジェスト用の Notion ページを作成し、
 * PAGE_ID を返す（Vercel 環境変数 KAIZEN_DIGEST_PAGE_ID に手動設定用）。
 *
 * セキュリティ：SETUP_TOKEN 認証で保護（1回きりのセットアップ用）。
 * 既に PAGE_ID が有効なら abort（冪等性）。
 */
import { NextRequest, NextResponse } from "next/server";

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";

async function createDigestPage(): Promise<{ pageId: string; pageUrl: string }> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    throw new Error("NOTION_TOKEN or NOTION_DATABASE_ID not set");
  }

  const body = {
    parent: {
      database_id: dbId,
    },
    properties: {
      チケット名: {
        title: [
          {
            type: "text" as const,
            text: { content: "KAIZEN_DIGEST_PAGE" },
          },
        ],
      },
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
    const err = await res.text().catch(() => "");
    throw new Error(`Notion API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const pageId = String(data?.id || "").replace(/-/g, "");
  const pageUrl = String(data?.url || "");

  if (!pageId) {
    throw new Error("Response missing page ID");
  }

  return { pageId, pageUrl };
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/, "") || "";
  const expected = process.env.SETUP_TOKEN;

  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 既に設定済みなら abort（冪等性）
  const existing = process.env.KAIZEN_DIGEST_PAGE_ID;
  if (existing && existing !== "pending") {
    return NextResponse.json(
      { message: "already configured", pageId: existing },
      { status: 200 }
    );
  }

  try {
    const { pageId, pageUrl } = await createDigestPage();
    return NextResponse.json(
      {
        ok: true,
        pageId,
        pageUrl,
        instruction: `Set KAIZEN_DIGEST_PAGE_ID=${pageId} in Vercel environment`,
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("[setup] digest page creation failed", (e as Error).message);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
