import { describe, expect, it } from "vitest";
import { createTestDb } from "./create-test-db.js";

describe("createTestDb", () => {
  it("returns a DbPort backed by a migrated :memory: database", async () => {
    const { db, raw } = await createTestDb();

    // マイグレーション済み（v10）であることを、実テーブルへの書き込みで
    // 確かめる（`tasks` は version 1 から存在する）。
    const result = await db.run(
      "INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)",
      ["テストタスク", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    expect(result.changes).toBe(1);

    const version = raw.pragma("user_version", { simple: true });
    expect(version).toBe(10);

    raw.close();
  });

  it("returns a distinct database for each call", async () => {
    const first = await createTestDb();
    const second = await createTestDb();

    expect(first.raw).not.toBe(second.raw);

    first.raw.close();
    second.raw.close();
  });
});
