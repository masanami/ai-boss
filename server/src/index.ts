import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, resolveEvidenceDir } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startScheduler } from "./scheduler/scheduler.js";
// 機能仕様 docs/features/tauri-in-app-runtime.md 実装計画①: `claude-client.ts`
// （コア）はもう `backends/*.ts` を静的 import しないため、`claude-code`
// バックエンドの入口は Node 周辺の `dev-llm-backends.ts` を単一の窓口とする
// （self-review: design-reviewer — `backends/claude-code-backend.js` を
// このファイルから直接 import すると、以前の self-review で閉じたはずの
// 「非ファサード経由の呼び出し元」を再び開けてしまう）。
import {
  registerDevLlmBackends,
  checkClaudeCodeAvailability,
  nodeExecFileForAvailabilityCheck,
} from "./llm/dev-llm-backends.js";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
runMigrations(db);

// 開発者用の版（このエントリ）だけが `claude-code`/`api` を登録する
// （オーナーの決定 Q4-b・Q4-c）。以前は `createApp` 呼び出しの副作用として
// 暗黙に登録されていたが、`startScheduler`（下）が呼ぶ通知文面生成の経路
// （`scheduler-tick.ts` → `notification-body.ts` → `createClaudeClient`）が
// 将来 `createApp` より前に動くよう並び替わった場合に無登録のまま倒れる
// リスクがあった（self-review: design-reviewer, PLAUSIBLE）。明示的にここで
// 呼ぶことで、起動順の入れ替えに対して構造的に安全にする（`registerLlmBackend`
// は `Map#set` の冪等性を持つため、`createApp` 内で再度呼ばれても無害）。
registerDevLlmBackends();

if (config.llmBackend === "claude-code") {
  // FR-13 / AC-12: best-effort, non-blocking — never awaited so it cannot
  // delay `serve()` below (fail-fast at startup is reserved for LLM_BACKEND
  // itself being invalid, FR-02; this check only warns and lets the server
  // start regardless of the result). `checkClaudeCodeAvailability` is
  // documented to catch every failure mode internally and never reject, but
  // that guarantee shouldn't rest on this call site trusting it blindly
  // (self-review: code-reviewer/design-reviewer) — `.catch()` here makes
  // "never blocks/never crashes startup" structural even if that internal
  // guarantee were ever violated by a future edit. This call is intentionally
  // left untested at this wiring layer, same convention as the scheduler
  // startup call below.
  checkClaudeCodeAvailability({ execFile: nodeExecFileForAvailabilityCheck }).catch(() => {
    // Unreachable in practice (see comment above) — defense in depth only.
  });
}

// Resolved relative to this module (not cwd) so it works both compiled
// (server/dist/index.js) and under tsx watch (server/src/index.ts).
const webDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticRoot = existsSync(webDistPath) ? webDistPath : undefined;

if (!staticRoot) {
  console.warn(
    `web のビルド成果物が見つかりません（${webDistPath}）。API のみ起動します。` +
      "フロントエンドも配信するには `npm run build` を実行してください（`npm run start` は自動でビルドします）。",
  );
}

// エビデンス強制（#256 決定 1-a / #387）: 保管ディレクトリは既存の DB パス
// から導出する（新しい環境変数は発明しない）。`config.dbPath` は
// `:memory:` になり得ない（`loadConfig` の実路のみを通る）ため、ここでは
// 常に有効なディレクトリが得られる。
const evidenceDir = resolveEvidenceDir(config.dbPath);

const app = createApp(db, process.env, {
  staticRoot,
  llmBackend: config.llmBackend,
  evidenceDir,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ai-boss server listening on port ${info.port}`);
  if (staticRoot) {
    console.log(`web assets served from ${staticRoot}`);
  }
});

// Slacking-detection scheduler (Issue #38): started only from this
// production entry point, never from `createApp`/tests (see
// `scheduler/scheduler.ts` and `scheduler/scheduler-tick.ts`, which are
// tested directly and independently of node-cron/the server process).
const scheduler = startScheduler({ db, env: process.env });

function gracefulStop(signal: NodeJS.Signals): void {
  console.log(`${signal} received, stopping the scheduler...`);
  // Stops future cron triggers only — an in-flight tick is not drained
  // before exiting. Accepted as a local-MVP tradeoff (single-user, no
  // orchestrator to wait for); worst case a signal during a tick loses that
  // tick's notification, which the next minute's tick will naturally retry
  // if the underlying condition still holds.
  scheduler.stop();
  process.exit(0);
}

process.on("SIGINT", gracefulStop);
process.on("SIGTERM", gracefulStop);
