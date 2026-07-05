# カイゼンくん Phase B - 本番テストプラン（2026-07-05）

## 概要

秘密鍵投入後、実際に本番で自律改修ワークフロー全体が動作することを段階的に検証するプラン。  
リスク最小化のため、**即時通知（即動作）→ LINE 提案送信→ GO 検知→ PR 生成→自動マージ** の各ステップを低リスク順に実行検証。

---

## テストスコープ

| フェーズ | 検証対象 | 対象リポ | 期間 | リスク |
|---------|---------|---------|------|--------|
| **Phase A** | 通知ダイジェスト配線 | ステレポ | 完了 | 低 |
| **Phase B** | 自律改修ワークフロー全体 | ステレポ | **本テスト** | 低→中 |
| Phase C | 本番自動化常態化監視 | ステレポ | 運用 | 高 |

---

## テストシナリオ（4段階・低リスク順）

### シナリオ① : LINE 提案送信確認（リスク最小・データ変更なし）

**目的**: 社長の Slack 発言が LINE で自動提案に変換されることを確認

**実行手順**:
1. 社長が Slack に発言: `/kaizen_dev 遅い` ← テスト用 Notion ID をノード指定
2. kaizen-mado が LINE API を呼び出し
3. 社長の LINE に提案が 5 秒以内に到着
4. 提案内容: 「ノード: 遅い → 提案A: cache 追加」（要件書より自動抽出）

**期待結果**:
- LINE メッセージ受信: **5/5 成功**（5 回テスト実行）
- メッセージ遅延: **< 5 秒**
- 提案内容: **要件書と一致**

**検証チェックリスト**:
```
□ 1回目: LINE受信 ✓ / 遅延時間: ___ 秒
□ 2回目: LINE受信 ✓ / 遅延時間: ___ 秒
□ 3回目: LINE受信 ✓ / 遅延時間: ___ 秒
□ 4回目: LINE受信 ✓ / 遅延時間: ___ 秒
□ 5回目: LINE受信 ✓ / 遅延時間: ___ 秒
□ 提案内容の正確性: ✓ (「○○を追加」等、文言が要件と一致)
□ 人的被害: なし
```

**ロールバック**: なし（変更はデータなし、通知のみ）

**所要時間**: 5 分

---

### シナリオ② : GO 検知 → PR 生成（中リスク・コード変更なし）

**目的**: LINE で GO と返信したとき、GitHub Actions が実行されて PR が生成されることを確認

**前提条件**:
- シナリオ① が成功している
- GitHub Actions ワークフロー `kaizen-execute.yml` が接続済み
- GitHub branch protection: main に対する push 禁止（PR 経由のみ）

**実行手順**:
1. 社長が LINE で「GO」と返信
2. Webhook が kaizen-mado に通知
3. GitHub Actions で `kaizen-execute.yml` トリガー
4. PR が自動生成（ブランチ名: `kaizen/test-{timestamp}`）
5. PR 内容: CI チェック、自動生成コードのホワイトリスト確認

**期待結果**:
- GitHub PR 出現: **10 秒以内**
- PR author: `kaizen-bot[bot]` （社長でなくボット名義）
- PR タイトル: `[kaizen] test-proposal-timestamp`
- PR body: Notion ノード link + 提案内容

**検証チェックリスト**:
```
□ GitHub Actions実行開始: ✓ / 時刻: ___
□ PR生成確認: ✓ / PR#: ___
□ PR Author が bot である: ✓
□ ホワイトリスト外の変更がないか: ✓ (手で diff 確認)
□ CI ステータス: passing / failing →【判定】
□ 人的被害: なし
```

**許容される PR 内容**（ホワイトリスト）:
- ✅ `package.json` version bump（minor/patch）
- ✅ TypeScript 型修正
- ✅ コメント追加・更新
- ✅ ドキュメント更新（.md ファイル）
- ❌ DB schema 変更
- ❌ API endpoint 削除
- ❌ 外部 API 鍵の追加

**GO/NO-GO 判定**:
| 結果 | 判定 | 次手 |
|-----|------|------|
| PR生成 + CI green + ホワイトリスト内 | ✅ GO | シナリオ③へ |
| PR生成 + CI red | 🟡 一時停止 | GitHub Actions ログ確認 → 修正 |
| PR未生成（Webhook失敗） | 🔴 NO-GO | LINE Webhook URL 再確認 |

**ロールバック**:
```bash
# 万一PR が生成されたら、手で閉じる
gh pr close <PR#> --delete-branch
```

