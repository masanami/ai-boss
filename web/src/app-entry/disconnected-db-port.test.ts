import { describe, expect, it, vi } from "vitest";
import { createDisconnectedDbPort, DbNotConnectedError } from "./disconnected-db-port";

describe("createDisconnectedDbPort", () => {
  it("run() rejects without executing SQL", async () => {
    const port = createDisconnectedDbPort();
    await expect(port.run("INSERT INTO tasks (title) VALUES (?)", ["x"])).rejects.toThrow(
      DbNotConnectedError,
    );
  });

  it("get() rejects without executing SQL", async () => {
    const port = createDisconnectedDbPort();
    await expect(port.get("SELECT 1")).rejects.toThrow(DbNotConnectedError);
  });

  it("all() rejects without executing SQL", async () => {
    const port = createDisconnectedDbPort();
    await expect(port.all("SELECT * FROM tasks")).rejects.toThrow(DbNotConnectedError);
  });

  it("exec() rejects without executing SQL", async () => {
    const port = createDisconnectedDbPort();
    await expect(port.exec("PRAGMA foreign_keys = ON")).rejects.toThrow(DbNotConnectedError);
  });

  it("transaction() rejects without calling the passed function", async () => {
    const port = createDisconnectedDbPort();
    const fn = vi.fn();

    await expect(port.transaction(fn)).rejects.toThrow(DbNotConnectedError);
    expect(fn).not.toHaveBeenCalled();
  });
});
