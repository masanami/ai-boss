import { execFile as nodeExecFile } from "node:child_process";

/**
 * macOS 通知アダプタ。`terminal-notifier` が利用可能ならそれを使い（クリックで
 * `url` を開ける）、未導入・実行失敗時は `osascript` の `display notification`
 * にフォールバックする（クリック時のアプリ起動は保証しない — 明示的な仮定、
 * Issue #37）。
 *
 * クリティカル設計: 子プロセス実行は `NotifierDeps.execFile` として DI する。
 * テストは必ずこれをモックし、実際の通知コマンドを起動しない。
 */

export interface NotificationPayload {
  title: string;
  body: string;
  /** クリック時に開く URL。terminal-notifier 経由のときのみクリックで開ける。 */
  url?: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface NotifierDeps {
  execFile: ExecFileFn;
}

export type NotificationChannel = "terminal-notifier" | "osascript" | "none";

export interface SendNotificationResult {
  delivered: boolean;
  channel: NotificationChannel;
}

/**
 * Hard timeout for the real system exec (added for the scheduler
 * integration, Issue #38 self-review): without it, a hung/misbehaving
 * `terminal-notifier`/`osascript` process would leave `sendNotification`'s
 * promise pending forever. Combined with the scheduler's concurrency guard
 * (`scheduler/scheduler-tick.ts`), an unresolved promise would keep that
 * guard's "a tick is in flight" flag stuck permanently, silently and
 * permanently halting all future ticks. `child_process.execFile` kills the
 * process and invokes the callback with an error once `timeout` elapses.
 */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * Real `execFile` for production wiring (injected by the scheduler —
 * `scheduler/scheduler.ts`). Thin wrapping, no branching logic of its own,
 * so it is intentionally left untested at the integration level here (same
 * convention as `server/src/index.ts`) — the timeout behavior itself is
 * covered by a dedicated unit test that mocks `node:child_process`.
 */
export const nodeSystemExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function buildTerminalNotifierArgs(payload: NotificationPayload): string[] {
  const args = ["-title", payload.title, "-message", payload.body];
  if (payload.url) {
    args.push("-open", payload.url);
  }
  return args;
}

/**
 * Escapes a string for embedding inside an AppleScript double-quoted string
 * literal (backslash and double-quote are AppleScript's own escape
 * characters, same as JSON). The escaped string is passed as a single
 * `execFile` argument (no shell involved), so this only needs to keep the
 * AppleScript string literal well-formed — it is not a shell-escaping
 * concern.
 *
 * Newlines are normalized to spaces: a literal line break inside the string
 * literal would break the `-e` script (unlike `-message` for
 * terminal-notifier, which accepts them fine). Claude-generated notification
 * bodies could in principle contain them, so this keeps the osascript
 * fallback robust even then.
 */
function escapeForAppleScriptString(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function buildOsascriptArgs(payload: NotificationPayload): string[] {
  const title = escapeForAppleScriptString(payload.title);
  const body = escapeForAppleScriptString(payload.body);
  return ["-e", `display notification "${body}" with title "${title}"`];
}

/**
 * Sends a macOS notification, preferring `terminal-notifier` and falling
 * back to `osascript`. Never throws: command failures (missing binary,
 * non-zero exit, etc.) are logged and reported via the returned result so a
 * misbehaving notification never stops the caller (the future scheduler).
 */
export async function sendNotification(
  payload: NotificationPayload,
  deps: NotifierDeps,
): Promise<SendNotificationResult> {
  try {
    await deps.execFile("terminal-notifier", buildTerminalNotifierArgs(payload));
    return { delivered: true, channel: "terminal-notifier" };
  } catch (terminalNotifierErr) {
    console.error(
      "terminal-notifier failed, falling back to osascript:",
      terminalNotifierErr instanceof Error
        ? terminalNotifierErr.name
        : typeof terminalNotifierErr,
    );
  }

  try {
    await deps.execFile("osascript", buildOsascriptArgs(payload));
    return { delivered: true, channel: "osascript" };
  } catch (osascriptErr) {
    console.error(
      "osascript fallback failed; notification was not delivered:",
      osascriptErr instanceof Error ? osascriptErr.name : typeof osascriptErr,
    );
    return { delivered: false, channel: "none" };
  }
}
