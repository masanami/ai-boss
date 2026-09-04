import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Task } from "../tasks/task.js";

const { createClaudeClientMock, streamBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
  };
});

const { generateNotificationBody } = await import("./notification-body.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

function putSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
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

describe("generateNotificationBody", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
  const now = new Date("2026-07-05T10:00:00+09:00");

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  it("reflects the persona (name/tone) and the notification purpose in the system prompt", async () => {
    putSetting(db, "boss_name", "スミス");
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("着手しろ"));

    await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });

    const request = streamBossMessageMock.mock.calls[0][1];
    expect(request.system).toContain("スミス");
    expect(request.system).toContain("通知文面");
  });

  // Issue #288: 催促文面は現在日時を「出す」側。同じ purpose:"notification"
  // を使う boss-comment.ts は「出さない」側であり、この対が「出力可否を
  // purpose から導いていない」ことの検証を兼ねる。
  it("includes the current date/time section in the system prompt (#288)", async () => {
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("手を動かせ"));

    await generateNotificationBody(db, env, {
      ruleType: "deadline_overdue",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });

    const request = streamBossMessageMock.mock.calls[0][1];
    expect(request.system).toContain("現在日時:");
  });

  it("includes the rule type, escalation level, and task title in the user message", async () => {
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("着手しろ"));

    await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 2,
      task: makeTask({ title: "見積書作成" }),
      now,
    });

    const request = streamBossMessageMock.mock.calls[0][1];
    const userMessage = request.messages[0].content as string;
    expect(userMessage).toContain("見積書作成");
    expect(userMessage).toContain("L2");
  });

  it("uses a small max_tokens for cost minimization", async () => {
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("着手しろ"));

    await generateNotificationBody(db, env, {
      ruleType: "silence",
      escalationLevel: 1,
      task: null,
      now,
    });

    const request = streamBossMessageMock.mock.calls[0][1];
    expect(request.maxTokens).toBeLessThanOrEqual(200);
  });

  // Issue #117 (D4): same rationale as boss-comment.ts — small maxTokens
  // must not compete with thinking.
  it("sends thinking: { type: 'disabled' } (Issue #117)", async () => {
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("着手しろ"));

    await generateNotificationBody(db, env, {
      ruleType: "silence",
      escalationLevel: 1,
      task: null,
      now,
    });

    const request = streamBossMessageMock.mock.calls[0][1] as { thinking: unknown };
    expect(request.thinking).toEqual({ type: "disabled" });
  });

  it("returns the trimmed Claude-generated text when the call succeeds", async () => {
    streamBossMessageMock.mockResolvedValue(
      fakeTextMessage("  資料作成に早く着手しろ。  "),
    );

    const body = await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });

    expect(body).toBe("資料作成に早く着手しろ。");
  });

  it("falls back to the fixed template when the API key is missing, without throwing", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask({ title: "資料作成" }),
      now,
    });

    expect(body).toContain("資料作成");
    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  it("falls back to the fixed template when reading settings from the DB fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // resolveBossSettings(db) は db.prepare を呼ぶため、閉じた DB で例外になる
    db.close();

    const body = await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask({ title: "資料作成" }),
      now,
    });

    expect(body).toContain("資料作成");
    expect(streamBossMessageMock).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("falls back to the fixed template when streamBossMessage rejects, without leaking the error message", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    streamBossMessageMock.mockRejectedValue(
      new Error("connection reset with request id secret123"),
    );

    const body = await generateNotificationBody(db, env, {
      ruleType: "silence",
      escalationLevel: 2,
      task: null,
      now,
    });

    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).not.toContain("secret123");
    consoleErrorSpy.mockRestore();
  });

  it("falls back to the fixed template when the response has no text content blocks", async () => {
    streamBossMessageMock.mockResolvedValue(fakeTextMessage(""));

    const body = await generateNotificationBody(db, env, {
      ruleType: "break_overrun",
      escalationLevel: 3,
      task: null,
      now,
    });

    expect(body.length).toBeGreaterThan(0);
  });

  it("interpolates the task title into the todo_stall fallback template", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "todo_stall",
      escalationLevel: 1,
      task: makeTask({ title: "見積書作成" }),
      now,
    });

    expect(body).toContain("見積書作成");
  });

  it("produces different fallback text across escalation levels for the same rule type", async () => {
    createClaudeClientMock.mockImplementation(() => {
      throw new MissingApiKeyError();
    });

    const l1 = await generateNotificationBody(db, env, {
      ruleType: "avoidance",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });
    const l3 = await generateNotificationBody(db, env, {
      ruleType: "avoidance",
      escalationLevel: 3,
      task: makeTask(),
      now,
    });

    expect(l1).not.toBe(l3);
  });

  it("starts the silence L1 fallback with a confirmation question, not a demand", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "silence",
      escalationLevel: 1,
      task: null,
      now,
    });

    expect(body).toContain("？");
  });

  it("returns a generic fallback instead of throwing when escalationLevel is out of the known 1-3 range (defensive: the notifications.escalation_level column has no CHECK constraint)", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "silence",
      escalationLevel: 4 as unknown as 1 | 2 | 3,
      task: null,
      now,
    });

    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a generic fallback instead of throwing when ruleType is not one of the known rule types (defensive: the notifications.type column has no CHECK constraint)", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "unknown_rule" as unknown as "silence",
      escalationLevel: 1,
      task: null,
      now,
    });

    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
  });

  it("interpolates the task title into the deadline_overdue fallback template (added for the scheduler integration, Issue #38)", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "deadline_overdue",
      escalationLevel: 1,
      task: makeTask({ title: "見積書作成" }),
      now,
    });

    expect(body).toContain("見積書作成");
  });

  it("falls back to a fixed morning_meeting template without a task (added for the scheduler integration, Issue #38)", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "morning_meeting",
      escalationLevel: 1,
      task: null,
      now,
    });

    expect(body).toContain("朝会");
  });

  it("falls back to a fixed evening_meeting template without a task (added for the scheduler integration, Issue #38)", async () => {
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const body = await generateNotificationBody(db, env, {
      ruleType: "evening_meeting",
      escalationLevel: 2,
      task: null,
      now,
    });

    expect(body).toContain("夕会");
  });

  it("produces different fallback text across escalation levels for the new deadline_overdue rule type", async () => {
    createClaudeClientMock.mockImplementation(() => {
      throw new MissingApiKeyError();
    });

    const l1 = await generateNotificationBody(db, env, {
      ruleType: "deadline_overdue",
      escalationLevel: 1,
      task: makeTask(),
      now,
    });
    const l3 = await generateNotificationBody(db, env, {
      ruleType: "deadline_overdue",
      escalationLevel: 3,
      task: makeTask(),
      now,
    });

    expect(l1).not.toBe(l3);
  });
});
