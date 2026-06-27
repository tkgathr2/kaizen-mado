# 📋 カイゼンくん受付ゲートウェイ仕様書
**@真田/@早乙女へのSlackメッセージをカイゼンくんが受け取り、Slackで仕様確定→改善パイプライン投入→完了報告する**

**作成日**：2026-06-26
**版**：1.9（WEB申請=kaizen-mado本体も緊急度/重要度○/10・優先度バッジのカードUIに統一）
**対象**：mention-hisho (tkgathr2/mention-hisho) 拡張 + kaizen-mado 連携
**優先度**：P1
**前提**：mention-hisho は Railway 常駐 Node（Next.js App Router・singleton）。kaizen-mado は Vercel/Next.js App Router。

> **v1.3 改訂サマリ**：v1.2 は実コードを確認せず書いたため致命的な事実誤認があった。本版で全て実コードに照合して修正。主な修正＝①完了報告を「存在しない push webhook」から「既存 `GET /api/board` のポーリング」へ ②全ファイルパスを App Router (`app/api/**/route.ts`) に ③既存 detect フローとの干渉（社長への二重通知）を抑制設計 ④状態保存を Phase1 から Postgres 化 ⑤汎用化(§11.5)・自己進化(§11.6)を本体スコープから分離し将来章へ格下げ ⑥型定義3点を本文に明記。

---

## 1. 目的

@真田啓・@早乙女静 宛てに届いた「改善してほしい」メッセージを、**連絡を受けた本人（メンションされたその人格）がそのまま対応**し、Slackスレッドでの対話で要件を確定して、本人がカイゼンくん（kaizen-mado）へカイゼン要望を出してあげる。改修完了後は元のSlackスレッドへ報告する。専用の「受付係」キャラは作らない。

### 成功定義（測定可能な受入条件）
- ✅ @真田/@早乙女へのカイゼン要望メッセージを検知し、**かつ社長への二重通知（既存detectフロー）を発火させない**
- ✅ Slackスレッド内でペルソナ別の口調で要件ヒアリングが完結する
- ✅ 確定要件が `POST /api/submit` でカイゼンくんに登録され、`ticketId`（KZ-XXX）が返る
- ✅ カイゼンくんの改修完了を**ポーリングで検知**し、元スレッドへ報告する
- ✅ 一般メッセージ（挨拶・質問）を誤って受付ヒアリングに巻き込まない（誤検知時の離脱コスト＝1メッセージ以下）

---

## 2. 背景

### 現状の課題
- カイゼンくんは kaizen.takagi.bz のWebフォーム/`?sys=<slug>` URLからしか要望を受けない
- Slackで「直して」と言っても、誰かが手でカイゼンくんに転記する必要がある

### 解決方針
mention-hisho を拡張し「カイゼン受付モード」を追加。カイゼン要望と判定されたメッセージは、そのSlackスレッドでペルソナがヒアリングし、kaizen-mado の `/api/submit` へ投入する。**kaizen-mado 本体には改修を加えない**（連携は既存APIのみ使用）。

---

## 3. 要件

| ID | 要件 | 優先度 |
|---|---|---|
| REQ-1 | @真田/@早乙女宛のメッセージのうちカイゼン要望を検知する | P0 |
| REQ-2 | **カイゼン要望と判定したら、既存 `ingest()`/`notifyPresident()` を短絡し社長へ二重通知しない** | P0 |
| REQ-3 | 受付突入前に「カイゼン要望として受け付けますか？」を1回確認する（誤検知の離脱コスト最小化） | P0 |
| REQ-4 | スレッドでペルソナ別口調で「対象システム/問題詳細/種別/優先度」をヒアリングする | P0 |
| REQ-5 | 全項目確定後に確認メッセージ（収集値を全て反映）を送り「はい/OK」で確定する | P0 |
| REQ-6 | `POST /api/submit` で投入し `ticketId` をスレッドへ報告する | P0 |
| REQ-7 | カイゼンくんの改修完了を**ポーリング（`GET /api/board`）で検知**し、元スレッドへ報告する | P1 |
| REQ-8 | ペルソナごとに口調を一貫させる（真田=簡潔／早乙女=丁寧） | P0 |
| REQ-9 | 「やめる/キャンセル」で中断する | P1 |
| REQ-10 | 既存のメンション秘書くんの一般返信フローと共存する（署名検証後に分岐） | P0 |
| REQ-11 | カイゼン対象外（雑談/質問/相談）は早乙女が返答案を作り、社長へLINE確認→OK/修正/却下→返信する（既存メンション秘書くんフロー・§4.10） | P0 |
| REQ-14 | 一般返答もカイゼン受付も、社長のOK/修正/却下を教師信号に質を上げ続ける（§11.6 経験ループ） | P1 |
| REQ-12 | 同一スレッドのセッションは冪等に進む（Slack再配信・同時返信で二重遷移しない） | P0 |
| REQ-13 | `autoEligible:false` のシステムは「登録済・社長判断待ち」を明示し、無言放置しない | P1 |

---

## 4. システム設計

### 4.1 全体フロー

```
[ユーザー] @真田「プロレポのボタンが動かない」
    ↓ POST /app/api/slack/events （署名検証 → markSlackEventSeen で冪等化）
[mention-hisho]
    ↓ 1. classify：カイゼン要望 or 一般
    ↓   ├─ 一般 → 既存メンション秘書くんの返答フロー（§4.10）
    ↓   │        早乙女が返答案を作成 → 社長へLINEで確認 → OK/修正/却下 → OKで返信
    ↓   └─ カイゼン → ★ingest/notifyPresident を短絡（社長へ二重通知しない）
    ↓ 2. 本人が確認「カイゼン要望を出しておきましょうか？」
[ユーザー]「はい」
    ↓ 3. 本人がヒアリング（その人格の口調のまま）
[ユーザー]「プロレポ」「○○ボタンが500エラー」「優先度高」
    ↓ 4. 確認（収集値を全反映）→「はい」
    ↓ 5. POST {KAIZEN_BASE_URL}/api/submit → ticketId 取得
[mention-hisho]「カイゼン要望を出しておいた（KZ-123）」
    ↓ 6. ポーリングワーカーが GET /api/board を定期確認
[kaizen-mado] 改修パイプライン（議論→GO待ち→着手→PR）
    ↓ board 上で当該 KZ が「完了/差し戻し」へ
[mention-hisho]「KZ-123 完了。PR: ...」を元スレッドへ報告
```

### 4.2 アーキテクチャ（実コードに準拠）

**実装方針：mention-hisho の拡張。kaizen-mado 本体は無改修。**

