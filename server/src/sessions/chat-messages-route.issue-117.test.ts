import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

/**
 * Issue #117 full-stack reproduction: unlike `chat-messages-route.test.ts`
 * (which mocks `../llm/claude-client.js` and so can never exercise
 * `normalizeMessage`'s content-dropping behavior), this file mocks the raw
 * `@anthropic-ai/sdk` client — the same technique `api-backend.test.ts`
 * uses — so the real `streamBossMessage` → `streamApiMessage` →
 * `normalizeMessage` chain runs end to end through the actual HTTP route.
 * This is what pins the originally reported symptom as a fixed regression:
 * a thinking-only SDK response with `stop_reason: "max_tokens"` must no
 * longer produce a silently-empty boss reply, but the route's documented
 * fallback text.
 */

const { anthropicCtor, streamMock } = vi.hoisted(() => {
  const streamMock = vi.fn();
  const anthropicCtor = vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock, create: vi.fn() },
  }));
  return { anthropicCtor, streamMock };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicCtor }));

const { createApp } = await import("../app.js");

interface SseEvent {
  event: string;
  data: string;
}

function parseSseEvents(raw: string): SseEvent[] {
  return raw
    .trim()
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLines = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : "message",
        data: dataLines.join("\n"),
      };
    });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * A minimal stand-in for `Anthropic.Messages.MessageStream`, matching
 * `api-backend.test.ts`'s `createFakeStream` helper: `finalMessage()`
 * resolves with the given (thinking-only, in this file) message and no
 * `text` events are ever emitted — reproducing a turn that never streamed
 * any visible text before hitting `max_tokens`.
 */
function createThinkingOnlyStream() {
  return {
    on: vi.fn(),
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "thinking", thinking: "内部推論のみでトークンを使い切った..." }],
      stop_reason: "max_tokens",
      model: "claude-sonnet-5",
      usage: { input_tokens: 5000, output_tokens: 1024 },
    }),
  };
}

describe("POST /api/sessions/:id/messages — Issue #117 reproduction", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    anthropicCtor.mockClear();
    streamMock.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  async function createSession(app: ReturnType<typeof createApp>): Promise<Session> {
    return readJson<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "adhoc" }),
      }),
    );
  }

  it("falls back to the documented 'no response' text (not an empty message) when the SDK returns a thinking-only, max_tokens-truncated turn", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    streamMock.mockReturnValue(createThinkingOnlyStream());
    const app = createApp(db, env);
    const session = await createSession(app);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日の決定を踏まえて相談したい" }),
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("応答を生成できなかった。もう一度送ってくれ。");

    // The diagnostic (D5) fired from normalizeMessage — the whole point of
    // this end-to-end test vs. the backend-level one is confirming it's
    // reachable through the real route, not just unit-tested in isolation.
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no text/tool_use content"),
      expect.objectContaining({ stopReason: "max_tokens" }),
    );

    consoleWarnSpy.mockRestore();
  });
});
