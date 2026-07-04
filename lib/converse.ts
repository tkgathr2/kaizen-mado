// ── 社長 ⇄ AI の双方向LINE会話エンジン ──
// webhook が「GO/修正/却下」コマンドでない自由文を受けたとき、ここが会話で答える。
// 役割は3つ：①意図判定（状況質問 / 要望 / 既存案件への指示）②参照解決（どのチケットの話か）
// ③要望なら改善チケット（受付）を自動作成。実改修・対人送信・課金には絶対つながない。
//
// 安全方針（fail-safe）：
//  - ANTHROPIC/Notion 鍵が無くても壊れない。会話生成は鍵があるときだけ。無ければ定型文で返す。
//  - 例外は内部で握り、必ず「社長に見せる返事の文字列」を返す（ホストの webhook を壊さない）。
//  - 自由文→チケットは必ず「受付」止まり。その先は既存ループが安全に処理する。
import type { TicketRow } from "./tickets";
import type { Ticket, TicketType, Importance } from "./types";
import { normalizeSystemForTicket, SYSTEMS } from "./systems";
import {
  recordLearning,
  recallLearning,
  type LearningEvent,
  type LearningKind,
  type MemoryHit,
} from "./memory";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// ── 意図の種類 ──
// status   = 状況質問（今どう？／詰まってるのある？） → チケット状況から会話で答える
// request  = 要望（○○を直して／△△を改善して） → 改善チケット（受付）を自動作成
// command  = 既存案件への指示（さっきのGO／ステレポのやつ却下） → 参照解決して applyGoAction
// question = 質問（○○ってどうやるの？何ですか？） → 会話で答える（チケット化しない）
// fragment = 断片・文脈不足（「あれ？」「何これ？」） → 聞き返してからチケット化
// chat     = それ以外の雑談・あいさつ → 会話で軽く返す（チケットは作らない）
export type Intent = "status" | "request" | "command" | "question" | "fragment" | "chat";
export type RefAction = "go" | "fix" | "reject";

export interface IntentResult {
  intent: Intent;
  /** command のときの操作（go/fix/reject）。 */
  refAction?: RefAction;
  /** 文面から拾えたチケットID（KZ-5 等）。無ければ null。 */
  ticketId: string | null;
  /** request のときに抽出した要望（チケット化に使う）。 */
  request?: {
    system: string | null;
    title: string;
    detail: string;
    type: TicketType;
    importance: Importance;
  };
}

// ── 軽量・決定論的な前さばき（LLMを呼ぶ前のルールベース判定） ──
// 鍵が無くても最低限の意図判定が効くように、まず正規表現で粗く振り分ける。
// ここで command/ID が確定すれば LLM を呼ばずに済み、速くて安い。

const RE_TICKET_ID = /\b(KZ[-－]?\s?\d+)\b/i;
// 既存案件への指示（GO/修正/却下を含む文）。「さっきのGO」「ステレポのやつ却下」等。
const RE_GO = /(承認|ゴー|ごー|go\b|オーケー|オッケー|okです|ok\b|進めて|やって(いい|ください|くれ)|着手して)/i;
const RE_REJECT = /(却下|やめ(て|よう|とこ)|中止|なし(で|に)|見送|ボツ|いらない)/;
const RE_FIX = /(修正(して)?|なおして|直して|やり直し|やりなおし|作り直|変えて|変更して)/;
// 「さっき／前／それ」などの参照語、または明示IDがあれば「既存案件への指示」寄り。
// 「〜のやつ／〜の件」は既存の何かを指す言い回しなので参照語に含める
// （例：「ステレポのやつ却下」「あの件GO」）。具体的な不具合描写を伴う新規要望
//  （「ステレポの一覧が重いので直して」）とは「やつ/件」の有無で見分ける。
const RE_REFERENCE = /(さっき|先(ほど|程)|前の|あの|その|それ|これ|この件|例の|今の|のやつ|の件)/;

