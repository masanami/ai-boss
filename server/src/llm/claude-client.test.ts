import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { anthropicCtor, streamMock, createMock } = vi.hoisted(() => {
  const streamMock = vi.fn();
  const createMock = vi.fn();
  const anthropicCtor = vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock, create: createMock },
  }));
  return { anthropicCtor, streamMock, createMock };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicCtor }));

const {
  createClaudeClient,
  MissingApiKeyError,
  LlmTimeoutError,
  DEFAULT_MODEL,
  MAX_TOOL_ROUNDS,
  streamBossMessage,
  buildToolResultMessage,
  createBossMessage,
  requestVerdict,
  runWithTimeoutAndRetry,
} = await import("./claude-client.js");

interface FakeMessage {
  content: unknown[];
}

/**
 * A minimal stand-in for `Anthropic.Messages.MessageStream`: `on("text", ...)`
 * synchronously replays the given deltas, and `finalMessage()` resolves with
 * the given fake message.
 */
function createFakeStream(finalMessage: FakeMessage, textDeltas: string[] = []) {
  return {
    on: vi.fn((event: string, listener: (delta: string) => void) => {
      if (event === "text") {
        for (const delta of textDeltas) {
          listener(delta);
        }
      }
    }),
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  };
}

function apiClient(env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-test-key" }) {
  return createClaudeClient(env);
}

function textMessage(text: string): FakeMessage {
  return { content: text ? [{ type: "text", text, citations: null }] : [] };
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): FakeMessage {
  return { content: [{ type: "tool_use", id, name, input }] };
}

beforeEach(() => {
  anthropicCtor.mockClear();
  streamMock.mockReset();
  createMock.mockReset();
});

describe("createClaudeClient", () => {
  it("throws MissingApiKeyError when ANTHROPIC_API_KEY is not set (api backend)", () => {
    expect(() => createClaudeClient({})).toThrow(MissingApiKeyError);
  });

  it("returns { backend: 'api', client } and constructs the Anthropic client with the api key, 120s timeout, and maxRetries 2", () => {
    const result = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    expect(result.backend).toBe("api");
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "sk-ant-test-key",
      timeout: 120_000,
      maxRetries: 2,
    });
  });

  it("returns { backend: 'claude-code' } without checking ANTHROPIC_API_KEY (FR-10)", () => {
    const result = createClaudeClient({}, "claude-code");

    expect(result).toEqual({ backend: "claude-code" });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });
});

describe("DEFAULT_MODEL", () => {
  it("is claude-sonnet-5", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
  });
});

describe("streamBossMessage (no tools/executeTool — single round)", () => {
  it("streams with the default model when no model is given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5" }));
  });

  it("streams with the given model when one is provided", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-4-8" }));
  });

  it("defaults max_tokens to 1024 when not given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));
  });

  it("passes system, messages, tools, and maxTokens through unchanged", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();
    const messages: Parameters<typeof streamBossMessage>[1]["messages"] = [
      { role: "user", content: "朝会お願いします" },
    ];
    const tools: NonNullable<Parameters<typeof streamBossMessage>[1]["tools"]> = [
      {
        name: "update_task",
        description: "タスクを更新する",
        input_schema: { type: "object", properties: {} },
      },
    ];

    await streamBossMessage(client, {
      system: "あなたはボスです",
      messages,
      tools,
      maxTokens: 2048,
    });

    expect(streamMock).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: "あなたはボスです",
      messages,
      tools,
    });
  });

  it("relays each streamed text delta to onTextDelta", async () => {
    const fakeStream = createFakeStream({ content: [] }, ["今日は", "頑張ろう"]);
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();
    const onTextDelta = vi.fn();

    await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "進捗どうですか" }] },
      { onTextDelta },
    );

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "今日は");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "頑張ろう");
  });

  it("resolves with the final message, including any tool_use blocks, when no executeTool is given", async () => {
    const finalMessage = toolUseMessage("tool_1", "update_task", { id: 1 });
    const fakeStream = createFakeStream(finalMessage);
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    const result = await streamBossMessage(client, {
      messages: [{ role: "user", content: "タスクを更新して" }],
    });

    expect(result).toEqual({
      content: [{ type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } }],
    });
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});

