import type Anthropic from "@anthropic-ai/sdk";
import type { LlmBackend, AppEnv } from "../config.js";
import type {
  BossLlmClient,
  BossLlmMessage,
  BossToolExecutor,
  OnTextDelta,
  OnToolEvent,
  RetryDecision,
} from "./claude-client.js";

/**
 * LLM バックエンドの注入レジストリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定3・実装計画①）。
 *
 * `llm/claude-client.ts`（コア）は `claude-code`/`api` バックエンドの実装
 * モジュール（`backends/*.ts`）を静的 import しない — それぞれが
 * `@anthropic-ai/claude-agent-sdk`／`@anthropic-ai/sdk`（値）を引き込み、
 * 製品版のコアのバンドルに混入してしまうため。代わりにこのモジュールが持つ
 * グローバルなレジストリへ、Node 周辺（開発者用の版のエントリ
 * `llm/dev-llm-backends.ts`）が実装を注入する。製品版のコアのエントリ
 * （`core-entry.ts`）はどのバックエンドも登録しない（オーナーの決定 Q4-c）。
 *
 * このモジュール自身は `import type` のみで `claude-client.ts`/`config.ts`
 * を参照する（erased されるため実行時の循環importにはならない）。
 */

/** 呼び出しごとに注入されるコールバック群。バックエンドごとに使う・使わない
 * が分かれる（例: `api` は `executeTool` を内部で呼ばない — `claude-client.ts`
 * の外側のツールループが呼ぶ）が、型は共通で持つ。 */
export interface LlmDispatchHooks {
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  executeTool?: BossToolExecutor;
}

/** `claude-client.ts` の `resolveRequest` が組み立てる、バックエンド非依存に
 * 解決済みのリクエスト（`ApiMessageRequest` と同じ形。`claude-code` 側は
 * `model`/`system`/`messages`/`tools` のみを使う）。 */
export interface ResolvedLlmRequest {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  maxTokens: number;
  thinking: Anthropic.ThinkingConfigParam;
  outputConfig?: Anthropic.OutputConfig;
}

export interface LlmBackendImplementation {
  /** バックエンド固有のクライアント（`BossLlmClient` の該当バリアント）を
   * 組み立てる。API キー未設定等、クライアント構築自体が失敗しうる場合は
   * ここで例外を投げる（`api` の `MissingApiKeyError` 等）。 */
  createClient(env: AppEnv): BossLlmClient;
  /** ストリーミングの1ラウンドを実行する。`signal` は
   * `runWithTimeoutAndRetry` が管理する共有のタイムアウト/中止シグナル。 */
  streamRound(
    client: BossLlmClient,
    request: ResolvedLlmRequest,
    hooks: LlmDispatchHooks,
    signal: AbortSignal,
  ): Promise<BossLlmMessage>;
  /** 非ストリーミングの1ラウンドを実行する。 */
  createRound(
    client: BossLlmClient,
    request: ResolvedLlmRequest,
    signal: AbortSignal,
  ): Promise<BossLlmMessage>;
  /** Issue #224 のリトライ可否判定（`api` のみ持つ）。未設定なら
   * `claude-client.ts` 側の既定ポリシー（常にリトライ）のまま。 */
  classifyError?(error: unknown): RetryDecision;
}

const registry = new Map<LlmBackend, LlmBackendImplementation>();

export function registerLlmBackend(name: LlmBackend, implementation: LlmBackendImplementation): void {
  registry.set(name, implementation);
}

export function getLlmBackendImplementation(name: LlmBackend): LlmBackendImplementation | undefined {
  return registry.get(name);
}

export function registeredLlmBackendNames(): LlmBackend[] {
  return [...registry.keys()];
}

/** テスト専用のリセット。レジストリはプロセス（vitest のモジュールグラフ）
 * 単位のグローバル状態であり、あるテストが登録した実装が後続のテストへ
 * 漏れないようにするための逃げ道。プロダクションコードからは呼ばない。 */
export function resetLlmBackendRegistryForTest(): void {
  registry.clear();
}