// 状況質問（疑問・確認）。「今どう？」「詰まってる？」「どこまで進んだ？」等。
// 注意：「教えて」は RE_QUESTION と重複するためここには入れない（status/question の誤分類を防ぐ）。
// 口語の「どう？」「どうなの」もカバーする。
const RE_STATUS = /(どう(なって|です|なの|\?|？)|どうなっ|進捗|状況|どこまで|詰まって|止まって|残って|今どう|いまどう|何が(ある|残)|ある\?|ありますか|一覧|リスト|まとめて)/;

// 要望（命令・依頼）。「○○を直して/改善して/欲しい/作って/追加して」等。
const RE_REQUEST = /(改善して|直して|なおして|修正して|欲しい|ほしい|作って|つくって|追加して|つけて|付けて|できるように|したい|して(ほしい|欲しい)|不便|使いにくい|わかりにくい|分かりにくい|遅い|重い|バグ|エラー|落ちる|おかしい)/;

const RE_BUG = /(バグ|エラー|落ちる|動かない|おかしい|壊れて|不具合|表示されない|消えた|二重)/;
const RE_NEW = /(新(しく|機能)|追加して|つけて|付けて|作って|つくって|できるように)/;
const RE_HIGH = /(至急|急ぎ|今すぐ|大至急|止まって|使えない|全員|困って|やばい|重大|致命)/;
const RE_LOW = /(いつか|余裕(が)?あれば|そのうち|できれば|気になる程度|細かい|ちょっとした)/;

// 質問（情報質問・確認）。「何ですか」「なぜ」「どうやって」等。要望（〜してほしい）とは異なる。
const RE_QUESTION = /(何(です|か|ですか)|なぜ|どうして|どうやって|やり方|方法|どこ|誰|いつ|説明|教えて|参考|例|サンプル|テンプレート|使い方|設定方法|仕様|スペック)/i;

// 断片（短い・不完全・文脈不足）。「あれ？」「これ？」「何これ？」等。
const RE_FRAGMENT = /^(あ(れ|の)?|こ(れ|の)?|そ(れ|の)?|何|え|へ|ん|えっ|は|ぁ|あ\?|これ\?|何これ|何この|ど(ういう|うなって))(\?|？|$)/;

/** 文面からチケットID（KZ-5 等）を1つ抜く。表記ゆれ（KZ5 / KZ－5 / KZ 5）を正規化。無ければ null。 */
export function extractTicketId(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(RE_TICKET_ID);
  if (!m) return null;
  return m[1]
    .toUpperCase()
    .replace(/[－\s]/g, "-")
    .replace(/^KZ(\d)/, "KZ-$1")
    .replace(/-+/, "-");
}

/** 文面から「対象システム名」を推定する。SYSTEMS の正式名・slug・別名で部分一致。無ければ null。 */
export function guessSystem(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const s of SYSTEMS) {
    if (s.name === "その他") continue;
    if (t.includes(s.name.toLowerCase())) return s.name;
    if (t.includes(s.slug.toLowerCase())) return s.name;
  }
  // よくある略称・ひらがな表記の別名。
  const aliases: { re: RegExp; name: string }[] = [
    { re: /(ステ\s?レポ|sterepo)/i, name: "ステレポ" },
    { re: /(プロ\s?レポ|prorepo)/i, name: "プロレポ" },
    { re: /(ほうこ|報告書くん)/, name: "ほうこちゃん" },
    { re: /(カイゼン|改善くん|かいぜん)/, name: "カイゼンくん本体" },
    { re: /(かいた|物品)/, name: "かいたくん（物品購入）" },
    { re: /(キャスト名簿|名簿くん)/, name: "キャスト名簿くん" },
    { re: /(らくらく|契約くん)/, name: "らくらく契約くん" },
    { re: /(見積)/, name: "見積もりシステム" },
    { re: /(巡回)/, name: "巡回くん" },
    { re: /(まもる)/, name: "まもるくん" },
    { re: /(採用管理)/, name: "採用管理システム" },
  ];
  for (const a of aliases) {
    if (a.re.test(text)) return a.name;
  }
  return null;
}