```
mention-hisho/
├── app/api/
│   ├── slack/events/route.ts   ← 既存改変。署名検証後・ingest前にカイゼン分岐を挿入
│   └── cron/kaizen/route.ts    ← 新規。完了ポーリング（GET /api/board 突合）
└── lib/
    ├── kaizen/
    │   ├── classify.ts         ← 新規。カイゼン要望 or 一般判定（AI）
    │   ├── interview.ts        ← 新規。ヒアリング状態マシン
    │   ├── persona.ts          ← 新規。tone別メッセージ生成（+フォールバック）
    │   ├── store.ts            ← 新規。PgKaizenStore（既存 PgHenjiStore を流用）
    │   ├── submit.ts           ← 新規。/api/submit クライアント
    │   └── poll.ts             ← 新規。GET /api/board 突合ロジック
    └── types.ts                ← 既存改変。Kaizen系の型を追加
```

**既存資産の再利用（実コード確認済み）：**
- 署名検証・冪等化：`app/api/slack/events/route.ts` の `verifySlackSignature` ＋ `markSlackEventSeen(eventId)`
- 永続化：`lib/henji/store.ts` の `PgHenjiStore`（`DATABASE_URL` で Pg、無ければインメモリ。jsonb + ON CONFLICT RETURNING）。これを `PgKaizenStore` の雛形にする
- AI呼び出し：`lib/anthropic.ts`（`claude-opus-4-8`、plain fetch、失敗時フォールバック）
- 社長通知の既存発火点：`ingest(ev)` ＋ `notifyPresident(rec.id)`（events/route.ts 内）← ★ここをカイゼン時に短絡する

### 4.3 干渉抑制設計（REQ-2・最重要）

既存 `events/route.ts` は @幹部メンションごとに `ingest()` → `notifyPresident()` を**無条件で**発火する。カイゼン要望も同じメッセージなので、何もしないと社長へ二重通知が飛ぶ（＝Slackラリー増・禁止事項）。

**挿入点と短絡規則：**
```
events/route.ts:
  1) verifySlackSignature        （既存・変更なし）
  2) markSlackEventSeen(eventId) （既存・冪等化）
  3) ★classify(text, persona)   （新規挿入）
       - "kaizen" かつ受付確認OK → カイゼン受付フローへ。ingest/notifyPresident は呼ばない（return）
       - それ以外                → 既存どおり ingest()/notifyPresident()
```
- **E2E必須**：カイゼン分類されたメッセージで `notifyPresident` が**呼ばれないこと**をテストする（モックのcall数=0）。

### 4.4 カイゼン判定ロジック（classify）

```typescript
// lib/kaizen/classify.ts
function classify(text: string, persona: PersonaMeta):
  Promise<{ type: "kaizen" | "general"; confidence: number; reason: string }>
```
- **算出方式**：`lib/anthropic.ts` のLLMに「0.0–1.0 の confidence と type を JSON で返せ」と指示（プロンプト雛形を §6.5 に添付）。テスト時は LLM クライアントを DI で差し替え（固定レスポンス注入）。
- **閾値**：`confidence >= 0.7 → kaizen`。ただし **kaizen 判定でも即ヒアリングに入らず、REQ-3 の受付確認を必ず挟む**（誤検知の被害＝確認1問のみ）。
- カイゼン要望の例：「動かない」「エラー」「使いにくい」「〜できるように」「〜が遅い」。一般の例：挨拶・質問・報告・相談。
- **誤検知時の離脱**：受付確認に「いいえ」と答えれば即終了し、一般フローへも回さない（その回は何もしない）。

### 4.5 ヒアリング状態マシン

```
[idle]
  ↓ kaizen 検知
[confirm_intake]    ← 「カイゼン要望を出しておきましょうか？(はい/いいえ)」
  ├─ いいえ → [aborted]
  └─ はい
[asking_system]     ← 「どのシステムですか？」
  ↓
[asking_detail]     ← 「どんな問題ですか？」
  ↓
[asking_type]       ← 「バグ/改善/新機能？」（文脈で明らかなら省略）
  ↓
[assessing_priority] ← ★優先度は聞かない。本人が緊急度・重要度を各○/10で算出（§4.5.1）
  ↓
[confirming]        ← 「緊急度X・重要度Y → 優先度Z で出します。[システム]の[詳細]を[種別]で。いいですか？」
  ↓ 「はい/OK」（優先度に異議があればその場で直す）
[submitted]         ← POST /api/submit 実行、ticketId 取得
  ↓
[waiting_kaizen]    ← 「カイゼン要望を出しておいた（KZ-XXX）」報告。ポーリング監視対象に登録
  ↓ poll が完了/差し戻しを検知
[completed] / [rejected_by_president]
```

- **聞くのは system / detail / type の3つだけ**。**優先度はユーザーに聞かず、本人が緊急度×重要度から算出する**（§4.5.1）。
- **初回メッセージからの抽出**：`extractInitialFields(text): Promise<Partial<Collected>>`（LLM）で system/detail/type を抽出。**信頼度が高い項目のみ** 該当 `asking_*` をスキップ。ただし **`confirming` で全項目（抽出分・算出した優先度を含む）をユーザーに提示**する（誤抽出の素通り防止）。
- **自由文の正規化**：type はユーザーが「不具合」等と答えうる。受信時に `normalize(raw): value | null`（LLM or 辞書）で enum へ寄せる。失敗時は再質問。
- **中断**：どの状態でも「やめる/キャンセル/cancel」で `[aborted]`。
- **割り込み**：`confirming` 中に「はい/OK」以外が来たら「はい/いいえでお答えください」と再提示。`waiting_kaizen` 中の新規メッセージは新規セッション扱いにはせず、状況案内のみ返す。

### 4.5.1 優先度の自動算出（緊急度×重要度・本人が点数を出して通告／社長指示2026-06-27）

優先度を「高/中/低どれ？」とユーザーに聞かない。**聞き終えた内容から、本人（真田/早乙女）が緊急度と重要度を点数化し、優先度を決めて「これで行きますね」と通告**する（賢い対応＝§4.12 応答品質基準の一環）。

**スコアリング（各 ○/10・LLMがヒアリング内容から算出。ユーザーには「○/10」で見せる）：**

| 軸 | 9〜10（最大） | 5〜6（中） | 1〜2（最小） |
|---|---|---|---|
| 緊急度 Urgency | 今まさに業務が止まっている | たまに困る・回避策あり | 気になる程度 |
| 重要度 Importance | 売上・採用・法令・安全に直結／多人数が毎日使う | 一部業務に影響 | あれば嬉しい(nice-to-have) |

**優先度マッピング（合計20点満点・目安・運用で調整可）：**
- **高**：緊急度≥8 または 重要度≥8 で、かつ 合計≥14
- **中**：合計 8〜13
- **低**：合計 ≤7

**通告フォーマット（confirming で提示。点数は必ず ○/10 で見せる）：**
- 真田：「緊急度8/10・重要度9/10、優先度"高"で出す。プロレポの○○ボタン500エラーをバグとして。いいか？」
- 早乙女：「緊急度8/10・重要度9/10と判断しました。優先度"高"でカイゼン要望をお出しします。プロレポの○○の件です。よろしいでしょうか？」
- **算出根拠を1行添える**（「業務が止まる×全員が使う＝高」）。ユーザーが「いや低めで」と言えばその場で上書きできる（本人算出が既定・人手で微調整可）。

