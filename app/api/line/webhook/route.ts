// ── POST /api/line/webhook ── LINEからのGO/修正/却下を検知してチケットを進める ──
// 1) x-line-signature を channel secret で検証（不一致は401）
// 2) 送信元userIdが高木さん本人か検証（他人・誤爆を弾く）
// 3) postback（ボタン）or text（「GO KZ-12」）を解析 → 該当チケットへ applyGoAction
// LINEには常に200を返す（個別イベントの失敗でwebhook全体は失敗にしない＝再送ループ防止）。
import { NextRequest, NextResponse } from "next/server";
import {
  verifyLineSignature,
  parsePostback,
  verifyProposalToken,
  parseTextCommand,
  isAuthorizedUser,
  replyText,
} from "@/lib/line";
import {
  fetchTicketByPageId,
  findGoMachiByTicketId,
  fetchTicketsByState,
} from "@/lib/tickets";
import { applyGoAction } from "@/lib/govote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (replyToken) await replyText(replyToken, r.reply);
    return;
  }

  // ② テキスト（「GO KZ-12」/「却下」など）
  if (ev?.type === "message" && ev?.message?.type === "text") {
    const cmd = parseTextCommand(ev.message.text);
    if (!cmd) return; // 雑談・無関係な発言は無視（誤爆防止）

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
    const r = await applyGoAction(cmd.action, ticket);
    if (replyToken) await replyText(replyToken, r.reply);
    return;
  }
}
