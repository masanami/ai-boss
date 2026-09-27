import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";
import type { DriverHook } from "../db/test-support/hooked-driver.js";
import type { DbPort } from "../db/db-port.js";
import { setSettingValue } from "../settings/settings-repository.js";
import { createMeetingScheduleRouter } from "./meeting-schedule-routes.js";

// #606・機能仕様 docs/features/async-db-layer.md 決定 2（T4）: フック付き
// ドライバで失敗と割り込みを決定的に差し込む。

const TODAY = "2026-07-05";

interface Harness {
  db: DbPort;
  raw: Database.Database;
  hooks: DriverHook[];
  app: Hono;
}

const opened: Database.Database[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 6, 5, 8, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  for (const raw of opened.splice(0)) {
    raw.close();
  }
});

async function setup(): Promise<Harness> {
  const { db, raw, hooks } = await createHookedTestDb();
  opened.push(raw);
  raw
    .prepare("INSERT INTO settings (key, value) VALUES ('morning_meeting_time', '09:00'), ('evening_meeting_time', '19:00')")
    .run();
  const app = new Hono();
  app.route("/api/meeting-schedule", createMeetingScheduleRouter(db));
  return { db, raw, hooks, app };
}

function putSchedule(app: Hono, body: unknown) {
  return app.request(`/api/meeting-schedule/${TODAY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function overrides(raw: Database.Database): Record<string, string> {
  const rows = raw
    .prepare("SELECT meeting_type, meeting_time FROM meeting_time_overrides WHERE date = ?")
    .all(TODAY) as { meeting_type: string; meeting_time: string }[];
  return Object.fromEntries(rows.map((row) => [row.meeting_type, row.meeting_time]));
}

describe("T4 meeting-schedule overrides on the async DB port (#606)", () => {
  it("AC-9: when an operation in the middle of an override update fails, no override changes", async () => {
    const { raw, hooks, app } = await setup();
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO meeting_time_overrides (date, meeting_type, meeting_time, created_at, updated_at) VALUES (?, 'morning', '09:15', ?, ?)",
      )
      .run(TODAY, now, now);
    let upserts = 0;
    hooks.push({
      matches: (sql) => sql.trimStart().startsWith("INSERT INTO meeting_time_overrides"),
      after: () => {
        upserts += 1;
        if (upserts === 2) {
          throw new Error("injected override write failure");
        }
      },
    });

    const res = await putSchedule(app, { morning: "09:30", evening: "19:30" });

    expect(res.status).toBe(500);
    expect(upserts).toBe(2);
    expect(overrides(raw)).toEqual({ morning: "09:15" });
  });

  it("AC-19: a default-time change issued right after the update read the defaults does not run until the override write commits", async () => {
    const { db, raw, hooks, app } = await setup();
    const order: string[] = [];
    let defaultsChange: Promise<void> | undefined;
    hooks.push(
      {
        matches: (sql) => sql.trimStart().startsWith("INSERT INTO meeting_time_overrides"),
        after: () => void order.push("override"),
      },
      {
        matches: (sql) => sql.trimStart().startsWith("INSERT INTO settings"),
        after: () => void order.push("defaults-change"),
      },
      {
        // 判定（削除か upsert か・遅延の上限）に使う既定の時刻の読み出しの直後。
        matches: (sql) => defaultsChange === undefined && sql === "SELECT key, value FROM settings",
        after: () => {
          defaultsChange = setSettingValue(db, "morning_meeting_time", "06:00");
        },
      },
    );

    const res = await putSchedule(app, { morning: "09:30" });
    await defaultsChange;

    expect(res.status).toBe(200);
    expect(order).toEqual(["override", "defaults-change"]);
    expect(overrides(raw)).toEqual({ morning: "09:30" });
  });
});
