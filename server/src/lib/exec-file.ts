import { execFile as nodeChildProcessExecFile } from "node:child_process";

/**
 * Generic `execFile`-shaped DI contract (file + args in, `{stdout, stderr}`
 * out, no shell involved). Callers that spawn a short-lived helper process
 * inject this so tests can supply a fake instead of exercising a real
 * subprocess. Mirrors `notifications/notifier.ts`'s private `ExecFileFn` /
 * `nodeSystemExecFile` pattern — that module is left untouched here (it is a
 * "クリティカル箇所"（通知の実行系）per the project CLAUDE.md, so this ticket
 * does not modify it) — but is exported here so new call sites (starting
 * with `llm/backends/claude-code-backend.ts`'s FR-13 startup availability
 * check) share one implementation instead of hand-duplicating the
 * Promise/timeout wrapper per module (self-review: code-reviewer/
 * design-reviewer both flagged the duplication when this lived inline in
 * `claude-code-backend.ts`).
 */
export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Builds a real {@link ExecFileFn} with an explicit hard timeout —
 * `child_process.execFile`'s own `timeout` option kills the subprocess and
 * invokes the callback with an error once `timeoutMs` elapses, so a hung
 * process can never leave the returned promise pending forever (same
 * discipline as `notifications/notifier.ts`'s `EXEC_TIMEOUT_MS`).
 *
 * `env`, when given, is passed through verbatim to `child_process.execFile`'s
 * own `env` option (which, like the Agent SDK's `query()` `env` option,
 * *replaces* rather than merges with the subprocess environment) — callers
 * that need to strip/augment specific variables (e.g.
 * `claude-code-backend.ts`'s `buildClaudeCodeEnv`, which excludes
 * `ANTHROPIC_API_KEY`) build that object themselves and pass it in, so this
 * module stays domain-agnostic.
 */
export function createTimedExecFile(
  timeoutMs: number,
  options: { env?: NodeJS.ProcessEnv } = {},
): ExecFileFn {
  return (file, args) =>
    new Promise((resolve, reject) => {
      nodeChildProcessExecFile(
        file,
        args,
        { timeout: timeoutMs, env: options.env },
        (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}
