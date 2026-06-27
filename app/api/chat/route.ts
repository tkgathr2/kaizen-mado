// ── POST /api/chat ── 会話1ターン処理（履歴→Claude→{reply,phase,ticket}）
import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, toAnthropicMessages } from "@/lib/prompt";
import { callClaude, callClaudeWithSlack } from "@/lib/anthropic";
import { slackAvailableForSystem } from "@/lib/slack";
import { fallbackTurn } from "@/lib/fallback";
import { resolveSystem } from "@/lib/systems";
import { isRecallEnabled, recallSimilar, buildRecallNote } from "@/lib/recall";
import { checkRateLimit, clientKeyFromHeaders } from "@/lib/ratelimit";
import { sanitizeHistory } from "@/lib/history";
import type { TurnResult } from "@/lib/types";

// 画像をモデルへ渡すか（既定OFF＝従来テキスト挙動・回帰ゼロ）。
// "true" のときだけ各 user ターンの attachments を検証して通す。
function visionEnabled(): boolean {
  return process.env.KAIZEN_VISION_ENABLED === "true";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 巨大ペイロードの JSON パース前に Content-Length ヘッダで弾く（DoS 対策）。
// base64 画像3枚（各5MB）＋テキスト30ターン分でも ~20MB 以内に収まる想定で上限を設ける。
// ヘッダが無い場合（chunked 転送など）はスキップし、後段のサイズ検証に委ねる。
const CONTENT_LENGTH_LIMIT = 20 * 1024 * 1024; // 20MB

export async function POST(req: NextRequest) {
  // ── ① Content-Length による早期 413（JSON パース前）──
  const clHeader = req.headers.get("content-length");
  if (clHeader !== null) {
    const cl = parseInt(clHeader, 10);
    if (!isNaN(cl) && cl > CONTENT_LENGTH_LIMIT) {
      return NextResponse.json(
        { error: "payload too large" },
        { status: 413 }
      );
    }
  }

  // ── ② レート制限（base64 の regex 走査前に効かせる）──
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

  // ── ③ JSON パース（レート制限後） ──
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const system = resolveSystem(body?.system);
  const history = sanitizeHistory(body?.messages, visionEnabled());

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "messages must end with a user turn" },
      { status: 400 }
    );
  }

  // まず Claude を試し、失敗したらフォールバックへ。会話は決して止めない。
  // Slack調査が使える窓口（トークン＋許可チャンネルあり）だけ read_slack 付きの経路にする。
  const useSlack = slackAvailableForSystem(system);
  let result: TurnResult;
  let usedFallback = false;
  try {
    const prompt = buildSystemPrompt(system, { slack: useSlack });
    result = useSlack
      ? await callClaudeWithSlack(prompt, toAnthropicMessages(history), system)
      : await callClaude(prompt, toAnthropicMessages(history));
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
