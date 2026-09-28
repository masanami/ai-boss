import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";

const { createClaudeClientMock, streamBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
}));

vi.mock("./llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm/claude-client.js")>();
  return { ...actual, createClaudeClient: createClaudeClientMock, streamBossMessage: streamBossMessageMock };
});

const { openDatabase } = await import("./db/connection.js");
const { runMigrations } = await import("./db/migrate.js");
const { portFor } = await import("./db/test-support/port-for.js");
const { createCoreApp } = await import("./core-app.js");

/**
 * `createCoreApp` の `onStateChangingRequest`（#585 S2）のうち、SSE で応答する
 * チャット（ボスのツールが応答を返した後のストリームの中で状態を変える）の
 * 扱い。LLM を模擬する必要があるため core-app.test.ts から分けた。
 */
describe("onStateChangingRequest with the SSE chat route", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  it("is called again when the SSE stream finishes (after the boss's tools could have changed state)", async () => {
    let calls = 0;
    const app = createCoreApp(portFor(db), {}, { onStateChangingRequest: () => calls++ });
    const session = (await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "adhoc" }),
      })
    ).json()) as { id: number };
    calls = 0;

    let finishLlm!: () => void;
    streamBossMessageMock.mockImplementation(
      () =>
        new Promise<Anthropic.Message>((resolve) => {
          finishLlm = () =>
            resolve({ content: [{ type: "text", text: "了解した", citations: null }] } as unknown as Anthropic.Message);
        }),
    );

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = res.text();
    await vi.waitFor(() => expect(finishLlm).toBeDefined());
    expect(calls).toBe(1);
    finishLlm();
    await body;
    expect(calls).toBe(2);
  });

  it("is called again when the client stops the SSE stream (the stop button hangs up)", async () => {
    let calls = 0;
    const app = createCoreApp(portFor(db), {}, { onStateChangingRequest: () => calls++ });
    const session = (await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "adhoc" }),
      })
    ).json()) as { id: number };
    calls = 0;
    streamBossMessageMock.mockImplementation(() => new Promise(() => undefined));

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    await vi.waitFor(() => expect(streamBossMessageMock).toHaveBeenCalled());
    expect(calls).toBe(1);
    await res.body!.cancel();
    expect(calls).toBe(2);
  });
});
