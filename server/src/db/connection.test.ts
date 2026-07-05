import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";

describe("openDatabase", () => {
  it("opens an in-memory database and enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");

    const result = db.pragma("foreign_keys", { simple: true });

    expect(result).toBe(1);

    db.close();
  });
});
