import { describe, expect, it, vi } from "vitest";

const { anthropicCtor, streamMock } = vi.hoisted(() => {
  const streamMock = vi.fn();
  const anthropicCtor = vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock },
  }));
  return { anthropicCtor, streamMock };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: anthropicCtor }));

const {
  createClaudeClient,
  MissingApiKeyError,
  DEFAULT_MODEL,
  streamBossMessage,
  buildToolResultMessage,
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

describe("createClaudeClient", () => {
  it("throws MissingApiKeyError when ANTHROPIC_API_KEY is not set", () => {
    expect(() => createClaudeClient({})).toThrow(MissingApiKeyError);
  });

  it("constructs the Anthropic client with the api key, 120s timeout, and maxRetries 2", () => {
    createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "sk-ant-test-key",
      timeout: 120_000,
      maxRetries: 2,
    });
  });
});

describe("DEFAULT_MODEL", () => {
  it("is claude-sonnet-5", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
  });
});

describe("streamBossMessage", () => {
  it("streams with the default model when no model is given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5" }),
    );
  });

  it("streams with the given model when one is provided", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    await streamBossMessage(client, {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8" }),
    );
  });

  it("defaults max_tokens to 1024 when not given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    await streamBossMessage(client, {
      messages: [{ role: "user", content: "こんにちは" }],
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 1024 }),
    );
  });

  it("passes system, messages, tools, and maxTokens through unchanged", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
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
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    const onTextDelta = vi.fn();

    await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "進捗どうですか" }] },
      onTextDelta,
    );

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "今日は");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "頑張ろう");
  });

  it("resolves with the final message, including any tool_use blocks", async () => {
    const finalMessage: FakeMessage = {
      content: [
        { type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } },
      ],
    };
    const fakeStream = createFakeStream(finalMessage);
    streamMock.mockReturnValue(fakeStream);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    const result = await streamBossMessage(client, {
      messages: [{ role: "user", content: "タスクを更新して" }],
    });

    expect(result).toEqual(finalMessage);
  });
});

describe("buildToolResultMessage", () => {
  it("builds a user message with a tool_result content block", () => {
    const message = buildToolResultMessage("tool_1", "更新しました");

    expect(message).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_1", content: "更新しました" },
      ],
    });
  });

  it("marks the tool_result as an error when isError is true", () => {
    const message = buildToolResultMessage("tool_1", "失敗しました", {
      isError: true,
    });

    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "失敗しました",
          is_error: true,
        },
      ],
    });
  });
});
