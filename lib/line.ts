// ── LINE Messaging API クライアント（GO伺いの送信＋webhook署名検証） ──
// 依存軽量化のため素のfetch + node:crypto で実装（line-notify-ai の line.ts を踏襲）。
// 秘密情報は process.env から読む。LINE鍵が未設定なら lineEnabled()=false で「送らない」=fail-safe。
// このモジュール自体は対人送信を行うが、宛先は LINE_TARGET_USER_ID（高木さん本人）に限定する。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TicketRow } from "./tickets";
import type { DiscussResult } from "./discuss";

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

// ── env ヘルパ ──
function accessToken(): string {
  const v = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!v) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return v;
}
function channelSecret(): string {
  const v = process.env.LINE_CHANNEL_SECRET;
  if (!v) throw new Error("LINE_CHANNEL_SECRET is not set");
  return v;
}
function targetUserId(): string {
  const v = process.env.LINE_TARGET_USER_ID;
  if (!v) throw new Error("LINE_TARGET_USER_ID is not set");
  return v;
}

/** LINE連携が有効か（3鍵すべて揃ったときだけ送信する。未設定なら静かにスキップ）。 */
export function lineEnabled(): boolean {
  return Boolean(
    process.env.LINE_CHANNEL_ACCESS_TOKEN &&
      process.env.LINE_CHANNEL_SECRET &&
      process.env.LINE_TARGET_USER_ID
  );
}

