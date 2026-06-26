// ── カイゼン窓口の「Slackを読んで原因を調べる」機能の安全境界（許可チャンネル） ──
//
// SECURITY（最重要）：カイゼン窓口（/api/chat）は認証なしの公開窓口。
// もしAIに任意のSlackチャンネルを読ませると、誰でも社内Slackを引き出せてしまう。
// そこで「窓口の対象システムごとに、読んでよい安全なチャンネルだけ」をここで許可リスト化し、
// それ以外は一切読めないようにする（モデルにチャンネルを選ばせない＝WHEREは固定）。
//
// 設定方法：チャンネルIDは env で渡す（ハードコードしない）。env 未設定のシステムは
// 「Slackを読む」機能が無効のまま＝今までどおりの挙動（安全側の既定）。
//
// 例: SLACK_CH_RECRUIT="C0123456789"  → 「Indeed応募通知」窓口がそのチャンネルを読めるようになる。

/** 読んでよいSlackチャンネル1件（人が読むラベルと実ID）。 */
export interface SlackChannelRef {
  /** ログ・診断用の短いラベル（利用者やモデルには内部的にしか出さない）。 */
  label: string;
  /** SlackチャンネルID（env由来。ここに無いIDは絶対に読まない）。 */
  channelId: string;
}

/** env から1チャンネル分の許可を組み立てる（未設定なら空＝そのシステムは読めない）。 */
function fromEnv(envVar: string, label: string): SlackChannelRef[] {
  const id = process.env[envVar];
  if (!id || !id.trim()) return [];
  return [{ label, channelId: id.trim() }];
}

/**
 * 対象システム名（lib/systems.ts の正式名）→ 読んでよいチャンネルの許可リスト。
 * ここに載っていないシステムは Slack を一切読めない（安全側の既定）。
 * 新しいシステムを足すときは「公開窓口に晒して安全なチャンネルか」を必ず吟味すること。
 */
function buildAllowlist(): Record<string, SlackChannelRef[]> {
  return {
    // 応募通知ボット（tkgathr2/recruit）の通知/エラーが出るチャンネル。
    "Indeed応募通知": fromEnv("SLACK_CH_RECRUIT", "応募通知ボット"),
  };
}

/**
 * 対象システムで読んでよいチャンネル一覧を返す（許可リストに無ければ空）。
 * env を毎回参照するため、テストや段階リリースで env を差し替えても追従する。
 */
export function channelsForSystem(system: string | null | undefined): SlackChannelRef[] {
  if (!system) return [];
  const list = buildAllowlist()[system];
  return Array.isArray(list) ? list : [];
}
