// ── POST /api/line/webhook ── LINEからのGO/修正/却下を検知してチケットを進める ──
// 1) x-line-signature を channel secret で検証（不一致は401）
// 2) 送信元userIdが高木さん本人か検証（他人・誤爆を弾く）
// 3) postback（ボタン）or text（「GO KZ-12」）を解析 → 該当チケットへ applyGoAction
// LINEには常に200を返す（個別イベントの失敗でwebhook全体は失敗にしない＝再送ループ防止）。
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  verifyLineSignature,
  parsePostback,
  verifyProposalToken,
  parseTextCommand,
  isAuthorizedUser,
  replyText,
  getQuotedMap,
} from "@/lib/line";
import {
  fetchTicketByPageId,
  findGoMachiByTicketId,
  fetchTicketsByState,
  fetchAllTickets,
} from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";
import { kickEndpoint } from "@/lib/trigger";
import {
  classifyIntent,
  resolveTicket,
  requestToTicket,
  summarizeStatus,
  generateReply,
  converseEnabled,
  guessSystem,
  recallForReply,
  formatLearningContext,
  recordConversationTurn,
  recordDecisionTurn,
  type ResolveContext,
  type ConverseTurn,
} from "@/lib/converse";
import { enqueueNotification } from "@/lib/notification";
import { createTicket } from "@/lib/notion";
import { findRecentDuplicate } from "@/lib/tickets";
import { appendLineChat } from "@/lib/kaizen-notion";

// GO適用の結果が「着手」になったら、即 /api/execute を起こして実改修へ進める（応答はブロックしない）。
function kickIfStarted(newState?: string) {
  if (newState === "着手") waitUntil(kickEndpoint("/api/execute"));
}

// 全体学習への記録は「非ブロッキング・fail-safe」。社長への返信を絶対に遅らせない/壊さない。
// 記録の Promise は await せず void で投げ、例外も握る（記録失敗で会話は止めない）。
// Vercel上では waitUntil で関数終了後も記録の完了を待たせる（記録の取りこぼし防止）。
function recordInBackground(p: Promise<unknown>): void {
  const safe = Promise.resolve(p).catch(() => {});
  try {
    waitUntil(safe);
  } catch {
    // waitUntil が使えない環境（テスト等）でも記録自体は走る。例外は握る。
    void safe;
  }
}

// ── 短期会話履歴（インメモリ・best-effort）──
// 同インスタンスへのリクエストが続く間だけ有効。Vercel serverless では別インスタンスに当たると
// 履歴はリセットされるが、その場合でも会話は成立する（履歴無しで返す）。
// QUOTED_MAP_MAX 同様、古いものから捨てる単純なリングバッファ構造。
const CONV_HISTORY_MAX_TURNS = 10;
const convHistory: ConverseTurn[] = [];

