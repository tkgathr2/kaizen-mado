// ── LINE push エンドポイント（外部監視系クライアントからの汎用通知） ──
// checkLinePushAuth で認証：CRON_SECRET (x-cron-secret / Authorization: Bearer) に加え、
// 監視系クライアント専用の MONITOR_PUSH_SECRET (x-monitor-secret) も受ける。
// 【社長指示 2026-08-15】カイゼンくん自前LINEチャネルへの送信は全廃。真田システム経由が本線、
// 失敗時はSlack警告（旧: mention-hishoへの相乗りを廃止しカイゼンくん固有チャンネルのみで送る
// という2026-06-28の決定を、本件で再度上書きする）。
//
// 【Medium指摘6・2026-08-15 バグチェック】PR#169で宛先が「カイゼンくん自前LINE」から
// 「真田専用LINEチャネル」に変わったため、MONITOR_PUSH_SECRETの保持者は真田Bot名義で任意テキストを
// 真田チャネルへ投入できる（旧設計の「LINE通知のみの最小権限鍵」より実質的な権限が大きい＝
// lib/cronAuth.ts のコメント参照）。真田チャネルは社長の自由文返信＝fireDevRoutine起動（開発発注）
// という特権的な経路の入口のため、この本文には「外部監視系からの自動通知であり、返信は開発発注
// として扱われない」旨の固定枠を必ず付ける（awaitsReplyは付けない＝この経路はそもそも返信を
// 求めない設計）。
import { NextRequest, NextResponse } from "next/server";
import { checkLinePushAuth } from "@/lib/cronAuth";
import { notifySlackAlert } from "@/lib/line";
import { handoffFyiToSanada } from "@/lib/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINE_TEXT_MAX = 5000;

// 【Medium指摘6・2026-08-15 バグチェック】この経路は真田専用LINEチャネルへ着地するため、
// 社長が「開発発注（自由文返信→fireDevRoutine起動）」と誤認しないよう、本文の前後に
// 「外部監視系からの自動通知であり、返信は開発発注として扱われない」ことを示す固定枠を付ける。
const EXTERNAL_NOTICE_HEADER =
  "⚠️【外部監視の自動通知】これは監視システムからの自動送信です。返信しても開発発注（Claude Code起動）としては扱われません。";
const EXTERNAL_NOTICE_DIVIDER = "――――――――――――――";

export async function POST(req: NextRequest) {
  if (!checkLinePushAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { text?: string; message?: string; sender?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const raw = body.text ?? body.message ?? "";
  if (!raw || typeof raw !== "string") {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
  }

  // title があれば先頭に付ける（task-complete.ps1 の [Claude Code] プレフィクス互換）
  const titleRaw = typeof body.title === "string" ? body.title
                 : typeof body.sender === "string" ? body.sender : "";
  const title = titleRaw.replace(/[\r\n\t]/g, " ").trim().slice(0, 40);
  const message = title ? `[${title}] ${raw}` : raw;

  // fyiText＝実際に真田チャネルへ届く本文。外部監視通知であることが視覚的に分かるよう
  // 前後にマーカーを付けた「最終形」の長さで上限判定する（マーカー分の超過を見逃さないため）。
  const fyiText = [
    EXTERNAL_NOTICE_HEADER,
    EXTERNAL_NOTICE_DIVIDER,
    message,
    EXTERNAL_NOTICE_DIVIDER,
  ].join("\n");

  if (fyiText.length > LINE_TEXT_MAX) {
    return NextResponse.json(
      { error: "text too long", max: LINE_TEXT_MAX, got: fyiText.length },
      { status: 400 }
    );
  }

  // ticketId概念が無い外部通知のため、合成IDで冪等キーを作る（同一内容の連投を弾く）。
  const pushId = `external-push:${title || "untitled"}`;
  const handed = await handoffFyiToSanada(pushId, fyiText).catch(() => false);
  if (!handed) {
    const alerted = await notifySlackAlert(
      `外部通知（${title || "無題"}）を真田チャネルへ送れませんでした。text: ${message.slice(0, 100)}`,
      "⚠️ 外部通知が真田チャネルへ送れませんでした"
    ).catch(() => false);
    if (!alerted) {
      return NextResponse.json({ error: "send failed" }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true });
}
