# 🛠️ カイゼン窓口（カイゼンくん 第1段）

現場・スタッフの声を、チャットでAIが深掘りし、Notion「改善チケットDB」へ自動起票するフィードバック受付窓口。

- 技術：Next.js（App Router）+ Vercel
- LLM：Anthropic API（**サーバ側ルート経由**。キーはクライアントに出さない）
- 起票：Notion API でデータソース `🔁 カイゼンくん 改善チケットDB` に `状態=受付` で1件作成
- 仕様：Notion「【CTO室 → Claude Code】カイゼンくん 実装引き継ぎ仕様書（第1段）」

## 会話の流れ（UX）
1. `?sys=` で対象システムを判定（未指定なら会話で特定）
2. AIが対象を確認 → 短い質問で1つずつ深掘り（何が／どの画面・操作で／どうしたいか）
3. 種別（bug/改善/新機能）・重要度（高/中/低）を会話から判定
4. 要約＋「最後に、この内容で送りますね。よろしいですか？」
5. ［この内容で送る］→ Notion起票 →「送りました（KZ-xxx）」→ 完了

API不通でも会話が止まらないフォールバック進行を内蔵（`lib/fallback.ts`）。

## ローカル実行
```bash
npm install
cp .env.example .env.local   # 値を埋める（.env.local はコミットされない）
npm run dev                  # http://localhost:3000/?sys=prorepo
```

### 環境変数 一覧（`.env.local` / Vercel）

このシステムが参照する**すべての**環境変数。未設定でも窓口は動く（後方互換）。鍵の無い機能は安全に不活性化する（fail-safe）。雛型は `.env.example`。

#### LLM（会話・要約）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | 会話を駆動する Anthropic APIキー（サーバ側のみ・クライアントに出さない） | なし | 本物のAI会話が有効。未設定だと簡易フォールバック会話で進む |
| `ANTHROPIC_MODEL` | 使用するClaudeモデル | `claude-sonnet-4-6` | 指定モデルで会話する |

#### 起票先（Notion 改善チケットDB）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `NOTION_TOKEN` | Notion内部インテグレーションのトークン（改善チケットDBに「接続」共有が前提） | なし | Notionへ自動起票が有効。未設定だと起票できない |
| `NOTION_DATA_SOURCE_ID` | 起票先データソース（🔁 カイゼンくん 改善チケットDB） | `3385ed10-660e-4917-ae90-a279afd71626` | そのデータソースへ起票 |
| `NOTION_DATABASE_ID` | 互換用フォールバック database_id（古いNotion APIで data source が使えない場合） | `4771cbc4-06d3-4eb9-a30f-05058ca69bd7` | data source 不可時にこのDBへ起票 |

#### 公開チャット(`/api/chat`) の濫用・コスト保護
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `KAIZEN_CHAT_RATE_PER_MIN` | 1分あたりの会話ターン上限（IP単位・プロセス内メモリ） | `20` | この上限を超えると `429`＋やさしい案内を返す。**best-effort**（サーバレスはインスタンス毎メモリのため厳密ではない） |
| `KAIZEN_CHAT_RATE_PER_HOUR` | 1時間あたりの会話ターン上限（IP単位） | `100` | 同上（長い窓の上限） |

#### 公開起票API(`/api/submit`) のCSRF/オリジン制御
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `KAIZEN_ALLOWED_ORIGINS` | 起票POSTを許可するオリジン（カンマ区切り） | **未設定＝全許可**（後方互換） | 該当オリジン以外は403。値は**窓口自身**（例 `https://kaizen.takagi.bz`）。下の注意必読 |

#### 認証（任意・Auth.js v5 / Google OAuth）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `AUTH_SECRET` | Auth.js のセッション署名鍵 | なし | （下記3つ揃いで）ログイン必須化 |
| `AUTH_GOOGLE_ID` | Google OAuth クライアントID | なし | 同上 |
| `AUTH_GOOGLE_SECRET` | Google OAuth クライアントシークレット | なし | **3つすべて揃った瞬間**に認証ON＝ログイン必須。1つでも欠けると認証OFF（完全公開） |
| `KAIZEN_ALLOWED_DOMAINS` | ログインを許可する会社ドメイン（カンマ区切り） | **未設定＝全Googleアカウント許可** | 該当ドメインのGoogleアカウントだけログイン可（例 `takagi.bz`） |

