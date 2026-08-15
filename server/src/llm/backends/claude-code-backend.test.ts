import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { BOSS_TOOLS } from "../../boss/boss-tools.js";
import { SUBMIT_VERDICT_TOOL } from "../../decisions/verdict-tool.js";
import { SUBMIT_EVENING_SUMMARY_TOOL } from "../../reports/evening-summary-tool.js";

const { queryMock, toolMock, createSdkMcpServerMock } = vi.hoisted(() => {
  const toolMock = vi.fn(
    (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: (args: unknown) => Promise<unknown>,
    ) => ({ name, description, inputSchema, handler }),
  );
  const createSdkMcpServerMock = vi.fn((options: { name: string; tools: unknown[] }) => ({
    type: "sdk" as const,
    name: options.name,
    tools: options.tools,
  }));
  const queryMock = vi.fn();
  return { queryMock, toolMock, createSdkMcpServerMock };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  tool: toolMock,
  createSdkMcpServer: createSdkMcpServerMock,
}));

const {
  streamClaudeCodeMessage,
  createClaudeCodeMessage,
  buildClaudeCodePrompt,
  buildClaudeCodeEnv,
  TOOL_ZOD_SHAPES,
  ClaudeCodeUnavailableError,
  resolveClaudeCodeExecutablePath,
  CLAUDE_CODE_EXECUTABLE_PATH,
  checkClaudeCodeAvailability,
  CLAUDE_CODE_UNAVAILABLE_HINT,
} = await import("./claude-code-backend.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/** An async iterable whose first `next()` call rejects with `err` — used to
 * simulate a query stream that fails before yielding anything (AC-07's
 * "例外経路"), without an unreachable `yield` after a `throw` (which trips
 * `require-yield`). */
function rejectingStream(err: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(err) };
    },
  };
}

