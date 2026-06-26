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
  type ResolveContext,
} from "@/lib/converse";
import { createTicket } from "@/lib/notion";
import { findRecentDuplicate } from "@/lib/tickets";

// GO適用の結果が「着手」になったら、即 /api/execute を起こして実改修へ進める（応答はブロックしない）。
function kickIfStarted(newState?: string) {
  if (newState === "着手") waitUntil(kickEndpoint("/api/execute"));
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
    if (!verifyProposalToken(p.pageId, p.token)) {
      if (replyToken) await replyText(replyToken, "ボタンの照合に失敗しました（古い/不正なボタンの可能性）。");
      return;
    }
    const ticket = await fetchTicketByPageId(p.pageId);
    if (!ticket) {
      if (replyToken) await replyText(replyToken, "対象チケットが見つかりませんでした。");
      return;
    }
    const r = await applyGoAction(p.action, ticket);
    kickIfStarted(r.newState);
    if (replyToken) await replyText(replyToken, r.reply);
    return;
  }

  // ② テキスト（「GO KZ-12」/「却下」など、または自由文の会話）
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

    // ── B) 要望 → 改善チケット（受付）を自動作成 ──
    if (intent.intent === "request" && intent.request) {
      const ticket = requestToTicket(intent.request);
      try {
        // インスタンス跨ぎの二重起票防止（best-effort・失敗時は通常作成へ）。
        const dup = await findRecentDuplicate(ticket, "社長(LINE)");
        const created = dup
          ? { ticketId: dup.ticketId }
          : await createTicket(ticket, "社長(LINE)");
        await safeReply(
          replyToken,
          `チケットにしました（${created.ticketId}）。順番に進めます。` +
            `\n対象：${ticket.system}／${ticket.type}／重要度${ticket.importance}`
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
      reply = await generateReply(text, statusNote, hint);
    }
    // Claude が使えない/失敗時：状況質問は状況サマリをそのまま返す。雑談は定型のやさしい一言。
    if (!reply) {
      reply =
        intent.intent === "status"
          ? statusNote
          : "はい、カイゼンくんです。直してほしいこと・困っていることがあれば、いつでも書いてください。";
    }
    await safeReply(replyToken, reply);
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
