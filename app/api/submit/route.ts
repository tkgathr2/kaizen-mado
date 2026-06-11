// ── POST /api/submit ── confirm 済みの ticket を受けて Notion 起票
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { auth } from "@/auth";
import { createTicket } from "@/lib/notion";
import { memorizeToKnowhow } from "@/lib/knowhow";
import { normalizeSystemForTicket } from "@/lib/systems";
import { isAuthEnabled } from "@/lib/authz";
import { kickEndpoint } from "@/lib/trigger";
import type { Ticket, TicketType, Importance } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coerceTicket(input: any): Ticket | null {
  if (!input || typeof input !== "object") return null;
  const type: TicketType =
    input.type === "bug" || input.type === "新機能" ? input.type : "改善";
  const importance: Importance =
    input.importance === "高" || input.importance === "低" ? input.importance : "中";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (!detail && !title) return null;
  return {
    system: normalizeSystemForTicket(input.system),
    type,
    title: title || "改善のご要望",
    detail: detail || title,
    importance,
  };
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const ticket = coerceTicket(body?.ticket);
  if (!ticket) {
    return NextResponse.json({ error: "ticket is required" }, { status: 400 });
  }
  // 起票者はサーバ側でセッションから確定（クライアント入力より優先・なりすまし防止）。
  // fail-safe：鍵未投入（認証OFF）時は auth() を呼ばず従来どおり body.reporter or null。
  // これにより鍵が無い間も起票は確実に動く（auth() の例外で窓口を壊さない）。
  let reporter = typeof body?.reporter === "string" ? body.reporter : null;
  if (isAuthEnabled()) {
    const session = await auth();
    reporter = session?.user?.name || session?.user?.email || reporter;
  }

  try {
    const result = await createTicket(ticket, reporter);
    // デュアルライト：声を knowhow にも貯める（従・失敗してもユーザーには成功を返す）
    const memorized = await memorizeToKnowhow(ticket, result.ticketId);
    // イベント駆動：起票直後に /api/process を起こし、議論→GO待ち→LINE提案まで即進める。
    // 応答はブロックしない（after で後処理）。鍵未投入なら kickEndpoint は no-op。
    waitUntil(kickEndpoint("/api/process"));
    return NextResponse.json({ ok: true, ...result, memorized });
  } catch (err) {
    console.error("[submit] Notion create failed:", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: "起票に失敗しました。時間をおいて再度お試しください。" },
      { status: 502 }
    );
  }
}
