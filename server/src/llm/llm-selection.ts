import { resolveLlmBackend, type AppEnv } from "../config.js";
import { resolveBossSettingsFrom } from "../boss/boss-settings.js";
import type { SettingsSnapshot } from "../settings/settings-repository.js";
import type { LlmBackendName } from "./llm-backend-registry.js";
import { isBossProvider } from "./model-catalog.js";
import { PLAN_DEFAULT_MODEL_ID } from "./plan-default-model.js";

/**
 * 選択の解決関数（機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定 7・オーナーの決定 Q6。#582 のクリティカル設計決定 5
 * の骨格の前倒し）。
 *
 * LLM を使う呼び出し元（チャット・セッションの要約・朝会の開始の発言・
 * 夕会の要約抽出・ダッシュボードのひとこと・通知文面・催促の予約の文面）は、
 * 人格・モデルを読むのと同じ 1 つの設定のスナップショットでこの関数を呼び、
 * 返ったバックエンドでクライアントを作り、返ったモデルを要求に使う。
 * `resolveLlmBackend(env)` を直接呼ばない。
 *
 * 解決関数はエントリが {@link setLlmSelectionResolver} で登録する（LLM
 * バックエンドと同じくモジュールのレジストリ。#582 の仮定 A10）。何も登録
 * しないときは {@link devLlmSelectionResolver}（開発者用の版の従来の決め方）が
 * 使われる。製品版のエントリが登録し忘れても、製品版の `env` は空なので
 * `claude-code`（製品版では未登録）になり、送信せずに
 * `LlmBackendNotRegisteredError` で失敗する（黙って別の送信先へ送らない）。
 *
 * このモジュールは製品版のコアのバンドル検査の対象（`core-entry.ts` から
 * 到達する）——Node 組み込み・SDK を import しない。
 */

export interface LlmSelection {
  backend: LlmBackendName;
  model: string;
}

export type LlmSelectionResolver = (env: AppEnv, settings: SettingsSnapshot) => LlmSelection;

/**
 * 開発者用の版の解決関数: バックエンドは従来どおり `LLM_BACKEND`
 * （`resolveLlmBackend`。未設定なら `claude-code`、許容外なら例外）、
 * モデルは従来どおり設定の `model`（未設定なら `DEFAULT_MODEL`）。
 */
export const devLlmSelectionResolver: LlmSelectionResolver = (env, settings) => ({
  backend: resolveLlmBackend(env),
  model: resolveBossSettingsFrom(settings).model,
});

/** 製品版の選択の保存先（`settings` のキー。開発者用の `model` とは別。仮定 A10・A11）。 */
export const BYOK_PROVIDER_SETTING_KEY = "byok_provider";
export const BYOK_MODEL_SETTING_KEY = "byok_model";

/**
 * 課金経路の選択の保存先（機能仕様 docs/features/llm-relay-server.md 決定 S2-Q5・
 * 仮定 A14）。値は `plan`（料金プラン込み＝LLM 中継）／`byok`（自分のキー）。キーが無い
 * ときは `byok`（従来どおり）。S2 では画面から変えられない（決定 S2-Q7。#584 で出す）。
 */
export const LLM_BILLING_ROUTE_SETTING_KEY = "llm_billing_route";

/**
 * 製品版でプロバイダとモデルが選ばれていない（未保存・保存値が不正）ときの
 * 失敗。別のバックエンドや既定のプロバイダ・既定のモデルを補わず、送信しない
 * （ADR 0003 決定 9 の読み替え）。呼び出し元は既存の `try` の中で解決関数を
 * 呼んでおり、この例外は既存の失敗の経路（チャットの 500・テンプレートへの
 * 退避など）に乗る。文言は秘密を含まない。
 */
export class LlmSelectionNotConfiguredError extends Error {
  constructor() {
    super(
      "LLM のプロバイダとモデルが選ばれていません。設定画面でプロバイダとモデルを選んで保存してください（選ぶまで LLM は使えません）",
    );
    this.name = "LlmSelectionNotConfiguredError";
  }
}

/** BYOK の解決（#582 S2）: 保存した選択（`byok_provider`・`byok_model`）から決める。 */
function resolveByokSelection(settings: SettingsSnapshot): LlmSelection {
  const provider = settings.get(BYOK_PROVIDER_SETTING_KEY);
  const model = settings.get(BYOK_MODEL_SETTING_KEY);
  if (!isBossProvider(provider) || model === undefined || model === "") {
    throw new LlmSelectionNotConfiguredError();
  }
  return { backend: provider === "anthropic" ? "byok-anthropic" : "byok-openai", model };
}

/**
 * 製品版の解決関数（#582 S2・クリティカル設計決定 5。#583 S2 で課金経路を足した）:
 * 1 つのスナップショットから課金経路（`llm_billing_route`）を読む。
 * - `plan` → `relay` とプラン込みの既定の値（`byok_provider`・`byok_model` は読まない）。
 * - `byok` またはキーが無い → 保存した選択（`byok_provider`・`byok_model`）で、`anthropic` →
 *   `byok-anthropic`、`openai` → `byok-openai` とモデルを返す。プロバイダが無い・2 値以外、
 *   またはモデルが無い（空を含む）ときは {@link LlmSelectionNotConfiguredError}。
 *   モデルが一覧に無い場合は補正せずそのまま返す——BYOK のバックエンドの送信前の
 *   関門（`assertByokModelAllowed`）が止める。
 * - それ以外の値（空・`PLAN`・`relay` 等）は補わず {@link LlmSelectionNotConfiguredError}。
 * `env` と設定の `model` は読まない（製品版で `LLM_BACKEND` の経路へ切り替わらない・
 * 開発者用の値が影響しない）。
 */
export const productLlmSelectionResolver: LlmSelectionResolver = (_env, settings) => {
  const route = settings.get(LLM_BILLING_ROUTE_SETTING_KEY);
  if (route === "plan") {
    return { backend: "relay", model: PLAN_DEFAULT_MODEL_ID };
  }
  if (route === undefined || route === "byok") {
    return resolveByokSelection(settings);
  }
  throw new LlmSelectionNotConfiguredError();
};

let registeredResolver: LlmSelectionResolver | undefined;

/** エントリが解決関数を登録する（製品版の web のエントリが製品版の解決関数を登録する）。 */
export function setLlmSelectionResolver(resolver: LlmSelectionResolver): void {
  registeredResolver = resolver;
}

/** 登録された解決関数（無ければ開発者用の解決関数）で選択を解決する。 */
export function resolveLlmSelection(env: AppEnv, settings: SettingsSnapshot): LlmSelection {
  return (registeredResolver ?? devLlmSelectionResolver)(env, settings);
}

/** テスト専用のリセット（`resetLlmBackendRegistryForTest` と同じ扱い）。
 * プロダクションコードからは呼ばない。 */
export function resetLlmSelectionResolverForTest(): void {
  registeredResolver = undefined;
}
