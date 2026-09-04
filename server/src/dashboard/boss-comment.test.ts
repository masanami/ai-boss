import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { getCachedBossComment } from "./boss-comment-cache.js";
import { computeTaskFingerprint } from "./task-fingerprint.js";

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
    // insertTask は updated_at に実時刻を使う。フィンガープリントの入力に
    // なるため、CLAUDE.md のテスト方針（現在時刻はモックする）に従って固定
    // する。テスト内の now と同じローカル日付に揃え、TZ 非依存に組む。
    // shouldAdvanceTime: true は await が実タイマー待ちで止まらないようにする。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 6, 6, 8, 0));
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("calls the Claude API and returns the generated text on first request", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    const comment = await getOrGenerateBossComment(db, env, now);

    expect(comment).toBe("今日も一日決めた通りにやれ");
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });

  // Issue #288: ボスコメントは現在日時を「出さない」側の経路。1日1回の
  // キャッシュで再利用されるため、分粒度の時刻を入れると朝生成した文面が
  // 夕方まで陳腐化したまま表示される。同じ purpose:"notification" を使う
  // notification-body.ts は「出す」側であり、この対が「出力可否を purpose
  // から導いていない」ことの検証を兼ねる。
  it("omits the current date/time section from the system prompt (#288)", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    await getOrGenerateBossComment(db, env, now);

    const request = createBossMessageMock.mock.calls[0][1];
    expect(request.system).not.toContain("現在日時:");
  });

  // Issue #117 (D4): this route's small maxTokens is sized for the comment
  // text alone — thinking must stay off so it can't starve max_tokens.
  it("sends thinking: { type: 'disabled' } (Issue #117 — small maxTokens must not compete with thinking)", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    await getOrGenerateBossComment(db, env, now);

    const request = createBossMessageMock.mock.calls[0][1] as { thinking: unknown };
    expect(request.thinking).toEqual({ type: "disabled" });
  });

  it("caches the generated comment under today's local date key", async () => {
    const now = new Date(2026, 6, 6, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    await getOrGenerateBossComment(db, env, now);

    expect(getCachedBossComment(db, "2026-07-06", computeTaskFingerprint([]))).toBe(
      "今日も一日決めた通りにやれ",
    );
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

  // Issue #121 (reproduces #98): the cache key used to be date-only, so a
  // task created after the first same-day request kept serving the stale
  // "no tasks" comment. The fingerprint (id, updated_at) must change once a
  // task exists, invalidating the cache even though the date hasn't changed.
  it("regenerates on the same day once a task is created (Issue #121, reproduces #98)", async () => {
    const first = new Date(2026, 6, 6, 8, 0);
    const second = new Date(2026, 6, 6, 9, 0);
    createBossMessageMock
      .mockResolvedValueOnce(fakeTextMessage("タスクが無いときのひとこと"))
      .mockResolvedValueOnce(fakeTextMessage("タスクがあるときのひとこと"));

    const firstComment = await getOrGenerateBossComment(db, env, first);

    insertTask(db, {
      title: "新しいタスク",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });

    const secondComment = await getOrGenerateBossComment(db, env, second);

    expect(firstComment).toBe("タスクが無いときのひとこと");
    expect(secondComment).toBe("タスクがあるときのひとこと");
    expect(secondComment).not.toBe(firstComment);
    expect(createBossMessageMock).toHaveBeenCalledTimes(2);
  });

  // Cache validity with a non-empty, unchanged task set (fingerprint
  // stability): the existing "cache hit" test above only covers the
  // zero-tasks case, so this confirms the fingerprint itself doesn't churn
  // when nothing about the tasks changes.
  it("does not call the Claude API again when task state is unchanged, with existing tasks present", async () => {
    insertTask(db, {
      title: "既存タスク",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    const first = new Date(2026, 6, 6, 8, 0);
    const second = new Date(2026, 6, 6, 20, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も一日決めた通りにやれ"));

    const firstComment = await getOrGenerateBossComment(db, env, first);
    const secondComment = await getOrGenerateBossComment(db, env, second);

    expect(secondComment).toBe(firstComment);
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });
});
