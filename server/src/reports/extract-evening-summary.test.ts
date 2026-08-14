import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Message } from "../sessions/message.js";

const { createClaudeClientMock, requestVerdictMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  requestVerdictMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    requestVerdict: requestVerdictMock,
  };
});

const { extractEveningSummary } = await import("./extract-evening-summary.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

function calledWithValid(data: {
  reportSummary: string;
  bossComment: string;
  carryOver: string;
}) {
  return { called: true as const, result: { valid: true as const, data } };
}

function calledWithInvalid(error: string) {
  return { called: true as const, result: { valid: false as const, error } };
}

function notCalled() {
  return { called: false as const };
}

const now = new Date(2026, 7, 14, 20, 0);

const eveningMessages: Message[] = [
  { id: 1, session_id: 1, role: "user", content: "今日はタスクAを終わらせた", created_at: now.toISOString() },
  { id: 2, session_id: 1, role: "boss", content: "よくやったな", created_at: now.toISOString() },
];

describe("extractEveningSummary", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("正常系: ツールが有効な3値で呼ばれたら、そのままの値（camelCase）を返す", async () => {
    requestVerdictMock.mockResolvedValue(
      calledWithValid({
        reportSummary: "タスクAを完了した",
        bossComment: "よくやった",
        carryOver: "タスクBを明日に持ち越す",
      }),
    );

    const result = await extractEveningSummary(db, env, eveningMessages, now);

    expect(result).toEqual({
      reportSummary: "タスクAを完了した",
      bossComment: "よくやった",
      carryOver: "タスクBを明日に持ち越す",
    });
  });

  it("持ち越しなし: LLM が carry_over: 'なし' を返したら、そのまま 'なし' を返す", async () => {
    requestVerdictMock.mockResolvedValue(
      calledWithValid({
        reportSummary: "タスクAを完了した",
        bossComment: "よくやった",
        carryOver: "なし",
      }),
    );

    const result = await extractEveningSummary(db, env, eveningMessages, now);

    expect(result?.carryOver).toBe("なし");
  });

  it("api バックエンドでは toolChoice で submit_evening_summary の呼び出しを強制する", async () => {
    requestVerdictMock.mockResolvedValue(
      calledWithValid({ reportSummary: "a", bossComment: "b", carryOver: "なし" }),
    );

    await extractEveningSummary(db, env, eveningMessages, now);

    expect(requestVerdictMock).toHaveBeenCalledTimes(1);
    const [, request, toolName] = requestVerdictMock.mock.calls[0];
    expect(toolName).toBe("submit_evening_summary");
    expect(request.toolChoice).toEqual({ type: "tool", name: "submit_evening_summary" });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].name).toBe("submit_evening_summary");
  });

  it("claude-code バックエンドでは toolChoice を渡さない（プロンプト指示で代替）", async () => {
    createClaudeClientMock.mockReturnValue({ backend: "claude-code", env: {} });
    requestVerdictMock.mockResolvedValue(
      calledWithValid({ reportSummary: "a", bossComment: "b", carryOver: "なし" }),
    );

    await extractEveningSummary(
      db,
      { ...env, LLM_BACKEND: "claude-code" },
      eveningMessages,
      now,
    );

    const [, request] = requestVerdictMock.mock.calls[0];
    expect(request.toolChoice).toBeUndefined();
    // プロンプト指示で代替: システムプロンプトに daily-report purpose の
    // ツール呼び出し指示が含まれる。
    expect(request.system).toContain("submit_evening_summary");
  });

  it("フォールバック: ツールが呼ばれなかった場合は null を返す（例外を投げない）", async () => {
    requestVerdictMock.mockResolvedValue(notCalled());

    const result = await extractEveningSummary(db, env, eveningMessages, now);

    expect(result).toBeNull();
  });

  it("フォールバック: ツール入力が不正形（必須欠落・空文字）の場合は null を返す（例外を投げない）", async () => {
    requestVerdictMock.mockResolvedValue(calledWithInvalid("carry_over is required"));

    const result = await extractEveningSummary(db, env, eveningMessages, now);

    expect(result).toBeNull();
  });

  it("フォールバック: requestVerdict が例外を投げた場合も null を返す（例外を投げない）", async () => {
    requestVerdictMock.mockRejectedValue(new Error("network error"));

    const result = await extractEveningSummary(db, env, eveningMessages, now);

    expect(result).toBeNull();
  });

  it("フォールバック: API キー未設定（MissingApiKeyError）の場合も null を返す（例外を投げない）", async () => {
    createClaudeClientMock.mockImplementation(() => {
      throw new MissingApiKeyError();
    });

    const result = await extractEveningSummary(db, {}, eveningMessages, now);

    expect(result).toBeNull();
    expect(requestVerdictMock).not.toHaveBeenCalled();
  });

  it("タイムアウト: timeoutMs を指定して応答が遅い場合、超過時点で null を返す（フェイクタイマーで決定的に）", async () => {
    vi.useFakeTimers();
    let resolveSlow: (value: unknown) => void = () => {};
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    requestVerdictMock.mockReturnValue(slowPromise);

    const resultPromise = extractEveningSummary(db, env, eveningMessages, now, {
      timeoutMs: 1000,
    });
    // アサーションの取りこぼし（unhandled rejection の警告）を避けるため、
    // タイムアウト後に解決される遅延応答にも空のハンドラを付けておく。
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result).toBeNull();

    // 後から実際の応答が解決しても、既に確定した結果には影響しない
    // （unhandled rejection にもならない）ことを確認する。
    resolveSlow(calledWithValid({ reportSummary: "a", bossComment: "b", carryOver: "なし" }));
    await vi.runAllTimersAsync();
  });

  it("timeoutMs 未指定時はタイムアウトせず、遅い応答でも結果を待って返す", async () => {
    vi.useFakeTimers();
    let resolveSlow: (value: unknown) => void = () => {};
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    requestVerdictMock.mockReturnValue(slowPromise);

    const resultPromise = extractEveningSummary(db, env, eveningMessages, now);

    await vi.advanceTimersByTimeAsync(60_000);
    resolveSlow(
      calledWithValid({ reportSummary: "a", bossComment: "b", carryOver: "なし" }),
    );
    const result = await resultPromise;

    expect(result).toEqual({ reportSummary: "a", bossComment: "b", carryOver: "なし" });
  });
});
