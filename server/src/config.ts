const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = "./data/ai-boss.db";
/** Default backend used by `loadConfig`, re-exported so callers that need a
 * fallback outside of `loadConfig` (e.g. `app.ts`'s
 * `CreateAppOptions.llmBackend`) don't hardcode the `"api"` literal. Note
 * `llm/claude-client.ts`'s own `createClaudeClient` default is a separate,
 * independently-hardcoded `"api"` fallback for callers outside `app.ts`
 * (`server/src/llm/` is out of this ticket's scope). */
export const DEFAULT_LLM_BACKEND: LlmBackend = "api";
const ALLOWED_LLM_BACKENDS = ["api", "claude-code"] as const;

export type LlmBackend = (typeof ALLOWED_LLM_BACKENDS)[number];

export interface AppConfig {
  port: number;
  dbPath: string;
  hasAnthropicApiKey: boolean;
  llmBackend: LlmBackend;
}

function resolvePort(env: NodeJS.ProcessEnv): number {
  if (!env.PORT) {
    return DEFAULT_PORT;
  }

  const parsed = Number(env.PORT);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `PORT の値 "${env.PORT}" は不正です。既定値 ${DEFAULT_PORT} を使用します。`,
    );
    return DEFAULT_PORT;
  }

  return parsed;
}

function isLlmBackend(value: string): value is LlmBackend {
  return (ALLOWED_LLM_BACKENDS as readonly string[]).includes(value);
}

function resolveLlmBackend(env: NodeJS.ProcessEnv): LlmBackend {
  if (env.LLM_BACKEND === undefined) {
    return DEFAULT_LLM_BACKEND;
  }

  if (isLlmBackend(env.LLM_BACKEND)) {
    return env.LLM_BACKEND;
  }

  throw new Error(
    `LLM_BACKEND の値 "${env.LLM_BACKEND}" は不正です。許容値は ${ALLOWED_LLM_BACKENDS.join(
      " / ",
    )} のいずれかです。`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = resolvePort(env);
  const dbPath = env.DB_PATH ?? DEFAULT_DB_PATH;
  const hasAnthropicApiKey = Boolean(env.ANTHROPIC_API_KEY);
  const llmBackend = resolveLlmBackend(env);

  if (!hasAnthropicApiKey && llmBackend === "api") {
    console.warn(
      "ANTHROPIC_API_KEY is not set. Claude API 連携機能は動作しません。",
    );
  }

  return { port, dbPath, hasAnthropicApiKey, llmBackend };
}
