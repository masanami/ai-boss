import {
  productLlmSelectionResolver,
  registerByokAnthropicBackend,
  setLlmSelectionResolver,
  type SecureTransportPort,
} from "../../../server/src/core-entry.js";

/**
 * 製品版の LLM の準備（#581 S3・機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定 6・7）: BYOK（Anthropic）のバックエンドに Tauri 実装の
 * 転送のポートを渡して登録し、製品版の解決関数（常に `byok-anthropic` と設定の
 * `model`）を登録する。BYOK（OpenAI）は登録しない（#582 S2）。
 */
export function installProductLlm(transport: SecureTransportPort): void {
  registerByokAnthropicBackend(transport);
  setLlmSelectionResolver(productLlmSelectionResolver);
}