/** 文面から種別を推定（bug / 新機能 / 改善）。 */
export function guessType(text: string | null | undefined): TicketType {
  const t = text || "";
  if (RE_BUG.test(t)) return "bug";
  if (RE_NEW.test(t)) return "新機能";
  return "改善";
}

/** 文面から重要度を推定（高 / 中 / 低）。明示の緊急語があれば高、控えめ語があれば低、既定は中。 */
export function guessImportance(text: string | null | undefined): Importance {
  const t = text || "";
  if (RE_HIGH.test(t)) return "高";
  if (RE_LOW.test(t)) return "低";
  return "中";
}

/** 自由文から短い件名を作る（先頭の要点だけ。句読点・改行で切る）。 */
export function makeTitle(text: string | null | undefined): string {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return "改善のご要望";
  // 最初の文（。！？\n まで）を件名候補に。なければ全体。
  const firstSentence = t.split(/[。．！!？?\n]/)[0].trim() || t;
  return firstSentence.slice(0, 40);
}

/**
 * ルールベースの意図判定（LLM不要・決定論）。
 * 鍵が無くても効く一次判定。優先順位は：
 *  1) GO/修正/却下 の動詞 ＋（ID or 参照語）＝ command（既存案件への指示）
 *  2) 短い・不完全＝ fragment（聞き返してからチケット化）
 *  3) 状況質問の語 ＝ status
 *  4) 情報質問の語 ＝ question（要望ではなく質問）
 *  5) 要望の語 ＝ request
 *  6) それ以外 ＝ chat
 */
export function classifyIntent(text: string | null | undefined): IntentResult {
  const t = (text || "").trim();
  const ticketId = extractTicketId(t);

  // ── 1) 既存案件への指示（command） ──
  // GO/修正/却下 の動詞があり、かつ「ID or 参照語」で既存の何かを指していると分かる場合。
  const hasRef = ticketId !== null || RE_REFERENCE.test(t);
  if (RE_REJECT.test(t) && hasRef) {
    return { intent: "command", refAction: "reject", ticketId };
  }
  // 「修正して」は要望(request)とも取れるが、ID/参照語があれば既存案件への修正指示とみなす。
  if (RE_FIX.test(t) && hasRef) {
    return { intent: "command", refAction: "fix", ticketId };
  }
  if (RE_GO.test(t) && hasRef) {
    return { intent: "command", refAction: "go", ticketId };
  }
  // ID だけ来て動詞が無いとき：既存案件に触れているが操作不明 → command(go扱いにはしない)。
  // 安全側で status（その件どうなってる？）として状況を返す。
  if (ticketId && RE_STATUS.test(t)) {
    return { intent: "status", ticketId };
  }

  // ── 2) 断片・文脈不足（fragment） ──
  // 短い・「あれ？」「何これ？」など不完全な文 → 聞き返してからチケット化
  if (RE_FRAGMENT.test(t)) {
    return { intent: "fragment", ticketId };
  }

  // ── 3) 状況質問（status） ──
  if (RE_STATUS.test(t) && !RE_REQUEST.test(t)) {
    return { intent: "status", ticketId };
  }

  // ── 4) 情報質問（question） ──
  // 「何ですか」「どうやって」など、要望ではなく情報を求めている。チケット化しない。
  if (RE_QUESTION.test(t) && !RE_REQUEST.test(t)) {
    return { intent: "question", ticketId };
  }

  // ── 5) 要望（request） ──
  if (RE_REQUEST.test(t)) {
    return {
      intent: "request",
      ticketId: null,
      request: {
        system: guessSystem(t),
        title: makeTitle(t),
        detail: t.slice(0, 1800),
        type: guessType(t),
        importance: guessImportance(t),
      },
    };
  }

  // ── 6) それ以外＝雑談 ──
  return { intent: "chat", ticketId };
}

// ── 参照解決（複数LINEが来た時、前のチケットに返せる） ──
// 優先順位：① ID 一致 → ② quotedMessageId（送信履歴との対応）→ ③ 自然文（システム名／直近）

