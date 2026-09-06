import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "./sessions-repository.js";
import {
  deleteMessagesFrom,
  findMessageInSession,
  insertMessage,
  listMessagesBySessionId,
} from "./messages-repository.js";

/**
 * Forces a message's `created_at` to an exact value via a direct UPDATE, so
 * ordering-sensitive tests (AC-4, AC-5) don't depend on the timing of
 * consecutive `insertMessage` calls, which can land in the same
 * millisecond on a real `:memory:` DB.
 */
function setCreatedAt(db: Database.Database, messageId: number, at: Date): void {
  const result = db
    .prepare("UPDATE messages SET created_at = ? WHERE id = ?")
    .run(at.toISOString(), messageId);
  if (result.changes !== 1) {
    throw new Error(
      `setCreatedAt: expected to update exactly 1 row for message ${messageId}, updated ${result.changes}`,
    );
  }
}

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

  describe("findMessageInSession", () => {
    it("returns the message when it belongs to the given session", () => {
      const session = insertSession(db, { type: "adhoc" });
      const message = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "資料を確認します",
      });

      expect(findMessageInSession(db, session.id, message.id)).toEqual(
        message,
      );
    });

    it("returns undefined when the id belongs to a different session (AC-7)", () => {
      const sessionA = insertSession(db, { type: "adhoc" });
      const sessionB = insertSession(db, { type: "morning" });
      const messageInB = insertMessage(db, {
        session_id: sessionB.id,
        role: "user",
        content: "Bでの発言",
      });

      expect(findMessageInSession(db, sessionA.id, messageInB.id)).toBeUndefined();
    });

    it("returns undefined when the id does not exist at all", () => {
      const session = insertSession(db, { type: "adhoc" });

      expect(findMessageInSession(db, session.id, 999_999)).toBeUndefined();
    });
  });

  describe("deleteMessagesFrom", () => {
    it("deletes the target message itself (AC-1)", () => {
      const session = insertSession(db, { type: "adhoc" });
      const target = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });

      deleteMessagesFrom(db, session.id, target.id);

      expect(findMessageInSession(db, session.id, target.id)).toBeUndefined();
    });

    it("deletes every later message in the same session regardless of role (AC-2)", () => {
      const session = insertSession(db, { type: "adhoc" });
      const target = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });
      const bossReply = insertMessage(db, {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });
      const laterUserMessage = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "その後の発言",
      });

      const deletedCount = deleteMessagesFrom(db, session.id, target.id);

      expect(deletedCount).toBe(3);
      expect(listMessagesBySessionId(db, session.id)).toEqual([]);
      expect(
        findMessageInSession(db, session.id, bossReply.id),
      ).toBeUndefined();
      expect(
        findMessageInSession(db, session.id, laterUserMessage.id),
      ).toBeUndefined();
    });

    it("does not delete earlier messages in the same session (AC-3)", () => {
      const session = insertSession(db, { type: "adhoc" });
      const earlier = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "最初の発言",
      });
      const target = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });

      deleteMessagesFrom(db, session.id, target.id);

      const remaining = listMessagesBySessionId(db, session.id);
      expect(remaining.map((m) => m.id)).toEqual([earlier.id]);
    });

    it("does not delete messages belonging to other sessions (AC-4)", () => {
      const sessionA = insertSession(db, { type: "adhoc" });
      const sessionB = insertSession(db, { type: "morning" });
      const target = insertMessage(db, {
        session_id: sessionA.id,
        role: "user",
        content: "Aの書き直したい発言",
      });
      const otherSessionMessage = insertMessage(db, {
        session_id: sessionB.id,
        role: "user",
        content: "Bへの発言",
      });
      // Two consecutive insertMessage calls can land in the same
      // millisecond, so relying on natural insertion order would make this
      // test's premise non-deterministic. Force the exact scenario AC-4
      // calls out explicitly: a later created_at alone must not make a row
      // eligible for deletion when it belongs to a different session.
      setCreatedAt(db, target.id, new Date(2024, 0, 1, 9, 0, 0));
      setCreatedAt(db, otherSessionMessage.id, new Date(2024, 0, 1, 9, 0, 1));
      const expectedOtherSessionMessage = findMessageInSession(
        db,
        sessionB.id,
        otherSessionMessage.id,
      );
      expect(
        findMessageInSession(db, sessionA.id, target.id)!.created_at <
          expectedOtherSessionMessage!.created_at,
      ).toBe(true);

      const deletedCount = deleteMessagesFrom(db, sessionA.id, target.id);

      expect(deletedCount).toBe(1);
      expect(findMessageInSession(db, sessionA.id, target.id)).toBeUndefined();
      expect(
        findMessageInSession(db, sessionB.id, otherSessionMessage.id),
      ).toEqual(expectedOtherSessionMessage);
    });

    it("returns 0 and deletes nothing when fromMessageId does not belong to the session", () => {
      const sessionA = insertSession(db, { type: "adhoc" });
      const sessionB = insertSession(db, { type: "morning" });
      const messageInB = insertMessage(db, {
        session_id: sessionB.id,
        role: "user",
        content: "Bへの発言",
      });

      const deletedCount = deleteMessagesFrom(db, sessionA.id, messageInB.id);

      expect(deletedCount).toBe(0);
      expect(findMessageInSession(db, sessionB.id, messageInB.id)).toEqual(
        messageInB,
      );
    });

    it("returns the number of deleted rows (AC-6)", () => {
      const session = insertSession(db, { type: "adhoc" });
      const target = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });
      insertMessage(db, {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });

      const deletedCount = deleteMessagesFrom(db, session.id, target.id);

      expect(deletedCount).toBe(2);
    });

    describe("when two messages share the same created_at (AC-5)", () => {
      // created_at is server-managed and set at insert time, so this test
      // forces a tie via a direct UPDATE (setCreatedAt) rather than relying
      // on two insertMessage calls happening to land in the same
      // millisecond. TZ-independent: derived from local date/time
      // components, not a hardcoded UTC string (project convention for
      // fixed test timestamps).
      const sameCreatedAt = new Date(2024, 0, 1, 9, 0, 0);

      it("deletes both rows when the older id (smaller id) is the target", () => {
        const session = insertSession(db, { type: "adhoc" });
        const older = insertMessage(db, {
          session_id: session.id,
          role: "user",
          content: "古い方",
        });
        const newer = insertMessage(db, {
          session_id: session.id,
          role: "user",
          content: "新しい方",
        });
        setCreatedAt(db, older.id, sameCreatedAt);
        setCreatedAt(db, newer.id, sameCreatedAt);
        expect(
          findMessageInSession(db, session.id, older.id)?.created_at,
        ).toBe(findMessageInSession(db, session.id, newer.id)?.created_at);

        const deletedCount = deleteMessagesFrom(db, session.id, older.id);

        expect(deletedCount).toBe(2);
        expect(listMessagesBySessionId(db, session.id)).toEqual([]);
      });

      it("keeps the older row when the newer id (larger id) is the target", () => {
        const session = insertSession(db, { type: "adhoc" });
        const older = insertMessage(db, {
          session_id: session.id,
          role: "user",
          content: "古い方",
        });
        const newer = insertMessage(db, {
          session_id: session.id,
          role: "user",
          content: "新しい方",
        });
        setCreatedAt(db, older.id, sameCreatedAt);
        setCreatedAt(db, newer.id, sameCreatedAt);
        expect(
          findMessageInSession(db, session.id, older.id)?.created_at,
        ).toBe(findMessageInSession(db, session.id, newer.id)?.created_at);

        const deletedCount = deleteMessagesFrom(db, session.id, newer.id);

        expect(deletedCount).toBe(1);
        const remaining = listMessagesBySessionId(db, session.id);
        expect(remaining.map((m) => m.id)).toEqual([older.id]);
      });
    });
  });
});
