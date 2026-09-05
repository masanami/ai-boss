import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertNotification } from "../notifications/notifications-repository.js";
import { calculateTodayMaxEscalationLevel } from "./today-escalation.js";

describe("calculateTodayMaxEscalationLevel", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("returns 0 when there are no notifications", () => {
    const now = new Date(2026, 6, 6, 10, 0);

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(0);
  });

  it("returns the highest escalation_level among today's notifications", () => {
    const now = new Date(2026, 6, 6, 15, 0);
    // insertNotification は sent_at にサーバー時刻を書くので、それが `now` の
    // 当日に落ちるよう時計を固定する（上限が入る前は「未来の行」として通っていた）。
    vi.useFakeTimers();
    vi.setSystemTime(now);
    insertNotification(db, { type: "todo_stall", escalation_level: 1, body: "着手しろ" });
    insertNotification(db, { type: "avoidance", escalation_level: 3, body: "戻れ" });
    insertNotification(db, { type: "silence", escalation_level: 2, body: "報告しろ" });

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(3);
  });

  // ローカル日付基準・TZ非依存: 固定時刻は new Date(y, m, d, h, mi, s, ms) から
  // 導出する（ADR 0007 決定5）。
  function insertAt(escalationLevel: number, sentAt: Date): void {
    db
      .prepare(
        `INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("todo_stall", null, escalationLevel, `level ${escalationLevel}`, sentAt.toISOString());
  }

  it("ignores notifications sent on a previous local day", () => {
    const yesterday = new Date(2026, 6, 5, 23, 0);
    const today = new Date(2026, 6, 6, 9, 0);
    insertAt(3, yesterday);

    expect(calculateTodayMaxEscalationLevel(db, today)).toBe(0);
  });

  it("ignores a notification sent exactly at the next local day's 00:00:00.000 (future-dated row after a clock/timezone rollback) while keeping one sent at 23:59:59.999 (half-open interval upper bound, ADR 0007 決定3, #236)", () => {
    const now = new Date(2026, 6, 6, 15, 0);
    // 上限直前は含む（対照。これが無いと「常に 0 を返す」壊れ方でも通ってしまう）
    insertAt(2, new Date(2026, 6, 6, 23, 59, 59, 999));
    // 翌ローカル暦日 00:00:00.000 ちょうど＝対象外。より高い level にして、
    // 上限が消えた退行を最大値で検出できるようにする。
    insertAt(5, new Date(2026, 6, 7, 0, 0, 0, 0));

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(2);
  });

  it("includes a notification sent exactly at today's local 00:00:00.000 (inclusive lower bound) while ignoring one sent at 23:59:59.999 the day before", () => {
    const now = new Date(2026, 6, 6, 9, 0);
    insertAt(4, new Date(2026, 6, 5, 23, 59, 59, 999));
    insertAt(1, new Date(2026, 6, 6, 0, 0, 0, 0));

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(1);
  });
});
