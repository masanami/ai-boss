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
- [ ] FR-04: チャットの SSE 挙動は両バックエンドで同一の外部仕様とする。イベント契約（現行実装・`web/src` のクライアント型と同一）: `event: text`（データ `{text}`＝delta）、`event: tool`（データ `{name, input, result, isError}`。ツール ID を外部ペイロードに追加しない）、正常完了時 `event: done`（保存済みボスメッセージ）、ストリーム障害時 `event: error`。イベント順序は「text（0 回以上）→ tool（ツール使用時）→ 次ラウンドの text → … → done」とし、最終メッセージを DB に保存する。Agent SDK 出力からこの契約への変換規則はバックエンド内に閉じる。ただし Agent SDK が partial message 相当の逐次イベントを提供しない場合に限り、「前提・仮定（明示）」4 の縮退仕様（1 応答 1 text イベント）に従い、縮退時も本要件を満たすとみなす。
- [ ] FR-05: カスタムツール（BOSS_TOOLS・SUBMIT_VERDICT_TOOL）は、`claude-code` バックエンドでは Agent SDK の in-process MCP サーバ（`createSdkMcpServer` / `tool()`）として提供し、既存のツール実行関数（`executeBossTool` / `parseVerdictToolInput`）を再利用する。ツールの実行主体と呼び出し元への通知はクリティカル設計決定の「補足決定（ツール実行主体の一本化）」に従う。
- [ ] FR-06: `claude-code` バックエンドでは Claude Code のビルトインツール（Bash・Read・Write・Edit・WebSearch・WebFetch を含む全ビルトインツール）を無効化し、許可ツールをアプリ定義のカスタムツールのみに限定する。この制限は許可リスト（自動承認リスト）のみに依存せず、Agent SDK が提供する「ビルトインツール集合の明示指定」「設定ファイル（settings）読み込みの無効化」「MCP 構成の厳格化」の設定を併用し、未許可ツールの使用要求は拒否する（各設定キー名は実装時の SDK バージョンで確認し、採用したオプション名を実装チケットに記録する）。
- [ ] FR-07: 再裁定（submit_verdict）は `tool_choice` 強制の等価機能が Agent SDK に無いため、プロンプトによるツール使用指示のみで代替する。ツールが呼ばれなかった場合は現行実装と同じく再試行せず HTTP 500 を返す。
- [ ] FR-08: settings テーブルの `model` 設定は両バックエンドに適用される（`claude-code` バックエンドでは Agent SDK の model オプションに渡す）。
- [ ] FR-09: `claude-code` バックエンド選択時、`ANTHROPIC_API_KEY` を Agent SDK およびその子プロセスへ渡さない（サブスクリプション認証を強制し、API キー課金への意図しない切替を防ぐ）。子プロセス環境は `process.env` を基礎としたコピーから `ANTHROPIC_API_KEY` のみを除外し、テレメトリ無効化変数（非機能要件参照）を追加して明示的に渡す（`PATH`・`HOME`・Claude Code の設定ディレクトリ指定変数のような実行・認証に必要な変数を保持するため。Agent SDK は `env` 指定時に親環境と自動マージしない前提を置く）。この除外・付与・継承はユニットテストで担保する。
- [ ] FR-10: `claude-code` バックエンド選択時は `MissingApiKeyError` の検査を行わない（`ANTHROPIC_API_KEY` 未設定でも動作する）。`api` バックエンドの挙動は現行から変更しない。
- [ ] FR-11: `claude-code` バックエンドの実行環境不備（Claude Code 未インストール・未ログイン）は専用エラー型（例: `ClaudeCodeUnavailableError`）で表現し、呼び出し元の既存契約に乗せる: チャット・再裁定は HTTP 500、ダッシュボードコメント・通知文面はテンプレートへフォールバックする。ログにはエラークラス名のみ残す（現行のログ規律を継承）。
- [ ] FR-12: `claude-code` バックエンドの失敗時に `api` バックエンドへ自動フォールバックしない（オーナーの課金意図に反する無断切替を禁止する）。
- [ ] FR-13: サーバー起動時、`LLM_BACKEND=claude-code` の場合は Claude Code 実行環境の可用性を best-effort で確認する。確認の対象は「Agent SDK が実際に使用する Claude Code 実行バイナリ」（SDK 同梱バイナリ。SDK が実行パスの取得・指定手段を提供する場合はバックエンド実装と同じパスを共有する）とし、PATH 上の `claude` コマンドの検査で代替しない。確認の内容は「当該バイナリのバージョン取得を `execFile`（シェル非経由）で実行し、失敗（ENOENT・非ゼロ終了・タイムアウト）で警告ログを出す」とする（トークン消費を伴う疎通確認は行わない。起動は止めない。現行の `hasAnthropicApiKey` 警告パターンを踏襲）。
- [ ] FR-14: `claude-code` バックエンドのダッシュボードコメント生成では、リクエスト単位の応答長上限（現行 `DASHBOARD_COMMENT_MAX_TOKENS=150`）の代替として、プロンプトに明示的な短文指示（1〜2 文・全角 80 字以内）を追加する。プロンプト指示のみでは上限を保証できないため、生成後に上限（全角 80 字相当）を検証し、超過時は既存のテンプレートフォールバックを使用する（短いコメントという既存 UI の契約を維持するため）。
- [ ] FR-15: `claude-code` バックエンドでは Claude Code のセッション履歴の永続化（`~/.claude/projects/` 配下への会話 JSONL 書き出し）を無効化する（オプション名は実装時の SDK バージョンで確認し、実装チケットに記録する）。会話データの保存先をアプリの SQLite に一本化する。SDK が永続化の無効化手段を提供しない場合は、警告ログを出して動作を継続し、逸脱（ローカルディスク内の Claude Code セッションファイルに会話履歴が残ること。外部送信は発生しない）を実装チケットと本仕様に明記する（オーナーがこの逸脱を許容しない場合は `api` バックエンドを使用する）。

