#!/usr/bin/env npx ts-node
/**
 * ローカル検証: runDailyNotificationBatch のテスト（改善⑤）
 * テスト内容：
 *  1. storeが有効か確認
 *  2. 空のキューで実行（何も送らない）
 *  3. 結果をログ出力
 */

import { runDailyNotificationBatch } from "./lib/notification";

async function main() {
  console.log("🧪 カイゼン通知⑤ ローカルテスト開始");
  console.log("=".repeat(60));

  // ① 環境変数確認
  console.log("\n📋 環境変数チェック:");
  console.log(`  KAIZEN_DIGEST_PAGE_ID: ${process.env.KAIZEN_DIGEST_PAGE_ID ? "設定済" : "❌ 未設定"}`);
  console.log(`  NOTION_TOKEN: ${process.env.NOTION_TOKEN ? "設定済" : "❌ 未設定"}`);
  console.log(`  LINE_TARGET_USER_ID: ${process.env.LINE_TARGET_USER_ID ? "設定済" : "❌ 未設定"}`);
  console.log(`  CRON_SECRET: ${process.env.CRON_SECRET ? "設定済" : "❌ 未設定"}`);

  // ② runDailyNotificationBatch 実行（force=true で時刻ガード飛ばし）
  console.log("\n🔄 runDailyNotificationBatch({ force: true }) 実行中...");
  const result = await runDailyNotificationBatch({ force: true });

  // ③ 結果出力
  console.log("\n✅ 実行結果:");
  console.log(JSON.stringify(result, null, 2));

  // ④ 判定
  console.log("\n📊 判定:");
  if (result.ok) {
    console.log("  ✅ 処理成功");
    if (result.skipped) {
      console.log(`  ℹ️  スキップ理由: ${result.skipped}`);
      console.log(`      考察: "${result.skipped}" が正常なら OK`);
    }
    if (result.sent > 0) {
      console.log(`  📤 ${result.sent}件送信`);
    }
  } else {
    console.log("  ❌ 処理失敗");
    console.log(`      原因: ${result.skipped || "不明"}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("テスト完了\n");
}

main().catch((e) => {
  console.error("❌ エラー:", e);
  process.exit(1);
});
