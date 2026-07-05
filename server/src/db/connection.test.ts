import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";

describe("openDatabase", () => {
  it("opens an in-memory database and enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");

    const result = db.pragma("foreign_keys", { simple: true });

    expect(result).toBe(1);

    db.close();
  });

  describe("when the parent directory of the db file does not exist yet", () => {
    let tempRoot: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), "ai-boss-connection-test-"));
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it("creates the parent directory and opens the database", () => {
      const dbPath = join(tempRoot, "nested", "dir", "ai-boss.db");

      const db = openDatabase(dbPath);

      expect(() => db.pragma("foreign_keys", { simple: true })).not.toThrow();

      db.close();
    });
  });
});
