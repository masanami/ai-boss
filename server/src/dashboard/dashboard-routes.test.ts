import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertNotification } from "../notifications/notifications-repository.js";
import type { DashboardResponse } from "./dashboard.js";

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

const { createApp } = await import("../app.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/dashboard", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日も決めた通りにやれ"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("returns 200 with the full dashboard shape", async () => {
    vi.setSystemTime(new Date(2026, 6, 6, 10, 0));
    const app = createApp(db, env);

    const res = await app.request("/api/dashboard");

    expect(res.status).toBe(200);
    const body = await readJson<DashboardResponse>(res);
    expect(body).toEqual({
      progress: { done: 0, total: 0, ratio: 0 },
      morningSessionHeld: false,
      eveningSessionHeld: false,
      todayMaxEscalationLevel: 0,
      bossComment: "今日も決めた通りにやれ",
      date: "2026-07-06",
    });
  });

  it("reflects task progress, session flags, and the max escalation level", async () => {
    vi.setSystemTime(new Date(2026, 6, 6, 20, 0));
    insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "done",
      boss_comment: null,
      estimated_minutes: null,
    });
    insertTask(db, {
      title: "メール返信",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    insertSession(db, { type: "morning" });
    insertNotification(db, { type: "avoidance", escalation_level: 2, body: "戻れ" });
    const app = createApp(db, env);

    const res = await app.request("/api/dashboard");

    expect(res.status).toBe(200);
    const body = await readJson<DashboardResponse>(res);
    expect(body.progress).toEqual({ done: 1, total: 2, ratio: 0.5 });
    expect(body.morningSessionHeld).toBe(true);
    expect(body.eveningSessionHeld).toBe(false);
    expect(body.todayMaxEscalationLevel).toBe(2);
  });

  it("returns 200 with a fallback comment (not 500) when the API key is missing", async () => {
    vi.setSystemTime(new Date(2026, 6, 6, 10, 0));
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });
    const app = createApp(db, {});

    const res = await app.request("/api/dashboard");

    expect(res.status).toBe(200);
    const body = await readJson<DashboardResponse>(res);
    expect(typeof body.bossComment).toBe("string");
    expect(body.bossComment.length).toBeGreaterThan(0);
    expect(createBossMessageMock).not.toHaveBeenCalled();
  });

  it("does not call the Claude API on a second same-day request", async () => {
    vi.setSystemTime(new Date(2026, 6, 6, 10, 0));
    const app = createApp(db, env);

    await app.request("/api/dashboard");
    vi.setSystemTime(new Date(2026, 6, 6, 18, 0));
    await app.request("/api/dashboard");

    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });
});
