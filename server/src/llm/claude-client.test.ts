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

const { streamClaudeCodeMessageMock, createClaudeCodeMessageMock } = vi.hoisted(() => ({
  streamClaudeCodeMessageMock: vi.fn(),
  createClaudeCodeMessageMock: vi.fn(),
}));

// The `claude-code` backend's own behavior (Agent SDK message normalization,
// MCP tool wiring, etc.) is covered independently in
// `backends/claude-code-backend.test.ts`. Here we only verify how the facade
// (`claude-client.ts`) *wires into* that backend: single-dispatch (no
// MAX_TOOL_ROUNDS loop), callback forwarding, and the AC-11 timeout/retry
// policy — so the backend module itself is mocked rather than the raw
// `@anthropic-ai/claude-agent-sdk`.
vi.mock("./backends/claude-code-backend.js", async (importOriginal) => {
  // `buildClaudeCodeEnv` (FR-09/AC-06) is real production logic exercised
  // via `createClaudeClient` in this file's tests — only the query-dispatch
  // functions are mocked (their own behavior is covered independently in
  // `backends/claude-code-backend.test.ts`, per this file's header comment).
  const actual = await importOriginal<typeof import("./backends/claude-code-backend.js")>();
  return {
    ...actual,
    streamClaudeCodeMessage: streamClaudeCodeMessageMock,
    createClaudeCodeMessage: createClaudeCodeMessageMock,
  };
});

const {
  createClaudeClient,
  MissingApiKeyError,
  LlmTimeoutError,
  ClaudeCodeUnavailableError,
  CLAUDE_CODE_UNAVAILABLE_HINT,
  DEFAULT_MODEL,
  MAX_TOOL_ROUNDS,
  streamBossMessage,
  buildToolResultMessage,
  createBossMessage,
  requestVerdict,
  runWithTimeoutAndRetry,
} = await import("./claude-client.js");

function claudeCodeClient() {
  return createClaudeClient({}, "claude-code");
}

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
  return createClaudeClient(env, "api");
}

/**
 * A fake `MessageStream` whose `finalMessage()` rejects with `error` instead
 * of resolving — used to simulate a transient SDK-level failure (network
 * error, etc.) for the api backend's Issue #176 timeout/retry wiring tests
 * below. Optionally replays `textDeltas` first (via `on("text", ...)`) so a
 * test can simulate "some text was already relayed before the failure".
 */
function createFailingStream(error: Error, textDeltas: string[] = []) {
  return {
    on: vi.fn((event: string, listener: (delta: string) => void) => {
      if (event === "text") {
        for (const delta of textDeltas) {
          listener(delta);
        }
      }
    }),
    finalMessage: vi.fn().mockRejectedValue(error),
  };
}

/** A fake `MessageStream` whose `finalMessage()` never resolves — used to
 * simulate an SDK call that hangs until the facade's shared timeout budget
 * aborts it (Issue #176). */
function createHangingStream() {
  return {
    on: vi.fn(),
    finalMessage: vi.fn().mockReturnValue(new Promise(() => {})),
  };
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
  streamClaudeCodeMessageMock.mockReset();
  createClaudeCodeMessageMock.mockReset();
});