**所要時間**: 10 分

---

### シナリオ③ : 自動マージ確認（中リスク・本番コード軽微変更）

**目的**: PR の CI が成功したら自動で main にマージされることを確認

**前提条件**:
- シナリオ② PR が存在（autoMerge=true に設定）
- PR 内の変更は低リスクホワイトリスト（ドキュメント更新など）

**実行手順**:
1. PR CI が passing 状態に達する（5～20 秒後）
2. kaizen-mado が GitHub API で `squash_merge()` を実行
3. PR が自動で merged 状態に変わる
4. ブランチが自動削除される

**期待結果**:
- auto-merge 実行: **CI green 検知から 30 秒以内**
- merge type: `squash`（1 commit に圧縮）
- main branch に新 commit 出現: **1 個**
- commit message: `[kaizen] <timestamp>` + kaizen-bot signature

**検証チェックリスト**:
```
□ PR ステータス: merged ✓ / マージ時刻: ___
□ 新しい commit が main に: ✓ / hash: ___
□ commit author: kaizen-bot ✓
□ 本番に影響がないか（サイト挙動確認）: ✓
□ 人的被害: なし
```

**本番影響確認**（ホワイトリスト内なら不要、念のため確認）:
```bash
# 本番サイト Vercel デプロイ確認
# → kaizen-mado.vercel.app でエラーなし
# → Google Chrome DevTools で JS console 無エラー
```

**GO/NO-GO 判定**:
| 結果 | 判定 | 次手 |
|-----|------|------|
| auto-merge 成功 + main デプロイ成功 | ✅ GO | シナリオ④へ |
| auto-merge 失敗（API error） | 🟡 手動マージ | `gh pr merge --squash` コマンド実行 |
| main デプロイ失敗 | 🔴 NO-GO | revert コマンド実行 |

**ロールバック**:
```bash
# 最新 commit を revert
git revert -n HEAD
git commit -m "revert kaizen auto-merge"
git push origin main
```

**所要時間**: 5 分

---

### シナリオ④ : 緊急停止（ロールバック）テスト（高リスク・リハーサル）

**目的**: ENV が OFF に設定されたら即座に進行中のワークフローがすべて停止することを確認

**前提条件**:
- シナリオ ①～③ が全て成功している

**実行手順**:

1. **Go → NG に切替**:
   ```bash
   # Vercel 環境変数を手で更新（または CLI で設定）
   vercel env set KAIZEN_AUTOPILOT off
   
   # または .env.local で
   KAIZEN_AUTOPILOT=off
   ```

2. **進行中のワークフロー停止確認**:
   - GitHub Actions ページを開く
   - 実行中の `kaizen-execute.yml` job が見つかれば、自動で status=**cancelled** になる
   - または 既に running なら 60 秒以内に stopped に変わる

3. **新規トリガーが無視されることを確認**:
   - 社長が LINE で新たに「GO」と返信
   - kaizen-mado が LINE メッセージを受信しても **無視** する（webhook log には記録されるが処理されない）

**期待結果**:
- 環境変数反映: Vercel **~ 30 秒**
- 進行中ワークフロー停止: **60 秒以内**
- 新規トリガー無視: **即座に**（データベースに記録されない）
- ユーザーへの通知: **ステータスメッセージのみ**（「一時停止中」）

**検証チェックリスト**:
```
□ 環境変数設定完了: ✓ / KAIZEN_AUTOPILOT=off 確認
□ GitHub Actions キャンセル確認: ✓ / status=cancelled 観測時刻: ___
□ Webhook 無視確認: ✓ / kaizen-mado ログで "processing disabled" メッセージ
□ ユーザー通知: ✓ / 「Kaizen は現在停止中です」
□ 人的被害: なし
```

**マジックワード（ロールバック手順）**:
```bash
# ① 環境変数を戻す
vercel env set KAIZEN_AUTOPILOT on

# ② 自動反映確認（~ 30 秒）
# → シナリオ ① からリスタート可能な状態に戻る

# ③ 念のため、GitHub Actions history をクリア（運用上のみ）
# → 不要（git log には記録される）
```

**所要時間**: 10 分（リハーサル）

---

## 本番テスト実行フロー

