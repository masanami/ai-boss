/**
 * 製品版（Tauri アプリ）のコアのエントリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定3・スライス S1・
 * 仮定 A3: 名前・置き場所は実装で決めてよい）。
 *
 * `createCoreApp` と、登録済み LLM バックエンド名の列挙をそのまま re-export
 * するだけで、**LLM バックエンドを一つも登録しない**（オーナーの決定
 * Q4-c — 製品版のコアには `api` も含めキーを WebView に載せるバックエンドを
 * 入れない）。バックエンドの登録は #581（Rust 通信層）・#582（プロバイダ
 * 抽象化）の責務であり、本機能（#594）の対象外。
 *
 * このモジュール（および、この import グラフから到達可能なすべてのモジュ
 * ール）は Node 組み込み（`node:*`）・Node グローバル（`process`・`Buffer`・
 * `require`・`__dirname`・`__filename`）・`@anthropic-ai/claude-agent-sdk`・
 * `@anthropic-ai/sdk`・`@hono/node-server` を値として import・参照しない —
 * `server/src/core-entry.bundle.test.ts` が esbuild のバンドル検査
 * （受入基準1〜7・12）と TypeScript コンパイラ API による静的検査で固定する。
 */
export { createCoreApp, type CreateCoreAppOptions } from "./core-app.js";
export { registeredLlmBackendNames as registeredCoreLlmBackendNames } from "./llm/llm-backend-registry.js";
