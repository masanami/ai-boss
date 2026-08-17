import { createRequire } from "node:module";
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BossContentBlock,
  BossLlmMessage,
  BossToolExecutor,
  OnTextDelta,
  OnToolEvent,
} from "../claude-client.js";
import { SWITCH_TO_API_BACKEND_HINT } from "../../config.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../tasks/task.js";
import { APPEAL_VERDICTS } from "../../decisions/appeal.js";
import { createTimedExecFile, type ExecFileFn } from "../../lib/exec-file.js";

/**
 * `claude-code` backend (Issue #79): calls the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, which drives a local Claude Code
 * execution environment authenticated via the owner's subscription login)
 * instead of the Claude API directly.
 *
 * クリティカル設計決定（docs/features/claude-code-backend.md）:
 * - カスタムツールは in-process MCP サーバ（`createSdkMcpServer` / `tool()`）
 *   として提供する。既存の JSON Schema（`boss-tools.ts` / `task-tools.ts` /
 *   `verdict-tool.ts` / `reports/evening-summary-tool.ts`）は単一ソースとして
 *   変更しない。Zod スキーマはこのファイル内に閉じて手書きし、整合はユニット
 *   テストで担保する（`TOOL_ZOD_SHAPES` を参照）。
 * - 「補足決定（ツール実行主体の一本化）」: サーバ側の実行関数を持つツール
 *   （`create_task` / `update_task` / `record_decision` — DB 書き込み。
 *   `get_activity_log`（Issue #150） — DB 読み出しのみだが同じ経路）は MCP
 *   ハンドラが実行主体となり、`callbacks.executeTool`（呼び出し元が
 *   db/sessionId をクロージャで束縛済み）をハンドラ内から一度だけ呼ぶ。呼び出し元
 *   （`claude-client.ts`）はこの結果を tool_use として再実行しない
 *   （`streamBossMessage` は claude-code バックエンド時、単一 dispatch のみ
 *   行い MAX_TOOL_ROUNDS ループを回さない — 詳細は `claude-client.ts`）。
 * - `submit_verdict` はツール実行関数を持たない（DB 書き込みは呼び出し元の
 *   `appeals-route.ts` がトランザクションで行う）。MCP ハンドラは入力を
 *   捕捉して受理応答を返すのみで、検証（`parseVerdictToolInput`）は既存の
 *   `requestVerdict`（`claude-client.ts`）が返り値の tool_use ブロックに
 *   対して行う — API バックエンドと同じ経路を通すことで検証ロジックの
 *   重複を避ける。`submit_evening_summary`（Issue #108）も同じ理由・同じ
 *   経路で非実行ツールとして扱う（`buildSubmitEveningSummaryTool` 参照）。
 */

