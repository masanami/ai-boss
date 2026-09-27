import type { RelayModel } from "./config.js";
import type { MessagesRequest } from "./request-validation.js";

/**
 * 既定モデルの解決と要求の書き換え（機能仕様 クリティカル設計決定 3）。
 *
 * `model`（プラン込みの既定の値）を既定モデルの ID に置き換え、既定モデルの
 * 行に従って `thinking` と `output_config` を書き換える。それ以外の項目は
 * アプリの要求の値をそのまま残す（新しいオブジェクトを返し、引数は変えない）。
 */
export function rewriteForModel(request: MessagesRequest, model: RelayModel): MessagesRequest {
  const rewritten: MessagesRequest = { ...request, model: model.id };

  const thinking = request.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === "adaptive" && model.adaptiveThinkingReplacement) {
    rewritten.thinking = { ...model.adaptiveThinkingReplacement };
  }

  const outputConfig = request.output_config as Record<string, unknown> | undefined;
  if (outputConfig && !model.supportsEffort && "effort" in outputConfig) {
    const rest = { ...outputConfig };
    delete rest.effort;
    if (Object.keys(rest).length === 0) {
      delete rewritten.output_config;
    } else {
      rewritten.output_config = rest;
    }
  }
  return rewritten;
}
