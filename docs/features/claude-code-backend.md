# Claude Code バックエンド（LLM バックエンド選択機能）

## 概要

LLM 呼び出しのバックエンドとして、現行の Claude API 直呼び（`@anthropic-ai/sdk`）に加え、Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`、内部で Claude Code を実行）を選択可能にする。選択は `server/.env` の `LLM_BACKEND` で行い、既定は現行どおり Claude API とする。

## 背景・目的

- 現行は全 LLM 呼び出しが `ANTHROPIC_API_KEY` による API 従量課金である。オーナーは Claude サブスクリプション（Claude Code ログイン）を保有しており、これを ai-boss の LLM 呼び出しに活用して API 従量課金への依存を減らしたい。
- Claude Agent SDK はローカルの Claude Code 実行環境（`claude login` 済みの資格情報）で動作するため、`ANTHROPIC_API_KEY` を設定せずに LLM 呼び出しが可能になる。

## ユーザーストーリー

ai-boss のオーナー（macOS ローカルで Claude Code を利用中のシングルユーザー）として、LLM バックエンドを Claude Code（サブスクリプション認証）に切り替えて、API キーの従量課金なしでボス機能（チャット・裁定・コメント・通知文面）を利用したい。

## 機能要件

- [ ] FR-01: `server/.env` の `LLM_BACKEND` でバックエンドを選択できる。許容値は `api` と `claude-code` の 2 値。未設定時は `api` として動作する（後方互換）。
- [ ] FR-02: `LLM_BACKEND` が許容値以外の場合、サーバー起動時にエラーで停止し、許容値を含むメッセージを表示する（誤設定のまま意図しない課金経路で動くことを防ぐ）。
- [ ] FR-03: `claude-code` バックエンドは、既存 4 呼び出し箇所（チャット `server/src/sessions/chat-messages-route.ts`・再裁定 `server/src/decisions/appeals-route.ts`・ダッシュボードコメント `server/src/dashboard/boss-comment.ts`・通知文面 `server/src/notifications/notification-body.ts`）のすべてで動作する（検証は AC-03・AC-04・AC-10 が対応する）。
- [ ] FR-04: チャットの SSE 挙動は両バックエンドで同一の外部仕様とする: text delta を `event: text` で逐次送出し、ツール実行を `event: tool` で送出し、最終メッセージを DB に保存する。ただし Agent SDK が partial message 相当の逐次イベントを提供しない場合に限り、「前提・仮定（明示）」4 の縮退仕様（1 応答 1 text イベント）に従い、縮退時も本要件を満たすとみなす。
- [ ] FR-05: カスタムツール（BOSS_TOOLS・SUBMIT_VERDICT_TOOL）は、`claude-code` バックエンドでは Agent SDK の in-process MCP サーバ（`createSdkMcpServer` / `tool()`）として提供し、既存のツール実行関数（`executeBossTool` / `parseVerdictToolInput`）を再利用する。
- [ ] FR-06: `claude-code` バックエンドでは Claude Code のビルトインツール（Bash・Read・Write・Edit・WebSearch・WebFetch を含む全ビルトインツール）を無効化し、許可ツールをアプリ定義のカスタムツールのみに限定する（許可リスト方式。Agent SDK 側の設定キー名は実装時の SDK バージョンで確認し、採用したオプション名を実装チケットに記録する）。
- [ ] FR-07: 再裁定（submit_verdict）は `tool_choice` 強制の等価機能が Agent SDK に無いため、プロンプトによるツール使用指示のみで代替する。ツールが呼ばれなかった場合は現行実装と同じく再試行せず HTTP 500 を返す。
- [ ] FR-08: settings テーブルの `model` 設定は両バックエンドに適用される（`claude-code` バックエンドでは Agent SDK の model オプションに渡す）。
- [ ] FR-09: `claude-code` バックエンド選択時、`ANTHROPIC_API_KEY` を Agent SDK およびその子プロセスへ渡さない（サブスクリプション認証を強制し、API キー課金への意図しない切替を防ぐ）。この除外はユニットテストで担保する。
- [ ] FR-10: `claude-code` バックエンド選択時は `MissingApiKeyError` の検査を行わない（`ANTHROPIC_API_KEY` 未設定でも動作する）。`api` バックエンドの挙動は現行から変更しない。
- [ ] FR-11: `claude-code` バックエンドの実行環境不備（Claude Code 未インストール・未ログイン）は専用エラー型（例: `ClaudeCodeUnavailableError`）で表現し、呼び出し元の既存契約に乗せる: チャット・再裁定は HTTP 500、ダッシュボードコメント・通知文面はテンプレートへフォールバックする。ログにはエラークラス名のみ残す（現行のログ規律を継承）。
- [ ] FR-12: `claude-code` バックエンドの失敗時に `api` バックエンドへ自動フォールバックしない（オーナーの課金意図に反する無断切替を禁止する）。
- [ ] FR-13: サーバー起動時、`LLM_BACKEND=claude-code` の場合は Claude Code 実行環境の可用性を best-effort で確認する。確認の内容は「Claude Code 実行ファイルのバージョン取得（`claude --version` 相当）を `execFile`（シェル非経由）で実行し、失敗（ENOENT・非ゼロ終了・タイムアウト）で警告ログを出す」とする（トークン消費を伴う疎通確認は行わない。起動は止めない。現行の `hasAnthropicApiKey` 警告パターンを踏襲）。
- [ ] FR-14: `claude-code` バックエンドのダッシュボードコメント生成では、リクエスト単位の応答長上限（現行 `DASHBOARD_COMMENT_MAX_TOKENS=150`）の代替として、プロンプトに明示的な短文指示（1〜2 文・全角 80 字以内）を追加し、短いコメントという既存 UI の契約を維持する。

## 非機能要件

- パフォーマンス: チャットのストリーミング体感（text delta の逐次 SSE 送出）を `claude-code` バックエンドでも維持する（Agent SDK の partial message ストリーミングを使用する）。ただし Agent SDK が partial message 相当の逐次イベントを提供しない場合は「前提・仮定（明示）」4 の縮退仕様に従い、縮退時も本要件を満たすとみなす（FR-04・AC-03 と同一の条件）。
- セキュリティ・プライバシー: 「全データはローカル SQLite・外部送信は Anthropic への推論リクエストのみ」という不変制約を `claude-code` バックエンドでも維持する。FR-06 のビルトインツール無効化に加え、Claude Code の非必須外部通信（テレメトリ・自動アップデート確認）を無効化する環境変数（`DISABLE_TELEMETRY=1`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）をバックエンド実行時に設定する。
- 信頼性: 呼び出し全体のタイムアウト 120 秒・失敗時の指数バックオフ再試行最大 2 回を両バックエンドの統一ポリシーとする。実装箇所の帰属: `api` バックエンドは現行どおり `@anthropic-ai/sdk` のクライアントオプション（`timeout` / `maxRetries`）への委譲を変更しない。`claude-code` バックエンドはファサード層で新規に実装する。両者は外部から見た振る舞い（最大 2 回・120 秒）を一致させる。

## 技術的な制約・方針

- 使用技術: `@anthropic-ai/claude-agent-sdk`（server workspace に新規依存として追加）
- 変更対象: `server/src/llm/`（ファサード化とバックエンド実装の追加）、`server/src/config.ts`（`LLM_BACKEND` の読み込み・検証）、`server/.env.example`
- 既存コードとの関係: `claude-client.ts` の公開関数（`createClaudeClient` / `streamBossMessage` / `createBossMessage` / `buildToolResultMessage`）を利用する 4 呼び出し箇所のロジック（ツールループ・SSE 中継・フォールバック文言・エラーハンドリング分岐）は無改修とする。型注釈・import の型名の機械的な変更のみ許容する（詳細はクリティカル設計決定の「補足決定（ファサードの型設計と『無改修』の正確なスコープ）」）
- テスト方針: `claude-code` バックエンドのテストは `vi.mock("@anthropic-ai/claude-agent-sdk")` によるモジュールモックで行う（現行の `vi.mock("@anthropic-ai/sdk")` パターンを踏襲）。web/ 配下の変更は行わない（設定 UI へのバックエンド選択の露出はしない）

### 前提・仮定（明示）

本機能は単一 repo 完結の課題として、以下を明示的な仮定として置く。実装前にオーナーが否定した場合は該当部分を見直す。

1. **課金の仮定（要オーナー確認）**: Agent SDK 経由の利用は 2026-06-15 以降、サブスクリプションプランに含まれる SDK 専用クレジット枠から標準 API レートで消費される（Max 5x で月 $100 相当。サブスクリプションの通常利用枠とは別枠）。「API キーの従量課金が不要になる」ことは満たすが、無制限ではない。オーナーは自身のプランでこの枠の残量・レートを実利用前に確認する。
2. **利用規約の仮定**: 本アプリはオーナー本人がローカルで使うシングルユーザーアプリであり、オーナー自身のサブスクリプション認証を使うことは「第三者にサブスクリプションログインを提供する」形態に当たらない（第三者提供は Anthropic のポリシーで禁止されている）。
3. **API 差分の仮定**: Agent SDK には Messages API の `tool_choice`・`max_tokens` のリクエスト単位指定に完全一致する機能が無い。`tool_choice` は FR-07 の方式で代替し、応答長の上限は既定値のまま運用する（現行 `DEFAULT_MAX_TOKENS=1024` 相当の厳密な制御は `claude-code` バックエンドでは行わない）。短文契約に依存するダッシュボードコメントのみ FR-14 のプロンプト指示で代替する（意思決定済み。代替案「api バックエンド同等の長さ制御の別途実装」は追加調査コストに見合わないため却下）。
4. **ストリーミングの仮定**: Agent SDK の partial message ストリーミング（`includePartialMessages` 相当のオプション）で text delta を取得できる。実装時に SDK の実バージョンで確認し、取得できない場合はメッセージ単位の送出（delta なし・1 応答 1 text イベント）へ縮退し、その旨を実装チケットに記録する（意思決定済み: 縮退を許容する。この仮定が FR-04・AC-03 の但し書きの正であり、縮退が発生した場合も受入基準を満たすとみなす。delta ストリーミング不可を理由に本機能全体をブロックしない）。

## クリティカル設計決定

> セキュリティ・機密データ・外部連携のクリティカル領域について、要件定義時に決定した方針を記録する。後続の `feature-implementer` はこの決定に従い、独自判断で逸脱しない。

### 外部システム連携（Claude Code 連携方式）

- **採用案**: Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）の in-process 組み込み。カスタムツールは `createSdkMcpServer` / `tool()` で in-process MCP サーバとして定義し、`db` / `sessionId` をクロージャで束縛して既存のツール実行関数を再利用する。
- **ツールスキーマの橋渡し方針**: 既存のツール定義（`server/src/boss/boss-tools.ts`・`server/src/boss/task-tools.ts`・`server/src/decisions/verdict-tool.ts` の `input_schema`＝JSON Schema）は変更せず単一ソースとして維持する。Agent SDK の `tool()` が要求する Zod スキーマは `backends/claude-code-backend.ts` 内に閉じて手書きし、既存 JSON Schema との整合（ツール名の一致・必須フィールドの一致）をユニットテストで担保する。JSON Schema→Zod の変換ライブラリは追加しない（依存追加に見合わないため）。入力値の最終検証は既存のツール実行関数側の検証（`parseVerdictToolInput` の検証を含む）を正とする。
- **理由**: 本アプリの LLM 統合の中核はカスタムツール（タスク CRUD・record_decision・submit_verdict）であり、in-process なら既存の `executeBossTool` / `parseVerdictToolInput` をほぼそのまま再利用できる。プロセス spawn オーバーヘッド（100–500ms）が無く、チャットのツールループ（MAX_TOOL_ROUNDS）でも体感速度を維持できる。テストも既存のモジュールモックパターンを踏襲できる。
- **代替案**: `claude -p` サブプロセス spawn — カスタムツールを stdio MCP サーバ（別プロセス）で橋渡しする新規アーキテクチャ層が必要で実装・保守コストが不釣り合いに大きく、spawn オーバーヘッドがツールループで複利的に効くため却下。プロセス分離が必須の要件が将来生じた場合の代替として温存する（`server/src/notifications/notifier.ts` の execFile DI パターンが土台になる）。
- **影響範囲**: `server/src/llm/` 配下。呼び出し 4 箇所の公開契約（`streamBossMessage` / `createBossMessage` の呼び出し形と戻り値のうち実際に参照されるフィールド `{type:"text",text}` / `{type:"tool_use",id,name,input}`）は維持し、バックエンド出力の正規化はバックエンドモジュール内に閉じ込める。
- **補足決定（ファサードの型設計と「無改修」の正確なスコープ）**: 現行の `createClaudeClient(env): Anthropic` は `@anthropic-ai/sdk` の具象クラス型を返し、呼び出し 4 箇所の型注釈（`let client: Anthropic`）もこれに結合しているため、戻り値型をバックエンド共通の抽象型（判別可能ユニオン。例: `type BossLlmClient = { backend: "api"; client: Anthropic } | { backend: "claude-code"; ... }`）へ変更する。`streamBossMessage` / `createBossMessage` はこの抽象型を受け取り、内部でバックエンド実装へ委譲する。`buildToolResultMessage` の入出力形式（tool_result ブロック）は両バックエンド共通で現行のまま維持する。「呼び出し 4 箇所は無改修」の正確なスコープは「ロジック（ツールループ・SSE 中継・フォールバック文言・エラーハンドリング分岐）を変更しない」であり、型注釈・import の型名の機械的な変更は許容範囲に含める。この機械的変更の対象は `let client: Anthropic` のような変数宣言に限らず、呼び出し 4 箇所に散在する Anthropic SDK 具象型への参照全般（例: `chat-messages-route.ts` の `isToolUseBlock` の引数・型ガード、`appeals-route.ts` の `let finalMessage: Anthropic.Message`、`boss-comment.ts` の `extractText` のシグネチャ）を含み、typecheck 通過（AC-09）まで追随変更する。ユニオンの `claude-code` バリアントのフィールド具体設計は `backends/claude-code-backend.ts` の実装詳細に委ね、ファサード側は `backend` 判別のみに用いる。
- **補足決定（FR-10 とエラーハンドリングの整合）**: `createClaudeClient`（ファサード）は `api` バックエンド時のみ `MissingApiKeyError` を投げる。`claude-code` バックエンド時は API キー検査を行わず、実行環境不備は `ClaudeCodeUnavailableError` として投げる。呼び出し 4 箇所の既存 catch 節は `Error` 一般を処理して HTTP 500 またはテンプレートフォールバックへ導くため、catch 節のロジック改修なしで両エラー型に対応できる。
- **補足決定**: 会話状態は現行のステートレス方式（DB から履歴を再構築し毎回全文送信）を両バックエンドで維持する。Agent SDK のセッション継続機能（resume）は「boss セッション ⇔ backend セッション」のマッピング状態の新設が必要になり YAGNI に反するため今回のスコープ外とする。

### セキュリティ・認証情報の取り扱い

- **採用案**: バックエンド選択は `server/.env` の `LLM_BACKEND`（起動時に `loadConfig` で一度だけ読み検証）。`claude-code` バックエンドは Claude Code のログイン済み資格情報を暗黙に使い、アプリはトークンを一切扱わない。`ANTHROPIC_API_KEY` は Agent SDK とその子プロセスの環境変数から明示的に除外し、除外をテストで担保する（FR-09）。失敗時の `api` への自動フォールバックは禁止する（FR-12）。
- **理由**: バックエンド選択は「このマシンで何が使えるか」というマシン固有の実行環境事実であり、`ANTHROPIC_API_KEY` / `DB_PATH` / `PORT` と同じ `.env` の建て付けが既存パターンと整合する。settings テーブル（UI から変更可能）に置くと、サブプロセス実行モードの切替という重い決定がブラウザから触れる面に露出し、クリティカル箇所のレビュー方針とも整合しない。
- **代替案**: settings テーブル + 設定 UI での切替 — UI から再起動なしで切替できる利点はあるが、上記の理由および実行環境の可否（インストール・ログイン状態）に依存する設定は保存時に検証できない点で却下。
- **影響範囲**: `server/src/config.ts`・`server/.env.example`・`server/src/llm/`。`MissingApiKeyError` は `api` バックエンド専用の検査として現行位置に残す。

### プライバシー不変制約の維持（ビルトインツール無効化）

- **採用案**: `claude-code` バックエンドでは Claude Code のビルトインツールを全無効化し、許可ツールをアプリ定義のカスタムツールのみに限定する（許可リスト方式）。テレメトリ・自動アップデート確認は環境変数で無効化する。この制限が効いていることをテストで担保する（バックエンドへ渡すオプションの検証）。
- **理由**: Claude Code は既定でファイル読み書き・シェル実行・Web 検索の能力を持つコーディングエージェントであり、無効化しないと「LLM は文面生成とアプリ定義ツールのみ・外部送信は Anthropic への推論リクエストのみ」という本アプリの不変制約（`docs/features/ai-boss-mvp.md` 非機能要件）を破りうる。
- **代替案**: パーミッションモードによる制限のみで運用 — 許可リストに比べ将来のビルトインツール追加で穴が開きうるため、明示的な許可リスト方式を採る。
- **影響範囲**: `server/src/llm/` のバックエンド実装。既存のカスタムツール定義（`server/src/boss/boss-tools.ts`・`server/src/decisions/verdict-tool.ts`）は変更しない。

## 機能全体の設計

### アーキテクチャ決定

`server/src/llm/claude-client.ts` をファサードとし、配下にバックエンド実装を置く:

```text
server/src/llm/
  claude-client.ts        # ファサード（公開 IF は現行を維持）+ 統一タイムアウト・リトライ
  backends/
    api-backend.ts        # 現行の @anthropic-ai/sdk 呼び出しを移設
    claude-code-backend.ts # Agent SDK 呼び出し + 出力正規化 + in-process MCP ツール定義
