import { resolveLlmBackend, type AppEnv } from "../config.js";
import { resolveBossSettingsFrom } from "../boss/boss-settings.js";
import type { SettingsSnapshot } from "../settings/settings-repository.js";
import type { LlmBackendName } from "./llm-backend-registry.js";

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

/**
 * 製品版の解決関数（当面の固定の関数。#582 S2 で「保存したプロバイダと
 * モデルから決める関数」へ差し替える）: バックエンドは常に BYOK
 * （Anthropic）、モデルは設定の `model`（未設定なら `DEFAULT_MODEL`）。
 * `env` を読まない（製品版で `LLM_BACKEND` の経路へ切り替わらない）。
 */
export const productLlmSelectionResolver: LlmSelectionResolver = (_env, settings) => ({
  backend: "byok-anthropic",
  model: resolveBossSettingsFrom(settings).model,
});

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
