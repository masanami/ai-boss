import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";

interface ErrorBodyWithCode {
  error: string;
  code: string;
}

interface WorkLogBody {
  date: string;
  content: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ローカル日付基準・TZ非依存: new Date(y, m, d, h, mi) から toISOString() で
// DB 用の値を作る（CLAUDE.md「テスト方針」）。
function iso(y: number, m: number, d: number, h: number, mi: number, s = 0): string {
  return new Date(y, m - 1, d, h, mi, s).toISOString();
}

function insertRawSession(db: Database.Database, createdAt: string): number {
  const result = db
    .prepare("INSERT INTO sessions (type, started_at, ended_at) VALUES ('evening', ?, ?)")
    .run(createdAt, createdAt);
  return Number(result.lastInsertRowid);
}

function insertRawDecision(
  db: Database.Database,
  opts: { sessionId: number; content: string; status: "active" | "revised" | "withdrawn"; createdAt: string },
): void {
  db.prepare(`INSERT INTO decisions (session_id, content, status, created_at) VALUES (?, ?, ?, ?)`).run(
    opts.sessionId,
    opts.content,
    opts.status,
    opts.createdAt,
  );
}

function insertRawActivityEvent(
  db: Database.Database,
  opts: { type: string; createdAt: string },
): void {
  db.prepare(`INSERT INTO activity_events (type, created_at) VALUES (?, ?)`).run(opts.type, opts.createdAt);
}

const env = {};

describe("GET /api/work-logs/:date", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 200 with the fixed '（記録なし）' body when there is no evening session at all (no prerequisite)", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/work-logs/2026-08-14");

    expect(res.status).toBe(200);
    const body = await readJson<WorkLogBody>(res);
    expect(body.date).toBe("2026-08-14");
    expect(body.content).toContain("# 作業ログ 2026-08-14（金）");
    expect(body.content).toContain("（記録なし）");
  });

  it("returns 200 even when an evening session exists but has not ended (no prerequisite, unlike daily reports)", async () => {
    const app = createApp(db, env);
    insertRawSession(db, iso(2026, 8, 14, 19, 0));

    const res = await app.request("/api/work-logs/2026-08-14");

    expect(res.status).toBe(200);
  });

  it("merges decisions and activity events into one created_at-ascending list", async () => {
    const app = createApp(db, env);
    const sessionId = insertRawSession(db, iso(2026, 8, 14, 19, 0));
    insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 14, 9, 5) });
    insertRawDecision(db, {
      sessionId,
      content: "本日のノルマは◯◯を完了させることとする",
      status: "active",
      createdAt: iso(2026, 8, 14, 9, 30),
    });
    insertRawDecision(db, {
      sessionId,
      content: "△△を先に着手する",
      status: "revised",
      createdAt: iso(2026, 8, 14, 11, 30),
    });
    insertRawDecision(db, {
      sessionId,
      content: "取り下げられた決定",
      status: "withdrawn",
      createdAt: iso(2026, 8, 14, 12, 0),
    });
    insertRawActivityEvent(db, { type: "checkin", createdAt: iso(2026, 8, 14, 13, 0) });

    const res = await app.request("/api/work-logs/2026-08-14");
    const body = await readJson<WorkLogBody>(res);

    const idx = {
      taskStart: body.content.indexOf("09:05 着手"),
      decision: body.content.indexOf("09:30 決定:"),
      revised: body.content.indexOf("11:30 決定（改訂済み）"),
      withdrawn: body.content.indexOf("12:00 決定（撤回）"),
      checkin: body.content.indexOf("13:00 チェックイン"),
    };
    expect(Object.values(idx).every((i) => i > -1)).toBe(true);
    expect(idx.taskStart).toBeLessThan(idx.decision);
    expect(idx.decision).toBeLessThan(idx.revised);
    expect(idx.revised).toBeLessThan(idx.withdrawn);
    expect(idx.withdrawn).toBeLessThan(idx.checkin);
  });

  it("excludes chat_message events from the response", async () => {
    const app = createApp(db, env);
    insertRawActivityEvent(db, { type: "chat_message", createdAt: iso(2026, 8, 14, 9, 5) });

    const res = await app.request("/api/work-logs/2026-08-14");
    const body = await readJson<WorkLogBody>(res);

    expect(body.content).toContain("（記録なし）");
  });

  it("excludes records from the previous/next day (local calendar-day boundary)", async () => {
    const app = createApp(db, env);
    insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 13, 23, 59) });
    insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 15, 0, 0) });

    const res = await app.request("/api/work-logs/2026-08-14");
    const body = await readJson<WorkLogBody>(res);

    expect(body.content).toContain("（記録なし）");
  });

  it("returns 400 with code invalid_date for a malformed date param", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/work-logs/2026-13-40");

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBodyWithCode>(res);
    expect(body.code).toBe("invalid_date");
  });

  it("returns 400 with code invalid_date for a non-existent calendar date (e.g. Feb 30)", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/work-logs/2026-02-30");

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBodyWithCode>(res);
    expect(body.code).toBe("invalid_date");
  });

  it("returns 400 with code invalid_date for a non YYYY-MM-DD string", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/work-logs/not-a-date");

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBodyWithCode>(res);
    expect(body.code).toBe("invalid_date");
  });
});
