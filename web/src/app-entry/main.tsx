import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import "../index.css";
import { installInAppApi } from "./in-app-fetch";
import { createProductCoreApp } from "./create-product-core-app";
import { createBlobEvidenceContentOpener } from "./open-evidence-content-as-blob";
import { EvidenceContentOpenerContext } from "../evidence-content-opener-context";

/**
 * 製品版（Tauri アプリ）の web のエントリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定1・S2「器の構成」・
 * 仮定 A5）。既存の `web/src/App.tsx` を、開発者用の版（`main.tsx`）とは別の
 * 描画経路から呼ぶ — 画面コンポーネント自体は一切変更しない。
 *
 * 描画より前に:
 * 1. グローバルの `fetch` を包み、`/api` 配下の要求だけをアプリ内の
 *    `createCoreApp` へ振り向ける（決定1「/api の振り向け」）。
 * 2. Blob URL の方式（証跡ファイルのリンク）を組み立て、コンテキストで注入
 *    する。
 */

const productCoreApp = createProductCoreApp();
const originalFetch = window.fetch.bind(window);
window.fetch = installInAppApi(productCoreApp, originalFetch, window.location);

const evidenceContentOpener = createBlobEvidenceContentOpener({
  // `window.fetch` は上で既に包んだ後の参照 — `/api` 配下の証跡取得はアプリ内
  // のコアへ振り向けられる。
  fetch: (input, init) => window.fetch(input, init),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  openWindow: (url) => {
    window.open(url, "_blank");
  },
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <EvidenceContentOpenerContext.Provider value={evidenceContentOpener}>
      <App />
    </EvidenceContentOpenerContext.Provider>
  </StrictMode>,
);
