import { describe, expect, it } from "vitest";
import { buildTimeline, selectTimelineSessions } from "./merge-timeline";
import type { ChatMessage, ChatSession } from "./chat";

// Local-time anchors (ADR 0007 決定5): every timestamp is derived from a
// local-date constructor rather than a fixed UTC string, so the day-boundary
// assertions below stay TZ-independent.
const LOCAL_NOW = new Date(2026, 6, 5, 12, 0, 0); // 2026-07-05 12:00 local
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 6, day, hour, minute, 0).toISOString();

function session(overrides: Partial<ChatSession> & { id: number }): ChatSession {
  return {
    type: "adhoc",
    started_at: at(5, 9),
    ended_at: null,
    summary: null,
    ...overrides,
  };
}

function message(
  overrides: Partial<ChatMessage> & { id: number; session_id: number },
): ChatMessage {
  return {
    role: "user",
    content: `message ${overrides.id}`,
    interrupted: 0,
    created_at: at(5, 10),
    ...overrides,
  };
}

describe("selectTimelineSessions", () => {
  it("keeps today's sessions ordered by started_at ascending", () => {
    const evening = session({ id: 3, type: "evening", started_at: at(5, 18) });
    const adhoc = session({ id: 1, started_at: at(5, 9) });
    const morning = session({ id: 2, type: "morning", started_at: at(5, 10) });

    const selected = selectTimelineSessions([evening, adhoc, morning], LOCAL_NOW, []);

    expect(selected.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("breaks started_at ties by ascending id so the order is deterministic", () => {
    const later = session({ id: 9, started_at: at(5, 9) });
    const earlier = session({ id: 4, started_at: at(5, 9) });

    const selected = selectTimelineSessions([later, earlier], LOCAL_NOW, []);

    expect(selected.map((s) => s.id)).toEqual([4, 9]);
  });

  // AC-14
  it("excludes sessions from a previous local day", () => {
    const yesterday = session({ id: 1, started_at: at(4, 9), ended_at: at(4, 18) });
    const today = session({ id: 2, started_at: at(5, 9) });

    const selected = selectTimelineSessions([yesterday, today], LOCAL_NOW, []);

    expect(selected.map((s) => s.id)).toEqual([2]);
  });

  // AC-13: ADR 0007 決定4 で日跨ぎの夕会は開始日に帰属するため、23:50 開始の
  // 夕会は 00:30 時点で「当日」から外れる。補正が無いと会の最中に履歴が
  // 画面から消える。
  it("keeps the active session even when it started on a previous local day", () => {
    const crossMidnight = session({
      id: 7,
      type: "evening",
      started_at: at(4, 23, 50),
    });
    const justAfterMidnight = new Date(2026, 6, 5, 0, 30, 0);

    const selected = selectTimelineSessions(
      [crossMidnight],
      justAfterMidnight,
      [7],
    );

    expect(selected.map((s) => s.id)).toEqual([7]);
  });

  it("does not resurrect a previous day's session that is not the active one", () => {
    const yesterdayOpen = session({ id: 7, type: "evening", started_at: at(4, 23, 50) });
    const justAfterMidnight = new Date(2026, 6, 5, 0, 30, 0);

    const selected = selectTimelineSessions([yesterdayOpen], justAfterMidnight, []);

    expect(selected).toEqual([]);
  });

  it("does not duplicate the active session when it also started today", () => {
    const today = session({ id: 2, type: "morning", started_at: at(5, 9) });

    const selected = selectTimelineSessions([today], LOCAL_NOW, [2]);

    expect(selected.map((s) => s.id)).toEqual([2]);
  });
});

describe("buildTimeline", () => {
  // AC-12
  it("merges messages from several sessions into one created_at-ascending timeline", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9) });
    const evening = session({ id: 2, type: "evening", started_at: at(5, 18) });

    const entries = buildTimeline([
      {
        session: adhoc,
        messages: [
          message({ id: 10, session_id: 1, content: "朝の相談", created_at: at(5, 9, 30) }),
          message({ id: 11, session_id: 1, content: "夜の相談", created_at: at(5, 20) }),
        ],
      },
      {
        session: evening,
        messages: [
          message({ id: 12, session_id: 2, content: "夕会の報告", created_at: at(5, 18, 5) }),
        ],
      },
    ]);

    expect(entries.map((entry) => entry.key)).toEqual([
      "message-10",
      "boundary-2-start",
      "message-12",
      "message-11",
    ]);
  });

  // AC-11
  it("emits start and end boundaries for a finished meeting", () => {
    const morning = session({
      id: 2,
      type: "morning",
      started_at: at(5, 9),
      ended_at: at(5, 9, 30),
    });

    const entries = buildTimeline([{ session: morning, messages: [] }]);

    expect(entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-2-start",
        sessionType: "morning",
        event: "start",
      },
      {
        kind: "boundary",
        key: "boundary-2-end",
        sessionType: "morning",
        event: "end",
      },
    ]);
  });

  // 明示的な仮定5
  it("emits only the start boundary while a meeting is still open", () => {
    const evening = session({ id: 3, type: "evening", started_at: at(5, 18) });

    const entries = buildTimeline([{ session: evening, messages: [] }]);

    expect(entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-3-start",
        sessionType: "evening",
        event: "start",
      },
    ]);
  });

  // 明示的な仮定4: 随時は「会でない区間」なので境界を出さない
  it("emits no boundary for an adhoc session", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9), ended_at: at(5, 10) });

    const entries = buildTimeline([
      { session: adhoc, messages: [message({ id: 10, session_id: 1 })] },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["message"]);
  });

  it("places the start boundary before a meeting-opening message stored at the same instant", () => {
    const evening = session({ id: 3, type: "evening", started_at: at(5, 18) });

    const entries = buildTimeline([
      {
        session: evening,
        messages: [
          message({
            id: 20,
            session_id: 3,
            role: "boss",
            content: "今日の進捗を報告しろ。",
            created_at: at(5, 18),
          }),
        ],
      },
    ]);

    expect(entries.map((entry) => entry.key)).toEqual([
      "boundary-3-start",
      "message-20",
    ]);
  });

  it("places the end boundary after a message stored at the same instant", () => {
    const evening = session({
      id: 3,
      type: "evening",
      started_at: at(5, 18),
      ended_at: at(5, 19),
    });

    const entries = buildTimeline([
      {
        session: evening,
        messages: [message({ id: 21, session_id: 3, created_at: at(5, 19) })],
      },
    ]);

    expect(entries.map((entry) => entry.key)).toEqual([
      "boundary-3-start",
      "message-21",
      "boundary-3-end",
    ]);
  });

  it("orders messages sharing a created_at by ascending id", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9) });

    const entries = buildTimeline([
      {
        session: adhoc,
        messages: [
          message({ id: 31, session_id: 1, created_at: at(5, 10) }),
          message({ id: 30, session_id: 1, created_at: at(5, 10) }),
        ],
      },
    ]);

    expect(entries.map((entry) => entry.key)).toEqual(["message-30", "message-31"]);
  });

  it("maps message role and content onto the message entry", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9) });

    const entries = buildTimeline([
      {
        session: adhoc,
        messages: [
          message({ id: 40, session_id: 1, role: "boss", content: "やれ。" }),
        ],
      },
    ]);

    expect(entries).toEqual([
      { kind: "message", key: "message-40", role: "boss", content: "やれ。" },
    ]);
  });

  // Issue #254: 中断はサーバに永続化されているので、リロードでタイムラインを
  // 組み直しても「途中で終わった応答」として復元されなければならない
  // （組み直しで落とすと、リロード後だけ普通の応答に見えてしまう）。
  it("marks a reply the server stored as interrupted, so a reload still shows it as cut short", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9) });

    const entries = buildTimeline([
      {
        session: adhoc,
        messages: [
          message({
            id: 41,
            session_id: 1,
            role: "boss",
            content: "まずは見積",
            interrupted: 1,
          }),
        ],
      },
    ]);

    expect(entries).toEqual([
      {
        kind: "message",
        key: "message-41",
        role: "boss",
        content: "まずは見積",
        interrupted: true,
      },
    ]);
  });

  it("leaves a completed reply without an interrupted marker", () => {
    const adhoc = session({ id: 1, started_at: at(5, 9) });

    const entries = buildTimeline([
      {
        session: adhoc,
        messages: [
          message({ id: 42, session_id: 1, role: "boss", content: "やれ。" }),
        ],
      },
    ]);

    expect(entries).toEqual([
      { kind: "message", key: "message-42", role: "boss", content: "やれ。" },
    ]);
  });

  it("returns an empty timeline for no sessions", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});
