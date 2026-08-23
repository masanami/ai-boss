import { describe, expect, it, vi } from "vitest";

const { anthropicCtor, streamMock, createMock } = vi.hoisted(() => {
  const streamMock = vi.fn();
  const createMock = vi.fn();
  const anthropicCtor = vi.fn().mockImplementation(() => ({
    messages: { stream: streamMock, create: createMock },
  }));
  return { anthropicCtor, streamMock, createMock };
});

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  // Issue #223: keep the real named `APIError`/`RateLimitError`/etc. exports
  // so `error instanceof APIError` in `isRetryableApiError`/
  // `getApiRetryAfterMs` (both import the named `APIError` export, not
  // `Anthropic.APIError`) works in tests — only the default-exported client
  // constructor is faked. (Before #223 this mock replaced the whole module
  // with just `{ default: anthropicCtor }`, which left the named `APIError`
  // export `undefined` and would have thrown a `TypeError` the moment any
  // test exercised the new `instanceof` check.)
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return { ...actual, default: anthropicCtor };
});
// Issue #224 resolved the heads-up this comment used to carry: both
// `claude-client.test.ts` and `chat-messages-route.issue-117.test.ts` now use
// the same `importOriginal`-based `@anthropic-ai/sdk` mock as this file
// (rather than the old `() => ({ default: anthropicCtor })`, which dropped
// the named `APIError` export) — required once `claude-client.ts` wired
// `isRetryableApiError`/`getApiRetryAfterMs` into the `api` branch's retry
// policy (`RetryTimeoutOptions.classifyError`), since that policy reaches an
// `error instanceof APIError` check on every failed `api` attempt.

const { createApiClient, streamApiMessage, createApiMessage, isRetryableApiError, getApiRetryAfterMs } =
  await import("./api-backend.js");
const AnthropicModule = await import("@anthropic-ai/sdk");

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
  it("constructs the Anthropic client with the api key, 120s timeout, and maxRetries 0 (Issue #176: SDK-level retry disabled — the facade's runWithTimeoutAndRetry is the sole retry policy)", () => {
    createApiClient("sk-ant-test-key");

    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "sk-ant-test-key",
      timeout: 120_000,
      maxRetries: 0,
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

  it("forwards the given AbortSignal to the SDK stream call's request options (Issue #176)", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");
    const controller = new AbortController();

    await streamApiMessage(
      client,
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "こんにちは" }],
        maxTokens: 1024,
        thinking: { type: "disabled" },
      },
      undefined,
      controller.signal,
    );

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5" }),
      { signal: controller.signal },
    );
  });

  it("calls client.messages.stream with a single argument (no request options) when no AbortSignal is given", async () => {
    const fakeStream = createFakeStream({ content: [] });
    streamMock.mockReturnValue(fakeStream);
    const client = createApiClient("sk-ant-test-key");

    await streamApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "こんにちは" }],
      maxTokens: 1024,
      thinking: { type: "disabled" },
    });

    expect(streamMock.mock.calls[0]).toHaveLength(1);
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

  it("forwards the given AbortSignal to the SDK create call's request options (Issue #176)", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = createApiClient("sk-ant-test-key");
    const controller = new AbortController();

    await createApiMessage(
      client,
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "進言内容" }],
        maxTokens: 1024,
        thinking: { type: "disabled" },
      },
      controller.signal,
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5" }),
      { signal: controller.signal },
    );
  });

  it("calls client.messages.create with a single argument (no request options) when no AbortSignal is given", async () => {
    createMock.mockResolvedValue({ content: [] });
    const client = createApiClient("sk-ant-test-key");

    await createApiMessage(client, {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "進言内容" }],
      maxTokens: 1024,
      thinking: { type: "disabled" },
    });

    expect(createMock.mock.calls[0]).toHaveLength(1);
  });
});