function assistantTextMessage(text: string) {
  return {
    type: "assistant" as const,
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

function assistantToolUseMessage(id: string, name: string, input: unknown) {
  return {
    type: "assistant" as const,
    message: { content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
  };
}

function textDeltaEvent(text: string) {
  return {
    type: "stream_event" as const,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
  };
}

function resultMessage(subtype: "success" | "error_max_turns" = "success") {
  return { type: "result" as const, subtype };
}

function lastQueryOptions(): Record<string, unknown> {
  const call = queryMock.mock.calls.at(-1) as [{ prompt: string; options: Record<string, unknown> }];
  return call[0].options;
}

function registeredTools(): Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> {
  const call = createSdkMcpServerMock.mock.calls.at(-1) as [{ tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }];
  return call[0].tools;
}

function findHandler(name: string) {
  const found = registeredTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} was not registered`);
  return found.handler;
}

// ---------------------------------------------------------------------------
// buildClaudeCodePrompt
// ---------------------------------------------------------------------------

describe("buildClaudeCodePrompt", () => {
  it("returns the plain text of a single user message unchanged (no role prefix)", () => {
    const prompt = buildClaudeCodePrompt([{ role: "user", content: "こんにちは" }]);

    expect(prompt).toBe("こんにちは");
  });

  it("formats multi-turn history with role-labeled lines", () => {
    const prompt = buildClaudeCodePrompt([
      { role: "user", content: "進捗どうですか" },
      { role: "assistant", content: "順調だ" },
      { role: "user", content: "了解です" },
    ]);

    expect(prompt).toBe("User: 進捗どうですか\n\nBoss: 順調だ\n\nUser: 了解です");
  });

  it("returns an empty string for an empty message list", () => {
    expect(buildClaudeCodePrompt([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeCodeEnv (FR-09, AC-06)
// ---------------------------------------------------------------------------

describe("buildClaudeCodeEnv", () => {
  it("excludes ANTHROPIC_API_KEY from a process.env-based copy", () => {
    const env = buildClaudeCodeEnv({ ANTHROPIC_API_KEY: "sk-ant-should-be-excluded", PATH: "/usr/bin" });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("adds DISABLE_TELEMETRY=1 and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", () => {
    const env = buildClaudeCodeEnv({});

    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("preserves PATH/HOME and other existing variables needed to run/authenticate the subprocess", () => {
    const env = buildClaudeCodeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/owner",
      CLAUDE_CONFIG_DIR: "/Users/owner/.claude",
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/owner");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/owner/.claude");
  });

  it("does not mutate the given process.env object", () => {
    const processEnv = { ANTHROPIC_API_KEY: "sk-ant-test", PATH: "/usr/bin" };

    buildClaudeCodeEnv(processEnv);

    expect(processEnv.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });
});

// ---------------------------------------------------------------------------
// TOOL_ZOD_SHAPES ⇔ JSON Schema alignment
// ---------------------------------------------------------------------------

describe("TOOL_ZOD_SHAPES alignment with the JSON Schema tool definitions", () => {
  const jsonSchemaTools: Anthropic.Tool[] = [
    ...BOSS_TOOLS,
    SUBMIT_VERDICT_TOOL,
    SUBMIT_EVENING_SUMMARY_TOOL,
  ];

  it.each(jsonSchemaTools.map((toolDef) => [toolDef.name, toolDef] as const))(
    "%s: Zod shape keys and required-ness match the JSON Schema",
    (name, toolDef) => {
      const shape = TOOL_ZOD_SHAPES[name as keyof typeof TOOL_ZOD_SHAPES];
      expect(shape, `no Zod shape registered for "${name}"`).toBeDefined();

      const schema = toolDef.input_schema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const jsonKeys = Object.keys(schema.properties ?? {}).sort();
      const zodKeys = Object.keys(shape).sort();
      expect(zodKeys).toEqual(jsonKeys);

      const requiredKeys = new Set(schema.required ?? []);
      for (const key of zodKeys) {
        const field = (shape as Record<string, z.ZodTypeAny>)[key];
        const isOptionalInZod = field.isOptional();
        const isRequiredInJson = requiredKeys.has(key);
        expect(isOptionalInZod, `field "${key}"`).toBe(!isRequiredInJson);
      }

      // Regression guard (self-review round 2): the Zod shapes were found to
      // be missing the JSON Schema's field `description`s in an earlier
      // round of this ticket's own self-review — assert they carry them
      // through (via `.unwrap()` for `.optional()`-wrapped fields, since
      // `.describe()` was applied to the inner type before `.optional()`).
      for (const key of zodKeys) {
        const jsonDescription = (schema.properties?.[key] as { description?: string } | undefined)
          ?.description;
        if (jsonDescription === undefined) {
          continue;
        }
        const field = (shape as Record<string, z.ZodTypeAny>)[key];
        const unwrapped: z.ZodTypeAny = field.isOptional()
          ? (field as unknown as { unwrap: () => z.ZodTypeAny }).unwrap()
          : field;
        expect(unwrapped.description, `field "${key}" description`).toBe(jsonDescription);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// streamClaudeCodeMessage
// ---------------------------------------------------------------------------

describe("streamClaudeCodeMessage", () => {
  it("passes model/systemPrompt/tools:[]/settingSources:[]/strictMcpConfig/allowedTools/mcpServers (FR-06, AC-05, AC-08)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("了解"), resultMessage()]));

    await streamClaudeCodeMessage({
      model: "claude-opus-4-8",
      system: "あなたはボスです",
      messages: [{ role: "user", content: "進捗どうですか" }],
      tools: BOSS_TOOLS,
    });

    const options = lastQueryOptions();
    expect(options.model).toBe("claude-opus-4-8");
    expect(options.systemPrompt).toBe("あなたはボスです");
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual([
      "mcp__ai-boss__create_task",
      "mcp__ai-boss__update_task",
      "mcp__ai-boss__record_decision",
    ]);
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual(["ai-boss"]);
    // Runaway-loop guard (self-review): claude-code has no MAX_TOOL_ROUNDS
    // equivalent from the facade side (see `streamBossMessage`'s doc
    // comment), so `maxTurns` here is the only defense-in-depth cap.
    expect(typeof options.maxTurns).toBe("number");
    expect(options.maxTurns).toBeGreaterThan(0);
  });

  it("forwards the given env to query()'s env option, and disables session persistence (FR-09/AC-06, FR-15/AC-13)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("了解"), resultMessage()]));
    const env = { PATH: "/usr/bin", DISABLE_TELEMETRY: "1" };

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] },
      { env },
    );

    const options = lastQueryOptions();
    expect(options.env).toBe(env);
    // FR-15 / AC-13: the option name `persistSession` was confirmed in the
    // installed SDK version's type declarations (sdk.d.ts, `Options.persistSession`
    // — "When false, disables session persistence to disk... @default true").
    // No FR-15 deviation to record: the SDK does provide the disable option.
    expect(options.persistSession).toBe(false);
  });

  it("registers no MCP server / allowedTools when no tools are given (dashboard comment / notification body)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("今日も一日頑張れ"), resultMessage()]));

    await streamClaudeCodeMessage({
      model: "claude-sonnet-5",
      system: "system",
      messages: [{ role: "user", content: "ひとことをくれ" }],
    });

    const options = lastQueryOptions();
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
  });

  // AC-05（未許可ツールの使用要求の拒否）: FR-06 の多層方式は許可リスト
  // （allowedTools＝自動承認）のみに依存しない。第 5 層として自前の
  // `canUseTool` ハンドラを渡し、許可リスト外のツール使用要求を deny する。
  // 拒否判定はこのハンドラ（自コード境界）で検証できる。
  describe("canUseTool — 未許可ツールの使用要求の拒否 (FR-06, AC-05)", () => {
    type CanUseToolFn = (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string; message?: string }>;

    it("passes a canUseTool handler that denies built-in and foreign MCP tools", async () => {
      queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("了解"), resultMessage()]));

      await streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進捗どうですか" }],
        tools: BOSS_TOOLS,
      });

      const canUseTool = lastQueryOptions().canUseTool as CanUseToolFn;
      expect(typeof canUseTool).toBe("function");

      const bash = await canUseTool("Bash", { command: "echo hi" });
      expect(bash.behavior).toBe("deny");
      expect(bash.message).toContain("Bash");

      const foreignMcp = await canUseTool("mcp__other-server__do_thing", {});
      expect(foreignMcp.behavior).toBe("deny");
      expect(foreignMcp.message).toContain("mcp__other-server__do_thing");
    });

    it("allows exactly the app-defined fully-qualified MCP tools", async () => {
      queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("了解"), resultMessage()]));

      await streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進捗どうですか" }],
        tools: BOSS_TOOLS,
      });

      const options = lastQueryOptions();
      const canUseTool = options.canUseTool as CanUseToolFn;
      for (const allowed of options.allowedTools as string[]) {
        const result = await canUseTool(allowed, {});
        expect(result.behavior).toBe("allow");
      }
      // 素名（MCP 完全修飾でない自ツール名）は許可リスト外なので deny
      const bareName = await canUseTool("create_task", {});
      expect(bareName.behavior).toBe("deny");
    });

    it("denies every tool when the call site provides no tools (dashboard comment / notification body)", async () => {
      queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("今日も一日頑張れ"), resultMessage()]));

      await streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        system: "system",
        messages: [{ role: "user", content: "ひとことをくれ" }],
      });

      const canUseTool = lastQueryOptions().canUseTool as CanUseToolFn;
      expect(typeof canUseTool).toBe("function");
      expect((await canUseTool("Bash", {})).behavior).toBe("deny");
      expect((await canUseTool("mcp__ai-boss__create_task", {})).behavior).toBe("deny");
    });
  });

  it("relays text deltas from stream_event content_block_delta text_delta messages to onTextDelta, in order (FR-04)", async () => {
    queryMock.mockReturnValueOnce(
      toAsyncIterable([
        textDeltaEvent("今日は"),
        textDeltaEvent("頑張ろう"),
        assistantTextMessage("今日は頑張ろう"),
        resultMessage(),
      ]),
    );
    const onTextDelta = vi.fn();

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "進捗どうですか" }] },
      { onTextDelta },
    );

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "今日は");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "頑張ろう");
    expect(lastQueryOptions().includePartialMessages).toBe(true);
  });

  it("does not request includePartialMessages when no onTextDelta is given", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([assistantTextMessage("ok"), resultMessage()]));

    await streamClaudeCodeMessage({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });

    expect(lastQueryOptions().includePartialMessages).toBe(false);
  });

  it("falls back to a single onTextDelta call with the full text when includePartialMessages was requested but no stream_event delta ever arrived (前提・仮定4 の縮退仕様, self-review)", async () => {
    // No `stream_event`/`content_block_delta` messages in this fake stream —
    // simulates a running Agent SDK version that doesn't actually emit
    // partial messages despite `includePartialMessages: true`.
    queryMock.mockReturnValueOnce(
      toAsyncIterable([assistantTextMessage("今日は頑張ろう"), resultMessage()]),
    );
    const onTextDelta = vi.fn();

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "進捗どうですか" }] },
      { onTextDelta },
    );

    expect(onTextDelta).toHaveBeenCalledTimes(1);
    expect(onTextDelta).toHaveBeenCalledWith("今日は頑張ろう");
  });

  it("does not double-fire the degraded fallback when stream_event deltas did arrive normally", async () => {
    queryMock.mockReturnValueOnce(
      toAsyncIterable([
        textDeltaEvent("今日は"),
        textDeltaEvent("頑張ろう"),
        assistantTextMessage("今日は頑張ろう"),
        resultMessage(),
      ]),
    );
    const onTextDelta = vi.fn();

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "進捗どうですか" }] },
      { onTextDelta },
    );

    expect(onTextDelta).toHaveBeenCalledTimes(2);
  });

  it("does not fire the degraded fallback when there is no text content at all (e.g. tool-only turn, no onTextDelta call needed)", async () => {
    queryMock.mockImplementationOnce(() => toAsyncIterable([resultMessage()]));
    const onTextDelta = vi.fn();

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "タスクを作って" }] },
      { onTextDelta },
    );

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("executes a DB-writing tool via the MCP handler exactly once, notifies onToolEvent once with FR-04's payload, and reflects the tool_use block in the final content (AC-03)", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: '{"id":1,"title":"資料作成"}', isError: false });
    const onToolEvent = vi.fn();
    const onTextDelta = vi.fn();

    // Build a bespoke async generator so we can `await handler(...)` at the
    // right point in the sequence (after the tool_use message, before the
    // follow-up text) — mirroring FR-04's "text → tool → 次ラウンドのtext" order.
    // `findHandler` reads from `createSdkMcpServerMock`'s calls, which is
    // already populated by the time `query()` runs (the MCP server is built
    // before `query()` is invoked — see `runClaudeCodeQuery`).
    async function* fakeStream() {
      yield assistantToolUseMessage("toolu_1", "create_task", { title: "資料作成" });
      const handler = findHandler("create_task");
      await handler({ title: "資料作成" });
      yield textDeltaEvent("タスクを作成した");
      yield assistantTextMessage("タスクを作成した");
      yield resultMessage();
    }
    queryMock.mockImplementationOnce(() => fakeStream());

    const result = await streamClaudeCodeMessage(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "タスクを作って" }],
        tools: BOSS_TOOLS,
      },
      { executeTool, onToolEvent, onTextDelta },
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("create_task", { title: "資料作成" });
    expect(onToolEvent).toHaveBeenCalledTimes(1);
    expect(onToolEvent).toHaveBeenCalledWith({
      name: "create_task",
      input: { title: "資料作成" },
      result: '{"id":1,"title":"資料作成"}',
      isError: false,
    });
    expect(onTextDelta).toHaveBeenCalledWith("タスクを作成した");
    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "create_task", input: { title: "資料作成" } },
      { type: "text", text: "タスクを作成した" },
    ]);
  });

  it("throws when the tool handler is invoked without an executeTool callback (defensive)", async () => {
    queryMock.mockImplementationOnce(() => toAsyncIterable([resultMessage()]));

    await streamClaudeCodeMessage({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "タスクを作って" }],
      tools: BOSS_TOOLS,
    });

    const handler = findHandler("create_task");
    await expect(handler({ title: "x" })).rejects.toThrow(/executeTool/);
  });

  it("throws (does not return a partially-successful message) when the result subtype is not success (補足決定「FR-10とエラーハンドリングの整合」)", async () => {
    queryMock.mockReturnValueOnce(
      toAsyncIterable([assistantTextMessage("途中経過"), resultMessage("error_max_turns")]),
    );

    await expect(
      streamClaudeCodeMessage({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/error_max_turns/);
  });

  it("does not reclassify a non-success result subtype as ClaudeCodeUnavailableError (it's an in-turn execution failure, not an environment unavailability — FR-11)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([resultMessage("error_max_turns")]));

    await expect(
      streamClaudeCodeMessage({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.not.toBeInstanceOf(ClaudeCodeUnavailableError);
  });

  // AC-07's "例外経路" (as opposed to the "非成功結果メッセージ" path covered
  // by the two tests above): a failure thrown while iterating the query
  // stream itself (subprocess/environment failure), reclassified as FR-11's
  // dedicated error type.
  describe("execution-environment failures (AC-07 例外経路, FR-11)", () => {
    it("reclassifies an ENOENT spawn failure as ClaudeCodeUnavailableError with reason 'not_installed'", async () => {
      const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      queryMock.mockImplementationOnce(() => rejectingStream(enoent));

      const promise = streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(promise).rejects.toBeInstanceOf(ClaudeCodeUnavailableError);
      await expect(promise).rejects.toMatchObject({ reason: "not_installed" });
    });

    it("reclassifies an unrecognized mid-stream failure (e.g. not logged in / expired credentials) as ClaudeCodeUnavailableError with reason 'unknown'", async () => {
      queryMock.mockImplementationOnce(() =>
        rejectingStream(new Error("Claude Code exited with status 1")),
      );

      const promise = streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(promise).rejects.toBeInstanceOf(ClaudeCodeUnavailableError);
      await expect(promise).rejects.toMatchObject({ reason: "unknown" });
    });

    it("preserves the ClaudeCodeUnavailableError class name for the caller's 'log class name only' discipline", async () => {
      queryMock.mockImplementationOnce(() =>
        rejectingStream(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
      );

      try {
        await streamClaudeCodeMessage({
          model: "claude-sonnet-5",
          messages: [{ role: "user", content: "hi" }],
        });
        expect.unreachable("expected streamClaudeCodeMessage to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("ClaudeCodeUnavailableError");
      }
    });

    it("reclassifies a synchronous throw from query() itself — e.g. the Agent SDK's bundled native binary not found — as ClaudeCodeUnavailableError (self-review: query() must run inside the try, not before it)", async () => {
      queryMock.mockImplementationOnce(() => {
        throw new Error(
          "Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.",
        );
      });

      const promise = streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(promise).rejects.toBeInstanceOf(ClaudeCodeUnavailableError);
      await expect(promise).rejects.toMatchObject({ reason: "unknown" });
    });
  });

  it("surfaces the submit_verdict tool_use block without executing anything (no executeTool call) — AC-04", async () => {
    const executeTool = vi.fn();

    queryMock.mockImplementationOnce(() =>
      toAsyncIterable([
        assistantToolUseMessage("toolu_v1", "submit_verdict", {
          verdict: "upheld",
          response: "維持する",
        }),
        resultMessage(),
      ]),
    );

    const result = await streamClaudeCodeMessage(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進言内容" }],
        tools: [SUBMIT_VERDICT_TOOL],
      },
      { executeTool },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_v1", name: "submit_verdict", input: { verdict: "upheld", response: "維持する" } },
    ]);
  });

  it("strips the MCP-qualified prefix (mcp__ai-boss__submit_verdict) from the tool_use name it surfaces, so requestVerdict's bare-name match still works (self-review regression guard for AC-04)", async () => {
    // The model calls in-process MCP tools by their fully-qualified name
    // (see `mcpToolName`/`allowedTools`), so a real Agent SDK run would
    // yield an assistant `tool_use` block named `mcp__ai-boss__submit_verdict`
    // — not the bare `submit_verdict` the other tests above assert against
    // for simplicity. Without stripping this prefix back off, `requestVerdict`
    // (`claude-client.ts`) would never match `toolName === "submit_verdict"`
    // and re-adjudication would always resolve to `{called: false}` (HTTP 500).
    queryMock.mockImplementationOnce(() =>
      toAsyncIterable([
        assistantToolUseMessage("toolu_v1", "mcp__ai-boss__submit_verdict", {
          verdict: "upheld",
          response: "維持する",
        }),
        resultMessage(),
      ]),
    );

    const result = await streamClaudeCodeMessage({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      tools: [SUBMIT_VERDICT_TOOL],
    });

    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_v1", name: "submit_verdict", input: { verdict: "upheld", response: "維持する" } },
    ]);
  });

  it("strips the MCP-qualified prefix from executed-tool tool_use blocks too (create_task)", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "{}", isError: false });

    async function* fakeStream() {
      yield assistantToolUseMessage("toolu_1", "mcp__ai-boss__create_task", { title: "資料作成" });
      await findHandler("create_task")({ title: "資料作成" });
      yield resultMessage();
    }
    queryMock.mockImplementationOnce(() => fakeStream());

    const result = await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "タスクを作って" }], tools: BOSS_TOOLS },
      { executeTool },
    );

    expect(result.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "create_task", input: { title: "資料作成" } },
    ]);
  });

  it("the submit_verdict MCP handler itself never calls executeTool and returns an ack without side effects", async () => {
    const executeTool = vi.fn();
    queryMock.mockImplementationOnce(() => toAsyncIterable([resultMessage()]));

    await streamClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "進言内容" }], tools: [SUBMIT_VERDICT_TOOL] },
      { executeTool },
    );

    const handler = findHandler("submit_verdict");
    const callToolResult = (await handler({ verdict: "upheld", response: "維持する" })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(executeTool).not.toHaveBeenCalled();
    expect(callToolResult.content[0]?.type).toBe("text");
  });

  it("surfaces the submit_evening_summary tool_use block without executing anything (no executeTool call) — Issue #108", async () => {
    const executeTool = vi.fn();

    queryMock.mockImplementationOnce(() =>
      toAsyncIterable([
        assistantToolUseMessage("toolu_es1", "submit_evening_summary", {
          report_summary: "タスクAを完了した",
          boss_comment: "よくやった",
          carry_over: "なし",
        }),
        resultMessage(),
      ]),
    );

    const result = await streamClaudeCodeMessage(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "夕会の会話ログ" }],
        tools: [SUBMIT_EVENING_SUMMARY_TOOL],
      },
      { executeTool },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_es1",
        name: "submit_evening_summary",
        input: { report_summary: "タスクAを完了した", boss_comment: "よくやった", carry_over: "なし" },
      },
    ]);
  });

  it("does not throw ClaudeCodeBackendError for submit_evening_summary (regression guard: it must be registered like submit_verdict, not treated as an unknown/executed tool)", async () => {
    queryMock.mockImplementationOnce(() => toAsyncIterable([resultMessage()]));

    await expect(
      streamClaudeCodeMessage({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "夕会の会話ログ" }],
        tools: [SUBMIT_EVENING_SUMMARY_TOOL],
      }),
    ).resolves.toBeDefined();
  });

  it("the submit_evening_summary MCP handler itself never calls executeTool and returns an ack without side effects", async () => {
    const executeTool = vi.fn();
    queryMock.mockImplementationOnce(() => toAsyncIterable([resultMessage()]));

    await streamClaudeCodeMessage(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "夕会の会話ログ" }],
        tools: [SUBMIT_EVENING_SUMMARY_TOOL],
      },
      { executeTool },
    );

    const handler = findHandler("submit_evening_summary");
    const callToolResult = (await handler({
      report_summary: "a",
      boss_comment: "b",
      carry_over: "なし",
    })) as { content: Array<{ type: string; text: string }> };

    expect(executeTool).not.toHaveBeenCalled();
    expect(callToolResult.content[0]?.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// createClaudeCodeMessage
// ---------------------------------------------------------------------------

describe("createClaudeCodeMessage", () => {
  it("does not stream (includePartialMessages is false) and resolves with the final content", async () => {
    queryMock.mockReturnValueOnce(
      toAsyncIterable([assistantTextMessage("今日も一日決めた通りにやれ"), resultMessage()]),
    );

    const result = await createClaudeCodeMessage({
      model: "claude-sonnet-5",
      system: "system",
      messages: [{ role: "user", content: "ひとことをくれ" }],
    });

    expect(lastQueryOptions().includePartialMessages).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "今日も一日決めた通りにやれ" }]);
  });

  it("aborts the query's AbortController immediately when the given signal is already aborted (AC-11)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([resultMessage()]));
    const controller = new AbortController();
    controller.abort();

    await createClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    );

    const options = lastQueryOptions();
    expect((options.abortController as AbortController).signal.aborted).toBe(true);
  });

  it("aborts the query's AbortController when the given signal aborts mid-flight (AC-11)", async () => {
    const controller = new AbortController();
    let capturedAbortController: AbortController | undefined;
    queryMock.mockImplementationOnce(() => {
      capturedAbortController = lastQueryOptions().abortController as AbortController;
      return toAsyncIterable([resultMessage()]);
    });

    const promise = createClaudeCodeMessage(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    );
    controller.abort();
    await promise;

    expect(capturedAbortController?.signal.aborted).toBe(true);
  });

  it("passes CLAUDE_CODE_EXECUTABLE_PATH (the same shared constant the startup check reads) to query()'s pathToClaudeCodeExecutable option (FR-13)", async () => {
    queryMock.mockReturnValueOnce(toAsyncIterable([resultMessage()]));

    await createClaudeCodeMessage({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });

    const options = lastQueryOptions();
    // Two separate assertions, deliberately: `"in"` checks the *key* was
    // forwarded at all — this still catches a regression where
    // `runClaudeCodeQuery` stops passing `pathToClaudeCodeExecutable`
    // entirely, even in an environment where `CLAUDE_CODE_EXECUTABLE_PATH`
    // happens to be `undefined` (e.g. on Linux, which
    // `resolveClaudeCodeExecutablePath` now deliberately bails out on — see
    // its own describe block below), where a plain `.toBe(undefined)`
    // equality check alone couldn't distinguish "key present with value
    // undefined" from "key absent" (self-review round 2: code-reviewer
    // caught the equality-only version of this test as passing vacuously in
    // that case). The equality check separately catches "forwarded a
    // different value than the shared constant".
    expect("pathToClaudeCodeExecutable" in options).toBe(true);
    expect(options.pathToClaudeCodeExecutable).toBe(CLAUDE_CODE_EXECUTABLE_PATH);
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeCodeExecutablePath (FR-13)
// ---------------------------------------------------------------------------

describe("resolveClaudeCodeExecutablePath", () => {
  it("resolves the platform/arch-specific optional-dependency package's bundled binary (darwin-arm64)", () => {
    const resolve = vi.fn().mockReturnValue("/fake/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");

    const path = resolveClaudeCodeExecutablePath({ platform: "darwin", arch: "arm64", resolve });

    expect(resolve).toHaveBeenCalledWith("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
    expect(path).toBe("/fake/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
  });

  it("appends .exe on win32", () => {
    const resolve = vi.fn().mockReturnValue("C:\\fake\\claude.exe");

    resolveClaudeCodeExecutablePath({ platform: "win32", arch: "x64", resolve });

    expect(resolve).toHaveBeenCalledWith("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
  });

  it("returns undefined (does not throw) when the platform package cannot be resolved (e.g. installed with --omit=optional)", () => {
    const resolve = vi.fn(() => {
      throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
    });

    const path = resolveClaudeCodeExecutablePath({ platform: "darwin", arch: "arm64", resolve });

    expect(path).toBeUndefined();
  });

  // self-review (code-reviewer/design-reviewer): the SDK itself picks among
  // *multiple* package-name candidates only for linux (musl-vs-glibc
  // preference) and android (a dedicated package) — this function does not
  // reimplement that selection, so it must bail out to `undefined` (falling
  // through to the SDK's own correct internal resolution) rather than risk
  // handing the SDK a mismatched-libc binary via the now-explicit
  // `pathToClaudeCodeExecutable` option.
  it.each(["linux", "android"] as const)(
    "returns undefined without calling resolve on %s (musl/glibc or android package selection is not reimplemented — YAGNI, this app is macOS-only)",
    (platform) => {
      const resolve = vi.fn().mockReturnValue("/should-not-be-used");

      const path = resolveClaudeCodeExecutablePath({ platform, arch: "x64", resolve });

      expect(path).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// checkClaudeCodeAvailability (FR-13, AC-12)
// ---------------------------------------------------------------------------

describe("checkClaudeCodeAvailability", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("execFile's the shared backend executable path (not PATH 'claude') with --version, and does not warn on success", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "2.1.231 (Claude Code)", stderr: "" });
    const resolveExecutablePath = vi.fn().mockReturnValue("/opt/claude-agent-sdk-darwin-arm64/claude");

    await checkClaudeCodeAvailability({ execFile, resolveExecutablePath });

    expect(execFile).toHaveBeenCalledWith("/opt/claude-agent-sdk-darwin-arm64/claude", ["--version"]);
    expect(execFile.mock.calls[0]![0]).not.toBe("claude");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs a warning and does not throw when execFile rejects with ENOENT (not installed)", async () => {
    const execFile = vi.fn().mockRejectedValue(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    const resolveExecutablePath = vi.fn().mockReturnValue("/opt/claude-agent-sdk-darwin-arm64/claude");

    await expect(
      checkClaudeCodeAvailability({ execFile, resolveExecutablePath }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs a warning and does not throw when execFile rejects with a non-zero exit", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Command failed"), { code: 1 }));
    const resolveExecutablePath = vi.fn().mockReturnValue("/opt/claude-agent-sdk-darwin-arm64/claude");

    await expect(
      checkClaudeCodeAvailability({ execFile, resolveExecutablePath }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs a warning and does not throw when execFile rejects with a timeout", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" }));
    const resolveExecutablePath = vi.fn().mockReturnValue("/opt/claude-agent-sdk-darwin-arm64/claude");

    await expect(
      checkClaudeCodeAvailability({ execFile, resolveExecutablePath }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs a warning and skips execFile entirely when the executable path cannot be resolved", async () => {
    const execFile = vi.fn();
    const resolveExecutablePath = vi.fn().mockReturnValue(undefined);

    await checkClaudeCodeAvailability({ execFile, resolveExecutablePath });

    expect(execFile).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("includes the LLM_BACKEND=api switch-back guidance (Issue #118) in every warning this function logs", async () => {
    // Path-unresolvable case.
    await checkClaudeCodeAvailability({
      execFile: vi.fn(),
      resolveExecutablePath: () => undefined,
    });
    // execFile-rejects case.
    await checkClaudeCodeAvailability({
      execFile: vi.fn().mockRejectedValue(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
      resolveExecutablePath: () => "/opt/claude-agent-sdk-darwin-arm64/claude",
    });
    // Unexpected synchronous-throw case.
    await checkClaudeCodeAvailability({
      execFile: vi.fn(),
      resolveExecutablePath: () => {
        throw new Error("unexpected synchronous failure");
      },
    });

    expect(console.warn).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(console.warn).mock.calls) {
      expect(call).toContain(CLAUDE_CODE_UNAVAILABLE_HINT);
    }
  });

  it("logs a warning and does not throw when resolveExecutablePath itself throws synchronously (structural 'never rejects' guarantee — self-review: design-reviewer)", async () => {
    const execFile = vi.fn();
    const resolveExecutablePath = vi.fn(() => {
      throw new Error("unexpected synchronous failure");
    });

    await expect(
      checkClaudeCodeAvailability({ execFile, resolveExecutablePath }),
    ).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("uses CLAUDE_CODE_EXECUTABLE_PATH by default when resolveExecutablePath is not supplied", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await checkClaudeCodeAvailability({ execFile });

    // Deterministic regardless of the host environment (whether the optional
    // platform package is installed or not — self-review: code-reviewer/
    // design-reviewer flagged an earlier version of this test as relying on
    // "some real path was resolved", which fails differently depending on
    // install state). `resolveClaudeCodeExecutablePath`'s own DI-based tests
    // above cover the resolution algorithm's correctness in isolation; this
    // test only exercises that the *default* wiring reads the shared
    // constant.
    if (CLAUDE_CODE_EXECUTABLE_PATH === undefined) {
      expect(execFile).not.toHaveBeenCalled();
    } else {
      expect(execFile).toHaveBeenCalledWith(CLAUDE_CODE_EXECUTABLE_PATH, ["--version"]);
    }
  });
});
