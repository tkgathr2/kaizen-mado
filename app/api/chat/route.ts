// ── POST /api/chat ── 会話1ターン処理（履歴→Claude→{reply,phase,ticket}）
import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, toAnthropicMessages } from "@/lib/prompt";
import { callClaude } from "@/lib/anthropic";
import { fallbackTurn } from "@/lib/fallback";
import { resolveSystem } from "@/lib/systems";
import type { ChatMessage, TurnResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeHistory(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const m of input) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content : "";
    if (role && content) out.push({ role, content: content.slice(0, 4000) });
  }
  // 直近30ターンに制限（暴走・コスト対策）
  return out.slice(-30);
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const system = resolveSystem(body?.system);
  const history = sanitizeHistory(body?.messages);

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "messages must end with a user turn" },
      { status: 400 }
    );
  }

  // まず Claude を試し、失敗したらフォールバックへ。会話は決して止めない。
  let result: TurnResult;
  let usedFallback = false;
  try {
    const prompt = buildSystemPrompt(system);
    result = await callClaude(prompt, toAnthropicMessages(history));
  } catch (err) {
    console.error("[chat] Claude failed, using fallback:", (err as Error).message);
    result = fallbackTurn(system, history);
    usedFallback = true;
  }

  // confirm のとき system が空なら、リンク由来の system を補完
  if (result.phase === "confirm" && result.ticket && !result.ticket.system) {
    result.ticket.system = system ?? "その他";
  }

  return NextResponse.json({ ...result, fallback: usedFallback });
}
