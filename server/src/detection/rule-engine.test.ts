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
    // due_at はローカル暦日（ADR 0010 決定 1）。締切が切れるのは翌暦日 00:00 な
    // ので、now（7/5 12:00）で超過させるには締切を 7/4 にする。7/5 のままだと
    // そもそも超過せず、「休憩中は抑制される」ことのテストが恒真になる。
    const overdueTask = makeTask({
      id: 1,
      status: "todo",
      due_at: "2026-07-04",
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

  it("does not fire break_overrun when only a paused task exists and no break is active (#179 判断4: G-179-17)", () => {
    const paused = makeTask({ id: 1, status: "paused" });
    const pauseEvent = makeActivityEvent({
      type: "task_pause",
      task_id: 1,
      created_at: "2026-07-05T09:00:00",
    });

    const result = evaluateRules(
      baseInput({
        now: new Date("2026-07-05T10:00:00"),
        tasks: [paused],
        activityEvents: [pauseEvent],
      }),
    );

    expect(result.map((r) => r.ruleType)).not.toContain("break_overrun");
  });

  // AC-16: 暦日 D を締切とするタスクの deadline_overdue の**最初の発火が D+1 の
  // 始業（09:00）**であること（ADR 0010 帰結）。締切超過の条件成立自体は D+1
  // 00:00 だが、その時刻は勤務時間帯 [09:00, 18:00) の外で rule-engine のゲートが
  // 閉じているため、実際に催促が出るのは始業から。時刻付き T18:00 だった現状の
  // 実効挙動と同じであり、本変更が催促を前倒しして強めていないことを固定する。
  //
  // 固定時刻は new Date(y, m, d, h) 由来のローカル日時（ADR 0007 決定 5）。
  // 勤務時間帯ゲートもローカル時刻基準なので、これで TZ 非依存になる。
  describe("first deadline_overdue firing for a calendar-day due date (AC-16)", () => {
    const DUE_DATE_KEY = "2026-07-05"; // 暦日 D
    const overdueTask = makeTask({ id: 1, status: "todo", due_at: DUE_DATE_KEY });

    function deadlineFirings(now: Date) {
      return evaluateRules(baseInput({ now, tasks: [overdueTask] })).filter(
        (r) => r.ruleType === "deadline_overdue",
      );
    }

    // (a) 本変更の**変異検出点**。旧解釈（暦日の始まりを締切とみなす／UTC 0 時
    // として解釈する）だと締切当日の日中に発火してしまう。
    it("does not fire during the due date itself, inside working hours", () => {
      expect(deadlineFirings(new Date(2026, 6, 5, 17))).toEqual([]);
    });

    // (b) 締切超過は成立しているが、始業前で勤務時間帯ゲートが閉じている。
    it("does not fire after the deadline lapses but before working hours begin", () => {
      expect(deadlineFirings(new Date(2026, 6, 6, 8))).toEqual([]);
    });

    // (c) 最初の発火。
    it("fires at the start of business on the day after the due date", () => {
      expect(deadlineFirings(new Date(2026, 6, 6, 9))).toEqual([
        {
          ruleType: "deadline_overdue",
          ruleKey: "deadline_overdue:1",
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });
  });

  it("fires deadline_overdue notifications for every overdue task independently", () => {
    // 締切はローカル暦日で、超過は翌暦日 00:00 から。now は 7/5 12:00 なので
    // 両方を 7/5 より前の暦日にする（7/5 締切はこの時点ではまだ超過ではない）。
    const first = makeTask({ id: 1, status: "todo", due_at: "2026-07-03" });
    const second = makeTask({ id: 2, status: "todo", due_at: "2026-07-04" });

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