const MCP_SERVER_NAME = "ai-boss";
const MCP_TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function mcpToolName(name: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${name}`;
}

/**
 * FR-06 / AC-05 (layer 5 — deny-by-default permission handler): builds the
 * `canUseTool` callback passed to `query()`. `allowedTools` only
 * auto-approves our own MCP tools; it does not by itself reject a request
 * for anything else, and the spec's multi-layer decision explicitly forbids
 * relying on the allow-list alone. This handler is the app-owned boundary
 * where any tool request outside the fully-qualified allow-list is denied —
 * which also makes AC-05's "未許可ツールの使用要求は拒否する" verifiable in
 * unit tests without depending on SDK-internal behavior.
 */
function buildCanUseTool(allowedTools: readonly string[]) {
  return async (toolName: string): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> =>
    allowedTools.includes(toolName)
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          message: `Tool "${toolName}" is not permitted: this app only allows its own MCP tools (${
            allowedTools.length > 0 ? allowedTools.join(", ") : "none for this request"
          }).`,
        };
}

/**
 * The model calls in-process MCP tools by their fully-qualified name
 * (`mcp__<server>__<tool>` — see `mcpToolName`/`allowedTools` above and
 * `sdk.d.ts`'s `disallowedTools`/`mcp_call` doc comments for the same
 * qualification scheme), so `SDKAssistantMessage`'s `tool_use` blocks carry
 * that qualified name too. Strip it back to the bare name our own callers
 * use (`requestVerdict`'s `toolName` match, `executeBossTool`'s dispatch)
 * before surfacing a `tool_use` block in the normalized `BossLlmMessage` —
 * self-review caught this: without stripping, claude-code re-adjudication
 * would never match `toolName === "submit_verdict"` and always resolve to
 * `{called: false}` (HTTP 500), since `requestVerdict` compares against the
 * bare name.
 */
function unqualifyToolName(name: string): string {
  return name.startsWith(MCP_TOOL_NAME_PREFIX) ? name.slice(MCP_TOOL_NAME_PREFIX.length) : name;
}

// ---------------------------------------------------------------------------
// Zod スキーマ（既存 JSON Schema の手書き対応。整合はテストで担保 — 変換
// ライブラリは追加しない、というクリティカル設計決定に従う）
// ---------------------------------------------------------------------------

const createTaskShape = {
  title: z.string().describe("タスクのタイトル（必須）"),
  description: z.string().describe("詳細説明").optional(),
  priority: z.enum(TASK_PRIORITIES).describe("優先度").optional(),
  due_at: z.string().describe("締切（ISO 8601 日時文字列）").optional(),
  estimated_minutes: z.number().int().describe("所要時間見積もり（分）").optional(),
  boss_comment: z.string().describe("ボスの決定・コメント").optional(),
};

const updateTaskShape = {
  id: z.number().int().describe("更新対象タスクの id（必須）"),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  due_at: z.string().describe("締切（ISO 8601 日時文字列）").optional(),
  status: z.enum(TASK_STATUSES).optional(),
  boss_comment: z.string().optional(),
  estimated_minutes: z.number().int().optional(),
};

const recordDecisionShape = {
  content: z.string().describe("決定内容（必須）"),
  rationale: z.string().describe("決定の根拠").optional(),
  task_id: z.number().int().describe("関連するタスクの id").optional(),
};

const getActivityLogShape = {
  task_id: z.number().int().describe("絞り込み対象のタスクの id").optional(),
  since: z
    .string()
    .describe(
      "この日時（ISO 8601 文字列。YYYY-MM-DD のみの指定はローカル日の0時として扱う）以降のイベントに絞り込む。省略時は task_id 指定時は全期間、未指定時は当日ローカル0時以降。",
    )
    .optional(),
  until: z
    .string()
    .describe(
      "この日時（ISO 8601 文字列。YYYY-MM-DD のみの指定はローカル日の23:59:59として扱う）以前のイベントに絞り込む",
    )
    .optional(),
};

const submitVerdictShape = {
  verdict: z.enum(APPEAL_VERDICTS).describe("裁定結果。維持なら upheld、修正するなら revised。"),
  response: z.string().describe("ボスの再裁定文（ユーザーに提示する説明・断言）"),
  revised_content: z.string().describe("verdict が revised の場合の修正後の決定内容（必須）").optional(),
  revised_rationale: z.string().describe("修正の根拠").optional(),
};

/** 日報生成（Issue #108）の値の抽出ステップで使う `submit_evening_summary`
 * の Zod 対応。`submit_verdict` と同じく DB 書き込みを伴わない「値の報告」
 * ツールで、3値はすべて必須（JSON Schema 側 `evening-summary-tool.ts` の
 * `required` と一致 — 整合はテストで担保）。 */
const submitEveningSummaryShape = {
  report_summary: z.string().describe("ユーザーが夕会で報告した内容の要点（平文・簡潔に）"),
  boss_comment: z.string().describe("その報告に対するボスの講評・評価コメント（平文・簡潔に）"),
  carry_over: z
    .string()
    .describe("翌日への持ち越し事項の要約。持ち越しが無い場合は「なし」と書くこと（空文字は不可）。"),
};

/**
 * Exported so a unit test can assert the Zod shapes' keys/required-ness stay
 * aligned with the JSON Schema tool definitions (`BOSS_TOOLS`,
 * `SUBMIT_VERDICT_TOOL`, `SUBMIT_EVENING_SUMMARY_TOOL`) that remain the
 * single source of truth.
 */
export const TOOL_ZOD_SHAPES = {
  create_task: createTaskShape,
  update_task: updateTaskShape,
  record_decision: recordDecisionShape,
  get_activity_log: getActivityLogShape,
  submit_verdict: submitVerdictShape,
  submit_evening_summary: submitEveningSummaryShape,
} as const;

/** Tool names with their own non-executing handler (report-a-value tools;
 * see `buildSubmitVerdictTool` / `buildSubmitEveningSummaryTool`). Kept as a
 * single source alongside `EXECUTED_TOOL_NAMES` below rather than
 * duplicating the literal list. */
const NON_EXECUTING_TOOL_NAMES = new Set(["submit_verdict", "submit_evening_summary"]);

/** Derived from `TOOL_ZOD_SHAPES` (minus the non-executing tools above, each
 * of which has its own handler) rather than a separately hand-maintained
 * literal list, so there is a single place to add a new tool that goes
 * through `callbacks.executeTool` (self-review: avoid triple bookkeeping
 * across `BOSS_TOOLS`, `TOOL_ZOD_SHAPES`, and this set). The classification
 * axis here is "has a server-side executor function reached via
 * `executeTool`", not "writes to the DB" — `get_activity_log` (Issue #150)
 * is a DB-read-only tool that still belongs in this set, since it is
 * dispatched through the same `executeBossTool`/`executeTool` path as the
 * DB-writing tools above it. */
const EXECUTED_TOOL_NAMES = new Set(
  Object.keys(TOOL_ZOD_SHAPES).filter((name) => !NON_EXECUTING_TOOL_NAMES.has(name)),
);

// ---------------------------------------------------------------------------
// プロンプト構築（ステートレス方式: DB から再構築した履歴を毎回全文送信する
// という補足決定を、Agent SDK の単一 prompt 文字列インターフェースの上で
// 実現する。単一ユーザーターンのみの場合はそのままテキストを渡し、複数
// ターンの場合はロール付きの平文トランスクリプトに整形する。会話履歴には
// tool_use/tool_result ブロックは含まれない — ルートから渡される
// `request.messages` は DB 由来のプレーンテキスト往復のみで、途中経過の
// ツール呼び出しは MCP ハンドラ内で完結し履歴化されないため）。
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = { user: "User", assistant: "Boss" };

function extractMessageText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => ("text" in block && block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

export function buildClaudeCodePrompt(messages: Anthropic.MessageParam[]): string {
  if (messages.length === 0) {
    return "";
  }
  if (messages.length === 1 && messages[0].role === "user") {
    return extractMessageText(messages[0].content);
  }
  return messages
    .map((message) => `${ROLE_LABELS[message.role] ?? message.role}: ${extractMessageText(message.content)}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// in-process MCP サーバ構築
// ---------------------------------------------------------------------------

interface McpHooks {
  executeTool?: BossToolExecutor;
  onToolEvent?: OnToolEvent;
}

class ClaudeCodeBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeBackendError";
  }
}

