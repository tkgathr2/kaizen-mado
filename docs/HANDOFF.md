# カイゼンくん改善案 — 引き継ぎ（kaizen-mado / WEB申請側）

このセッション（2026-06-27）でまとめた改善案の引き継ぎ。実装はこの docs の仕様書を正本にする。

## 正本
- 仕様書フル：`docs/kaizen-reception-gateway-spec.md`（v1.9）
- Notion：https://app.notion.com/p/38b0d9808b3b8187bedef8c138a241d7

## このリポ（kaizen-mado）でやること = WEB申請の体験統一（仕様書 §4.14）
WEB申請（kaizen.takagi.bz）も Slack と同じ「緊急度 ○/10・重要度 ○/10・優先度バッジ」のカードUIに揃える。**緊急度8/10・重要度9/10・優先度 高 はマスト。**

### 必須要件
1. 緊急度・重要度を各 ○/10 でAI算出（ユーザーに優先度を聞かない）
   - 緊急度：9-10=業務停止／5-6=回避策あり／1-2=軽微
   - 重要度：9-10=売上採用法令安全直結・多人数毎日／5-6=一部業務／1-2=nice-to-have
   - 優先度（合計20点満点）：高=どちらか8以上かつ合計14以上／中=8-13／低=≤7、算出根拠を1行
2. 確認カードに 緊急度8/10・重要度9/10・優先度バッジ＋根拠＋ボタン（色：高 #A32D2D／中 #BA7517／低 #5F5E5A、絵文字なし）
3. 既存流用：`app/page.tsx` の確認カード・`/api/submit`・`systems.ts`。追加は点数表示部分のみ
4. データ：`lib/types.ts` の `Ticket` に `urgency(1-10)`/`importanceScore(1-10)`/`priority`/`priorityReason` を追加。既存 `importance` は `priority` へ移行。後方互換＝旧チケットは点数「—」表示
5. board / dashboard に優先度バッジ＋点数を表示

### 変更ファイル
`lib/types.ts` / `app/api/chat/route.ts` / `app/api/submit/route.ts` / `app/page.tsx` / `app/board/page.tsx` / `app/dashboard/page.tsx` / Notion DBプロパティ追加

### 着手順
- Phase 0：`Ticket` 型拡張
- Phase 1：`/api/chat` で緊急度・重要度を算出 ＋ 確認カードを点数表示に
- Phase 2：board / dashboard に表示

### 共通基準
緊急度・重要度・優先度のスコアリングは仕様書 §4.5.1 を唯一の正とし、Slack受付（mention-hisho）と文言・閾値を合わせる。
