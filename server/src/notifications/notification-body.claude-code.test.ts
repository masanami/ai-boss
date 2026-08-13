import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Task } from "../tasks/task.js";

/**
 * AC-10 (Issue #79): exercises `generateNotificationBody` end-to-end through
 * the *real* `claude-client.ts` facade and `claude-code-backend.ts` — see
 * `dashboard/boss-comment.claude-code.test.ts`'s doc comment for why this is
 * a separate file from `notification-body.test.ts` (which mocks
 * `../llm/claude-client.js` wholesale and is backend-agnostic).
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

const { generateNotificationBody } = await import("./notification-body.js");

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "資料作成",
    description: null,
    category: "work",
    priority: "high",
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-05T00:00:00+09:00",
    updated_at: "2026-07-05T00:00:00+09:00",
    completed_at: null,
    ...overrides,
  };
}

describe("generateNotificationBody (claude-code backend, end-to-end via the real facade)", () => {
  let db: Database.Database;
  const env = { LLM_BACKEND: "claude-code" };
  const now = new Date("2026-07-05T10:00:00+09:00");

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    queryMock.mockReset();
  });

  it("generates via the claude-code backend without ANTHROPIC_API_KEY", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("着手しろ"), resultMessage()]));

    const body = await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });

    expect(body).toBe("着手しろ");
  });

  it("falls back to the template without throwing when the claude-code query fails", async () => {
    vi.useFakeTimers();
    try {
      queryMock.mockImplementation(() => {
        throw new Error("claude code executable not found");
      });

      const bodyPromise = generateNotificationBody(db, env, {
        ruleType: "todo_stall",
        escalationLevel: 1,
        task: makeTask(),
        now,
      });
      await vi.advanceTimersByTimeAsync(1_000 + 2_000);

      expect(await bodyPromise).toBe("そろそろ資料作成に着手しよう。");
    } finally {
      vi.useRealTimers();
    }
  });
});
