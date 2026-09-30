import {
  productLlmSelectionResolver,
  registerByokAnthropicBackend,
  registerByokOpenAiBackend,
  setLlmSelectionResolver,
  type SecureTransportPort,
} from "../../../server/src/core-entry.js";

/**
 * 製品版の LLM の準備（#581 S3 の BYOK〔Anthropic〕の登録に、#582 S2 が BYOK
 * 〔OpenAI〕を加えた。機能仕様 docs/features/llm-provider-abstraction.md
 * クリティカル設計決定 5「S2 の形」）: BYOK（Anthropic）と BYOK（OpenAI）の
 * 両方に同じ Tauri 実装の転送のポートを渡して登録し、製品版の解決関数（保存した
 * プロバイダとモデルから送信先を決める。未選択なら失敗する）を登録する。
 * 送信先はプロバイダの選択だけで決まり、キーの登録の有無では切り替わらない。
 */
export function installProductLlm(transport: SecureTransportPort): void {
  registerByokAnthropicBackend(transport);
  registerByokOpenAiBackend(transport);
  setLlmSelectionResolver(productLlmSelectionResolver);
}
