// ── POST /api/chat ── 会話1ターン処理（履歴→Claude→{reply,phase,ticket}）
import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, toAnthropicMessages } from "@/lib/prompt";
import { callClaude, callClaudeWithSlack, chunkReply } from "@/lib/anthropic";
import { slackAvailableForSystem } from "@/lib/slack";
import { fallbackTurn } from "@/lib/fallback";
import { resolveSystem } from "@/lib/systems";
import { isRecallEnabled, recallSimilar, buildRecallNote } from "@/lib/recall";
import { checkRateLimit, clientKeyFromHeaders } from "@/lib/ratelimit";
import { sanitizeHistory } from "@/lib/history";
import type { TurnResult } from "@/lib/types";

// 画像をモデルへ渡すか（既定OFF＝従来テキスト挙動・回帰ゼロ）。
// "true" のときだけ各 user ターンの画像 attachments を検証して通す。
function visionEnabled(): boolean {
  return process.env.KAIZEN_VISION_ENABLED === "true";
}

// ファイル（PDF/テキスト/xlsx/docx）をモデルへ渡すか（既定OFF＝回帰ゼロ）。
function filesEnabled(): boolean {
  return process.env.KAIZEN_FILES_ENABLED === "true";
}

// SSE ストリーミングを有効にするか（既定OFF＝従来の一括 JSON 応答）。
function streamEnabled(): boolean {
  return process.env.KAIZEN_STREAM_ENABLED === "true";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 巨大ペイロードの JSON パース前に Content-Length ヘッダで弾く（DoS 対策）。
// base64 画像/ファイル（合計~20MB）＋テキスト30ターン分でも収まる想定。
// ファイル添付経路では合計20MBまで許すため、ヘッダ上限は 25MB に拡張（超は 413）。
// ヘッダが無い場合（chunked 転送など）はスキップし、後段のサイズ検証に委ねる。
const CONTENT_LENGTH_LIMIT = 25 * 1024 * 1024; // 25MB

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
  const history = sanitizeHistory(body?.messages, {
    withVision: visionEnabled(),
    withFiles: filesEnabled(),
  });

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "messages must end with a user turn" },
      { status: 400 }
    );
  }

  // ── ④ ストリーミング判定（フラグON かつ クライアントが要求したとき） ──
  // 要求＝body.stream===true もしくは Accept: text/event-stream。
  const wantsStream =
    body?.stream === true || (req.headers.get("accept") || "").includes("text/event-stream");

  if (wantsStream && streamEnabled()) {
    return streamResponse(system, history);
  }

  const { result, usedFallback } = await runTurn(system, history);
  return NextResponse.json({ ...result, fallback: usedFallback });
}

/**
 * 1ターンを処理して TurnResult を得る共通ロジック（非ストリーム／ストリーム両用）。
 * Claude 失敗時はフォールバックへ。会話は決して止めない。
 */
async function runTurn(
  system: string | null,
  history: ReturnType<typeof sanitizeHistory>
): Promise<{ result: TurnResult; usedFallback: boolean }> {
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

  return { result, usedFallback };
}

/**
 * SSE（text/event-stream）で返す。record_turn の構造化出力を壊さないため、
 * まず通常どおり確定結果を得てから reply を分割して delta を逐次送り、最後に done を送る
 * （契約 §6：難しければ「確定後に分割送出＋本物の typing は B 側」で可・安全側）。
 *   event: delta  data: {"text": "<差分>"}
 *   event: done   data: {"phase","ticket","reply","fallback"}
 *   event: error  data: {"message"}
 */
function streamResponse(
  system: string | null,
  history: ReturnType<typeof sanitizeHistory>
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      try {
        const { result, usedFallback } = await runTurn(system, history);
        for (const piece of chunkReply(result.reply)) {
          send("delta", { text: piece });
        }
        send("done", {
          phase: result.phase,
          ticket: result.ticket,
          reply: result.reply,
          fallback: usedFallback,
        });
      } catch (err) {
        send("error", { message: (err as Error).message || "stream failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