/** 会話ターンを短期履歴に追記する（古いものから捨てる）。 */
function appendConvHistory(userText: string, assistantText: string): void {
  convHistory.push({ userText, assistantText });
  while (convHistory.length > CONV_HISTORY_MAX_TURNS) {
    convHistory.shift();
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LINE Developers コンソールの「検証」ボタンは GET を送る。200 を返さないと URL が「無効」扱いになる。
export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("x-line-signature");
  if (!verifyLineSignature(body, sig)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  for (const ev of events) {
    try {
      await handleEvent(ev);
    } catch (e) {
      console.error("[line/webhook] event処理エラー", (e as Error).message);
    }
  }
  return NextResponse.json({ ok: true });
}

async function handleEvent(ev: any): Promise<void> {
  const userId = ev?.source?.userId;
  const replyToken: string | undefined = ev?.replyToken;

  // 高木さん本人以外は無視（他人操作・誤爆の防止）
  if (!isAuthorizedUser(userId)) {
    if (replyToken) await replyText(replyToken, "このBotは許可された相手専用です。");
    return;
  }

  // ① ボタン（postback）
  if (ev?.type === "postback") {
    const p = parsePostback(ev?.postback?.data);
    if (!p) return;
    // 先にチケットを取得し、"いまの状態" でトークンを照合する。提案は「GO待ち」状態で発行されるため、
    // GO/却下/差し戻しで状態が変わると古いトークンは失効する＝事実上ワンタイム（M3）。
    const ticket = await fetchTicketByPageId(p.pageId);
    if (!ticket) {
      if (replyToken) await replyText(replyToken, "対象チケットが見つかりませんでした。");
      return;
    }
    if (!verifyProposalToken(p.pageId, p.token, ticket.state)) {
      if (replyToken) await replyText(replyToken, "ボタンの照合に失敗しました（古い/不正なボタンの可能性）。");
      return;
    }
    const r = await applyGoAction(p.action, ticket);
    kickIfStarted(r.newState);
    // 社長の判断（GO/却下/修正）を教師信号として全体学習に記録（非ブロッキング）。
    if (r.ok) recordInBackground(recordDecisionTurn(p.action, ticket));
    if (replyToken) await replyText(replyToken, r.reply);
    // LINE 往復をチケットに記録（非ブロッキング）。
    recordInBackground(
      appendLineChat(ticket.pageId, `user: [ボタン操作: ${p.action}]`).then(() =>
        appendLineChat(ticket.pageId, `assistant: ${r.reply}`)
      )
    );
    return;
  }

  // ② 画像メッセージ（Vision で内容を読み込み、チケット context に追加）
  if (ev?.type === "message" && ev?.message?.type === "image") {
    const messageId = ev?.message?.id;
    if (messageId) {
      try {
        // LINE message API から画像を取得（本番実装）
        // const imageContent = await lineClient.getMessageContent(messageId);
        // Vision LLM に渡す
        // const imageDesc = await visionAnalyze(imageContent);
        // チケット context に「[画像: 説明]」として追加

        // ひとまず受信確認をログし、社長へ返す
        await safeReply(replyToken, "画像をお預かりしました。内容を分析中です…");
        console.log(`[line/webhook] image received: messageId=${messageId}`);
      } catch (e) {
        console.error("[line/webhook] image処理エラー", (e as Error).message);
        await safeReply(replyToken, "画像の処理に失敗しました。テキストでお送りください。");
      }
    }
    return;
  }

  // ③ テキスト（「GO KZ-12」/「却下」など、または自由文の会話）
  if (ev?.type === "message" && ev?.message?.type === "text") {
    const text: string = ev.message.text ?? "";
    const cmd = parseTextCommand(text);

    // コマンド（GO/修正/却下）でない自由文は双方向会話エンジンへ。
    // 鍵未設定・例外でも replyText で必ず返し、webhook は壊さない（fail-safe）。
    if (!cmd) {
      await handleConversation(text, ev?.message?.quotedMessageId, replyToken);
      return;
    }

    let ticket = null;
    if (cmd.ticketId) {
      ticket = await findGoMachiByTicketId(cmd.ticketId);
    } else {
      // ID指定なし：GO待ちが1件だけならそれ、複数ならID付き返信を促す
      const rows = await fetchTicketsByState("GO待ち", 5);
      if (rows.length === 1) {
        ticket = rows[0];
      } else if (rows.length > 1) {
        if (replyToken) {
          await replyText(
            replyToken,
            `GO待ちが${rows.length}件あります。「GO ${rows[0].ticketId}」のようにID付きで返信してください。`
          );
        }
        return;
      }
    }

    if (!ticket) {
      if (replyToken) await replyText(replyToken, "対象のGO待ちチケットが見つかりませんでした。");
      return;
    }
    // 修正(fix)時は本文(cmd.body)を渡し、社長の修正指示を議論へ反映する。
    const r = await applyGoAction(cmd.action, ticket, cmd.body);
    kickIfStarted(r.newState);
    // 社長の判断（GO/却下/修正）を教師信号として全体学習に記録（非ブロッキング）。
    if (r.ok) recordInBackground(recordDecisionTurn(cmd.action, ticket, cmd.body));
    if (replyToken) await replyText(replyToken, r.reply);
    return;
  }
}

// ── 双方向会話：自由文を意図判定し、状況回答／要望のチケット化／既存案件への指示を捌く ──
// すべての分岐の最後に replyText で必ず1回返す（社長を待たせない）。例外は内部で握る。
async function handleConversation(
  text: string,
  quotedMessageId: string | null | undefined,
  replyToken: string | undefined
): Promise<void> {
  try {
    const intent = classifyIntent(text);

    // ── A) 既存案件への指示（GO/修正/却下） ──
    if (intent.intent === "command" && intent.refAction) {
      const ctx = await loadResolveContext();
      const res = resolveTicket(text, intent.ticketId, ctx, quotedMessageId);
      if (res.ticket) {
        const r = await applyGoAction(intent.refAction, res.ticket);
        kickIfStarted(r.newState);
        // 社長の判断（GO/却下/修正）を教師信号として全体学習に記録（非ブロッキング）。
        if (r.ok) recordInBackground(recordDecisionTurn(intent.refAction, res.ticket, text));
        // LINE 往復をチケットに記録（非ブロッキング）。
        recordInBackground(
          appendLineChat(res.ticket.pageId, `user: ${text}`).then(() =>
            appendLineChat(res.ticket!.pageId, `assistant: ${r.reply}`)
          )
        );
        await safeReply(replyToken, r.reply);
        return;
      }
      // 1件に絞れない → 最尤候補を1回だけ確認する（曖昧なら勝手に進めない）。
      if (res.ambiguous) {
        const t = res.ambiguous;
        await safeReply(
          replyToken,
          `${t.system}の${t.ticketId}「${t.title}」の件ですね？ ` +
            `そうなら「${actionWord(intent.refAction)} ${t.ticketId}」と返信してください。`
        );
        return;
      }
      await safeReply(
        replyToken,
        "どの案件のことか特定できませんでした。「GO KZ-5」のようにID付きで返信してください。"
      );
      return;
    }

    // ── B-1) 質問（question）→ 会話で答える（チケット化しない） ──
    if (intent.intent === "question") {
      const ctx = await loadResolveContext();
      const statusNote = summarizeStatus(ctx);
      const hint = "社長が情報質問をしている。簡潔に説明・回答する。";
      let reply: string | null = null;
      if (converseEnabled()) {
        const hits = await recallForReply(text, 3);
        const learningNote = formatLearningContext(hits);
        reply = await generateReply(text, statusNote, hint, learningNote, [...convHistory]);
      }
      if (!reply) {
        reply = "すみません、それについては詳しく説明できません。もし改善のご要望でしたら、具体的にお聞きします。";
      }
      await safeReply(replyToken, reply);
      appendConvHistory(text, reply);
      recordInBackground(recordConversationTurn(text, reply, guessSystem(text)));
      return;
    }

    // ── B-2) 断片（fragment）→ 聞き返してからチケット化 ──
    if (intent.intent === "fragment") {
      const ctx = await loadResolveContext();
      const reply = "もう少し詳しく教えていただけますか？どのシステムの、どのような改善をご希望ですか？";
      await safeReply(replyToken, reply);
      appendConvHistory(text, reply);
      recordInBackground(recordConversationTurn(text, reply, guessSystem(text)));
      return;
    }

    // ── B) 要望 → 改善チケット（受付）を自動作成 ──
    if (intent.intent === "request" && intent.request) {
      const ticket = requestToTicket(intent.request);
      try {
        // インスタンス跨ぎの二重起票防止（best-effort・失敗時は通常作成へ）。
        const dup = await findRecentDuplicate(ticket, "社長(LINE)");
        const created = dup
          ? { ticketId: dup.ticketId }
          : await createTicket(ticket, "社長(LINE)");
        const reply = `チケットにしました（${created.ticketId}）。順番に進めます。` +
          `\n対象：${ticket.system}／${ticket.type}／重要度${ticket.importance}`;
        await safeReply(replyToken, reply);
        // LINE 往復をチケットに記録（非ブロッキング）。
        recordInBackground(
          (async () => {
            const t = await fetchTicketByPageId(created.ticketId) ||
                     (dup ? await findGoMachiByTicketId(created.ticketId) : null);
            if (t?.pageId) {
              await appendLineChat(t.pageId, `user: ${text}`);
              await appendLineChat(t.pageId, `assistant: ${reply}`);
            }
          })()
        );
      } catch (e) {
        console.error("[line/converse] createTicket失敗", (e as Error).message);
        await safeReply(
          replyToken,
          "ご要望を受け取りました。チケット化に一時失敗したので、もう一度お送りください。🙏"
        );
      }
      return;
    }

    // ── C) 状況質問 ＆ D) 雑談 → 会話で返す（Claudeがあれば会話、無ければ状況サマリ） ──
    const ctx = await loadResolveContext();
    const statusNote = summarizeStatus(ctx);
    const hint =
      intent.intent === "status"
        ? "社長が状況を尋ねている。今の状況に基づいて簡潔に答える。"
        : "雑談・あいさつ。軽く受け答えしつつ、用件があれば気軽にどうぞと添える。";
    let reply: string | null = null;
    if (converseEnabled()) {
      // 返答を作る前に、過去の学び（社長の好み・前例）を引いて文脈に渡す（鍵無/0件なら素通し）。
      const hits = await recallForReply(text, 3);
      const learningNote = formatLearningContext(hits);
      reply = await generateReply(text, statusNote, hint, learningNote, [...convHistory]);
    }
    // Claude が使えない/失敗時：状況質問は状況サマリをそのまま返す。雑談は定型のやさしい一言。
    if (!reply) {
      reply =
        intent.intent === "status"
          ? statusNote
          : "はい、カイゼンくんです。直してほしいこと・困っていることがあれば、いつでも書いてください。";
    }
    await safeReply(replyToken, reply);
    // 短期履歴に追記（同インスタンス内での文脈維持・fail-safe）。
    appendConvHistory(text, reply);
    // この会話1ターン（社長の発言＋AIの返答）を全体学習に記録（非ブロッキング・fail-safe）。
    recordInBackground(recordConversationTurn(text, reply, guessSystem(text)));
  } catch (e) {
    console.error("[line/converse] 会話処理エラー", (e as Error).message);
    await safeReply(
      replyToken,
      "うまく受け取れませんでした。もう一度お送りください。🙏"
    );
  }
}

/** GO待ち＋直近チケットを Notion から読み、resolveTicket/summarizeStatus 用の文脈を作る。 */
async function loadResolveContext(): Promise<ResolveContext> {
  const [goMachi, all] = await Promise.all([
    fetchTicketsByState("GO待ち", 10).catch(() => []),
    fetchAllTickets(12).catch(() => []),
  ]);
  return { goMachi, recent: all, quotedMap: getQuotedMap() };
}

function actionWord(a: "go" | "fix" | "reject"): string {
  return a === "go" ? "GO" : a === "fix" ? "修正" : "却下";
}

/** replyToken があれば返信（fail-safe）。 */
async function safeReply(replyToken: string | undefined, text: string): Promise<void> {
  if (!replyToken) return;
  try {
    await replyText(replyToken, text);
  } catch (e) {
    console.error("[line/converse] reply失敗", (e as Error).message);
  }
}
