import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { evaluateRules } from "./rule-engine.js";
import { DEFAULT_DETECTION_SETTINGS, type DetectionInput } from "./detection-types.js";
import { makeActivityEvent, makeTask } from "./detection-test-fixtures.js";
import { toDateKey } from "./time-utils.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { loadDetectionSettings } from "../scheduler/detection-settings.js";

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

  // AC-10 (#483, 親要件 #448): DB に既に work_start >= work_end の不正な組が
  // 保存されている状態でも、#482 の読み出し側ガード（loadDetectionSettings）
  // を経由した設定を渡せば、稼働時間ゲート下の 5 ルール（unstarted /
  // avoidance / break_overrun / silence / deadline_overdue）が評価される
  // （検知が全停止しない）ことを確認する。
  //
  // PUT /api/settings 経由では #480/#481 のバリデータに弾かれてこの状態を
  // 作れないため、settings テーブルへ直接 INSERT して再現する
  // （detection-settings.test.ts の putSetting と同じ手法）。
  //
  // 固定時刻は new Date(y, m, d, h, m) 由来のローカル日時から導出し
  // （AC-11、ADR 0007 決定 5）、活動イベント・締切もそこから相対的に導く。
  describe("AC-10: rules are evaluated under a corrupted working-hours pair (via loadDetectionSettings guard)", () => {
    let db: Database.Database;

    // 2026-09-10 13:00（ローカル）。#482 のガードが効いた後の既定稼働時間
    // 09:00-18:00 の内側に置く。
    const NOW = new Date(2026, 8, 10, 13, 0);
    // NOW の暦日の前日（締切超過を成立させるため）。ハードコードした日付
    // 文字列ではなく NOW から相対的に導く。
    const YESTERDAY_DUE_DATE = toDateKey(new Date(2026, 8, 9));

    function isoMinutesBefore(base: Date, minutes: number): string {
      return new Date(base.getTime() - minutes * 60 * 1000).toISOString();
    }

    function putSetting(key: string, value: string): void {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
    }

    beforeEach(() => {
      db = openDatabase(":memory:");
      runMigrations(db);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // work_start >= work_end の不正な組（日またぎ）を直接書き込む。PUT
      // 経由では #480/#481 に弾かれてこの状態を作れない。
      putSetting("work_start", "22:00");
      putSetting("work_end", "02:00");
    });

    afterEach(() => {
      db.close();
      vi.restoreAllMocks();
    });

    it("sanity check: loadDetectionSettings falls back the corrupted pair to the default working hours", () => {
      expect(loadDetectionSettings(db).workingHours).toEqual(
        DEFAULT_DETECTION_SETTINGS.workingHours,
      );
    });

    it("evaluates break_overrun while on break", () => {
      const settings = loadDetectionSettings(db);
      const activeBreak = makeActivityEvent({
        type: "break_start",
        expected_minutes: 15,
        created_at: isoMinutesBefore(NOW, 20),
      });

      const result = evaluateRules({
        now: NOW,
        tasks: [],
        activityEvents: [activeBreak],
        notifications: [],
        settings,
        todaysSessionTypes: ["morning", "evening"],
      });

      expect(result).toEqual([
        { ruleType: "break_overrun", ruleKey: "break_overrun", escalationLevel: 1, taskId: null },
      ]);
    });

    it("evaluates unstarted, silence, and deadline_overdue together while not on break", () => {
      const settings = loadDetectionSettings(db);
      // 未着手閾値（既定60分）を超過させる。
      const topTask = makeTask({
        id: 1,
        status: "todo",
        priority: "high",
        created_at: isoMinutesBefore(NOW, 61),
      });
      // 締切（NOW の前暦日）は D+1 00:00 に超過が成立し、NOW（13:00）は
      // その後。
      const overdueTask = makeTask({ id: 2, status: "todo", due_at: YESTERDAY_DUE_DATE });
      // 無音閾値（既定45分）は超過させつつ、回避検知の窓（既定30分）より
      // 外側に置き、avoidance ではなく unstarted が出ることを固定する。
      const otherTaskActivity = makeActivityEvent({
        type: "task_update",
        task_id: 99,
        created_at: isoMinutesBefore(NOW, 50),
      });

      const result = evaluateRules({
        now: NOW,
        tasks: [topTask, overdueTask],
        activityEvents: [otherTaskActivity],
        notifications: [],
        settings,
        todaysSessionTypes: ["morning", "evening"],
      });

      expect(result).toEqual(
        expect.arrayContaining([
          { ruleType: "unstarted", ruleKey: "unstarted:1", escalationLevel: 1, taskId: 1 },
          { ruleType: "silence", ruleKey: "silence", escalationLevel: 1, taskId: null },
          {
            ruleType: "deadline_overdue",
            ruleKey: "deadline_overdue:2",
            escalationLevel: 1,
            taskId: 2,
          },
        ]),
      );
      expect(result).toHaveLength(3);
    });

    it("evaluates avoidance when there is recent activity on another task", () => {
      const settings = loadDetectionSettings(db);
      const topTask = makeTask({
        id: 1,
        status: "todo",
        priority: "high",
        created_at: isoMinutesBefore(NOW, 61),
      });
      // 回避検知の窓（既定30分）の内側に別タスクへの活動を置く。
      const recentOtherActivity = makeActivityEvent({
        type: "task_update",
        task_id: 2,
        created_at: isoMinutesBefore(NOW, 10),
      });

      const result = evaluateRules({
        now: NOW,
        tasks: [topTask],
        activityEvents: [recentOtherActivity],
        notifications: [],
        settings,
        todaysSessionTypes: ["morning", "evening"],
      });

      expect(result).toEqual([
        { ruleType: "avoidance", ruleKey: "avoidance:1", escalationLevel: 1, taskId: 1 },
      ]);
    });

    // 検出力の確認（恒真アサーション対策）: loadDetectionSettings を経由せず
    // 生の不正な組をそのまま evaluateRules に渡すと（＝#482 のガードが
    // 存在しないのと同じ状態）、稼働時間ゲート下のルールは発火しない。
    // 上記のテストが「ガードが効いているから」発火していることの対照。
    it("control: the same inputs do NOT fire working-hours-gated rules when the raw corrupted pair bypasses the guard", () => {
      const rawSettings = {
        ...DEFAULT_DETECTION_SETTINGS,
        workingHours: { start: "22:00", end: "02:00" },
      };
      const topTask = makeTask({
        id: 1,
        status: "todo",
        priority: "high",
        created_at: isoMinutesBefore(NOW, 61),
      });
      const overdueTask = makeTask({ id: 2, status: "todo", due_at: YESTERDAY_DUE_DATE });
      const otherTaskActivity = makeActivityEvent({
        type: "task_update",
        task_id: 99,
        created_at: isoMinutesBefore(NOW, 50),
      });

      const result = evaluateRules({
        now: NOW,
        tasks: [topTask, overdueTask],
        activityEvents: [otherTaskActivity],
        notifications: [],
        settings: rawSettings,
        todaysSessionTypes: ["morning", "evening"],
      });

      expect(result).toEqual([]);
    });
  });
});
