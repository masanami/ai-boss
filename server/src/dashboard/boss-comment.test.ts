import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { getCachedBossComment } from "./boss-comment-cache.js";

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

const { getOrGenerateBossComment } = await import("./boss-comment.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

describe("getOrGenerateBossComment", () => {
  let db: Database.Database;
  // `LLM_BACKEND` を api に固定する（Issue #118）。この関数は
  // `resolveLlmBackend(env)` で自分でバックエンドを解決し、`api` /
  // `claude-code` で挙動が分岐する（短文指示の付与・全角80字フォールバック）。
  // 既定が claude-code になったため、明示しないとこのファイル全体が
  // claude-code 側へ倒れ、api 側の契約（FR-14）を検証するテストが
  // リポジトリから消える（claude-code 側は
  // `boss-comment.claude-code.test.ts` が担保する）。
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key", LLM_BACKEND: "api" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  it("calls the Claude API and returns the generated text on first request", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(comment).toBe("今日も一日決めた通りにやれ");
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });

  it("caches the generated comment under today's local date key", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    await getOrGenerateBossComment(db, env, now);

    expect(getCachedBossComment(db, "2026-07-06")).toBe("今日も一日決めた通りにやれ");
  });

  it("does not call the Claude API again on a second same-day request (cache hit)", async () => {
    const first = new Date(2026, 6, 6, 8, 0);
    const second = new Date(2026, 6, 6, 20, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    const firstComment = await getOrGenerateBossComment(db, env, first);
    const secondComment = await getOrGenerateBossComment(db, env, second);

    expect(secondComment).toBe(firstComment);
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });

  it("calls the Claude API again once the local date changes", async () => {
    const today = new Date(2026, 6, 6, 8, 0);
    const tomorrow = new Date(2026, 6, 7, 8, 0);
    createBossMessageMock
      .mockResolvedValueOnce(fakeTextMessage("今日のひとこと"))
      .mockResolvedValueOnce(fakeTextMessage("明日のひとこと"));

    const todayComment = await getOrGenerateBossComment(db, env, today);
    const tomorrowComment = await getOrGenerateBossComment(db, env, tomorrow);

    expect(todayComment).toBe("今日のひとこと");
    expect(tomorrowComment).toBe("明日のひとこと");
    expect(createBossMessageMock).toHaveBeenCalledTimes(2);
  });

  it("returns the fallback comment without throwing when the API key is missing", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const comment = await getOrGenerateBossComment(db, {}, now);

    expect(typeof comment).toBe("string");
    expect(comment.length).toBeGreaterThan(0);
    expect(createBossMessageMock).not.toHaveBeenCalled();
  });

  it("returns the fallback comment without throwing when the Claude call fails", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockRejectedValue(new Error("connection reset"));

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(typeof comment).toBe("string");
    expect(comment.length).toBeGreaterThan(0);
  });

  it("does not cache the fallback comment, retrying generation on the next call", async () => {
    const first = new Date(2026, 6, 6, 8, 0);
    const second = new Date(2026, 6, 6, 9, 0);
    createBossMessageMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(fakeTextMessage("回復後のひとこと"));

    await getOrGenerateBossComment(db, env, first);
    const secondComment = await getOrGenerateBossComment(db, env, second);

    expect(secondComment).toBe("回復後のひとこと");
    expect(createBossMessageMock).toHaveBeenCalledTimes(2);
  });
});
