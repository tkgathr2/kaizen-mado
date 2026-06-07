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

### 必要な環境変数（`.env.local` / Vercel）
| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic APIキー（サーバ側のみ） |
| `ANTHROPIC_MODEL` | 任意。既定 `claude-sonnet-4-6` |
| `NOTION_TOKEN` | Notion内部インテグレーションのトークン。改善チケットDBに「接続」を共有しておく |
| `NOTION_DATABASE_ID` | `4771cbc4-06d3-4eb9-a30f-05058ca69bd7`（改善チケットDB） |
| `NOTION_DATA_SOURCE_ID` | `3385ed10-660e-4917-ae90-a279afd71626`（参照用） |

> secrets/.env・本番デプロイは**高木承認必須**（ハイブリッドの本番前ゲート）。

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
