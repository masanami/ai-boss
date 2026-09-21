import { describe, expect, it } from "vitest";
import { evaluateRules } from "./rule-engine.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  type DetectionInput,
  type FiringNotification,
  type NotificationHistoryEntry,
} from "./detection-types.js";
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

  it("keeps suppressing every rule except break_overrun while on break outside working hours (#550)", () => {
    // 帯の外でも休憩ゲートは変わらない: 締切超過のタスクがあっても休憩中は
    // break_overrun だけが（帯の外の 1 回だけの形で）発火する。
    const overdueTask = makeTask({ id: 1, status: "todo", due_at: "2026-07-04" });
    const activeBreak = makeActivityEvent({
      type: "break_start",
      expected_minutes: 15,
      created_at: new Date(2026, 6, 5, 19, 0).toISOString(),
    });

    const result = evaluateRules(
      baseInput({
        now: new Date(2026, 6, 5, 20, 0),
        tasks: [overdueTask],
        activityEvents: [activeBreak],
      }),
    );

    expect(result).toEqual([
      {
        ruleType: "break_overrun",
        ruleKey: "break_overrun:2026-07-05",
        escalationLevel: 1,
        taskId: null,
      },
    ]);
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

  // AC-16: 暦日 D を締切とするタスクの deadline_overdue が D 当日には発火しない
  // こと（ADR 0010）。締切超過の条件成立は D+1 00:00。当初は勤務時間帯
  // [09:00, 18:00) の外でゲートが閉じ、最初の催促は D+1 の始業だったが、#550
  // （S2）以降は帯の外でも暦日ごとに 1 回だけ L1 で発火し、始業からは従来どおり
  // エスカレーションする。
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

    // (b) 締切超過は成立しているが始業前（勤務時間帯の外）。#550（S2）以降は
    // 帯の外でも帯外区間（終業〜翌始業）ごとに 1 回だけ L1 で発火する（機能仕様
    // docs/features/working-hours-intervals.md 決定 9・10）。D+1 08:00 は D の
    // 終業から始まった区間に属するので、rule_key の日付は D（7/5）になる。
    it("fires once at level 1 with a period-scoped rule_key after the deadline lapses but before working hours begin (#550)", () => {
      expect(deadlineFirings(new Date(2026, 6, 6, 8))).toEqual([
        {
          ruleType: "deadline_overdue",
          ruleKey: "deadline_overdue:1:2026-07-05",
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });

    // (c) 勤務時間帯での最初の発火（帯の中の rule_key は暦日を含まない）。
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
      // 休憩は申告時間内（30 分）に留め、#550 以降は帯の外でも鳴る break_overrun を混ぜない
      const activeBreak = [
        makeActivityEvent({ type: "break_start", expected_minutes: 30, created_at: DAY(19, 55).toISOString() }),
      ];

      const result = evaluateRules(
        baseInput({ now: DAY(20, 15), tasks: [task], notifications, activityEvents: activeBreak }),
      );

      expect(result).toEqual([]);
    });

    // #550（S2）以降、帯の外では他のルールも暦日ごとに 1 回だけ発火する。
    // commitment_missed はそれと独立に、暦日を含まない約束ごとの rule_key で鳴る。
    it("fires commitment_missed alongside the other rules outside working hours, each once at level 1 (#550)", () => {
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

      expect(result).toEqual([
        { ruleType: "unstarted", ruleKey: "unstarted:2:2026-09-14", escalationLevel: 1, taskId: 2 },
        {
          ruleType: "deadline_overdue",
          ruleKey: "deadline_overdue:2:2026-09-14",
          escalationLevel: 1,
          taskId: 2,
        },
        {
          ruleType: "commitment_missed",
          ruleKey: buildCommitmentMissedRuleKey(taskA),
          escalationLevel: 1,
          taskId: 1,
        },
      ]);
    });
  });
});

