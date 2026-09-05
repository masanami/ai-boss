import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { listEventsSince } from "../activity/activity-events-repository.js";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "../activity/local-day.js";
import { findTaskById } from "../tasks/tasks-repository.js";
import type { Task } from "../tasks/task.js";
import type { ToolExecutionResult } from "./task-tools.js";

/** Maximum number of events returned in one call, to protect the chat
 * context window (Issue #150's explicit "上限" decision). */
const MAX_EVENTS = 100;

/** Sentinel `since` used when `task_id` is given without an explicit
 * `since`: the ticket's default is "full history" in that case (task-scoped
 * logs are small and needed to compute cross-day actual duration), which we
 * implement by passing a timestamp before any real `activity_events` row. */
const EPOCH_ISO = new Date(0).toISOString();

/**
 * Tool the boss invokes during chat to look up `activity_events` (Issue
 * #150, parent #141's 案 1). Typical use: after a completion report, call
 * this with the task's `task_id` to fetch its `task_start` (着手) through
 * completion timestamps, compute the actual elapsed time, and compare it
 * against the task's estimate (`expected_minutes` / `estimated_minutes`) to
 * flag a gap.
 *
 * Event types:
 * - `task_start`: 着手（作業開始）
 * - `task_update`: タスク更新（完了時にも記録される）
 * - `checkin`: 定時報告（朝会・夕会）
 * - `break_start` / `break_end`: 休憩の開始・終了
 * - `chat_message`: チャットでの発言
 */
export const GET_ACTIVITY_LOG_TOOL: Anthropic.Tool = {
  name: "get_activity_log",
  description:
    "作業ログ（activity_events）を照会する。完了報告を受けたときは対象タスクの task_id を指定して呼び、" +
    "task_start（着手）から完了までの実績時間を算出し、見積もり（expected_minutes / estimated_minutes）との乖離を確認するのに使う。" +
    "イベント型の意味: task_start=着手、task_update=タスク更新（完了時にも記録される）、checkin=定時報告、" +
    "break_start・break_end=休憩の開始・終了、chat_message=チャットでの発言。" +
    "task_id / since / until はすべて任意の絞り込み条件。since を省略した場合、task_id 指定時は全期間、" +
    "未指定時は当日ローカル0時以降が対象になる。" +
    "task_id を指定した場合は task（id / title / status / estimated_minutes / completed_at）も併せて返るため、" +
    "実績時間と見積もりの突き合わせや、完了済みかどうかの判断にはこの task の値を使うこと。" +
    "結果は最大100件（新しい順に切り詰め、古いイベントから欠落しうる）。truncated が true の場合は since/until で範囲を絞って再照会すること。",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "integer", description: "絞り込み対象のタスクの id" },
      since: {
        type: "string",
        description:
          "この日時（ISO 8601 文字列。YYYY-MM-DD のみの指定はローカル日の0時として扱う）以降のイベントに絞り込む。省略時は task_id 指定時は全期間、未指定時は当日ローカル0時以降。",
      },
      until: {
        type: "string",
        description:
          "この日時（ISO 8601 文字列）より前のイベントに絞り込む（この日時ちょうどは含まない）。YYYY-MM-DD のみの指定はその日全体を含める（翌ローカル日の0時より前として扱う）。省略時は上限なし。過去を遡るときは since も指定すること（since 省略時の下限は当日ローカル0時のまま）。",
      },
    },
    required: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type IsoParseResult =
  | { ok: true; iso: string }
  | { ok: false; error: string };

/** Matches a bare `YYYY-MM-DD` date (no time-of-day component). */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Matches an ISO 8601 datetime: `T` 区切り・分まで必須・秒/ミリ秒任意・
 * タイムゾーン指定（`Z` or `±HH:MM`）任意（省略時は `Date.parse` のローカル
 * 解釈に委ねる）。`Date.parse` 単独だと `July 5, 2026` や `2026/07/05` 等の
 * 非 ISO 形式まで受理してしまうため、形式はこのパターンで先に絞る
 * （PR #152 レビュー指摘）。 */
const DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** `2026-02-30` のような存在しない暦日を `Date` の月繰り上げ正規化で
 * 受理しないための実在チェック。 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year &&
    probe.getMonth() === month - 1 &&
    probe.getDate() === day
  );
}

/** Validates and canonicalizes an ISO 8601 date-ish input. Canonicalizing
 * (round-tripping through `Date`) matters for `since`: `listEventsSince`
 * compares `created_at` as plain TEXT, so `since` must be in the same
 * `toISOString()` shape the repository stores to sort/compare correctly.
 *
 * A bare `YYYY-MM-DD` value is interpreted as a *local* day rather than
 * `Date.parse`'s default (UTC midnight per ECMA-262) — this tool's own
 * omitted-`since` default (`startOfLocalDayIso`) is local-day based, so an
 * explicit date-only `since`/`until` following the opposite (UTC)
 * convention would silently shift the window by the timezone offset
 * (self-review: caught as a JST +9h drift). `dateOnlyBoundary` picks which
 * edge of that local day a bare date resolves to: `"start-of-day"` for
 * `since` (00:00:00.000 local), `"start-of-next-day"` for `until` (the next
 * local calendar day's 00:00:00.000, used as an *exclusive* upper bound per
 * ADR 0007 決定3 — not 23:59:59.999, which would drop same-day rows if the
 * stored precision ever exceeds milliseconds; #236) — so `{since:
 * "2026-07-05", until: "2026-07-05"}` covers the whole local day rather than
 * being an always-empty window. Both edges come from `activity/local-day.ts`
 * (the single definition of the local-day range; it advances the calendar
 * date rather than adding a fixed 24h, see its DST note). Anything with a
 * time component still goes through `Date.parse` unchanged. */
