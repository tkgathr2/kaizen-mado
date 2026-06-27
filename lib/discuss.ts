// ── CTO Agent Lab 議論の自動化（LLM構造化出力 / tool use 強制） ──
// 改善チケットを「議論」して方針・工数・リスク・GO可否の推奨・GO伺いドラフトを出す。
// このルートは誰にも送信しない。GO伺いドラフトは"送信用の下書き"であり実送信しない。
// キー未設定・通信失敗時は fallback（throwしない）。
import type { TicketRow } from "./tickets";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export type Recommendation = "GO推奨" | "要検討" | "非推奨";
export type Level = "高" | "中" | "低";

export interface DiscussResult {
  houshin: string;
  /** 具体的な改善手順（番号つきの実作業ステップ）。社長が「どう直すか」を具体的に掴めるように。 */
  steps: string[];
  kousuu: string;
  risks: string[];
  /** 重要度（高/中/低）＝直さないと困る度合い。 */
  importance: Level;
  /** 緊急度（高/中/低）＝今すぐやるべき度合い。 */
  urgency: Level;
  recommendation: Recommendation;
  goDraft: string;
  /** LINE通知用：こまりごとを素人語で1行（〜34字）。専門用語・長文・英字の羅列を避ける。 */
  problemPlain: string;
  /** LINE通知用：直し方を素人語の短い箇条書き（1〜3個・各〜28字）。番号や専門用語を避ける。 */
  fixPlain: string[];
  /** LINE通知用：気をつけることを素人語で1行（〜40字）。無ければ「特になし」。 */
  riskPlain: string;
  source: "claude" | "fallback";
}

const SYSTEM_PROMPT =
  "あなたは高木産業グループ CTO Agent Lab。改善チケットについて、方針・具体的な改善手順・工数見積・リスク・重要度・緊急度・GO可否の推奨・社長へのGO伺いドラフトを簡潔かつ具体的に出す。手順は『何をどう直すか』が分かる実作業ステップにする。GO伺いドラフトは\"送信用の下書き\"であり実送信はしない。" +
  "さらにLINE通知用に problemPlain / fixPlain / riskPlain を“素人が読んで分かる短い言葉”で必ず作る。problemPlain=こまりごとを素人語で1行（〜34字）。fixPlain=直し方を素人語の短い箇条書き1〜3個（各〜28字・番号や専門用語を避け『○○を再発行して設定し直す』のような言い方）。riskPlain=気をつけることを素人語で1行（〜40字・無ければ『特になし』）。技術用語や手順の羅列・英字の羅列はNotion用の steps に回し、plainには書かない。";

const DISCUSS_TOOL = {
  name: "record_discussion",
  description:
    "改善チケットの議論結果を記録する。方針・具体的な改善手順・工数見積・リスク・重要度・緊急度・推奨・GO伺いドラフトを構造化して返す。",
  input_schema: {
    type: "object",
    properties: {
      houshin: { type: "string", description: "対応方針（2〜4文）" },
      steps: {
        type: "array",
        items: { type: "string" },
        description:
          "具体的な改善手順（実作業ステップ。例：『①該当画面の◯◯を××に変更』『②テスト追加』のように、何をどう直すかが分かる粒度で2〜5個）",
      },
      kousuu: { type: "string", description: "工数見積（例: 半日 / 2〜3日 など）" },
      risks: {
        type: "array",
        items: { type: "string" },
        description: "想定リスク（箇条書き）",
      },
      importance: {
        type: "string",
        enum: ["高", "中", "低"],
        description: "重要度＝直さないと困る度合い（高/中/低）",
      },
      urgency: {
        type: "string",
        enum: ["高", "中", "低"],
        description: "緊急度＝今すぐやるべき度合い（高/中/低）",
      },
      recommendation: {
        type: "string",
        enum: ["GO推奨", "要検討", "非推奨"],
        description: "GO可否の推奨",
      },
      go_ukagai_draft: {
        type: "string",
        description: "社長へのGO伺いドラフト（送信用下書き・実送信はしない）",
      },
      problem_plain: {
        type: "string",
        description:
          "LINEで社長がひと目で分かる、こまりごとの素人語1行（〜34字）。専門用語・長文・英字の羅列を避ける。詳細な技術手順は steps（Notion用）に書く。",
      },
      fix_plain: {
        type: "array",
        items: { type: "string" },
        description:
          "LINEで社長がひと目で分かる、直し方の素人語の短い箇条書き1〜3個（各〜28字）。番号や専門用語を避け『○○を再発行して設定し直す』のような言い方。詳細な技術手順は steps（Notion用）に書く。",
      },
      risk_plain: {
        type: "string",
        description:
          "LINEで社長がひと目で分かる、気をつけることの素人語1行（〜40字・無ければ『特になし』）。専門用語・長文・英字の羅列を避ける。",
      },
    },
    required: [
      "houshin",
      "steps",
      "kousuu",
      "risks",
      "importance",
      "urgency",
      "recommendation",
      "go_ukagai_draft",
      "problem_plain",
      "fix_plain",
      "risk_plain",
    ],
  },
} as const;

