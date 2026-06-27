// ── Anthropic API 呼び出し（サーバ側のみ。キーはクライアントへ出さない） ──
// LLMのフリーテキストJSONをパースすると壊れやすいため、tool use（構造化出力）を
// 強制して、モデルには検証済みのオブジェクトを直接返させる。文字列パースに依存しない。
import type { TurnResult, Ticket, Phase, TicketType, Importance, Priority } from "./types";
import { readSlackForSystem } from "./slack";
import { clampScore, computePriority, isPriority } from "./priority";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Anthropic への1リクエストあたりのタイムアウト（ミリ秒）。
// 公開・無認証窓口なので、無タイムアウトだとクライアント切断後もツールループが
// 全反復走り続け、課金とコネクションが浪費される（DoS）。
const FETCH_TIMEOUT_MS = 20_000;

/**
 * タイムアウトと「呼び出し側の AbortSignal（クライアント切断）」を1つに束ねた signal を作る。
 * - タイムアウト発火：AbortSignal.timeout が abort。
 * - クライアント切断：req.signal（あれば）が abort。
 * どちらかが abort したら fetch を中断し、ツールループも止める。
 * AbortSignal.any が無い古いランタイム向けに手動 fallback も用意（degrade-safe）。
 */
function buildFetchSignal(upstream?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (!upstream) return timeout;
  // 標準（Node18.17+/最近のブラウザ）：複数 signal を束ねる。
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([upstream, timeout]) as AbortSignal;
  }
  // fallback：手動で両方を監視して中継する。
  const controller = new AbortController();
  const onAbort = (reason: unknown) => controller.abort(reason);
  if (upstream.aborted) controller.abort((upstream as any).reason);
  else upstream.addEventListener("abort", () => onAbort((upstream as any).reason), { once: true });
  if (timeout.aborted) controller.abort((timeout as any).reason);
  else timeout.addEventListener("abort", () => onAbort((timeout as any).reason), { once: true });
  return controller.signal;
}

// content は文字列、または text/image ブロックの配列（マルチモーダル時）。
// Phase 2/3：user ターンが画像を持つときだけブロック配列になる（lib/prompt.ts が組む）。
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

// read_slack を何回まで許すか（コスト・レイテンシの上限。少なめでよい）。
const MAX_SLACK_ITERS = 2;

// 対象システムの“許可された”Slackチャンネルを読むツール。
// チャンネルは指定できない（WHERE は許可リストで固定・WHEN だけモデルが判断）。
const READ_SLACK_TOOL = {
  name: "read_slack",
  description:
    "対象システムの“許可された”Slackチャンネルの直近メッセージを読み、エラーの原因調査に使う（読み取り専用）。" +
    "チャンネルは指定できない（窓口の対象システムに紐づく安全なチャンネルだけが自動で読まれる）。" +
    "利用者が『Slackを見て／読み込んで』『○○がエラー』等と言い、原因究明に役立つときだけ呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "読むメッセージ件数（省略可。多くても15件まで）",
      },
    },
  },
} as const;

// モデルに必ず呼ばせるツール。input がそのまま TurnResult になる。
const TURN_TOOL = {
  name: "record_turn",
  description:
    "今回のターンの応答を記録する。reply は利用者に見せる文章。phase が confirm のときは ticket を必ず埋める。",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "利用者に見せる返答（地の文で2〜4文）" },
      phase: {
        type: "string",
        enum: ["clarify", "confirm"],
        description: "深掘り中なら clarify、要約確認に進むなら confirm",
      },
      ticket: {
        type: ["object", "null"],
        description: "confirm のときのみ必須。clarify のときは null。",
        properties: {
          system: { type: "string" },
          type: { type: "string", enum: ["bug", "改善", "新機能"] },
          title: { type: "string", description: "短い件名（30字程度）" },
          detail: { type: "string", description: "背景・困りごと・要望を3〜6文で" },
          importance: { type: "string", enum: ["高", "中", "低"] },
          // ── 優先度スコアリング（§4.5.1・ユーザーには優先度を聞かず本人が算出）──
          urgency: {
            type: "number",
            description:
              "緊急度 1〜10。9-10=今まさに業務が止まる／5-6=たまに困る・回避策あり／1-2=気になる程度。会話内容から判定。",
          },
          importanceScore: {
            type: "number",
            description:
              "重要度 1〜10。9-10=売上・採用・法令・安全に直結／多人数が毎日使う／5-6=一部業務に影響／1-2=あれば嬉しい。会話内容から判定。",
          },
          priority: {
            type: "string",
            enum: ["高", "中", "低"],
            description:
              "優先度。高=緊急度か重要度が8以上かつ合計14以上／中=合計8-13／低=合計7以下。",
          },
          priorityReason: {
            type: "string",
            description: "優先度の算出根拠を1行で（例：業務が止まる×全員が使う＝高）。",
          },
        },
        required: [
          "system",
          "type",
          "title",
          "detail",
          "importance",
          "urgency",
          "importanceScore",
          "priority",
          "priorityReason",
        ],
      },
    },
    required: ["reply", "phase"],
  },
} as const;