export interface ResolveContext {
  /** 現在GO待ち（社長の判断待ち）のチケット。新しい順。 */
  goMachi: TicketRow[];
  /** 直近に動いた（最近更新の）チケット。新しい順。 */
  recent: TicketRow[];
  /** quotedMessageId → ticketId の対応（送信履歴。無ければ空）。 */
  quotedMap?: Record<string, string>;
}

export interface ResolveResult {
  ticket: TicketRow | null;
  /** 1件に絞れず確認が要るとき、候補（最尤1件）を入れる。 */
  ambiguous?: TicketRow | null;
  /** どの手段で解決したか（デバッグ・説明用）。 */
  via: "id" | "quoted" | "system" | "single" | "none";
}

/** ID/quoted/自然文 でチケットを特定する純粋ロジック（Notion読取は呼び出し側で済ませて rows を渡す）。
 * @param text      社長のメッセージ全文（システム名の自然文照合に使う）
 * @param ticketId  事前に extractTicketId で拾ったID（あれば最優先）
 * @param ctx       解決に使う文脈（GO待ち・直近・引用マップ）
 * @param quotedMessageId LINE webhook の message.quotedMessageId（あれば②で使う）
 */
export function resolveTicket(
  text: string | null | undefined,
  ticketId: string | null,
  ctx: ResolveContext,
  quotedMessageId?: string | null
): ResolveResult {
  const pool = dedupRows([...(ctx.goMachi || []), ...(ctx.recent || [])]);

  // ① ID 一致（最優先・曖昧さゼロ）
  if (ticketId) {
    const norm = normalizeTicketId(ticketId);
    const hit = pool.find((r) => normalizeTicketId(r.ticketId) === norm);
    if (hit) return { ticket: hit, via: "id" };
  }

  // ② 引用返信（quotedMessageId → ticketId）。送信履歴の対応が残っていれば確実に当たる。
  if (quotedMessageId && ctx.quotedMap && ctx.quotedMap[quotedMessageId]) {
    const qid = normalizeTicketId(ctx.quotedMap[quotedMessageId]);
    const hit = pool.find((r) => normalizeTicketId(r.ticketId) === qid);
    if (hit) return { ticket: hit, via: "quoted" };
  }

  // ③ 自然文：システム名で絞る（「ステレポのやつ」）。
  const sys = guessSystem(text);
  if (sys) {
    const matches = pool.filter((r) => r.system === sys);
    if (matches.length === 1) return { ticket: matches[0], via: "system" };
    if (matches.length > 1) {
      // 同じシステムで複数 → 最尤（先頭＝より新しい/GO待ち優先）を確認候補にする。
      return { ticket: null, ambiguous: matches[0], via: "system" };
    }
  }

  // ④ 自然文：「さっき/前の/それ」など参照語のみ。GO待ちが1件ならそれ、複数なら確認。
  if (RE_REFERENCE.test((text || "").trim())) {
    const go = ctx.goMachi || [];
    if (go.length === 1) return { ticket: go[0], via: "single" };
    if (go.length > 1) return { ticket: null, ambiguous: go[0], via: "single" };
    // GO待ちが無ければ直近1件で代替。
    if ((ctx.recent || []).length >= 1) {
      return { ticket: null, ambiguous: ctx.recent[0], via: "single" };
    }
  }

  return { ticket: null, via: "none" };
}

function normalizeTicketId(id: string): string {
  return (id || "").toUpperCase().replace(/[\s－]/g, "-").replace(/^KZ(\d)/, "KZ-$1");
}

/** pageId で重複を除いて順序を保つ。 */
function dedupRows(rows: TicketRow[]): TicketRow[] {
  const seen = new Set<string>();
  const out: TicketRow[] = [];
  for (const r of rows) {
    if (!r?.pageId || seen.has(r.pageId)) continue;
    seen.add(r.pageId);
    out.push(r);
  }
  return out;
}

