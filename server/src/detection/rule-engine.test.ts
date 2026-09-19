import { describe, expect, it } from "vitest";
import { evaluateRules } from "./rule-engine.js";
import { DEFAULT_DETECTION_SETTINGS, type DetectionInput } from "./detection-types.js";
import { makeActivityEvent, makeTask } from "./detection-test-fixtures.js";
import { buildCommitmentMissedRuleKey } from "./commitment-missed.js";

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
      // #433: rule_key に実効時刻（この入力では既定の 09:00）が埋め込まれる
      ruleKey: "morning_meeting:2026-07-05@09:00",
      escalationLevel: 1,
      taskId: null,
    });
  });

  it("returns no notifications when nothing warrants one", () => {
    const result = evaluateRules(baseInput());

    expect(result).toEqual([]);
  });

  // 機能仕様 docs/features/task-start-commitment.md 決定 4・ADR 0004 改訂
  // （2026-09-13）。固定時刻はすべて new Date(2026, 8, 14, h, min)（翌日は
  // new Date(2026, 8, 15, h, min)）から導出する（TZ 非依存。既定の勤務時間帯
  // 09:00-18:00・エスカレーション間隔 15/10/10 分）。
  describe("commitment_missed (Issue #524)", () => {
    const DAY = (h: number, min: number) => new Date(2026, 8, 14, h, min);
    const NEXT_DAY = (h: number, min: number) => new Date(2026, 8, 15, h, min);

    it("fires commitment_missed exactly at the committed time (0-minute grace), not one minute before", () => {
      const committedStartAt = DAY(14, 0).toISOString();
      const committedAt = DAY(9, 30).toISOString();
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: committedStartAt,
        committed_at: committedAt,
      });

      const at1400 = evaluateRules(baseInput({ now: DAY(14, 0), tasks: [task] }));
      expect(at1400).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);

      const at1359 = evaluateRules(baseInput({ now: DAY(13, 59), tasks: [task] }));
      expect(at1359).toEqual([]);
    });

    it.each(["in_progress", "paused", "done", "dropped"] as const)(
      "does not fire commitment_missed for a %s task even past the committed time",
      (status) => {
        const task = makeTask({
          id: 1,
          status,
          committed_start_at: DAY(14, 0).toISOString(),
          committed_at: DAY(9, 30).toISOString(),
        });

        const result = evaluateRules(baseInput({ now: DAY(14, 30), tasks: [task] }));

        expect(result.map((r) => r.ruleType)).not.toContain("commitment_missed");
      },
    );

    it("fires commitment_missed for a non-top-priority task's commitment", () => {
      const taskA = makeTask({
        id: 1,
        priority: "high",
        status: "in_progress",
        committed_start_at: null,
        committed_at: null,
      });
      const taskB = makeTask({
        id: 2,
        priority: "low",
        status: "todo",
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: DAY(14, 30), tasks: [taskA, taskB] }));

      expect(result).toContainEqual({
        ruleType: "commitment_missed",
        ruleKey: buildCommitmentMissedRuleKey(taskB),
        escalationLevel: 1,
        taskId: 2,
      });
    });

    it("does not fire unstarted for a top-priority task with a commitment, even before the commitment time", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        created_at: DAY(9, 0).toISOString(),
        estimated_minutes: null,
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: DAY(13, 0), tasks: [task] }));

      expect(result.map((r) => r.ruleType)).not.toContain("unstarted");
    });

    it("does not fire avoidance for a top-priority task with a commitment, even with recent activity on other tasks", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        created_at: DAY(9, 0).toISOString(),
        estimated_minutes: null,
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });
      const otherActivity = [
        makeActivityEvent({ type: "task_start", task_id: 999, created_at: DAY(12, 50).toISOString() }),
      ];

      const result = evaluateRules(
        baseInput({ now: DAY(13, 0), tasks: [task], activityEvents: otherActivity }),
      );

      expect(result.map((r) => r.ruleType)).not.toContain("avoidance");
    });

    it("fires only commitment_missed (not unstarted) once the top-priority task's commitment time has passed", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        created_at: DAY(9, 0).toISOString(),
        estimated_minutes: null,
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: DAY(14, 30), tasks: [task] }));

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    it("does not fall back to evaluating unstarted for the next-priority task when the top-priority task has a commitment", () => {
      const taskA = makeTask({
        id: 1,
        priority: "high",
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const taskB = makeTask({
        id: 2,
        priority: "low",
        status: "todo",
        committed_start_at: null,
        committed_at: null,
        created_at: DAY(9, 0).toISOString(),
        estimated_minutes: null,
      });

      // taskA の約束（20:00）はまだ来ていないため commitment_missed も発火しない。
      // ここで確認したいのは taskB への unstarted が「次点への繰り下げ」で
      // 発火しないこと。
      const result = evaluateRules(baseInput({ now: DAY(13, 0), tasks: [taskA, taskB] }));

      expect(result.map((r) => r.ruleType)).not.toContain("unstarted");
    });

    it("still fires unstarted at exactly the threshold for a top-priority task without a commitment (unaffected)", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        created_at: DAY(9, 0).toISOString(),
        estimated_minutes: null,
        committed_start_at: null,
        committed_at: null,
      });

      const at1000 = evaluateRules(baseInput({ now: DAY(10, 0), tasks: [task] }));
      expect(at1000.map((r) => r.ruleType)).toContain("unstarted");

      const at0959 = evaluateRules(baseInput({ now: DAY(9, 59), tasks: [task] }));
      expect(at0959.map((r) => r.ruleType)).not.toContain("unstarted");
    });

    // ruleKey の形そのものを検査するテスト（buildCommitmentMissedRuleKey は
    // 使わず直書きする）。
    it("returns a commitment_missed ruleKey in the form commitment_missed:{taskId}:{committed_start_at}:{committed_at}", () => {
      const committedStartAt = DAY(14, 0).toISOString();
      const committedAt = DAY(9, 30).toISOString();
      const task = makeTask({
        id: 7,
        status: "todo",
        committed_start_at: committedStartAt,
        committed_at: committedAt,
      });

      const result = evaluateRules(baseInput({ now: DAY(14, 0), tasks: [task] }));

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: `commitment_missed:7:${committedStartAt}:${committedAt}`,
          escalationLevel: 1,
          taskId: 7,
        },
      ]);
    });

    it("does not carry over notification history from a changed commitment time (new ruleKey => L1)", () => {
      const taskId = 42;
      const firstTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });

      const firstResult = evaluateRules(baseInput({ now: DAY(14, 0), tasks: [firstTask] }));
      expect(firstResult).toHaveLength(1);
      const notifications = [
        { ruleKey: firstResult[0].ruleKey, escalationLevel: 1, sentAt: DAY(14, 0).toISOString() },
      ];

      const secondTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(14, 10).toISOString(),
        committed_at: DAY(14, 5).toISOString(),
      });

      const secondResult = evaluateRules(
        baseInput({ now: DAY(14, 20), tasks: [secondTask], notifications }),
      );

      expect(secondResult).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(secondTask),
          escalationLevel: 1,
          taskId,
        },
      ]);
    });

    it("escalates to L2 at +15 minutes within working hours, not yet at +14", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(14, 0).toISOString() }];

      const at1414 = evaluateRules(baseInput({ now: DAY(14, 14), tasks: [task], notifications }));
      expect(at1414).toEqual([]);

      const at1415 = evaluateRules(baseInput({ now: DAY(14, 15), tasks: [task], notifications }));
      expect(at1415).toEqual([
        { ruleType: "commitment_missed", ruleKey, escalationLevel: 2, taskId: 1 },
      ]);
    });

    it("resets to L1 within working hours when an activity signal occurs after the last notification", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 30).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(14, 0).toISOString() }];
      const activityEvents = [makeActivityEvent({ type: "chat_message", created_at: DAY(14, 5).toISOString() })];

      const result = evaluateRules(
        baseInput({ now: DAY(14, 6), tasks: [task], notifications, activityEvents }),
      );

      expect(result).toEqual([
        { ruleType: "commitment_missed", ruleKey, escalationLevel: 1, taskId: 1 },
      ]);
    });

    it("fires L1 outside working hours when the ruleKey has no notification history yet", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [task] }));

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    it("does not re-fire outside working hours once the ruleKey already has notification history, even without activity", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() }];

      const result = evaluateRules(baseInput({ now: DAY(20, 15), tasks: [task], notifications }));

      expect(result).toEqual([]);
    });

    it("does not re-fire outside working hours even when an activity signal follows the notification", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() }];
      const activityEvents = [makeActivityEvent({ type: "chat_message", created_at: DAY(20, 5).toISOString() })];

      const result = evaluateRules(
        baseInput({ now: DAY(20, 6), tasks: [task], notifications, activityEvents }),
      );

      expect(result).toEqual([]);
    });

    it("does not re-fire once working hours end for a commitment already notified inside working hours", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(17, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(17, 0).toISOString() }];

      const result = evaluateRules(baseInput({ now: DAY(18, 0), tasks: [task], notifications }));

      expect(result).toEqual([]);
    });

    it("escalates to L2 once the next working-hours window begins the next day, not before it", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() }];

      const at0859 = evaluateRules(baseInput({ now: NEXT_DAY(8, 59), tasks: [task], notifications }));
      expect(at0859).toEqual([]);

      const at0900 = evaluateRules(baseInput({ now: NEXT_DAY(9, 0), tasks: [task], notifications }));
      expect(at0900).toEqual([
        { ruleType: "commitment_missed", ruleKey, escalationLevel: 2, taskId: 1 },
      ]);
    });

    it("fires L1 outside working hours the next calendar day when there is still no notification history (no calendar-day cutoff)", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: NEXT_DAY(2, 0), tasks: [task] }));

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    it("fires L1 outside working hours when the commitment was moved (20:00 -> 21:00), even with history for the old commitment", () => {
      const taskId = 5;
      const firstTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(19, 0).toISOString(),
      });
      const firstResult = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [firstTask] }));
      expect(firstResult).toHaveLength(1);
      const notifications = [
        { ruleKey: firstResult[0].ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() },
      ];

      const secondTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(21, 0).toISOString(),
        committed_at: DAY(20, 5).toISOString(),
      });

      const secondResult = evaluateRules(
        baseInput({ now: DAY(21, 0), tasks: [secondTask], notifications }),
      );

      expect(secondResult).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(secondTask),
          escalationLevel: 1,
          taskId,
        },
      ]);
    });

    it("fires L1 outside working hours when the commitment was moved back to its original time (20:00 -> 21:00 -> 20:00), even with history for the first instance", () => {
      const taskId = 6;
      const firstTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(19, 0).toISOString(),
      });
      const firstResult = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [firstTask] }));
      expect(firstResult).toHaveLength(1);
      const notifications = [
        { ruleKey: firstResult[0].ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() },
      ];

      const secondTask = makeTask({
        id: taskId,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(20, 10).toISOString(),
      });

      const secondResult = evaluateRules(
        baseInput({ now: DAY(20, 10), tasks: [secondTask], notifications }),
      );

      expect(secondResult).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(secondTask),
          escalationLevel: 1,
          taskId,
        },
      ]);
    });

    it("fires commitment_missed inside working hours while on a declared break", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(14, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const activeBreak = [makeActivityEvent({ type: "break_start", created_at: DAY(13, 55).toISOString() })];

      const result = evaluateRules(
        baseInput({ now: DAY(14, 0), tasks: [task], activityEvents: activeBreak }),
      );

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    it("fires commitment_missed outside working hours while on a declared break", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const activeBreak = [makeActivityEvent({ type: "break_start", created_at: DAY(19, 55).toISOString() })];

      const result = evaluateRules(
        baseInput({ now: DAY(20, 0), tasks: [task], activityEvents: activeBreak }),
      );

      expect(result).toEqual([
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(task),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    it("does not re-fire outside working hours while on a declared break once notification history exists (still the 1-time rule)", () => {
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const ruleKey = buildCommitmentMissedRuleKey(task);
      const notifications = [{ ruleKey, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() }];
      const activeBreak = [makeActivityEvent({ type: "break_start", created_at: DAY(19, 55).toISOString() })];

      const result = evaluateRules(
        baseInput({ now: DAY(20, 15), tasks: [task], notifications, activityEvents: activeBreak }),
      );

      expect(result).toEqual([]);
    });

    it("does not open the working-hours gate for other rules (unstarted/deadline_overdue) when commitment_missed fires outside working hours", () => {
      const taskA = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: DAY(20, 0).toISOString(),
        committed_at: DAY(9, 0).toISOString(),
      });
      const taskB = makeTask({
        id: 2,
        status: "todo",
        committed_start_at: null,
        committed_at: null,
        due_at: "2026-09-13",
      });

      const result = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [taskA, taskB] }));

      expect(result.map((r) => r.ruleType)).toContain("commitment_missed");
      expect(result.map((r) => r.ruleType)).not.toContain("unstarted");
      expect(result.map((r) => r.ruleType)).not.toContain("deadline_overdue");
    });
  });
});