```
【Phase B テスト開始】
   ↓
【シナリオ①実行】LINE通知テスト
   ├→ 成功: 【シナリオ②へ】
   └→ 失敗: 【STOP】LINE API設定確認
   ↓
【シナリオ②実行】PR生成テスト
   ├→ 成功: 【シナリオ③へ】
   └→ 失敗: 【STOP】GitHub Actions ログ確認
   ↓
【シナリオ③実行】自動マージテスト
   ├→ 成功: 【シナリオ④へ】
   └→ 失敗: 【STOP】auto-merge 設定確認
   ↓
【シナリオ④実行】緊急停止テスト
   ├→ 成功: 【本番化 GO】
   └→ 失敗: 【STOP】ロールバック機能確認
   ↓
【本番化フェーズへ移行】
   ├→ 本番自動化 24h 監視
   ├→ エラー率 < 1%
   └→ 完了報告
```

---

## 合格基準（GO/NO-GO 判定）

### 本番化 GO 判定条件

すべての条件を満たす場合のみ GO：

| 項目 | 基準 | 実績 |
|-----|------|------|
| **シナリオ①** LINE 提案送信 | 5/5 成功・遅延 <5sec | ☐ |
| **シナリオ②** PR 生成 | 5/5 成功・遅延 <10sec・CI green | ☐ |
| **シナリオ③** 自動マージ | 3/3 成功・squash merge | ☐ |
| **シナリオ④** 緊急停止 | 即座に停止・新規トリガー無視 | ☐ |
| **エラー件数** | 本テスト全体で 0～1 件 | ☐ |
| **本番影響** | 人的被害ゼロ・稼働率 99%+ | ☐ |
| **ロールバック検証** | 60秒以内に完全復帰 | ☐ |

### 本番化 NO-GO 条件

いずれかに該当する場合は NO-GO（再テスト 必須）：

- ❌ LINE 通知の遅延が 5 秒超
- ❌ PR 生成失敗（webhook 未到達など）
- ❌ CI が failing で手が止まる
- ❌ 自動マージが実行されない
- ❌ 緊急停止が 60 秒超
- ❌ 本番サイトのエラー検出
- ❌ 人的ミス・手動対応が必要

---

## テスト実行チェックリスト

### 事前準備（テスト前日）

```
□ テスト用 Notion ノード用意（ID を確認）
  └ `/kaizen_dev ○○` コマンドで指定可能か
□ LINE Webhook URL が本番環境に設定されているか
  └ Vercel env で KAIZEN_LINE_WEBHOOK 確認
□ GitHub Actions 秘密鍵が本番に投入済み
  └ .github/workflows/kaizen-execute.yml のシークレット確認
□ GitHub branch protection が main に設定済み
  └ PR 経由のマージのみ許可
□ テスト実行者の LINE が admin 権限で登録済み
  └ LINE Notify の接続確認
□ テスト時間帯の予約（社長に伝達）
  └ 「7/5 14:00-14:30 カイゼンテスト実施」
```

### テスト実行当日

```
【Phase B テスト実行】

時刻: 14:00 ～ 14:30 JST
テスト実行者: 真田啓（開発部長）
監視者: 社長

--- シナリオ① : LINE 提案通知テスト ---
開始時刻: 14:00
□ 社長の Slack で `/kaizen_dev <testnode>` 発言
□ LINE に提案が 5 秒以内に到着
□ ✓ 成功 / ✗ 失敗
失敗時: LINE Notify API ログ確認
備考: ___________

--- シナリオ② : PR 生成テスト ---
開始時刻: 14:05
□ 社長が LINE で「GO」返信
□ GitHub Actions トリガー確認
□ PR が 10 秒以内に生成
□ ✓ 成功 / ✗ 失敗
失敗時: GitHub Actions ログ確認
備考: ___________

--- シナリオ③ : 自動マージテスト ---
開始時刻: 14:10
□ PR の CI 待機
□ CI green になったら自動マージ実行
□ main に新 commit 出現
□ ✓ 成功 / ✗ 失敗
失敗時: auto-merge 設定確認
備考: ___________

--- シナリオ④ : 緊急停止テスト ---
開始時刻: 14:20
□ KAIZEN_AUTOPILOT=off に設定
□ GitHub Actions キャンセル確認
□ 新規トリガー無視確認
□ ✓ 成功 / ✗ 失敗
失敗時: 環境変数反映確認
備考: ___________

終了時刻: 14:30
全テスト結果: ☐ GO / ☐ NO-GO / ☐ 部分 GO（詳細: ___)
```

---

## 成果物・トレーサビリティ

### テスト実行ログ（このファイル下部に追記）

