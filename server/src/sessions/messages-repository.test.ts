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
  listTodaysAdhocMessages,
} from "./messages-repository.js";
import type { Message } from "./message.js";

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

  describe("listTodaysAdhocMessages", () => {
    it("returns an empty array when there are no adhoc messages today", () => {
      const now = new Date(2026, 6, 6, 10, 0);

      expect(listTodaysAdhocMessages(db, now)).toEqual([]);
    });

    it("returns messages with the same created_at in id ascending order", () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const session = insertSession(db, { type: "adhoc" });
      const sameTimestamp = new Date(2026, 6, 6, 9, 0);
      // 同一 created_at のメッセージを2件挿入し、結果が id 昇順という決定的な
      // 順序になることを固定する（`listMessagesBySessionId` と同じ契約）。
      // 注記: messages.id は SQLite の rowid エイリアスであり、created_at の
      // 索引が無い現行スキーマではテーブルスキャン自体が常に rowid(=id) 昇順
      // で行われるため、`ORDER BY ... id ASC` 句の有無を出力順の差だけで
      // 機械的に判別することはできない（実測済み）。このテストは「id 昇順
      // で返る」という公開契約をドキュメントとして固定するものであり、
      // 句そのものの必要性の証明ではない。
      const insertedFirst = insertAt(session.id, "user", "1件目", sameTimestamp);
      const insertedSecond = insertAt(session.id, "boss", "2件目", sameTimestamp);

      const result = listTodaysAdhocMessages(db, now);

      expect(result.map((m) => m.id)).toEqual([
        insertedFirst.id,
        insertedSecond.id,
      ]);
    });

    it("returns full Message rows, not just ids", () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const session = insertSession(db, { type: "adhoc" });
      const message = insertAt(
        session.id,
        "user",
        "今日の随時相談",
        new Date(2026, 6, 6, 9, 0),
      );

      const result = listTodaysAdhocMessages(db, now);

      expect(result).toEqual([message]);
    });

    it("merges messages from multiple adhoc sessions in chronological order", () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const sessionA = insertSession(db, { type: "adhoc" });
      const sessionB = insertSession(db, { type: "adhoc" });
      // sessionB の発言のほうが後に作られたセッションだが created_at は早い、
      // という配置にすることで、セッション横断のマージが created_at 主導で
      // あり、セッションの挿入順・id 順に頼っていないことを検証する。
      const laterFromA = insertAt(
        sessionA.id,
        "user",
        "Aの発言(created_atは遅い)",
        new Date(2026, 6, 6, 9, 30),
      );
      const earlierFromB = insertAt(
        sessionB.id,
        "user",
        "Bの発言(created_atは早い)",
        new Date(2026, 6, 6, 9, 0),
      );

      const result = listTodaysAdhocMessages(db, now);

      expect(result.map((m) => m.id)).toEqual([
        earlierFromB.id,
        laterFromA.id,
      ]);
    });

    it("excludes messages belonging to non-adhoc (morning/evening) sessions", () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const adhocSession = insertSession(db, { type: "adhoc" });
      const morningSession = insertSession(db, { type: "morning" });
      const eveningSession = insertSession(db, { type: "evening" });
      const adhocMessage = insertAt(
        adhocSession.id,
        "user",
        "随時セッションの発言",
        new Date(2026, 6, 6, 9, 0),
      );
      insertAt(
        morningSession.id,
        "user",
        "朝会の発言",
        new Date(2026, 6, 6, 9, 0),
      );
      insertAt(
        eveningSession.id,
        "user",
        "夕会の発言",
        new Date(2026, 6, 6, 9, 0),
      );

      const result = listTodaysAdhocMessages(db, now);

      expect(result.map((m) => m.id)).toEqual([adhocMessage.id]);
    });

    it("ignores a message created on a previous local day while including one created exactly at today's local 00:00:00.000 (inclusive lower bound)", () => {
      const now = new Date(2026, 6, 6, 9, 0);
      const session = insertSession(db, { type: "adhoc" });
      insertAt(session.id, "user", "前日の発言", new Date(2026, 6, 5, 23, 59, 59, 999));
      const todayStart = insertAt(
        session.id,
        "user",
        "当日0時ちょうどの発言",
        new Date(2026, 6, 6, 0, 0, 0, 0),
      );

      const result = listTodaysAdhocMessages(db, now);

      expect(result.map((m) => m.id)).toEqual([todayStart.id]);
    });

    it("ignores a message created exactly at the next local day's 00:00:00.000 while keeping one created at 23:59:59.999 (half-open interval upper bound)", () => {
      const now = new Date(2026, 6, 6, 15, 0);
      const session = insertSession(db, { type: "adhoc" });
      const lastMoment = insertAt(
        session.id,
        "user",
        "当日23:59:59.999の発言",
        new Date(2026, 6, 6, 23, 59, 59, 999),
      );
      insertAt(
        session.id,
        "user",
        "翌日0時ちょうどの発言",
        new Date(2026, 6, 7, 0, 0, 0, 0),
      );

      const result = listTodaysAdhocMessages(db, now);

      expect(result.map((m) => m.id)).toEqual([lastMoment.id]);
    });
  });

  // insertMessage はサーバー管理の created_at (`new Date().toISOString()`) を
  // 使うため、任意の日時を持つメッセージを作るには created_at を直接指定した
  // INSERT が要る（today-escalation.test.ts の insertAt と同じ手法。ADR 0007
  // 決定5: 固定時刻は new Date(y, m, d, h, mi, s, ms) から導出し TZ 非依存にする）。
  function insertAt(
    sessionId: number,
    role: "user" | "boss",
    content: string,
    createdAt: Date,
  ): Message {
    const result = db
      .prepare(
        `INSERT INTO messages (session_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, role, content, createdAt.toISOString());

    return db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Message;
  }
});