// ---------------------------------------------------------------------------
// FR-09 / AC-06: 実行環境の環境変数構築
// ---------------------------------------------------------------------------

/**
 * FR-09 / AC-06: builds the subprocess environment the Agent SDK's
 * `query()` `env` option receives. Per `sdk.d.ts`'s `Options.env` doc
 * comment, "When set, this value REPLACES the subprocess environment
 * entirely — it is not merged with `process.env`", so this must be a full
 * `process.env`-shaped copy (preserving `PATH`/`HOME`/Claude Code config-dir
 * variables the subprocess needs to run and authenticate), not a sparse
 * override object, and `ANTHROPIC_API_KEY` must be deleted from *this* copy
 * rather than merely omitted from an override (omitting it from a sparse
 * override would leave it inherited).
 *
 * クリティカル設計決定「セキュリティ・認証情報の取り扱い」: `claude-code`
 * バックエンドはサブスクリプション認証を強制するため、`ANTHROPIC_API_KEY`
 * を子プロセス環境から明示的に除外する（FR-12 の課金意図に反する無断切替
 * 禁止とも整合）。非機能要件「セキュリティ・プライバシー」: テレメトリ・
 * 自動アップデート確認を無効化する環境変数を付与する
 * （`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` は自動アップデート確認も
 * 止めるが、実行系は npm 依存としてバージョン管理されるため意図した挙動）。
 */
