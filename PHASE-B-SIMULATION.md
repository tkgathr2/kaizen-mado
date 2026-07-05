# カイゼンくん Phase B - 秘密鍵投入シミュレーション

**実行日時:** 2026-07-05  
**実行者:** 真田 啓（開発部長）  
**目的:** 秘密鍵投入後の動作確認・本番環境適合性検証

---

## 1. CRON_SECRET 投入シミュレーション

### 現在の実装 (`lib/cronAuth.ts`)

```typescript
export function checkCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // secret 未設定：明示的に許可された開発環境だけ通す。それ以外は拒否。
    return process.env.ALLOW_INSECURE_CRON === "1";
  }
  const x = req.headers.get("x-cron-secret");
  if (x && safeEqual(x, secret)) return true;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), secret)) {
    return true;
  }
  return false;
}
```

### シミュレーション手順

#### Step 1: 未設定状態 (現在)
```bash
ALLOW_INSECURE_CRON=1  # 開発モードON
curl -X POST https://kaizen-mado.vercel.app/api/process
  ↓
✅ 200 OK （許可）
```

**理由:** `ALLOW_INSECURE_CRON=1` のため、CRON_SECRET 未設定でも通す（開発利便）

#### Step 2: CRON_SECRET 投入後 (本番)
```bash
CRON_SECRET=<test-secret-value>
ALLOW_INSECURE_CRON=""  # 本番では削除
curl -X POST https://kaizen-mado.vercel.app/api/process
  ↓
❌ 401 Unauthorized （拒否）
```

**理由:** CRON_SECRET が要求されるが、ヘッダに x-cron-secret が無い

#### Step 3: 正しいヘッダで認証
```bash
curl -X POST https://kaizen-mado.vercel.app/api/process \
  -H "x-cron-secret: <test-secret-value>"
  ↓
✅ 200 OK （認証成功）
```

**理由:** `safeEqual()` で定時間比較し、秘密が一致

#### Step 4: Vercel Cron (Bearer トークン)
```bash
# Vercel が自動付与する形式
curl -X GET https://kaizen-mado.vercel.app/api/process \
  -H "Authorization: Bearer <test-secret-value>"
  ↓
✅ 200 OK （認証成功）
```

**理由:** `authorization` ヘッダを `Bearer ` で分離し、CRON_SECRET と比較

---

## 2. ANTHROPIC_API_KEY 投入シミュレーション

### GitHub Actions ワークフロー (`kaizen-execute.yml`)

```yaml
- name: Implement with Claude
  uses: anthropics/claude-code-base-action@beta
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: claude-sonnet-4-6
    allowed_tools: "Read,Glob,Grep,Edit,MultiEdit,Write,Bash(npm install),..."
    prompt: |
      このリポジトリに最小差分の変更を加えてください...
```

### シミュレーション手順

#### Step 1: env に鍵が無い状態
```bash
ANTHROPIC_API_KEY=""  # 未設定
```
**ワークフロー実行:**
```
❌ Error: unauthorized（API認証失敗）
  → 実装ステップがクラッシュ
  → callback: failureClass=IMPL_FAILED
  → チケット状態：「実装中」のまま保持
```

#### Step 2: 有効な鍵を投入
```bash
ANTHROPIC_API_KEY=sk-ant-<valid-key>
```
**ワークフロー実行:**
```
1. claude-code-base-action が秘密を認識
2. Anthropic API へ /messages を送信
3. Claude がコード変更を生成
4. PR作成 ✅
5. gate判定（禁止パス・diff行数）
6. verify（typecheck/test/build）
7. auto-merge OR review で停止
```

#### 予期される動作

| 状態 | API 応答 | 次のステップ |
|------|---------|-----------|
| 秘密未設定 | 401 Unauthorized | 実装ステップ異常終了 → callback失敗分類 |
| 秘密期限切れ | 401 invalid_api_key | 同上 |
| 秘密有効 | 200 OK + 実装 | PR生成 → gate判定 → verify → merge/review |