```

- 呼び出し 4 箇所は import 先・呼び出し形を変えない（ファサードが `LLM_BACKEND` に応じて委譲する）。型注釈の変更はクリティカル設計決定の「補足決定（ファサードの型設計と『無改修』の正確なスコープ）」に従う。
- バックエンドの選択値は `loadConfig` が読み、ファサードへ渡す（`process.env` をファサード内で直接読まない）。

### IF / API

- ファサードの公開関数は現行の `createClaudeClient` / `streamBossMessage` / `createBossMessage` / `buildToolResultMessage` を維持する。戻り値のコンテンツブロックは、呼び出し元が参照する `{type:"text",text}` と `{type:"tool_use",id,name,input}` を必ず満たす。
- `claude-code` バックエンドの出力正規化（Agent SDK のメッセージ → 上記ブロック形式）はバックエンドモジュール内に閉じる。

### 実装計画（チケット分解の見通し）

1. 基盤: `LLM_BACKEND` 設定の読み込み・検証（FR-01・FR-02・FR-13）+ ファサード化（既存 api 実装の backends/ への移設・既存テスト維持・ファサード層の統一タイムアウト/リトライ実装〔非機能要件・信頼性。AC-11 の検証対象〕）
2. claude-code バックエンド本体: Agent SDK 統合・in-process MCP ツール・出力正規化・ストリーミング（FR-03〜FR-08・FR-14・非機能要件）
3. セキュリティ・エラー系: 環境変数除外・エラー型・フォールバック禁止・テレメトリ無効化（FR-09〜FR-12）

最終分解は `/create-ticket` で行う。

## 受入基準

- [ ] AC-01: `LLM_BACKEND` 未設定で起動した場合、現行と同一の挙動（api バックエンド）で全既存テストが通過する。
- [ ] AC-02: `LLM_BACKEND=不正値` で起動した場合、サーバーが起動せず、許容値（`api` / `claude-code`）を含むエラーメッセージが表示される。
- [ ] AC-03: `LLM_BACKEND=claude-code` かつ `ANTHROPIC_API_KEY` 未設定で、チャット送信 → text delta の SSE 受信 → カスタムツール実行 → 応答保存、の一連が動作する（Agent SDK はモック。結合確認は walkthrough で実施）。「前提・仮定（明示）」4 の縮退仕様が発動した場合は「1 応答 1 text イベントの SSE 受信」で本基準を満たすとみなす。
- [ ] AC-04: `claude-code` バックエンドで再裁定を実行し、submit_verdict ツール入力が現行と同じ検証（`parseVerdictToolInput`）を通過して裁定が保存される。ツール未呼び出し時は HTTP 500 が返る。
- [ ] AC-05: `claude-code` バックエンドへ渡すオプションに、ビルトインツールが含まれず、許可ツールがアプリ定義ツールのみであることをテストで確認できる。
- [ ] AC-06: `claude-code` バックエンドの実行環境へ渡す環境変数に `ANTHROPIC_API_KEY` が含まれず、`DISABLE_TELEMETRY=1` と `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` が含まれることをテストで確認できる。
- [ ] AC-07: `claude-code` バックエンドで実行環境不備エラーが発生した場合、チャット・再裁定は HTTP 500、ダッシュボードコメント・通知文面はテンプレートフォールバックとなり、ログにエラークラス名のみが記録される。api バックエンドへの自動切替が発生しない。
- [ ] AC-08: settings の `model` 変更が `claude-code` バックエンドの呼び出しに反映される（モックに渡された model 値で確認）。
- [ ] AC-09: `/quality-check` が pass する（lint / typecheck / test 全通過）。
- [ ] AC-10: `claude-code` バックエンドでダッシュボードコメント生成・通知文面生成が動作する（モックに応答テキストを返させ、生成結果が保存・返却されることを確認する）。ダッシュボードコメントのプロンプトに FR-14 の短文指示が含まれることをテストで確認できる。
- [ ] AC-11: `claude-code` バックエンドのファサード層タイムアウト（120 秒）・リトライ（最大 2 回・指数バックオフ）を、モックで失敗・遅延を注入して検証できる（リトライ回数とタイムアウト発火の確認。時刻はモックし TZ・実時間に依存しない）。
- [ ] AC-12: `LLM_BACKEND=claude-code` で起動時の可用性確認（FR-13）が失敗しても、警告ログが出力されたうえでサーバーの起動が継続することをテストで確認できる。
