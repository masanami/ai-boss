import { describe, expect, it } from "vitest";
import {
  isWithinRecentLocalDays,
  terminalReferenceAt,
} from "./recent-terminal-tasks";
import type { Task, TaskStatus } from "./task";

const WINDOW_DAYS = 7;

/**
 * 固定時刻はローカル暦日基準で組む（ADR 0007 決定 5: UTC 文字列リテラルを
 * 使わない）。ローカル 2026-09-10 12:00 を「今」とすると、windowDays = 7 の
 * 包含範囲は 2026-09-04〜2026-09-10 になる。
 */
const NOW = new Date(2026, 8, 10, 12, 0, 0);

/** ローカル暦日から ISO 文字列を組む（サーバが返す形に合わせる）。 */
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): string {
  return new Date(
    year,
    monthIndex,
    day,
    hour,
    minute,
    second,
    millisecond,
  ).toISOString();
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 1,
    title: "資料を作る",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: localIso(2026, 8, 1),
    updated_at: localIso(2026, 8, 1),
    completed_at: null,
    evidence_required: false,
    ...overrides,
  };
}

describe("terminalReferenceAt", () => {
  it("returns completed_at for a done task (AC-24)", () => {
    const completedAt = localIso(2026, 8, 9, 18);
    const task = makeTask({
      status: "done",
      completed_at: completedAt,
      updated_at: localIso(2026, 8, 10, 9),
    });

    expect(terminalReferenceAt(task)).toBe(completedAt);
  });

  it("returns updated_at for a dropped task (AC-25)", () => {
    // dropped には中止時刻を持つ列が無く、updateTask は done 以外への遷移で
    // completed_at を null にする（決定 3）。
    const updatedAt = localIso(2026, 8, 9, 18);
    const task = makeTask({
      status: "dropped",
      updated_at: updatedAt,
      completed_at: localIso(2026, 8, 1, 10),
    });

    expect(terminalReferenceAt(task)).toBe(updatedAt);
  });

  it("returns null for non-terminal statuses (AC-26)", () => {
    const nonTerminal: TaskStatus[] = ["todo", "in_progress", "paused"];

    for (const status of nonTerminal) {
      const task = makeTask({
        status,
        updated_at: localIso(2026, 8, 10, 9),
        completed_at: localIso(2026, 8, 10, 9),
      });

      expect(terminalReferenceAt(task)).toBeNull();
    }
  });

  it("returns null for a done task whose completed_at is null (決定 4)", () => {
    const task = makeTask({ status: "done", completed_at: null });

    expect(terminalReferenceAt(task)).toBeNull();
  });
});

describe("isWithinRecentLocalDays", () => {
  it("returns false when the reference is null (AC-27)", () => {
    expect(isWithinRecentLocalDays(null, NOW, WINDOW_DAYS)).toBe(false);
  });

  it("treats the first moment of the lower-bound calendar day as within the window (AC-28 true side)", () => {
    // now = 2026-09-10・windowDays = 7 → 下限の暦日は 2026-09-04。
    expect(
      isWithinRecentLocalDays(localIso(2026, 8, 4, 0, 0, 0, 0), NOW, WINDOW_DAYS),
    ).toBe(true);
  });

  it("treats the millisecond before the lower-bound calendar day as outside the window (AC-28 false side)", () => {
    expect(
      isWithinRecentLocalDays(
        localIso(2026, 8, 3, 23, 59, 59, 999),
        NOW,
        WINDOW_DAYS,
      ),
    ).toBe(false);
  });

  it("returns false when the reference cannot be parsed (決定 4 と同じ fail-closed)", () => {
    // toDateKey は Invalid Date に "NaN-NaN-NaN" を返し、辞書順では下限より
    // 大きくなる。明示的に弾かないと読めない値が列に残り続ける。
    expect(isWithinRecentLocalDays("not a timestamp", NOW, WINDOW_DAYS)).toBe(
      false,
    );
  });

  it("walks calendar days instead of adding a fixed number of milliseconds (ADR 0007 決定 3)", () => {
    // DST のある地域では 24 時間 ≠ 1 暦日。TZ=America/New_York では 2026-03-08 に
    // DST が始まるため、now = ローカル 2026-03-11 00:30 から固定の 6×24h を引くと
    // 2026-03-04 23:30 に着地し、下限が 1 暦日ずれて 03-04 のタスクが残ってしまう。
    // 暦日を進退させる実装なら下限は 2026-03-05 で、どのタイムゾーンでも 03-04 は
    // 範囲外になる（npm test と npm run test:tz の両方で成り立つ）。
    const now = new Date(2026, 2, 11, 0, 30);

    expect(isWithinRecentLocalDays(localIso(2026, 2, 4, 23), now, WINDOW_DAYS)).toBe(
      false,
    );
    expect(isWithinRecentLocalDays(localIso(2026, 2, 5, 0), now, WINDOW_DAYS)).toBe(
      true,
    );
  });

  it("keeps a reference in the middle of the window (sanity)", () => {
    expect(
      isWithinRecentLocalDays(localIso(2026, 8, 7, 15), NOW, WINDOW_DAYS),
    ).toBe(true);
  });

  it("treats a reference in the future as within the window (AC-29)", () => {
    // 上限側は絞らない（明示的な仮定 3: 時計のずれで未来値が入っても消さない）。
    expect(
      isWithinRecentLocalDays(localIso(2026, 8, 11, 9), NOW, WINDOW_DAYS),
    ).toBe(true);
  });

  it("walks the calendar across a month boundary (AC-30)", () => {
    // now = 2026-03-02 → 下限は 2026-02-24（2 月は 28 日まで）。
    const now = new Date(2026, 2, 2, 12, 0, 0);

    expect(
      isWithinRecentLocalDays(localIso(2026, 1, 24, 0, 0, 0, 0), now, WINDOW_DAYS),
    ).toBe(true);
    expect(
      isWithinRecentLocalDays(
        localIso(2026, 1, 23, 23, 59, 59, 999),
        now,
        WINDOW_DAYS,
      ),
    ).toBe(false);
  });

  it("walks the calendar across a year boundary (AC-30)", () => {
    // now = 2027-01-02 → 下限は 2026-12-27。
    const now = new Date(2027, 0, 2, 12, 0, 0);

    expect(
      isWithinRecentLocalDays(
        localIso(2026, 11, 27, 0, 0, 0, 0),
        now,
        WINDOW_DAYS,
      ),
    ).toBe(true);
    expect(
      isWithinRecentLocalDays(
        localIso(2026, 11, 26, 23, 59, 59, 999),
        now,
        WINDOW_DAYS,
      ),
    ).toBe(false);
  });

  it("does not mutate the input task or now (AC-31)", () => {
    const task = makeTask({
      status: "dropped",
      updated_at: localIso(2026, 8, 9, 18),
    });
    const taskSnapshot = { ...task };
    const now = new Date(NOW.getTime());
    const nowSnapshot = now.getTime();

    isWithinRecentLocalDays(terminalReferenceAt(task), now, WINDOW_DAYS);

    expect(task).toEqual(taskSnapshot);
    expect(now.getTime()).toBe(nowSnapshot);
  });
});