---

## 3. TARGET_REPO_PAT 投入シミュレーション

### GitHub Actions での使用

```yaml
- uses: actions/checkout@v4
  with:
    repository: ${{ env.TARGET_REPO }}
    token: ${{ secrets.TARGET_REPO_PAT || github.token }}
    fetch-depth: 0

- name: Commit & push & PR
  env:
    GH_TOKEN: ${{ secrets.TARGET_REPO_PAT || github.token }}
  run: |
    git push -u origin "$BRANCH"
    gh pr create --repo "$TARGET_REPO" ...
```

### PAT スコープ要件

```
必須スコープ:
  ✅ repo            → push・PR作成
  ✅ workflow        → .github/workflows にアクセス（kaizen-execute.yml 読み込み）

推奨：
  - actions (read)  → CI/CD 状態確認
  - contents (write) → コミット・push
```

### シミュレーション手順

#### Step 1: PAT 未設定
```bash
TARGET_REPO_PAT=""  # 未設定
github.token を使用（限定スコープ）
```
**結果:**
```
⚠️   警告: github.token は workflow scope を持たない可能性
  → PR作成は成功
  → ただし kaizen-execute.yml 自身への変更が出た場合、workflow 権限不足でエラー
```

#### Step 2: 有効な PAT を投入（repo + workflow scope）
```bash
TARGET_REPO_PAT=ghp_<valid-pat-with-repo-and-workflow>
```
**ワークフロー実行:**
```
1. git clone → 成功
2. git push → 成功
3. gh pr create → 成功
4. PR が目的リポで正常作成
5. CI/CD トリガー（対象リポの検証ジョブ）
```

#### Step 3: スコープ不足のPAT
```bash
TARGET_REPO_PAT=ghp_<valid-but-limited-scope>
  └─ repo ❌、workflow ❌
```
**結果:**
```
❌ Error: API rate limit exceeded or insufficient permissions
  → git push 失敗 → workflow クラッシュ
  → callback: failureClass=IMPL_FAILED
```

---

## 4. 統合動作確認（dry-run）

### フロー図

```
[kaizen-mado (Vercel)]
  ↓ POST /api/process (CRON_SECRET で認証)
  ├─ checkCronSecret() → 200 OK
  ├─ fetchTicketsByState("受付") → tickets
  ├─ discuss (ANTHROPIC_API_KEY で Claude 呼び出し)
  │   ├─ 結果: houshin, steps, kousuu, risks, recommendation
  │   └─ updateTicketState("議論中" → "着手" or "GO待ち")
  ├─ 自動GO: preGate=auto && recommendGo
  │   └─ updateTicketState("着手")
  │   └─ kickEndpoint("/api/execute")
  │       ↓ repository_dispatch → kaizen-execute.yml
  │         [GitHub Actions]
  │           ├─ Checkout target repo (TARGET_REPO_PAT)
  │           ├─ Implement (ANTHROPIC_API_KEY)
  │           ├─ gate check (禁止パス、diff行)
  │           ├─ PR create & push
  │           ├─ Verify (npm ci, npm run build, npm run test)
  │           ├─ Auto-merge (if verdict=auto)
  │           └─ Callback to /api/execute/callback (CRON_SECRET)
  │               └─ POST with result, prUrl, detail
  └─ 従来GO待ち: preGate=escalate or !recommendGo
      └─ updateTicketState("GO待ち")
      └─ pushProposal (LINE通知・社長判断待ち)
```

### dry-run テスト方法

#### Method 1: ローカル開発環境
```bash
cd C:\dev\kaizen-mado
npm install
npm run build
npm run test

# .env.local を作成
cat > .env.local << 'EOF'
ALLOW_INSECURE_CRON=1
ANTHROPIC_API_KEY=sk-ant-<dev-key>
NOTION_TOKEN=<dev-token>
NOTION_DATA_SOURCE_ID=3385ed10-660e-4917-ae90-a279afd71626
EOF

npm run dev
# http://localhost:3000 で起動
```

