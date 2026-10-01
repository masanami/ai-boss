/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 製品版の web をビルドした Tauri の対象（`vite.app.config.ts` の `envPrefix`。
   * Tauri の CLI を経ないビルド・開発者用の版では未定義）。
   */
  readonly TAURI_ENV_PLATFORM?: string;
}
