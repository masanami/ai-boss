import { describe, expect, it } from "vitest";
import { findOverdueTasks } from "./deadline-overdue.js";
import { makeTask } from "./detection-test-fixtures.js";
import { toDateKey } from "./time-utils.js";

// due_at は**ローカル暦日**（ADR 0010 決定 1）。締切が切れるのは締切の暦日 D の
// 翌ローカル暦日 D+1 の 00:00 ちょうど（決定 2）。
//
// 固定値はすべて `new Date(y, m, d, h)` 由来のローカル日時から導出し、UTC 文字列
// リテラルで固定しない（ADR 0007 決定 5）。UTC リテラルで置くと実行 TZ によって
// 暦日がずれ、`npm run test:tz` で落ちる。
const DUE_DAY = new Date(2026, 6, 5); // 2026-07-05 ローカル
const DUE_DATE_KEY = toDateKey(DUE_DAY); // "2026-07-05"

/** 締切暦日 D の翌暦日 D+1 00:00 ちょうど（＝まだ超過ではない境界） */
const AT_BOUNDARY = new Date(2026, 6, 6);
/** D+1 00:00 を 1 ミリ秒過ぎた瞬間（＝超過の成立） */
const JUST_AFTER_BOUNDARY = new Date(2026, 6, 6, 0, 0, 0, 1);
/** 締切当日の日中。旧解釈（暦日の始まりを締切とみなす）だとここで超過になる */
const DURING_DUE_DAY = new Date(2026, 6, 5, 17);

describe("findOverdueTasks", () => {
  it("returns a todo task once the day after its due date has begun", () => {
    const overdue = makeTask({ status: "todo", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([overdue], JUST_AFTER_BOUNDARY)).toEqual([overdue]);
  });

  it("does not include a task exactly at the start of the day after its due date (not yet overdue)", () => {
    const task = makeTask({ status: "todo", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([task], AT_BOUNDARY)).toEqual([]);
  });

  it("does not include a task during its own due date (the deadline covers the whole calendar day)", () => {
    const task = makeTask({ status: "todo", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([task], DURING_DUE_DAY)).toEqual([]);
  });

  it("does not include a task with no due_at", () => {
    const task = makeTask({ status: "todo", due_at: null });

    expect(findOverdueTasks([task], JUST_AFTER_BOUNDARY)).toEqual([]);
  });

  it("does not include done or dropped tasks even if overdue", () => {
    const done = makeTask({ status: "done", due_at: DUE_DATE_KEY });
    const dropped = makeTask({ status: "dropped", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([done, dropped], JUST_AFTER_BOUNDARY)).toEqual([]);
  });

  it("includes an overdue in_progress task", () => {
    const inProgress = makeTask({
      status: "in_progress",
      due_at: DUE_DATE_KEY,
    });

    expect(findOverdueTasks([inProgress], JUST_AFTER_BOUNDARY)).toEqual([
      inProgress,
    ]);
  });

  it("returns every overdue task, not just the top-priority one", () => {
    const first = makeTask({
      id: 1,
      status: "todo",
      due_at: toDateKey(new Date(2026, 6, 4)),
    });
    const second = makeTask({ id: 2, status: "todo", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([first, second], JUST_AFTER_BOUNDARY)).toEqual([
      first,
      second,
    ]);
  });

  it("includes an overdue paused task (#179 判断4: G-179-8)", () => {
    const paused = makeTask({ status: "paused", due_at: DUE_DATE_KEY });

    expect(findOverdueTasks([paused], JUST_AFTER_BOUNDARY)).toEqual([paused]);
  });

  it("interprets a legacy time-of-day due_at as its local calendar day", () => {
    // 旧形式は破棄せず正規化対象として扱う（ADR 0010 決定 3）。その瞬時の
    // ローカル暦日 D が締切になるため、超過は D+1 00:00 以降。
    const instant = new Date(2026, 6, 5, 18);
    const legacy = makeTask({ status: "todo", due_at: instant.toISOString() });
    const dayAfter = new Date(2026, 6, 6, 0, 0, 0, 1);

    expect(findOverdueTasks([legacy], DURING_DUE_DAY)).toEqual([]);
    expect(findOverdueTasks([legacy], dayAfter)).toEqual([legacy]);
  });

  // AC-8: 不正値を `new Date()` が過去の瞬時として解釈できてしまう場合でも
  // 締切超過にしない。"0" は `new Date("0")` が 2000-01-01 を返すため、ガードが
  // 無いと**常に**締切超過として催促が飛び続ける。
  it.each(["0", "not-a-date-at-all", "2026-13-01", "2026-02-30", "12/31/2026", ""])(
    "does not treat an unparseable due_at (%j) as overdue (AC-8)",
    (dueAt) => {
      const task = makeTask({ status: "todo", due_at: dueAt });

      expect(findOverdueTasks([task], JUST_AFTER_BOUNDARY)).toEqual([]);
    },
  );
});
