import { StrictMode } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import App from "../App";
import "../index.css";
import { installInAppApi } from "./in-app-fetch";
import { createBlobEvidenceContentOpener } from "./open-evidence-content-as-blob";
import { EvidenceContentOpenerContext } from "../evidence-content-opener-context";
import { bootProductApp } from "./boot-product-app";
import { getProductDatabase, openProductDb } from "./product-db";
import { ByokKeyManagerContext } from "../byok-key-manager-context";
import { createTauriSecureTransport, type SecureStreamEvent } from "./tauri-secure-transport";
import { createTauriByokKeyManager } from "./tauri-byok-key-manager";
import { installProductLlm } from "./product-llm";

/**
 * 製品版（Tauri アプリ）の web のエントリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定1・S2「器の構成」・
 * 仮定 A5）。既存の `web/src/App.tsx` を、開発者用の版（`main.tsx`）とは別の
 * 描画経路から呼ぶ — 画面コンポーネント自体は一切変更しない。
 *
 * 描画より前に（順序は `boot-product-app.ts`）:
 * 1. 製品版の DB（plugin-sql・#580 S2）を準備する。失敗したら「DB 未接続」
 *    で起動する。
 * 2. グローバルの `fetch` を包み、`/api` 配下の要求だけをアプリ内の
 *    `createCoreApp` へ振り向ける（決定1「/api の振り向け」）。
 * 3. Blob URL の方式（証跡ファイルのリンク）を組み立て、コンテキストで注入
 *    する。
 * 4. （#581 S3）製品版の LLM（BYOK〔Anthropic〕と製品版の解決関数）を DB と
 *    `/api` より前に登録し、キーの操作（設定画面のキーの欄）をコンテキストで
 *    注入する。どちらも器のコマンド（`secure_*`・`byok_key_*`）を呼ぶ。
 */

const secureTransport = createTauriSecureTransport({
  invoke: (command, args) => invoke(command, args),
  createChannel: () => new Channel<SecureStreamEvent>(),
  newRequestId: () => crypto.randomUUID(),
});
const byokKeyManager = createTauriByokKeyManager((command, args) => invoke(command, args));

const evidenceContentOpener = createBlobEvidenceContentOpener({
  // 呼ばれる時点の `window.fetch`（描画より前に包んだ後の参照）— `/api` 配下の
  // 証跡取得はアプリ内のコアへ振り向けられる。
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

void bootProductApp({
  installLlm: () => installProductLlm(secureTransport),
  openDb: () => openProductDb(getProductDatabase()),
  logError: (message, error) => console.error(message, error),
  installApi: (app) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = installInAppApi(app, originalFetch, window.location);
  },
  render: () => {
    createRoot(rootElement).render(
      <StrictMode>
        <EvidenceContentOpenerContext.Provider value={evidenceContentOpener}>
          <ByokKeyManagerContext.Provider value={byokKeyManager}>
            <App />
          </ByokKeyManagerContext.Provider>
        </EvidenceContentOpenerContext.Provider>
      </StrictMode>,
    );
  },
});