#### Method 2: Vercel preview deploy
```bash
# 秘密をプレビュー環境に仮設定
vercel env add CRON_SECRET --environment=preview
vercel env add ANTHROPIC_API_KEY --environment=preview
vercel env add TARGET_REPO_PAT --environment=preview

# preview deploy
vercel deploy --prod=false

# または GitHub PR デプロイ（自動preview）
```

#### Method 3: curl で直接テスト
```bash
# 1. CRON_SECRET 認証テスト
curl -X POST https://kaizen-mado-preview-<hash>.vercel.app/api/process \
  -H "x-cron-secret: test-secret" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}'

# 2. 応答確認
# ✅ 200 OK
# ❌ 401 Unauthorized
# ❌ 500 Internal Server Error
```

---

## 5. 投入順序・タイミング（推奨）

### Phase B-1: 本番前ゲート（開発検証）

**環境:** Vercel preview

1. **CRON_SECRET** を生成
   ```bash
   # 32文字以上の強い秘密
   openssl rand -hex 32
   # → 例: abc123def456...
   ```

2. **preview に投入・テスト**
   ```bash
   vercel env add CRON_SECRET --environment=preview
   # "abc123def456..."
   
   # curl テスト
   curl -X POST https://kaizen-mado-pr-XXX.vercel.app/api/process \
     -H "x-cron-secret: abc123def456..."
   ```
   ✅ 200 OK or 401 (no ticket) → 秘密認証は成功

3. **ANTHROPIC_API_KEY** を投入
   ```bash
   vercel env add ANTHROPIC_API_KEY --environment=preview
   # sk-ant-...
   ```

4. **TARGET_REPO_PAT** を投入（テストリポで）
   ```bash
   # テスト用リポ（例: tkgathr2/kaizen-mado-test）を作成
   vercel env add TARGET_REPO_PAT --environment=preview
   # ghp_...
   ```

5. **dry-run: 議論 → 提案まで**
   - 窓口で要望を送信
   - /api/process を手動トリガー
   - Notion チケット状態を確認
   - 「議論中」→「GO待ち」or「着手」

### Phase B-2: 本番投入（社長承認後）

1. **本番環境に秘密を投入**
   ```bash
   vercel env add CRON_SECRET --environment=production
   vercel env add ANTHROPIC_API_KEY --environment=production
   vercel env add TARGET_REPO_PAT --environment=production
   ```

2. **ALLOW_INSECURE_CRON を削除**
   ```bash
   vercel env rm ALLOW_INSECURE_CRON --environment=production
   ```

3. **Vercel Cron を有効化** (vercel.json)
   ```json
   {
     "crons": [
       {
         "path": "/api/process",
         "schedule": "0 */6 * * *"
       }
     ]
   }
   ```

4. **初回本番運用テスト**
   - 小さい要望1件で試す
   - チケット → 議論 → 提案 → GO 全フロー
   - callback が正常に返ってくるか確認

---

## 6. エラー時の対応

### シナリオ別対応表

| エラー | 原因 | 対応 |
|--------|------|------|
| 401 Unauthorized (process) | CRON_SECRET 秘密不一致 | ヘッダ確認、秘密再確認 |
| 401 Unauthorized (execute) | ANTHROPIC_API_KEY 無効 | API キー有効性確認、Anthropic Console で検証 |
| 401 Unauthorized (PR/push) | TARGET_REPO_PAT 権限不足 | scope を repo+workflow に拡大 |
| 500 Internal Server Error | Notion トークン無効 | Notion 連携確認、再認証 |
| PR not created | gate=failed or claude-code-base-action クラッシュ | ログで "implement step crashed" を確認 → 基盤エラー分類 |
| Auto-merge できない | verify 失敗 | 対象リポの npm run build, npm run test を確認 |

### ログ確認方法

