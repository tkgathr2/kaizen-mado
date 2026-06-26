// ── POST /api/chat ── 会話1ターン処理（履歴→Claude→{reply,phase,ticket}）
import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, toAnthropicMessages } from "@/lib/prompt";
import { callClaude } from "@/lib/anthropic";
import { fallbackTurn } from "@/lib/fallback";
import { resolveSystem } from "@/lib/systems";
import { isRecallEnabled, recallSimilar, buildRecallNote } from "@/lib/recall";
import { checkRateLimit, clientKeyFromHeaders } from "@/lib/ratelimit";
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

  // ── 濫用・コスト保護（best-effort の第一防衛線）──
  // /api/chat は公開窓口で、1ターンごとに課金API（Anthropic）を呼ぶ。認証OFF時は完全公開のため、
  // スクリプトで叩かれるとコスト爆発・DoS になる。プロセス内メモリのスライディングウィンドウで
  // IP（無ければセッション/フォールバック）単位に控えめな上限を課す。例外時はブロックせず通す。
  try {
    const key = clientKeyFromHeaders(req.headers, "anon");
    const rl = checkRateLimit(`chat:${key}`);
    if (!rl.allowed) {
      // 会話は壊さない：reply にやさしい日本語を入れて 429 で返す。
      // error も併記して既存クライアントの !res.ok 分岐でも穏当に止まれるようにする。
      return NextResponse.json(
        {
          reply:
            "アクセスが集中しています。少し時間をおいて、もう一度お試しください。🙏",
          error: "アクセスが集中しています。少し時間をおいて、もう一度お試しください。🙏",
          phase: "clarify",
          rateLimited: true,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }
  } catch (err) {
    // レート制限の内部エラーで会話を止めない（degrade-safe）。
    console.error("[chat] rate-limit check failed (ignored):", (err as Error).message);
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

  // Phase 3（recall・既定OFF）：要約確認に進むタイミングで1回だけ類似ノウハウを参照し、
  // 見つかれば一言添える。タイムアウト1.5秒・失敗は無言スキップ（会話を止めない）。
  if (result.phase === "confirm" && result.ticket && isRecallEnabled()) {
    const hits = await recallSimilar(result.ticket);
    const note = buildRecallNote(hits);
    if (note) result = { ...result, reply: `${result.reply}\n\n${note}` };
  }

  return NextResponse.json({ ...result, fallback: usedFallback });
}
