// ── スコープ限定・読み取り専用の Slack リーダー（カイゼン窓口の原因調査用） ──
//
// カイゼン窓口の利用者が「○○ボットがエラー。Slackを見て」と言ったとき、AIが
// 該当システムの"許可された"チャンネルだけを読んで原因を診断できるようにする。
//
// SECURITY（公開・無認証の窓口である前提で多層防御）：
//  1) モデルにチャンネルを選ばせない。窓口の対象システムに紐づく許可リスト
//     （lib/slackChannels.ts）のチャンネルだけを読む（WHERE は固定・WHEN だけAI判断）。
//  2) 読み取り専用（conversations.history のみ）。投稿・変更・削除は一切しない。
//  3) 直近 N 件（上限あり）だけ。全文ダンプしない。
//  4) PII マスク（lib/pii.ts）を必ず通してからモデルに渡す＝氏名/電話/住所等を出さない。
//  5) SLACK_BOT_TOKEN 未設定なら完全無効＝今までどおりの挙動（安全側の既定）。
//
// 成長エンジン連動について：
//  Slack起点チケットの「記憶（memorize）」と「想起（recall）」は、このファイルに
//  独自実装を持たない。統一メモリ層（lib/memory.ts）＋完了還元（lib/learn.ts）に一本化する
//  （別 project_key の孤立サイロを作らない・PIIマスクとKNOWHOW_ENABLEDゲートを継承する）。
import { maskPII } from "./pii";
import { channelsForSystem } from "./slackChannels";
import { knownSlackUserName } from "./slackUsers";

const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";
/** users.info のタイムアウト（GO伺い送信を長く待たせない）。 */
const SLACK_USER_INFO_TIMEOUT_MS = 4000;
/** 1チャンネルあたりの最大取得件数（コスト・情報量の上限）。 */
const MAX_MESSAGES = 15;
/** 1メッセージあたりの最大文字数（マスク後にさらに切り詰める）。 */
const MAX_MESSAGE_CHARS = 600;
/** 1回の read_slack で読むチャンネル数の上限（許可リストが複数でも暴走させない）。 */
const MAX_CHANNELS = 2;
/** Slack API のタイムアウト（監視同様、短く）。 */
const SLACK_TIMEOUT_MS = 5000;
/** 投稿APIのタイムアウト。 */
const SLACK_POST_TIMEOUT_MS = 8000;

// ── 公開窓口へ晒す前の二重の絞り込み（PII漏えい対策・セキュリティレビュー HIGH 対応） ──
//
// この窓口は無認証・公開。?sys= は利用者が選べるため、許可チャンネルは「匿名に見られても
// 安全な内容」に絞らねばならない。応募通知チャンネルは本来"応募者の氏名"を含むので、
//  (a) 正のフィルタ：診断（エラー調査）に関係する行だけを通す＝応募者通知を構造的に落とす。
//  (b) 氏名マスク：それでも残った敬称付きの氏名を最後の砦として伏字化する。
// 機能の目的は「ボットのエラー診断」であり応募内容の閲覧ではない、という用途にも一致する。

/** 診断（エラー調査）に関係しそうな行か。ここに該当しない行（応募者通知等）は落とす。 */
const DIAGNOSTIC_RE =
  /error|exception|fail|refused|timeout|timed out|traceback|stack|throw|crash|disconnect|reconnect|retry|warn|fatal|panic|null|undefined|\b[45]\d\d\b|エラー|失敗|落ち|停止|例外|タイムアウト|つながらない|動かない|不具合|警告|異常/i;

export function looksDiagnostic(text: string): boolean {
  return DIAGNOSTIC_RE.test(text);
}

/** 敬称付きの氏名を伏字化する（お客様・皆様等を巻き込んでも無害＝安全側）。 */
const NAME_HONORIFIC_RE =
  /[一-鿿゠-ヿｦ-ﾟA-Za-z][一-鿿゠-ヿ぀-ゟｦ-ﾟA-Za-z・\s]{0,18}?(さん|様|氏|くん|ちゃん|殿)/g;

/** 公開窓口へ出す前の最終サニタイズ：PIIマスク（電話/メール等）＋氏名マスク。 */
export function sanitizeSlackText(text: string): string {
  return maskPII(text).replace(NAME_HONORIFIC_RE, "[氏名]");
}

/** Slack 連携が有効か（トークンが設定されているか）。未設定なら機能ごとOFF。 */
export function slackEnabled(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN.trim());
}

/**
 * この対象システムの窓口で「Slackを読む」機能が使えるか。
 * トークンがあり、かつ許可チャンネルが1つ以上設定されているときだけ true。
 */
export function slackAvailableForSystem(system: string | null | undefined): boolean {
  return slackEnabled() && channelsForSystem(system).length > 0;
}

/** read_slack の結果（モデルに渡す形）。 */
export interface SlackReadResult {
  /** 読んだチャンネルごとの結果。 */
  channels: Array<{ label: string; messages: string[]; error?: string }>;
}

