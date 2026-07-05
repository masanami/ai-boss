const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = "./data/ai-boss.db";

export interface AppConfig {
  port: number;
  dbPath: string;
  hasAnthropicApiKey: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = resolvePort(env);
  const dbPath = env.DB_PATH ?? DEFAULT_DB_PATH;
  const hasAnthropicApiKey = Boolean(env.ANTHROPIC_API_KEY);

  if (!hasAnthropicApiKey) {
    console.warn(
      "ANTHROPIC_API_KEY is not set. Claude API 連携機能は動作しません（本チケットでは未使用）。",
    );
  }

  return { port, dbPath, hasAnthropicApiKey };
}
