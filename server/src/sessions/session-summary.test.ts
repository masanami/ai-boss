import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { insertSession } from "./sessions-repository.js";
import { insertMessage } from "./messages-repository.js";

const { createClaudeClientMock, createBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  createBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    createBossMessage: createBossMessageMock,
  };
});

const { generateSessionSummary } = await import("./session-summary.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

describe("generateSessionSummary", () => {
  let db: Database.Database;
  // #581 S3: バックエンドは選択の解決関数が `LLM_BACKEND` から決める（以前は引数で `"api"` を渡していた）。
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key", LLM_BACKEND: "api" };
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    createClaudeClientMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    errorSpy.mockRestore();
  });

  it("generates a summary from the session's conversation history", async () => {
    const session = await insertSession(portFor(db), { type: "morning" });
    await insertMessage(portFor(db), {
      session_id: session.id,
      role: "user",
      content: "資料作成を今日中に終わらせます",
    });
    await insertMessage(portFor(db), {
      session_id: session.id,
      role: "boss",
      content: "資料作成を最優先にしろ",
    });
    createBossMessageMock.mockResolvedValue(
      fakeTextMessage("資料作成を最優先にすることを決定した。"),
    );

    const summary = await generateSessionSummary(portFor(db), env, session.id);

    expect(summary).toBe("資料作成を最優先にすることを決定した。");
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });

  // Issue #117 (D4): same rationale as boss-comment.ts/notification-body.ts
  // — small maxTokens must not compete with thinking.
  it("sends thinking: { type: 'disabled' } (Issue #117)", async () => {
    const session = await insertSession(portFor(db), { type: "morning" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    createBossMessageMock.mockResolvedValue(fakeTextMessage("要約"));

    await generateSessionSummary(portFor(db), env, session.id);

    const request = createBossMessageMock.mock.calls[0][1] as { thinking: unknown };
    expect(request.thinking).toEqual({ type: "disabled" });
  });

  it("does not call the LLM and returns null when the session has no messages", async () => {
    const session = await insertSession(portFor(db), { type: "morning" });

    const summary = await generateSessionSummary(portFor(db), env, session.id);

    expect(summary).toBeNull();
    expect(createClaudeClientMock).not.toHaveBeenCalled();
    expect(createBossMessageMock).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when the API key is missing", async () => {
    const session = await insertSession(portFor(db), { type: "morning" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const summary = await generateSessionSummary(portFor(db), { LLM_BACKEND: "api" }, session.id);

    expect(summary).toBeNull();
    expect(createBossMessageMock).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when the Claude call fails", async () => {
    const session = await insertSession(portFor(db), { type: "evening" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    createBossMessageMock.mockRejectedValue(new Error("connection reset with request id xyz"));

    const summary = await generateSessionSummary(portFor(db), env, session.id);

    expect(summary).toBeNull();
  });

  it("returns null when the generated text is empty", async () => {
    const session = await insertSession(portFor(db), { type: "evening" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    createBossMessageMock.mockResolvedValue(fakeTextMessage(""));

    const summary = await generateSessionSummary(portFor(db), env, session.id);

    expect(summary).toBeNull();
  });

  it("logs only the error's class name, never its message, on failure", async () => {
    const session = await insertSession(portFor(db), { type: "evening" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    createBossMessageMock.mockRejectedValue(
      new Error("connection reset with secret request id xyz789"),
    );

    await generateSessionSummary(portFor(db), env, session.id);

    expect(errorSpy).toHaveBeenCalled();
    const loggedArgs = errorSpy.mock.calls.flat().map(String);
    expect(loggedArgs.join(" ")).not.toContain("xyz789");
    expect(loggedArgs.join(" ")).toContain("Error");
  });
});