### 4.6 ペルソナ（レジストリ＝静的メタ／秘密はenv）

**責務分離（v1.2のenv二重定義を解消）：**
- レジストリ `PERSONA_REGISTRY`：**静的メタのみ**（key / displayName / tone / systemPrompt）。秘密や可変値は持たない。
- 実行時解決 `resolvePersona(key): ResolvedPersona`：token / slackUserIds / iconUrl を **env `PERSONA_<KEY>_*` から読む**（env が唯一の真実）。

```typescript
interface PersonaMeta {            // レジストリの静的定義
  key: string;                     // "sanada" | "saotome"
  displayName: string;
  tone: "concise" | "polite";      // v1 は2種のみ実装（warm/formal は将来）
  systemPrompt: string;            // AI生成用のキャラ指示
  classifyThreshold?: number;      // 既定 0.7 の上書き
}
interface ResolvedPersona extends PersonaMeta {
  slackUserIds: string[];          // env PERSONA_<KEY>_USER_IDS
  botToken: string;                // env PERSONA_<KEY>_BOT_TOKEN（未設定時 SLACK_BOT_TOKEN）
  iconUrl?: string;                // env PERSONA_<KEY>_ICON_URL
}
```
- **対応するのは本人（受付係キャラを作らない）**：メンションされた本人（真田なら真田、早乙女なら早乙女）が、自分の口調でそのまま対応する。「受付係」という別人格は登場しない。本人がユーザーに代わってカイゼンくんへ要望を出してあげる立て付け。
- **メンション→ペルソナ解決**：イベント宛先 user id を全ペルソナの `slackUserIds` で逆引き。一致した最初のペルソナを採用。
- **Bot送信方式**：単一 Bot を `chat:write.customize` で username/icon 上書き（virtual-sender 方式）でも、ペルソナ別 Bot でも可。env でトークンを分けられる設計。**対人送信のため、既存の名乗りカウンタ・virtual-sender ルールの適用要否を実装前に確認（Open Question O-1）**。

#### tone="concise"（真田・簡潔）フォールバック文面

| 状態 | 文面 |
|---|---|
| confirm_intake | 「カイゼン要望だな。出しておくか？(はい/いいえ)」 |
| asking_system | 「了解。どのシステム？」 |
| asking_detail | 「詳細は？エラーや再現手順があれば」 |
| asking_type | 「種別は？バグ/改善/新機能」 |
| assessing_priority | （聞かない・本人が緊急度×重要度を算出。§4.5.1） |
| confirming | 「緊急度X/10・重要度Y/10、優先度Zで出す。[システム]の[詳細]を[種別]で。いいか？」 |
| submitted | 「カイゼン要望を出しておいた（KZ-123）。カイゼンくんが処理する」 |
| completed | 「KZ-123 完了。[summary]\nPR: [url]」 |
| rejected_by_president | 「KZ-123 は今回見送り。必要なら作り直す」 |
| aborted | 「了解。またいつでも」 |

#### tone="polite"（早乙女・丁寧）フォールバック文面

| 状態 | 文面 |
|---|---|
| confirm_intake | 「カイゼンのご要望としてお出ししておきますが、よろしいでしょうか？(はい/いいえ)」 |
| asking_system | 「かしこまりました。どのシステムについてのご要望でしょうか？」 |
| asking_detail | 「ご不便をおかけしております。もう少し詳しく教えていただけますか？」 |
| asking_type | 「種別を教えていただけますか？バグ修正・機能改善・新機能追加のいずれかでしょうか？」 |
| assessing_priority | （聞かない・本人が緊急度×重要度を算出。§4.5.1） |
| confirming | 「緊急度X/10・重要度Y/10と判断しました。優先度Zでお出しします。○○の△△の件です。よろしいでしょうか？」 |
| submitted | 「カイゼン要望をお出ししておきました（KZ-123）。カイゼンくんが対応いたします」 |
| completed | 「KZ-123 の対応が完了いたしました。[summary]\n詳細：[url]」 |
| rejected_by_president | 「KZ-123 は今回見送りとなりました。必要でしたら改めて承ります」 |
| aborted | 「承知いたしました。またお声がけください」 |

- **AI動的生成**：上表は**フォールバック（決定的）**。通常は `generateMessage(persona, state, collected): Promise<string>` が tone × systemPrompt × 収集状態で文面を生成。**失敗（throw / 5秒超 / 空応答 / 学習無効env）時は上表に倒す**（degrade-safe）。

### 4.7 kaizen-mado への投入（実APIに準拠）

**POST {KAIZEN_BASE_URL}/api/submit**（既存API・無改修）

リクエスト：
```json
{
  "ticket": {
    "system": "プロレポ",
    "type": "bug",
    "title": "プロレポの○○ボタン500エラー",
    "detail": "ヒアリングで収集した詳細",
    "importance": "高"
  },
  "reporter": "発言者のSlack表示名"
}
```
- **Origin 必須**：kaizen-mado は `KAIZEN_ALLOWED_ORIGINS` で Origin ヘッダを検証する。投入時に `Origin: https://mention.takagi.bz` を明示付与し、§9.1 で kaizen-mado 側 allowlist に追加する（両方そろって初めて通る・単一の失敗点）。
- **type 値**：kaizen-mado の `TicketType = "bug" | "改善" | "新機能"` に合わせる（`bug` のみ英語）。`coerceTicket` が未知 type を「改善」・未知 importance を「中」に**黙って既定化**するため、正規化失敗値を送ると意図しない分類になる。よって正規化は mention-hisho 側で完結させる。
- **レスポンス**：成功 `{ ok:true, ticketId:"KZ-123", pageId:"..." }`。重複時 `{ ok:true, duplicate:true }`（200）。Notion失敗 `502`。Origin不許可 `403`。

### 4.8 完了報告（ポーリング方式・v1.2のpush webhookを廃止）

> **重大修正**：kaizen-mado に外向き webhook（`completionWebhookUrl`）は**存在しない**。callback は GitHub Actions が kaizen-mado 自身へ返す受信口（`x-cron-secret` 保護）であり、外部へ通知しない。さらに kaizen-mado は「完了FYIを自分から送らない」方針（GO伺いと詰まり連絡だけ）。よって push は使えず、**mention-hisho 側からのポーリング**で完了を検知する。

**`app/api/cron/kaizen/route.ts`（新規・Railwayの定期実行 or 既存cron基盤）：**
1. `waiting_kaizen` 状態のセッションを `PgKaizenStore` から列挙
2. 各 `ticketId` を `GET {KAIZEN_BASE_URL}/api/board`（既存・無認証）で突合
3. 状態が「完了/差し戻し」へ遷移していたら、ペルソナ口調で元スレッドへ1回だけ報告 → `[completed]`/`[rejected_by_president]` へ
4. **報告の冪等性**：報告済みフラグをセッションに持ち、二重報告しない
5. ポーリング間隔の目安：数分。長期未完了は打ち切らず案内のみ（改修は kaizen-mado 側の所掌）

