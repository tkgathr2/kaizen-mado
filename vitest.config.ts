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
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
