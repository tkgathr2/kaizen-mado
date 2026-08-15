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
| `KAIZEN_AUTOPILOT` | 旧・自動着手スイッチ（**2026-08-12 以降は無効**） | — | **どんな値を入れても自動着手は起きない**。社長指示（2026-08-12）で「重要度・危険度に関係なく全チケットが必ず社長のLINE確認を経由する」運用へ変更し、`/api/process` のオートパイロット分岐を廃止したため。`lib/gate.ts` の `autopilotEnabled()` は将来の再有効化のため残しているが、本番コードからは呼ばれていない |
| `KAIZEN_STUCK_MINUTES` | 「実装中」滞留をstuckとみなす分数 | `30` | 指定分で巻き戻し判定 |
| `KAIZEN_PUBLIC_BASE` | 窓口の公開ベースURL（callback/boardリンク生成用） | `https://kaizen.takagi.bz` | 指定URLでリンクを組み立てる |

#### 真田システム（mention-hisho）への受け渡し ★通知の本線・自前LINEフォールバックは全廃
2026-08-12 社長指示により、カイゼンくんが自前でLINE通知を出すのをやめ、用件は**真田のシステム（mention-hisho）へ受け渡す**。真田側が「真田宛メンションが来た状態」として扱い、既存の真田LINEカード（✅OK / ✏️修正 / 🚫却下 / 🛠ClaudeCodeへ送る）を社長へ出す。着手は社長が「🛠ClaudeCodeへ送る」を押したときに真田側から起きる。

2026-08-15 社長指示「カイゼンくんのLINEチャネルに一切来ない仕組みにして」により、**受け渡しに失敗したときの自前LINE（旧 `pushProposal`/`pushText`）へのフォールバックを全廃**した。失敗時は代わりに `lib/line.ts` の `notifySlackAlert`（真田Bot名義・persona-slack-relay経由・宛先はカイゼン監視チャンネル `C0BD5ESUFMM`＝社長＋幹部Botのみ）で警告するだけにし、社長に何も届かない無音状態は作らない。`pushProposal`/`pushText` 関数自体は緊急手段として `lib/line.ts` に残しているが、通常フローからは呼ばれない。

| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `MENTION_HISHO_BASE_URL` | 真田システムの本番ベースURL。受け口は `${BASE}/api/kaizen/handoff` | なし | 設定すると受け渡しが有効。**未設定なら受け渡しは不活性**＝Slack警告のみ |
| `KAIZEN_HANDOFF_SECRET` | 受け渡しの認証キー（`x-kaizen-handoff-secret` ヘッダで送る） | なし | **真田側（mention-hisho）と同じ値**を両方に入れる。片方だけだと相手が401で弾く |
| `KAIZEN_REPLY_SECRET` | `POST /api/kaizen/reply`（真田チャネルからの引用返信の書き戻し口）の認証キー（`x-kaizen-reply-secret` ヘッダで送る） | なし | **未設定ならこの口は503で無効化**（fail-closed）。真田側（mention-hisho）と同じ値を両方に入れる |

##### 詰まり連絡と引用返信（`awaitsReply` / `POST /api/kaizen/reply`）
詰まり連絡（`lib/notify.ts` `notifyStuckOnce`）は「社長の回答を必要とする」FYIのため、`handoffFyiToSanada(ticketId, text, {awaitsReply: true})` で送る。真田専用LINEチャネルのwebhookは自由文の返信を全部 Claude Code Routine 起動に使ってしまうため、社長には「このメッセージを引用返信（長押し→返信）で答えてください」と案内する（`buildStuckText`）。相手側（mention-hisho）は `awaitsReply:true` が付いた通知だけLINE送信後の `messageId` を控え、社長がその通知を引用返信したときに限り `POST /api/kaizen/reply` へ `{ticketId, replyText}` をPOSTしてくる。カイゼンくん側は `x-kaizen-reply-secret` を検証したうえでチケットを探し、議論ブロックへ「真田チャネルからの回答」として `replyText` を追記する（状態遷移や再実行はしない）。

Slack起点チケット（幹部Botへの app_mention から自動起票されたもの）は `slackChannel` / `slackThreadTs` も一緒に渡す。これが無いと真田側は合成ts（`kaizen:<ticketId>`）しか持てず、社長がカードの「✅OK」を押しても `invalid_thread_ts` で必ず失敗する（2026-08-12 実測・バグチェック High-2）。

##### 「真田実装中」状態 — 二重実装の防止（2026-08-12 バグチェック High-1）

社長が「🛠 ClaudeCodeへ送る」を押すと真田側の Claude Code が起動する。その直後に真田が書き戻す GO を
`{action:"go"}`（＝状態「着手」）にしていたため、**カイゼンくん側の自動改修が同じチケットをもう一度
Claude Code で実装**していた（2026-08-12 KZ-132 で実測。真田のセッションと同時に `kaizen-execute` が走行し、
Notion に `自動着手 実行ワークフローを起動` → `実装失敗（差し戻し）[IMPL_FAILED]` が残った。二重課金）。

対策として `POST /api/admin/go` は `executor` を受け取る。

| executor | 遷移先 | 意味 |
|---|---|---|
| 省略 / `"kaizen"` | `着手` | 従来どおりカイゼンくん自身が自動改修する（受け渡し失敗時の自前LINE→GOのフォールバック経路） |
| `"sanada"` | `真田実装中` | 真田側の Claude Code が既に起動済み。カイゼンくんの自動改修は**動かさない** |

**「経路が1本も残っていない」ことの根拠**：カイゼンくん側で自動改修を起こすのは `app/api/execute` だけで、
そこが対象を引くのは状態リテラルによる Notion クエリだけ（`fetchTicketsByState("着手")` と
reaper の `fetchStaleImplementing`→`fetchTicketsByState("実装中")`）。`真田実装中` はそのどちらにも現れず、
`/api/process`（`受付`）・`review-list`（`レビュー`）・`/api/admin/go`（`GO待ち`）にも現れない。
`lib/__tests__/sanadaExecutor.test.ts` がソースを機械検査して回帰を防ぐ。

> ⚠️ **前提**：Notion の「🔁 カイゼンくん 改善チケットDB」の `状態`（select）に選択肢 **`真田実装中`** が登録されていること（2026-08-12 登録済み）。
> Notion API は未登録の選択肢を**自動作成しない**（`Invalid select value for property "状態"` の 400 を返す）。
> 登録が無いと GO の書き戻しが 500 になり、チケットが「GO待ち」に取り残される（二重実装は起きない＝安全側だが進まない）。
> DBを作り直す・複製するときは必ず先に選択肢を追加すること。
`kz-sweep` だけは監視対象に含めるが**自動クローズはしない**（48hリマインドのみ）。

#### LINE通知（提案→GO の窓口・受け渡し失敗時のフォールバック）
| 変数 | 役割 | 既定 | 設定すると |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API のアクセストークン | なし | （3つ揃いで）提案をLINEへpush。未設定なら通知しない |
| `LINE_CHANNEL_SECRET` | LINE webhook 署名検証用シークレット | なし | webhook の署名検証が有効 |
| `LINE_TARGET_USER_ID` | 提案の送信先ユーザーID | なし | そのユーザーへ通知 |

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
