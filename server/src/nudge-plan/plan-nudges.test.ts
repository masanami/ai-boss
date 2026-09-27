import { describe, expect, it } from "vitest";
import { planNudges, type DailyDetectionValues, type PlannedNudge } from "./plan-nudges.js";
import { evaluateRules } from "../detection/rule-engine.js";
import type { DetectionSettings, FiringNotification, NotificationHistoryEntry } from "../detection/detection-types.js";
import { toDateKey } from "../detection/time-utils.js";
import { makeActivityEvent, makeTask } from "../detection/detection-test-fixtures.js";
import { buildCommitmentMissedRuleKey } from "../detection/commitment-missed.js";
import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import { PLAN_SETTINGS, DEFAULT_DAILY, uniformDailyValues } from "./plan-test-fixtures.js";

interface SweepInput {
  tasks?: Task[];
  activityEvents?: ActivityEvent[];
  notifications?: NotificationHistoryEntry[];
  settings?: Omit<DetectionSettings, "morningMeetingTime" | "eveningMeetingTime">;
  dailyValues: Map<string, DailyDetectionValues>;
}

/**
 * 次の刻み: `after` が分境界ちょうどなら `after + 60秒`、そうでなければ
 * `after` より後の直近の分境界（機能仕様 仮定 A2）。`planNudges` 本体
 * （`nextMinuteBoundary`。エポックミリ秒を60,000で割って切り捨てる算術）とは
 * 別の組み立て方であえて書く: ローカルの秒・ミリ秒を0へ落として「次の分」へ
 * 1分足す（フィールド単位の構成）。実装側のエポックミリ秒の算術に同じ間違いが
 * あっても、このオラクルは別経路で計算するため共有しない。
 */
function nextTick(after: Date): Date {
  const truncatedToMinute = new Date(
    after.getFullYear(),
    after.getMonth(),
    after.getDate(),
    after.getHours(),
    after.getMinutes(),
    0,
    0,
  );
  const next = new Date(truncatedToMinute.getTime() + 60_000);
  // フィールド単位の組み立ては、秒への夏時間の巻き戻し（fall-back）の時間帯を
  // 跨ぐと `next <= after` になりうる（同じローカル時・分が2回出現するため）。
  // その場合 sweep の `for (...; t < toExclusive; t = nextTick(t))` が無限
  // ループするため、黙って進めず失敗させる（現状のテストは対象の時間帯を
  // 跨がないため到達しないが、将来DSTを跨ぐケースを足したときの安全策）。
  if (next.getTime() <= after.getTime()) {
    throw new Error(
      `nextTick: 夏時間の巻き戻しにより ${after.toISOString()} の次の刻みが後退した（${next.toISOString()}）。このオラクルは DST 巻き戻しの時間帯を跨ぐ入力に対応していない`,
    );
  }
  return next;
}

/**
 * オラクル: `rule-engine.test.ts` の `sweep` と同じ形（1 分刻みで evaluateRules を
 * 呼び、発火を仮の履歴として積みながら進める）で、`planNudges` の結果と
 * 独立に組んだ参照実装。dailyValues を暦日ごとに差し替える点だけが違う。
 */
function sweep(
  from: Date,
  toExclusive: Date,
  input: SweepInput,
): { at: Date; firing: FiringNotification }[] {
  const notifications = [...(input.notifications ?? [])];
  const tasks = input.tasks ?? [];
  const activityEvents = input.activityEvents ?? [];
  const settings = input.settings ?? PLAN_SETTINGS;
  const fired: { at: Date; firing: FiringNotification }[] = [];

  for (let t = from; t < toExclusive; t = nextTick(t)) {
    const daily = input.dailyValues.get(toDateKey(t));
    if (!daily) throw new Error(`sweep: dailyValues に ${toDateKey(t)} が無い`);
    const result = evaluateRules({
      now: t,
      tasks,
      activityEvents,
      notifications: [...notifications],
      settings: {
        ...settings,
        morningMeetingTime: daily.morningMeetingTime,
        eveningMeetingTime: daily.eveningMeetingTime,
      },
      todaysSessionTypes: daily.sessionTypes,
    });
    notifications.push(
      ...result.map((f) => ({ ruleKey: f.ruleKey, escalationLevel: f.escalationLevel, sentAt: t.toISOString() })),
    );
    fired.push(...result.map((firing) => ({ at: t, firing })));
  }
  return fired;
}

function toPlannedNudges(fired: { at: Date; firing: FiringNotification }[]): PlannedNudge[] {
  return fired.map(({ at, firing }) => ({ ...firing, scheduledAt: at }));
}