**audience の整合**：受付スレッドへの完了報告は「**要望者本人向け**」。kaizen-mado が廃止したのは「**社長向けLINEのFYI**」。対象者が異なるため両立する（意図的）。

### 4.9 autoEligible:false の扱い（REQ-13）

`autoEligible:false`（外部SaaS等で自動改修しない）のシステムは、submit 後にカイゼンくんが社長LINE提案で止まり、board 上は「完了」に進まない。無言放置を避けるため：
- submit 直後の報告で「KZ-123 を登録。このシステムは社長判断後に対応します」と**着地点を明示**
- ポーリングは「完了」を待ち続けず、一定期間で「社長判断待ちのまま」を1回案内して監視終了

### 4.10 一般メッセージの返答フロー（雑談/質問/相談・既存メンション秘書くん連携／社長指示2026-06-27）

classify が「general」と判定したメッセージ（カイゼン要望でない雑談・質問・相談）は、**既存メンション秘書くん（mention-hisho）の返答フローに乗せる**。新規開発はせず、既存資産を使う。

**フロー（既存・実コードに準拠）：**
```
一般メッセージ検知
 → 早乙女が返答案を生成（lib/saotome.ts／generateDraft）
 → 社長へLINEで提案「こう返してよいですか？」（OK/修正/却下ボタン付き）
 → 社長の判断：
     OK   → 早乙女Bot名義でSlackスレッドへ返信（executed）
     修正 → 修正指示を反映して再生成（revising → 再提案）
     却下 → 返信しない（rejected）
```
- **設計の含意**：§4.3 の干渉抑制で「カイゼン時のみ ingest/notifyPresident を短絡」とした。**一般時は短絡せず、既存の `ingest`→返答案→LINE提案フローをそのまま通す**＝社長が言った「返答を考えて→LINEで確認→許可をもらう」はこの既存フローで満たされる。
- **新規実装はゼロ**：受付ゲートウェイは「一般と判定したら既存フローへ委譲する」だけ。返答生成・LINE提案・OK/修正/却下の各機構は mention-hisho に既存（[[project_mention_hisho_built]]）。
- **対人送信ガード**：実際のSlack返信は早乙女Bot名義（virtual-sender／名乗りカウンタ適用・O-1）。社長OKを得てから送る点は社長専管①対人送信に合致。

### 4.11 成長する仕組み（受付も返答も社長OK/修正/却下で学習・社長指示2026-06-27）

社長の「これもどんどん成長する仕組みに入れて」を反映。**カイゼン受付と一般返答の両方**を、社長の判断（OK/修正/却下）を教師信号にして質を上げ続ける。詳細設計は §11.6（経験ループ）。

| 学習対象 | 教師信号 | 蓄積先 | 次回の活かし方 |
|---|---|---|---|
| 一般返答の質 | 社長の OK / 修正内容 / 却下 | knowhow（既存の早乙女成長脳） | 似た相手・話題で recall し返答案に反映 |
| カイゼン分類の精度 | 受付確認の はい/いいえ・誤判定 | knowhow `project_key=kaizen-gateway` | 判定辞書・閾値を補強 |
| ヒアリングの省略 | 往復回数・聞きすぎ/聞き漏れ | 同上 | スキップ判定を強化 |

- 既存のメンション秘書くんは「早乙女に成長脳（OK/NGを教師信号に knowhow）」を持つ（[[project_mention_hisho_built]]）。本ゲートウェイの受付側も**同じ学習基盤に相乗り**する（新しい仕組みを作らない）。
- 学習で変えるのは「返答案・聞き方・分類」まで。**送信可否は必ず社長OKを通す**（暴走防止）。`KB_API_KEY` 未設定なら学習OFF・受付/返答は通常動作（degrade-safe）。

### 4.12 応答品質基準（Slack対話を"考え抜いた回答"レベルにする・社長指示2026-06-27）

Slackでの真田/早乙女のヒアリング・返答を、テンプレ的な一問一答で終わらせず、**相手の意図を汲み・先回りし・素人語で的確に返す賢い対話**にする。これは受付（カイゼン）も一般返答（§4.10）も共通の品質基準。

**7原則（generateMessage の systemPrompt に組み込む）：**
1. **相手の一言から背景・狙いを汲む**（「ボタンが動かない」→ 500エラーならサーバー側かも、と先読み）
2. **テンプレを並べず、文脈で聞く/省くを判断**（分かることは聞き返さない・初回文から抽出）
3. **素人にも分かる言葉・例え**で返す（専門用語は1行で補足）
4. **先回りの提案**（言われる前に「ついでにこれも」を1つ添える）
5. **1往復で要点を返す**（小出しにせずラリーを増やさない・[[feedback_never_increase_employee_workload_or_slack_rally]]）
6. **必要なら調べてから答える**（社内knowhow・過去事例を recall してから・§11.6）
7. **根拠を添えた的確さ**（優先度も §4.5.1 のスコアで根拠付き）

**before / after（同じ要望への応答）：**
```
【機械的（NG）】
真田「種別は？バグ/改善/新機能」
真田「優先度は？高/中/低」

【目指すレベル（OK）】
真田「プロレポの○○ボタンで500エラーですね。サーバー側の可能性が高いです。
　　 直前の操作だけ教えてもらえれば、こちらで切り分けてバグとして出します。
　　 業務が止まる範囲なら緊急度8/10・重要度9/10＝優先度"高"で出しますね」
```

**実装への落とし込み：**
- 各ペルソナの `systemPrompt`（§4.6）に上記7原則を明記し、`generateMessage` が常にこの基準で生成する。
- フォールバック文面（§4.6 の表）は"最低保証"。AI生成が動くときは7原則に沿ったより賢い文面を出す。
- 品質は §11.6 の経験ループで学習（社長OK/修正を教師信号に、良い聞き方・返し方を蓄積）。

### 4.13 メッセージUI（Slack Block Kit でカード表示・社長指示2026-06-27）

受付の「確認・通告・完了」は、プレーンテキストの吹き出しでなく **Slack Block Kit のカード**で見せる（モックで示した見た目を実装に落とす）。**絵文字は使わない**（CLAUDE.md準拠）。色・レイアウト・点数バッジで分かりやすさを出す。一般返答（§4.10）はプレーンテキストのまま。

**カード化する3場面：**

| 場面 | 見せ方 | 左バー色（attachment color） |
|---|---|---|
| confirming（優先度の通告＋確認） | 件名＋fields（緊急度○/10・重要度○/10・優先度・種別）＋根拠context＋ボタン | 優先度で 高=`#A32D2D`／中=`#BA7517`／低=`#5F5E5A` |
| submitted（受付完了） | 「カイゼン要望を出しました（KZ-XXX）」＋context | グレー |
| completed（改修完了） | 「KZ-XXX 完了」＋修正概要＋PRリンクボタン | 緑 `#0F6E56` |

