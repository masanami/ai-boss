import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/transitional-bridge.js";
import { insertSession } from "./sessions-repository.js";
import {
  countUserMessagesBySessionId,
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

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(async () => {
    db.close();
  });

  describe("insertMessage", () => {
    it("inserts a message with a server-managed created_at", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });

      const message = await insertMessage(portFor(db), {
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
    it("returns an empty array when the session has no messages", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });

      expect(await listMessagesBySessionId(portFor(db), session.id)).toEqual([]);
    });

    it("returns messages ordered by created_at ascending", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const first = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "最初の発言",
      });
      const second = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });

      const result = await listMessagesBySessionId(portFor(db), session.id);

      expect(result.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it("does not return messages belonging to other sessions", async () => {
      const sessionA = await insertSession(portFor(db), { type: "adhoc" });
      const sessionB = await insertSession(portFor(db), { type: "morning" });
      await insertMessage(portFor(db), {
        session_id: sessionA.id,
        role: "user",
        content: "Aへの発言",
      });
      const messageB = await insertMessage(portFor(db), {
        session_id: sessionB.id,
        role: "user",
        content: "Bへの発言",
      });

      const result = await listMessagesBySessionId(portFor(db), sessionB.id);

      expect(result.map((m) => m.id)).toEqual([messageB.id]);
    });
  });

  describe("findMessageInSession", () => {
    it("returns the message when it belongs to the given session", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const message = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "資料を確認します",
      });

      expect(await findMessageInSession(portFor(db), session.id, message.id)).toEqual(
        message,
      );
    });

    it("returns undefined when the id belongs to a different session (AC-7)", async () => {
      const sessionA = await insertSession(portFor(db), { type: "adhoc" });
      const sessionB = await insertSession(portFor(db), { type: "morning" });
      const messageInB = await insertMessage(portFor(db), {
        session_id: sessionB.id,
        role: "user",
        content: "Bでの発言",
      });

      expect(await findMessageInSession(portFor(db), sessionA.id, messageInB.id)).toBeUndefined();
    });

    it("returns undefined when the id does not exist at all", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });

      expect(await findMessageInSession(portFor(db), session.id, 999_999)).toBeUndefined();
    });
  });

  describe("deleteMessagesFrom", () => {
    it("deletes the target message itself (AC-1)", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const target = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });

      await deleteMessagesFrom(portFor(db), session.id, target.id);

      expect(await findMessageInSession(portFor(db), session.id, target.id)).toBeUndefined();
    });

    it("deletes every later message in the same session regardless of role (AC-2)", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const target = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });
      const bossReply = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });
      const laterUserMessage = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "その後の発言",
      });

      const deletedCount = await deleteMessagesFrom(portFor(db), session.id, target.id);

      expect(deletedCount).toBe(3);
      expect(await listMessagesBySessionId(portFor(db), session.id)).toEqual([]);
      expect(
        await findMessageInSession(portFor(db), session.id, bossReply.id),
      ).toBeUndefined();
      expect(
        await findMessageInSession(portFor(db), session.id, laterUserMessage.id),
      ).toBeUndefined();
    });

    it("does not delete earlier messages in the same session (AC-3)", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const earlier = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "最初の発言",
      });
      const target = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });

      await deleteMessagesFrom(portFor(db), session.id, target.id);

      const remaining = await listMessagesBySessionId(portFor(db), session.id);
      expect(remaining.map((m) => m.id)).toEqual([earlier.id]);
    });

    it("does not delete messages belonging to other sessions (AC-4)", async () => {
      const sessionA = await insertSession(portFor(db), { type: "adhoc" });
      const sessionB = await insertSession(portFor(db), { type: "morning" });
      const target = await insertMessage(portFor(db), {
        session_id: sessionA.id,
        role: "user",
        content: "Aの書き直したい発言",
      });
      const otherSessionMessage = await insertMessage(portFor(db), {
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
      const expectedOtherSessionMessage = await findMessageInSession(
        portFor(db),
        sessionB.id,
        otherSessionMessage.id,
      );
      expect(
        (await findMessageInSession(portFor(db), sessionA.id, target.id))!.created_at <
          expectedOtherSessionMessage!.created_at,
      ).toBe(true);

      const deletedCount = await deleteMessagesFrom(portFor(db), sessionA.id, target.id);

      expect(deletedCount).toBe(1);
      expect(await findMessageInSession(portFor(db), sessionA.id, target.id)).toBeUndefined();
      expect(
        await findMessageInSession(portFor(db), sessionB.id, otherSessionMessage.id),
      ).toEqual(expectedOtherSessionMessage);
    });

    it("returns 0 and deletes nothing when fromMessageId does not belong to the session", async () => {
      const sessionA = await insertSession(portFor(db), { type: "adhoc" });
      const sessionB = await insertSession(portFor(db), { type: "morning" });
      const messageInB = await insertMessage(portFor(db), {
        session_id: sessionB.id,
        role: "user",
        content: "Bへの発言",
      });

      const deletedCount = await deleteMessagesFrom(portFor(db), sessionA.id, messageInB.id);

      expect(deletedCount).toBe(0);
      expect(await findMessageInSession(portFor(db), sessionB.id, messageInB.id)).toEqual(
        messageInB,
      );
    });

    it("returns the number of deleted rows (AC-6)", async () => {
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const target = await insertMessage(portFor(db), {
        session_id: session.id,
        role: "user",
        content: "書き直したい発言",
      });
      await insertMessage(portFor(db), {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });

      const deletedCount = await deleteMessagesFrom(portFor(db), session.id, target.id);

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

      it("deletes both rows when the older id (smaller id) is the target", async () => {
        const session = await insertSession(portFor(db), { type: "adhoc" });
        const older = await insertMessage(portFor(db), {
          session_id: session.id,
          role: "user",
          content: "古い方",
        });
        const newer = await insertMessage(portFor(db), {
          session_id: session.id,
          role: "user",
          content: "新しい方",
        });
        setCreatedAt(db, older.id, sameCreatedAt);
        setCreatedAt(db, newer.id, sameCreatedAt);
        expect(
          (await findMessageInSession(portFor(db), session.id, older.id))?.created_at,
        ).toBe((await findMessageInSession(portFor(db), session.id, newer.id))?.created_at);

        const deletedCount = await deleteMessagesFrom(portFor(db), session.id, older.id);

        expect(deletedCount).toBe(2);
        expect(await listMessagesBySessionId(portFor(db), session.id)).toEqual([]);
      });

      it("keeps the older row when the newer id (larger id) is the target", async () => {
        const session = await insertSession(portFor(db), { type: "adhoc" });
        const older = await insertMessage(portFor(db), {
          session_id: session.id,
          role: "user",
          content: "古い方",
        });
        const newer = await insertMessage(portFor(db), {
          session_id: session.id,
          role: "user",
          content: "新しい方",
        });
        setCreatedAt(db, older.id, sameCreatedAt);
        setCreatedAt(db, newer.id, sameCreatedAt);
        expect(
          (await findMessageInSession(portFor(db), session.id, older.id))?.created_at,
        ).toBe((await findMessageInSession(portFor(db), session.id, newer.id))?.created_at);

        const deletedCount = await deleteMessagesFrom(portFor(db), session.id, newer.id);

        expect(deletedCount).toBe(1);
        const remaining = await listMessagesBySessionId(portFor(db), session.id);
        expect(remaining.map((m) => m.id)).toEqual([older.id]);
      });
    });
  });

  describe("listTodaysAdhocMessages", () => {
    it("returns an empty array when there are no adhoc messages today", async () => {
      const now = new Date(2026, 6, 6, 10, 0);

      expect(await listTodaysAdhocMessages(portFor(db), now)).toEqual([]);
    });

    it("returns messages with the same created_at in id ascending order", async () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const session = await insertSession(portFor(db), { type: "adhoc" });
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

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result.map((m) => m.id)).toEqual([
        insertedFirst.id,
        insertedSecond.id,
      ]);
    });

    it("returns full Message rows, not just ids", async () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const session = await insertSession(portFor(db), { type: "adhoc" });
      const message = insertAt(
        session.id,
        "user",
        "今日の随時相談",
        new Date(2026, 6, 6, 9, 0),
      );

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result).toEqual([message]);
    });

    it("merges messages from multiple adhoc sessions in chronological order", async () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const sessionA = await insertSession(portFor(db), { type: "adhoc" });
      const sessionB = await insertSession(portFor(db), { type: "adhoc" });
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

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result.map((m) => m.id)).toEqual([
        earlierFromB.id,
        laterFromA.id,
      ]);
    });

    it("excludes messages belonging to non-adhoc (morning/evening) sessions", async () => {
      const now = new Date(2026, 6, 6, 10, 0);
      const adhocSession = await insertSession(portFor(db), { type: "adhoc" });
      const morningSession = await insertSession(portFor(db), { type: "morning" });
      const eveningSession = await insertSession(portFor(db), { type: "evening" });
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

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result.map((m) => m.id)).toEqual([adhocMessage.id]);
    });

    it("ignores a message created on a previous local day while including one created exactly at today's local 00:00:00.000 (inclusive lower bound)", async () => {
      const now = new Date(2026, 6, 6, 9, 0);
      const session = await insertSession(portFor(db), { type: "adhoc" });
      insertAt(session.id, "user", "前日の発言", new Date(2026, 6, 5, 23, 59, 59, 999));
      const todayStart = insertAt(
        session.id,
        "user",
        "当日0時ちょうどの発言",
        new Date(2026, 6, 6, 0, 0, 0, 0),
      );

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result.map((m) => m.id)).toEqual([todayStart.id]);
    });

    it("ignores a message created exactly at the next local day's 00:00:00.000 while keeping one created at 23:59:59.999 (half-open interval upper bound)", async () => {
      const now = new Date(2026, 6, 6, 15, 0);
      const session = await insertSession(portFor(db), { type: "adhoc" });
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

      const result = await listTodaysAdhocMessages(portFor(db), now);

      expect(result.map((m) => m.id)).toEqual([lastMoment.id]);
    });
  });

  // #276 判断3: 朝会終了ゲート（mentoring-gate.ts）が読む「対象セッションの
  // role='user' 件数」。判定に使う純粋関数 isMentoringComplete への入力を
  // 用意する側の責務であり、boss のメッセージや他セッションのメッセージは
  // 数えない。
  describe("countUserMessagesBySessionId", () => {
    it("returns 0 when the session has no messages at all", async () => {
      const session = await insertSession(portFor(db), { type: "morning" });

      expect(await countUserMessagesBySessionId(portFor(db), session.id)).toBe(0);
    });

    it("counts only role='user' messages, excluding role='boss' messages in the same session", async () => {
      const session = await insertSession(portFor(db), { type: "morning" });
      await insertMessage(portFor(db), { session_id: session.id, role: "boss", content: "おはよう" });
      await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });

      expect(await countUserMessagesBySessionId(portFor(db), session.id)).toBe(1);
    });

    it("excludes role='user' messages that belong to a different session", async () => {
      const target = await insertSession(portFor(db), { type: "morning" });
      const other = await insertSession(portFor(db), { type: "morning" });
      await insertMessage(portFor(db), { session_id: other.id, role: "user", content: "他セッションの発言" });

      expect(await countUserMessagesBySessionId(portFor(db), target.id)).toBe(0);
    });

    it("counts multiple user messages in the same session", async () => {
      const session = await insertSession(portFor(db), { type: "morning" });
      await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "発言1" });
      await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "発言2" });

      expect(await countUserMessagesBySessionId(portFor(db), session.id)).toBe(2);
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
