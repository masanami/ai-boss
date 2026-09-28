import { defineConfig } from "vitest/config";

/**
 * 製品版（plugin-sql 実装）の上で、両版で同じ契約スイートを回す設定
 * （#580 S2・機能仕様 docs/features/async-db-layer.md「契約テストを器の上で
 * 通す仕組み」）。器の IPC の中継（cargo でビルドする子プロセス）を使うため、
 * 既定の `npm test`（`vite.config.ts`）には含めず、ルートの
 * `npm run test:tauri-db` で回す。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tauri-db/**/*.tauri-db.test.ts"],
    // 中継の起動（子プロセス）とマイグレーションの往復に時間がかかる。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
