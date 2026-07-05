import { describe, expect, it } from "vitest";
import { evaluateRules } from "./rule-engine.js";
import { DEFAULT_DETECTION_SETTINGS, type DetectionInput } from "./detection-types.js";
import { makeActivityEvent, makeTask } from "./detection-test-fixtures.js";

const settings = DEFAULT_DETECTION_SETTINGS;

function baseInput(overrides: Partial<DetectionInput> = {}): DetectionInput {
  return {
    now: new Date("2026-07-05T12:00:00"),
    tasks: [],
    activityEvents: [],
    notifications: [],
    settings,
    // 既定ではテスト対象外の朝会・夕会定時ルールが誤って混ざらないよう、
    // 両方実施済み扱いにしておく（個別のテストで明示的に上書きする）
    todaysSessionTypes: ["morning", "evening"],
    ...overrides,
  };
}

describe("evaluateRules", () => {
  it("fires an unstarted notification for a top-priority task past its threshold", () => {
    const task = makeTask({
      id: 1,
      status: "todo",
      priority: "high",
      estimated_minutes: 30,
      created_at: "2026-07-05T11:00:00",
    });

    const result = evaluateRules(baseInput({ tasks: [task] }));

    expect(result).toEqual([
      { ruleType: "unstarted", ruleKey: "unstarted:1", escalationLevel: 1, taskId: 1 },
    ]);
  });

  it("does not fire the unstarted rule before the threshold has elapsed", () => {
    const task = makeTask({
      id: 1,
      status: "todo",
      priority: "high",
      estimated_minutes: 30,
      created_at: "2026-07-05T11:45:00",
    });

    const result = evaluateRules(baseInput({ tasks: [task] }));

    expect(result).toEqual([]);
  });

  it("prefers avoidance over unstarted when there is recent activity on another task", () => {
    const topTask = makeTask({
      id: 1,
      status: "todo",
      priority: "high",
      estimated_minutes: 30,
      created_at: "2026-07-05T11:00:00",
    });
    const otherActivity = [
      makeActivityEvent({
        type: "task_update",
        task_id: 2,
        created_at: "2026-07-05T11:50:00",
      }),
    ];

    const result = evaluateRules(
      baseInput({ tasks: [topTask], activityEvents: otherActivity }),
    );

    expect(result).toEqual([
      { ruleType: "avoidance", ruleKey: "avoidance:1", escalationLevel: 1, taskId: 1 },
    ]);
  });

  it("suppresses all rules except break_overrun while on break", () => {
    const overdueTask = makeTask({
      id: 1,
      status: "todo",
      due_at: "2026-07-05T00:00:00",
    });
    const activeBreak = makeActivityEvent({
      type: "break_start",
      expected_minutes: 15,
      created_at: "2026-07-05T11:00:00",
    });

    const result = evaluateRules(
      baseInput({ tasks: [overdueTask], activityEvents: [activeBreak] }),
    );

    expect(result).toEqual([
      { ruleType: "break_overrun", ruleKey: "break_overrun", escalationLevel: 1, taskId: null },
    ]);
  });

  it("suppresses all detection rules (including break_overrun) outside working hours", () => {
    const activeBreak = makeActivityEvent({
      type: "break_start",
      expected_minutes: 15,
      created_at: "2026-07-05T19:00:00",
    });

    const result = evaluateRules(
      baseInput({
        now: new Date("2026-07-05T20:00:00"),
        activityEvents: [activeBreak],
      }),
    );

    expect(result).toEqual([]);
  });

  it("fires deadline_overdue notifications for every overdue task independently", () => {
    const first = makeTask({ id: 1, status: "todo", due_at: "2026-07-04T00:00:00" });
    const second = makeTask({ id: 2, status: "todo", due_at: "2026-07-05T00:00:00" });

    const result = evaluateRules(baseInput({ tasks: [first, second] }));

    expect(result).toContainEqual({
      ruleType: "deadline_overdue",
      ruleKey: "deadline_overdue:1",
      escalationLevel: 1,
      taskId: 1,
    });
    expect(result).toContainEqual({
      ruleType: "deadline_overdue",
      ruleKey: "deadline_overdue:2",
      escalationLevel: 1,
      taskId: 2,
    });
  });

  it("does not re-fire a rule_key before its escalation interval has elapsed (duplicate suppression)", () => {
    const task = makeTask({
      id: 1,
      status: "todo",
      priority: "high",
      estimated_minutes: 30,
      created_at: "2026-07-05T10:00:00",
    });
    const notifications = [
      { ruleKey: "unstarted:1", escalationLevel: 1, sentAt: "2026-07-05T11:59:00" },
    ];

    const result = evaluateRules(baseInput({ tasks: [task], notifications }));

    expect(result).toEqual([]);
  });

  it("escalates to level 2 once the level-1 interval has elapsed", () => {
    const task = makeTask({
      id: 1,
      status: "todo",
      priority: "high",
      estimated_minutes: 30,
      created_at: "2026-07-05T10:00:00",
    });
    const notifications = [
      { ruleKey: "unstarted:1", escalationLevel: 1, sentAt: "2026-07-05T11:45:00" },
    ];

    const result = evaluateRules(baseInput({ tasks: [task], notifications }));

    expect(result).toEqual([
      { ruleType: "unstarted", ruleKey: "unstarted:1", escalationLevel: 2, taskId: 1 },
    ]);
  });

  it("fires the morning meeting rule even outside working hours and even while on break", () => {
    const activeBreak = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T19:50:00",
    });

    const result = evaluateRules(
      baseInput({
        now: new Date("2026-07-05T20:00:00"),
        activityEvents: [activeBreak],
        todaysSessionTypes: [],
      }),
    );

    expect(result).toContainEqual({
      ruleType: "morning_meeting",
      ruleKey: "morning_meeting:2026-07-05",
      escalationLevel: 1,
      taskId: null,
    });
  });

  it("returns no notifications when nothing warrants one", () => {
    const result = evaluateRules(baseInput());

    expect(result).toEqual([]);
  });
});