function parseIsoInput(
  value: unknown,
  fieldName: string,
  dateOnlyBoundary: "start-of-day" | "start-of-next-day",
): IsoParseResult {
  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be an ISO 8601 date string` };
  }

  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    if (!isRealCalendarDate(year, month, day)) {
      return {
        ok: false,
        error: `${fieldName} must be a valid ISO 8601 date string (got "${value}")`,
      };
    }
    const localDay = new Date(year, month - 1, day);
    const iso =
      dateOnlyBoundary === "start-of-next-day"
        ? startOfNextLocalDayIso(localDay)
        : startOfLocalDayIso(localDay);
    return { ok: true, iso };
  }

  const match = DATETIME_PATTERN.exec(value);
  if (!match) {
    return {
      ok: false,
      error: `${fieldName} must be a valid ISO 8601 date string (got "${value}")`,
    };
  }
  const [, y, mo, d, h, mi, sec] = match;
  const inRange =
    isRealCalendarDate(Number(y), Number(mo), Number(d)) &&
    Number(h) <= 23 &&
    Number(mi) <= 59 &&
    (sec === undefined || Number(sec) <= 59);
  const timestamp = inRange ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(timestamp)) {
    return {
      ok: false,
      error: `${fieldName} must be a valid ISO 8601 date string (got "${value}")`,
    };
  }
  return { ok: true, iso: new Date(timestamp).toISOString() };
}

/**
 * Executes a `get_activity_log` tool_use block. Pure DB read: no session id
 * is needed (unlike `record_decision`), so `executeBossTool` dispatches to
 * this directly. Reuses `listEventsSince()` for the time window (both
 * bounds; its upper bound is exclusive, matching this tool's `until` since
 * #236) and filters `task_id` in memory rather than adding a new repository
 * query.
 */
export function executeGetActivityLogTool(
  db: Database.Database,
  input: unknown,
): ToolExecutionResult {
  if (!isRecord(input)) {
    return { content: "input must be an object", isError: true };
  }

  let taskId: number | undefined;
  let task: Task | undefined;
  if (input.task_id !== undefined && input.task_id !== null) {
    if (typeof input.task_id !== "number" || !Number.isInteger(input.task_id)) {
      return { content: "task_id must be an integer", isError: true };
    }
    // Mirrors decision-tool.ts's existence check: without it, a
    // hallucinated/mistyped task_id would silently return `{events: [],
    // truncated: false}` instead of an error, and the boss could not tell
    // "this task has no log entries" apart from "this task_id is wrong"
    // (self-review finding).
    const found = findTaskById(db, input.task_id);
    if (!found) {
      return { content: `task ${input.task_id} not found`, isError: true };
    }
    taskId = input.task_id;
    task = found;
  }

  let sinceIso: string | undefined;
  if (input.since !== undefined && input.since !== null) {
    const parsed = parseIsoInput(input.since, "since", "start-of-day");
    if (!parsed.ok) {
      return { content: parsed.error, isError: true };
    }
    sinceIso = parsed.iso;
  }

  let untilIso: string | undefined;
  if (input.until !== undefined && input.until !== null) {
    const parsed = parseIsoInput(input.until, "until", "start-of-next-day");
    if (!parsed.ok) {
      return { content: parsed.error, isError: true };
    }
    untilIso = parsed.iso;
  }

  // `until` omitted → no upper bound (#236 decision). This is a look-up
  // tool, not an aggregate: a future-dated row after a clock rollback shows
  // up as one more event the boss can see and question, rather than
  // silently inflating a number (the #230/#236 aggregate symptom). Adding a
  // "today" cap here would also break the task_id "full history" default,
  // which is deliberately unbounded on both ends.
  const effectiveSince =
    sinceIso ?? (taskId !== undefined ? EPOCH_ISO : startOfLocalDayIso());

  // `untilIso` is canonical `toISOString()` output (parseIsoInput), so the
  // repository's TEXT comparison is exact. Its upper bound is exclusive —
  // one half-open semantics for both date-only and explicit datetimes
  // (ADR 0007 決定3; #236).
  let events = listEventsSince(db, effectiveSince, untilIso);

  if (taskId !== undefined) {
    events = events.filter((event) => event.task_id === taskId);
  }

  const truncated = events.length > MAX_EVENTS;
  const limited = truncated ? events.slice(-MAX_EVENTS) : events;

  // task_id 指定時はタスク側のメタデータも返す。activity_events だけでは
  // 見積もり（estimated_minutes）と権威ある完了時刻（completed_at）が分からず、
  // task_update イベントも変更内容を持たないため「完了なのか優先度変更なのか」
  // を区別できない＝実績時間と見積もりの突き合わせができない（PR #152 レビュー指摘）。
  const taskMeta = task
    ? {
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          estimated_minutes: task.estimated_minutes,
          completed_at: task.completed_at,
        },
      }
    : {};

  return {
    content: JSON.stringify({ ...taskMeta, events: limited, truncated }),
    isError: false,
  };
}