**confirming カードの Block Kit（実装サンプル・絵文字なし）：**
```json
{
  "text": "緊急度8/10・重要度9/10、優先度「高」でカイゼン要望を出します。よろしいですか？",
  "attachments": [{
    "color": "#A32D2D",
    "blocks": [
      { "type": "section", "text": { "type": "mrkdwn",
        "text": "*カイゼン要望を出します*\nプロレポ ／ 申請ボタン500エラー（バグ）" } },
      { "type": "section", "fields": [
        { "type": "mrkdwn", "text": "*緊急度*\n8/10" },
        { "type": "mrkdwn", "text": "*重要度*\n9/10" },
        { "type": "mrkdwn", "text": "*優先度*\n高" },
        { "type": "mrkdwn", "text": "*種別*\nバグ" }
      ]},
      { "type": "context", "elements": [
        { "type": "mrkdwn", "text": "根拠：申請業務が止まる × 全員が毎日使う" } ]},
      { "type": "actions", "elements": [
        { "type": "button", "text": { "type": "plain_text", "text": "この内容で出す" },
          "style": "primary", "value": "confirm_submit", "action_id": "kz_confirm" },
        { "type": "button", "text": { "type": "plain_text", "text": "優先度を下げる" },
          "value": "lower_priority", "action_id": "kz_lower" },
        { "type": "button", "text": { "type": "plain_text", "text": "やめる" },
          "value": "abort", "action_id": "kz_abort" }
      ]}
    ]
  }]
}
```
- **`text` フィールド必須**：Slack の仕様で、Block Kit 非対応クライアント・通知プレビュー用に同内容のテキストを必ず入れる（フォールバック）。
- **ボタンの押下**＝Slack interactivity（`block_actions`）。新規エンドポイント `app/api/slack/interactivity/route.ts` で受信し、署名検証→該当セッションの状態を進める（confirm_submit→submitted／lower_priority→優先度を1段下げて再提示／abort→aborted）。
- **ボタンを使わず「はい」とテキスト返信しても同じく進む**（ボタンは任意の近道。状態マシンは両方受ける）。
- **完了カード**：`color: "#0F6E56"`、section に修正概要、PR は `button`（url 付き）で開けるように。
- **一般返答**：Block Kit を使わずプレーンテキスト（§4.10・早乙女の自然な会話）。

**前提（導入時）**：Slack App の Interactivity を有効化し Request URL を `/api/slack/interactivity` に設定（§9.1）。未設定ならボタンは表示せず「はい/いいえ」テキスト運用にフォールバック（degrade-safe）。

### 4.14 WEB申請（kaizen-mado 本体）も同じ体験に統一（社長指示2026-06-27）

もとのWEB申請（kaizen.takagi.bz）も、Slackと同じ「**緊急度 ○/10・重要度 ○/10・優先度 高/中/低**」のカードUIに揃える。**緊急度・重要度・優先度の3点はマスト**（確認画面に必ず出す）。**使えるものは流用**し、追加は最小にする。

> **スコープ注記**：これは kaizen-mado **本体**の改修（受付ゲートウェイ＝mention-hisho とは別リリース）。両者で **スコアリング基準（§4.5.1）とカードの見た目（§4.13）を共有**して、SlackでもWEBでも同じ申請体験にする。§4.2 の「kaizen-mado 無改修」は Slack受付ゲートウェイ機能に限った話で、本節は別途の本体改修と位置づける。

**現状（実コード確認済み）：**
- WEB申請は**チャット形式**（`app/page.tsx`）。AIと会話 → `phase:"confirm"` で確認カード表示 → `/api/submit` で起票。
- `Ticket` 型（`lib/types.ts`）は `system/type/title/detail/importance(高/中/低)`。**緊急度・点数の概念は無い**。

**変更点（最小・既存流用）：**

| 対象 | 変更 | 流用するもの |
|---|---|---|
| `lib/types.ts` | `Ticket` に `urgency`(1〜10)・`importanceScore`(1〜10)・`priority`(高/中/低) を追加。既存 `importance` は当面 `priority` のエイリアスとして残し移行 | 既存型をそのまま拡張 |
| チャットAI（`/api/chat`） | confirm 前に §4.5.1 の基準で緊急度・重要度を算出（ユーザーに優先度は聞かない） | 既存の会話フロー・confirm遷移 |
| 確認カード（`app/page.tsx`） | 既存の確認カードを §4.13 と同じ見た目に：緊急度 ○/10・重要度 ○/10・優先度バッジ＋根拠＋[この内容で送信]/[優先度を下げる]/[修正] | 既存の確認カード枠・tailwind・ボタン |
| `/api/submit` | `urgency/importanceScore/priority` を受け取り Notion に保存（DBプロパティ追加） | 既存 submit・dedup・origin チェック |
| board / dashboard | 一覧に優先度バッジ＋点数を表示 | 既存 `app/board/page.tsx`・`app/dashboard/page.tsx` |

**マスト要件：**
- 確認画面に必ず「緊急度 ○/10・重要度 ○/10・優先度（高/中/低バッジ）」を出す。
- 優先度は §4.5.1 のマッピングで算出（高=どちらか8以上＆合計14以上／中=8〜13／低=≤7）。算出根拠を1行添える。
- 優先度バッジ色は §4.13 と同じ（高=赤系／中=橙系／低=灰系）。**絵文字は使わない**。

**UI（WEBの確認カード・tailwind イメージ）：**
- Slackの Block Kit と同じ情報配置：件名（システム／タイトル）→ 緊急度・重要度・優先度・種別の4項目 → 根拠 → アクションボタン。
- 既に確認カードの枠・スクロール追従・二重送信ガードがあるので、**中身（点数表示部分）を足すだけ**で済む。

**後方互換：**
- 既存チケット（urgency 無し）は `importance(高/中/低)` から優先度を表示し、点数は「—」または推定値（高→緊急度/重要度を高めに補完）で見せる。新規申請から点数が入る。

**変更ファイル（kaizen-mado 本体・別リリース）：**
`lib/types.ts` / `app/api/chat/route.ts` / `app/api/submit/route.ts` / `app/page.tsx`（確認カード）/ `app/board/page.tsx` / `app/dashboard/page.tsx` / Notion DB プロパティ追加。スコアリング基準は §4.5.1 を唯一の正とし、Slack受付（mention-hisho）と文言・閾値を合わせる。

---

## 5. インターフェース仕様

### 5.1 完了ポーリング（GET /api/board 突合）
- 入力：`waiting_kaizen` セッションの ticketId 群
- 取得：`GET {KAIZEN_BASE_URL}/api/board`（既存）
- 突合：ticketId をキーに状態判定。「完了」「差し戻し（却下）」を終端とする
- 出力：終端到達分のみスレッド報告（冪等・1回）

### 5.2 エラーハンドリング