/** 取得件数を安全な範囲に丸める。 */
function clampLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return MAX_MESSAGES;
  return Math.min(n, MAX_MESSAGES);
}

/** 1チャンネルの履歴を読み、PIIマスク済みのテキスト配列にして返す（読み取り専用）。 */
async function readOneChannel(
  token: string,
  channelId: string,
  limit: number
): Promise<{ messages: string[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const url = `${SLACK_HISTORY_URL}?channel=${encodeURIComponent(channelId)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      return { messages: [], error: `slack: ${data?.error || `http ${res.status}`}` };
    }
    const raw = Array.isArray(data.messages) ? data.messages : [];
    const messages = raw
      .map((m: any) => (typeof m?.text === "string" ? m.text : ""))
      .filter((t: string) => t.trim().length > 0)
      // (a) 正のフィルタ：診断に関係する行だけ通す＝応募者通知等のPIIを構造的に落とす。
      .filter((t: string) => looksDiagnostic(t))
      // (b) サニタイズ（PII＋氏名マスク）→ さらに長文を切り詰める（マスクしてから切る）。
      .map((t: string) => sanitizeSlackText(t).slice(0, MAX_MESSAGE_CHARS));
    return { messages };
  } catch (err) {
    return { messages: [], error: `slack: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 対象システムの「許可されたチャンネルだけ」を読む。
 * - モデルは channel を指定できない（WHERE は許可リストで固定）。
 * - トークン/許可リストが無ければ空（=読めない）。
 */
export async function readSlackForSystem(
  system: string | null | undefined,
  limit?: number
): Promise<SlackReadResult> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return { channels: [] };

  const refs = channelsForSystem(system).slice(0, MAX_CHANNELS);
  if (refs.length === 0) return { channels: [] };

  const n = clampLimit(limit);
  const channels = await Promise.all(
    refs.map(async (ref) => {
      const r = await readOneChannel(token, ref.channelId, n);
      return { label: ref.label, messages: r.messages, error: r.error };
    })
  );
  return { channels };
}

/** 起票者文字列からSlackユーザーIDを抜く（Notion往復で付きうる \ エスケープも許容）。 */
function slackMentionUserId(reporter: string | null | undefined): string | null {
  const raw = (reporter || "").trim().replace(/\\/g, "");
  const m = raw.match(/^Slack:<@([A-Z0-9]+)>$/i);
  return m ? m[1] : null;
}

/**
 * 起票者フィールド（例: "Slack:<@U0AR8F63YBA>"）を人間が読める表示名へ解決する。
 * 社長要望「誰から来たか分かるようにしてほしい」対応（2026-07-08）。
 * - 既にメール/氏名等の読める形式ならそのまま返す（Slackメンション形式のときだけAPIを叩く）。
 * - APIが使えない（トークン未設定・users:read不足・失敗・タイムアウト）ときは
 *   既知ユーザー対応表（lib/slackUsers.ts）で解決する。それでも不明なら元の文字列に
 *   フォールバック（GO伺い送信をユーザー名解決の失敗で止めない・fail-safe）。
 */
export async function resolveReporterDisplay(
  reporter: string | null | undefined
): Promise<string> {
  const raw = (reporter || "").trim();
  if (!raw) return "不明";
  const userId = slackMentionUserId(raw);
  if (!userId) return raw;

  const fallback = knownSlackUserName(userId) ?? raw;
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_USER_INFO_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: controller.signal }
    );
    const data = await res.json().catch(() => null);
    if (!data?.ok || !data.user) return fallback;
    const name = data.user.profile?.real_name || data.user.real_name || data.user.name;
    return name ? String(name) : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 表示直前の最終ガード（同期・API不要）：解決しきれなかった生のSlackメンションを、
 * IDのまま社長に見せず「読める表記」へ置き換える（社長指示 2026-07-09「SlackのIDではなくて」）。
 * 既知ユーザーなら名前、未知なら「Slackの方（お名前未登録）」。通常の氏名等はそのまま。
 */
export function readableReporter(reporter: string | null | undefined): string {
  const raw = (reporter || "").trim();
  if (!raw) return "不明";
  const userId = slackMentionUserId(raw);
  if (!userId) return raw;
  return knownSlackUserName(userId) ?? "Slackの方（お名前未登録）";
}

/**
 * Slack のスレッドにメッセージを投稿する（完了通知・受け付け確認用）。
 * chat:write スコープが SLACK_BOT_TOKEN に付与されている場合のみ動作する。
 * 失敗しても例外を投げない（投稿失敗でカイゼンフローを止めない・fail-safe）。
 */
export async function postToSlack(
  channelId: string,
  threadTs: string,
  text: string
): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: channelId,
        thread_ts: threadTs,
        text,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      console.warn("[slack] postToSlack failed:", data?.error ?? `http ${res.status}`);
    }
    return Boolean(data?.ok);
  } catch (err) {
    console.warn("[slack] postToSlack error:", (err as Error).message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
