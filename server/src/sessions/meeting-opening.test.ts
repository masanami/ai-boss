import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

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

const {
  generateMeetingOpening,
  shouldGenerateMeetingOpening,
  MORNING_OPENING_FALLBACK,
  EVENING_OPENING_FALLBACK,
} = await import("./meeting-opening.js");

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

describe("shouldGenerateMeetingOpening", () => {
  it.each([
    ["morning", 0, true],
    ["evening", 0, true],
    ["morning", 1, false],
    ["evening", 3, false],
    ["adhoc", 0, false],
  ] as const)(
    "type=%s messageCount=%i -> %s",
    (sessionType, existingMessageCount, expected) => {
      expect(shouldGenerateMeetingOpening(sessionType, existingMessageCount)).toBe(
        expected,
      );
    },
  );
});

describe("generateMeetingOpening", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key", LLM_BACKEND: "api" };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 20, 8, 0));
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

  it("calls the Claude API and returns the generated text for a morning session", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日はA案件から片付けろ。"));

    const result = await generateMeetingOpening(db, env, now, "morning");

    expect(result).toEqual({ text: "今日はA案件から片付けろ。", succeeded: true });
    expect(createBossMessageMock).toHaveBeenCalledTimes(1);
  });

  it("calls the Claude API and returns the generated text for an evening session", async () => {
    const now = new Date(2026, 7, 20, 18, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("今日の進捗を聞かせろ。"));

    const result = await generateMeetingOpening(db, env, now, "evening");

    expect(result).toEqual({ text: "今日の進捗を聞かせろ。", succeeded: true });
  });

  it("passes sessionType through to the system prompt so the morning flow instruction is included", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("報告しろ"));

    await generateMeetingOpening(db, env, now, "morning");

    expect(createBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: expect.stringContaining("朝会（計画セッション）") }),
    );
  });

  it("passes sessionType through to the system prompt so the evening flow instruction is included", async () => {
    const now = new Date(2026, 7, 20, 18, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("報告しろ"));

    await generateMeetingOpening(db, env, now, "evening");

    expect(createBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: expect.stringContaining("夕会（報告セッション）") }),
    );
  });

  // Issue #288: 会の開始ひとことは現在日時を「出す」側の経路。
  it("includes the current date/time section in the system prompt (#288)", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("報告しろ"));

    await generateMeetingOpening(db, env, now, "morning");

    expect(createBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: expect.stringContaining("現在日時:") }),
    );
  });

  it("sends thinking: { type: 'disabled' } and a small maxTokens budget", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage("報告しろ"));

    await generateMeetingOpening(db, env, now, "morning");

    expect(createBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ thinking: { type: "disabled" }, maxTokens: 150 }),
    );
  });

  it("AC-5: returns the morning fallback (succeeded: false) without throwing when the Claude call fails", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockRejectedValue(new Error("connection reset with request id xyz"));

    const result = await generateMeetingOpening(db, env, now, "morning");

    expect(result).toEqual({ text: MORNING_OPENING_FALLBACK, succeeded: false });
  });

  it("AC-5: returns the evening fallback (succeeded: false) without throwing when the Claude call fails", async () => {
    const now = new Date(2026, 7, 20, 18, 0);
    createBossMessageMock.mockRejectedValue(new Error("connection reset"));

    const result = await generateMeetingOpening(db, env, now, "evening");

    expect(result).toEqual({ text: EVENING_OPENING_FALLBACK, succeeded: false });
  });

  it("returns the fallback when the generated text is empty", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    createBossMessageMock.mockResolvedValue(fakeTextMessage(""));

    const result = await generateMeetingOpening(db, env, now, "morning");

    expect(result).toEqual({ text: MORNING_OPENING_FALLBACK, succeeded: false });
  });

  it("falls back after the 10s timeout when generation does not resolve in time", async () => {
    const now = new Date(2026, 7, 20, 18, 0);
    createBossMessageMock.mockReturnValue(new Promise(() => {}));

    const resultPromise = generateMeetingOpening(db, env, now, "evening");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result).toEqual({ text: EVENING_OPENING_FALLBACK, succeeded: false });
  });

  it("does not fall back before the 10s timeout elapses", async () => {
    const now = new Date(2026, 7, 20, 18, 0);
    let resolveMessage: (message: Anthropic.Message) => void = () => {};
    createBossMessageMock.mockReturnValue(
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    );

    const resultPromise = generateMeetingOpening(db, env, now, "evening");
    await vi.advanceTimersByTimeAsync(9_000);
    resolveMessage(fakeTextMessage("ぎりぎり間に合った"));
    const result = await resultPromise;

    expect(result).toEqual({ text: "ぎりぎり間に合った", succeeded: true });
  });

  it("logs only the error's class name, never its message, on failure (ADR 0002 決定4)", async () => {
    const now = new Date(2026, 7, 20, 8, 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createBossMessageMock.mockRejectedValue(
      new Error("request id abc123 leaked into the message"),
    );

    await generateMeetingOpening(db, env, now, "morning");

    const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText).not.toContain("abc123");
    expect(loggedText).toContain("Error");
    errorSpy.mockRestore();
  });
});
