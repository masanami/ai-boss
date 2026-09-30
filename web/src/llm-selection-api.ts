/**
 * 製品版の LLM の選択（プロバイダとモデル）の API クライアント（#582 S2・
 * 機能仕様 docs/features/llm-provider-abstraction.md 仮定 A13・A14）。
 * `GET`・`PUT /api/llm-selection` は製品版のコアだけが有効にする——開発者用の版
 * では呼ばない（設定画面が製品版のときだけこのモジュールを使う）。
 */

export type LlmProvider = "anthropic" | "openai";

export interface LlmCatalogRow {
  provider: LlmProvider;
  modelId: string;
  displayName: string;
  isDefault: boolean;
}

export interface LlmSelectionState {
  /** 未保存・保存値が 2 値以外のときは `null`（未選択）。 */
  provider: LlmProvider | null;
  model: string | null;
  /** 保存したモデルが保存したプロバイダの一覧にあるか。 */
  modelInCatalog: boolean;
  catalog: LlmCatalogRow[];
}

const LLM_SELECTION_URL = "/api/llm-selection";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

export async function fetchLlmSelection(): Promise<LlmSelectionState> {
  const response = await fetch(LLM_SELECTION_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as LlmSelectionState;
}

/** プロバイダとモデルを必ず組で保存し、保存後の状態を返す。拒否（400）はサーバーの文言の Error。 */
export async function saveLlmSelection(selection: {
  provider: LlmProvider;
  model: string;
}): Promise<LlmSelectionState> {
  const response = await fetch(LLM_SELECTION_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: selection.provider, model: selection.model }),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as LlmSelectionState;
}
