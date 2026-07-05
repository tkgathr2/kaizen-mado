# 改善⑤ 本番デプロイチェックリスト（2026-07-04）

## 実装状況 ✅ 完全完了

### コード実装
- ✅ cronハンドラ（`app/api/cron/notification-batch/route.ts`）実装済み
- ✅ `runDailyNotificationBatch()` 関数実装済み（`lib/notification.ts`）
- ✅ Notion永続化（⟦KZQ⟧キュー / ⟦KZS⟧送信ログ）
- ✅ LINE送信ロジック
- ✅ デデュペ・再送抑止（24h）・古いログ掃除（48h）
- ✅ PR #128-#132 全マージ
- ✅ `npm run build` 緑 / `npm run test` 686緑

### 本番基盤
- ✅ vercel.json cron設定: `0 23 * * *`（UTC23:00 = JST 08:00）
- ✅ Notionダイジェスト用ページ作成済み: `3930d9808b3b8138beccec54fe02e65d`

---

## 社長設定タスク（確認ゼロで実行可）

### 1️⃣ Vercelダッシュボード → Environment Variables

**プロジェクト:** `kaizen-mado` (本番)  
**環境:** Production

以下2つを追加：

| 変数名 | 値 | 説明 |
|---|---|---|
| `KAIZEN_DIGEST_PAGE_ID` | `3930d9808b3b8138beccec54fe02e65d` | Notion改善⑤ダイジェストページ |
| `KAIZEN_DIGEST_PAGE_ID` (Preview) | `3930d9808b3b8138beccec54fe02e65d` | 本番で発動するので Previewも同じ値でOK |

### 2️⃣ 検証（自動実行）

設定→ 2時間以内に自動でcron発火（明朝08:00 JST）。

**確認方法:**
1. Notion改善⑤ページを開く
2. 子ブロック（⟦KZQ⟧キュー / ⟦KZS⟧送信ログ）が出現 → 成功
3. LINE 社長へ日次ダイジェスト 1通到着 → 検証完了

---

## 無効化（緊急時）

未設定のままなら自動で `no-op`（機能OFF・挙動不変）。  
本番への影響 = ゼロ。

---

## 残タスク

🟢 実装完了 / 🟡 社長設定待ち

- 🟡 Vercel環境変数2つ設定（社長UI操作・2min）
- 🟢 E2E自動検証（明朝cron実行待ち・人力不要）