// ── IntentResult.request → Ticket（起票用）への変換（純関数） ──
/** 要望から起票用の Ticket を組み立てる（normalizeSystemForTicket で select 安全値に丸める）。 */
export function requestToTicket(req: NonNullable<IntentResult["request"]>): Ticket {
  return {
    system: normalizeSystemForTicket(req.system),
    type: req.type,
    title: (req.title || "改善のご要望").slice(0, 100),
    detail: (req.detail || "").slice(0, 1800),
    importance: req.importance,
  };
}

// ── 状況サマリの文章化（純関数・LLM不要のフォールバック兼ベース） ──
/** GO待ち・直近チケットから「今の状況」を社長向けの短い日本語にまとめる。 */
export function summarizeStatus(ctx: ResolveContext): string {
  const go = ctx.goMachi || [];
  const recent = (ctx.recent || []).filter((r) => !go.some((g) => g.pageId === r.pageId));
  const lines: string[] = [];

  if (go.length > 0) {
    lines.push(`✋ GO待ち（社長の判断待ち）が${go.length}件：`);
    for (const t of go.slice(0, 5)) {
      lines.push(`・${t.ticketId} ${t.system}「${truncate(t.title, 24)}」`);
    }
  } else {
    lines.push("✋ GO待ち（社長の判断待ち）はありません。");
  }

  if (recent.length > 0) {
    lines.push("");
    lines.push("🔧 最近動いた案件：");
    for (const t of recent.slice(0, 4)) {
      lines.push(`・${t.ticketId} [${t.state}] ${t.system}「${truncate(t.title, 20)}」`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string | null | undefined, max: number): string {
  const t = (s || "").trim().replace(/\s+/g, " ");
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + "…";
}

// ── Claude 呼び出し（会話の返事を生成。鍵が無ければ呼ばない＝呼び出し側で分岐） ──
/** Claude が使えるか（ANTHROPIC_API_KEY があるか）。 */
export function converseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const CONVERSE_SYSTEM =
  "あなたは高木産業グループの開発窓口『カイゼンくん』のアシスタント。" +
  "社長とLINEで会話する。返事は短く（2〜4文）、敬語、専門用語を避けてやさしく。" +
  "今の状況（GO待ち・最近の案件）を渡されたら、それに基づいて事実だけ答える。" +
  "勝手に約束しない・送信や課金には触れない。要望は『チケットにして順番に進めます』と受ける。";

/** recall で引いた過去の学びを、返答生成プロンプトに添える短い文脈に整形する。
 *  ヒット0件なら空文字（プロンプトに足さない＝素通し）。社長の好み・過去の判断を踏まえて答える土台。 */
export function formatLearningContext(hits: MemoryHit[] | null | undefined): string {
  if (!hits || hits.length === 0) return "";
  const lines = hits
    .map((h) => (h?.content || "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => `・${truncate(c, 160)}`);
  return lines.length ? lines.join("\n") : "";
}

/** generateReply に渡す過去の会話ターン（最大件数は呼び出し側で制限）。 */
export interface ConverseTurn {
  userText: string;
  assistantText: string;
}

/**
 * 会話の返事を Claude（claude-sonnet-4-6）で生成する。
 * @param userText 社長のメッセージ
 * @param contextNote 「今の状況」テキスト（summarizeStatus 等）
 * @param hint この返事の趣旨（status/request/command の補足。プロンプトに添える）
 * @param learningNote 過去の学び（recall）を整形した文脈。あれば社長の好み・前例を踏まえて答える。
 * @param history 直近の会話ターン（古い順）。渡すと文脈を覚えた返事になる。
 * 失敗・キー未設定時は null を返す（呼び出し側がフォールバック文を使う）。
 */
export async function generateReply(
  userText: string,
  contextNote: string,
  hint?: string,
  learningNote?: string,
  history?: ConverseTurn[]
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const sys =
    CONVERSE_SYSTEM +
    (contextNote ? `\n\n【今の状況】\n${contextNote}` : "") +
    (learningNote
      ? `\n\n【過去の学び・社長の好み（参考）】\n${learningNote}`
      : "") +
    (hint ? `\n\n【この返事の趣旨】${hint}` : "");

  const historyMessages: { role: "user" | "assistant"; content: string }[] = [];
  if (history && history.length > 0) {
    for (const turn of history.slice(-6)) {
      if (turn.userText.trim()) {
        historyMessages.push({ role: "user", content: turn.userText.slice(0, 2000) });
      }
      if (turn.assistantText.trim()) {
        historyMessages.push({ role: "assistant", content: turn.assistantText.slice(0, 2000) });
      }
    }
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: sys,
        messages: [
          ...historyMessages,
          { role: "user", content: userText.slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = Array.isArray(data?.content)
      ? data.content
          .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
          .map((b: any) => b.text)
          .join("")
          .trim()
      : "";
    return text || null;
  } catch {
    return null;
  }
}

// ── 全体学習の配線（会話エンジン側のフック） ──
// 社長との会話・判断を「同じ1つの記憶」へ流し込み、会話の返答前にその記憶を引く。
// すべて fail-safe：memory層は元々 no-op 安全だが、ここでも例外を握り会話/リクエストを絶対止めない。

/**
 * 会話の返答を作る前に、社長の発言で過去の学び（社長の好み・前例）を引く。
 * - 鍵が無い／0件なら [] を返し、呼び出し側は素通しでよい（recallLearning が fail-safe）。
 * - 例外は握って [] を返す（会話を止めない）。
 */
export async function recallForReply(
  userText: string,
  topK = 3
): Promise<MemoryHit[]> {
  try {
    return await recallLearning(userText, { topK });
  } catch {
    return [];
  }
}

/**
 * 社長との会話1ターンを全体学習に記録する（kind:"conversation"）。
 * 非ブロッキング：await してもしなくてもよいよう、例外は内部で握って boolean を返す。
 * 記録の失敗で社長への返信が遅れ/壊れないこと（呼び出し側は void で投げてよい）。
 * @param userText 社長の発言（summary に要約として入る）
 * @param replyText AIの返答（detail に文脈として入る）
 * @param system 関係するシステム（任意・分かれば）
 */
export async function recordConversationTurn(
  userText: string,
  replyText: string,
  system?: string | null
): Promise<boolean> {
  const summary = (userText || "").trim().slice(0, 200);
  if (!summary) return false;
  const event: LearningEvent = {
    kind: "conversation",
    summary,
    detail: (replyText || "").trim().slice(0, 800) || undefined,
    system: system || undefined,
  };
  try {
    return await recordLearning(event);
  } catch {
    return false;
  }
}

/**
 * 社長の判断（GO/却下/修正）を教師信号として全体学習に記録する。
 * - go/reject ＝ kind:"decision"（なぜ進めた/見送ったか）
 * - fix（「違う」「直して」系の軌道修正）＝ kind:"correction"（status=failed＝しくじり先生）
 * 非ブロッキング・fail-safe（例外を握って boolean）。
 * @param action 適用された操作（go/fix/reject）
 * @param ticket 対象チケット（system/title を文脈として残す）
 * @param note   社長が添えた本文（修正指示など。任意）
 */
export async function recordDecisionTurn(
  action: RefAction,
  ticket: Pick<TicketRow, "ticketId" | "system" | "title">,
  note?: string | null
): Promise<boolean> {
  const kind: LearningKind = action === "fix" ? "correction" : "decision";
  const verb = action === "go" ? "GO（承認）" : action === "reject" ? "却下" : "修正指示";
  const summary = `${verb}: ${ticket.system}「${truncate(ticket.title, 40)}」(${ticket.ticketId})`;
  const detailParts: string[] = [];
  if (note && note.trim()) detailParts.push(`社長の言葉: ${note.trim().slice(0, 600)}`);
  const event: LearningEvent = {
    kind,
    summary,
    detail: detailParts.length ? detailParts.join("\n") : undefined,
    system: ticket.system || undefined,
  };
  try {
    return await recordLearning(event);
  } catch {
    return false;
  }
}
