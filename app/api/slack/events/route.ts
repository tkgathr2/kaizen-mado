// ── POST /api/slack/events ── Slack Events API webhook ──
// 幹部Bot（真田・早乙女等）への app_mention を受け取り、カイゼンチケットを起票してフローを起動する。
// 対象：全ての app_mention（バグ・質問・要望・改善・雑談 問わず全メンションを受付）。
// type は本文のキーワードから自動判定（"bug" | "改善" | "新機能"）。
// 認証: x-slack-signature（HMAC-SHA256 + タイムスタンプ検証・5分以内のみ受付）を必ず通過してから処理する。
//   ★ 複数アプリ対応：幹部Botは人格ごとに別Slackアプリ＝別署名鍵のため、SLACK_SIGNING_SECRET は
//     カンマ区切りで複数の鍵を持てる。受信イベントはいずれか1つの鍵で署名一致すれば通す。
// Slack は3秒以内の応答を要求するため、起票は同期・process kickは非同期（fire-and-forget）にする。
// 成長エンジン連動: ここでは recall しない。過去の学びの参照は非同期の議論工程（lib/discuss.ts が
//   統一メモリ層 lib/memory.ts から recall する）で行う＝3秒ホットパスを汚さず、detailにも残さない。
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createTicket } from "@/lib/notion";
import { findRecentDuplicate } from "@/lib/tickets";
import type { Ticket, TicketType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** タイムスタンプ許容差（リプレイ攻撃防止・秒単位）。 */
const MAX_TIMESTAMP_DIFF_SEC = 5 * 60; // 5分

/**
 * SLACK_SIGNING_SECRET をカンマ区切りで複数鍵に分解する（前後空白・空要素は除去）。
 * 幹部Botが複数アプリにまたがるため、各アプリの Signing Secret を1つの env に並べて持つ。
 * 例: SLACK_SIGNING_SECRET="abc123...,def456..."（真田アプリ,早乙女アプリ）
 */
function parseSigningSecrets(): string[] {
  const raw = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Slack Events API の署名検証（HMAC-SHA256・複数鍵対応）。
 * secrets のいずれか1つで一致すれば true。鍵が空、または全て不一致なら false（fail-closed）。
 */
function verifySlackSignature(
  secrets: string[],
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  if (secrets.length === 0) return false;

  // タイムスタンプが数字以外（空文字・非数値）はリプレイ攻撃の変形として拒否する。
  // Number("") = 0, Number("abc") = NaN → Math.abs(now - NaN) = NaN で検証をすり抜けるため、
  // 事前に純粋な10進数字列であることを確認する（Slackの仕様は UNIX秒の整数文字列）。
  if (!/^\d+$/.test(timestamp)) return false;

  // タイムスタンプが5分以上古い → リプレイ攻撃防止
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_DIFF_SEC) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const sigBuf = Buffer.from(signature, "utf8");

  // 登録された各アプリの署名鍵を順に試し、1つでも一致すれば通す。
  for (const secret of secrets) {
    const hmac = crypto.createHmac("sha256", secret).update(baseString).digest("hex");
    const expBuf = Buffer.from(`v0=${hmac}`, "utf8");
    // タイミング攻撃防止のため timingSafeEqual を使う（長さ不一致は先に弾く）。
    if (expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) {
      return true;
    }
  }
  return false;
}

/** メンション（<@UXXX>）を除去して本文だけ取り出す。 */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * メンション本文のキーワードから TicketType を自動推定する。
 * 全ての app_mention を受け付け、内容に応じて適切な種別に振り分ける。
 * - バグ系 → "bug"
 * - 機能追加・新しい仕組み系 → "新機能"
 * - 使い勝手・改善要望・質問系 → "改善"（デフォルト＝全メンションを取りこぼさない）
 */
function inferTicketType(text: string): TicketType {
  // バグ系（エラー・壊れ・動かない等）
  if (
    /バグ|エラー|壊れ|動かな|おかし|できない|失敗|ERROR|bug|crash|broken|not work|落ちた|止まった|表示されない|送れない|登録できない/i.test(
      text
    )
  )
    return "bug";

  // 新機能系（追加・新しく・作って・対応してほしい等）
  if (
    /追加|新しい|新機能|作って|実装|対応して|できたら|あったらいい|機能がほしい|feature|request|搭載|設けて/i.test(
      text
    )
  )
    return "新機能";

  // 改善系・質問系（使いにくい・もっと・質問・教えて等）すべてのメンションを受け付けるため
  // 「質問」「使い方」なども "改善" として起票し、カイゼンフローで対応する。
  return "改善";
}

/** 内部APIのベースURL（Vercel本番 or ローカル開発）。 */
function getBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  return "http://localhost:3000";
}

