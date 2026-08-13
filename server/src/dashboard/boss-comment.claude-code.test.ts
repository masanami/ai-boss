import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { getCachedBossComment } from "./boss-comment-cache.js";

/**
 * AC-10 (Issue #79): exercises `getOrGenerateBossComment` end-to-end through
 * the *real* `claude-client.ts` facade and `claude-code-backend.ts` — only
 * `@anthropic-ai/claude-agent-sdk` itself is mocked (unlike
 * `boss-comment.test.ts`, which mocks `../llm/claude-client.js` wholesale
 * and is backend-agnostic). This is what actually proves `LLM_BACKEND=claude-code`
 * takes effect for the dashboard comment (via `resolveLlmBackend(env)`,
 * wired in this ticket) and that FR-14's short-text instruction / overflow
 * fallback behave as specified.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
  createSdkMcpServer: vi.fn((options: { name: string; tools: unknown[] }) => ({
    type: "sdk",
    ...options,
  })),
}));

const { getOrGenerateBossComment, CLAUDE_CODE_SHORT_TEXT_INSTRUCTION } = await import("./boss-comment.js");

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function assistantTextMessage(text: string) {
  return { type: "assistant" as const, message: { content: [{ type: "text", text }] }, parent_tool_use_id: null };
}

function resultMessage(subtype: "success" = "success") {
  return { type: "result" as const, subtype };
}

function mockClaudeCodeReply(text: string): void {
  queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage(text), resultMessage()]));
}

describe("getOrGenerateBossComment (claude-code backend, end-to-end via the real facade)", () => {
  let db: Database.Database;
  const env = { LLM_BACKEND: "claude-code" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    queryMock.mockReset();
  });

  it("generates via the claude-code backend without ANTHROPIC_API_KEY and caches the result", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    mockClaudeCodeReply("今日も一日決めた通りにやれ");

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(comment).toBe("今日も一日決めた通りにやれ");
    expect(getCachedBossComment(db, "2026-07-06")).toBe("今日も一日決めた通りにやれ");
  });

  it("includes the FR-14 short-text instruction in the prompt sent to the Agent SDK", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    mockClaudeCodeReply("今日も一日決めた通りにやれ");

    await getOrGenerateBossComment(db, env, now);

    const promptSent = (queryMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(promptSent).toContain(CLAUDE_CODE_SHORT_TEXT_INSTRUCTION);
  });

  it("falls back to the template (and does not cache) when the response exceeds the 全角80字 limit", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    const tooLong = "あ".repeat(81);
    mockClaudeCodeReply(tooLong);

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(comment).toBe("今日も決めたことを淡々とこなせ。");
    expect(getCachedBossComment(db, "2026-07-06")).toBeUndefined();
  });

  it("accepts a response exactly at the 全角80字 limit (boundary)", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    const exactly80 = "あ".repeat(80);
    mockClaudeCodeReply(exactly80);

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(comment).toBe(exactly80);
  });

  it("falls back to the template without throwing when the claude-code query fails (e.g. spawn/auth failure)", async () => {
    // The facade retries claude-code failures up to twice (AC-11); use fake
    // timers so the exponential backoff between attempts doesn't slow the
    // test down with real waits.
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 6, 6, 8, 0);
      queryMock.mockImplementation(() => {
        throw new Error("claude code executable not found");
      });

      const commentPromise = getOrGenerateBossComment(db, env, now);
      await vi.advanceTimersByTimeAsync(1_000 + 2_000);

      expect(await commentPromise).toBe("今日も決めたことを淡々とこなせ。");
    } finally {
      vi.useRealTimers();
    }
  });
});