export function buildClaudeCodeEnv(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const env: NodeJS.ProcessEnv = { ...processEnv };
  delete env.ANTHROPIC_API_KEY;
  return {
    ...env,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// ---------------------------------------------------------------------------
// FR-13 / AC-12: Claude Code 実行バイナリのパス共有・起動時可用性確認
// ---------------------------------------------------------------------------

/**
 * Resolves the same Claude Code executable path the Agent SDK's `query()`
 * falls back to when `pathToClaudeCodeExecutable` is left unset. Confirmed by
 * reading the installed SDK (v0.3.231, `node_modules/@anthropic-ai/claude-
 * agent-sdk/sdk.mjs`): when `options.pathToClaudeCodeExecutable` is absent it
 * builds a short list of package-name candidates and does
 * `require.resolve('<candidate>/claude')` (`.exe` on win32) relative to its
 * own module location, returning the first one whose file actually exists —
 * matching `manifest.json`'s `platforms` map and the sibling
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` optional-dependency
 * packages (`os`/`cpu` package.json fields, single `claude`/`claude.exe`
 * binary file). The SDK does not export this resolution as a public API, so
 * it is reimplemented here (not called into) — `require.resolve` follows
 * Node's normal `node_modules` walk-up, so calling it from *this* module
 * resolves to the exact same absolute file the SDK's own internal call
 * would, since both live under the same installed dependency tree. This is
 * the "採用オプション名" recorded on the ticket: `pathToClaudeCodeExecutable`
 * is the SDK's only path-override option — see {@link CLAUDE_CODE_EXECUTABLE_PATH}
 * below, whose value `runClaudeCodeQuery` now passes explicitly, so the
 * availability check (`checkClaudeCodeAvailability`) and the backend's real
 * `query()` call are provably checking/spawning the *same* binary — one
 * resolved value shared by both, not two independently-matching resolution
 * algorithms that could drift apart in a future SDK version.
 *
 * Every platform except `"linux"`/`"android"` has exactly one candidate in
 * the SDK's own list (identical to what this function builds), so this
 * function is an exact reimplementation for them, including the `"win32"`
 * `.exe` case this module still supports for parity/testability even though
 * this app only ships on macOS (CLAUDE.md's "macOS ローカル完結"). `"linux"`
 * and `"android"` are the two platforms where the SDK picks among *multiple*
 * candidates (musl-vs-glibc preference on Linux, an Android-specific
 * package) — reimplementing that selection logic is out of scope (YAGNI:
 * this app never runs there), and guessing wrong would be strictly worse
 * than doing nothing: an explicitly-set `pathToClaudeCodeExecutable`
 * *overrides* the SDK's own (correct) multi-candidate resolution entirely,
 * so a wrong guess here could hand the SDK a glibc binary on a musl host
 * (self-review: code-reviewer/design-reviewer both flagged this). This
 * function returns `undefined` for those two platforms instead, which falls
 * through to the SDK's own internal resolution unchanged (pre-#83 behavior).
 *
 * `deps` is DI for the unit tests (see `claude-code-backend.test.ts`);
 * production callers use the defaults, which read the real
 * `process.platform`/`process.arch` and a real `require.resolve` anchored at
 * this module.
 */
export function resolveClaudeCodeExecutablePath(deps: {
  platform?: NodeJS.Platform;
  arch?: string;
  resolve?: (specifier: string) => string;
} = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux" || platform === "android") {
    return undefined;
  }
  const arch = deps.arch ?? process.arch;
  const resolve = deps.resolve ?? createRequire(import.meta.url).resolve;
  const ext = platform === "win32" ? ".exe" : "";
  try {
    return resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`);
  } catch {
    return undefined;
  }
}

/**
 * Computed once at module load (this value is process-invariant — the host
 * platform/arch and installed dependency tree don't change during a run),
 * rather than re-resolved on every `runClaudeCodeQuery`/`checkClaudeCodeAvailability`
 * call. This is also what makes the "same binary" guarantee structural
 * rather than "two calls to a pure function that happen to agree": both
 * consumers below read this one constant (self-review: code-reviewer).
 */
export const CLAUDE_CODE_EXECUTABLE_PATH = resolveClaudeCodeExecutablePath();

export interface ClaudeCodeAvailabilityCheckDeps {
  execFile: ExecFileFn;
  /** Overridable for tests; defaults to returning {@link CLAUDE_CODE_EXECUTABLE_PATH}. */
  resolveExecutablePath?: () => string | undefined;
}

/**
 * Static, secret-free guidance shown whenever the `claude-code` backend
 * (the default since Issue #118) turns out to be unavailable — either at
 * startup ({@link checkClaudeCodeAvailability}, best-effort) or at request
 * time ({@link ClaudeCodeUnavailableError}, surfaced by `claude-client.ts`'s
 * `dispatchStream`/`dispatchCreate`). Defined here (not in `claude-client.ts`)
 * and re-exported by that module's facade, because `claude-client.ts` already
 * imports from this module — defining it there and importing it back here
 * would create a circular import. Its switch-back sentence is imported from
 * `config.ts` (a leaf module that owns `LLM_BACKEND`'s semantics and imports
 * nothing) so `loadConfig`'s startup notice and this hint can't drift apart.
 *
 * Deliberately says "claude-code バックエンド" without claiming it is the
 * *default*: this fires for an explicit `LLM_BACKEND=claude-code` too, and
 * telling such an owner their `.env` setting isn't in effect would send them
 * chasing the wrong problem (self-review: code-reviewer).
 *
 * Deliberately static: per the "log class name only" discipline (see
 * `ClaudeCodeUnavailableError`'s own doc comment above), callers never log
 * `err.message`, so this is the only way to surface actionable guidance
 * without risking request/environment details leaking into logs.
 */
export const CLAUDE_CODE_UNAVAILABLE_HINT =
  "claude-code バックエンドが利用できません。Claude Code のインストール・ログイン状態を確認してください。" +
  SWITCH_TO_API_BACKEND_HINT;

/**
 * FR-13 / AC-12: best-effort startup check of the `claude-code` backend's
 * execution environment. Runs the shared executable path's `--version`
 * (never a token-consuming call — no prompt is sent) and never throws: every
 * failure mode — the path could not be resolved at all, `execFile` rejects
 * with `ENOENT` (not installed), a non-zero exit, or a timeout (the injected
 * `execFile` is expected to enforce one explicitly, matching `notifier.ts`'s
 * `nodeSystemExecFile` pattern — see {@link nodeExecFileForAvailabilityCheck}
 * below) — is caught and logged as a warning only, so the caller
 * (`server/src/index.ts`) can call this without blocking or failing startup.
 * Fail-fast at startup is reserved for `LLM_BACKEND` itself being invalid
 * (FR-02) — this check is explicitly best-effort (FR-13). The whole body
 * (including the `resolveExecutablePath()` call, not just the `execFile`
 * call) is wrapped in a single `try` so this "never rejects" guarantee is
 * structural rather than resting on every individual line inside happening
 * to already be guarded (self-review: design-reviewer) — `server/src/index.ts`
 * additionally never awaits this call and attaches its own `.catch`, as
 * defense in depth.
 *
 * Per the codebase's "log class name only" discipline (see `notifier.ts`,
 * and this module's own `ClaudeCodeUnavailableError` doc comment), only
 * `err.name`/`typeof err` is logged, never `.message` or a stack — the
 * checked executable path is also logged (it is a local npm-installed
 * filesystem path, not user/secret data) so the warning stays diagnosable
 * without violating that discipline.
 */
export async function checkClaudeCodeAvailability(
  deps: ClaudeCodeAvailabilityCheckDeps,
): Promise<void> {
  try {
    const resolveExecutablePath = deps.resolveExecutablePath ?? (() => CLAUDE_CODE_EXECUTABLE_PATH);
    const executablePath = resolveExecutablePath();
    if (!executablePath) {
      console.warn(
        "claude-code バックエンド: Claude Code 実行バイナリのパスを解決できませんでした。起動時の可用性確認をスキップします（サーバーの起動は継続します）。",
        CLAUDE_CODE_UNAVAILABLE_HINT,
      );
      return;
    }
    try {
      await deps.execFile(executablePath, ["--version"]);
    } catch (err) {
      console.warn(
        `claude-code バックエンド: 起動時の可用性確認に失敗しました（対象: ${executablePath}）。サーバーの起動は継続します。`,
        err instanceof Error ? err.name : typeof err,
        CLAUDE_CODE_UNAVAILABLE_HINT,
      );
    }
  } catch (err) {
    console.warn(
      "claude-code バックエンド: 起動時の可用性確認中に予期しないエラーが発生しました。サーバーの起動は継続します。",
      err instanceof Error ? err.name : typeof err,
      CLAUDE_CODE_UNAVAILABLE_HINT,
    );
  }
}

/** Timeout for the real availability-check `execFile` (FR-13 requires an
 * explicit timeout, same discipline as `notifier.ts`'s `EXEC_TIMEOUT_MS`).
 * Deliberately generous rather than short: this is a fire-and-forget startup
 * probe that `server/src/index.ts` never awaits before `serve()`, so a
 * longer budget costs nothing (self-review: code-reviewer measured the
 * bundled binary's own cold-start `--version` invocation at ~3.4s on a local
 * run with a cold filesystem cache — the previous 5s budget left too little
 * margin and risked a false "unavailable" warning on an otherwise-healthy
 * install; sized well above that observed cold-start cost instead). */
const AVAILABILITY_CHECK_TIMEOUT_MS = 20_000;

/**
 * Real `execFile` wiring for {@link checkClaudeCodeAvailability}, used only
 * by `server/src/index.ts`'s production startup hook. Passes
 * `buildClaudeCodeEnv(process.env)` (computed once, at the same "startup, not
 * per-request" granularity as this whole check) so the probe's subprocess
 * environment excludes `ANTHROPIC_API_KEY` and carries the telemetry-off
 * variables, matching every other spawn of this same binary
 * (`runClaudeCodeQuery`'s `query()` call) even though `--version` itself
 * performs no inference and has no billing/auth consequence today
 * (self-review: code-reviewer — keeps the policy uniform against future
 * changes to what this probe runs). Left untested at this layer — same
 * convention as `notifier.ts`'s own `nodeSystemExecFile` and
 * `server/src/index.ts`'s scheduler wiring — `createTimedExecFile`'s timeout/
 * env wiring is covered by `lib/exec-file.test.ts`, and the branching logic
 * this is used in (`checkClaudeCodeAvailability`) is covered by
 * `claude-code-backend.test.ts` with an injected fake.
 */
export const nodeExecFileForAvailabilityCheck: ExecFileFn = createTimedExecFile(
  AVAILABILITY_CHECK_TIMEOUT_MS,
  { env: buildClaudeCodeEnv(process.env) },
);

// ---------------------------------------------------------------------------
// FR-11: 実行環境不備の専用エラー型
// ---------------------------------------------------------------------------

/**
 * Distinguishes an execution-environment failure (Claude Code not
 * installed) from other, unclassified failures caught while running the
 * Agent SDK query. `"unknown"` also covers "not logged in / expired
 * credentials": the installed SDK version (0.3.231) exposes no dedicated
 * result subtype or error code for that case (verified by searching
 * `sdk.d.ts`/`sdk.mjs` for login/authentication-specific signals — none
 * found), so it cannot be distinguished from other unclassified failures
 * without guessing at stderr text. This is a recorded, deliberate
 * limitation (see the ticket's SDK-option research comment), not an
 * oversight — `reason` still lets a caller that wants to special-case "not
 * installed" do so.
 */
export type ClaudeCodeUnavailableReason = "not_installed" | "unknown";

/**
 * FR-11: dedicated error type for claude-code execution-*environment*
 * unavailability (not installed / not logged in), as opposed to an in-turn
 * execution failure such as hitting the max-turns cap (which keeps using
 * `ClaudeCodeBackendError` — see the `result` message handling in
 * `runClaudeCodeQuery` below). The 4 existing call sites' generic `Error`
 * catches (chat/appeals routes → HTTP 500; dashboard comment / notification
 * body → template fallback) handle this without any change, since they all
 * catch `Error` broadly (補足決定「FR-10 とエラーハンドリングの整合」).
 *
 * Every site that logs an error like this logs `error.name` only, never
 * `.message`/`.reason` (the existing "log class name only" discipline — see
 * `notifier.ts` and the chat/appeals routes' catch comments), so `reason` is
 * for programmatic use only and is never written to a log.
 */
export class ClaudeCodeUnavailableError extends Error {
  readonly reason: ClaudeCodeUnavailableReason;

  constructor(reason: ClaudeCodeUnavailableReason, message: string) {
    super(message);
    this.name = "ClaudeCodeUnavailableError";
    this.reason = reason;
  }
}

/** Classifies an error caught while iterating the Agent SDK's query stream
 * (i.e. a failure of the subprocess/environment itself, not a deliberate
 * `throw` from this module's own "non-success result" handling — see the
 * `instanceof ClaudeCodeBackendError` re-throw guard in `runClaudeCodeQuery`)
 * into a {@link ClaudeCodeUnavailableError}. Node's `child_process.spawn`
 * (which the Agent SDK's subprocess transport uses under the hood) sets
 * `.code === "ENOENT"` on the error it raises when the executable cannot be
 * found — the standard, well-known signal for "not installed". */
function toClaudeCodeUnavailableError(err: unknown): ClaudeCodeUnavailableError {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") {
    return new ClaudeCodeUnavailableError(
      "not_installed",
      "claude-code backend: the Claude Code executable was not found (ENOENT) — is it installed?",
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ClaudeCodeUnavailableError(
    "unknown",
    `claude-code backend: query failed before completion (${detail})`,
  );
}

function buildExecutedTool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, hooks: McpHooks) {
  return tool(name, description, shape, async (args) => {
    if (!hooks.executeTool) {
      throw new ClaudeCodeBackendError(
        `claude-code backend: tool "${name}" was called but no executeTool callback was supplied`,
      );
    }
    const result = await hooks.executeTool(name, args);
    if (hooks.onToolEvent) {
      await hooks.onToolEvent({ name, input: args, result: result.content, isError: result.isError });
    }
    return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
  });
}

/**
 * `submit_verdict` has no execution function of its own — the DB write
 * happens in the caller (`appeals-route.ts`'s transaction) after
 * `requestVerdict` resolves, and validation (`parseVerdictToolInput`) is
 * performed by `requestVerdict` itself against the `tool_use` block that
 * naturally appears in the model's assistant message (captured by
 * `runClaudeCodeQuery`'s message loop below — same as the `api` backend,
 * which never executes this tool either). This handler's only job is to
 * satisfy the MCP round-trip the SDK requires to complete the turn.
 */
function buildSubmitVerdictTool(description: string) {
  return tool("submit_verdict", description, submitVerdictShape, async () => {
    return { content: [{ type: "text" as const, text: "裁定を受け付けた。" }] };
  });
}

/**
 * `submit_evening_summary`（Issue #108: 日報生成の「値の抽出」ステップ）も
 * `submit_verdict` と同じ理由で実行関数を持たない: DB 書き込み（`daily_reports`
 * への UPSERT）は呼び出し元（`generate-daily-report.ts`）が
 * `requestVerdict` の戻り値を見て行い、検証（`parseEveningSummaryToolInput`）
 * も `requestVerdict` 自身が `tool_use` ブロックに対して行う（`api` バック
 * エンドと同じ検証経路を通す）。このハンドラは Agent SDK の MCP ラウンド
 * トリップを完了させるだけの受理応答を返す。
 */
function buildSubmitEveningSummaryTool(description: string) {
  return tool("submit_evening_summary", description, submitEveningSummaryShape, async () => {
    return { content: [{ type: "text" as const, text: "夕会サマリを受け付けた。" }] };
  });
}

/** Builds the in-process MCP server exposing exactly the tools named in
 * `tools` (the JSON Schema `Anthropic.Tool[]` the facade forwards — for
 * chat this is `BOSS_TOOLS`, for re-adjudication `[SUBMIT_VERDICT_TOOL]`,
 * for daily-report extraction `[SUBMIT_EVENING_SUMMARY_TOOL]`, for
 * dashboard-comment/notification-body it is empty/undefined). Throws if a
 * tool name has no registered Zod schema — a defensive guard, since the
 * call sites are all controlled by this codebase. */
function buildMcpServer(toolDefs: Anthropic.Tool[], hooks: McpHooks) {
  const tools = toolDefs.map((toolDef) => {
    if (toolDef.name === "submit_verdict") {
      return buildSubmitVerdictTool(toolDef.description ?? "");
    }
    if (toolDef.name === "submit_evening_summary") {
      return buildSubmitEveningSummaryTool(toolDef.description ?? "");
    }
    if (EXECUTED_TOOL_NAMES.has(toolDef.name)) {
      const shape = TOOL_ZOD_SHAPES[toolDef.name as keyof typeof TOOL_ZOD_SHAPES];
      return buildExecutedTool(toolDef.name, toolDef.description ?? "", shape, hooks);
    }
    throw new ClaudeCodeBackendError(
      `claude-code backend: no Zod schema registered for tool "${toolDef.name}"`,
    );
  });
  return createSdkMcpServer({ name: MCP_SERVER_NAME, tools });
}

/**
 * Runaway-loop guard (self-review): the `claude-code` backend runs Agent
 * SDK's own internal multi-turn tool loop instead of the facade's
 * `MAX_TOOL_ROUNDS` (see `claude-client.ts`'s `streamBossMessage` doc
 * comment), and without a cap here a misbehaving turn could keep calling
 * DB-writing tools until the 120s facade timeout — burning subscription
 * usage and, per the non-functional requirement "信頼性" (3), each such
 * call is itself never retried once it has a side effect, so a long unbounded
 * loop has no other backstop. `maxTurns` is *not* used as a substitute for
 * the timeout (docs/features/claude-code-backend.md 非機能要件・信頼性 (2)
 * explicitly reserves that role for `AbortController`) — it is a
 * defense-in-depth cap set generously above the `api` backend's
 * `MAX_TOOL_ROUNDS` (5) to account for the Agent SDK counting turns
 * differently (a single tool round-trip may span more than one internal
 * "turn").
 */
const MAX_AGENT_TURNS = 10;

// ---------------------------------------------------------------------------
// クエリ実行
// ---------------------------------------------------------------------------

export interface ClaudeCodeMessageRequest {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  /** JSON Schema tool definitions from the facade (`BOSS_TOOLS` /
   * `[SUBMIT_VERDICT_TOOL]` / undefined). Only used to decide which
   * in-process MCP tools to register — `maxTokens`/`toolChoice` have no
   * Agent SDK equivalent and are intentionally not forwarded (see the
   * feature spec's 前提・仮定 3). */
  tools?: Anthropic.Tool[];
}

export interface ClaudeCodeDispatchOptions {
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  executeTool?: BossToolExecutor;
  /** Shared deadline signal (AC-11) — a fresh `AbortController` is created
   * per attempt and wired to abort when this signal aborts, since the Agent
   * SDK's `query()` takes an `AbortController`, not a raw `AbortSignal`. */
  signal?: AbortSignal;
  /** FR-09 / AC-06: the subprocess environment (built once by
   * `createClaudeClient` via {@link buildClaudeCodeEnv} and carried on
   * `BossLlmClient`'s `claude-code` variant — see `claude-client.ts`),
   * forwarded verbatim to the Agent SDK's `query()` `env` option. */
  env?: Record<string, string | undefined>;
}

/**
 * Runs a single Agent SDK `query()` call to completion and normalizes it to
 * a `BossLlmMessage` (FR-04's content-block contract). Shared by the
 * streaming (chat) and non-streaming (verdict / dashboard comment /
 * notification body) call sites — the only behavioral difference is whether
 * `includePartialMessages` is requested and `onTextDelta` is wired.
 */
async function runClaudeCodeQuery(
  request: ClaudeCodeMessageRequest,
  options: ClaudeCodeDispatchOptions,
): Promise<BossLlmMessage> {
  const toolDefs = request.tools ?? [];
  const mcpServer =
    toolDefs.length > 0
      ? buildMcpServer(toolDefs, {
          executeTool: options.executeTool,
          onToolEvent: options.onToolEvent,
        })
      : undefined;
  const allowedTools = toolDefs.map((toolDef) => mcpToolName(toolDef.name));

  const abortController = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) {
      abortController.abort();
    } else {
      options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const content: BossContentBlock[] = [];
  let sawSuccessResult = false;
  let textDeltaRelayed = false;

  try {
    // self-review (code-reviewer): `query()` itself must be inside this
    // try — the Agent SDK validates/resolves its bundled native executable
    // synchronously when `query()` is called (before any message is
    // iterated), so a "Claude Code is not installed" failure — FR-11's
    // primary trigger — throws here, not from the `for await` below. Calling
    // it outside the try would let that specific failure escape
    // classification into `ClaudeCodeUnavailableError` entirely.
    const stream = query({
      prompt: buildClaudeCodePrompt(request.messages),
      options: {
        model: request.model,
        systemPrompt: request.system,
        abortController,
        // FR-13: the same module-level constant the startup availability
        // check (`checkClaudeCodeAvailability`) probes — see
        // `CLAUDE_CODE_EXECUTABLE_PATH`'s doc comment. `undefined` when
        // unresolvable (e.g. installed with `--omit=optional`, or on a
        // platform this module deliberately doesn't resolve for) falls back
        // to the SDK's own internal resolution/error, i.e. unchanged pre-#83
        // behavior.
        pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE_PATH,
        // FR-06 (multi-layer built-in tool disablement):
        // 1. `tools: []` — explicit built-in tool set, empty = all disabled.
        // 2. `settingSources: []` — do not load settings-file-declared tools/MCP.
        // 3. `strictMcpConfig: true` — only the `mcpServers` passed here (no
        //    project/user/plugin MCP).
        // 4. `allowedTools` — auto-approve only our own MCP tools (does not by
        //    itself restrict availability; combined with 1-3 above per the
        //    ticket's explicit instruction not to rely on the allow-list alone).
        // 5. `canUseTool` — deny-by-default permission handler for anything
        //    outside the allow-list (AC-05's rejection boundary — see
        //    `buildCanUseTool`).
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        canUseTool: buildCanUseTool(allowedTools),
        mcpServers: mcpServer ? { [MCP_SERVER_NAME]: mcpServer } : undefined,
        includePartialMessages: Boolean(options.onTextDelta),
        maxTurns: MAX_AGENT_TURNS,
        // FR-09 / AC-06: replaces (not merges with) the subprocess env — see
        // `buildClaudeCodeEnv`'s doc comment. Left `undefined` only in tests
        // that call the backend directly without going through
        // `createClaudeClient` (the Agent SDK then falls back to inheriting
        // `process.env` unchanged, per its own doc comment — production
        // callers always go through the facade, which always supplies this).
        env: options.env,
        // FR-15 / AC-13: disable Claude Code's session-history persistence to
        // `~/.claude/projects/` — conversation state is the app's own SQLite,
        // per the "補足決定" that conversation state stays stateless/DB-backed.
        persistSession: false,
      },
    });

    for await (const message of stream) {
      if (message.type === "stream_event") {
        const { event } = message;
        if (
          options.onTextDelta &&
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          options.onTextDelta(event.delta.text);
          textDeltaRelayed = true;
        }
        continue;
      }
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            content.push({
              type: "tool_use",
              id: block.id,
              name: unqualifyToolName(block.name),
              input: block.input,
            });
          }
        }
        continue;
      }
      if (message.type === "result") {
        // 補足決定「FR-10 とエラーハンドリングの整合」: Agent SDK が例外では
        // なく非成功の結果メッセージ（is_error 相当）を返す経路もすべて
        // Error へ変換し、不完全な応答を成功として返さない。This is an
        // in-turn execution failure (e.g. max turns reached), not an
        // execution-*environment* unavailability (FR-11) — so it stays a
        // `ClaudeCodeBackendError`, not `ClaudeCodeUnavailableError`.
        if (message.subtype !== "success") {
          throw new ClaudeCodeBackendError(
            `claude-code backend query did not complete successfully (${message.subtype})`,
          );
        }
        sawSuccessResult = true;
      }
    }
  } catch (err) {
    // FR-11: an error thrown by the async iteration itself (as opposed to
    // the deliberate `ClaudeCodeBackendError` throw just above, which must
    // pass through unclassified) means the subprocess/environment failed —
    // not installed, not logged in, or crashed — so it is reclassified as
    // `ClaudeCodeUnavailableError` (AC-07's "例外経路").
    if (err instanceof ClaudeCodeBackendError) {
      throw err;
    }
    throw toClaudeCodeUnavailableError(err);
  }

  if (!sawSuccessResult) {
    throw new ClaudeCodeBackendError("claude-code backend query ended without a result message");
  }

  // FR-04 / non-functional requirement "パフォーマンス" 縮退仕様: partial
  // message streaming was requested (`includePartialMessages`) but no
  // `content_block_delta`/`text_delta` ever arrived — e.g. the running SDK
  // version doesn't actually emit them despite the option, or the reply
  // came through a message shape this loop doesn't treat as a delta source.
  // Without this fallback the assistant's text would sit unused in `content`
  // forever, since callers that stream (`chat-messages-route.ts`) build their
  // persisted message purely from `onTextDelta` accumulation and never read
  // this function's return value (self-review caught this — see the ticket's
  // 前提・仮定 4: "取得できない場合はメッセージ単位の送出（delta なし・1
  // 応答 1 text イベント）へ縮退し、その旨を実装チケットに記録する").
  if (options.onTextDelta && !textDeltaRelayed) {
    const fullText = content
      .filter((block): block is Extract<BossContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (fullText !== "") {
      options.onTextDelta(fullText);
    }
  }

  return { content };
}

export function streamClaudeCodeMessage(
  request: ClaudeCodeMessageRequest,
  options: ClaudeCodeDispatchOptions = {},
): Promise<BossLlmMessage> {
  return runClaudeCodeQuery(request, options);
}

export function createClaudeCodeMessage(
  request: ClaudeCodeMessageRequest,
  options: Pick<ClaudeCodeDispatchOptions, "signal" | "env"> = {},
): Promise<BossLlmMessage> {
  return runClaudeCodeQuery(request, options);
}