describe("isRetryableApiError", () => {
  const {
    APIError,
    RateLimitError,
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError,
    InternalServerError,
    APIConnectionError,
    APIConnectionTimeoutError,
    APIUserAbortError,
  } = AnthropicModule;

  it("returns false for 400 (Bad Request) — caller's fault, retrying can't help", () => {
    const error = new BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns false for 401 (Authentication)", () => {
    const error = new AuthenticationError(401, undefined, "unauthorized", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns false for 403 (Permission Denied)", () => {
    const error = new PermissionDeniedError(403, undefined, "forbidden", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns false for 404 (Not Found)", () => {
    const error = new NotFoundError(404, undefined, "not found", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns false for 409 (Conflict) — narrower than the SDK's own lock-timeout retry heuristic, per Issue #223's AC", () => {
    const error = new ConflictError(409, undefined, "conflict", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns false for 422 (Unprocessable Entity)", () => {
    const error = new UnprocessableEntityError(422, undefined, "unprocessable", new Headers());
    expect(isRetryableApiError(error)).toBe(false);
  });

  it("returns true for 408 (Request Timeout)", () => {
    const error = new APIError(408, undefined, "timeout", new Headers());
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for 429 (Too Many Requests / rate limit)", () => {
    const error = new RateLimitError(429, undefined, "rate limited", new Headers());
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for 500 (Internal Server Error)", () => {
    const error = new InternalServerError(500, undefined, "internal error", new Headers());
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for 503 (Service Unavailable)", () => {
    const error = new APIError(503, undefined, "unavailable", new Headers());
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for 529 (Anthropic's overloaded_error, outside the SDK's named 5xx subclasses)", () => {
    const error = new APIError(529, undefined, "overloaded", new Headers());
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for APIConnectionError (no status — preserves the pre-#223 uniform retry behavior)", () => {
    const error = new APIConnectionError({ message: "connection failed" });
    expect(error.status).toBeUndefined();
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for APIConnectionTimeoutError (no status)", () => {
    const error = new APIConnectionTimeoutError();
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for APIUserAbortError (no status) — see this function's doc comment for why the facade must still check `signal.aborted` before this", () => {
    const error = new APIUserAbortError();
    expect(error.status).toBeUndefined();
    expect(isRetryableApiError(error)).toBe(true);
  });

  it("returns true for an arbitrary non-APIError (e.g. a plain bug) — non-regression from the pre-#223 uniform retry policy", () => {
    expect(isRetryableApiError(new TypeError("something else broke"))).toBe(true);
    expect(isRetryableApiError("not even an Error")).toBe(true);
    expect(isRetryableApiError(undefined)).toBe(true);
  });
});

describe("getApiRetryAfterMs", () => {
  const { APIError, APIConnectionError } = AnthropicModule;

  /** Builds a 429 `RateLimitError`-shaped `APIError` carrying the given
   * `retry-after` header value (or no header at all when omitted) — the
   * realistic shape this function is meant to unwrap. */
  function rateLimitError(retryAfterHeaderValue?: string): InstanceType<typeof APIError> {
    const headers = new Headers();
    if (retryAfterHeaderValue !== undefined) {
      headers.set("retry-after", retryAfterHeaderValue);
    }
    return new APIError(429, undefined, "rate limited", headers);
  }

  it("returns undefined when error is not an APIError at all", () => {
    expect(getApiRetryAfterMs(new TypeError("not even an APIError"))).toBeUndefined();
    expect(getApiRetryAfterMs(undefined)).toBeUndefined();
  });

  it("returns undefined when the APIError has no headers (e.g. APIConnectionError)", () => {
    const error = new APIConnectionError({ message: "connection failed" });
    expect(error.headers).toBeUndefined();
    expect(getApiRetryAfterMs(error)).toBeUndefined();
  });

  it("returns undefined when there is no retry-after header", () => {
    expect(getApiRetryAfterMs(rateLimitError())).toBeUndefined();
  });

  it("parses the numeric-seconds form into milliseconds", () => {
    expect(getApiRetryAfterMs(rateLimitError("30"))).toBe(30_000);
  });

  it("parses '0' as 0ms (a valid, if trivial, wait)", () => {
    expect(getApiRetryAfterMs(rateLimitError("0"))).toBe(0);
  });

  it("treats a negative numeric value as unparsable ('指定なし'), not as a (mis-parsed) date — self-review regression coverage: Codex shadow review + code-reviewer both flagged that a lenient Date.parse previously reinterpreted this as a valid far-future date", () => {
    expect(getApiRetryAfterMs(rateLimitError("-5"))).toBeUndefined();
    expect(getApiRetryAfterMs(rateLimitError("-9999"))).toBeUndefined();
  });

  it("treats a non-numeric, non-HTTP-date value as unparsable", () => {
    expect(getApiRetryAfterMs(rateLimitError("not-a-value"))).toBeUndefined();
  });

  it("treats a non-HTTP-date-formatted date-like string as unparsable (only the RFC 9110 IMF-fixdate form is accepted, not e.g. ISO 8601)", () => {
    expect(getApiRetryAfterMs(rateLimitError("2050-01-01T00:00:00Z"))).toBeUndefined();
  });

  it("treats an empty header value as unparsable", () => {
    expect(getApiRetryAfterMs(rateLimitError(""))).toBeUndefined();
  });

  it("parses the HTTP-date form relative to the given `now`, TZ-independently", () => {
    // Built from local-date components (not a UTC string literal) per this
    // repo's TZ-independence convention — see CLAUDE.md's testing policy.
    const now = new Date(2026, 7, 24, 10, 0, 0); // 2026-08-24 10:00:00 local
    const target = new Date(now.getTime() + 45_000); // 45s later
    const header = target.toUTCString(); // RFC 7231 HTTP-date, e.g. "Mon, 24 Aug 2026 ... GMT"

    expect(getApiRetryAfterMs(rateLimitError(header), now)).toBe(45_000);
  });

  it("treats an HTTP-date in the past (relative to `now`) as unparsable ('指定なし'), not a negative number", () => {
    const now = new Date(2026, 7, 24, 10, 0, 0);
    const past = new Date(now.getTime() - 60_000); // 60s earlier
    const header = past.toUTCString();

    expect(getApiRetryAfterMs(rateLimitError(header), now)).toBeUndefined();
  });

  it("treats an unparsable date string as unparsable", () => {
    expect(getApiRetryAfterMs(rateLimitError("not a date at all"))).toBeUndefined();
  });

  it("never returns Infinity for an enormous-but-finite numeric-seconds value — self-review regression coverage: code-reviewer (round 2) caught that checking Number.isFinite on `seconds` before multiplying by 1000 let `seconds * 1000` itself overflow to Infinity and leak out, silently breaking the 'milliseconds' contract", () => {
    // A 306-digit all-9s string: `Number(...)` alone is still finite
    // (1e+306), but multiplying by 1000 overflows past `Number.MAX_VALUE`.
    const enormousSeconds = "9".repeat(306);
    const result = getApiRetryAfterMs(rateLimitError(enormousSeconds));
    expect(result).toBeUndefined();
    expect(result).not.toBe(Infinity);
  });
});
