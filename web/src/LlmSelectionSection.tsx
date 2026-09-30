import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  fetchLlmSelection,
  saveLlmSelection,
  type LlmProvider,
  type LlmSelectionState,
} from "./llm-selection-api";

/**
 * 設定画面の「LLM（プロバイダとモデル）」の欄（#582 S2・機能仕様
 * docs/features/llm-provider-abstraction.md クリティカル設計決定 5「S2 の形」）。
 * 製品版でキーの操作が注入されたときだけ表示される（`SettingsView`）。
 *
 * - 設定の保存のフォームとは別のフォーム（プロバイダとモデルは必ず組で保存する）
 * - 選択は `select` だけで行う——自由入力の欄は無い（一覧外のモデルは画面で選べない）
 * - 未選択・保存したモデルが一覧に無いときは案内を出し、モデルを既定で埋めない
 *   （選ぶまで保存を押せない。黙って選ばない）
 */

const PROVIDERS: ReadonlyArray<{ id: LlmProvider; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
];

const HEADING = "LLM（プロバイダとモデル）";
const UNSELECTED_GUIDANCE =
  "プロバイダとモデルを選んで保存してください。選ぶまで LLM は使えません";

function outOfCatalogGuidance(model: string): string {
  return `保存されているモデル（${model}）は選べるモデルの一覧にありません。一覧から選び直して保存してください。選び直すまで LLM は使えません`;
}

function guidanceFor(state: LlmSelectionState): string | null {
  if (state.provider === null || state.model === null) return UNSELECTED_GUIDANCE;
  return state.modelInCatalog ? null : outOfCatalogGuidance(state.model);
}

export default function LlmSelectionSection() {
  const [state, setState] = useState<LlmSelectionState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [provider, setProvider] = useState<LlmProvider | "">("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyState = (next: LlmSelectionState) => {
    setState(next);
    setProvider(next.provider ?? "");
    // 一覧に無い保存値は選択肢に無いので、未選択の状態で表示する（既定で埋めない）。
    setModel(next.provider !== null && next.modelInCatalog && next.model !== null ? next.model : "");
  };

  useEffect(() => {
    let active = true;
    fetchLlmSelection().then(
      (fetched) => {
        if (active) applyState(fetched);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (loadFailed) {
    return (
      <section aria-label={HEADING}>
        <p role="alert">LLM の選択の取得に失敗しました</p>
      </section>
    );
  }
  if (state === null) {
    return (
      <section aria-label={HEADING}>
        <p>読み込み中…</p>
      </section>
    );
  }

  const modelRows = state.catalog.filter((row) => row.provider === provider);
  const canSave = provider !== "" && model !== "" && !saving;
  const guidance = guidanceFor(state);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (provider === "" || model === "" || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    saveLlmSelection({ provider, model })
      .then(
        (next) => {
          applyState(next);
          setSaved(true);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "保存に失敗しました"),
      )
      .finally(() => setSaving(false));
  };

  return (
    <form aria-label={HEADING} onSubmit={handleSubmit}>
      <fieldset disabled={saving}>
        <legend>{HEADING}</legend>
        {guidance !== null && <p role="status">{guidance}</p>}
        <label>
          プロバイダ
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as LlmProvider | "");
              // 他方のプロバイダのモデルは選べないので選び直す。
              setModel("");
              setSaved(false);
            }}
          >
            <option value="">選んでください</option>
            {PROVIDERS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          使うモデル
          <select
            value={model}
            disabled={provider === ""}
            onChange={(event) => {
              setModel(event.target.value);
              setSaved(false);
            }}
          >
            <option value="">選んでください</option>
            {modelRows.map((row) => (
              <option key={row.modelId} value={row.modelId}>
                {row.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!canSave}>
          選択を保存
        </button>
      </fieldset>
      {error !== null && <p role="alert">{error}</p>}
      {error === null && saved && <p>保存しました</p>}
    </form>
  );
}
