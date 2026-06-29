# Slack → カイゼン 連携の配線手順

幹部Bot（真田・早乙女・鷹司）への `app_mention` を検知してカイゼンを起動するための設定メモ。

## エンドポイント
`POST https://kaizen.takagi.bz/api/slack/events`

## 環境変数（Vercel）
- `SLACK_SIGNING_SECRET` … **カンマ区切りで複数アプリの Signing Secret を並べる**。
  幹部Botは人格ごとに別Slackアプリ＝別署名鍵のため、受信イベントはいずれか1つの鍵で
  署名一致すれば通す（`app/api/slack/events/route.ts` の `parseSigningSecrets`/`verifySlackSignature`）。
  例: `SLACK_SIGNING_SECRET="<真田アプリの鍵>,<早乙女アプリの鍵>,<鷹司アプリの鍵>"`
- `SLACK_BOT_TOKEN` … 完了返信（`postToSlack`）に使う。`chat:write` 必須。返信元は「カイゼン窓口リーダー」Bot。
- `CRON_SECRET` … 起票後の `/api/process` 内部kickの認証に流用。

## 各幹部BotアプリのSlack側設定（アプリごと）
1. **OAuth & Permissions** … Bot Token Scopes に `app_mentions:read`（受信用）。
2. **Event Subscriptions** … Enable → Request URL に上記エンドポイント → `app_mention` を購読。
   ※ Request URL 登録時、Slackは url_verification チャレンジを **そのアプリの署名鍵で署名** して送る。
   先に `SLACK_SIGNING_SECRET` にそのアプリの鍵を入れて再デプロイしておくこと（未設定だと500）。
3. **Reinstall** … スコープ反映のため再インストール。表示名がドリフトしたら `users.profile.set` で再適用。

## 動作確認
- 未署名リクエストで `POST /api/slack/events` を叩くと、鍵未設定なら500、鍵設定済みなら401。
- 幹部Botをメンション → カイゼンに「その他」種別でチケット起票 → カイゼン完了時に元スレッドへ返信。

## 対象アプリ（高木産業ワークスペース）
| 人格 | アプリ名 | App ID | 配線状況 |
|---|---|---|---|
| 真田 | sanada | A0BCXSXFX4P | ✅ 署名鍵投入・Event登録・app_mentions:read 再インストール済 |
| 早乙女 | saotome | A0BC8QXT0CX | 署名鍵投入済→Event登録・再インストール処理中 |
| 鷹司 | takatsukasa | A0BCM6JHLMT | 署名鍵投入済→Event登録・再インストール処理中 |
| 返信用 | カイゼン窓口リーダー | A0BD3SD17TR | （postToSlack用・chat:write） |

## 自動化メモ（2026-06-30 真田）
- 署名鍵の取り出し＝Slack Basic Information の input 値を Show 後に読み、`window.name` ブリッジで
  Vercel タブへ運ぶ（鍵値をアシスタント文脈に出さない）。
- Vercel env の更新＝ダッシュボードAPI `PATCH /api/v9/projects/{pid}/env/{id}` を同一オリジン
  `credentials:include` で叩く（行メニューUIが自動化で不安定なため）。
- Event Subscriptions＝設定UIが不安定なため `apps.manifest.export`/`update`（同一オリジン `/api/`・
  App Configuration Token）で request_url + bot_events + scopes を一括設定。
