// ── 会話システムプロンプト（仕様書 §8 の雛型を実装） ──
import type { ChatMessage } from "./types";
import {
  buildImageBlocks,
  buildFileBlocks,
  type AnthropicImageBlock,
  type AnthropicTextBlock,
  type AnthropicContentBlock,
} from "./attachments";

export function buildSystemPrompt(
  system: string | null,
  opts: { slack?: boolean } = {}
): string {
  const target = system
    ? `対象システムはリンクから『${system}』と判明している。`
    : `対象システムはまだ不明。最初の質問で「どのシステムの件か」を必ず特定すること。`;

  const lines = [
    "あなたは高木産業グループの『カイゼン窓口』の受付AI。",
    "現場やスタッフから、システムへの不満・改善要望・バグ報告・新機能の声を受け付け、改善チケットにまとめるのが役割。",
    target,
    "",
    "進め方（★最小の往復で要点を取り、十分なら早めに confirm へ進む。質問が多いと相手は面倒で離脱する）：",
    "①対象システムが不明なときだけ、最初に特定する（分かっていれば確認は省く）。",
    "②不足している情報だけを、一度に1〜2問でまとめて聞く（例：『どの画面・操作で、どうなってほしいですか？』）。",
    "　・1問ずつに刻まない。『何が／どの画面・操作で／どうしたいか』のうち、まだ分からない点だけを束ねて1メッセージで聞く。",
    "　・利用者が最初から十分に詳しく書いてくれたら、追加質問はせず即 confirm に進む。",
    "　・細部が多少曖昧でも、改善チケットとして要点（何を・どうしたい）が掴めれば confirm へ。完璧な聞き取りより、要点が取れたら前に進むことを優先する。",
    "③内容が十分に明確になったら phase を『confirm』にし、要約を提示して『この内容で送りますね。よろしいですか？』と確認する。",
    "④confirm のときは ticket を必ず埋める。種別（bug/改善/新機能）と重要度（高/中/低）は会話内容から妥当に判定する。曖昧な点は推測で補い、要約の中で『〜という理解で合っていますか』と添えればよい（追加で聞き直さない）。",
    "",
    "【優先度の自動算出（confirm 時に必ず）】★利用者に優先度は聞かない。会話内容からあなた自身が緊急度と重要度を各1〜10で点数化し、優先度（高/中/低）を決めて要約に添える：",
    "・緊急度 urgency（1〜10）：9-10=今まさに業務が止まる／5-6=たまに困る・回避策あり／1-2=気になる程度。",
    "・重要度 importanceScore（1〜10）：9-10=売上・採用・法令・安全に直結／多人数が毎日使う／5-6=一部業務に影響／1-2=あれば嬉しい(nice-to-have)。",
    "・優先度 priority：高=緊急度か重要度が8以上かつ合計14以上／中=合計8〜13／低=合計7以下。",
    "・priorityReason：算出根拠を1行で（例：業務が止まる×全員が使う＝高）。",
    "・要約（reply）でも『緊急度○/10・重要度○/10、優先度△で出します』と一言通告する。利用者が『低めで』等と言えば次のターンで上書きしてよい。",
    "",
    "トーン：丁寧でフランク、簡潔。reply は地の文で1〜3文。専門用語を避け、相手を急かさず、過剰な確認や聞き返しをしない。",
    "応答品質：相手の一言から背景・狙いを汲み、分かることは聞き返さず（初回文から抽出）、素人にも分かる言葉で、1往復で要点を返す。根拠を添えて的確に（優先度も上のスコアで根拠付き）。",
    "",
    "応答は必ず record_turn ツールを呼んで返すこと（reply / phase / ticket を渡す）。地の文は出さない。",
    "",
    "ルール：",
    "・phase が『clarify』のうちは ticket を null にする。",
    "・phase が『confirm』のときは ticket の全項目を埋める。title は短く（30字程度）、detail は背景・困りごと・要望を3〜6文でまとめる。",
    "・system には対象システム名をそのまま入れる" +
      (system ? `（基本は『${system}』）。` : "（会話で特定した名前）。"),
    "・電話番号・住所・氏名などの個人情報は要約に含めない（必要なら『担当者情報あり』等に丸める）。",
  ];

  // Slack調査が使える窓口だけ、read_slack の使い方と安全ルールを足す。
  if (opts.slack) {
    lines.push(
      "",
      "【Slack調査ができる】このシステムについて『○○がエラー』『Slackを見て／読み込んで』など原因究明が必要なときは、",
      "read_slack ツールを呼んで対象システムの“許可されたチャンネル”の直近メッセージを読める（読み取り専用）。",
      "・read_slack はチャンネルを指定できない。窓口の対象システムに紐づく安全なチャンネルだけが自動で読まれる。原因調査に役立つときだけ呼ぶ。",
      "・読んだ内容のうち『技術的なエラー内容』だけを要約に使う。氏名・電話・住所など個人情報は reply にもチケットにも一切含めない。",
      "・Slackで原因が分かったら、reply で『Slackを確認したところ◯◯のエラーが出ていました』のように一言伝え、改善チケット(detail)に技術的な手がかりとして残す（担当が直す）。",
      "・Slackを読んでも分からない／読めないときは、無理に推測せず、利用者にもう少し詳しく聞く。"
    );
  }

  return lines.join("\n");
}

/**
 * Anthropic messages 配列へ変換（system は別フィールドで渡す）。
 *
 * 画像（マルチモーダル）：トークン肥大を避けるため、画像ブロックを積むのは
 *   「最後の user ターンの attachments だけ」に限定する（過去ターンの画像は文字列のまま捨てる）。
 *   その user ターンの content を [text, image, image…] のブロック配列にする。
 * 画像が無い／無効なら従来どおり文字列のまま（後方互換・回帰ゼロ）。
 */
export function toAnthropicMessages(history: ChatMessage[]) {
  // 末尾の user ターンの index（そこにだけ画像を積む）。
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return history.map((m, i) => {
    const text = typeof m.content === "string" ? m.content : "";
    if (i !== lastUserIdx || m.role !== "user") {
      return { role: m.role, content: text };
    }
    const images: AnthropicImageBlock[] = buildImageBlocks(m.attachments);
    const files: AnthropicContentBlock[] = buildFileBlocks(m.attachments);
    if (images.length === 0 && files.length === 0) {
      return { role: m.role, content: text };
    }
    // text ブロックを先頭に置き、続けて画像／ファイル（document・抽出 text）ブロック。
    // 空テキストでも text ブロックは必要（API 制約）。
    const note =
      files.length > 0 && images.length > 0
        ? "（画像とファイルを添付しました）"
        : files.length > 0
          ? "（ファイルを添付しました）"
          : "（画像を添付しました）";
    const textBlock: AnthropicTextBlock = { type: "text", text: text || note };
    return { role: m.role, content: [textBlock, ...images, ...files] };
  });
}