/**
 * Claudeに1ターン投げて TurnResult を得る。
 * キー未設定や通信失敗・想定外応答時は例外を投げる（呼び出し側がフォールバックに切替）。
 */
export async function callClaude(
  system: string,
  messages: AnthropicMessage[],
  signal?: AbortSignal
): Promise<TurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      tools: [TURN_TOOL],
      tool_choice: { type: "tool", name: TURN_TOOL.name },
      messages,
    }),
    // タイムアウト＋クライアント切断で中断（無タイムアウトDoS対策）。
    signal: buildFetchSignal(signal),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const toolUse = Array.isArray(data?.content)
    ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === TURN_TOOL.name)
    : null;

  if (!toolUse?.input) {
    throw new Error("model did not return a tool_use block");
  }
  return coerceTurn(toolUse.input);
}

/**
 * Slack調査ツール付きで1ターン処理する（tool use ループ）。
 * モデルは read_slack（対象システムの許可チャンネルを読む）を最大 MAX_SLACK_ITERS 回まで
 * 呼べる。最後は必ず record_turn を強制して TurnResult を得る。
 * Slack連携が無効/許可リスト未設定のシステムでは read_slack は空を返すだけ（無害）。
 *
 * @param system     システムプロンプト本文（buildSystemPrompt の出力）
 * @param messages   会話履歴
 * @param slackSystem Slackスコープに使う対象システムの正式名（許可リストの解決に使う）
 */
export async function callClaudeWithSlack(
  system: string,
  messages: AnthropicMessage[],
  slackSystem: string | null,
  signal?: AbortSignal
): Promise<TurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  // 会話を content-block 形式で持つ（tool_use / tool_result を積めるように）。
  const convo: Array<{ role: "user" | "assistant"; content: unknown }> = messages.map(
    (m) => ({ role: m.role, content: m.content })
  );

  for (let iter = 0; iter <= MAX_SLACK_ITERS; iter++) {
    // クライアント切断後はツールループを継続しない（無駄な課金・走査を止める）。
    if (signal?.aborted) throw new Error("request aborted");
    const forceTurn = iter === MAX_SLACK_ITERS; // 最終反復は record_turn を強制
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        tools: forceTurn ? [TURN_TOOL] : [READ_SLACK_TOOL, TURN_TOOL],
        // any＝何らかのツールを必ず呼ばせる（地の文を返させない）。最終は record_turn 固定。
        // 並列tool_useを禁止＝1ターン1tool_use（複数返ると tool_result 不足で次回400になるため予防）。
        tool_choice: forceTurn
          ? { type: "tool", name: TURN_TOOL.name, disable_parallel_tool_use: true }
          : { type: "any", disable_parallel_tool_use: true },
        messages: convo,
      }),
      // 各反復にタイムアウト＋クライアント切断の中断を効かせる（無タイムアウトDoS対策）。
      signal: buildFetchSignal(signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];

    const turn = blocks.find(
      (b) => b?.type === "tool_use" && b?.name === TURN_TOOL.name
    );
    if (turn?.input) return coerceTurn(turn.input);

    const slackCall = blocks.find(
      (b) => b?.type === "tool_use" && b?.name === READ_SLACK_TOOL.name
    );
    if (slackCall && !forceTurn) {
      const rawLimit = Number(slackCall.input?.limit);
      const result = await readSlackForSystem(
        slackSystem,
        Number.isFinite(rawLimit) ? rawLimit : undefined
      );
      // モデルの tool_use をそのまま積み、tool_result を返す（次反復で record_turn へ）。
      convo.push({ role: "assistant", content: blocks });
      convo.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: slackCall.id,
            content: JSON.stringify(result).slice(0, 6000),
          },
        ],
      });
      continue;
    }

    // 想定外（tool_use 無し）：record_turn を強制してもう一度だけ回す。
    if (!forceTurn) {
      convo.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "（続けます）" }],
      });
      convo.push({ role: "user", content: "record_turn ツールで返答してください。" });
      continue;
    }
    throw new Error("model did not return a record_turn tool_use");
  }
  throw new Error("tool loop exhausted without record_turn");
}

