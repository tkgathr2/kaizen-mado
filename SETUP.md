# カイゼンくん 起動手順（鍵投入ランブック）

コードは完成済み。以下の鍵を入れた分だけ機能が「起きる」段階リリース設計。
鍵が無い間は全機能が安全に不活性（窓口は従来どおり公開稼働）。担当：真田が画面操作で伴走可。

クローズドループ全体：
**声 → 起票 → 議論(GO待ち) → 📱LINE提案 → 社長GO → 着手 → 自動改修(対象リポ) → PR→ゲート→マージ→デプロイ → 📱報告 → 学び**

---

## ステップ0：必要な鍵の一覧

| 置き場所 | 変数 | 役割 | これが無いと |
|---|---|---|---|
| Vercel | `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | 会話AI・議論 | （投入済）|
| Vercel | `NOTION_TOKEN` / `NOTION_DATABASE_ID` | 起票・状態更新 | （投入済）|
| Vercel | `LINE_CHANNEL_ACCESS_TOKEN` | LINE送信 | LINE提案・報告が出ない |
| Vercel | `LINE_CHANNEL_SECRET` | webhook署名検証 | GO検知が動かない |
| Vercel | `LINE_TARGET_USER_ID` | 宛先（社長本人） | 送信先が無い |
| Vercel | `CRON_SECRET` | ループ/実行/callbackの認証 | /api/process・/api/execute が401で不活性 |
| Vercel | `GITHUB_DISPATCH_TOKEN` | 実行WF起動(PAT) | 自動改修が発火しない（社長案件への振り分けは動く）|
| GitHub Secrets (kaizen-mado) | `ANTHROPIC_API_KEY` | Actions内のClaude改修 | 改修できない |
| GitHub Secrets (kaizen-mado) | `TARGET_REPO_PAT` | 対象リポへpush/PR/merge | 改修できない |
| GitHub Secrets (kaizen-mado) | `CRON_SECRET` | callback認証（Vercelと同値） | 結果が戻らない |
| `lib/targets.ts` | `autoEligible` | システム別の自動許可 | falseの間は社長案件へエスカレ（安全既定）|

---

## ステップ1：LINE（Phase A＝提案とGO検知を起こす）

1. LINE Developers Console で **kaizen専用の Messaging APIチャネルを新規作成**
   （既存 line-notify-ai とは別チャネル。webhookの宛先が別のため）。
2. 取得する値：
   - `LINE_CHANNEL_ACCESS_TOKEN`（Messaging API > チャネルアクセストークン・長期）
   - `LINE_CHANNEL_SECRET`（Basic settings > Channel secret）
3. **Webhook URL** を `https://kaizen.takagi.bz/api/line/webhook` に設定し、Webhookを「利用する」ON。応答メッセージはOFF推奨。
4. 社長のLINEでこのBotを友だち追加 → 一度何か送信 → webhookログの `source.userId` を確認し `LINE_TARGET_USER_ID` に設定。
5. 上記3つをVercel環境変数へ投入 → 再デプロイ。
   - 確認：`/api/line/webhook` に署名なしPOSTで **401** が返る（=有効）。

## ステップ2：改善ループ＆実行の定期実行（CRON_SECRET）

1. Vercelに `CRON_SECRET`（任意の長い乱数）を投入。
2. 以下を定期実行（GET/POST両対応・`Authorization: Bearer $CRON_SECRET` か `x-cron-secret` で認証）：
   - `/api/process`（受付→議論→GO待ち＋LINE提案）
   - `/api/execute`（着手→自動改修dispatch or 社長案件エスカレ）
   - 叩き方の選択肢：① Vercel Cron（`vercel.json`にcrons追加。※Hobbyプランはcron頻度に制限があるためプラン要確認）／② 既存のscheduled-tasks等の外部スケジューラから上記URLへ定期GET（Bearer付き）。頻度は5〜15分目安。
   - 即時性を上げたい場合：GO直後に `/api/execute` を叩く運用も可（webhookは状態を「着手」にするのみ）。

## ステップ3：自動改修エンジン（対象システムを実際に直す）

1. **GitHub PAT** を発行（スコープ：対象リポ tkgathr2/* に `repo` ＋ `workflow`）→ `TARGET_REPO_PAT`。
2. kaizen-mado の **GitHub Secrets** に：`ANTHROPIC_API_KEY`・`TARGET_REPO_PAT`・`CRON_SECRET`。
3. Vercelに `GITHUB_DISPATCH_TOKEN`（kaizen-madoへ `repository_dispatch` できるPAT＝`repo`スコープ）。
4. **対象リポを1件ずつ段階解放**：
   - そのシステムの repo を `lib/targets.ts` に設定（未設定なら自動不可）。
   - ライブで1件、軽微な改善チケットを通して試走（PR→ゲート→マージ→ヘルス→callback）。
   - 問題なければ `lib/targets.ts` の該当 `autoEligible` を `true` に。以後そのシステムは自動改修対象。

---

## 安全メモ（運用前提）
- 金額・個人情報・認証・削除に触れる案件は機械的に「社長確認」へ逃げる（自動では直さない）。
- コード生成後、差分≥50行 or 禁止パス接触 or CI失敗 は自動マージせず「レビュー」へ。
- 「赤」運用：止めたいときは `CRON_SECRET` を変更（=ループ即停止）、または `GITHUB_DISPATCH_TOKEN` を外す（=自動改修停止）。
- いずれの鍵も未投入の間は、窓口だけ従来どおり動き、他は静かに不活性。

詳細設計：Notion「🔁 カイゼンくん 要件定義＋設計案 v0.1」「現状・ロードマップ」§10/§11。