describe("createClaudeClient", () => {
  it("throws MissingApiKeyError when ANTHROPIC_API_KEY is not set (api backend explicit)", () => {
    expect(() => createClaudeClient({}, "api")).toThrow(MissingApiKeyError);
  });

  it("returns { backend: 'api', client } and constructs the Anthropic client with the api key, 120s timeout, and maxRetries 0 (Issue #176: SDK-level retry disabled in favor of the facade's runWithTimeoutAndRetry)", () => {
    const result = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" }, "api");

    expect(result.backend).toBe("api");
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "sk-ant-test-key",
      timeout: 120_000,
      maxRetries: 0,
    });
  });

  it("defaults to the claude-code backend (DEFAULT_LLM_BACKEND, Issue #118) when the backend argument is omitted and LLM_BACKEND is unset, and never throws MissingApiKeyError even without ANTHROPIC_API_KEY", () => {
    const result = createClaudeClient({});

    expect(result.backend).toBe("claude-code");
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("resolves the omitted backend argument from env, so an explicit LLM_BACKEND=api still wins over the new default (Issue #118 — FR-12: no silent backend switch)", () => {
    const result = createClaudeClient({
      LLM_BACKEND: "api",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
    });

    expect(result.backend).toBe("api");
  });

  it("returns { backend: 'claude-code', env } without checking ANTHROPIC_API_KEY (FR-10)", () => {
    const result = createClaudeClient({}, "claude-code");

    expect(result).toEqual({
      backend: "claude-code",
      env: {
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  // FR-09 / AC-06: env exclusion/injection/inheritance is real production
  // logic (`buildClaudeCodeEnv`, not mocked in this file — see the
  // `vi.mock("./backends/claude-code-backend.js", ...)` header comment), so
  // asserting it here through `createClaudeClient`'s public surface exercises
  // the actual implementation rather than a stand-in.
  it("excludes ANTHROPIC_API_KEY, adds the telemetry-disable vars, and preserves PATH/HOME (FR-09, AC-06)", () => {
    const result = createClaudeClient(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/owner",
        ANTHROPIC_API_KEY: "sk-ant-should-be-excluded",
        SOME_OTHER_VAR: "kept",
      },
      "claude-code",
    );

    expect(result.backend).toBe("claude-code");
    const env = (result as { backend: "claude-code"; env: Record<string, string | undefined> }).env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/owner");
    expect(env.SOME_OTHER_VAR).toBe("kept");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
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

    // Issue #176: the facade now always forwards its own shared AbortSignal
    // (2nd arg to `client.messages.stream`) — assert its presence alongside
    // the field under test rather than dropping the arg-count check.
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("streams with the given model when one is provided", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("defaults max_tokens to 16000 when not given (Issue #117: max_tokens bounds thinking+text combined)", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 16000 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("defaults thinking to { type: 'disabled' } when not given (Issue #117 fail-safe default)", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: "disabled" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes the caller's thinking/outputConfig through, overriding the default", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not send output_config when outputConfig is not given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = apiClient();

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    const sentRequest = streamMock.mock.calls[0][0] as Record<string, unknown>;
    expect("output_config" in sentRequest).toBe(false);
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

    expect(streamMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-5",
        max_tokens: 2048,
        system: "あなたはボスです",
        messages,
        tools,
        thinking: { type: "disabled" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

    expect(result.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } },
    ]);
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
    expect(result.content).toEqual([{ type: "text", text: "タスクを作成した" }]);

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

  // Issue #117 (self-review: design-reviewer). The DEFAULT_MAX_TOKENS
  // increase is what first makes "thinking *and* a tool_use in the same
  // turn" reachable on the chat route, and the API requires that turn to be
  // replayed with its original thinking block + signature before the
  // tool_result. Echoing the normalized content (which drops thinking)
  // would break every tool-using chat turn, so pin the verbatim replay.
  it("replays the assistant turn verbatim — thinking block and signature intact — before the tool_result", async () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "タスク名を決める内部推論",
      signature: "sig_abc123",
    };
    const firstStream = createFakeStream({
      content: [
        thinkingBlock,
        { type: "tool_use", id: "tool_1", name: "create_task", input: { title: "資料作成" } },
      ],
    });
    const secondStream = createFakeStream(textMessage("タスクを作成した"));
    streamMock.mockReturnValueOnce(firstStream).mockReturnValueOnce(secondStream);

    await streamBossMessage(
      apiClient(),
      {
        messages: [{ role: "user", content: "タスクを作って" }],
        thinking: { type: "adaptive" },
      },
      { executeTool: vi.fn().mockResolvedValue({ content: "{}", isError: false }) },
    );

    const secondCallRequest = streamMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(secondCallRequest.messages[1]).toEqual({
      role: "assistant",
      content: [
        thinkingBlock,
        { type: "tool_use", id: "tool_1", name: "create_task", input: { title: "資料作成" } },
      ],
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

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

    expect(createMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-5",
        max_tokens: 2048,
        system: "あなたはボスです",
        messages,
        tools,
        tool_choice: { type: "tool", name: "submit_verdict" },
        thinking: { type: "disabled" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("defaults thinking to { type: 'disabled' } when not given", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = apiClient();

    await createBossMessage(client, {
      messages: [{ role: "user", content: "進言内容" }],
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: "disabled" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("resolves with the message returned by messages.create, including tool_use blocks", async () => {
    createMock.mockResolvedValue(toolUseMessage("tool_1", "submit_verdict", { verdict: "upheld" }));
    const client = apiClient();

    const result = await createBossMessage(client, {
      messages: [{ role: "user", content: "進言内容" }],
    });

    expect(result.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "upheld" } },
    ]);
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

  it("uses the last matching tool_use block when the tool was called more than once (e.g. a multi-turn claude-code response)", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "revised", response: "第一稿" } },
        { type: "tool_use", id: "tool_2", name: "submit_verdict", input: { verdict: "upheld", response: "最終稿" } },
      ],
    });
    const client = apiClient();

    const outcome = await requestVerdict(
      client,
      { messages: [{ role: "user", content: "進言内容" }] },
      "submit_verdict",
      validate,
    );

    expect(outcome).toEqual({
      called: true,
      result: { valid: true, data: { verdict: "upheld", response: "最終稿" } },
    });
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

describe("streamBossMessage (claude-code backend wiring)", () => {
  it("makes exactly one dispatch call — no MAX_TOOL_ROUNDS loop — even when the backend's result still contains a tool_use block", async () => {
    streamClaudeCodeMessageMock.mockResolvedValue({
      content: [{ type: "tool_use", id: "toolu_1", name: "create_task", input: { title: "資料作成" } }],
    });
    const executeTool = vi.fn().mockResolvedValue({ content: "ok", isError: false });

    const result = await streamBossMessage(
      claudeCodeClient(),
      { messages: [{ role: "user", content: "タスクを作って" }], tools: [] },
      { executeTool },
    );

    expect(streamClaudeCodeMessageMock).toHaveBeenCalledTimes(1);
    // The outer facade loop never calls `executeTool` itself for claude-code
    // — the backend's own in-process MCP handler is the execution site
    // (would otherwise double-execute the tool the backend already ran).
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "create_task", input: { title: "資料作成" } },
    ]);
  });

  // D6 regression (Issue #117): claude-code has no thinking/max_tokens
  // starvation problem of its own (the Agent SDK controls its own turn
  // budget), and `backends/claude-code-backend.ts` is deliberately left
  // untouched by this fix — dispatchStream must keep destructuring only
  // model/system/messages/tools for this branch, even when a caller passes
  // thinking/outputConfig (e.g. because it shares a request builder with an
  // api-backend call site).
  it("does not forward thinking/outputConfig to the claude-code backend even when the caller sets them", async () => {
    streamClaudeCodeMessageMock.mockResolvedValue({ content: [{ type: "text", text: "了解" }] });

    await streamBossMessage(claudeCodeClient(), {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });

    expect(streamClaudeCodeMessageMock).toHaveBeenCalledWith(
      { model: "claude-sonnet-5", system: undefined, messages: [{ role: "user", content: "hi" }], tools: undefined },
      expect.anything(),
    );
  });

  it("forwards model/system/messages/tools and onTextDelta/onToolEvent/executeTool through to the backend", async () => {
    streamClaudeCodeMessageMock.mockResolvedValue({ content: [{ type: "text", text: "了解" }] });
    const onTextDelta = vi.fn();
    const onToolEvent = vi.fn();
    const executeTool = vi.fn();
    const tools = [{ name: "create_task", description: "", input_schema: { type: "object" as const, properties: {} } }];

    await streamBossMessage(
      claudeCodeClient(),
      { model: "claude-opus-4-8", system: "あなたはボスです", messages: [{ role: "user", content: "hi" }], tools },
      { onTextDelta, onToolEvent, executeTool },
    );

    expect(streamClaudeCodeMessageMock).toHaveBeenCalledWith(
      { model: "claude-opus-4-8", system: "あなたはボスです", messages: [{ role: "user", content: "hi" }], tools },
      expect.objectContaining({ onToolEvent }),
    );
    // `onTextDelta` is wrapped (to track "text already streamed" for AC-11's
    // retry-safety — see dispatchStream's doc comment), so the backend
    // receives a *different* function reference; assert it still relays to
    // the original callback instead of comparing references.
    const passedOptions = streamClaudeCodeMessageMock.mock.calls[0][1] as {
      executeTool: typeof executeTool;
      onTextDelta: (delta: string) => void;
    };
    expect(typeof passedOptions.executeTool).toBe("function");
    passedOptions.onTextDelta("今日は");
    expect(onTextDelta).toHaveBeenCalledWith("今日は");
  });

  // self-review (code-reviewer): the FR-09/AC-06 env-exclusion wiring
  // (`client.env` → `streamClaudeCodeMessage`'s options) had no facade-level
  // assertion — removing `env: client.env` from `dispatchStream` would have
  // left the whole suite green while silently re-inheriting the full
  // `process.env` (including `ANTHROPIC_API_KEY`) in the subprocess.
  it("forwards the client's built env (FR-09/AC-06) to the backend, not just callbacks", async () => {
    streamClaudeCodeMessageMock.mockResolvedValue({ content: [{ type: "text", text: "了解" }] });
    const client = createClaudeClient(
      { ANTHROPIC_API_KEY: "sk-ant-should-be-excluded", PATH: "/usr/bin" },
      "claude-code",
    );

    await streamBossMessage(client, { messages: [{ role: "user", content: "hi" }] });

    expect(streamClaudeCodeMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      }),
    );
  });

  it("retries once with exponential backoff after a transient failure with no side effect (AC-11)", async () => {
    vi.useFakeTimers();
    try {
      streamClaudeCodeMessageMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      const promise = streamBossMessage(claudeCodeClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(streamClaudeCodeMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry once a DB-writing tool has been executed during the failed attempt (AC-11 — no duplicate side effects)", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok", isError: false });
    streamClaudeCodeMessageMock.mockImplementationOnce(
      async (_request: unknown, options: { executeTool?: typeof executeTool }) => {
        await options.executeTool?.("create_task", { title: "x" });
        throw new Error("failed after the tool already ran");
      },
    );

    await expect(
      streamBossMessage(
        claudeCodeClient(),
        { messages: [{ role: "user", content: "タスクを作って" }] },
        { executeTool },
      ),
    ).rejects.toThrow("failed after the tool already ran");

    expect(streamClaudeCodeMessageMock).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("does not retry once text has already been streamed to the caller during the failed attempt (self-review — no duplicated text on retry)", async () => {
    const onTextDelta = vi.fn();
    streamClaudeCodeMessageMock.mockImplementationOnce(
      async (_request: unknown, options: { onTextDelta?: (delta: string) => void }) => {
        options.onTextDelta?.("今日は");
        throw new Error("failed mid-stream, after text was already relayed");
      },
    );

    await expect(
      streamBossMessage(
        claudeCodeClient(),
        { messages: [{ role: "user", content: "進捗どうですか" }] },
        { onTextDelta },
      ),
    ).rejects.toThrow("failed mid-stream, after text was already relayed");

    // A retry here would have called streamClaudeCodeMessage a 2nd time and
    // relayed "今日は" to `onTextDelta` again, duplicating it in both the SSE
    // stream and the persisted message (`fullText` accumulation in
    // chat-messages-route.ts).
    expect(streamClaudeCodeMessageMock).toHaveBeenCalledTimes(1);
    expect(onTextDelta).toHaveBeenCalledTimes(1);
  });

  // FR-12 / AC-07's "api への自動切替が発生しない" clause — self-review
  // (code-reviewer/design-reviewer): the design guarantees this structurally
  // (dispatchStream never branches to the `api` backend once `client.backend
  // === "claude-code"`), but nothing pinned the invariant with a failure
  // scenario. Uses the api-backend mocks already declared at this file's top
  // (`anthropicCtor`/`streamMock`).
  it("does not fall back to the api backend when claude-code fails, even after retries are exhausted (FR-12, AC-07)", async () => {
    vi.useFakeTimers();
    try {
      streamClaudeCodeMessageMock.mockRejectedValue(
        new ClaudeCodeUnavailableError(
          "not_installed",
          "claude-code backend: the Claude Code executable was not found (ENOENT) — is it installed?",
        ),
      );

      const promise = streamBossMessage(claudeCodeClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);

      await expect(promise).rejects.toThrow();
      expect(anthropicCtor).not.toHaveBeenCalled();
      expect(streamMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs the CLAUDE_CODE_UNAVAILABLE_HINT via console.warn and still rejects with the original ClaudeCodeUnavailableError (Issue #118)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unavailableError = new ClaudeCodeUnavailableError(
        "not_installed",
        "claude-code backend: the Claude Code executable was not found (ENOENT) — is it installed?",
      );
      streamClaudeCodeMessageMock.mockRejectedValue(unavailableError);

      const promise = streamBossMessage(claudeCodeClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);

      await expect(promise).rejects.toBe(unavailableError);
      expect(warnSpy).toHaveBeenCalledWith(CLAUDE_CODE_UNAVAILABLE_HINT);
      // Logged exactly once — the warning belongs to the whole dispatch
      // (after retries are exhausted), not once per retry attempt.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("createBossMessage / requestVerdict (claude-code backend wiring)", () => {
  // D6 regression (Issue #117) — see the equivalent streamBossMessage test
  // above for the rationale.
  it("does not forward thinking/outputConfig to the claude-code backend even when the caller sets them", async () => {
    createClaudeCodeMessageMock.mockResolvedValue({ content: [{ type: "text", text: "了解" }] });

    await createBossMessage(claudeCodeClient(), {
      messages: [{ role: "user", content: "進言内容" }],
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });

    expect(createClaudeCodeMessageMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-5",
        system: undefined,
        messages: [{ role: "user", content: "進言内容" }],
        tools: undefined,
      },
      expect.anything(),
    );
  });

  it("createBossMessage forwards model/system/messages/tools to the backend and resolves with its content", async () => {
    createClaudeCodeMessageMock.mockResolvedValue({
      content: [{ type: "tool_use", id: "toolu_v1", name: "submit_verdict", input: { verdict: "upheld", response: "維持する" } }],
    });

    const result = await createBossMessage(claudeCodeClient(), {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      tools: [{ name: "submit_verdict", description: "", input_schema: { type: "object", properties: {} } }],
    });

    expect(createClaudeCodeMessageMock).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-5",
        system: undefined,
        messages: [{ role: "user", content: "進言内容" }],
        tools: [{ name: "submit_verdict", description: "", input_schema: { type: "object", properties: {} } }],
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        // self-review (code-reviewer): dispatchCreate's `env: client.env`
        // forwarding (FR-09/AC-06) had no facade-level assertion either —
        // see the equivalent note on dispatchStream's wiring test above.
        env: { DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      }),
    );
    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_v1", name: "submit_verdict", input: { verdict: "upheld", response: "維持する" } },
    ]);
  });

  it("requestVerdict validates the tool_use block returned by the claude-code backend, same as the api backend", async () => {
    createClaudeCodeMessageMock.mockResolvedValue({
      content: [{ type: "tool_use", id: "toolu_v1", name: "submit_verdict", input: { verdict: "upheld", response: "維持する" } }],
    });
    const validate = vi.fn().mockReturnValue({ valid: true, data: { verdict: "upheld" } });

    const outcome = await requestVerdict(
      claudeCodeClient(),
      { messages: [{ role: "user", content: "進言内容" }] },
      "submit_verdict",
      validate,
    );

    expect(validate).toHaveBeenCalledWith({ verdict: "upheld", response: "維持する" });
    expect(outcome).toEqual({ called: true, result: { valid: true, data: { verdict: "upheld" } } });
  });

  it("retries createBossMessage on a transient failure (no tool execution on this path, always safe to retry — AC-11)", async () => {
    vi.useFakeTimers();
    try {
      createClaudeCodeMessageMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "今日も一日決めた通りにやれ" }] });

      const promise = createBossMessage(claudeCodeClient(), {
        messages: [{ role: "user", content: "ひとことをくれ" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).resolves.toEqual({ content: [{ type: "text", text: "今日も一日決めた通りにやれ" }] });
      expect(createClaudeCodeMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("createBossMessage also logs the CLAUDE_CODE_UNAVAILABLE_HINT via console.warn on ClaudeCodeUnavailableError (Issue #118 — dispatchCreate path)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unavailableError = new ClaudeCodeUnavailableError(
        "unknown",
        "claude-code backend: query failed before completion",
      );
      createClaudeCodeMessageMock.mockRejectedValue(unavailableError);

      const promise = createBossMessage(claudeCodeClient(), {
        messages: [{ role: "user", content: "進言内容" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);

      await expect(promise).rejects.toBe(unavailableError);
      expect(warnSpy).toHaveBeenCalledWith(CLAUDE_CODE_UNAVAILABLE_HINT);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// Issue #176: the `api` backend now shares the same AC-11 timeout/retry
// policy as `claude-code` (see `dispatchStream`/`dispatchCreate`'s doc
// comments in claude-client.ts). These tests mirror the equivalent
// "claude-code backend wiring" blocks above, but exercise the api-backend
// mocks (`anthropicCtor`/`streamMock`/`createMock`) declared at this file's
// top instead of the claude-code mocks.
describe("streamBossMessage (api backend timeout/retry wiring, Issue #176)", () => {
  it("retries once with exponential backoff after a transient failure with no side effect (AC-11)", async () => {
    vi.useFakeTimers();
    try {
      streamMock
        .mockReturnValueOnce(createFailingStream(new Error("transient")))
        .mockReturnValueOnce(createFakeStream(textMessage("ok")));

      const promise = streamBossMessage(apiClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry once text has already been streamed to the caller during the failed attempt (AC-2 — no duplicated text on retry)", async () => {
    const onTextDelta = vi.fn();
    streamMock.mockReturnValueOnce(
      createFailingStream(new Error("failed mid-stream, after text was already relayed"), ["今日は"]),
    );

    await expect(
      streamBossMessage(
        apiClient(),
        { messages: [{ role: "user", content: "進捗どうですか" }] },
        { onTextDelta },
      ),
    ).rejects.toThrow("failed mid-stream, after text was already relayed");

    // A retry here would have called client.messages.stream a 2nd time and
    // relayed "今日は" to `onTextDelta` again, duplicating it in both the SSE
    // stream and the persisted message.
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(onTextDelta).toHaveBeenCalledTimes(1);
  });

  it("fails with LlmTimeoutError once the shared timeout budget elapses, aborting the in-flight SDK call via the forwarded AbortSignal (AC-1)", async () => {
    vi.useFakeTimers();
    try {
      streamMock.mockReturnValue(createHangingStream());

      const promise = streamBossMessage(apiClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(promise).rejects.toThrow(LlmTimeoutError);
      // The shared AbortSignal (Issue #176) must reach the SDK call's
      // request options, not just the caller's own `await` — otherwise the
      // in-flight HTTP request keeps running after the facade gives up.
      const [, options] = streamMock.mock.calls[0] as [unknown, { signal?: AbortSignal }];
      expect(options.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not exceed 3 total attempts (AC-3): the facade's retries alone, not compounded with the SDK's own maxRetries", async () => {
    vi.useFakeTimers();
    try {
      streamMock.mockReturnValue(createFailingStream(new Error("still failing")));

      const promise = streamBossMessage(apiClient(), {
        messages: [{ role: "user", content: "hi" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);

      await expect(promise).rejects.toThrow("still failing");
      // If the SDK's own maxRetries (2, pre-#176) were still active
      // alongside the facade's retries, this would be up to 3 × 3 = 9 calls
      // instead of exactly 3 — see `api-backend.ts`'s `createApiClient`
      // (maxRetries: 0) and this file's `createApiClient` test above.
      expect(streamMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a later round even after an earlier round's tool has already executed, without re-executing that tool (multi-round side-effect safety)", async () => {
    vi.useFakeTimers();
    try {
      const executeTool = vi.fn().mockResolvedValue({ content: "ok", isError: false });
      // Round 1 succeeds and returns a tool_use block.
      streamMock.mockReturnValueOnce(
        createFakeStream(toolUseMessage("tool_1", "create_task", { title: "資料作成" })),
      );
      // Round 2's first attempt fails transiently (no side effect within
      // *that* attempt — the round-1 tool already completed before round 2
      // was even dispatched), is retried once, then succeeds.
      streamMock
        .mockReturnValueOnce(createFailingStream(new Error("transient round2 failure")))
        .mockReturnValueOnce(createFakeStream(textMessage("了解した")));

      const promise = streamBossMessage(
        apiClient(),
        { messages: [{ role: "user", content: "タスクを作って" }], tools: [] },
        { executeTool },
      );
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.content).toEqual([{ type: "text", text: "了解した" }]);
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledWith("create_task", { title: "資料作成" });
      expect(streamMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createBossMessage (api backend timeout/retry wiring, Issue #176)", () => {
  it("retries createBossMessage on a transient failure (no tool execution on this path, always safe to retry — AC-11)", async () => {
    vi.useFakeTimers();
    try {
      createMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(textMessage("今日も一日決めた通りにやれ"));

      const promise = createBossMessage(apiClient(), {
        messages: [{ role: "user", content: "ひとことをくれ" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.content).toEqual([{ type: "text", text: "今日も一日決めた通りにやれ" }]);
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails with LlmTimeoutError once the shared timeout budget elapses, aborting the in-flight SDK call via the forwarded AbortSignal (AC-1)", async () => {
    vi.useFakeTimers();
    try {
      createMock.mockReturnValue(new Promise(() => {}));

      const promise = createBossMessage(apiClient(), {
        messages: [{ role: "user", content: "進言内容" }],
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(promise).rejects.toThrow(LlmTimeoutError);
      const [, options] = createMock.mock.calls[0] as [unknown, { signal?: AbortSignal }];
      expect(options.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