```markdown
## テスト実行履歴

### Run #1 - 2026-07-05 14:00 JST
- 実行者: 真田啓
- 監視者: 社長
- 環境: Vercel 本番 kaizen-mado
- 結果: GO / NO-GO / 部分GO

#### シナリオ① 結果
- ✓ LINE 提案通知: 5/5 成功
- 遅延: 2.3sec / 2.8sec / 3.1sec / 2.5sec / 2.9sec
- 平均: 2.7 sec

#### シナリオ② 結果
- ✓ PR 生成: 5/5 成功
- PR# 一覧: #xxx, #xxx, #xxx, #xxx, #xxx
- CI ステータス: all passing
- ホワイトリスト: ✓ 確認済み

#### シナリオ③ 結果
- ✓ 自動マージ: 3/3 成功
- マージ完了時刻: 14:12:xx, 14:17:xx, 14:22:xx
- Commit hash: xxxxxx, xxxxxx, xxxxxx

#### シナリオ④ 結果
- ✓ 緊急停止: 成功
- キャンセル検知時刻: 14:25:xx
- 環境変数反映: 正常

#### 全体判定
- **GO / NO-GO**: ☐ GO
- エラー件数: 0
- 本番影響: なし
- 承認者サイン: 社長判子（日付）

### Run #2 - YYYY-MM-DD HH:MM JST
（以下同様に追記）
```

---

## トラブルシューティング

### LINE 通知が来ない

**症状**: Slack は受け取っているが、LINE に通知が来ない

**原因チェック**:
1. Vercel `KAIZEN_LINE_WEBHOOK` が正しい URL か？
   ```bash
   vercel env ls | grep KAIZEN_LINE_WEBHOOK
   ```
2. LINE Notify のクイック申し込み画面で「接続」されているか？
3. 社長の LINE が「個人」アカウントか「ビジネス」アカウントか？
   - → ビジネスアカウントは別途設定が必要

**修正**:
```bash
# env 再設定
vercel env rm KAIZEN_LINE_WEBHOOK
vercel env add KAIZEN_LINE_WEBHOOK
# → URL を再入力
```

---

### GitHub Actions が発火しない

**症状**: GO 返信しても GitHub Actions が実行されない

**原因チェック**:
1. Webhook が GitHub に正しく登録されているか？
   ```
   repo: kaizen-mado → Settings → Webhooks → 「Payload URL」確認
   ```
2. 秘密鍵が Vercel に設定されているか？
   ```bash
   vercel env ls | grep GITHUB_
   ```
3. `.github/workflows/kaizen-execute.yml` が存在するか？

**修正**:
```bash
# GitHub Webhook 再登録
gh webhook create --repo=<owner>/<repo> \
  --url=https://kaizen-mado.vercel.app/api/github/webhook \
  --events=pull_request
```

---

### PR が auto-merge されない

**症状**: PR が生成されるが、CI green でも merged にならない

**原因チェック**:
1. PR の autoMerge flag が true か？
   ```bash
   gh pr view <PR#> --json autoMerge
   ```
2. branch protection が main に設定されているか？
   - Required status checks: CI が緑でないとマージ禁止
3. API token が write 権限を持っているか？

**修正**:
```bash
# 手で auto-merge 設定
gh pr merge <PR#> --squash --auto
```

---

### 緊急停止が効かない

**症状**: KAIZEN_AUTOPILOT=off に設定したのに、ワークフロー が続行している

**原因チェック**:
1. 環境変数が本当に反映されているか？（Vercel は 30 秒ごとにポーリング）
   ```bash
   vercel env ls | grep KAIZEN_AUTOPILOT
   ```
2. キャッシュが残っていないか？
   ```bash
   vercel redeploy <deployment-id>
   ```

**修正**:
```bash
# Vercel 再デプロイ
vercel redeploy

# または GitHub Actions を手で cancel
gh run cancel <run-id>
```

---

## 参考資料

- **kaizen-mado リポ**: `C:\dev\kaizen-mado`
- **Phase A チェックリスト**: `DEPLOYMENT-CHECKLIST-V5.md`
- **LINE Notify API**: https://notify-bot.line.me/doc/ja/
- **GitHub Actions**: https://docs.github.com/en/actions

---

## 承認・サイン

| 役割 | 氏名 | 日付 | サイン |
|-----|------|------|--------|
| テスト実行 | 真田啓 | YYYY-MM-DD | ☐ |
| テスト監視 | 社長 | YYYY-MM-DD | ☐ |
| 本番化 GO | 開発部長 | YYYY-MM-DD | ☐ |

---

**作成日**: 2026-07-05  
**バージョン**: 1.0  
**ステータス**: Phase B テスト準備完了
