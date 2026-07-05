import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "./sessions-repository.js";
import { insertMessage, listMessagesBySessionId } from "./messages-repository.js";

describe("messages repository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("insertMessage", () => {
    it("inserts a message with a server-managed created_at", () => {
      const session = insertSession(db, { type: "adhoc" });

      const message = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "今日は資料作成から始めます",
      });

      expect(message).toMatchObject({
        session_id: session.id,
        role: "user",
        content: "今日は資料作成から始めます",
      });
      expect(typeof message.id).toBe("number");
      expect(typeof message.created_at).toBe("string");
    });
  });

  describe("listMessagesBySessionId", () => {
    it("returns an empty array when the session has no messages", () => {
      const session = insertSession(db, { type: "adhoc" });

      expect(listMessagesBySessionId(db, session.id)).toEqual([]);
    });

    it("returns messages ordered by created_at ascending", () => {
      const session = insertSession(db, { type: "adhoc" });
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

      const result = listMessagesBySessionId(db, session.id);

      expect(result.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it("does not return messages belonging to other sessions", () => {
      const sessionA = insertSession(db, { type: "adhoc" });
      const sessionB = insertSession(db, { type: "morning" });
      insertMessage(db, {
        session_id: sessionA.id,
        role: "user",
        content: "Aへの発言",
      });
      const messageB = insertMessage(db, {
        session_id: sessionB.id,
        role: "user",
        content: "Bへの発言",
      });

      const result = listMessagesBySessionId(db, sessionB.id);

      expect(result.map((m) => m.id)).toEqual([messageB.id]);
    });
  });
});
