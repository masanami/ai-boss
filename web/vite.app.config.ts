import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 製品版（Tauri アプリ）の web のビルド設定（機能仕様
 * docs/features/tauri-in-app-runtime.md 仮定 A5・S2「器の構成」）。
 *
 * `web/app.html`（製品版のエントリ `src/app-entry/main.tsx` を読む）を
 * ビルドし、出力を `web/dist-app/` に置く（`tauri.conf.json` の
 * `build.frontendDist` が指す先）。開発者用の版（`web/vite.config.ts`・
 * `web/index.html`）とはエントリ・出力先の両方が別。
 *
 * `devUrl` を使わない（機能仕様「Tauri の器の構成」）ため、この設定に
 * `server`（Vite dev server）の設定は無い — `npm run build:app` で
 * `dist-app/` へビルドしたものを Tauri が読む。
 */

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-app",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(webRoot, "app.html"),
    },
  },
});