| 事象 | 対応 |
|---|---|
| `/api/submit` 502 | 3回リトライ（指数バックオフ 1s/2s/4s）。なお重複 `duplicate:true`(200) は再送しない |
| `/api/submit` 403 | **config エラー**として扱う（Origin allowlist 未設定）。社長へ運用通知し、ユーザーには「登録できませんでした」 |
| `/api/submit` 400 | 「登録できませんでした。お手数ですが内容を変えて再度お知らせください」 |
| 無応答 30分 | セッションを `[aborted]` にリセット。「タイムアウトしました。またどうぞ」 |
| board が長期未完了 | 打ち切らず「対応中/社長判断待ち」を1回案内。改修は kaizen-mado 所掌 |
| classify の LLM 失敗 | 安全側＝「general」扱い（受付に巻き込まない）。フォールバック文面は使わない |

### 5.3 タイムアウトの2概念（v1.2の矛盾を解消）
- **無応答タイムアウト＝30分**：ヒアリング途中で返信が途絶えたらリセット
- **セッションTTL＝24時間**：GC（古いセッションの掃除）。両者は別概念

---

## 6. 実装仕様

### 6.1 新規ファイル一覧（App Router 準拠）

| ファイル | 役割 |
|---|---|
| `app/api/cron/kaizen/route.ts` | 完了ポーリング（GET /api/board 突合・終端報告） |
| `app/api/slack/interactivity/route.ts` | Block Kit ボタン（block_actions）受信。署名検証→状態を進める（§4.13） |
| `lib/kaizen/blocks.ts` | Block Kit メッセージ生成（confirming/submitted/completed カード・§4.13） |
| `lib/kaizen/classify.ts` | カイゼン要望 or 一般判定（AI・DI可能） |
| `lib/kaizen/interview.ts` | 状態マシン制御 |
| `lib/kaizen/persona.ts` | tone別メッセージ生成（+フォールバック表） |
| `lib/kaizen/store.ts` | `PgKaizenStore`（既存 PgHenjiStore 流用） |
| `lib/kaizen/submit.ts` | /api/submit クライアント（Origin付与・リトライ） |
| `lib/kaizen/poll.ts` | board 突合ロジック |

### 6.2 既存ファイルの変更

| ファイル | 変更内容 |
|---|---|
| `app/api/slack/events/route.ts` | 署名検証後・`markSlackEventSeen`後・`ingest`前に classify 分岐を挿入（§4.3） |
| `lib/types.ts` | KaizenState / KaizenSession / PersonaMeta / Collected / Ticket 型を追加 |

### 6.3 環境変数（追加）

| 変数名 | 必須 | 説明 | 未設定時 |
|---|---|---|---|
| `KAIZEN_BASE_URL` | ✅ | kaizen-mado の URL | https://kaizen.takagi.bz |
| `KAIZEN_SUBMIT_ORIGIN` | ✅ | submit 時に付与する Origin（kaizen側 allowlist と対） | mention.takagi.bz |
| `PERSONA_<KEY>_USER_IDS` | ✅ | そのペルソナ宛と判定する Slack user id（カンマ区切り） | レジストリ既定 |
| `PERSONA_<KEY>_BOT_TOKEN` | ❌ | ペルソナ別 Bot トークン | SLACK_BOT_TOKEN を流用 |
| `PERSONA_<KEY>_ICON_URL` | ❌ | ペルソナのアイコン | デフォルト |
| `DATABASE_URL` | ✅ | PgKaizenStore 用（既存と共用） | インメモリ（本番非推奨） |
| `GATEWAY_LEARNING_ENABLED` | ❌ | 自己進化（将来・§11.6）のON/OFF | off |
| `KB_API_KEY` | ❌ | knowhow recall/memorize（将来・§11.6） | 学習OFF |

### 6.4 型定義（本文に明記）

```typescript
type KaizenState =
  | "confirm_intake" | "asking_system" | "asking_detail" | "asking_type"
  | "assessing_priority" | "confirming" | "submitted" | "waiting_kaizen"
  | "completed" | "rejected_by_president" | "aborted" | "timeout";

interface Collected {
  system?: string;
  detail?: string;
  type?: "bug" | "改善" | "新機能";
  // 優先度はユーザーに聞かず本人が算出（§4.5.1）。点数は ○/10 で提示
  urgency?: number;                 // 緊急度 1〜10（LLM算出）
  importanceScore?: number;         // 重要度 1〜10（LLM算出）
  priority?: "高" | "中" | "低";    // urgency+importanceScore（20点満点）から導出
  priorityReason?: string;          // 算出根拠1行（confirmingで提示）
}

interface KaizenSession {
  id: string;                 // UUID
  channelId: string;
  threadTs: string;           // 一意キー = channelId + threadTs
  personaKey: string;         // resolvePersona のキー
  reporterUserId: string;
  reporterName: string;
  state: KaizenState;
  collected: Collected;
  ticketId?: string;          // KZ-XXX
  pageId?: string;
  reported?: boolean;         // 完了報告の冪等フラグ
  lastEventId?: string;       // Slack 再配信の冪等化
  createdAt: string;          // ISO8601
  updatedAt: string;
}
```
- **永続化**：`PgKaizenStore`（`DATABASE_URL` 必須）。jsonb 1行/セッション、`channelId+threadTs` を unique キーに `ON CONFLICT ... RETURNING` で atomic upsert。**Railway 常駐でもデプロイで揮発するため、インメモリは Phase1 から不採用**（既存 PgHenjiStore と同じ判断）。
- **冪等性**：状態遷移は `lastEventId` と `markSlackEventSeen` で Slack 再配信を弾く。read-modify-write は upsert で atomic に。

### 6.5 AIメッセージ生成・分類の仕様
- **モデル**：既存 `lib/anthropic.ts`（`claude-opus-4-8`、plain fetch、失敗時フォールバック）を流用。マルチエージェント不要のため素のSDK/fetchでよい（CLAUDE.md 例外条項）。
- **classify プロンプト雛形**：
  ```
  あなたは社内システムへの「改善要望か否か」を判定する分類器。
  次のSlack発言を分類し、JSONのみ返す：{"type":"kaizen"|"general","confidence":0.0-1.0,"reason":"..."}
  kaizen=バグ/不具合/使いにくさ/機能追加/改善依頼。general=挨拶/質問/報告/相談。
  発言：「{text}」
  ```
- **generateMessage**：`(persona, state, collected) → 1メッセージ(プレーンテキスト)`。systemPrompt にペルソナ指示、user に「今の状態と既収集値、次に聞くこと」を渡す。出力はプレーンテキスト1通固定。
- **テスト**：classify/generate とも LLM クライアントを **DI** で差し替え、固定レスポンスで決定的に検証。

---

## 7. テスト計画

### 7.1 ユニットテスト（Gherkin・LLMはモック注入）

