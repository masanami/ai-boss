import { describe, expect, it } from "vitest";
import { compactPlanHistory } from "./compact-plan-history.js";
import { planNudges, type DailyDetectionValues } from "./plan-nudges.js";
import { DEFAULT_DETECTION_SETTINGS, type NotificationHistoryEntry } from "../detection/detection-types.js";
import { toDateKey } from "../detection/time-utils.js";
import { makeActivityEvent, makeTask } from "../detection/detection-test-fixtures.js";
import { buildCommitmentMissedRuleKey } from "../detection/commitment-missed.js";
import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import { PLAN_SETTINGS, uniformDailyValues } from "./plan-test-fixtures.js";

interface RawPlanInput {
  now: Date;
  horizonEnd: Date;
  maxCount?: number;
  tasks: Task[];
  activityEvents: ActivityEvent[];
  notifications: NotificationHistoryEntry[];
  dailyValues?: Map<string, DailyDetectionValues>;
}

/** 圧縮前後で `planNudges` の結果が一致することを検証する（受入基準の核） */
function assertCompactionPreservesPlan(input: RawPlanInput): void {
  const dailyValues = input.dailyValues ?? uniformDailyValues(input.now, input.horizonEnd);
  const maxCount = input.maxCount ?? 1000;

  const rawPlan = planNudges({
    now: input.now,
    horizonEnd: input.horizonEnd,
    maxCount,
    tasks: input.tasks,
    activityEvents: input.activityEvents,
    notifications: input.notifications,
    settings: PLAN_SETTINGS,
    dailyValues,
  });

  const compacted = compactPlanHistory({
    now: input.now,
    tasks: input.tasks,
    activityEvents: input.activityEvents,
    notifications: input.notifications,
  });

  const compactedPlan = planNudges({
    now: input.now,
    horizonEnd: input.horizonEnd,
    maxCount,
    tasks: input.tasks,
    activityEvents: compacted.activityEvents,
    notifications: compacted.notifications,
    settings: PLAN_SETTINGS,
    dailyValues,
  });

  expect(compactedPlan.nudges).toEqual(rawPlan.nudges);
  expect(compactedPlan.truncatedAt).toEqual(rawPlan.truncatedAt);
}

