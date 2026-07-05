import { describe, expect, it, vi } from "vitest";
import { execFile as nodeExecFile } from "node:child_process";
import { sendNotification } from "./notifier.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function ok() {
  return Promise.resolve({ stdout: "", stderr: "" });
}

/** Timeout-shaped error, matching what Node's `child_process` passes to the
 * callback when a process is killed for exceeding its configured `timeout`
 * (see child_process docs: `killed: true`, `signal` set, no `code`). */
function timeoutError(): Error {
  return Object.assign(new Error("command timed out"), {
    killed: true,
    signal: "SIGTERM",
  });
}

describe("sendNotification", () => {
  it("calls terminal-notifier with -title and -message when it is available", async () => {
    const execFile = vi.fn().mockImplementation(ok);

    const result = await sendNotification(
      { title: "ボス", body: "そろそろ着手しよう" },
      { execFile },
    );

    expect(execFile).toHaveBeenCalledWith("terminal-notifier", [
      "-title",
      "ボス",
      "-message",
      "そろそろ着手しよう",
    ]);
    expect(result).toEqual({ delivered: true, channel: "terminal-notifier" });
  });

  it("appends -open <url> when a url is given", async () => {
    const execFile = vi.fn().mockImplementation(ok);

    await sendNotification(
      { title: "ボス", body: "着手しろ", url: "http://localhost:5173" },
      { execFile },
    );

    expect(execFile).toHaveBeenCalledWith("terminal-notifier", [
      "-title",
      "ボス",
      "-message",
      "着手しろ",
      "-open",
      "http://localhost:5173",
    ]);
  });

  it("does not call osascript when terminal-notifier succeeds", async () => {
    const execFile = vi.fn().mockImplementation(ok);

    await sendNotification({ title: "ボス", body: "着手しろ" }, { execFile });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalledWith(
      "osascript",
      expect.anything(),
    );
  });

  it("falls back to osascript when terminal-notifier is not available", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn terminal-notifier ENOENT"))
      .mockImplementationOnce(ok);

    const result = await sendNotification(
      { title: "ボス", body: "着手しろ" },
      { execFile },
    );

    expect(execFile).toHaveBeenNthCalledWith(1, "terminal-notifier", [
      "-title",
      "ボス",
      "-message",
      "着手しろ",
    ]);
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "osascript",
      expect.arrayContaining(["-e"]),
    );
    expect(result).toEqual({ delivered: true, channel: "osascript" });
  });

  it("embeds the title and body in the osascript display notification command", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockImplementationOnce(ok);

    await sendNotification({ title: "ボス", body: "着手しろ" }, { execFile });

    const [, script] = execFile.mock.calls[1] as [string, string[]];
    expect(script[0]).toBe("-e");
    expect(script[1]).toContain("着手しろ");
    expect(script[1]).toContain("ボス");
    expect(script[1]).toContain("display notification");
  });

  it("safely escapes double quotes in the body without breaking the osascript argument list", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockImplementationOnce(ok);

    await sendNotification(
      { title: "ボス", body: 'サボり"検知"だ' },
      { execFile },
    );

    const [, script] = execFile.mock.calls[1] as [string, string[]];
    expect(script).toHaveLength(2);
    expect(script[1]).toContain('\\"検知\\"');
  });

  it("normalizes newlines in the body so a multi-line Claude-generated message doesn't break the osascript string literal", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockImplementationOnce(ok);

    await sendNotification(
      { title: "ボス", body: "1行目\n2行目" },
      { execFile },
    );

    const [, script] = execFile.mock.calls[1] as [string, string[]];
    expect(script[1]).not.toContain("\n");
    expect(script[1]).toContain("1行目 2行目");
  });

  it("resolves without throwing and reports delivered:false when both commands fail", async () => {
    const execFile = vi.fn().mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await sendNotification(
      { title: "ボス", body: "着手しろ" },
      { execFile },
    );

    expect(result).toEqual({ delivered: false, channel: "none" });
    consoleErrorSpy.mockRestore();
  });

  it("resolves without throwing and reports delivered:false when both commands time out (killed for exceeding the configured timeout)", async () => {
    const execFile = vi.fn().mockRejectedValue(timeoutError());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sendNotification({ title: "ボス", body: "着手しろ" }, { execFile });

    expect(result).toEqual({ delivered: false, channel: "none" });
    consoleErrorSpy.mockRestore();
  });
});

describe("nodeSystemExecFile", () => {
  it("invokes child_process.execFile with a timeout so a hung notifier process cannot block the caller forever", async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: null, stdout: string, stderr: string) => void)(null, "", "");
      return {} as ReturnType<typeof nodeExecFile>;
    });

    const { nodeSystemExecFile } = await import("./notifier.js");
    await nodeSystemExecFile("terminal-notifier", ["-title", "t", "-message", "m"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "terminal-notifier",
      ["-title", "t", "-message", "m"],
      expect.objectContaining({ timeout: expect.any(Number) }),
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

    const { nodeSystemExecFile } = await import("./notifier.js");

    await expect(
      nodeSystemExecFile("terminal-notifier", ["-title", "t", "-message", "m"]),
    ).rejects.toThrow();
  });
});
