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
    const client = createApiClient("sk-ant-test-key");
    const onTextDelta = vi.fn();

    await streamApiMessage(
      client,
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進捗どうですか" }],
        maxTokens: 1024,
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
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "了解した" },
        { type: "tool_use", id: "tool_1", name: "update_task", input: { id: 1 } },
      ],
    });
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
    });

    expect(result).toEqual({
      content: [
        { type: "tool_use", id: "tool_1", name: "submit_verdict", input: { verdict: "upheld" } },
      ],
    });
  });
});
