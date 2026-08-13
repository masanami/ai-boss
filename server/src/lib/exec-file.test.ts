import { describe, expect, it, vi } from "vitest";
import { execFile as nodeExecFile } from "node:child_process";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const { createTimedExecFile } = await import("./exec-file.js");

/** Timeout-shaped error, matching what Node's `child_process` passes to the
 * callback when a process is killed for exceeding its configured `timeout`
 * (see child_process docs: `killed: true`, `signal` set, no `code`) —
 * mirrors `notifications/notifier.test.ts`'s `timeoutError` helper. */
function timeoutError(): Error {
  return Object.assign(new Error("command timed out"), {
    killed: true,
    signal: "SIGTERM",
  });
}

describe("createTimedExecFile", () => {
  it("invokes child_process.execFile with the given timeout so a hung process cannot block the caller forever", async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: null, stdout: string, stderr: string) => void)(null, "2.1.231", "");
      return {} as ReturnType<typeof nodeExecFile>;
    });

    const execFile = createTimedExecFile(5_000);
    const result = await execFile("/opt/claude", ["--version"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "/opt/claude",
      ["--version"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
    expect(result).toEqual({ stdout: "2.1.231", stderr: "" });
  });

  it("passes the given env through to child_process.execFile's own env option (replaces, not merges)", async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: null, stdout: string, stderr: string) => void)(null, "", "");
      return {} as ReturnType<typeof nodeExecFile>;
    });
    const env = { PATH: "/usr/bin" };

    const execFile = createTimedExecFile(5_000, { env });
    await execFile("/opt/claude", ["--version"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "/opt/claude",
      ["--version"],
      expect.objectContaining({ env }),
      expect.any(Function),
    );
  });

  it("rejects (without leaving the promise pending forever) when execFile reports a timeout", async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: Error, stdout: string, stderr: string) => void)(
        timeoutError(),
        "",
        "",
      );
      return {} as ReturnType<typeof nodeExecFile>;
    });

    const execFile = createTimedExecFile(5_000);

    await expect(execFile("/opt/claude", ["--version"])).rejects.toThrow(/timed out/);
  });

  it("rejects with an ENOENT-coded error when the executable does not exist", async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: NodeJS.ErrnoException, stdout: string, stderr: string) => void)(
        Object.assign(new Error("spawn /opt/claude ENOENT"), { code: "ENOENT" }),
        "",
        "",
      );
      return {} as ReturnType<typeof nodeExecFile>;
    });

    const execFile = createTimedExecFile(5_000);

    await expect(execFile("/opt/claude", ["--version"])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
