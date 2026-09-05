import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { listTodaysSessionTypes } from "./todays-sessions.js";

function insertSessionAt(db: Database.Database, type: "morning" | "evening" | "adhoc", startedAt: string): void {
  const session = insertSession(db, { type });
  db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(startedAt, session.id);
}

describe("listTodaysSessionTypes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when no sessions have been started today", () => {
    insertSessionAt(db, "morning", "2026-07-04T09:00:00");

    const result = listTodaysSessionTypes(db, new Date(2026, 6, 5, 12, 0, 0));

    expect(result).toEqual([]);
  });

  it("includes session types started today, excluding other days", () => {
    insertSessionAt(db, "morning", "2026-07-05T09:00:00");
    insertSessionAt(db, "evening", "2026-07-04T18:00:00");

    const result = listTodaysSessionTypes(db, new Date(2026, 6, 5, 12, 0, 0));

    expect(result).toEqual(["morning"]);
  });

  it("de-duplicates repeated session types on the same day", () => {
    insertSessionAt(db, "adhoc", "2026-07-05T09:00:00");
    insertSessionAt(db, "adhoc", "2026-07-05T10:00:00");

    const result = listTodaysSessionTypes(db, new Date(2026, 6, 5, 12, 0, 0));

    expect(result).toEqual(["adhoc"]);
  });

  // #305: 上記3件の固定時刻（09:00/10:00/12:00/18:00）はローカル日と UTC 日が
  // 一致する帯なので、`toDateKey` がローカル暦日（getFullYear/getMonth/getDate）
  // ではなく UTC 暦日（toISOString().slice(0,10) 相当）に退行しても、Asia/Tokyo・
  // America/New_York のいずれでも検出できない（実測済み）。本ケースはローカル
  // 深夜前後（23:30・00:30）の2フィクスチャで両方向をカバーする:
  // 23:30 側は America/New_York（UTC-4/-5、深夜がUTC翌日に繰り上がる）で退行を
  // 検出でき、これは `npm run test:tz`（`TZ=America/New_York`）が実行するので
  // スクリプト化された実行で担保される。00:30 側は Asia/Tokyo（UTC+9、早朝が
  // UTC前日に繰り下がる）でのみ退行を検出でき、`package.json` の `test:tz` は
  // America/New_York のみのため、Asia/Tokyo での実行は手動実測でのみ確認済み
  // （スクリプト化はしていない）。両方とも `TZ=<該当TZ> npm test` で実際に fail
  // することを実測確認済み。
  it("classifies a session started near local midnight by the local calendar day, not the UTC day", () => {
    // production の保存形式（sessions-repository.ts の `new Date().toISOString()`）
    // に合わせ、ローカル構成の Date から toISOString() で Z 付き UTC 文字列を作る。
    insertSessionAt(db, "morning", new Date(2026, 6, 5, 0, 30, 0).toISOString());
    insertSessionAt(db, "evening", new Date(2026, 6, 5, 23, 30, 0).toISOString());

    const result = listTodaysSessionTypes(db, new Date(2026, 6, 5, 12, 0, 0));

    expect(result.sort()).toEqual(["evening", "morning"]);
  });
});