```gherkin
Feature: カイゼン判定と干渉抑制

  Scenario: バグ報告をカイゼン判定する
    Given LLMモックが {type:"kaizen", confidence:0.9} を返す
    And テキスト "プロレポのボタンでエラー"
    When classify を実行する
    Then type == "kaizen"

  Scenario: カイゼン判定時に社長通知を発火しない（REQ-2）
    Given カイゼン分類かつ受付確認OK
    When events ハンドラを実行する
    Then notifyPresident の呼び出し回数 == 0
    And ingest の呼び出し回数 == 0

  Scenario: 一般メッセージは既存フローへ
    Given LLMモックが {type:"general"} を返す
    When events ハンドラを実行する
    Then 既存 ingest が呼ばれる

  Scenario: 誤検知時の離脱は1メッセージ（REQ-3）
    Given confirm_intake 状態
    When ユーザーが "いいえ"
    Then state == "aborted" かつ 以後質問しない

Feature: 冪等性（REQ-12）

  Scenario: Slack 再配信で二重遷移しない
    Given asking_system 状態・event_id="E1" を処理済み
    When 同じ event_id="E1" が再配信される
    Then 状態は進まない（markSlackEventSeen で弾く）

Feature: ペルソナ口調（フォールバックに対して検証）

  Scenario: 真田の確認文（決定的フォールバック）
    Given persona=sanada, state=asking_system, AI生成は無効
    When generateMessage を実行する
    Then フォールバック文面 "どのシステム" を含み 文字数 < 30
```

### 7.2 E2E シナリオ

| # | シナリオ | 期待結果 |
|---|---|---|
| 1 | @真田「プロレポのバグ」→受付確認→4問→確認→submit | KZ-XXX 報告・**社長通知ゼロ** |
| 2 | @早乙女「○○が遅い、緊急、プロレポ」（複数情報） | 抽出済み項目はスキップ・confirming で全値提示 |
| 3 | ヒアリング中「やめる」 | aborted・以後沈黙 |
| 4 | @真田「おはようございます」 | 一般フロー（既存）へ・受付に入らない |
| 5 | ポーリングで board が「完了」検知 | 元スレッドへ完了報告（1回・冪等） |
| 6 | submit が 403（Origin未設定） | config エラー扱い・社長へ運用通知 |
| 7 | autoEligible:false のシステム | 「社長判断後に対応」を明示・無言放置しない |

---

## 8. 実装順序（Phase）

### Phase 0（型・土台）
1. `lib/types.ts` に Kaizen系の型を定義（§6.4）
2. `lib/kaizen/store.ts`：`PgKaizenStore`（既存 PgHenjiStore を雛形に・Pg必須）

### Phase 1（コア受付・P0）
3. `lib/kaizen/classify.ts`（DI可能・LLMモック前提）
4. `lib/kaizen/persona.ts`（フォールバック表＋AI生成）
5. `lib/kaizen/interview.ts`（状態マシン）
6. `app/api/slack/events/route.ts` に分岐挿入（§4.3・干渉抑制）
7. `lib/kaizen/submit.ts`（Origin付与・リトライ）
8. ユニット＋E2E（シナリオ1〜4, 6）

### Phase 2（完了報告・P1）
9. `lib/kaizen/poll.ts` ＋ `app/api/cron/kaizen/route.ts`（ポーリング）
10. E2E（シナリオ5, 7）

> §11.5（汎用化）・§11.6（自己進化）は**本リリースのスコープ外**。Phase 1–2 完了・実運用で効果検証してから、別途 Phase 3 以降で検討する（理由は各章）。

---

## 9. 導入手順

### 9.1 事前準備
1. kaizen-mado の `KAIZEN_ALLOWED_ORIGINS` に `https://mention.takagi.bz` を追加（§4.7 の Origin と対）
2. mention-hisho に env 追加：`KAIZEN_BASE_URL` / `KAIZEN_SUBMIT_ORIGIN` / `PERSONA_<KEY>_USER_IDS` / `DATABASE_URL`（既存と共用）
3. ペルソナ Bot の表示名・アイコン方式（virtual-sender か別Bot）を確定し token を設定
4. **Slack App の Interactivity を有効化**し Request URL を `https://mention.takagi.bz/api/slack/interactivity` に設定（§4.13 のボタン用）。未設定なら「はい/いいえ」テキスト運用にフォールバック

### 9.2 verify-as-user（本番確認）
1. テストチャンネルで @真田 を含む改善要望を投稿
2. 受付確認→4問ヒアリング→確認→「はい」で KZ-ID が返ることを確認
3. **社長へ二重通知が飛んでいないこと**を確認（最重要）
4. kaizen.takagi.bz の board に当該チケットが載ることを確認
5. 改修完了後、ポーリングで元スレッドに完了報告が来ることを確認

---

## 10. 運用ルール
- セッション一意キー＝`channelId + threadTs`。無応答30分でリセット、TTL24hでGC
- スレッド返信は必ず `thread_ts` 指定でスレッド内に
- 実際の改修は kaizen-mado の既存パイプラインが担当（mention-hisho はゲートウェイのみ）
- ポーリングは Railway 常駐の定期実行 or 既存 cron 基盤に相乗り

---

## 11. FAQ

**Q1: @真田と@早乙女で結果は変わる？**
A：チケット内容は同じ。ヒアリングの口調だけペルソナで変わる。

**Q2: 誤判定でヒアリングに入りそうになったら？**
A：受付突入前に必ず「受け付けますか？(はい/いいえ)」を挟むので、「いいえ」で即終了。被害は確認1問のみ。

**Q3: autoEligible:false のシステムは？**
A：チケットは登録されるが自動改修は走らず社長LINE提案で止まる。受付スレッドには「社長判断後に対応」と明示し、無言放置しない（REQ-13）。

**Q4: 完了報告はなぜ push でなくポーリング？**
A：kaizen-mado に外向き webhook が無く、完了FYIを自分から送らない方針のため。既存の `GET /api/board` を突合する方式が、kaizen-mado 無改修で実現できる唯一の正攻法。

---

## 11.5 将来拡張：汎用化（本リリース対象外・参考）

> v1.2 で Phase1 に含めていたが、レビューで「2ペルソナ/1投入先/1チャネルに対する過剰設計」「具体型と矛盾」と判定。**本リリースから外し、将来の参考設計として残す**。実需が出た時点で着手する。

将来、受付窓口を全11幹部へ・投入先を Backlog 等へ・受信を LINE/メールへ広げたくなったら、以下の seam を1つずつ導入する（最初から全部作らない）：
- **ペルソナ**：`PERSONA_REGISTRY` に静的メタを追加（§4.6 は既にこの形）
- **投入先**：`submit()` を `interface KaizenSink { submit(t:Ticket):Promise<{ticketId:string}> }` に抽象化し sink を差し替え（型は実需時に確定）
- **チャネル**：Slack 受信を `IncomingMessage` へ正規化する intake アダプタを足す
- **ヒアリング項目**：`InterviewSchema`（項目配列）から状態列を生成する方式に変える ※この時 `KaizenState` の固定 union は廃止になる

**注意**：現行の `KaizenState`（固定 union）と `Collected`（kaizen-mado の enum 直結）は**意図的に具体**。汎用化はこれらを置き換える破壊的変更になるため、別バージョンで設計する。

