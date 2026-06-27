// ── POST /api/submit ── confirm 済みの ticket を受けて Notion 起票
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { auth } from "@/auth";
import { createTicket } from "@/lib/notion";
import { memorizeToKnowhow } from "@/lib/knowhow";
import { normalizeSystemForTicket } from "@/lib/systems";
import { isAuthEnabled, isOriginAllowed } from "@/lib/authz";
import { kickEndpoint } from "@/lib/trigger";
import { acceptSubmit } from "@/lib/dedup";
import { findRecentDuplicate } from "@/lib/tickets";
import { clampScore, computePriority, isPriority } from "@/lib/priority";
import type { Ticket, TicketType, Importance, Priority } from "@/lib/types";

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

  // ── 優先度スコアリング（§4.5.1）。点数があればクランプ、優先度は欠落時に点数から導く。
  // 後方互換：点数が無い古いクライアントからの送信は undefined のまま通す。
  const urgency = clampScore(input.urgency);
  const importanceScore = clampScore(input.importanceScore);
  let priority: Priority | undefined = isPriority(input.priority) ? input.priority : undefined;
  if (!priority && urgency != null && importanceScore != null) {
    priority = computePriority(urgency, importanceScore);
  }
  const priorityReason =
    typeof input.priorityReason === "string" && input.priorityReason.trim()
      ? input.priorityReason.trim().slice(0, 200)
      : undefined;

  return {
    system: normalizeSystemForTicket(input.system),
    type,
    title: title || "改善のご要望",
    detail: detail || title,
    importance,
    ...(urgency != null ? { urgency } : {}),
    ...(importanceScore != null ? { importanceScore } : {}),
    ...(priority ? { priority } : {}),
    ...(priorityReason ? { priorityReason } : {}),
  };
}

export async function POST(req: NextRequest) {
  // CSRF/オリジン安全化：KAIZEN_ALLOWED_ORIGINS（カンマ区切り）が設定されている時だけ、
  // 許可オリジンからの送信のみ受理する。未設定なら従来どおり全許可（後方互換・窓口を止めない）。
  if (!isOriginAllowed(req.headers.get("origin"), process.env.KAIZEN_ALLOWED_ORIGINS)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

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

  // ── 二重起票ガード（二段構え） ──
  // 第1段：プロセス内メモリの高速フィルタ。連打の大半は同一インスタンスに連続到達するので
  //        ここで即弾く（Notion APIコールを節約）。利用者には完了表示を返す。
  if (!acceptSubmit(ticket, reporter)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // 第2段：インスタンス跨ぎの真の冪等化。serverless で連打が別インスタンスに分かれると
  //        第1段（メモリ）をすり抜ける。createTicket の直前に Notion を1回問い合わせ、
  //        直近N秒以内・完全同一内容の既存チケットがあれば新規作成せずそれを返す。
  //        ★fail-safe：照合失敗時は null が返り、通常どおり作成にフォールバック（声を止めない）。
  const dup = await findRecentDuplicate(ticket, reporter);
  if (dup) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      ticketId: dup.ticketId,
      pageId: dup.pageId,
    });
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
