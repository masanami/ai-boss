import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { evaluateRules } from "../detection/rule-engine.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  type DetectionInput,
  type DetectionSettings,
} from "../detection/detection-types.js";
import { makeActivityEvent, makeTask } from "../detection/detection-test-fixtures.js";
import { toDateKey } from "../detection/time-utils.js";
import { loadDetectionSettings } from "./detection-settings.js";

/**
 * AC-10 (#483, 親要件 #448): DB に既に `work_start >= work_end` の不正な組が
 * 保存されている状態でも、読み出し側ガード（#482 の `loadDetectionSettings`）
 * を経由した設定を渡せば、稼働時間ゲート下の 5 ルール（`unstarted` /
 * `avoidance` / `break_overrun` / `silence` / `deadline_overdue`）が評価される
 * （検知が無言で全停止しない）ことを確認する。
 *
 * `PUT /api/settings` 経由では #480/#481 のバリデータに弾かれてこの状態を
 * 作れないため、`settings` テーブルへ直接 INSERT して再現する
 * （`detection-settings.test.ts` の `putSetting` と同じ手法）。
 *
 * **このファイルが `detection/` ではなく `scheduler/` にある理由**:
 * 検証対象は `loadDetectionSettings`（DB 読み出し）と `evaluateRules`（純粋
 * 関数）の**合成**であり、その合成を持つのは `scheduler/`（`scheduler-tick.ts`）
 * である。`detection/` 配下のプロダクションコードは `db/` も `scheduler/` も
 * import せず（依存は `scheduler` → `detection` の一方向）、検知ロジックは
 * 純粋関数に保つのが本リポジトリの方針（CLAUDE.md「開発原則」）。テストを
 * `detection/` に置くとこの向きが逆転するため、こちら側に置く。
 *
 * 固定時刻は `new Date(y, m, d, h, m)` 由来のローカル日時から導出し
 * （AC-11、ADR 0007 決定 5）、活動イベント・締切もそこから相対的に導く。
 */
describe("working-hours gate under a corrupted work_start/work_end pair (AC-10)", () => {
  let db: Database.Database;

  // 2026-09-10 13:00（ローカル）。#482 のガードが効いた後の既定稼働時間
  // 09:00-18:00 の内側に置く。
  const NOW = new Date(2026, 8, 10, 13, 0);
  // NOW の暦日の前日（締切超過を成立させるため）。日付要素を再度べた書き
  // せず NOW から導くことで、NOW をずらしても「前日」という関係が保たれる
  // （独立にハードコードすると、NOW を動かしたとき関係が黙って壊れても
  // 締切超過は成立したままでテストが緑を保ち、検出できない）。
  const YESTERDAY_DUE_DATE = toDateKey(
    new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1),
  );

  // 不正な組（日またぎ）は 1 箇所に持つ。DB へ書き込む値と、下の対照テストが
  // ガードを迂回して直接渡す値が同じであることが「対照」の前提であり、
  // 2 箇所にリテラルを手写しすると片方だけ変えても両方緑のまま
  // 「対照になっていない対照テスト」へ静かに劣化するため。
  const CORRUPTED_WORKING_HOURS = { start: "22:00", end: "02:00" } as const;

  function isoMinutesBefore(base: Date, minutes: number): string {
    return new Date(base.getTime() - minutes * 60 * 1000).toISOString();
  }

  function putSetting(key: string, value: string): void {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * 「休憩中でない」シナリオの入力一式（未着手・無音・締切超過が同時に
   * 成立する）。3 番目のテストと対照テストが**同一の入力**を使うことが
   * 対照の前提なので、フィクスチャを手写しで重複させずここから配る。
   */
  function notOnBreakScenario(settings: DetectionSettings): DetectionInput {
    return {
      now: NOW,
      tasks: [
        // 未着手閾値（既定60分）を超過させる。
        makeTask({
          id: 1,
          status: "todo",
          priority: "high",
          created_at: isoMinutesBefore(NOW, 61),
        }),
        // 締切（NOW の前暦日）は D+1 00:00 に超過が成立し、NOW（13:00）は
        // その後。
        makeTask({ id: 2, status: "todo", due_at: YESTERDAY_DUE_DATE }),
      ],
      // 無音閾値（既定45分）は超過させつつ、回避検知の窓（既定30分）より
      // 外側に置き、avoidance ではなく unstarted が出ることを固定する。
      activityEvents: [
        makeActivityEvent({
          type: "task_update",
          task_id: 99,
          created_at: isoMinutesBefore(NOW, 50),
        }),
      ],
      notifications: [],
      settings,
      todaysSessionTypes: ["morning", "evening"],
    };
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // work_start >= work_end の不正な組を直接書き込む。PUT 経由では
    // #480/#481 に弾かれてこの状態を作れない。
    putSetting("work_start", CORRUPTED_WORKING_HOURS.start);
    putSetting("work_end", CORRUPTED_WORKING_HOURS.end);
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
    const guardedSettings = loadDetectionSettings(db);
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
      settings: guardedSettings,
      todaysSessionTypes: ["morning", "evening"],
    });

    expect(result).toEqual([
      { ruleType: "break_overrun", ruleKey: "break_overrun", escalationLevel: 1, taskId: null },
    ]);
  });

  it("evaluates unstarted, silence, and deadline_overdue together while not on break", () => {
    const result = evaluateRules(notOnBreakScenario(loadDetectionSettings(db)));

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
    const guardedSettings = loadDetectionSettings(db);
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
      settings: guardedSettings,
      todaysSessionTypes: ["morning", "evening"],
    });

    expect(result).toEqual([
      { ruleType: "avoidance", ruleKey: "avoidance:1", escalationLevel: 1, taskId: 1 },
    ]);
  });

  // 検出力の確認（恒真アサーション対策）: loadDetectionSettings を経由せず
  // 生の不正な組をそのまま evaluateRules に渡すと（＝#482 のガードが存在
  // しないのと同じ状態）、稼働時間ゲート下のルールは 1 件も発火しない。
  // 上の「休憩中でない」テストと**同一の入力**で結果だけが変わることが、
  // それらが「ガードが効いているから緑」であることの担保になる。
  it("control: the same inputs do NOT fire working-hours-gated rules when the raw corrupted pair bypasses the guard", () => {
    const rawSettings: DetectionSettings = {
      ...DEFAULT_DETECTION_SETTINGS,
      workingHours: { ...CORRUPTED_WORKING_HOURS },
    };

    const result = evaluateRules(notOnBreakScenario(rawSettings));

    expect(result).toEqual([]);
  });
});