describe("streamBossMessage (tool loop)", () => {
  it("executes the tool, notifies onToolEvent, and continues with a second round when executeTool is given", async () => {
    const firstStream = createFakeStream(toolUseMessage("tool_1", "create_task", { title: "資料作成" }));
    const secondStream = createFakeStream(textMessage("タスクを作成した"), ["タスクを作成した"]);
    streamMock.mockReturnValueOnce(firstStream).mockReturnValueOnce(secondStream);
    const client = apiClient();

    const executeTool = vi.fn().mockResolvedValue({ content: '{"title":"資料作成"}', isError: false });
    const onToolEvent = vi.fn();
    const onTextDelta = vi.fn();

    const result = await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "タスクを作って" }] },
      { executeTool, onToolEvent, onTextDelta },
    );

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledWith("create_task", { title: "資料作成" });
    expect(onToolEvent).toHaveBeenCalledWith({
      name: "create_task",
      input: { title: "資料作成" },
      result: '{"title":"資料作成"}',
      isError: false,
    });
    expect(onTextDelta).toHaveBeenCalledWith("タスクを作成した");
    expect(result).toEqual({ content: [{ type: "text", text: "タスクを作成した" }] });

    const secondCallRequest = streamMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(secondCallRequest.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(secondCallRequest.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "create_task", input: { title: "資料作成" } }],
    });
    expect(secondCallRequest.messages[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: '{"title":"資料作成"}' }],
    });
  });

  it("awaits onToolEvent before requesting the next round (ordering)", async () => {
    const firstStream = createFakeStream(toolUseMessage("tool_1", "create_task", { title: "A" }));
    const secondStream = createFakeStream(textMessage("done"));
    const client = apiClient();

    const order: string[] = [];
    const executeTool = vi.fn().mockImplementation(async () => {
      order.push("executeTool");
      return { content: "ok", isError: false };
    });
    const onToolEvent = vi.fn().mockImplementation(async () => {
      order.push("onToolEvent");
    });
    streamMock.mockImplementationOnce(() => firstStream).mockImplementationOnce(() => {
      order.push("secondRound");
      return secondStream;
    });

    await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "タスクを作って" }] },
      { executeTool, onToolEvent },
    );

    expect(order).toEqual(["executeTool", "onToolEvent", "secondRound"]);
  });

  it("stops after MAX_TOOL_ROUNDS rounds when Claude keeps requesting tool use", async () => {
    streamMock.mockImplementation(() =>
      createFakeStream(toolUseMessage("tool_x", "create_task", { title: "無限タスク" })),
    );
    const client = apiClient();
    const executeTool = vi.fn().mockResolvedValue({ content: "{}", isError: false });

    const result = await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "タスクを作り続けて" }] },
      { executeTool },
    );

    expect(streamMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect(result.content).toEqual([
      { type: "tool_use", id: "tool_x", name: "create_task", input: { title: "無限タスク" } },
    ]);
  });

  it("stops after one round and returns the tool_use-bearing message when tools are present but executeTool is not given", async () => {
    const fakeStream = createFakeStream(toolUseMessage("tool_1", "create_task", { title: "資料作成" }));
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    const result = await streamBossMessage(client, {
      messages: [{ role: "user", content: "タスクを作って" }],
      tools: [{ name: "create_task", description: "", input_schema: { type: "object", properties: {} } }],
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "create_task", input: { title: "資料作成" } },
    ]);
  });
});

describe("createBossMessage", () => {
  it("calls messages.create with the default model when no model is given", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = apiClient();

    await createBossMessage(client, {
      messages: [{ role: "user", content: "進言内容" }],
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5" }));
  });

  it("passes system, messages, tools, toolChoice, and maxTokens through unchanged", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = apiClient();
    const messages: Parameters<typeof createBossMessage>[1]["messages"] = [
      { role: "user", content: "進言内容" },
    ];
    const tools: NonNullable<Parameters<typeof createBossMessage>[1]["tools"]> = [
      {
        name: "submit_verdict",
        description: "裁定を提出する",
        input_schema: { type: "object", properties: {} },
      },
    ];

    await createBossMessage(client, {
      system: "あなたはボスです",
      messages,
      tools,
      toolChoice: { type: "tool", name: "submit_verdict" },
      maxTokens: 2048,
    });

    expect(createMock).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: "あなたはボスです",
      messages,
      tools,
      tool_choice: { type: "tool", name: "submit_verdict" },
    });
  });

  it("resolves with the message returned by messages.create, including tool_use blocks", async () => {
    createMock.mockResolvedValue(toolUseMessage("tool_1", "submit_verdict", { verdict: "upheld" }));
    const client = apiClient();

    const result = await createBossMessage(client, {
      messages: [{ role: "user", content: "進言内容" }],
    });

    expect(result).toEqual({
      content: [{ type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "upheld" } }],
    });
  });
});

describe("buildToolResultMessage", () => {
  it("builds a user message with a tool_result content block", () => {
    const message = buildToolResultMessage("tool_1", "更新しました");

    expect(message).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "更新しました" }],
    });
  });

  it("marks the tool_result as an error when isError is true", () => {
    const message = buildToolResultMessage("tool_1", "失敗しました", { isError: true });

    expect(message).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_1", content: "失敗しました", is_error: true },
      ],
    });
  });
});