/**
 * 擬似ストリーミング用：確定済み reply を自然な単位（句読点・空白・絵文字境界）で
 * 分割して返す。record_turn の構造化出力を壊さずに「逐次表示」体験を出すための分割。
 * Anthropic の tool_use は partial_json でしかストリームできず文章として流せないため、
 * 安全側に倒して「確定後に分割送出」する（契約 §6 の許容案）。
 * code point 単位で扱い、サロゲートペア（絵文字）を割らない。
 */
export function chunkReply(reply: string, maxChunk = 24): string[] {
  const text = typeof reply === "string" ? reply : "";
  if (!text) return [];
  const cps = Array.from(text); // code point 配列（絵文字を割らない）
  const chunks: string[] = [];
  let buf = "";
  for (const ch of cps) {
    buf += ch;
    // 句読点・改行・空白・閉じ括弧で区切る、または上限長で区切る。
    const isBoundary = /[。．！？!?、,\n\s）)」』】]/.test(ch);
    if (buf.length >= maxChunk || (isBoundary && buf.length >= 6)) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** ツール入力（または任意のオブジェクト）を安全に TurnResult へ整える */
export function coerceTurn(obj: any): TurnResult {
  const phase: Phase = obj?.phase === "confirm" ? "confirm" : "clarify";
  const reply = typeof obj?.reply === "string" ? obj.reply.trim() : "";
  if (!reply) throw new Error("reply missing in model output");

  let ticket: Ticket | null = null;
  if (phase === "confirm") {
    const t = obj?.ticket ?? {};
    ticket = {
      system: String(t.system ?? ""),
      type: coerceType(t.type),
      title: String(t.title ?? "").slice(0, 100) || "改善のご要望",
      detail: String(t.detail ?? "").slice(0, 1800),
      importance: coerceImportance(t.importance),
      ...coerceScoring(t),
    };
  }
  return { reply, phase, ticket };
}

/**
 * 優先度スコアリングの安全整形（§4.5.1）。
 * - urgency / importanceScore を 1〜10 にクランプ（数値でなければ undefined＝未算出）。
 * - priority は 高/中/低 のみ採用。欠落／不正で両点数が揃っていれば点数から算出（フォールバック）。
 * - priorityReason は文字列のみ・長すぎる根拠は切る。
 * 旧チケット互換：点数が無いケースでは各フィールドを undefined のままにする（表示は「—」）。
 */
function coerceScoring(t: any): {
  urgency?: number;
  importanceScore?: number;
  priority?: Priority;
  priorityReason?: string;
} {
  const urgency = clampScore(t?.urgency);
  const importanceScore = clampScore(t?.importanceScore);

  let priority: Priority | undefined = isPriority(t?.priority) ? t.priority : undefined;
  // 優先度が欠落／不正でも、両点数が揃っていれば点数から導く（欠落時の点数フォールバック）。
  if (!priority && urgency != null && importanceScore != null) {
    priority = computePriority(urgency, importanceScore);
  }

  const reasonRaw = typeof t?.priorityReason === "string" ? t.priorityReason.trim() : "";
  const priorityReason = reasonRaw ? reasonRaw.slice(0, 200) : undefined;

  const out: {
    urgency?: number;
    importanceScore?: number;
    priority?: Priority;
    priorityReason?: string;
  } = {};
  if (urgency != null) out.urgency = urgency;
  if (importanceScore != null) out.importanceScore = importanceScore;
  if (priority) out.priority = priority;
  if (priorityReason) out.priorityReason = priorityReason;
  return out;
}

function coerceType(v: unknown): TicketType {
  return v === "bug" || v === "新機能" ? v : "改善";
}
function coerceImportance(v: unknown): Importance {
  return v === "高" || v === "低" ? v : "中";
}