describe("planNudges", () => {
  describe("matches the per-minute sweep oracle", () => {
    it("matches for a top-priority unstarted task escalating L1 -> L2 -> L3 -> L3 repeat", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      // 見積もり無し（既定閾値60分）のタスクが 08:01 作成 → now (09:00) 時点では
      // 59分しか経っておらずまだ未発火。09:01 でちょうど60分に達しL1が立つ。
      const horizonEnd = new Date(2026, 8, 14, 9, 50);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 8, 1).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { tasks: [task], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      // 具体値を固定: 09:01 に L1、以後 15分 (09:16 L2) → 10分 (09:26 L3) →
      // 10分ごとに L3 を繰り返す。既定の dailyNotificationCap=5 に達する
      // 09:46 の L3 で打ち止め（同じ rule_key の 5 件目）になる
      expect(plan.nudges.map((n) => [n.scheduledAt.getTime(), n.ruleKey, n.escalationLevel])).toEqual([
        [new Date(2026, 8, 14, 9, 1).getTime(), "unstarted:1", 1],
        [new Date(2026, 8, 14, 9, 16).getTime(), "unstarted:1", 2],
        [new Date(2026, 8, 14, 9, 26).getTime(), "unstarted:1", 3],
        [new Date(2026, 8, 14, 9, 36).getTime(), "unstarted:1", 3],
        [new Date(2026, 8, 14, 9, 46).getTime(), "unstarted:1", 3],
      ]);
    });

    it("matches for silence", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 12, 0);
      const lastCheckin = makeActivityEvent({ type: "checkin", created_at: new Date(2026, 8, 14, 8, 0).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { activityEvents: [lastCheckin], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [lastCheckin],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      expect(plan.nudges.length).toBeGreaterThan(0);
    });

    it("matches for morning and evening meetings due", () => {
      const now = new Date(2026, 8, 14, 8, 30);
      const horizonEnd = new Date(2026, 8, 14, 19, 0);
      const dailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      expect(plan.nudges.some((n) => n.ruleType === "morning_meeting")).toBe(true);
      expect(plan.nudges.some((n) => n.ruleType === "evening_meeting")).toBe(true);
    });

    it("matches for a single outside-working-hours firing", () => {
      const now = new Date(2026, 8, 14, 19, 0);
      const horizonEnd = new Date(2026, 8, 14, 20, 0);
      const lastCheckin = makeActivityEvent({ type: "checkin", created_at: new Date(2026, 8, 14, 17, 0).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { activityEvents: [lastCheckin], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [lastCheckin],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      // 帯の外は区間ごとに1回だけ（サイレンスの繰り返しが起きない）
      expect(plan.nudges.filter((n) => n.ruleType === "silence")).toHaveLength(1);
    });

    it("matches for a task-start commitment missed", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 11, 0);
      const task = makeTask({
        id: 1,
        status: "todo",
        committed_start_at: new Date(2026, 8, 14, 9, 0).toISOString(),
        committed_at: new Date(2026, 8, 14, 8, 0).toISOString(),
      });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { tasks: [task], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      expect(plan.nudges.every((n) => n.ruleKey === buildCommitmentMissedRuleKey(task))).toBe(true);
    });

    it("matches when the daily notification cap is reached", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 14, 12, 0);
      const overdueTask = makeTask({ id: 1, status: "todo", due_at: "2026-09-13" });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { tasks: [overdueTask], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [overdueTask],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      // 既定の dailyNotificationCap=5 に達して打ち止めになっていることを確認
      expect(plan.nudges.filter((n) => n.ruleType === "deadline_overdue")).toHaveLength(5);
    });

    it("matches when now is not on a minute boundary", () => {
      const now = new Date(2026, 8, 14, 9, 0, 30);
      const horizonEnd = new Date(2026, 8, 14, 11, 0, 0);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 7, 0).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd);

      const oracle = toPlannedNudges(sweep(now, horizonEnd, { tasks: [task], dailyValues }));
      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges).toEqual(oracle);
      // 具体値を固定: 最初の刻みは now 自身（9:00:30、分境界へ丸めない）。
      // 2 回目以降は実際の分境界（9:01:00, 9:02:00, ...）に揃う——
      // 「9:00:30 から単純に60秒ずつ足す」（9:01:30, 9:02:30, ...）にはならない
      // ことを、最初の刻み以降のタイミングでも固定する（オラクルの1回目の
      // 刻みだけの一致では見えない、2回目以降の境界揃えの誤りを検出する）
      expect(plan.nudges.map((n) => [n.scheduledAt.getTime(), n.escalationLevel])).toEqual([
        [new Date(2026, 8, 14, 9, 0, 30).getTime(), 1],
        [new Date(2026, 8, 14, 9, 16, 0).getTime(), 2],
        [new Date(2026, 8, 14, 9, 26, 0).getTime(), 3],
        [new Date(2026, 8, 14, 9, 36, 0).getTime(), 3],
        [new Date(2026, 8, 14, 9, 46, 0).getTime(), 3],
      ]);
    });
  });

  describe("calendar day boundary", () => {
    it("still schedules tomorrow's morning meeting even if today's was already held", () => {
      const now = new Date(2026, 8, 14, 20, 0);
      const horizonEnd = new Date(2026, 8, 15, 20, 0);
      const dailyValues = new Map<string, DailyDetectionValues>([
        ["2026-09-14", { ...DEFAULT_DAILY, sessionTypes: ["morning", "evening"] }],
        ["2026-09-15", { ...DEFAULT_DAILY, sessionTypes: [] }],
      ]);

      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      const tomorrowMorning = plan.nudges.find(
        (n) => n.ruleType === "morning_meeting" && n.ruleKey.startsWith("morning_meeting:2026-09-15"),
      );
      expect(tomorrowMorning).toBeDefined();
      expect(tomorrowMorning?.scheduledAt).toEqual(new Date(2026, 8, 15, 9, 0));
    });

    it("uses tomorrow's steady-state meeting time, not today's one-off override", () => {
      const now = new Date(2026, 8, 14, 6, 0);
      const horizonEnd = new Date(2026, 8, 15, 12, 0);
      const dailyValues = new Map<string, DailyDetectionValues>([
        ["2026-09-14", { morningMeetingTime: "11:00", eveningMeetingTime: "18:00", sessionTypes: [] }],
        ["2026-09-15", { morningMeetingTime: "09:00", eveningMeetingTime: "18:00", sessionTypes: [] }],
      ]);

      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      const todayMorning = plan.nudges.find(
        (n) => n.ruleType === "morning_meeting" && n.ruleKey.startsWith("morning_meeting:2026-09-14"),
      );
      const tomorrowMorning = plan.nudges.find(
        (n) => n.ruleType === "morning_meeting" && n.ruleKey.startsWith("morning_meeting:2026-09-15"),
      );
      expect(todayMorning?.scheduledAt).toEqual(new Date(2026, 8, 14, 11, 0));
      expect(todayMorning?.ruleKey).toBe("morning_meeting:2026-09-14@11:00");
      expect(tomorrowMorning?.scheduledAt).toEqual(new Date(2026, 8, 15, 9, 0));
      expect(tomorrowMorning?.ruleKey).toBe("morning_meeting:2026-09-15@09:00");
    });

    it("throws when a calendar day within the horizon is missing from dailyValues", () => {
      const now = new Date(2026, 8, 14, 20, 0);
      const horizonEnd = new Date(2026, 8, 15, 20, 0);
      // 15日分が無い
      const dailyValues = new Map<string, DailyDetectionValues>([["2026-09-14", DEFAULT_DAILY]]);

      expect(() =>
        planNudges({
          now,
          horizonEnd,
          maxCount: 1000,
          tasks: [],
          activityEvents: [],
          notifications: [],
          settings: PLAN_SETTINGS,
          dailyValues,
        }),
      ).toThrow(/dailyValues に地平線内の暦日 2026-09-15 の値が無い/);
    });

    it("throws for a missing calendar day even when maxCount would truncate the plan on the very first tick (before that day is ever reached)", () => {
      // 地平線は2暦日にまたがるが、maxCount=1・最初の刻み（帯の外）で
      // unstarted → silence → ... の順に2件以上同時発火することで、
      // 最初の刻みのうちに打ち切りの早期 return が起こり、ループは翌日
      // （欠けている暦日）へ一切到達しない入力にする（具体的に何件・どの
      // ルールが同時発火するかは以下の前提確認で直接検証し、ここでは
      // コメントとして数を断定しない）。「打ち切りで実際には参照されない
      // 暦日」であっても、事前検証は打ち切りの有無を先読みせず例外を投げる
      // （「計算前」の契約）。
      const now = new Date(2026, 8, 14, 20, 0);
      const horizonEnd = new Date(2026, 8, 15, 20, 0);
      const lastCheckin = makeActivityEvent({
        type: "checkin",
        created_at: new Date(2026, 8, 14, 17, 0).toISOString(),
      });
      const overdueTask = makeTask({ id: 1, status: "todo", due_at: "2026-09-13" });
      const completeDailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      // 前提確認: 翌日分の dailyValues を欠かさずに与えた場合、
      // maxCount=1 は最初の刻み（now そのもの）のうちに打ち切られる
      // （＝翌日へは一切進まないまま return する入力であることを、欠落を
      // 混ぜずに直接示す）
      const controlPlan = planNudges({
        now,
        horizonEnd,
        maxCount: 1,
        tasks: [overdueTask],
        activityEvents: [lastCheckin],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues: completeDailyValues,
      });
      expect(controlPlan.nudges).toHaveLength(1);
      expect(controlPlan.truncatedAt).toEqual(now);

      // 本題: 上と同じ入力から翌日分の dailyValues だけを欠かせても、
      // （欠落が一度も参照されないはずにもかかわらず）事前検証により
      // 例外が出る
      const incompleteDailyValues = new Map<string, DailyDetectionValues>([
        ["2026-09-14", completeDailyValues.get("2026-09-14")!],
      ]);
      expect(() =>
        planNudges({
          now,
          horizonEnd,
          maxCount: 1,
          tasks: [overdueTask],
          activityEvents: [lastCheckin],
          notifications: [],
          settings: PLAN_SETTINGS,
          dailyValues: incompleteDailyValues,
        }),
      ).toThrow(/dailyValues に地平線内の暦日 2026-09-15 の値が無い/);
    });

    it("does not require dailyValues when horizonEnd equals now (empty range)", () => {
      const now = new Date(2026, 8, 14, 20, 0);
      const dailyValues = new Map<string, DailyDetectionValues>(); // 空。now の暦日すら無い

      const plan = planNudges({
        now,
        horizonEnd: now,
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan).toEqual({ nudges: [], truncatedAt: null });
    });
  });

  describe("horizon boundary", () => {
    it("does not include a firing that would occur exactly at horizonEnd", () => {
      // 朝会が地平線の終わりちょうど（12:00）に発火する状況を作る
      const now = new Date(2026, 8, 14, 11, 58);
      const horizonEnd = new Date(2026, 8, 14, 12, 0);
      const dailyValues = uniformDailyValues(now, new Date(2026, 8, 14, 12, 1), {
        morningMeetingTime: "12:00",
        sessionTypes: [],
      });

      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(plan.nudges.every((n) => n.scheduledAt < horizonEnd)).toBe(true);
      expect(plan.nudges.some((n) => n.ruleType === "morning_meeting")).toBe(false);

      // 1分後ろへ地平線を伸ばすと、ちょうど 12:00 の朝会が含まれる
      const extendedPlan = planNudges({
        now,
        horizonEnd: new Date(2026, 8, 14, 12, 1),
        maxCount: 1000,
        tasks: [],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });
      expect(extendedPlan.nudges.some((n) => n.ruleType === "morning_meeting")).toBe(true);
    });
  });

  describe("maxCount", () => {
    it("returns at most maxCount nudges", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 15, 9, 0);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 7, 0).toISOString() });
      const overdueTask = makeTask({ id: 2, status: "todo", due_at: "2026-09-13" });
      const dailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      const plan = planNudges({
        now,
        horizonEnd,
        maxCount: 10,
        tasks: [task, overdueTask],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      // 上限ちょうどまで返り、打ち切りが実際に起きたことまで固定する
      // （toBeLessThanOrEqual だけだと空配列を返す実装でも通ってしまう）
      expect(plan.nudges).toHaveLength(10);
      expect(plan.truncatedAt).not.toBeNull();
    });

    it("truncates at the earliest firings and reports the timestamp of the first firing that did not fit", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 15, 9, 0);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 7, 0).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      const full = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      const maxCount = 3;
      const truncated = planNudges({
        now,
        horizonEnd,
        maxCount,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(truncated.nudges).toEqual(full.nudges.slice(0, maxCount));
      expect(truncated.truncatedAt).toEqual(full.nudges[maxCount]?.scheduledAt ?? null);
      expect(truncated.truncatedAt).not.toBeNull();
    });

    it("returns truncatedAt: null when every firing within the horizon fits exactly at the limit", () => {
      const now = new Date(2026, 8, 14, 9, 0);
      const horizonEnd = new Date(2026, 8, 15, 9, 0);
      const task = makeTask({ id: 1, status: "todo", created_at: new Date(2026, 8, 14, 7, 0).toISOString() });
      const dailyValues = uniformDailyValues(now, horizonEnd, { sessionTypes: [] });

      const full = planNudges({
        now,
        horizonEnd,
        maxCount: 1000,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      const exact = planNudges({
        now,
        horizonEnd,
        maxCount: full.nudges.length,
        tasks: [task],
        activityEvents: [],
        notifications: [],
        settings: PLAN_SETTINGS,
        dailyValues,
      });

      expect(exact.nudges).toEqual(full.nudges);
      expect(exact.truncatedAt).toBeNull();
    });
  });
});