describe("requestVerdict", () => {
  const validate = vi.fn((input: unknown) => {
    const record = input as { verdict?: string; response?: string };
    if (record.verdict === "upheld" || record.verdict === "revised") {
      return { valid: true as const, data: { verdict: record.verdict, response: record.response } };
    }
    return { valid: false as const, error: "invalid verdict" };
  });

  it("returns { called: true, result: { valid: true, ... } } when the tool was called with valid input", async () => {
    createMock.mockResolvedValue(
      toolUseMessage("tool_1", "submit_verdict", { verdict: "upheld", response: "維持する" }),
    );
    const client = apiClient();

    const outcome = await requestVerdict(
      client,
      { messages: [{ role: "user", content: "進言内容" }] },
      "submit_verdict",
      validate,
    );

    expect(outcome).toEqual({
      called: true,
      result: { valid: true, data: { verdict: "upheld", response: "維持する" } },
    });
  });

  it("returns { called: true, result: { valid: false, ... } } when the tool was called with invalid input", async () => {
    createMock.mockResolvedValue(
      toolUseMessage("tool_1", "submit_verdict", { verdict: "maybe", response: "検討中" }),
    );
    const client = apiClient();

    const outcome = await requestVerdict(
      client,
      { messages: [{ role: "user", content: "進言内容" }] },
      "submit_verdict",
      validate,
    );

    expect(outcome).toEqual({ called: true, result: { valid: false, error: "invalid verdict" } });
  });

  it("returns { called: false } when the tool was not called", async () => {
    createMock.mockResolvedValue(textMessage("検討中"));
    const client = apiClient();

    const outcome = await requestVerdict(
      client,
      { messages: [{ role: "user", content: "進言内容" }] },
      "submit_verdict",
      validate,
    );

    expect(outcome).toEqual({ called: false });
  });
});

describe("runWithTimeoutAndRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately (no retry) when the first attempt succeeds", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");
    const hasSideEffect = vi.fn().mockReturnValue(false);

    const result = await runWithTimeoutAndRetry(attempt, hasSideEffect);

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff after a failure when there was no side effect", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");
    const hasSideEffect = vi.fn().mockReturnValue(false);

    const promise = runWithTimeoutAndRetry(attempt, hasSideEffect, { baseDelayMs: 10, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("rejects with the last error after exhausting maxRetries (default 2 → 3 attempts)", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("still failing"));
    const hasSideEffect = vi.fn().mockReturnValue(false);

    const promise = runWithTimeoutAndRetry(attempt, hasSideEffect, { baseDelayMs: 10, timeoutMs: 5000 });
    // silence unhandled-rejection noise until we assert below
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10 + 20 + 1);

    await expect(promise).rejects.toThrow("still failing");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("does not retry when hasSideEffect() is already true after the failure (attempt called once)", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("failed after side effect"));
    const hasSideEffect = vi.fn().mockReturnValue(true);

    const promise = runWithTimeoutAndRetry(attempt, hasSideEffect, { baseDelayMs: 10, timeoutMs: 5000 });
    promise.catch(() => {});

    await expect(promise).rejects.toThrow("failed after side effect");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("aborts the attempt's signal and rejects with LlmTimeoutError when the timeout elapses", async () => {
    let observedSignal: AbortSignal | undefined;
    const attempt = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise(() => {
          observedSignal = signal;
        }),
    );
    const hasSideEffect = vi.fn().mockReturnValue(false);

    const promise = runWithTimeoutAndRetry(attempt, hasSideEffect, {
      timeoutMs: 5000,
      maxRetries: 0,
    });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).rejects.toThrow(LlmTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("treats timeoutMs as a whole-call budget shared across retries, not reset per attempt", async () => {
    // baseDelayMs (20ms) alone exceeds timeoutMs (15ms): if the timeout were
    // (incorrectly) reset for each attempt, the 2nd attempt would still fire
    // and could itself succeed/fail well within its own fresh 15ms budget.
    // With a single shared deadline, the overall budget elapses during the
    // backoff wait and no 2nd attempt should ever be made.
    const attempt = vi.fn().mockRejectedValue(new Error("first failure"));
    const hasSideEffect = vi.fn().mockReturnValue(false);

    const promise = runWithTimeoutAndRetry(attempt, hasSideEffect, {
      timeoutMs: 15,
      baseDelayMs: 20,
      maxRetries: 5,
    });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).rejects.toThrow(LlmTimeoutError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
