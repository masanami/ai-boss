import { describe, expect, it } from "vitest";
import { selectRewriteRange } from "./select-rewrite-range";
import type { ChatEntry } from "./chat";

const ACTIVE_SESSION_ID = 1;
const OTHER_SESSION_ID = 2;

function userMessage(overrides: Partial<ChatEntry> & { key: string }): ChatEntry {
  return {
    kind: "message",
    role: "user",
    content: `content of ${overrides.key}`,
    sessionId: ACTIVE_SESSION_ID,
    ...overrides,
  } as ChatEntry;
}

function bossMessage(overrides: Partial<ChatEntry> & { key: string }): ChatEntry {
  return {
    kind: "message",
    role: "boss",
    content: `content of ${overrides.key}`,
    sessionId: ACTIVE_SESSION_ID,
    ...overrides,
  } as ChatEntry;
}

function tool(key: string): ChatEntry {
  return {
    kind: "tool",
    key,
    tool: { name: "create_task", input: {}, result: "{}", isError: false },
  };
}

function boundary(key: string): ChatEntry {
  return { kind: "boundary", key, sessionType: "morning", event: "start" };
}

describe("selectRewriteRange", () => {
  // AC-25
  it("includes the target message itself when it is the only entry", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1"],
      total: 1,
      userCount: 1,
      bossCount: 0,
    });
  });

  // AC-26
  it("includes later messages from the same session", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      bossMessage({ key: "message-2", messageId: 2 }),
      userMessage({ key: "message-3", messageId: 3 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1", "message-2", "message-3"],
      total: 3,
      userCount: 2,
      bossCount: 1,
    });
  });

  // AC-27
  it("excludes later messages from a different session, even though they sort after the target", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      bossMessage({ key: "message-2", messageId: 2, sessionId: OTHER_SESSION_ID }),
      userMessage({ key: "message-3", messageId: 3 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1", "message-3"],
      total: 2,
      userCount: 2,
      bossCount: 0,
    });
  });

  // AC-28
  it("never includes boundary entries, whether before, inside, or after the range", () => {
    const entries: ChatEntry[] = [
      boundary("boundary-before"),
      userMessage({ key: "message-1", messageId: 1 }),
      boundary("boundary-inside"),
      bossMessage({ key: "message-2", messageId: 2 }),
      boundary("boundary-after"),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range.keys).toEqual(["message-1", "message-2"]);
    expect(range.keys).not.toContain("boundary-before");
    expect(range.keys).not.toContain("boundary-inside");
    expect(range.keys).not.toContain("boundary-after");
  });

  // AC-29
  it("counts userCount and bossCount separately by role, with total as their sum", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      bossMessage({ key: "message-2", messageId: 2 }),
      userMessage({ key: "message-3", messageId: 3 }),
      bossMessage({ key: "message-4", messageId: 4 }),
      bossMessage({ key: "message-5", messageId: 5 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range.userCount).toBe(2);
    expect(range.bossCount).toBe(3);
    expect(range.total).toBe(5);
  });

  // AC-30: regression for #272's merged timeline — a finished meeting's
  // messages sit *between* the target and a later same-session message in
  // screen order, and must neither be counted nor break the scan onward.
  it("skips a finished meeting's messages spliced between same-session messages (#272 regression)", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      boundary("boundary-20-start"),
      userMessage({ key: "message-30", messageId: 30, sessionId: OTHER_SESSION_ID }),
      bossMessage({ key: "message-31", messageId: 31, sessionId: OTHER_SESSION_ID }),
      boundary("boundary-20-end"),
      bossMessage({ key: "message-2", messageId: 2 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1", "message-2"],
      total: 2,
      userCount: 1,
      bossCount: 1,
    });
  });

  it("removes a tool notification inside the range from view without counting it as a message", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      tool("tool-1"),
      bossMessage({ key: "message-2", messageId: 2 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1", "tool-1", "message-2"],
      total: 2,
      userCount: 1,
      bossCount: 1,
    });
  });

  it("excludes entries that sort before the target", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      bossMessage({ key: "message-2", messageId: 2 }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 2);

    expect(range).toEqual({
      keys: ["message-2"],
      total: 1,
      userCount: 0,
      bossCount: 1,
    });
  });

  it("returns an empty range when the target message cannot be found in the given session", () => {
    const entries: ChatEntry[] = [userMessage({ key: "message-1", messageId: 1 })];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 999);

    expect(range).toEqual({ keys: [], total: 0, userCount: 0, bossCount: 0 });
  });

  it("does not match a message id that belongs to a different session than activeSessionId", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1, sessionId: OTHER_SESSION_ID }),
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({ keys: [], total: 0, userCount: 0, bossCount: 0 });
  });

  // Known gap tracked for Issue #378 (not this ticket): a message entry
  // `useChat` appends outside `buildTimeline` (optimistic send, or a
  // streamed reply's onDone/interrupted handling) has no messageId/sessionId
  // yet, even once the server has actually persisted it. This pins the
  // current, conservative behavior — such an entry is treated like a
  // different session and excluded — which under-counts rather than
  // over-counts a deletion until #378 attaches real identifiers.
  it("excludes a later same-session message entry that has no messageId/sessionId set (#378 gap)", () => {
    const entries: ChatEntry[] = [
      userMessage({ key: "message-1", messageId: 1 }),
      {
        kind: "message",
        key: "user-local-2",
        role: "user",
        content: "まだ識別子の無い発言",
      },
    ];

    const range = selectRewriteRange(entries, ACTIVE_SESSION_ID, 1);

    expect(range).toEqual({
      keys: ["message-1"],
      total: 1,
      userCount: 1,
      bossCount: 0,
    });
  });

  it("returns an empty range for an empty timeline", () => {
    expect(selectRewriteRange([], ACTIVE_SESSION_ID, 1)).toEqual({
      keys: [],
      total: 0,
      userCount: 0,
      bossCount: 0,
    });
  });
});
