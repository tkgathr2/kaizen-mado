# カイゼンくん ダイジェスト通知 本番有効化手順

## 概要
カイゼン改善⑤「毎朝ダイジェスト」機能を本番環境で有効化する手順です。

## ステップ 1：Vercel 環境変数を設定

### 方法 A：Vercel UI（推奨・UI で確認可能）

1. Vercel ダッシュボード → kaizen-mado プロジェクト → Settings → Environment Variables
2. 新規変数を追加：
   - **Name**: `KAIZEN_DIGEST_PAGE_ID`
   - **Value**: `pending`（初期値・ステップ 3 で更新）
   - **Environments**: Production, Preview, Development すべて選択
3. Save

### 方法 B：Vercel CLI

```bash
cd C:\Users\takag\dev\kaizen-mado
vercel env add KAIZEN_DIGEST_PAGE_ID
# プロンプトで "pending" を入力
# Environments: Production を選択
```

### 方法 C：API（curl または PowerShell）

```powershell
$projectId = "kaizen-mado-prod"  # 実際の project ID に置き換え
$teamId = "tkgathr2"
$token = $env:VERCEL_TOKEN

$body = @{
    key = "KAIZEN_DIGEST_PAGE_ID"
    value = "pending"
    target = @("production", "preview", "development")
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "https://api.vercel.com/v10/projects/$projectId/env?teamId=$teamId" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body $body `
  -ContentType "application/json"
```

## ステップ 2：Notion ダイジェストページを自動作成

デプロイ完了後、セットアップ API を1回だけ実行します：

```bash
# SETUP_TOKEN は env から取得（Vercel で別途設定が必要）
# または curl で直接呼び出し：
SETUP_TOKEN="your-setup-secret-here"

curl -X POST https://kaizen-mado.vercel.app/api/setup/digest-page \
  -H "Authorization: Bearer $SETUP_TOKEN" \
  -H "Content-Type: application/json"
```

**応答例**（成功時）：
```json
{
  "ok": true,
  "pageId": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "pageUrl": "https://www.notion.so/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "instruction": "Set KAIZEN_DIGEST_PAGE_ID=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 in Vercel environment"
}
```

## ステップ 3：PAGE_ID を Vercel に設定

上記で取得した `pageId` を使用して、Vercel 環境変数を更新：

### UI で更新（推奨）

1. Vercel ダッシュボード → Settings → Environment Variables
2. `KAIZEN_DIGEST_PAGE_ID` を探して Edit
3. 値を `a1b2c3d4e5f6...` に変更（ステップ 2 で取得した ID）
4. Save

### CLI で更新

```bash
vercel env rm KAIZEN_DIGEST_PAGE_ID
vercel env add KAIZEN_DIGEST_PAGE_ID
# 取得した pageId を入力
```

## ステップ 4：本番稼働確認

### 条件
- `KAIZEN_DIGEST_PAGE_ID` が有効な 32 文字 UUID に設定されている
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_TARGET_USER_ID` が設定されている
- Vercel Cron が「毎朝 08:00 JST（= 23:00 UTC）」に `/api/cron/notification-batch` を叩く

### 検証方法

#### 即座テスト（手動実行）

```bash
# CRON_SECRET を使用して cron ハンドラを直接実行
curl -X GET https://kaizen-mado.vercel.app/api/cron/notification-batch \
  -H "Authorization: Bearer $CRON_SECRET"

# 応答例（成功）：
# { "ok": true, "sent": 0, "considered": 0, "skipped": "empty" }
```

#### 定時テスト（朝 8 時を待つ）

- LINE に「🌅 カイゼン 昨日のうごき（まとめ）」が届く
- Notion の KAIZEN_DIGEST_PAGE_ID ページに、キュー（⟦KZQ⟧）と送信ログ（⟦KZS⟧）が記録される

### トラブルシュート

| 症状 | 原因 | 対応 |
|------|------|------|
| `disabled` | KAIZEN_DIGEST_PAGE_ID or LINE 未設定 | ステップ 1 ～ 3 を再確認 |
| `not-scheduled` | 08:00 ～ 08:29 JST 以外の時刻 | 朝 8 時まで待つ or force=true パラメータで手動実行 |
| `list-failed` | Notion API エラー | NOTION_TOKEN / KAIZEN_DIGEST_PAGE_ID 確認 |
| `send-failed` | LINE 送信失敗 | LINE 環境変数・API キー確認 |

## 仕様リファレンス

### ダイジェスト機能の役割分け

| 層 | 処理 | タイミング | 実装 |
|----|------|-----------|------|
| 即時通知 | GO 伺い・完了・詰まり等の判断要求 | リアルタイム | `lib/notify.ts` + `lib/line.ts` |
| ダイジェスト | 途中経過（着手/PR/エラー等）の日次まとめ | 毎朝 08:00 JST | `lib/notification.ts` + cron |

### キューフォーマット

- **キュー項目**: `⟦KZQ⟧{json}` — encodeQueue() で生成、decodeQueue() で復元
- **送信ログ**: `⟦KZS⟧<ticketId>:<type>\t<epochMs>` — 再送抑止用（24h TTL）

### 設定チェックリスト

```
☐ KAIZEN_DIGEST_PAGE_ID = 有効な UUID
☐ NOTION_TOKEN = sk-ant-v5-...（トークン有効）
☐ NOTION_DATABASE_ID = 4771cbc4-06d3-4eb9-a30f-05058ca69bd7
☐ LINE_CHANNEL_ACCESS_TOKEN = 設定済み
☐ LINE_CHANNEL_SECRET = 設定済み
☐ LINE_TARGET_USER_ID = 設定済み
☐ CRON_SECRET = 設定済み（cron 認証用）
☐ SETUP_TOKEN = 設定済み（初期化 API 認証用）
☐ vercel.json crons に /api/cron/notification-batch スケジュール済み
```

## 関連ドキュメント

- **実装**: `lib/notification.ts` — ダイジェスト機能の核
- **Cron ハンドラ**: `app/api/cron/notification-batch/route.ts`
- **初期化 API**: `app/api/setup/digest-page/route.ts`
- **即時通知**: `lib/notify.ts`, `lib/line.ts`