export async function POST(req: NextRequest) {
  // raw body を先に読む（署名検証に必要）
  const rawBody = await req.text();

  // Slack 署名検証（複数アプリ＝複数署名鍵に対応）
  const secrets = parseSigningSecrets();
  if (secrets.length === 0) {
    console.error("[slack/events] SLACK_SIGNING_SECRET is not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";
  if (!verifySlackSignature(secrets, timestamp, rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // URL 検証（Slack Event API 登録時の challenge）
  if (body?.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // event_callback 以外は無視（即200を返してSlackを安心させる）
  if (body?.type !== "event_callback") {
    return NextResponse.json({ ok: true });
  }

  const event = body?.event;

  // app_mention 以外は無視。bot_id 付き = Bot自身のメッセージ → スキップ（無限ループ防止）
  // ※ 全ての app_mention（バグ/質問/要望/改善/雑談 問わず）を受け付ける。
  if (event?.type !== "app_mention" || event?.bot_id) {
    return NextResponse.json({ ok: true });
  }

  const rawText = typeof event?.text === "string" ? event.text : "";
  const text = stripMentions(rawText);
  const channelId: string = event?.channel ?? "";
  // スレッド内メンションは thread_ts、通常メンションは ts をスレッドの起点にする
  const threadTs: string = event?.thread_ts ?? event?.ts ?? "";
  const userId: string = event?.user ?? "";

  // 最低限の情報が揃っていなければスキップ
  if (!text || !channelId || !threadTs) {
    return NextResponse.json({ ok: true });
  }

  // ── チケット起票（同期・≈300ms）──
  // Slack の3秒制限内に完了するため起票は同期で行う。
  // recall（過去の学びの参照）はここでは行わない＝非同期の議論工程(lib/discuss.ts)に委ねる。
  try {
    // type自動判定（全メンションを受付・内容から bug/改善/新機能 に振り分け）
    const ticketType = inferTicketType(text);

    const ticket: Ticket = {
      system: "その他",
      type: ticketType,
      title: text.slice(0, 100) || "Slackからの問い合わせ",
      detail: text,
      importance: "中",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: userId,
    };
    const reporter = `Slack:<@${userId}>`;

    // 重複チェック（15秒窓・fail-safe）
    const dup = await findRecentDuplicate(ticket, reporter).catch(() => null);
    if (dup) {
      // 重複は静かに無視（Slackには返答しない＝Botのスパム防止）
      return NextResponse.json({ ok: true });
    }

    // 起票
    const result = await createTicket(ticket, reporter);
    console.log(
      "[slack/events] ticket created:",
      result.ticketId,
      "type:",
      ticketType,
      "channel:",
      channelId
    );

    // ── /api/process を非同期起動（fire-and-forget）──
    // 起票完了後に受付→議論中→GO伺いフローを回す。
    // CRON_SECRET が未設定のときは内部 kick をスキップ（認証バイパスを防ぐ）。
    // この場合でもチケットは起票済みなので次回の /api/process cron で処理される。
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (!cronSecret) {
      console.warn(
        "[slack/events] CRON_SECRET is not set; skipping process kick for ticket",
        result.ticketId
      );
    } else {
      const baseUrl = getBaseUrl();
      fetch(`${baseUrl}/api/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-secret": cronSecret,
        },
        body: JSON.stringify({ pageId: result.pageId }),
      }).catch((e) =>
        console.warn("[slack/events] process kick failed (non-fatal):", e.message)
      );
    }
  } catch (err) {
    // 起票失敗もSlackには200を返す（Slackへのエラー表示を避ける・再送ループを防ぐ）
    console.error("[slack/events] createTicket failed:", (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
