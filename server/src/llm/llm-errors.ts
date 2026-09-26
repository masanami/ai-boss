import { SWITCH_TO_API_BACKEND_HINT } from "../config.js";

/**
 * `claude-code` バックエンドの実行環境不備を表すエラー型と、その案内文言
 * （機能仕様 docs/features/tauri-in-app-runtime.md「クリティカル設計決定3」）。
 *
 * 元々は `llm/backends/claude-code-backend.ts` に定義されていたが、その
 * モジュールは Agent SDK（`@anthropic-ai/claude-agent-sdk`）を値として import
 * しており、製品版のコアのバンドルに混入してはならない
 * （`server/src/core-entry.bundle.test.ts` が固定する）。一方でこのエラー型
 * 自体は `llm/claude-client.ts`（コア）や `reports/extract-evening-summary.ts`
 * のコメントが指す契約（フォールバック処理の分岐）でコアからも値として
 * 参照される必要があるため、Agent SDK を引き込まない独立モジュールへ切り出した
 * （実装計画①）。`claude-code-backend.ts` はこのモジュールから re-export する
 * ことで、既存テストが `backends/claude-code-backend.js` から import していて
 * も互換を保つ。
 */

/**
 * `"unknown"` は「未ログイン・認証情報の期限切れ」も含む。導入時点の SDK は
 * この2つを区別する専用のエラーコードを持たない（`claude-code-backend.ts`
 * 側の調査コメントを参照）。
 */
export type ClaudeCodeUnavailableReason = "not_installed" | "unknown";

/**
 * `claude-code` 実行**環境**の不備（未インストール・未ログイン）を表す専用
 * エラー型。ターン内の実行失敗（`ClaudeCodeBackendError`、maxTurns 到達等）
 * とは区別する。呼び出し元は `error.name` のみをログに出す（値・環境変数を
 * 漏らさない「クラス名のみログ」規律 — `claude-code-backend.ts` 側の各所の
 * コメントを参照）。
 */
export class ClaudeCodeUnavailableError extends Error {
  readonly reason: ClaudeCodeUnavailableReason;

  constructor(reason: ClaudeCodeUnavailableReason, message: string) {
    super(message);
    this.name = "ClaudeCodeUnavailableError";
    this.reason = reason;
  }
}

/**
 * `claude-code` バックエンドが利用できない場合に表示する、秘密情報を含まない
 * 静的な案内文言。起動時のベストエフォート確認（`checkClaudeCodeAvailability`）
 * とリクエスト時（`ClaudeCodeUnavailableError`）の両方から使われる。
 */
export const CLAUDE_CODE_UNAVAILABLE_HINT =
  "claude-code バックエンドが利用できません。Claude Code のインストール・ログイン状態を確認してください。" +
  SWITCH_TO_API_BACKEND_HINT;
