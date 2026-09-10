import { describe, expect, it } from "vitest";
import { pickTopPriorityTask } from "./priority.js";
import { makeTask } from "./detection-test-fixtures.js";
import { toDateKey } from "./time-utils.js";

// due_at はローカル暦日（ADR 0010 決定 1）。固定値は `new Date(y, m, d)` 由来の
// ローカル日付から導出し、UTC 文字列リテラルで固定しない（ADR 0007 決定 5）。
const EARLIER_DUE = toDateKey(new Date(2026, 6, 6)); // "2026-07-06"
const LATER_DUE = toDateKey(new Date(2026, 6, 10)); // "2026-07-10"

describe("pickTopPriorityTask", () => {
  it("picks the higher priority task over a lower priority one", () => {
    const low = makeTask({ id: 1, priority: "low" });
    const high = makeTask({ id: 2, priority: "high" });

    expect(pickTopPriorityTask([low, high])).toEqual(high);
  });

  it("ranks a null priority below low priority", () => {
    const noPriority = makeTask({ id: 1, priority: null });
    const low = makeTask({ id: 2, priority: "low" });

    expect(pickTopPriorityTask([noPriority, low])).toEqual(low);
  });

  it("breaks a priority tie by earlier due_at", () => {
    const laterDue = makeTask({ id: 1, priority: "high", due_at: LATER_DUE });
    const earlierDue = makeTask({
      id: 2,
      priority: "high",
      due_at: EARLIER_DUE,
    });

    expect(pickTopPriorityTask([laterDue, earlierDue])).toEqual(earlierDue);
  });

  it("treats a null due_at as last among a due_at tie-break", () => {
    const withDue = makeTask({ id: 1, priority: "high", due_at: LATER_DUE });
    const noDue = makeTask({ id: 2, priority: "high", due_at: null });

    expect(pickTopPriorityTask([noDue, withDue])).toEqual(withDue);
  });

  it("breaks a full tie by ascending id", () => {
    const higherId = makeTask({ id: 5, priority: "high" });
    const lowerId = makeTask({ id: 2, priority: "high" });

    expect(pickTopPriorityTask([higherId, lowerId])).toEqual(lowerId);
  });

  it("excludes done and dropped tasks from the candidates", () => {
    const done = makeTask({ id: 1, priority: "high", status: "done" });
    const dropped = makeTask({ id: 2, priority: "high", status: "dropped" });
    const todo = makeTask({ id: 3, priority: "low", status: "todo" });

    expect(pickTopPriorityTask([done, dropped, todo])).toEqual(todo);
  });

  it("returns undefined when there are no eligible tasks", () => {
    const done = makeTask({ id: 1, status: "done" });

    expect(pickTopPriorityTask([done])).toBeUndefined();
  });

  it("excludes a paused task from the candidates (#179 判断4: G-179-7)", () => {
    const paused = makeTask({ id: 1, priority: "high", status: "paused" });
    const todo = makeTask({ id: 2, priority: "low", status: "todo" });

    expect(pickTopPriorityTask([paused, todo])).toEqual(todo);
  });

  it("ranks a legacy time-of-day due_at by its local calendar day", () => {
    const legacyEarlier = makeTask({
      id: 1,
      priority: "high",
      due_at: new Date(2026, 6, 6, 18).toISOString(),
    });
    const laterDue = makeTask({ id: 2, priority: "high", due_at: LATER_DUE });

    expect(pickTopPriorityTask([laterDue, legacyEarlier])).toEqual(
      legacyEarlier,
    );
  });

  // AC-9: 不正な due_at は「締切なし」と同順（最後尾）に扱う。ガードが無いと
  // `new Date(dueAt).getTime()` が NaN を返し、比較が常に false になって並び順が
  // 入力配列の順序に依存して壊れる。**入力順を入れ替えた両方の並びで検証する**
  // ことで、たまたま入力順で通っている状態を排除する。
  it.each(["0", "not-a-date-at-all", "2026-13-01", "2026-02-30", "12/31/2026", ""])(
    "ranks an unparseable due_at (%j) behind a real due_at regardless of input order (AC-9)",
    (invalidDueAt) => {
      const invalid = makeTask({
        id: 1,
        priority: "high",
        due_at: invalidDueAt,
      });
      const withDue = makeTask({ id: 2, priority: "high", due_at: LATER_DUE });

      expect(pickTopPriorityTask([invalid, withDue])).toEqual(withDue);
      expect(pickTopPriorityTask([withDue, invalid])).toEqual(withDue);
    },
  );

  it.each(["0", "not-a-date-at-all", "2026-13-01", "2026-02-30", "12/31/2026", ""])(
    "ranks an unparseable due_at (%j) level with a null due_at, falling back to id order (AC-9)",
    (invalidDueAt) => {
      // 同順なら id 昇順で決まる。id の大小と入力順の両方を入れ替えて、
      // 「同順である」ことが入力順に依存せず成り立つことを確かめる。
      const invalidLowerId = makeTask({
        id: 1,
        priority: "high",
        due_at: invalidDueAt,
      });
      const nullHigherId = makeTask({ id: 2, priority: "high", due_at: null });

      expect(pickTopPriorityTask([invalidLowerId, nullHigherId])).toEqual(
        invalidLowerId,
      );
      expect(pickTopPriorityTask([nullHigherId, invalidLowerId])).toEqual(
        invalidLowerId,
      );

      const nullLowerId = makeTask({ id: 1, priority: "high", due_at: null });
      const invalidHigherId = makeTask({
        id: 2,
        priority: "high",
        due_at: invalidDueAt,
      });

      expect(pickTopPriorityTask([nullLowerId, invalidHigherId])).toEqual(
        nullLowerId,
      );
      expect(pickTopPriorityTask([invalidHigherId, nullLowerId])).toEqual(
        nullLowerId,
      );
    },
  );
});