function coerceRecommendation(v: unknown): Recommendation {
  return v === "GO推奨" || v === "非推奨" ? v : "要検討";
}

function coerceLevel(v: unknown, fallback: Level): Level {
  return v === "高" || v === "中" || v === "低" ? v : fallback;
}

/** 長い1行を素人語の短い表示用に詰める（語の途中で切らずに末尾「…」）。 */
function shortenPlain(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

/** ツール入力（または任意のオブジェクト）を安全に整形する。
 * importance/urgency が欠落・不正なときの既定は fallbackLevel（既定『中』）。
 * problemPlain/fixPlain/riskPlain が欠落していたら houshin/title/steps/risks から補う
 * （旧チケット・plain無しのclaude応答でも破綻しない後方互換）。 */
export function coerceDiscussion(
  obj: any,
  fallbackLevel: Level = "中"
): Omit<DiscussResult, "source"> {
  const houshin = typeof obj?.houshin === "string" ? obj.houshin.trim() : "";
  const toStrArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((r) => typeof r === "string" && r.trim()).map((r) => (r as string).trim())
      : [];
  const steps = toStrArray(obj?.steps);
  const kousuu = typeof obj?.kousuu === "string" ? obj.kousuu.trim() : "";
  const risks = toStrArray(obj?.risks);
  const importance = coerceLevel(obj?.importance, fallbackLevel);
  const urgency = coerceLevel(obj?.urgency, fallbackLevel);
  const recommendation = coerceRecommendation(obj?.recommendation);
  const goDraft =
    typeof obj?.go_ukagai_draft === "string"
      ? obj.go_ukagai_draft.trim()
      : typeof obj?.goDraft === "string"
        ? obj.goDraft.trim()
        : "";

  // ── LINE通知用の素人語フィールド（欠落時は既存フィールドから補う） ──
  const rawProblem =
    typeof obj?.problem_plain === "string"
      ? obj.problem_plain.trim()
      : typeof obj?.problemPlain === "string"
        ? obj.problemPlain.trim()
        : "";
  const problemPlain = rawProblem
    ? shortenPlain(rawProblem, 34)
    : houshin
      ? shortenPlain(houshin, 34)
      : shortenPlain(typeof obj?.title === "string" ? obj.title : "", 34);

  const rawFix =
    toStrArray(obj?.fix_plain).length > 0
      ? toStrArray(obj?.fix_plain)
      : toStrArray(obj?.fixPlain);
  const fixPlain = (rawFix.length > 0 ? rawFix : steps)
    .slice(0, 3)
    .map((s) => shortenPlain(s, 28));

  const rawRisk =
    typeof obj?.risk_plain === "string"
      ? obj.risk_plain.trim()
      : typeof obj?.riskPlain === "string"
        ? obj.riskPlain.trim()
        : "";
  const riskPlain = rawRisk
    ? shortenPlain(rawRisk, 40)
    : risks.length > 0
      ? shortenPlain(risks[0], 40)
      : "特になし";

  return {
    houshin,
    steps,
    kousuu,
    risks,
    importance,
    urgency,
    recommendation,
    goDraft,
    problemPlain,
    fixPlain,
    riskPlain,
  };
}

/** APIキー未設定・失敗時に使う定型の議論結果を生成する */
function fallbackDiscussion(ticket: TicketRow): DiscussResult {
  const type = ticket.type || "改善";
  const importance: Level = coerceLevel(ticket.importance, "中");

  // 既定は「要検討」。重要度「高」のときだけ「GO推奨」に上げる。
  // （「低」「中」は既定の「要検討」のまま＝以前の `else if (低) = 要検討` は
  //  初期値と同じno-opのデッドコードだったため削除。挙動は不変。）
  let recommendation: Recommendation = "要検討";
  if (importance === "高") recommendation = "GO推奨";

  // 緊急度はチケット種別から推定（bug＝今すぐ困る/高、新機能＝低、改善＝中）。
  const urgency: Level = type === "bug" ? "高" : type === "新機能" ? "低" : "中";

  const kousuu =
    type === "新機能" ? "2〜5日（要見積）" : type === "bug" ? "半日〜1日" : "1〜2日";

  // 具体的な改善手順（鍵未設定でも"次に何をするか"が分かる定型ステップ）。
  const steps: string[] =
    type === "bug"
      ? [
          "①再現条件を特定する（どの画面・操作・データで起きるか）",
          "②原因箇所を直し、再発防止の回帰テストを追加する",
          "③本番で直っていることを確認する",
        ]
      : type === "新機能"
        ? [
            "①要望の要件を1枚に整理し、影響範囲を確認する",
            "②画面・データ設計を決めて実装する",
            "③テストを足して本番反映する",
          ]
        : [
            "①現状のどこを、どう変えるかを具体化する",
            "②該当箇所を改修してテストを足す",
            "③本番で改善されたことを確認する",
          ];

  const risks: string[] = [];
  if (type === "bug") risks.push("再発防止のための回帰テストが必要");
  if (type === "新機能") risks.push("既存機能への影響範囲の確認が必要");
  risks.push("詳細要件のヒアリングが追加で必要な可能性");

  const houshin = `「${ticket.title || "改善のご要望"}」（${ticket.system || "対象未特定"} / ${type} / 重要度${importance}）について対応方針を検討する。まず内容を精査し、影響範囲と優先度を確認のうえ着手判断を行う。`;

  const goDraft = `【GO伺い（下書き・未送信）】\n対象: ${ticket.system || "未特定"}\n件名: ${ticket.title || "改善のご要望"}\n種別/重要度: ${type} / ${importance}\n推奨: ${recommendation}\n工数見積: ${kousuu}\n上記内容で着手してよろしいでしょうか。`;

  // LINE通知用の素人語（鍵未設定でも読める定型・種別ごと）。
  const problemPlain = shortenPlain(ticket.title || "改善してほしいことがあります", 34);
  const fixPlain: string[] =
    type === "bug"
      ? ["どこで起きるか調べる", "原因を直して再発を防ぐ", "直ったか本番で確かめる"]
      : type === "新機能"
        ? ["やりたいことを整理する", "画面を作って試す", "本番で使えるようにする"]
        : ["どこを変えるか決める", "その場所を直して試す", "良くなったか確かめる"];
  const riskPlain =
    type === "bug"
      ? "直したあと、元の不具合が戻らないか確認します"
      : type === "新機能"
        ? "今ある機能に影響が出ないか確認します"
        : "くわしい中身は追って確認が必要かもしれません";

  return {
    houshin,
    steps,
    kousuu,
    risks,
    importance,
    urgency,
    recommendation,
    goDraft,
    problemPlain,
    fixPlain,
    riskPlain,
    source: "fallback",
  };
}

/**
 * チケットを議論して DiscussResult を返す。
 * キー未設定・通信失敗・想定外応答時は fallback に落とす（throwしない）。
 */
export async function discussTicket(ticket: TicketRow): Promise<DiscussResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackDiscussion(ticket);

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const userContent = [
    `対象システム: ${ticket.system || "未特定"}`,
    `種別: ${ticket.type || "改善"}`,
    `重要度: ${ticket.importance || "中"}`,
    `件名: ${ticket.title || "改善のご要望"}`,
    `内容: ${ticket.detail || "(内容なし)"}`,
  ].join("\n");

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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [DISCUSS_TOOL],
        tool_choice: { type: "tool", name: DISCUSS_TOOL.name },
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) return fallbackDiscussion(ticket);

    const data = await res.json();
    const toolUse = Array.isArray(data?.content)
      ? data.content.find(
          (b: any) => b?.type === "tool_use" && b?.name === DISCUSS_TOOL.name
        )
      : null;
    if (!toolUse?.input) return fallbackDiscussion(ticket);

    // importance/urgency が欠落していたら、まずチケット自身の重要度→無ければ「中」を既定に。
    const fb = coerceLevel(ticket.importance, "中");
    return { ...coerceDiscussion(toolUse.input, fb), source: "claude" };
  } catch {
    return fallbackDiscussion(ticket);
  }
}
