import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertMessage } from "./messages-repository.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

interface ErrorBody {
  error: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("sessions routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /api/sessions", () => {
    it.each(["morning", "evening", "adhoc"] as const)(
      "creates a session with type %s",
      async (type) => {
        const app = createApp(db);

        const res = await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        });

        expect(res.status).toBe(201);
        const body = await readJson<Session>(res);
        expect(body).toMatchObject({ type, ended_at: null, summary: null });
        expect(typeof body.id).toBe("number");
        expect(typeof body.started_at).toBe("string");
      },
    );

    it("returns 400 when type is missing", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when type is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lunch" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when the request body is not valid JSON", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns an empty array when no sessions exist", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions");

      expect(res.status).toBe(200);
      expect(await readJson<Session[]>(res)).toEqual([]);
    });

    it("returns sessions ordered by started_at descending (most recent first)", async () => {
      const app = createApp(db);

      const first = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      const second = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request("/api/sessions");

      expect(res.status).toBe(200);
      const body = await readJson<Session[]>(res);
      expect(body.map((s) => s.id)).toEqual([second.id, first.id]);
    });

    it("filters sessions by ?type=", async () => {
      const app = createApp(db);

      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "morning" }),
      });
      const adhoc = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request("/api/sessions?type=adhoc");

      expect(res.status).toBe(200);
      const body = await readJson<Session[]>(res);
      expect(body.map((s) => s.id)).toEqual([adhoc.id]);
    });

    it("returns 400 when ?type= is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions?type=lunch");

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });
  });

  describe("GET /api/sessions/:id/messages", () => {
    it("returns an empty array when the session has no messages", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request(`/api/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      expect(await readJson<Message[]>(res)).toEqual([]);
    });

    it("returns messages ordered by created_at ascending", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );
      const first = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "最初の発言",
      });
      const second = insertMessage(db, {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });

      const res = await app.request(`/api/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      const body = await readJson<Message[]>(res);
      expect(body.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it("returns 404 for a non-existent session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/9999/messages");

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 404 for a non-numeric session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/not-a-number/messages");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/end", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("records ended_at (ISO 8601) on the session and returns it", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T09:30:00+09:00"));

      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body).toMatchObject({
        id: session.id,
        ended_at: new Date("2026-07-06T09:30:00+09:00").toISOString(),
      });
    });

    it("returns 404 for a non-existent session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/9999/end", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      const body = await readJson<{ error: string }>(res);
      expect(typeof body.error).toBe("string");
    });

    it("is idempotent: ending an already-ended session returns 200 with the original ended_at", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T18:00:00+09:00"));
      const first = await readJson<Session>(
        await app.request(`/api/sessions/${session.id}/end`, { method: "POST" }),
      );

      vi.setSystemTime(new Date("2026-07-06T19:00:00+09:00"));
      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body).toEqual(first);
    });
  });
});