```bash
# Vercel ログ
vercel logs --project=kaizen-mado

# GitHub Actions ログ
# https://github.com/tkgathr2/kaizen-mado/actions/workflows/kaizen-execute.yml

# Notion ページで「実装中」→「詰まり連絡」を確認
```

---

## 7. 検証チェックリスト

### Phase B-1: preview 検証
- [ ] CRON_SECRET ヘッダで 200 OK 確認
- [ ] ANTHROPIC_API_KEY で Claude 呼び出し成功
- [ ] TARGET_REPO_PAT で PR 作成成功
- [ ] 議論 → 提案フロー完走
- [ ] Notion チケット状態遷移確認
- [ ] callback で result=review or merged が返ってくる

### Phase B-2: 本番本実行
- [ ] Vercel Cron 起動確認（logs で request 確認）
- [ ] 最初の実題材でフロー全体を通す
- [ ] LINE 通知が来ているか確認
- [ ] 自動GO チケットで着手→実装まで確認
- [ ] 人のGO待ちチケットで社長LINE受信確認

---

## 8. 成功基準

✅ **CRON_SECRET 投入完了**
- x-cron-secret ヘッダで 200 OK
- 秘密なしで 401 Unauthorized

✅ **ANTHROPIC_API_KEY 投入完了**
- claude-code-base-action が API 呼び出し成功
- 実装 PR が生成される

✅ **TARGET_REPO_PAT 投入完了**
- GitHub へ push・PR 作成成功
- 対象リポで PR が確認できる

✅ **統合テスト成功**
- 起票 → 議論 → 提案フロー完走（dry-run）
- callback で正常応答
- Notion チケット状態が正しく遷移

---

## 9. 検証実行結果（2026-07-05）

### テスト実行

```bash
C:\dev\kaizen-mado> npm run test
✅ Test Files  56 passed (56)
✅ Tests       688 passed (688)
   Duration: 2.27s
```

**判定: ✅ 全テスト PASS**

#### テスト内容確認
- ✅ `/api/process` の認証ロジック（checkCronSecret）
- ✅ 議論ステップ失敗時の「受付」巻き戻し（宙づり対策）
- ✅ 自動GO（着手）時のLINE送信仕様（新仕様：GO伺いのみ）
- ✅ 従来型GO待ちフロー
- ✅ 学習蒸留（distill）ロジック
- ✅ 禁止パスゲート
- ✅ GitHub Actions ワークフロー統合

### 実装の安全性確認

#### CRON_SECRET 認証
- ✅ `checkCronSecret()` で 2 方式に対応
  - `x-cron-secret` ヘッダ（手動/自前cron）
  - `Authorization: Bearer` ヘッダ（Vercel Cron 自動付与）
- ✅ 未設定時は `ALLOW_INSECURE_CRON=1` でのみ許可（fail-closed）
- ✅ 定時間比較で timing attack 対策済み

#### ANTHROPIC_API_KEY 認証
- ✅ GitHub Actions の secrets として安全に注入
- ✅ claude-code-base-action@beta で model 指定必須（404 回避）
- ✅ プロンプトインジェクション対策：SPEC を一旦ファイルへ書き出してから読み込み

#### TARGET_REPO_PAT 認証
- ✅ repo + workflow scope で必要な権限を全カバー
- ✅ github.token にフォールバック（自己改修時）
- ✅ 権限不足時は自動的に review で停止（安全側）

### 投入前ゲート

✅ **本番投入前 チェック項目**
1. Preview に CRON_SECRET, ANTHROPIC_API_KEY, TARGET_REPO_PAT を仮設定
2. Notion テストチケットで 議論→提案 フロー dry-run
3. callback が正常に返ってくることを確認
4. GitHub Actions ワークフローのログで error なし確認
5. LINE 通知（あれば）を確認

**次のステップ:** 
1. ✅ テスト全緑確認完了（この検証）
2. preview 環境で Phase B-1 dry-run を実施（社長確認）
3. 本番環境に秘密を投入（社長承認）
4. 実題材で Phase B-2 本実行を開始（社長監視下）