/** 送信元userIdが通知先（高木さん本人）か。webhookで他人の操作を弾く。 */
export function isAuthorizedUser(userId: string | undefined | null): boolean {
  if (!userId) return false;
  const expected = process.env.LINE_TARGET_USER_ID;
  if (!expected) return false;
  const a = Buffer.from(userId);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Webhook署名検証。body生文字列を channel secret で HMAC-SHA256 → base64 し、
 * x-line-signature と timing-safe に比較する。
 */
export function verifyLineSignature(
  body: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;
  let secret: string;
  try {
    secret = channelSecret();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── GO伺いの照合トークン（誤爆・なりすまし＋失効対策） ──
// postbackのdataは利用者が改ざんできないが、署名済みwebhookでも「どのチケットへの操作か」を
// 確実に結びつけるため、pageIdからchannel secretでHMACした短いトークンを付ける。
// 我々が送ったボタン以外（偽postback）を弾く。
//
// ★失効（事実上のワンタイム化・M3）：旧実装は pageId だけでHMACしていたため、トークンが
//   「恒久有効」だった（GO/却下で状態が変わっても古いボタンが永遠に効く）。そこでチケットの
//   "状態(state)" をHMAC入力へ混ぜる。提案は必ず「GO待ち」状態で発行されるので既定値は "GO待ち"。
//   検証側（webhook）は "いまのチケット状態" で照合するため、GO/却下/差し戻しで状態が変われば
//   古いトークンは一致しなくなる＝事実上ワンタイム。進行中チケット（GO待ち）はそのまま有効。
// ★長さ：64bit(16hex)→128bit(32hex)に延長して総当たり耐性を上げる。
const PROPOSAL_DEFAULT_STATE = "GO待ち";

export function proposalToken(pageId: string, state: string = PROPOSAL_DEFAULT_STATE): string {
  let secret: string;
  try {
    secret = channelSecret();
  } catch {
    return "";
  }
  return createHmac("sha256", secret)
    .update(`kz:${pageId}:${state}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** トークンを timing-safe に検証する。state＝照合時点のチケット状態（既定 "GO待ち"）。
 * 状態が変わると expected も変わるため、古い状態で発行されたトークンは失効する。 */
export function verifyProposalToken(
  pageId: string,
  token: string | undefined | null,
  state: string = PROPOSAL_DEFAULT_STATE
): boolean {
  if (!token) return false;
  const expected = proposalToken(pageId, state);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GoAction = "go" | "fix" | "reject";

/** GO/修正/却下 の quick reply（postback）を組み立てる。dataにチケットpageIdと照合トークンを埋める。 */
function goQuickReply(pageId: string) {
  const tk = proposalToken(pageId);
  const mk = (act: GoAction, label: string, displayText: string) => ({
    type: "action" as const,
    action: {
      type: "postback" as const,
      label,
      data: `kz=${act}&pid=${encodeURIComponent(pageId)}&tk=${tk}`,
      displayText,
    },
  });
  return {
    items: [
      mk("go", "✅ GO（着手）", "GO"),
      mk("fix", "✏️ 修正", "修正"),
      mk("reject", "🚫 却下", "却下"),
    ],
  };
}

/** postback の data 文字列を {action,pageId,token} にパースする。 */
export function parsePostback(
  data: string | undefined | null
): { action: GoAction; pageId: string; token: string } | null {
  if (!data) return null;
  const params = new URLSearchParams(data);
  const act = params.get("kz");
  if (act !== "go" && act !== "fix" && act !== "reject") return null;
  const pageId = params.get("pid") || "";
  if (!pageId) return null;
  return { action: act, pageId, token: params.get("tk") || "" };
}

// テキスト返信からGO/修正/却下＋チケットIDを読む（ボタンを使わず「GO KZ-12」と打つ場合）。
const TEXT_GO = /^(go|ok|ゴー|ごー|オーケー|承認|よし)/i;
const TEXT_REJECT = /^(却下|ng|やめ|中止|なし)/i;
// 「修正して」「修正してください」のように丁寧な命令補助語が付く形も同じコマンド扱い。
// 補助語(して/してください/して下さい)は本文ではないので body 抽出時に一緒に削る。
const TEXT_FIX = /^(修正|なおして|直して|やり直し)(して(ください|下さい)?)?/;
const TICKET_ID_RE = /\b(KZ[-－]?\d+)\b/i;

/** 自由文から {action, ticketId?, body?} を読む。判定不能なら null（誤爆防止）。
 * body＝コマンド語・チケットID を除いた「本文」。社長が「修正 KZ-12 ◯◯を直して」と
 * 返信したときの「◯◯を直して」部分。修正(fix)時にこれを議論へ反映する。 */
export function parseTextCommand(
  text: string | undefined | null
): { action: GoAction; ticketId: string | null; body: string } | null {
  if (!text) return null;
  const t = text.trim();
  let action: GoAction | null = null;
  if (TEXT_REJECT.test(t)) action = "reject";
  else if (TEXT_FIX.test(t)) action = "fix";
  else if (TEXT_GO.test(t)) action = "go";
  if (!action) return null;
  const m = t.match(TICKET_ID_RE);
  const ticketId = m ? m[1].toUpperCase().replace("－", "-").replace(/KZ(\d)/, "KZ-$1") : null;
  // 本文＝先頭のコマンド語とチケットID表記を取り除いた残り。
  // 例: 「修正 KZ-12 ◯◯を直して」→「◯◯を直して」。区切りの記号・空白も削る。
  let body = t
    .replace(TEXT_REJECT, "")
    .replace(TEXT_FIX, "")
    .replace(TEXT_GO, "");
  if (m) body = body.replace(m[0], "");
  body = body.replace(/^[\s、,：:。.\-－―ー　]+/, "").trim();
  return { action, ticketId, body };
}

// ── 引用返信のための「送信メッセージID → チケットID」対応（best-effort・揮発） ──
// LINEの送信API応答は sentMessages[].id を返す。社長がその提案メッセージを
// 「引用返信」すると webhook に message.quotedMessageId が乗る。これを使い
// 「どのメッセージ＝どのチケットか」を特定するための軽量な対応表。
//
// ★限界（重要）：Vercel serverless は連続リクエストを別インスタンスで受けうるため、
//   この in-memory マップは「同じインスタンスに当たれば効く」程度の best-effort。
//   外れたら resolveTicket が自然文（システム名／直近）にフォールバックする設計（converse.ts）。
//   恒久対応は外部KV（Redis等）への移設だが、本実装では依存を増やさず軽量同居に留める。
const QUOTED_MAP_MAX = 200;
const quotedMap = new Map<string, string>(); // messageId → ticketId

/** 送信メッセージID→チケットID を記録（古いものから捨てる簡易LRU）。 */
export function recordSentMessage(messageId: string, ticketId: string): void {
  if (!messageId || !ticketId) return;
  if (quotedMap.has(messageId)) quotedMap.delete(messageId);
  quotedMap.set(messageId, ticketId);
  while (quotedMap.size > QUOTED_MAP_MAX) {
    const oldest = quotedMap.keys().next().value;
    if (oldest === undefined) break;
    quotedMap.delete(oldest);
  }
}

/** 現在の「メッセージID→チケットID」対応の浅いコピーを返す（resolveTicket に渡す）。 */
export function getQuotedMap(): Record<string, string> {
  return Object.fromEntries(quotedMap);
}

// ── 送信系（失敗してもthrowしない：呼び出し元の改善ループを止めないため fail-safe） ──
// 返値：失敗時は null、成功時は LINE応答（sentMessages を含む）。旧来の boolean 判定は
// `!!await postLine(...)` で互換。
async function postLine(endpoint: string, payload: unknown): Promise<any | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken()}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[line] post失敗", { endpoint, status: res.status, detail: detail.slice(0, 200) });
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("[line] post例外", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** 任意テキストを高木さん宛にpushする（完了報告・警告等）。 */
export async function pushText(text: string): Promise<boolean> {
  if (!lineEnabled()) return false;
  return Boolean(
    await postLine(LINE_PUSH_ENDPOINT, {
      to: targetUserId(),
      messages: [{ type: "text", text }],
    })
  );
}

/** postback応答用の簡易reply（「着手します」等の受領返信）。 */
export async function replyText(replyToken: string, text: string): Promise<boolean> {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return false;
  return Boolean(
    await postLine(LINE_REPLY_ENDPOINT, {
      replyToken,
      messages: [{ type: "text", text }],
    })
  );
}

// ── 文面ヘルパ（スマホのLINEは1行が短く折り返されるため、短文・要点先頭で組む） ──

/** LINE向けに1行へ整形して切り詰める（改行・連続空白は1スペースに）。 */
export function truncateForLine(s: string | null | undefined, max: number): string {
  const t = (s || "").trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

/** NotionページURL（詳細はLINEに書かずリンクへ逃がす）。 */
export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${(pageId || "").replace(/-/g, "")}`;
}

// ── 文字化け（mojibake）検知ガード ──
// 旧テスト投稿や取込時のエンコード崩れで「縺ｻ縺?縺薙■繧繧」のような呪文がそのまま
// LINEへ流れ、社長に「意味不明な通知」として届く事故があった。送信前にこれを検知し、
// 呪文ではなく「⚠️ 文字化けの可能性（リンクで原文確認）」という"意味の分かる警告"に置換する。

// UTF-8テキストをCP932/Latin1として誤デコードしたときに高頻度で現れる「署名文字」。
// これらは正常な日本語ではまず連続して出ない（出れば誤デコードの証拠）。
const MOJIBAKE_SIGNATURE =
  /[縀-繿�]|繧|繝|縺|蜉|蜈|蜊|郢|髟|髢|竏|繹|繞|繖|繚|ã|â|Ã|Â|�/g;
// 半角カタカナ（U+FF61–FF9F）。単体では正常（ﾊﾟｿｺﾝ等）なので、署名文字と併発した時だけ加点。
const HALFWIDTH_KANA = /[｡-ﾟ]/g;

/** 文字列が文字化け（mojibake）している可能性が高いか。誤検知を避けるため保守的に判定。 */
export function looksGarbled(s: string | null | undefined): boolean {
  const t = (s || "").trim();
  if (t.length < 4) return false; // 短文は誤判定を避けて素通し
  const sig = (t.match(MOJIBAKE_SIGNATURE) || []).length;
  const kana = (t.match(HALFWIDTH_KANA) || []).length;
  // 置換文字(�/U+FFFD)が1つでもあれば確定的に文字化け。
  if (/[�￾]/.test(t)) return true;
  // 署名文字が3つ以上、または「署名文字が2つ以上 かつ 半角カナと混在」なら文字化け。
  if (sig >= 3) return true;
  if (sig >= 2 && kana >= 1) return true;
  // 署名+半角カナの合計が全体の35%以上を占める（呪文化）。
  if (t.length >= 6 && (sig + kana) / t.length >= 0.35 && sig >= 1) return true;
  return false;
}

/** LINE向けに整形。文字化けしていれば呪文を出さず、意味の分かる警告に置換する。 */
export function cleanForLine(s: string | null | undefined, max: number): string {
  if (looksGarbled(s)) return "⚠️ 文字化けの可能性（くわしくはリンクで原文をご確認ください）";
  return truncateForLine(s, max);
}

/** 全体像（カンバン）ボードのURL。 */
export const BOARD_URL =
  (process.env.KAIZEN_PUBLIC_BASE || "https://kaizen.takagi.bz") + "/board";

// ── 工程ステッパー（社長が「今どこか／全体像」を一目で分かるように） ──
// カイゼンの全工程：①声→②提案→③GO→④着手→⑤PR→⑥反映
// 各LINE通知の先頭にこの1行を入れて、✅=済 / 🔵=いまここ / ・=これから を示す。
export const STAGES = ["声", "提案", "GO", "着手", "PR", "反映"] as const;
export type StageIndex = 1 | 2 | 3 | 4 | 5 | 6;

/** 工程バーを組み立てる。current=いまの工程(1〜6)。done=完了として閉じる場合はcurrentに6を渡す。 */
export function stageBar(current: StageIndex): string {
  return (
    "📍 " +
    STAGES.map((label, i) => {
      const n = i + 1;
      if (n < current) return `✅${label}`;
      if (n === current) return `🔵${label}`;
      return `・${label}`;
    }).join(" ")
  );
}

// 各システムのやさしい説明（社長が「何のシステムか」を一目で分かるように）。
const SYSTEM_LABELS: Record<string, string> = {
  カイゼンくん本体: "カイゼンくん（みんなの改善の声を受ける窓口アプリ）",
  プロレポ: "プロレポ（営業日報システム）",
  ステレポ: "ステレポ（SNS運用・分析システム）",
  ほうこちゃん: "ほうこちゃん（警備の報告書システム）",
  "mfc-invoice-upload": "請求書アップロード（MFクラウド連携）",
  Indeed応募通知: "Indeed応募通知（採用の応募通知Bot）",
  キャスト名簿くん: "キャスト名簿くん（スタッフ名簿システム）",
  らくらく契約くん: "らくらく契約くん（契約書づくり）",
  巡回くん: "巡回くん（SNS巡回システム）",
  その他: "その他のシステム",
};

/** システム名をやさしい説明つきにする（未知ならそのまま）。 */
export function systemLabel(system: string | null | undefined): string {
  if (!system) return "対象未特定のシステム";
  return SYSTEM_LABELS[system] || system;
}

/** メッセージ先頭の「何の件か」ヘッダー（3行）。社長が最初に
 * ①どのシステムか（やさしい説明・最上段） ②種別 ③ざっくり何をするか を一目で掴めるように。
 * 例：🖥 カイゼンくん（…窓口アプリ）/ 💡【カイゼンの提案】/ ✏️ 窓口に説明を1行足す */
export function msgHead(
  emoji: string,
  kind: string,
  system: string | null | undefined,
  title: string | null | undefined
): string {
  const sys = looksGarbled(system) ? "対象システム（文字化けの可能性）" : truncateForLine(systemLabel(system), 34);
  return (
    `🖥 ${sys}\n` +
    `${emoji}【${kind}】\n` +
    `✏️ ${cleanForLine(title || "改善のご要望", 32)}`
  );
}

/** GO伺い本文を組み立てる（チケット＋議論結果から）。
 * 読みやすさ最優先：結論（おすすめ）を先頭に、方針・リスクは要約だけ、詳細はNotionリンクへ。
 * 複数提案が連続で届いてもquick replyボタンは"最新メッセージ"にしか付かないため、
 * 「ID付きテキスト返信（GO KZ-3 等）」で前の提案にも答えられる形は維持する。 */
export function buildProposalText(ticket: TicketRow, d: DiscussResult): string {
  const id = ticket.ticketId;

  // ── 素人語の短いフィールドを使う（モデルが短文を作る前提）。
  // 文字化けガードはするが、語の途中で切らないよう切り幅は余裕を持たせる。
  // plain が空のときだけ既存フィールド（houshin/steps/risks）へフォールバック。
  const problemPlain = d.problemPlain && d.problemPlain.trim()
    ? cleanForLine(d.problemPlain, 40)
    : cleanForLine(ticket.title || d.houshin || "改善のご要望", 40);

  const fixSource =
    d.fixPlain && d.fixPlain.length > 0
      ? d.fixPlain
      : (d.steps || []);
  const fixLines = fixSource
    .filter((s) => s && s.trim())
    .slice(0, 3)
    .map((s) => `　・${cleanForLine(s, 32)}`);
  const fixBlock = fixLines.length > 0 ? fixLines : [`　・${cleanForLine(d.houshin || "内容を確認して直します", 32)}`];

  const riskPlain = d.riskPlain && d.riskPlain.trim()
    ? cleanForLine(d.riskPlain, 44)
    : (d.risks && d.risks.length > 0 ? cleanForLine(d.risks[0], 44) : "特になし");

  const sysLabel = looksGarbled(ticket.system)
    ? "対象システム（文字化けの可能性）"
    : truncateForLine(systemLabel(ticket.system), 40);
  const kousuu = looksGarbled(d.kousuu) ? "未記載" : truncateForLine(d.kousuu, 16);

  return [
    `🖥 ${sysLabel}`,
    `💡 カイゼンの提案`,
    ``,
    `❓ こまりごと`,
    `　${problemPlain}`,
    ``,
    `🔧 直し方`,
    ...fixBlock,
    ``,
    `⚠ 気をつけること`,
    `　${riskPlain}`,
    ``,
    `📊 重要度 ${truncateForLine(d.importance, 4)}／緊急度 ${truncateForLine(d.urgency, 4)}`,
    `🧭 おすすめ：${truncateForLine(d.recommendation, 24)}（目安 ${kousuu}）`,
    ``,
    `──────────`,
    `✅ 直していい？ 下のボタン、または返信で`,
    `　GO ／ 修正 ／ 却下`,
    `　（前の提案に答えるときは「GO ${id}」のようにID付きで）`,
    ``,
    stageBar(2), // ②提案（GO待ち）
    `🔎 くわしく ▶ ${notionPageUrl(ticket.pageId)}`,
    `🗂 全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}

// ── 社長案件（escalate）の「具体的な次の一手」生成 ──
// 「社長に相談です」を理由だけで終わらせず、社長が"どうすれば直せるか"を具体的に示す。
// チケットの system / title から指示文の雛形を1行作り、必要なら復旧の暫定手順を添える。

/** reasons の文面から「認証情報の再設定が必要」系かどうかを判定する。 */
function reasonsMentionAuth(reasons: string[]): boolean {
  return reasons.some((r) => /認証|ログイン|トークン|鍵|key|token|secret|credential|連携が切/i.test(r));
}

/**
 * 社長案件の「具体的な次の一手」を組み立てる（LINE表示用・複数行）。
 * - ▶ 直し方：PCのClaude Codeで指示するか、真田へ振る（system/titleから雛形を1行生成）。
 * - ▶ 暫定対応：認証切れ等なら、その復旧の具体手順を1〜2行添える。
 */
export function buildNextStepLines(
  ticket: { system?: string | null; title?: string | null },
  reasons: string[]
): string[] {
  const sys = looksGarbled(ticket.system) ? "該当システム" : truncateForLine(ticket.system || "該当リポ", 20);
  const what = cleanForLine(ticket.title || "この件", 30);
  // PCのClaude Codeへ貼れる指示文の雛形（1行）。
  const order = `「${sys}の『${what}』を直して」`;

  const lines: string[] = [
    `▶ 直し方：PCのClaude Codeで ${order} と指示するか、担当(真田)に振ってください。`,
  ];

  // 認証切れ系なら、復旧の暫定手順を具体的に添える。
  if (reasonsMentionAuth(reasons)) {
    lines.push(
      `▶ 暫定対応：${sys}の認証（ログイン/トークン）が切れています。再ログイン→トークン再発行→env更新で復旧します。`
    );
  }
  return lines;
}

// ── 基盤エラー（インフラ/認証/権限/設定）の判定 ──
// 自動改修の失敗には2種類ある：
//   (a) AI改修そのものの失敗（コードが直せなかった・テストが通らない 等）＝人の助けが要る詰まり。
//   (b) 仕組み側（CI/認証/権限/env）の不調＝真田が裏で直せば再走できる技術障害。
// (b) は社長に「直せませんでした」と出すと誤解を招く（社長の手は要らない）。そこで detail の
// 文言から (b) を検出し、文面を「仕組み側の不調・自動で再挑戦」に切り替え、状態も差し戻さない。
// 判定は保守的に：認証/権限/設定系の確度の高いパターンだけを基盤エラーとみなす。
const INFRA_ERROR_PATTERNS: RegExp[] = [
  /could not read Username/i,
  /could not read Password/i,
  /Authentication failed/i,
  /permission denied/i,
  /Permission to .+ denied/i,
  /not permitted/i,
  /\b403\b/,
  /\b401\b/,
  /Unauthorized/i,
  /Forbidden/i,
  /invalid (?:token|credential|api[\s_-]?key)/i,
  /bad credentials/i,
  /token .*(?:expired|revoked)/i,
  /secret .*(?:not set|missing)/i,
  /env(?:ironment)? .*(?:not set|missing)/i,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|CREDENTIAL)S?\b[^\n]*(?:not set|is missing|missing|undefined)/i,
  /fatal: (?:Authentication|could not read|unable to access)/i,
];

/** detail（実行ワークフローのエラー詳細）が「基盤エラー（認証/権限/設定系）」かどうか。
 * true のとき＝真田が裏で直せる仕組み側の不調。社長に「直せません」と出さず、差し戻さない。 */
export function isInfraError(detail: string | null | undefined): boolean {
  const t = (detail || "").trim();
  if (!t) return false;
  return INFRA_ERROR_PATTERNS.some((re) => re.test(t));
}

/** 基盤エラー時の文面（社長に「自動で再挑戦します・社長の手は不要」を伝える）。 */
export function buildInfraNoticeText(
  ticket: { ticketId?: string | null; system?: string | null; title?: string | null }
): string {
  return [
    msgHead("⚙️", "仕組み側の不調です", ticket.system, ticket.title),
    `（${ticket.ticketId || "KZ-?"}）この件は、いまカイゼンくんの仕組み側（連携/権限/設定）が`,
    `一時的に不調で自動改修まで進めませんでした。`,
    `真田が対処します。直りしだい自動でもう一度挑戦するので、社長の操作は不要です。`,
    ``,
    stageBar(4), // ④着手（仕組み側の不調で一時停止）
    `全体像 ▶ ${BOARD_URL}`,
  ].join("\n");
}

/** GO待ちチケットの提案を高木さん宛にpushする。GO/修正/却下のquick reply付き。
 * 送信成功時は応答の sentMessages[].id を「引用返信→チケット」対応として記録する
 * （社長がこの提案を引用返信で操作できるように）。 */
export async function pushProposal(ticket: TicketRow, d: DiscussResult): Promise<boolean> {
  if (!lineEnabled()) return false;
  const res = await postLine(LINE_PUSH_ENDPOINT, {
    to: targetUserId(),
    messages: [
      {
        type: "text",
        text: buildProposalText(ticket, d),
        quickReply: goQuickReply(ticket.pageId),
      },
    ],
  });
  if (!res) return false;
  const sent = Array.isArray(res?.sentMessages) ? res.sentMessages : [];
  for (const m of sent) {
    if (m?.id) recordSentMessage(String(m.id), ticket.ticketId);
  }
  return true;
}