---

## 11.6 将来拡張：自己進化（本リリース対象外・安全性要設計）

> 「経験から学ぶ」「ネットで新知識を取り込む」構想。レビューで **(a) 学習信号（完了結果）が本リリースのポーリングでようやく取れる段階 (b) ネット検索結果を `ticket.detail` に流すのは自動改修パイプラインへの注入経路で危険** と判定。**本リリースから外す**。

将来導入する場合の安全な形：
- **経験ループ（Reflexion型）のみ先行**：往復回数・却下/修正の有無を knowhow（`project_key=kaizen-gateway`）へ memorize、着手前に recall。学習で変えるのは「聞き方・判定閾値」までに限定。`KB_API_KEY` 未設定なら自動OFF（degrade-safe）。失敗は握り潰し。
- **一般返答も同じループで学習（§4.11）**：雑談/質問/相談への返答案は、社長の OK/修正/却下 を教師信号に既存の早乙女成長脳（knowhow）へ蓄積。次回は似た相手・話題で recall して返答案に反映。**送信は必ず社長OKを通す**（学習しても暴走しない）。
- **ネット検索（Agentic RAG）は受付に載せない**：外部知識の取得・取り込みは**改修側（kaizen-mado 本体）の所掌**とし、受付ゲートウェイから `ticket.detail` へ外部テキストを注入しない（プロンプトインジェクション/サプライチェーン防止）。
- **参考にした研究**：Reflexion（自己反省をメモリ化＝しくじり先生と同思想）、SAGE（忘却曲線でメモリ新陳代謝）、Dual-Process Agent（速い応答＋遅い反省）、Agentic RAG（検索要否の自律判断）。いずれも本リリースでは未実装。

---

## 12. ブラッシュアップ記録

### v1.3 改訂（独立3レビュー＋実コード照合）
critic / architect / code-reviewer の独立レビューで、v1.2 が実コード未確認による事実誤認を含むと判明。実コード（kaizen-mado / mention-hisho）に照合して以下を修正：

| 指摘 | 深刻度 | 対応 |
|---|---|---|
| 完了 push webhook (`completionWebhookUrl`) は実在しない | 🔴 | ポーリング（GET /api/board）へ全面変更（§4.8） |
| ファイルパスが App Router 不一致 | 🔴 | 全て `app/api/**/route.ts` に修正 |
| 既存 detect フローと干渉（社長へ二重通知） | 🔴 | classify=kaizen で ingest/notifyPresident 短絡（§4.3・REQ-2） |
| インメモリ前提が Railway/サーバーレスで破綻 | 🔴 | Phase0 から PgKaizenStore（既存流用・§6.4） |
| §11.5 汎用化が過剰・具体型と矛盾 | 🟡 | 本リリースから除外し将来章へ（§11.5） |
| §11.6 自己進化の学習信号欠如・注入リスク | 🔴 | 本リリースから除外。ネット検索は受付に載せない（§11.6） |
| 型定義3点・AI生成仕様・persona責務が未定義 | 🔴 | 本文に型とプロンプトを明記（§6.4/§6.5/§4.6） |
| 誤検知の離脱コスト・タイムアウト2概念の矛盾 | 🟡 | 受付確認を追加（REQ-3）・30分/24hを分離（§5.3） |

### 4次元チェック結果（v1.3）

| 次元 | 結果 | 確認内容 |
|---|---|---|
| 曖昧性 | ✅ Green | 状態マシン・干渉短絡点・正規化・確認ステップが一意 |
| テスト実行性 | ✅ Green | LLM をDIでモック・社長通知ゼロ等が客観判定可能 |
| 実装可能性 | ✅ Green | App Router 準拠・型/プロンプト明記・既存資産の流用先を特定 |
| 運用性 | ✅ Green | ポーリング・冪等報告・403=config・autoEligible:false 対応 |

**最終判定**：🟢 Ready for Implementation（本リリーススコープ＝Phase 0–2）

### Open Questions（実装前に確認）
- **O-1**：ペルソナ Bot 送信が「対人送信」として、既存の名乗りカウンタ・virtual-sender ルールの適用対象か（skills 層の確認が必要）。
- **O-2**：mention-hisho の定期実行基盤（cron）に kaizen ポーリングを相乗りできるか、Railway スケジューラの実体確認。

---

## 13. 版管理

| 版 | 日時 | 変更内容 |
|---|---|---|
| 1.0 | 2026-06-26 | 初版 |
| 1.1 | 2026-06-26 | 汎用性設計を追加（§11.5） |
| 1.2 | 2026-06-27 | 自己進化設計を追加（§11.6） |
| 1.3 | 2026-06-27 | 独立3レビュー＋実コード照合で全面改訂。完了報告をポーリング化／App Router 準拠／干渉抑制／Pg化／汎用化・自己進化を将来章へ格下げ／型・プロンプト明記 |
| 1.4 | 2026-06-27 | 雑談分岐の返答フローを明記（§4.10＝既存メンション秘書くんの返答案→社長LINE確認→OK/修正/却下→返信）。受付も返答も社長判断を教師信号に成長する仕組み（§4.11）を追加。REQ-11具体化・REQ-14追加 |
| 1.5 | 2026-06-27 | 「受付係」キャラを廃止し、連絡を受けた本人（その人格）がそのまま対応する立て付けに。ユーザー向け文言を「登録します」→「カイゼン要望を出しますね／出しておきました」に統一 |
| 1.6 | 2026-06-27 | 優先度をユーザーに聞かず本人が緊急度×重要度で算出し「これで行きますね」と通告（§4.5.1・assessing_priority・型にurgency/importanceScore/priority追加）。Slack対話の応答品質基準7原則（§4.12）を追加 |
| 1.7 | 2026-06-27 | 緊急度・重要度を各 ○/10（10点満点）表示に変更。スコア表・マッピング（合計20点満点）・通告文面・型を10段階に統一 |
| 1.8 | 2026-06-27 | Slackメッセージを Block Kit のカードUIに（§4.13）。確認＝○/10 fields＋優先度バッジ＋根拠＋ボタン（左バー色は優先度連動）、完了＝緑カード＋PRリンク。interactivity/blocks の新規ファイル・Interactivity有効化手順を追加。絵文字なし |
| 1.9 | 2026-06-27 | WEB申請（kaizen-mado本体）も緊急度/重要度○/10・優先度バッジのカードUIに統一（§4.14・マスト）。既存のチャット申請・確認カード・/api/submit を流用し、Ticketにurgency/importanceScore/priority追加。SlackとWEBでスコア基準(§4.5.1)・見た目(§4.13)を共有。後方互換あり |

## 14. 承認・署名

| 役職 | 名前 | 確認 | 日時 |
|---|---|---|---|
| 開発部長 | 真田 啓 | [ ] | - |
| 専務取締役 | 鷹司 統 | [ ] | - |

---

**END OF SPECIFICATION**
