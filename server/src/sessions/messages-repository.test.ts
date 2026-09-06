import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "./sessions-repository.js";
import {
  insertMessage,
  listMessagesBySessionId,
  listTodaysAdhocMessages,
} from "./messages-repository.js";
import type { Message } from "./message.js";

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
