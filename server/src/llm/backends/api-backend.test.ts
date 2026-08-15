import { describe, expect, it, vi } from "vitest";

const { anthropicCtor, streamMock, createMock } = vi.hoisted(() => {
  const streamMock = vi.fn();
  const createMock = vi.fn();
  const anthropicCtor = vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock, create: createMock },
  }));
  return { anthropicCtor, streamMock, createMock };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicCtor }));

const { createApiClient, streamApiMessage, createApiMessage } = await import(
  "./api-backend.js"
);

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

describe("createApiClient", () => {
  it("constructs the Anthropic client with the api key, 120s timeout, and maxRetries 2", () => {
    createApiClient("sk-ant-test-key");

    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "sk-ant-test-key",
      timeout: 120_000,
      maxRetries: 2,
    });
  });
});

describe("streamApiMessage", () => {
  it("streams with system, messages, tools, model, and maxTokens passed through unchanged", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");
    const messages: Parameters<typeof streamApiMessage>[1]["messages"] = [
      { role: "user", content: "朝会お願いします" },
    ];
    const tools: NonNullable<Parameters<typeof streamApiMessage>[1]["tools"]> = [
      {
        name: "update_task",
        description: "タスクを更新する",
        input_schema: { type: "object", properties: {} },
      },
    ];

    await streamApiMessage(client, {
      model: "claude-sonnet-5",
      system: "あなたはボスです",
      messages,
      tools,
      maxTokens: 2048,
      thinking: { type: "disabled" },
    });

    expect(streamMock).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: "あなたはボスです",
      messages,
      tools,
      thinking: { type: "disabled" },
    });
  });

  it("passes thinking and output_config through when both are set", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "こんにちは" }],
      maxTokens: 16000,
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      }),
    );
  });

  it("does not send an output_config key when outputConfig is not set", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "こんにちは" }],
      maxTokens: 16000,
      thinking: { type: "disabled" },
    });

    const sentRequest = streamMock.mock.calls[0][0] as Record<string, unknown>;
    expect("output_config" in sentRequest).toBe(false);
  });

  it("relays each streamed text delta to onTextDelta", async () => {
    const fakeStream = createFakeStream({ content: [] }, ["今日は", "頑張ろう"]);
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");
    const onTextDelta = vi.fn();

    await streamApiMessage(
      client,
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進捗どうですか" }],
        maxTokens: 1024,
        thinking: { type: "disabled" },
      },
      onTextDelta,
    );

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "今日は");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "頑張ろう");
  });

  it("normalizes text and tool_use content blocks, dropping other block types", async () => {
    const finalMessage: FakeMessage = {
      content: [
        { type: "text", text: "了解した", citations: null },
        { type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } },
        { type: "thinking", thinking: "internal reasoning" },
      ],
    };
    const fakeStream = createFakeStream(finalMessage);
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    const result = await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "タスクを更新して" }],
      maxTokens: 1024,
      thinking: { type: "disabled" },
    });

    expect(result.content).toEqual([
      { type: "text", text: "了解した" },
      { type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } },
    ]);
    // Issue #117: the dropped blocks survive on `rawContent` so the facade's
    // tool loop can replay the assistant turn verbatim (thinking block and
    // signature intact) — dropping them there would break the follow-up
    // round whenever thinking is enabled.
    expect(result.rawContent).toEqual(finalMessage.content);
  });

  it("does not warn when content is non-empty", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const finalMessage: FakeMessage = {
      content: [{ type: "text", text: "了解した", citations: null }],
    };
    const fakeStream = createFakeStream(finalMessage);
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "タスクを更新して" }],
      maxTokens: 1024,
      thinking: { type: "disabled" },
    });

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("Issue #117 reproduction: normalizes a thinking-only, stop_reason=max_tokens response to empty content and logs a diagnostic", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const finalMessage = {
      content: [{ type: "thinking", thinking: "夕会の決定ログを踏まえて長々と検討する内部推論..." }],
      stop_reason: "max_tokens",
      model: "claude-sonnet-5",
      usage: { input_tokens: 4200, output_tokens: 1024 },
    };
    const fakeStream = createFakeStream(finalMessage as unknown as FakeMessage);
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    const result = await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "今日の決定を踏まえて相談したい" }],
      maxTokens: 1024,
      thinking: { type: "adaptive" },
    });

    expect(result.content).toEqual([]);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const [, diagnostics] = consoleWarnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(diagnostics).toMatchObject({
      stopReason: "max_tokens",
      blockTypes: ["thinking"],
      model: "claude-sonnet-5",
      inputTokens: 4200,
      outputTokens: 1024,
    });

    const loggedArgs = consoleWarnSpy.mock.calls.flat();
    const serialized = JSON.stringify(loggedArgs);
    // No secret/content leakage: neither the thinking body nor the user's
    // message/system prompt text should ever reach the log.
    expect(serialized).not.toContain("夕会の決定ログ");
    expect(serialized).not.toContain("今日の決定を踏まえて相談したい");

    consoleWarnSpy.mockRestore();
  });
});

describe("createApiMessage", () => {
  it("creates with system, messages, tools, toolChoice, model, and maxTokens passed through unchanged", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = createApiClient("sk-ant-test-key");
    const messages: Parameters<typeof createApiMessage>[1]["messages"] = [
      { role: "user", content: "進言内容" },
    ];
    const tools: NonNullable<Parameters<typeof createApiMessage>[1]["tools"]> = [
      {
        name: "submit_verdict",
        description: "裁定を提出する",
        input_schema: { type: "object", properties: {} },
      },
    ];

    await createApiMessage(client, {
      model: "claude-sonnet-5",
      system: "あなたはボスです",
      messages,
      tools,
      toolChoice: { type: "tool", name: "submit_verdict" },
      maxTokens: 2048,
      thinking: { type: "disabled" },
    });

    expect(createMock).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: "あなたはボスです",
      messages,
      tools,
      tool_choice: { type: "tool", name: "submit_verdict" },
      thinking: { type: "disabled" },
    });
  });

  it("passes thinking and output_config through when both are set, and omits output_config when unset", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = createApiClient("sk-ant-test-key");

    await createApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      maxTokens: 16000,
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: "adaptive" }, output_config: { effort: "low" } }),
    );

    createMock.mockClear();
    await createApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      maxTokens: 16000,
      thinking: { type: "disabled" },
    });
    const sentRequest = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect("output_config" in sentRequest).toBe(false);
  });

  it("normalizes the resolved message's content blocks", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "upheld" } },
      ],
    });
    const client = createApiClient("sk-ant-test-key");

    const result = await createApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      maxTokens: 1024,
      thinking: { type: "disabled" },
    });

    expect(result.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "upheld" } },
    ]);
  });
});
