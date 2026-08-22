import { defineConfig } from "vitest/config";
import path from "node:path";

// カイゼンくん テスト土台（第1.5段ハードニング + 第2段ループの単体テスト）
// パスエイリアス @/* → ./*（tsconfig と一致）を vitest でも解決する。
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // ネットワーク到達のある実IO（route/外部API直叩き）はモックで閉じる方針。
    // 実HTTPは飛ばさない（テストは決定的・オフラインで通る）。
    // 【2026-08-22 bug-check-lab指摘修正】既定5000msだと、フルスイート実行時（全ワーカー並列で
    // CPU負荷が上がる）に app/api/chat/__tests__/stream.test.ts・lib/__tests__/line-401-e2e.test.ts
    // が単体実行ではpassするのにタイムアウトしてexit 1になっていた（並列負荷が原因）。
    // ロジック側の欠陥ではないため、全体のtestTimeoutを引き上げてCI green化する。
    testTimeout: 20_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