#### 改善ループ・自動実行の保護（cron系内部API）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `CRON_SECRET` | `/api/process`・`/api/execute` 等の内部API認証 | なし | 設定すると内部APIが保護される。**未設定は本番fail-closed**（401で不活性） |
| `ALLOW_INSECURE_CRON` | `CRON_SECRET` 未設定でも内部APIを通す逃がし弁 | なし | `1` のときだけ認証を通す（本番では使わない・開発/テスト用） |

#### 自動改修（GitHub Actions ディスパッチ）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `GITHUB_DISPATCH_TOKEN` | 対象リポへ改修ジョブを発火するトークン | なし | 「GO」で自動改修が走る。未設定なら発火しない（提案で停止＝赤運用） |
| `KAIZEN_ORCHESTRATOR_REPO` | 改修ジョブを起こすオーケストレータ・リポ | `tkgathr2/kaizen-mado` | 指定リポへディスパッチ |
| `KAIZEN_AUTOPILOT` | 自動着手の可否 | **未設定＝デフォルトON**（社長GO済の全自動運用） | `off`/`false`/`0` で自動着手を停止 |
| `KAIZEN_STUCK_MINUTES` | 「実装中」滞留をstuckとみなす分数 | `30` | 指定分で巻き戻し判定 |
| `KAIZEN_PUBLIC_BASE` | 窓口の公開ベースURL（callback/boardリンク生成用） | `https://kaizen.takagi.bz` | 指定URLでリンクを組み立てる |

#### LINE通知（提案→GO の窓口）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API のアクセストークン | なし | （3つ揃いで）提案をLINEへpush。未設定なら通知しない |
| `LINE_CHANNEL_SECRET` | LINE webhook 署名検証用シークレット | なし | webhook の署名検証が有効 |
| `LINE_TARGET_USER_ID` | 提案の送信先ユーザーID | なし | そのユーザーへ通知 |

#### GO待ち24時間超過アラート（Slack #カイゼンくん・開発チーム向け）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `SLACK_CH_KAIZEN_ALERT` | 通知先SlackチャンネルID | なし | `SLACK_BOT_TOKEN`（chat:write）と両方設定で毎朝8時JSTに `/api/cron/go-wait-alert` が投稿。片方でも未設定ならno-op |

#### ノウハウキング(knowhow) 連動
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `KNOWHOW_ENABLED` | 起票成功後に声を knowhow へ memorize（PIIマスク後） | `false` | `true` で蓄積ON |
| `KNOWHOW_API_BASE` | knowhow API のベースURL | `https://knowhow.up.railway.app` | 指定先へ送る |
| `KNOWHOW_PROJECT_KEY` | knowhow の project_key | `cto-lab` | そのプロジェクトへ記録 |
| `KB_API_KEY` | knowhow 認証キー（将来用） | なし | あれば付与して送信 |
| `KAIZEN_RECALL_ENABLED` | 要約確認時に類似ノウハウを参照して一言添える | `false` | `true` で類似引きON（失敗は無言スキップ） |

#### 学びの蒸留（distill・第2段の学習ループ）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `KAIZEN_DISTILL_ENABLED` | 完了チケットからの学び蒸留 | `false` | `true` で蒸留ON。プロバイダは鍵の有無で自動選択 |
| `KAIZEN_DISTILL_MODEL` | 蒸留に使う Anthropic モデル | 既定モデル | 指定モデルで蒸留 |
| `KAIZEN_DISTILL_OPENAI_MODEL` | 蒸留に使う OpenAI モデル | 既定モデル | 指定モデルで蒸留（OpenAI経路） |
| `KAIZEN_DISTILL_GEMINI_MODEL` | 蒸留に使う Gemini モデル | 既定モデル | 指定モデルで蒸留（Google経路） |
| `OPENAI_API_KEY` | 蒸留・要約の代替LLM（OpenAI） | なし | あればフォールバック先に使う |
| `GOOGLE_GENERATIVE_AI_API_KEY` | 蒸留・要約の代替LLM（Gemini） | なし | あればフォールバック先に使う |