describe("compactPlanHistory", () => {
  describe("plan equivalence before/after compaction", () => {
    it("keeps the in-progress task's old task_start when a more recent task_start has a null task_id (決定1の活動保持ルール)", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const horizonEnd = new Date(2026, 8, 14, 13, 0);
      const task = makeTask({ id: 1, status: "in_progress", estimated_minutes: 120 });

      const oldTaskStartForTask = makeActivityEvent({
        type: "task_start",
        task_id: 1,
        created_at: new Date(2026, 7, 1, 9, 0).toISOString(), // 40+日前、窓の外
      });
      // より新しいが task_id が無い task_start（種類ごとの最新はこちら）
      const newerTaskStartWithoutTask = makeActivityEvent({
        type: "task_start",
        task_id: null,
        created_at: new Date(2026, 7, 5, 9, 0).toISOString(), // 窓の外だが oldTaskStartForTask より新しい
      });
      // 直近の活動（無音の起点）。窓の中。
      const recentCheckin = makeActivityEvent({
        type: "checkin",
        created_at: new Date(2026, 8, 14, 11, 0).toISOString(), // now の60分前
      });

      // estimated_minutes=120, scale=0.75 → 90分（クランプ上限）にスケール
      // される。経過60分は 90分未満なので、in-progress の見積もりが正しく
      // 参照できていれば無音は発火しない。誤ってフォールバック(45分)に落ちると
      // 60分>=45分で誤発火する。
      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [oldTaskStartForTask, newerTaskStartWithoutTask, recentCheckin],
        notifications: [],
      });
    });

    it("keeps an unfinished old break so break_overrun still fires the same way", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const horizonEnd = new Date(2026, 8, 14, 13, 0);
      const oldActiveBreak = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: new Date(2026, 7, 1, 9, 0).toISOString(), // 40+日前、窓の外、break_end 無し
      });

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [],
        activityEvents: [oldActiveBreak],
        notifications: [],
      });
    });

    it("keeps the latest old break_overrun notification so escalation resumes from L3 instead of restarting at L1", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const horizonEnd = new Date(2026, 8, 14, 12, 10);
      // 休憩は40+日前に始まり、break_end無しでまだ続いている（活動はこの1件のみ）
      const oldActiveBreak = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: new Date(2026, 7, 1, 9, 0).toISOString(),
      });
      // 同じ古い休憩の最中に L3 まで到達済みの履歴（窓の外）。活動シグナルは
      // 休憩開始の1件だけで、この通知より後には無いため hasActivitySince は
      // false のまま → 圧縮で残っていれば L3 から再開し、無ければ L1 から
      // 再スタートしてしまう（区別できる境界ケース）
      const oldBreakOverrunL3: NotificationHistoryEntry = {
        ruleKey: "break_overrun",
        escalationLevel: 3,
        sentAt: new Date(2026, 7, 1, 10, 0).toISOString(),
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [],
        activityEvents: [oldActiveBreak],
        notifications: [oldBreakOverrunL3],
      });
    });

    it("keeps the latest old notification for a current incomplete task's rule_key so escalation resumes correctly", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 7, 1, 7, 0).toISOString() });
      const oldNotification: NotificationHistoryEntry = {
        ruleKey: "unstarted:1",
        escalationLevel: 1,
        sentAt: new Date(2026, 7, 1, 8, 0).toISOString(), // 40+日前、窓の外
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [],
        notifications: [oldNotification],
      });
    });

    it("keeps the latest old notification for a current incomplete task's avoidance rule_key", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 7, 1, 7, 0).toISOString() });
      // 直近（窓の中）に別タスクへの活動があり、回避判定が成立する
      const otherTaskActivity = makeActivityEvent({
        type: "task_update",
        task_id: 2,
        created_at: new Date(2026, 8, 14, 8, 50).toISOString(),
      });
      const oldAvoidanceNotification: NotificationHistoryEntry = {
        ruleKey: "avoidance:1",
        escalationLevel: 1,
        sentAt: new Date(2026, 7, 1, 8, 0).toISOString(), // 40+日前、窓の外
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [otherTaskActivity],
        notifications: [oldAvoidanceNotification],
      });
    });

    it("keeps the latest old notification for a current incomplete task's deadline_overdue rule_key", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      const task = makeTask({ id: 1, status: "todo", due_at: "2026-07-01" });
      const oldDeadlineNotification: NotificationHistoryEntry = {
        ruleKey: "deadline_overdue:1",
        escalationLevel: 1,
        sentAt: new Date(2026, 7, 2, 8, 0).toISOString(), // 40+日前、窓の外
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [],
        notifications: [oldDeadlineNotification],
      });
    });

    it("keeps the latest old notification for a current task's commitment_missed rule_key", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      const committedAt = new Date(2026, 7, 1, 6, 0).toISOString();
      const committedStartAt = new Date(2026, 7, 1, 7, 0).toISOString();
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: committedStartAt,
        committed_at: committedAt,
      });
      const oldCommitmentNotification: NotificationHistoryEntry = {
        ruleKey: buildCommitmentMissedRuleKey(task),
        escalationLevel: 1,
        sentAt: new Date(2026, 7, 1, 8, 0).toISOString(), // 40+日前、窓の外
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [],
        notifications: [oldCommitmentNotification],
      });
    });

    it("does not keep a stale commitment_missed notification for a task with no current commitment", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      // 約束を持たないタスク（committed_start_at/committed_at はどちらも null）
      const task = makeTask({ id: 1, status: "todo", committed_start_at: null, committed_at: null });
      // ガードが無いと `commitment_missed:1:null:null` のような形の rule_key
      // まで対象キーになりかねない、という退行を明示するためのテスト
      const staleNotification: NotificationHistoryEntry = {
        ruleKey: "commitment_missed:1:null:null",
        escalationLevel: 1,
        sentAt: new Date(2026, 7, 1, 8, 0).toISOString(),
      };

      const compacted = compactPlanHistory({
        now,
        tasks: [task],
        activityEvents: [],
        notifications: [staleNotification],
      });

      expect(compacted.notifications).toEqual([]);
    });

    it("keeps the latest old silence L3 entry so escalation resumes from L3", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      const lastCheckin = makeActivityEvent({
        type: "checkin",
        created_at: new Date(2026, 7, 1, 6, 0).toISOString(),
      });
      const oldSilenceL3: NotificationHistoryEntry = {
        ruleKey: "silence",
        escalationLevel: 3,
        sentAt: new Date(2026, 7, 1, 8, 0).toISOString(), // 40+日前、窓の外
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [],
        activityEvents: [lastCheckin],
        notifications: [oldSilenceL3],
      });
    });

    it("does not lose today's notifications that count toward the daily notification cap", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 10, 0);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 6, 0).toISOString() });
      // 既定の dailyNotificationCap=5 にちょうど達する当日の通知
      const todaysNotifications: NotificationHistoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
        ruleKey: "unstarted:1",
        escalationLevel: Math.min(i + 1, 3),
        sentAt: new Date(2026, 8, 14, 8, i).toISOString(),
      }));

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [],
        notifications: todaysNotifications,
      });
    });

    it("keeps an outside-hours period notification that started the previous day", () => {
      const now = new Date(2026, 8, 14, 8, 0); // まだ始業(09:00)前
      const horizonEnd = new Date(2026, 8, 14, 9, 30);
      // 前日 18:00〜今日 09:00 の帯外区間で、前日のうちに1回発火済み
      const periodNotification: NotificationHistoryEntry = {
        ruleKey: `silence:${toDateKey(new Date(2026, 8, 13))}`,
        escalationLevel: 1,
        sentAt: new Date(2026, 8, 13, 18, 0).toISOString(),
      };
      const lastCheckin = makeActivityEvent({
        type: "checkin",
        created_at: new Date(2026, 8, 13, 17, 0).toISOString(),
      });

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [],
        activityEvents: [lastCheckin],
        notifications: [periodNotification],
      });
    });

    it("matches across a full year of daily morning/evening meetings and outside-hours dated notifications", () => {
      const now = new Date(2026, 8, 14, 8, 30);
      const horizonEnd = new Date(2026, 8, 15, 8, 30);
      const dailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      const notifications: NotificationHistoryEntry[] = [];
      for (let daysAgo = 1; daysAgo <= 365; daysAgo++) {
        const day = new Date(2026, 8, 14 - daysAgo);
        notifications.push({
          ruleKey: `morning_meeting:${toDateKey(day)}@${DEFAULT_DETECTION_SETTINGS.morningMeetingTime}`,
          escalationLevel: 1,
          sentAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).toISOString(),
        });
        notifications.push({
          ruleKey: `evening_meeting:${toDateKey(day)}@${DEFAULT_DETECTION_SETTINGS.eveningMeetingTime}`,
          escalationLevel: 1,
          sentAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18, 0).toISOString(),
        });
        notifications.push({
          ruleKey: `silence:${toDateKey(day)}`,
          escalationLevel: 1,
          sentAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0).toISOString(),
        });
      }

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        maxCount: 63,
        tasks: [],
        activityEvents: [],
        notifications,
        dailyValues,
      });
    }, 20_000);
  });

  describe("retains the latest (not the oldest) entry per type/rule_key outside the window", () => {
    it("keeps the newer of two outside-window break_start events, not the older one (getActiveBreak correctness)", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const horizonEnd = new Date(2026, 8, 14, 12, 10);
      // 古い休憩A: 開始してすぐ終了済み（窓の外）
      const breakStartA = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: new Date(2026, 7, 1, 9, 0).toISOString(),
      });
      const breakEndA = makeActivityEvent({
        type: "break_end",
        created_at: new Date(2026, 7, 1, 9, 20).toISOString(),
      });
      // より新しい休憩B: breakStartA より後に始まり、break_end 無しでまだ
      // 続いている（窓の外だが breakStartA より新しい）。種類ごとの最新を
      // 正しく選べば「休憩中」、誤って古い方（breakStartA）を選ぶと
      // breakEndA が break_start より後に見えてしまい「休憩は終了済み」と
      // 誤判定する（区別できる境界ケース）
      const breakStartB = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: new Date(2026, 7, 5, 9, 0).toISOString(),
      });

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [],
        activityEvents: [breakStartA, breakEndA, breakStartB],
        notifications: [],
      });
    });

    it("keeps the newer of two outside-window notifications for the same rule_key, not the older one (escalation level correctness)", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 9, 10);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 6, 1, 7, 0).toISOString() });
      // より古い(60日前) L1 と、より新しい(40日前) L3 の両方が窓の外にある。
      // 正しく最新(L3)を残せば L3 のまま繰り返し発火し、誤って古い方(L1)を
      // 残すと L2 へ上がる発火になり、区別できる。
      const olderL1: NotificationHistoryEntry = {
        ruleKey: "unstarted:1",
        escalationLevel: 1,
        sentAt: new Date(2026, 6, 15, 8, 0).toISOString(),
      };
      const newerL3: NotificationHistoryEntry = {
        ruleKey: "unstarted:1",
        escalationLevel: 3,
        sentAt: new Date(2026, 7, 5, 8, 0).toISOString(),
      };

      assertCompactionPreservesPlan({
        now,
        horizonEnd,
        tasks: [task],
        activityEvents: [],
        notifications: [olderL1, newerL3],
      });
    });
  });

  describe("window boundary (now の前日ローカル0時)", () => {
    it("keeps an activity event exactly at the window start, even when it is not the latest of its type", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const windowStart = new Date(2026, 8, 13, 0, 0, 0, 0);
      const eventAtBoundary = makeActivityEvent({ type: "checkin", created_at: windowStart.toISOString() });
      // 同じ種類でより新しいイベントも用意し、「種類ごとの最新」経由の保持では
      // なく、窓（>= windowStart）経由で境界イベントが残ることを検証する
      const laterSameTypeEvent = makeActivityEvent({
        type: "checkin",
        created_at: new Date(2026, 8, 14, 11, 0).toISOString(),
      });

      const compacted = compactPlanHistory({
        now,
        tasks: [],
        activityEvents: [eventAtBoundary, laterSameTypeEvent],
        notifications: [],
      });

      expect(compacted.activityEvents).toContainEqual(eventAtBoundary);
    });

    it("keeps a notification exactly at the window start even for a rule_key that is not a current target key", () => {
      // 対象キー（break_overrun・silence・現在の未完了タスクのキー）ではない
      // rule_key を使うことで、「対象キーごとの最新1件」経由の保持が効かず、
      // 窓（>= windowStart）の判定だけが保持の唯一の理由になるようにする
      // （target key 経由でも残ってしまうと窓の境界そのものを検証できない）
      const now = new Date(2026, 8, 14, 12, 0);
      const windowStart = new Date(2026, 8, 13, 0, 0, 0, 0);
      const notificationAtBoundary: NotificationHistoryEntry = {
        ruleKey: "morning_meeting:2026-09-13@09:00",
        escalationLevel: 1,
        sentAt: windowStart.toISOString(),
      };

      const compacted = compactPlanHistory({
        now,
        tasks: [],
        activityEvents: [],
        notifications: [notificationAtBoundary],
      });

      expect(compacted.notifications).toContainEqual(notificationAtBoundary);
    });

    it("drops a notification just before the window start for a rule_key that is not a current target key", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const justBeforeWindowStart = new Date(2026, 8, 12, 23, 59, 59, 999);
      const notificationJustBefore: NotificationHistoryEntry = {
        ruleKey: "morning_meeting:2026-09-12@09:00",
        escalationLevel: 1,
        sentAt: justBeforeWindowStart.toISOString(),
      };

      const compacted = compactPlanHistory({
        now,
        tasks: [],
        activityEvents: [],
        notifications: [notificationJustBefore],
      });

      expect(compacted.notifications).toEqual([]);
    });
  });

  describe("bounded output size", () => {
    it("bounds the compacted activity count regardless of history length (1 day vs 1 year)", () => {
      const now = new Date(2026, 8, 14, 12, 0);

      const oneDay: ActivityEvent[] = Array.from({ length: 200 }, (_, i) =>
        makeActivityEvent({
          type: "checkin",
          created_at: new Date(2026, 8, 14, 0, i).toISOString(),
        }),
      );
      const oneYear: ActivityEvent[] = Array.from({ length: 365 }, (_, i) =>
        makeActivityEvent({
          type: "checkin",
          created_at: new Date(2026, 8, 14 - i, 0, 0).toISOString(),
        }),
      );

      const compactedOneDay = compactPlanHistory({ now, tasks: [], activityEvents: oneDay, notifications: [] });
      const compactedOneYear = compactPlanHistory({ now, tasks: [], activityEvents: oneYear, notifications: [] });

      expect(compactedOneDay.activityEvents.length).toBeLessThanOrEqual(210);
      expect(compactedOneYear.activityEvents.length).toBeLessThanOrEqual(210);
    });

    it("bounds the outside-window notification count by the number of date-less target rule_keys", () => {
      const now = new Date(2026, 8, 14, 12, 0);
      const task1 = makeTask({ id: 1, status: "todo" });
      const task2 = makeTask({ id: 2, status: "in_progress" });
      // 完了タスク: 対象キーに含まれない
      const doneTask = makeTask({ id: 3, status: "done" });

      const notifications: NotificationHistoryEntry[] = [];
      // daysAgo は 2 から開始する（daysAgo=1 は窓の中〔前日〕に入ってしまい、
      // 「窓の外で対象キーごとの最新1件だけを残す」ロジックを素通りしてしまう
      // ため、全件が確実に窓の外になるようにする）
      for (let daysAgo = 2; daysAgo <= 365; daysAgo++) {
        const day = new Date(2026, 8, 14 - daysAgo, 8, 0);
        notifications.push({ ruleKey: "silence", escalationLevel: 1, sentAt: day.toISOString() });
        notifications.push({ ruleKey: "break_overrun", escalationLevel: 1, sentAt: day.toISOString() });
        notifications.push({ ruleKey: "unstarted:1", escalationLevel: 1, sentAt: day.toISOString() });
        notifications.push({ ruleKey: "avoidance:2", escalationLevel: 1, sentAt: day.toISOString() });
        notifications.push({ ruleKey: "unstarted:3", escalationLevel: 1, sentAt: day.toISOString() });
      }

      const compacted = compactPlanHistory({
        now,
        tasks: [task1, task2, doneTask],
        activityEvents: [],
        notifications,
      });

      const windowStart = new Date(2026, 8, 13);
      const outsideWindow = compacted.notifications.filter(
        (entry) => new Date(entry.sentAt).getTime() < windowStart.getTime(),
      );
      // 対象キー: break_overrun・silence・unstarted:1・avoidance:2 の4件
      // （deadline_overdue:1・deadline_overdue:2 は該当データが無いため実際には
      // 現れない。done タスクの unstarted:3 はそもそも対象外）ちょうど4件になる
      // ことまで固定する（上限だけだと done タスクの取りこぼしを見逃す）
      expect(outsideWindow.length).toBe(4);
      expect(outsideWindow.map((e) => e.ruleKey).sort()).toEqual(
        ["avoidance:2", "break_overrun", "silence", "unstarted:1"].sort(),
      );
    });
  });
});
