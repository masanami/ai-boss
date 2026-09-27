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

/**
 * バックエンドが宣言する能力（機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定 5・#582 の決定 Q5）。呼び出し元・ファサードは
 * バックエンドの**名前**ではなく、ここで宣言された能力で振る舞いを変える
 * （`llm/claude-client.ts` の `streamBossMessage`・`reports/extract-evening-
 * summary.ts`・`dashboard/boss-comment.ts` の名前分岐を置き換える）。
 *
 * 3項目とも**必須**（任意項目にしない）: 宣言し忘れた実装が既定値へ黙って
 * 倒れるのを型で防ぐ（機能仕様の「理由」節）。
 */
export interface LlmBackendCapabilities {
  /** 真なら、このバックエンドは tool_use ループを自分で回す（現行の
   * `claude-code` — Agent SDK の内部ループ）。ファサード
   * （`streamBossMessage`）は1回だけ dispatch して返し、自身のツールループ
   * は回さない。偽なら、ファサードが最大 `MAX_TOOL_ROUNDS` ラウンド回す
   * （現行の `api`）。 */
  runsOwnToolLoop: boolean;
  /** 真のときだけ、呼び出し元（例: 夕会の要約抽出）は `toolChoice` で
   * ツール呼び出しを強制できる。偽なら渡さない（プロンプトの指示で
   * 代替する）。 */
  supportsToolChoice: boolean;
  /** 真のときだけ、要求ごとに応答の長さを制限できる（`api`/BYOK の
   * `maxTokens`）。偽なら、呼び出し元（ダッシュボードのひとこと）は
   * 短文指示をプロンプトへ足し、生成後に長さを検証してフォールバックする
   * 代替をとる。 */
  limitsResponseLength: boolean;
}

/**
 * レジストリの鍵の型（機能仕様 docs/features/secure-transport-byok.md
 * 仮定 A11）。`config.ts` の `LlmBackend`（`LLM_BACKEND` 環境変数の検証に
 * 使う、開発者用の版の許容値 `"api" | "claude-code"` の閉じた型）とは
 * **意図して分けている**: `LlmBackend` をそのまま広げると
 * `LLM_BACKEND=byok-anthropic` が開発者用の版で通ってしまう
 * （`resolveLlmBackend` は `config.ts` の狭い型のまま変えない）。
 * BYOK（Anthropic。S2）・将来の BYOK（OpenAI。#582）はこちらの広い型の
 * 鍵としてのみレジストリへ登録される。
 */
export type LlmBackendName = LlmBackend | "byok-anthropic";

export interface LlmBackendImplementation {
  /** このバックエンドが宣言する能力。 */
  capabilities: LlmBackendCapabilities;
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

const registry = new Map<LlmBackendName, LlmBackendImplementation>();

export function registerLlmBackend(name: LlmBackendName, implementation: LlmBackendImplementation): void {
  registry.set(name, implementation);
}

export function getLlmBackendImplementation(name: LlmBackendName): LlmBackendImplementation | undefined {
  return registry.get(name);
}

export function registeredLlmBackendNames(): LlmBackendName[] {
  return [...registry.keys()];
}

/** テスト専用のリセット。レジストリはプロセス（vitest のモジュールグラフ）
 * 単位のグローバル状態であり、あるテストが登録した実装が後続のテストへ
 * 漏れないようにするための逃げ道。プロダクションコードからは呼ばない。 */
export function resetLlmBackendRegistryForTest(): void {
  registry.clear();
}
