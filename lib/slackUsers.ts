// ── 既知Slackユーザーの表示名対応表（users:read スコープ無しでも名前を出すための砦） ──
// 本番Botトークンに users:read スコープが無い（missing_scope）と users.info が使えず、
// GO伺いに「誰から：Slack:<@U…>」の生IDがそのまま届いてしまった（KZ-72・2026-07-09 社長指摘）。
// 解決順序：users.info（API）→ この対応表 → 読める日本語表記（生IDは絶対に出さない）。
//
// ★氏名は env で渡す（このリポは public のため、個人名をコードに直書きしない）。
//   KAIZEN_SLACK_USER_NAMES="U0XXXXXXX:山田太郎,U0YYYYYYY:佐藤花子"
//   形式：カンマ区切りで「SlackユーザーID:表示名」。空・未設定なら対応表は空（fail-safe）。
const ENV_KEY = "KAIZEN_SLACK_USER_NAMES";

/** env の対応表をパースする（毎回読む＝テスト・env差し替えに追従。件数は高々数十で軽量）。 */
export function knownSlackUsers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env[ENV_KEY]?.trim();
  if (!raw) return {};
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim().toUpperCase();
    const name = pair.slice(i + 1).trim();
    if (/^[A-Z0-9]+$/.test(id) && name) map[id] = name;
  }
  return map;
}

/** 既知ユーザーIDなら表示名を返す（未知は null）。 */
export function knownSlackUserName(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return knownSlackUsers()[userId.toUpperCase().trim()] ?? null;
}
