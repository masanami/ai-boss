import { describe, expect, it } from "vitest";
import { pickTopPriorityTask } from "./priority.js";
import { makeTask } from "./detection-test-fixtures.js";

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
    const laterDue = makeTask({
      id: 1,
      priority: "high",
      due_at: "2026-07-10T00:00:00.000Z",
    });
    const earlierDue = makeTask({
      id: 2,
      priority: "high",
      due_at: "2026-07-06T00:00:00.000Z",
    });

    expect(pickTopPriorityTask([laterDue, earlierDue])).toEqual(earlierDue);
  });

  it("treats a null due_at as last among a due_at tie-break", () => {
    const withDue = makeTask({
      id: 1,
      priority: "high",
      due_at: "2026-07-10T00:00:00.000Z",
    });
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
});