// 機能仕様 docs/features/working-hours-intervals.md スライス S2（Issue #550・
// 決定 9・10）。勤務時間帯ゲート下の 5 ルールは、帯の外では resolveEscalation を
// 通さず、rule_key に帯外区間（終業〜翌始業）の開始日（ローカル暦日）を足して
// 区間ごとに 1 回だけ L1 で発火する（0 時をまたいでも同じ区間）。
// 固定時刻はすべて new Date(2026, 8, D, h, min) 由来のローカル日時（ADR 0007
// 決定 5。既定の勤務時間帯 09:00-18:00・エスカレーション間隔 15/10/10 分）。
describe("evaluateRules outside working hours (Issue #550 S2)", () => {
  const DAY_KEY = "2026-09-14";
  const NEXT_DAY_KEY = "2026-09-15";
  const DAY = (h: number, min: number) => new Date(2026, 8, 14, h, min);
  const NEXT_DAY = (h: number, min: number) => new Date(2026, 8, 15, h, min);

  // silence: 最後の活動（D 17:00）から既定の 45 分で成立し、以後ずっと成立。
  const lastCheckin = makeActivityEvent({ type: "checkin", created_at: DAY(17, 0).toISOString() });
  // unstarted: 見積もり無し（既定 60 分）の todo タスクが D 08:00 作成で、以後ずっと成立。
  const unstartedTask = makeTask({ id: 1, status: "todo", created_at: DAY(8, 0).toISOString() });

  function history(firings: FiringNotification[], at: Date): NotificationHistoryEntry[] {
    return firings.map((f) => ({
      ruleKey: f.ruleKey,
      escalationLevel: f.escalationLevel,
      sentAt: at.toISOString(),
    }));
  }

  /**
   * from から to（排他）まで毎分評価し、各 tick の発火を通知履歴へ積み上げる。
   * activityAt の時刻に達したら、その時点で活動シグナル（checkin）を追加する。
   */
  function sweep(
    from: Date,
    to: Date,
    input: Partial<DetectionInput>,
    activityAt: Date[] = [],
  ): { at: Date; firing: FiringNotification }[] {
    const notifications = [...(input.notifications ?? [])];
    const activityEvents = [...(input.activityEvents ?? [])];
    const fired: { at: Date; firing: FiringNotification }[] = [];
    for (let t = from; t < to; t = new Date(t.getTime() + 60_000)) {
      for (const a of activityAt) {
        if (a.getTime() === t.getTime()) {
          activityEvents.push(makeActivityEvent({ type: "checkin", created_at: t.toISOString() }));
        }
      }
      const result = evaluateRules(
        baseInput({ ...input, now: t, notifications: [...notifications], activityEvents: [...activityEvents] }),
      );
      notifications.push(...history(result, t));
      fired.push(...result.map((firing) => ({ at: t, firing })));
    }
    return fired;
  }

  function firingsOf(fired: { at: Date; firing: FiringNotification }[], ruleType: string) {
    return fired.filter((f) => f.firing.ruleType === ruleType);
  }

  describe("fires outside working hours", () => {
    it("fires silence at level 1 at 20:00 with an empty notification history", () => {
      const result = evaluateRules(baseInput({ now: DAY(20, 0), activityEvents: [lastCheckin] }));

      expect(result).toEqual([
        { ruleType: "silence", ruleKey: `silence:${DAY_KEY}`, escalationLevel: 1, taskId: null },
      ]);
    });

    it("fires unstarted at level 1 at 20:00 with an empty notification history", () => {
      const result = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [unstartedTask] }));

      expect(result).toEqual([
        { ruleType: "unstarted", ruleKey: `unstarted:1:${DAY_KEY}`, escalationLevel: 1, taskId: 1 },
      ]);
    });

    it("fires avoidance at level 1 at 20:00 when the top task is avoided", () => {
      const otherTaskActivity = makeActivityEvent({
        type: "task_update",
        task_id: 2,
        created_at: DAY(19, 50).toISOString(),
      });

      const result = evaluateRules(
        baseInput({ now: DAY(20, 0), tasks: [unstartedTask], activityEvents: [otherTaskActivity] }),
      );

      expect(result).toEqual([
        { ruleType: "avoidance", ruleKey: `avoidance:1:${DAY_KEY}`, escalationLevel: 1, taskId: 1 },
      ]);
    });

    it("fires deadline_overdue at level 1 once per overdue task at 20:00", () => {
      const first = makeTask({ id: 11, status: "in_progress", due_at: "2026-09-12" });
      const second = makeTask({ id: 12, status: "in_progress", due_at: "2026-09-13" });

      const result = evaluateRules(baseInput({ now: DAY(20, 0), tasks: [first, second] }));

      expect(result).toEqual([
        {
          ruleType: "deadline_overdue",
          ruleKey: `deadline_overdue:11:${DAY_KEY}`,
          escalationLevel: 1,
          taskId: 11,
        },
        {
          ruleType: "deadline_overdue",
          ruleKey: `deadline_overdue:12:${DAY_KEY}`,
          escalationLevel: 1,
          taskId: 12,
        },
      ]);
    });

    it("fires break_overrun at level 1 at 20:00 when the declared break is overrun", () => {
      const activeBreak = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: DAY(19, 30).toISOString(),
      });

      const result = evaluateRules(baseInput({ now: DAY(20, 0), activityEvents: [activeBreak] }));

      expect(result).toEqual([
        { ruleType: "break_overrun", ruleKey: `break_overrun:${DAY_KEY}`, escalationLevel: 1, taskId: null },
      ]);
    });
  });

  describe("fires only once per outside-working-hours period (end of work → next start of work)", () => {
    // 18:00 から翌 09:00 の直前（帯の外の最後の分 08:59）まで毎分評価する。
    const overnight = () =>
      sweep(DAY(18, 0), NEXT_DAY(9, 0), { tasks: [unstartedTask], activityEvents: [lastCheckin] });

    it("fires silence exactly once across an 18:00 → 09:00 per-minute sweep (no extra firing at midnight)", () => {
      const fired = overnight();

      expect(firingsOf(fired, "silence")).toEqual([
        {
          at: DAY(18, 0),
          firing: { ruleType: "silence", ruleKey: `silence:${DAY_KEY}`, escalationLevel: 1, taskId: null },
        },
      ]);
    });

    it("fires unstarted exactly once across the same sweep", () => {
      const fired = overnight();

      expect(firingsOf(fired, "unstarted").map((f) => [f.at, f.firing.ruleKey])).toEqual([
        [DAY(18, 0), `unstarted:1:${DAY_KEY}`],
      ]);
    });

    it("does not fire again when the local date changes from 23:59 to 00:00 within the same period", () => {
      // 前夜 18:00 に鳴った履歴だけがある状態で、0 時の前後と始業直前を評価する。
      const notifications = [
        { ruleKey: `silence:${DAY_KEY}`, escalationLevel: 1, sentAt: DAY(18, 0).toISOString() },
      ];

      for (const now of [DAY(23, 59), NEXT_DAY(0, 0), NEXT_DAY(8, 59)]) {
        expect(evaluateRules(baseInput({ now, activityEvents: [lastCheckin], notifications }))).toEqual([]);
      }
    });

    it("keys a pre-start-of-work time to the period that began the previous day, and an after-end-of-work time to the same day", () => {
      // work_start <= work_end が保証されているため、帯の外は「当日の終業以降」
      // か「当日の始業前」の 2 通りしかない。境界の分（18:00 と 08:59）で確かめる。
      const at = (now: Date) =>
        evaluateRules(baseInput({ now, activityEvents: [lastCheckin] })).map((r) => r.ruleKey);

      expect(at(DAY(18, 0))).toEqual([`silence:${DAY_KEY}`]);
      expect(at(NEXT_DAY(8, 59))).toEqual([`silence:${DAY_KEY}`]);
      expect(at(NEXT_DAY(0, 0))).toEqual([`silence:${DAY_KEY}`]);
    });

    it("never escalates beyond level 1 outside working hours", () => {
      const fired = overnight();

      expect(fired.length).toBeGreaterThan(0);
      expect(fired.every((f) => f.firing.escalationLevel === 1)).toBe(true);
    });

    it("does not re-fire the same rule_key on the same day after an activity signal is recorded", () => {
      // 20:00 に silence が鳴り、20:30 の活動で無音が解消し、21:15 に再び無音が成立する。
      // 帯の中なら活動で L1 へリセットされて再発火するが、帯の外では同じ区間のうちは鳴らない。
      const fired = sweep(DAY(20, 0), DAY(23, 59), { activityEvents: [lastCheckin] }, [DAY(20, 30)]);

      expect(fired.map((f) => f.firing)).toEqual([
        { ruleType: "silence", ruleKey: `silence:${DAY_KEY}`, escalationLevel: 1, taskId: null },
      ]);
    });

    it("stays at level 1 even after the escalation intervals elapse", () => {
      const notifications = [
        { ruleKey: `unstarted:1:${DAY_KEY}`, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() },
      ];

      for (const now of [DAY(20, 15), DAY(20, 30), DAY(23, 0)]) {
        expect(evaluateRules(baseInput({ now, tasks: [unstartedTask], notifications }))).toEqual([]);
      }
    });
  });

  describe("keeps the in-hours behavior unchanged", () => {
    it("escalates L1 → L2 → L3 inside working hours via resolveEscalation", () => {
      const fired = sweep(DAY(13, 0), DAY(13, 26), { tasks: [unstartedTask] });

      expect(fired.map((f) => [f.at, f.firing.ruleKey, f.firing.escalationLevel])).toEqual([
        [DAY(13, 0), "unstarted:1", 1],
        [DAY(13, 15), "unstarted:1", 2],
        [DAY(13, 25), "unstarted:1", 3],
      ]);
    });

    it("resets to level 1 on an activity signal inside working hours", () => {
      const lunchCheckin = makeActivityEvent({ type: "checkin", created_at: DAY(12, 0).toISOString() });
      // 12:45 に L1、13:00 に L2。13:05 の活動で解消し、13:50 に再び無音 → L1 へリセット。
      const fired = sweep(DAY(12, 45), DAY(13, 51), { activityEvents: [lunchCheckin] }, [DAY(13, 5)]);

      expect(fired.map((f) => [f.at, f.firing.ruleKey, f.firing.escalationLevel])).toEqual([
        [DAY(12, 45), "silence", 1],
        [DAY(13, 0), "silence", 2],
        [DAY(13, 50), "silence", 1],
      ]);
    });

    it("escalates normally once working hours begin after an out-of-hours firing", () => {
      const fired = sweep(NEXT_DAY(8, 0), NEXT_DAY(9, 26), { tasks: [unstartedTask] });

      expect(fired.map((f) => [f.at, f.firing.ruleKey, f.firing.escalationLevel])).toEqual([
        [NEXT_DAY(8, 0), `unstarted:1:${DAY_KEY}`, 1],
        [NEXT_DAY(9, 0), "unstarted:1", 1],
        [NEXT_DAY(9, 15), "unstarted:1", 2],
        [NEXT_DAY(9, 25), "unstarted:1", 3],
      ]);
    });
  });

  describe("resets the once-per-period allowance in the next outside-working-hours period", () => {
    it("fires silence outside working hours again in the next day's period after it fired", () => {
      const notifications = [
        { ruleKey: `silence:${DAY_KEY}`, escalationLevel: 1, sentAt: DAY(20, 0).toISOString() },
      ];

      const samePeriod = evaluateRules(
        baseInput({ now: NEXT_DAY(8, 59), activityEvents: [lastCheckin], notifications }),
      );
      const nextPeriod = evaluateRules(
        baseInput({ now: NEXT_DAY(20, 0), activityEvents: [lastCheckin], notifications }),
      );

      expect(samePeriod).toEqual([]);
      expect(nextPeriod).toEqual([
        { ruleType: "silence", ruleKey: `silence:${NEXT_DAY_KEY}`, escalationLevel: 1, taskId: null },
      ]);
    });

    it("fires silence outside working hours once per period across two consecutive nights (per-minute sweep)", () => {
      // D 18:00 → D+2 09:00 を毎分評価する（間の D+1 の勤務時間帯も含む）。帯外の
      // 発火（区間の日付付き rule_key）は各夜の終業直後の 1 回ずつだけで、0 時には増えない。
      const DAY_AFTER_NEXT = (h: number, min: number) => new Date(2026, 8, 16, h, min);
      const fired = sweep(DAY(18, 0), DAY_AFTER_NEXT(9, 0), { activityEvents: [lastCheckin] });

      expect(
        firingsOf(fired, "silence")
          .filter((f) => f.firing.ruleKey !== "silence")
          .map((f) => [f.at, f.firing.ruleKey]),
      ).toEqual([
        [DAY(18, 0), `silence:${DAY_KEY}`],
        [NEXT_DAY(18, 0), `silence:${NEXT_DAY_KEY}`],
      ]);
    });
  });

  describe("does not change the firing conditions themselves", () => {
    it("does not fire silence outside working hours when there is no activity signal at all", () => {
      expect(evaluateRules(baseInput({ now: DAY(20, 0) }))).toEqual([]);
    });

    it("does not fire any gated rule outside working hours when no condition holds", () => {
      const freshTask = makeTask({ id: 2, status: "todo", created_at: DAY(19, 30).toISOString() });
      const recentCheckin = makeActivityEvent({ type: "checkin", created_at: DAY(19, 50).toISOString() });

      expect(
        evaluateRules(baseInput({ now: DAY(20, 0), tasks: [freshTask], activityEvents: [recentCheckin] })),
      ).toEqual([]);
    });
  });
});
