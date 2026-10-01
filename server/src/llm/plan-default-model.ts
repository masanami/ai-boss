/**
 * 中継へ送るモデル名: 具体のモデル ID を持たず「プラン込みの既定」を依頼する値
 * （機能仕様 docs/features/llm-relay-server.md 仮定 A2・決定 O1）。中継の設定
 * （`relay/src/request-validation.ts` の `PLAN_DEFAULT_MODEL`）と同じ値で、テストで固定している。
 *
 * 選択の解決関数（`llm-selection.ts`）と `relay` バックエンドの両方が使うため、どちらにも
 * 依存しない小さなモジュールに置く（依存の向きを「バックエンド・選択 → 定数」にそろえる）。
 */
export const PLAN_DEFAULT_MODEL_ID = "ai-boss-plan-default";