> secrets/.env・本番デプロイは**高木承認必須**（ハイブリッドの本番前ゲート）。

> ⚠️ `KAIZEN_ALLOWED_ORIGINS` の注意：`widget.js` は窓口本体（`kaizen.takagi.bz/?embed=1`）を **iframe で開くだけ**なので、
> 起票POSTの `Origin` は埋め込み先ホストではなく **常に窓口自身（`kaizen.takagi.bz`）**。
> ここに各埋め込み先ホストのオリジンを設定すると実Origin（`kaizen.takagi.bz`）が許可されず**全窓口が403**になる。
> 設定するなら窓口自身のオリジンを入れること。

## システム別 窓口URL（`?sys=` スラッグ）
本番ドメインを `https://<domain>` とすると：

| システム | URL |
|---|---|
| プロレポ | `https://<domain>/?sys=prorepo` |
| ステレポ | `https://<domain>/?sys=sterepo` |
| ほうこちゃん | `https://<domain>/?sys=houko` |
| mfc-invoice-upload | `https://<domain>/?sys=mfc-invoice-upload` |
| Indeed応募通知 | `https://<domain>/?sys=indeed` |
| キャスト名簿くん | `https://<domain>/?sys=cast-meibo` |
| らくらく契約くん | `https://<domain>/?sys=rakuraku` |
| （未指定） | `https://<domain>/` → 会話で特定 |

スラッグ・正式名どちらでも受け付ける（`lib/systems.ts`）。

## 埋め込みフローティングウィジェット（widget.js）

各システムのHTMLに**1行**入れるだけで、画面右下にカイゼンくんのフローティングボタンが常駐し、
押すとその場にカイゼン窓口チャットのパネルが開く。

```html
<script src="https://kaizen.takagi.bz/widget.js" data-sys="prorepo" defer></script>
```

- `data-sys`：対象システムのslug（上表と同じ。省略すると会話で特定）
- `data-origin`：窓口オリジンの上書き（通常不要・ローカル検証用）
- Shadow DOM で描画するため埋め込み先のCSSと衝突しない。z-index は最前面級。
- パネル内は `/?embed=1&sys=…`（ヘッダー/フッターを畳んだコンパクト表示）
- パネル上部バーに「新しいタブで開く」「閉じる」あり。認証ON環境で iframe 内ログインが
  できない場合も新しいタブから利用できる。
- `middleware.ts` は `/widget.js` を認証対象から除外している（埋め込み先で読めなくなるため）。

## 構成
```
app/
  page.tsx            窓口チャットUI（?sys= を読む）
  layout.tsx          ルートレイアウト
  globals.css         スタイル
  api/chat/route.ts   会話1ターン（履歴→Claude→{reply,phase,ticket}）
  api/submit/route.ts confirm済みticketをNotion起票→{ticketId}
lib/
  types.ts            会話契約の型
  systems.ts          対象システムのマスタ／slug解決
  prompt.ts           システムプロンプト
  anthropic.ts        Anthropic呼び出し＋JSON厳密パース
  notion.ts           改善チケットDB起票
  fallback.ts         API不通時の簡易会話進行
```

## デプロイ（Vercel・要承認）
1. GitHubに新規リポジトリ（PII禁止リポとは無関係の新規リポ）でpush
2. VercelでImport → 環境変数を設定（上表）
3. Notionインテグレーションを改善チケットDBに「接続」共有
4. 本番URL発行後、各システムに窓口リンクを掲示

第2段以降（議論・自動着手・本番ゲート配線）は本スコープ外。