## 非機能要件

- パフォーマンス: チャットのストリーミング体感（text delta の逐次 SSE 送出）を `claude-code` バックエンドでも維持する（Agent SDK の partial message ストリーミングを使用する）。ただし Agent SDK が partial message 相当の逐次イベントを提供しない場合は「前提・仮定（明示）」4 の縮退仕様に従い、縮退時も本要件を満たすとみなす（FR-04・AC-03 と同一の条件）。
- セキュリティ・プライバシー: 「全データはローカル SQLite・外部送信は Anthropic への推論リクエストのみ」という不変制約を `claude-code` バックエンドでも維持する。FR-06 のビルトインツール無効化・FR-15 のセッション永続化無効化に加え、Claude Code の非必須外部通信（テレメトリ・自動アップデート確認）を無効化する環境変数（`DISABLE_TELEMETRY=1`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）をバックエンド実行時に設定する。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` は自動アップデート確認も無効化するが、バックエンドが使用する Claude Code 実行系は npm 依存（Agent SDK 同梱）としてバージョン管理されるため、実行時自動更新の無効化は意図した挙動である（セキュリティ更新は依存更新〔npm〕で取り込む）。
- 信頼性: 呼び出し全体のタイムアウト 120 秒・失敗時の指数バックオフ再試行最大 2 回を両バックエンドの統一ポリシーとする。実装箇所の帰属: `api` バックエンドは現行どおり `@anthropic-ai/sdk` のクライアントオプション（`timeout` / `maxRetries`）への委譲を変更しない。`claude-code` バックエンドはファサード層で新規に実装し、次の 3 点を満たす: (1) SDK/CLI 内部の自動リトライは設定（環境変数・オプション。実装時に確認し記録）で無効化または最小化し、ファサードのリトライと二重に効かせない。(2) 呼び出し全体の期限（120 秒）は `AbortController` で実装し、期限到達時はクエリをキャンセルする（リクエスト単位タイムアウトや maxTurns で代替しない）。(3) ファサードのリトライはツール実行（DB 副作用）前の失敗に限定し、ツール実行後の失敗は再試行せずエラー契約へ流す（副作用の重複実行を防ぐため）。

## 技術的な制約・方針

- 使用技術: `@anthropic-ai/claude-agent-sdk`（server workspace に新規依存として追加）
- 変更対象: `server/src/llm/`（ファサード化とバックエンド実装の追加）、`server/src/config.ts`（`LLM_BACKEND` の読み込み・検証）、`server/.env.example`
- 既存コードとの関係: ダッシュボードコメント・通知文面の 2 箇所はロジック無改修（型注釈・import の型名の機械的な変更のみ）。チャット・再裁定の 2 箇所は「ツール実行主体の一本化」（クリティカル設計決定の補足決定）に伴いファサードの新契約への置換改修を行うが、HTTP・SSE の外部仕様は変更しない（詳細はクリティカル設計決定の「補足決定（ファサードの型設計と『無改修』の正確なスコープ）」「補足決定（ツール実行主体の一本化）」）
- テスト方針: `claude-code` バックエンドのテストは `vi.mock("@anthropic-ai/claude-agent-sdk")` によるモジュールモックで行う（現行の `vi.mock("@anthropic-ai/sdk")` パターンを踏襲）。web/ 配下の変更は行わない（設定 UI へのバックエンド選択の露出はしない）

### 前提・仮定（明示）

本機能は単一 repo 完結の課題として、以下を明示的な仮定として置く。実装前にオーナーが否定した場合は該当部分を見直す。

1. **課金の前提（公式サポート記事で確認済み・2026-08-13 時点）**: Agent SDK・`claude -p` いずれの利用も、サブスクリプションの通常利用枠を消費する（API キーの従量課金とは別経路）。2026-06-15 に予定されていた SDK 専用クレジット枠への分離は同日に一時停止され、発効していない。この変更が将来再開された場合は課金経路が変わるため、再開アナウンス時に本前提を見直す。usage credits（利用枠超過後に標準 API レートで課金されるオプトイン機能）は別機能であり、本仕様では有効化を前提としない。`ANTHROPIC_API_KEY` を SDK に渡すと API 従量課金経路になるため、FR-09 で除外を担保する。
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
- **影響範囲**: `server/src/llm/` 配下。ここで維持を主張するのはコンテンツブロックのフィールド形式（呼び出し元が参照する `{type:"text",text}` / `{type:"tool_use",id,name,input}`）のみであり、チャット・再裁定のコールバック／戻り値契約自体は「補足決定（ツール実行主体の一本化）」により変更される。バックエンド出力の正規化はバックエンドモジュール内に閉じ込める。
- **補足決定（ツール実行主体の一本化）**: Agent SDK は in-process MCP ツールを自身のエージェントループ内で実行するため、現行のチャットルートの外側ツールループ（`tool_use` を受けて `executeBossTool` を実行し tool_result を返す方式）をそのまま併用すると、ツールの二重実行またはツールイベントの欠落が生じる。これを避けるため、**ツール実行主体をバックエンド内部（ファサード配下）に一本化**し、呼び出し元はツールを実行しない。具体的には: (1) チャットのツールループ（MAX_TOOL_ROUNDS・`executeBossTool` 実行・tool_result 継続）はファサード内へ移設し、`api` バックエンドもファサード内のループで実行する。(2) `claude-code` バックエンドでは MCP ハンドラが実行主体となる。(3) ファサードの `streamBossMessage` はコールバック契約を `onTextDelta`（既存）＋ `onToolEvent`（新設。FR-04 の `{name, input, result, isError}` を通知）へ拡張し、チャットルートは SSE 送出のみを担う。(4) 再裁定はファサードが「submit_verdict の検証済み結果、または未呼び出しの明示」を返す契約とする。いずれの経路でも、ツール副作用（DB 書き込み）と入力検証は 1 リクエストにつき一度だけ実行される（AC-03・AC-04 で検証）。
- **補足決定（ファサードの型設計と「無改修」の正確なスコープ）**: 現行の `createClaudeClient(env): Anthropic` は `@anthropic-ai/sdk` の具象クラス型を返し、呼び出し 4 箇所の型注釈（`let client: Anthropic`）もこれに結合しているため、戻り値型をバックエンド共通の抽象型（判別可能ユニオン。例: `type BossLlmClient = { backend: "api"; client: Anthropic } | { backend: "claude-code"; ... }`）へ変更する。`streamBossMessage` / `createBossMessage` はこの抽象型を受け取り、内部でバックエンド実装へ委譲する。呼び出し元の改修範囲: ダッシュボードコメント・通知文面の 2 箇所はロジック無改修とし、型注釈・import の型名の機械的な変更のみ許容する（対象は `let client: Anthropic` のような変数宣言に限らず、`boss-comment.ts` の `extractText` のシグネチャのような Anthropic SDK 具象型への参照全般を含み、typecheck 通過〔AC-09〕まで追随変更する）。チャットルートはツールループを廃止し「補足決定（ツール実行主体の一本化）」のコールバック契約への置換改修を、再裁定ルートは同・戻り値契約への置換改修を行う（HTTP・SSE の外部仕様は不変）。ユニオンの `claude-code` バリアントのフィールド具体設計は `backends/claude-code-backend.ts` の実装詳細に委ね、ファサード側は `backend` 判別のみに用いる。
- **補足決定（FR-10 とエラーハンドリングの整合）**: `createClaudeClient`（ファサード）は `api` バックエンド時のみ `MissingApiKeyError` を投げる。`claude-code` バックエンド時は API キー検査を行わず、実行環境不備は `ClaudeCodeUnavailableError` として投げる。呼び出し 4 箇所の既存 catch 節は `Error` 一般を処理して HTTP 500 またはテンプレートフォールバックへ導くため、catch 節のロジック改修なしで両エラー型に対応できる。また、Agent SDK が失敗を例外ではなく「非成功の結果メッセージ」（`is_error` 相当。例: 最大ターン到達・実行中エラーの subtype）として返す場合、ファサードはすべての非成功 subtype を `Error` へ変換して同じエラー契約に乗せる（非成功結果を成功として返し、不完全な応答を保存しない）。両経路（例外・非成功結果メッセージ）は AC-07 で検証する。
- **補足決定**: 会話状態は現行のステートレス方式（DB から履歴を再構築し毎回全文送信）を両バックエンドで維持する。Agent SDK のセッション継続機能（resume）は「boss セッション ⇔ backend セッション」のマッピング状態の新設が必要になり YAGNI に反するため今回のスコープ外とする。

### セキュリティ・認証情報の取り扱い

- **採用案**: バックエンド選択は `server/.env` の `LLM_BACKEND`（起動時に `loadConfig` で一度だけ読み検証）。`claude-code` バックエンドは Claude Code のログイン済み資格情報を暗黙に使い、アプリはトークンを一切扱わない。`ANTHROPIC_API_KEY` は Agent SDK とその子プロセスの環境変数から明示的に除外し、除外をテストで担保する（FR-09）。失敗時の `api` への自動フォールバックは禁止する（FR-12）。
- **理由**: バックエンド選択は「このマシンで何が使えるか」というマシン固有の実行環境事実であり、`ANTHROPIC_API_KEY` / `DB_PATH` / `PORT` と同じ `.env` の建て付けが既存パターンと整合する。settings テーブル（UI から変更可能）に置くと、サブプロセス実行モードの切替という重い決定がブラウザから触れる面に露出し、クリティカル箇所のレビュー方針とも整合しない。
- **代替案**: settings テーブル + 設定 UI での切替 — UI から再起動なしで切替できる利点はあるが、上記の理由および実行環境の可否（インストール・ログイン状態）に依存する設定は保存時に検証できない点で却下。
- **影響範囲**: `server/src/config.ts`・`server/.env.example`・`server/src/llm/`。`MissingApiKeyError` は `api` バックエンド専用の検査として現行位置に残す。

### プライバシー不変制約の維持（ビルトインツール無効化・セッション永続化無効化）

- **採用案**: `claude-code` バックエンドでは Claude Code のビルトインツールを全無効化し、許可ツールをアプリ定義のカスタムツールのみに限定する（FR-06 の多層方式）。あわせてセッション履歴の永続化を無効化し（FR-15）、テレメトリ・自動アップデート確認は環境変数で無効化する。これらの制限が効いていることをテストで担保する（バックエンドへ渡すオプションの検証）。
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

- ダッシュボードコメント・通知文面の 2 箇所は import 先・呼び出し形を変えない（ファサードが `LLM_BACKEND` に応じて委譲する）。チャット・再裁定の 2 箇所はファサードの新契約（コールバック／戻り値）への置換のみ行い、HTTP・SSE の外部仕様は変えない。型注釈の変更はクリティカル設計決定の「補足決定（ファサードの型設計と『無改修』の正確なスコープ）」に従う。
- バックエンドの選択値は `loadConfig` が読み、ファサードへ渡す（`process.env` をファサード内で直接読まない）。

### IF / API

- ファサードの公開関数は現行の `createClaudeClient` / `streamBossMessage` / `createBossMessage` / `buildToolResultMessage` を基礎に維持する。戻り値のコンテンツブロックは、呼び出し元が参照する `{type:"text",text}` と `{type:"tool_use",id,name,input}` を必ず満たす。
- `streamBossMessage` のコールバック契約は `onTextDelta`（既存）＋ `onToolEvent`（新設。FR-04 の `{name, input, result, isError}`）とし、ツールループはファサード内部に持つ（「補足決定（ツール実行主体の一本化）」）。再裁定向けには submit_verdict の検証済み結果（または未呼び出しの明示）を返す契約を提供する。
- `claude-code` バックエンドの出力正規化（Agent SDK のメッセージ → 上記ブロック形式・イベント）はバックエンドモジュール内に閉じる。

### 実装計画（チケット分解の見通し）

1. 基盤: `LLM_BACKEND` 設定の読み込み・検証（FR-01・FR-02・FR-13）+ ファサード化（既存 api 実装の backends/ への移設・ツールループのファサード内移設と `onToolEvent` コールバック契約の導入・チャット/再裁定ルートの新契約への置換・既存テスト維持・ファサード層の統一タイムアウト/リトライ実装〔非機能要件・信頼性。AC-11 の検証対象〕）
2. claude-code バックエンド本体: Agent SDK 統合・in-process MCP ツール・出力正規化・ストリーミング（FR-03〜FR-08・FR-14・非機能要件）
3. セキュリティ・エラー系: 環境変数除外・エラー型・フォールバック禁止・テレメトリ無効化・セッション永続化無効化（FR-09〜FR-12・FR-15）

最終分解は `/create-ticket` で行う。

## 受入基準

- [ ] AC-01: `LLM_BACKEND` 未設定で起動した場合、現行と同一の挙動（api バックエンド）で全既存テストが通過する。
- [ ] AC-02: `LLM_BACKEND=不正値` で起動した場合、サーバーが起動せず、許容値（`api` / `claude-code`）を含むエラーメッセージが表示される。
- [ ] AC-03: `LLM_BACKEND=claude-code` かつ `ANTHROPIC_API_KEY` 未設定で、チャット送信 → text delta の SSE 受信 → カスタムツール実行 → 応答保存、の一連が動作する（Agent SDK はモック。結合確認は walkthrough で実施）。ツール副作用（DB 書き込み）が 1 ツール呼び出しにつき一度だけ実行され、`event: tool` が 1 ツール実行につき一度だけ・FR-04 のペイロードと順序で送出されることを併せて検証する。「前提・仮定（明示）」4 の縮退仕様が発動した場合は「1 応答 1 text イベントの SSE 受信」で本基準を満たすとみなす。
- [ ] AC-04: `claude-code` バックエンドで再裁定を実行し、submit_verdict ツール入力が現行と同じ検証（`parseVerdictToolInput`）を通過して裁定が保存される。検証と保存が 1 リクエストにつき一度だけ実行されることを併せて検証する。ツール未呼び出し時は HTTP 500 が返る。
- [ ] AC-05: `claude-code` バックエンドへ渡すオプションに、ビルトインツールが含まれず、許可ツールがアプリ定義ツールのみであることをテストで確認できる。併せて、設定ファイル（settings）由来のツール・MCP サーバが読み込まれない設定であること、未許可ツールの使用要求が拒否されることを確認できる。
- [ ] AC-06: `claude-code` バックエンドの実行環境へ渡す環境変数が `process.env` を基礎としており、`ANTHROPIC_API_KEY` を含まず、`DISABLE_TELEMETRY=1` と `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を含み、実行に必要な既存変数（`PATH`・`HOME` 相当）を保持していることをテストで確認できる。
- [ ] AC-07: `claude-code` バックエンドで実行環境不備エラーが発生した場合、チャット・再裁定は HTTP 500、ダッシュボードコメント・通知文面はテンプレートフォールバックとなり、ログにエラークラス名のみが記録される。api バックエンドへの自動切替が発生しない。失敗が例外として送出される経路と、Agent SDK が非成功の結果メッセージ（`is_error` 相当）で返す経路の両方をテストする。
- [ ] AC-08: settings の `model` 変更が `claude-code` バックエンドの呼び出しに反映される（モックに渡された model 値で確認）。
- [ ] AC-09: `/quality-check` が pass する（lint / typecheck / test 全通過）。
- [ ] AC-10: `claude-code` バックエンドでダッシュボードコメント生成・通知文面生成が動作する（モックに応答テキストを返させ、生成結果が保存・返却されることを確認する）。ダッシュボードコメントのプロンプトに FR-14 の短文指示が含まれること、および上限（全角 80 字相当）を超過する応答を返すモックでテンプレートフォールバックとなることをテストで確認できる。
- [ ] AC-11: `claude-code` バックエンドのファサード層タイムアウト（120 秒）・リトライ（最大 2 回・指数バックオフ）を、モックで失敗・遅延を注入して検証できる（呼び出し全体の経過時間上限と期限到達時のキャンセル・リトライ回数・ツール実行後の失敗が再試行されないこと、の確認。時刻はモックし TZ・実時間に依存しない）。
- [ ] AC-12: `LLM_BACKEND=claude-code` で起動時の可用性確認（FR-13）が失敗しても、警告ログが出力されたうえでサーバーの起動が継続することをテストで確認できる。可用性確認の対象が PATH 上の `claude` コマンドではなく、バックエンド実装と共有された Claude Code 実行バイナリのパスであることを併せて確認できる。
- [ ] AC-13: `claude-code` バックエンドの呼び出しで、セッション履歴の永続化を無効化するオプション（FR-15）がモックに渡ることをテストで確認できる。
