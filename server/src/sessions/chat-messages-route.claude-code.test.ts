import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

/**
 * 受入基準（S1・機能仕様 docs/features/tauri-in-app-runtime.md）AC8:
 * 「開発者用の版で `LLM_BACKEND` 未設定のとき、チャットは `claude-code`
 * バックエンドで処理される」を、チャットの実ルート（`/api/sessions/:id/messages`）
 * を通じて end-to-end で固定する。
 *
 * `chat-messages-route.test.ts`（`../llm/claude-client.js` を丸ごとモック
 * するのでバックエンド非依存）・`chat-messages-route.issue-117.test.ts`
 * （`@anthropic-ai/sdk` をモックして `api` バックエンドを固定検証）とは異なり、
 * このファイルは `@anthropic-ai/claude-agent-sdk` をモックし、`LLM_BACKEND`
 * を一切設定しない — `createApp` が `llmBackend` 省略時に
 * `resolveLlmBackend(env)` で解決した既定値（`claude-code`、Issue #118）が
 * 実際にチャットの生成経路まで届くことを確認する
 * （`dashboard/boss-comment.claude-code.test.ts` の「別ファイルにする」設計
 * を踏襲）。
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

describe("POST /api/sessions/:id/messages — claude-code backend, end-to-end via the real facade (AC8)", () => {
  let db: Database.Database;
  // `LLM_BACKEND` を一切設定しない — Issue #118 の既定（claude-code）が実際に
  // チャットへ効くことを確認するのが本テストの主眼。
  const env = {};

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    queryMock.mockReset();
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

  it("processes the chat via the claude-code backend (Agent SDK query) when LLM_BACKEND is unset", async () => {
    queryMock.mockReturnValueOnce(
      toAsyncIterable([assistantTextMessage("承知した、進めろ。"), resultMessage()]),
    );

    const app = createApp(db, env);
    const session = await createSession(app);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "資料作成を進めていいか相談したい" }),
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("承知した、進めろ。");

    // Agent SDK の query() が実際に呼ばれたこと自体が、api バックエンド
    // （`@anthropic-ai/sdk`）ではなく claude-code バックエンド経由で処理
    // されたことの直接の証拠になる。
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
