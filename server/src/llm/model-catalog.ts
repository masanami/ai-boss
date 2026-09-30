/**
 * BYOK で許可するモデルの一覧と送信前の関門（機能仕様
 * docs/features/llm-provider-abstraction.md クリティカル設計決定3・
 * 受入基準（S1）「モデルの一覧と送信前の関門」・仮定 A8・A9）。
 *
 * アプリに同梱する固定の一覧をコアの定数として持つ。一覧に無いモデルは
 * 画面で選べない（S2）だけでなく、BYOK の各バックエンドが送信前に拒否する
 * （S1）——両バックエンドの `streamRound`／`createRound` の入口（転送の
 * ポートを呼ぶ前）が {@link assertByokModelAllowed} を呼ぶ。
 *
 * このモジュールは製品版のコアのバンドル検査の対象（`byok-openai-backend.ts`
 * から到達可能）——Node 組み込み・SDK を一切 import しない。
 */

export type BossProvider = "anthropic" | "openai";

/** 保存値・入力が許可するプロバイダ（`anthropic`・`openai`）のどちらかか。 */
export function isBossProvider(value: unknown): value is BossProvider {
  return value === "anthropic" || value === "openai";
}

export type OpenAiReasoningMode = "chat" | "disabled";

export interface ModelCatalogEntry {
  provider: BossProvider;
  modelId: string;
  displayName: string;
  isDefault: boolean;
  /**
   * OpenAI Responses の `reasoning.effort` の対応（OpenAI の行のみ）。
   * `chat` はチャット（`thinking: { type: "adaptive" }` ＋
   * `effort: "low"`）、`disabled` はそれ以外（`thinking: { type: "disabled"
   * }`）に対応する値。仮定 A6: `gpt-6-sol`・`gpt-6-luna` はいずれも `"none"`
   * （推論なし）を受け付ける前提に立つ（`gpt-6-astra` だけが `"none"` で
   * 400 を返すため一覧から外れている——「決定」節）。実 API は呼んでおらず、
   * 食い違いが判明したら実装時に直す。
   */
  openaiReasoningEffort?: { chat: string; disabled: string };
}

/**
 * 一覧（2026-09-27 オーナー決定）: Anthropic は `claude-sonnet-5`（既定）・
 * `claude-haiku-4-5`、OpenAI は `gpt-6-sol`（既定）・`gpt-6-luna`。
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { provider: "anthropic", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", isDefault: true },
  { provider: "anthropic", modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isDefault: false },
  {
    provider: "openai",
    modelId: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    isDefault: true,
    openaiReasoningEffort: { chat: "low", disabled: "none" },
  },
  {
    provider: "openai",
    modelId: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    isDefault: false,
    openaiReasoningEffort: { chat: "low", disabled: "none" },
  },
];

export function listModelsForProvider(provider: BossProvider): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider);
}

/** `modelId` が `provider` の一覧にあるか（保存の入口と送信前の関門が同じ規則を使う）。 */
export function isModelInCatalog(provider: BossProvider, modelId: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.provider === provider && entry.modelId === modelId);
}

export function getDefaultModelId(provider: BossProvider): string {
  const defaultEntry = MODEL_CATALOG.find((entry) => entry.provider === provider && entry.isDefault);
  if (!defaultEntry) {
    throw new Error(`model-catalog: no default model registered for provider "${provider}"`);
  }
  return defaultEntry.modelId;
}

/**
 * 一覧外・他方プロバイダのモデルを拒否する専用の例外（仮定 A9）。**本文・
 * プロンプトを持たない**——`provider`・`modelId` は秘密ではない（送信前に
 * 拒否した「選ばれたモデルの名前」であり、機能仕様の非機能要件「ログ」に
 * 反しない）。
 */
export class ByokModelNotAllowedError extends Error {
  readonly provider: BossProvider;
  readonly modelId: string;

  constructor(provider: BossProvider, modelId: string) {
    super(`BYOK model not allowed: ${provider}/${modelId} is not in the model catalog`);
    this.name = "ByokModelNotAllowedError";
    this.provider = provider;
    this.modelId = modelId;
  }
}

function findCatalogEntry(provider: BossProvider, modelId: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.provider === provider && entry.modelId === modelId);
}

/**
 * 送信前の関門本体。`provider` の一覧に `modelId` が無ければ（他方の
 * プロバイダの一覧にあるモデルを含む）{@link ByokModelNotAllowedError} を
 * 投げる。両方の BYOK バックエンドが `streamRound`／`createRound` の入口
 * （転送のポートを呼ぶ前）で呼ぶ。
 */
export function assertByokModelAllowed(provider: BossProvider, modelId: string): void {
  if (!isModelInCatalog(provider, modelId)) {
    throw new ByokModelNotAllowedError(provider, modelId);
  }
}

/**
 * OpenAI の行の `reasoning.effort` 対応を引く（`byok-openai-backend.ts` の
 * 要求本文の組み立てが使う）。一覧に無いモデルは
 * {@link ByokModelNotAllowedError} を投げる——呼び出し元は
 * {@link assertByokModelAllowed} を先に通しているはずだが、このモジュール
 * 単体でも安全に失敗する。
 */
export function getOpenAiReasoningEffort(modelId: string, mode: OpenAiReasoningMode): string {
  const entry = findCatalogEntry("openai", modelId);
  if (!entry?.openaiReasoningEffort) {
    throw new ByokModelNotAllowedError("openai", modelId);
  }
  return entry.openaiReasoningEffort[mode];
}
