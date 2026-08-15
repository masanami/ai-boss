const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = "./data/ai-boss.db";
/** Default backend used by `loadConfig`, re-exported so callers that need a
 * fallback outside of `loadConfig` (e.g. `app.ts`'s
 * `CreateAppOptions.llmBackend`) don't hardcode a literal. Issue #118:
 * changed from `"api"` to `"claude-code"` — the owner has a Claude Code
 * subscription login and wants that used by default instead of
 * `ANTHROPIC_API_KEY` pay-as-you-go. Set `LLM_BACKEND=api` in `server/.env`
 * to opt back into the `api` backend (back-compat, unchanged behavior).
 * `llm/claude-client.ts`'s own `createClaudeClient` default now imports this
 * same constant too (Issue #118 — single source of truth for the default),
 * rather than independently hardcoding a literal. */
export const DEFAULT_LLM_BACKEND: LlmBackend = "claude-code";
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

/**
 * Exported (beyond `loadConfig`'s own use) so call sites that only ever
 * receive `env` directly — not the already-loaded `AppConfig` — can resolve
 * the backend themselves. Used by `dashboard/boss-comment.ts` and
 * `notifications/notification-body.ts` (Issue #79): those two call
 * `createClaudeClient(env, resolveLlmBackend(env))` instead of relying on
 * its `"api"` default, so `LLM_BACKEND=claude-code` actually takes effect
 * for them too (`app.ts`'s `CreateAppOptions.llmBackend` only threads
 * through to the chat/decisions routers — see its doc comment). Re-running
 * the same validation `loadConfig` already performed at startup is
 * redundant but harmless (pure, no side effects) — `env.LLM_BACKEND` is
 * guaranteed valid or absent by the time any request handler runs.
 */
export function resolveLlmBackend(env: NodeJS.ProcessEnv): LlmBackend {
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
  const isExplicitLlmBackend = env.LLM_BACKEND !== undefined;
  const llmBackend = resolveLlmBackend(env);

  // Issue #118: log the effective backend once at startup — the default
  // changed from `api` to `claude-code`, so operators need a quick way to
  // confirm which one is actually in effect without reading `server/.env`.
  // Never includes `env.ANTHROPIC_API_KEY`'s value (see the "never logs the
  // key value" test below).
  console.log(
    `LLM backend: ${llmBackend}（${isExplicitLlmBackend ? "LLM_BACKEND で明示" : "既定値"}）`,
  );

  if (!hasAnthropicApiKey && llmBackend === "api") {
    console.warn(
      "ANTHROPIC_API_KEY is not set. Claude API 連携機能は動作しません。",
    );
  }

  // Issue #118: the default backend changed to `claude-code`, so an owner
  // who only ever set ANTHROPIC_API_KEY (and never touched LLM_BACKEND)
  // would otherwise have their request routing silently switch away from
  // the api pay-as-you-go path they may still expect. Only fires when the
  // default is actually in effect (LLM_BACKEND unset) — an explicit
  // `LLM_BACKEND=claude-code` is a deliberate choice and needs no nudge.
  if (llmBackend === "claude-code" && !isExplicitLlmBackend && hasAnthropicApiKey) {
    console.warn(
      "ANTHROPIC_API_KEY が設定されていますが、既定の claude-code バックエンドが使用されます。" +
        "Claude API（従量課金）経路を使うには server/.env に LLM_BACKEND=api を設定してください。",
    );
  }

  return { port, dbPath, hasAnthropicApiKey, llmBackend };
}
