import { describe, expect, it, vi } from "vitest";
import { sendNotification } from "./notifier.js";

function ok() {
  return Promise.resolve({ stdout: "", stderr: "" });
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
});
