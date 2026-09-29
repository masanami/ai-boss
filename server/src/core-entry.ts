/**
 * 製品版（Tauri アプリ）のコアのエントリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定3・スライス S1・
 * 仮定 A3: 名前・置き場所は実装で決めてよい）。
 *
 * `createCoreApp` と、登録済み LLM バックエンド名の列挙をそのまま re-export
 * するだけで、**LLM バックエンドを一つも登録しない**（オーナーの決定
 * Q4-c — 製品版のコアには `api` も含めキーを WebView に載せるバックエンドを
 * 入れない）。バックエンドの登録は #581（Rust 通信層）・#582（プロバイダ
 * 抽象化）の責務であり、本機能（#594）の対象外。
 *
 * このモジュール（および、この import グラフから到達可能なすべてのモジュ
 * ール）は Node 組み込み（`node:*`）・Node グローバル（`process`・`Buffer`・
 * `require`・`__dirname`・`__filename`）・`@anthropic-ai/claude-agent-sdk`・
 * `@anthropic-ai/sdk`・`@hono/node-server` を値として import・参照しない —
 * `server/src/core-entry.bundle.test.ts` が esbuild のバンドル検査
 * （受入基準1〜7・12）と TypeScript コンパイラ API による静的検査で固定する。
 */
export { createCoreApp, type CreateCoreAppOptions } from "./core-app.js";

/**
 * 非同期の DB ポートの直列化層とマイグレーション（#580 S2・機能仕様
 * docs/features/async-db-layer.md「S2 の設計」）。製品版の web のエントリが、
 * plugin-sql 実装のドライバ（`web/src/app-entry/plugin-sql-driver.ts`）の上に
 * S1 と同じ直列化層でポートを組み、`migrate.ts`（`user_version`）で
 * マイグレーションしてから `createCoreApp` に渡す。どちらも import を持たない
 * コア（`node:*`・better-sqlite3 に依存しない）で、このモジュールの公開面に
 * 置くことで `core-entry.bundle.test.ts` のバンドル検査の対象になる。
 */
export { createSerializedDb } from "./db/serialized-db.js";
export { runMigrations } from "./db/migrate.js";
export type { DbDriver, DbPort, RunResult, SqlValue } from "./db/db-port.js";
export { registeredLlmBackendNames as registeredCoreLlmBackendNames } from "./llm/llm-backend-registry.js";

/**
 * BYOK（Anthropic）の登録関数を**呼ばずに re-export する**（機能仕様
 * docs/features/secure-transport-byok.md「S2 のモジュールをバンドル検査の
 * 対象にする方法」・親の決定・案 (A)）。S3 で Tauri の器がこの関数へ
 * Tauri 実装の転送のポートを渡して呼ぶ——このモジュール自身は呼ばない
 * ため、`registeredCoreLlmBackendNames()` は依然空のまま
 * （オーナーの決定 Q4-c）。呼ばずに re-export するだけでも、この関数（と
 * その依存グラフ）は `core-entry.bundle.test.ts` のバンドル検査の対象に
 * なる——`@anthropic-ai/sdk` を値 import しない・Node のグローバルを
 * 参照しないことがそこで固定される。
 */
export { registerByokAnthropicBackend } from "./llm/backends/byok-anthropic-backend.js";

/**
 * BYOK（OpenAI）の登録関数も同じ理由で**呼ばずに re-export する**（機能仕様
 * docs/features/llm-provider-abstraction.md「実装計画」・S2「製品版のエント
 * リへの登録」より前——S1 は re-export のみ）。`OPENAI_RESPONSES_DESTINATION`
 * も併せて re-export し、S3 以降の Tauri 実装がこのモジュールから宛先の
 * 名前を引ける形に揃える（`ANTHROPIC_MESSAGES_DESTINATION` と同じ扱い）。
 */
export {
  registerByokOpenAiBackend,
  OPENAI_RESPONSES_DESTINATION,
} from "./llm/backends/byok-openai-backend.js";

/**
 * `SecureTransportError`（と失敗の種類の型）も re-export する（self-review:
 * design-reviewer, PLAUSIBLE）。エラーの分類（`classifyByokAnthropicError`）
 * は `instanceof SecureTransportError` というクラスの同一性に依存する。S3
 * の Tauri 実装のポートがこのモジュールから直接 `import` すれば元々問題は
 * 起きないが、コアのエントリの公開面（案 A）に揃えておくことで、S3 の
 * 実装がどこから転送のポートを組み立てても、同じクラスの実体で失敗を
 * 投げられるようにする。
 */
export {
  SecureTransportError,
  ANTHROPIC_MESSAGES_DESTINATION,
  type SecureTransportErrorKind,
  type SecureTransportPort,
  type SecureTransportSendRequest,
  type SecureTransportResponse,
  type SecureTransportResponseHeaders,
} from "./llm/secure-transport-port.js";

/**
 * 催促の予約を計画し直す処理（機能仕様 docs/features/scheduled-nudges.md
 * 「S2 の設計」）も**呼ばずに re-export する**。S3 で器が通知の予約ポートの
 * 実装を渡して作り、起動・前面への復帰などの契機と `createCoreApp` の
 * `onStateChangingRequest` へつなぐ。re-export により、この処理（と LLM の
 * 文面生成を含む依存グラフ）が `core-entry.bundle.test.ts` のバンドル検査の
 * 対象になる。
 */
export {
  createNudgeReplanner,
  type NudgeReplanner,
  type NudgeReplannerDeps,
} from "./nudge-plan/replan-nudges.js";
export type {
  NudgeSchedulerPort,
  ScheduledNotificationRequest,
} from "./nudge-plan/nudge-scheduler-port.js";

/**
 * 毎分の検知（`createTicker`）も**呼ばずに re-export する**（#579 S3・機能仕様
 * docs/features/tauri-in-app-runtime.md「S3 の設計」）。製品版の web のエントリが
 * DB のポートと製品版の通知ポートで組み立て、Rust 側の毎分の刻みのイベントを
 * 受けるたびに `tick` を呼ぶ（node-cron の置き換え）。`scheduler-tick.ts` は
 * 通知ポート（`notification-port.ts`）だけを受け取り、`notifier.ts`
 * （`node:child_process`）を import しないため、コアのバンドルに載せられる。
 * re-export により、この処理と依存グラフが `core-entry.bundle.test.ts` の
 * バンドル検査の対象になる。
 */
export { createTicker, type Ticker, type TickDeps } from "./scheduler/scheduler-tick.js";
export type {
  NotificationPayload,
  NotificationSender,
  SendNotificationResult,
} from "./notifications/notification-port.js";
