# 保証台帳（ai-boss）

> **この台帳が、このリポジトリの駆動文書です。** 機能仕様（`docs/features/`）は退役し、恒常的な設計決定は `docs/adr/` へ、すでに守られている公開面の振る舞いは本台帳へ移しました。
>
> ここに書かれているのは「**現に守られていて、テストで担保されている外向きの約束**」です。実装の内部設計・アルゴリズムはここには書きません（コードとテストが正本）。将来やりたいことも書きません（GitHub Issue が正本）。

## 読み方

| 列 | 意味 |
|---|---|
| ID | 保証の識別子。参照時はこの ID を使う。**採番は再利用しない**（保証を削除しても番号は空けたままにする） |
| 公開面 | 約束が観測される面（API・画面・純粋関数・実行系など） |
| 保証（約束） | 外から観測できる約束。条件と結果を含む |
| 参照テスト | その約束を担保しているテスト。**テストが消えたら保証も消える**（保証を残したままテストを消さない） |
| 宣言元 | この約束が決まった出所。`ADR NNNN` は恒常的な設計決定、`#N` は GitHub Issue、`退役仕様` は本 PR で削除した `docs/features/` の該当ドキュメント |

## 運用規律

- **保証を変える PR は、この台帳と参照テストを同時に変える。** 台帳だけ・テストだけを変えない。
- **保証を削除するのは、その約束を意図的にやめるときだけ。** テストが落ちたから台帳から消す、は禁止。
- **「Gaps」は約束ではない。** テストで担保されていない公開面の一覧であり、埋めるべき負債として扱う。Gaps の項目に依存した実装をしない。
- 内部実装のテスト（private ヘルパの分岐網羅・リポジトリ層の単体テスト等）は、公開面の保証が別途あるものについては本台帳に載せていない。それらは自由にリファクタリングしてよい。

---

## 1. サボり検知ルールエンジン

> 関連: [ADR 0004](./adr/0004-deterministic-detection-engine.md)（検知は決定的なルールエンジン・LLM は文面のみ）、[ADR 0007](./adr/0007-local-calendar-day-basis.md)（日付基準）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-001 | 検知ルール: 回避 | 最優先タスク以外への直近の活動（`task_start` / `task_update`）が閾値ウィンドウ内にあれば回避とみなし、ウィンドウ外・自タスクへの活動・対象外イベント種別・`task_id` なしは回避としない | `server/src/detection/avoidance.test.ts` :: returns true when another task had a task_start within the window | ADR 0004 / 退役仕様 mvp |
| G-002 | 検知ルール: 休憩延伸 | `break_end` が未記録の最新 `break_start` について、申告時間（未申告ならフォールバック値）を超過したら呼び戻し対象と判定する | `server/src/detection/break-overrun.test.ts` :: fires once the expected_minutes has been exceeded | ADR 0004 / 退役仕様 mvp |
| G-003 | 検知ルール: 締切超過 | `due_at` が現在時刻より過去の todo / in_progress タスクをすべて抽出する。done / dropped・`due_at` 未設定・ちょうど締切時刻のタスクは含めない | `server/src/detection/deadline-overdue.test.ts` :: returns every overdue task, not just the top-priority one | ADR 0004 / 退役仕様 mvp |
| G-004 | 検知ルール: 段階エスカレーション | 同一 `rule_key` の催促は履歴が無ければ即 L1、L1→L2 は既定 15 分・L2→L3 は既定 10 分の経過で昇格し L3 で頭打ち。直前通知後に活動シグナルがあれば L1 へリセットして即発火する。`rule_key` ごとに独立して管理される | `server/src/detection/escalation.test.ts` :: escalates from level 1 to level 2 exactly at the 15min interval, resets to level 1 and fires immediately when an activity signal occurred after the last notification | ADR 0004 / 退役仕様 mvp |
| G-005 | 検知ルール: 朝会・夕会の定時催促 | 設定時刻を過ぎてもその日その種別（morning / evening）のセッションが未開始なら催促対象と判定する。時刻設定が不正な場合は警告して発火しない | `server/src/detection/meeting.test.ts` :: fires when the meeting time has passed and no session of that type started today | ADR 0004 / 退役仕様 mvp |
| G-006 | 検知ルール: 優先タスク選定 | done / dropped を除外した候補から、優先度の高い順 → 締切の早い順 → id 昇順で「今日の最優先タスク」を 1 つ選ぶ（候補が無ければ未選出） | `server/src/detection/priority.test.ts` :: picks the higher priority task over a lower priority one, breaks a priority tie by earlier due_at | ADR 0004 / 退役仕様 mvp |
| G-007 | 検知ルール: 合成と抑制 | 未着手・回避・締切超過・休憩延伸・無音・朝会夕会催促を毎回まとめて評価する。休憩申告中は休憩延伸以外を抑制し、勤務時間帯外は朝会・夕会催促以外（休憩延伸を含む）をすべて抑制する | `server/src/detection/rule-engine.test.ts` :: suppresses all rules except break_overrun while on break, suppresses all detection rules (including break_overrun) outside working hours | ADR 0004 / 退役仕様 mvp |
| G-008 | 検知ルール: 無音検知 | 直近の `task_start` 対象タスクの `estimated_minutes` を基準に無音許容分数を算出し（20〜90 分にクランプ・基準が無ければ 45 分）、最後の活動からその閾値を超えた無音を検知する。活動履歴が皆無なら発火しない | `server/src/detection/silence.test.ts` :: clamps the scaled threshold down to the 90min ceiling, fires exactly at the threshold | ADR 0004 / 退役仕様 mvp |
| G-009 | 検知ルール: 勤務時間帯判定 | 設定された勤務時間帯（開始は含む・終了は含まない）の内外を判定する。時刻設定が不正なら既定の 09:00–18:00 へフォールバックして警告する | `server/src/detection/time-utils.test.ts` :: returns true at the exact start boundary, returns false at the exact end boundary (end is exclusive) | ADR 0004 / 退役仕様 mvp |
| G-010 | 検知ルール: 未着手検知 | 最優先タスクの `estimated_minutes` を基準に未着手許容分数を算出し（15〜120 分にクランプ・基準が無ければ 60 分）、作成時刻からその閾値が経過しても todo のままなら検知する。in_progress では発火しない | `server/src/detection/unstarted.test.ts` :: clamps large estimated_minutes down to the 120min ceiling, does not fire when the task is already in_progress | ADR 0004 / 退役仕様 mvp |

---

## 2. LLM バックエンドと設定

> 関連: [ADR 0001](./adr/0001-local-only-data-boundary.md)（ローカル完結の不変制約）、[ADR 0002](./adr/0002-api-key-and-llm-call-path.md)（API キーの取り扱い）、[ADR 0003](./adr/0003-llm-backend-isolation.md)（Claude Code の能力剥奪）
>
> **この節の保証は不変制約を直接支えています。** 変更する PR は人間レビュー必須（クリティカル箇所）。

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-011 | claude-code バックエンド: API キーの除外 | 子プロセス環境から `ANTHROPIC_API_KEY` を必ず除外する。渡された `process.env` オブジェクト自体は変更しない | `server/src/llm/backends/claude-code-backend.test.ts` :: excludes ANTHROPIC_API_KEY from a process.env-based copy, does not mutate the given process.env object | ADR 0003 / 退役仕様 ccb FR-09 |
| G-012 | claude-code バックエンド: テレメトリ無効化 | 子プロセス環境に `DISABLE_TELEMETRY=1` と `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を常に設定し、`PATH` / `HOME` は保持する | `server/src/llm/claude-client.test.ts` :: excludes ANTHROPIC_API_KEY, adds the telemetry-disable vars, and preserves PATH/HOME (FR-09, AC-06) | ADR 0001, ADR 0003 / 退役仕様 ccb |
| G-013 | claude-code バックエンド: ツール許可リスト | ビルトインツールを無効化し（`tools:[]` / `settingSources:[]` / `strictMcpConfig:true`）、許可判定でビルトイン・他 MCP・修飾なしの名前を deny、アプリ定義の完全修飾 MCP ツールのみ allow する | `server/src/llm/backends/claude-code-backend.test.ts` :: passes a canUseTool handler that denies built-in and foreign MCP tools, allows exactly the app-defined fully-qualified MCP tools | ADR 0003 / 退役仕様 ccb FR-06 |
| G-014 | claude-code バックエンド: ツール未指定時 | ツールを渡さない呼び出し（通知文面・ダッシュボードコメント）では MCP サーバ・許可リストを登録せず、すべてのツールを deny する | `server/src/llm/backends/claude-code-backend.test.ts` :: registers no MCP server / allowedTools when no tools are given, denies every tool when the call site provides no tools | ADR 0003 / 退役仕様 ccb FR-06 |
| G-015 | claude-code バックエンド: セッション永続化の無効化 | セッション履歴の永続化を無効化して呼び出す（会話の保存先を SQLite に一本化する） | `server/src/llm/backends/claude-code-backend.test.ts` :: forwards the given env to query()'s env option, and disables session persistence (FR-09/AC-06, FR-15/AC-13) | ADR 0001, ADR 0003 / 退役仕様 ccb FR-15 |
| G-016 | LLM ファサード: 自動フォールバック禁止 | claude-code バックエンドが失敗しても（再試行を尽くした後も）`api` バックエンドへ自動フォールバックしない | `server/src/llm/claude-client.test.ts` :: does not fall back to the api backend when claude-code fails, even after retries are exhausted (FR-12, AC-07) | ADR 0003 / 退役仕様 ccb FR-12 |
| G-017 | LLM ファサード: 既定バックエンド | `LLM_BACKEND` を明示しない場合は claude-code を使い、`ANTHROPIC_API_KEY` 未設定でも `MissingApiKeyError` を投げない | `server/src/llm/claude-client.test.ts` :: defaults to the claude-code backend (DEFAULT_LLM_BACKEND, Issue #118) …and never throws MissingApiKeyError without ANTHROPIC_API_KEY | #118 / 退役仕様 ccb FR-01 |
| G-018 | LLM ファサード: 副作用後の再試行禁止 | DB を書き込むツールを実行した後、またはテキストを既にクライアントへ配信した後に失敗した場合は再試行しない（副作用の二重発生・テキストの二重配信を防ぐ） | `server/src/llm/claude-client.test.ts` :: does not retry once a DB-writing tool has been executed during the failed attempt (AC-11), does not retry once text has already been streamed to the caller | ADR 0003 / 退役仕様 ccb |
| G-019 | LLM ファサード: タイムアウトとリトライ | タイムアウト予算は呼び出し全体で共有し（リトライごとにリセットしない）、期限到達で signal を abort し `LlmTimeoutError` で reject する。副作用の無い失敗は指数バックオフで再試行する | `server/src/llm/claude-client.test.ts` :: treats timeoutMs as a whole-call budget shared across retries, not reset per attempt, aborts the attempt's signal and rejects with LlmTimeoutError | ADR 0003 / 退役仕様 ccb 非機能要件 |
| G-020 | LLM ファサード: 実行環境不備の警告 | claude-code が利用不可のとき `LLM_BACKEND=api` への切替案内を含む警告を出し、失敗自体は隠蔽せず元のエラーで reject する | `server/src/llm/claude-client.test.ts` :: logs the CLAUDE_CODE_UNAVAILABLE_HINT via console.warn and still rejects with the original ClaudeCodeUnavailableError (Issue #118) | #118 / 退役仕様 ccb FR-11 |
| G-021 | 設定: 秘密情報をログに出さない | `ANTHROPIC_API_KEY` の値そのものは `console.log` / `console.warn` のいずれにも出力されない | `server/src/config.test.ts` :: reports hasAnthropicApiKey as true and never logs the key value when ANTHROPIC_API_KEY is set | ADR 0002 / 退役仕様 mvp |
| G-022 | 設定: `LLM_BACKEND` の検証と起動ログ | `LLM_BACKEND` は `api` / `claude-code` のいずれかでなければ起動時に許容値を含むエラーで停止する。有効値なら既定・明示の区別を添えて起動ログに 1 回だけ出力する | `server/src/config.test.ts` :: throws with an error message including the allowed values when LLM_BACKEND is invalid, logs the effective llmBackend once at startup | ADR 0003 / 退役仕様 ccb FR-02 |
| G-023 | 設定: 課金経路の切替案内 | 既定（未設定）で claude-code が有効かつ `ANTHROPIC_API_KEY` が設定されている場合のみ `LLM_BACKEND=api` への切替を促す警告を出す。明示指定時は出さない | `server/src/config.test.ts` :: warns to set LLM_BACKEND=api when the default claude-code backend is in effect and ANTHROPIC_API_KEY is set (Issue #118) | #118 |
| G-024 | api バックエンド: 診断ログの内容制限 | 応答が空になる異常時（thinking のみ・`max_tokens` 到達）に診断ログを 1 回出すが、thinking 本文・ユーザーメッセージ・システムプロンプトの内容は含めない | `server/src/llm/backends/api-backend.test.ts` :: Issue #117 reproduction: normalizes a thinking-only, stop_reason=max_tokens response to empty content and logs a diagnostic | #117 / ADR 0002 |
| G-025 | 設定: ポートと DB パス | ポート（`PORT`・既定 8787・不正値は既定へフォールバックして警告）と DB パス（`DB_PATH`・既定 `./data/ai-boss.db`）を環境変数から解決する | `server/src/config.test.ts` :: defaults port to 8787 when PORT is not set, falls back to the default port and warns when PORT is not a valid number | ADR 0005 / 退役仕様 mvp |

---

## 3. セッション・チャット・活動記録

> 関連: [ADR 0002](./adr/0002-api-key-and-llm-call-path.md)（SSE 中継）、[ADR 0004](./adr/0004-deterministic-detection-engine.md)（活動シグナルの一元化）、[ADR 0008](./adr/0008-evening-dialogue-prerequisite.md)（夕会の前提条件）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-026 | SSE 契約: チャット応答ストリーム | `text/event-stream` で応答し、生成中は `event: text`（差分テキスト）、ツール実行時は `event: tool`（`name` / `isError` / `result`）を送り、正常終了時は永続化済みボスメッセージを含む `event: done` で締める | `server/src/sessions/chat-messages-route.test.ts` :: streams text deltas and a final done event with the persisted boss message, executes a create_task tool call …emits a tool event | ADR 0002 / 退役仕様 ccb FR-04 |
| G-027 | SSE 契約: エラーイベント | LLM 呼び出しが失敗した場合はボスメッセージを永続化せず、生のエラー文言（request id 等）を含まない `event: error` を送る。ストリーム途中の失敗では部分テキストを保存したうえで `event: error` を送る | `server/src/sessions/chat-messages-route.test.ts` :: emits a sanitized SSE error event when the Claude call fails, without persisting a boss message, persists the partial boss text when the stream fails midway | ADR 0002 / 退役仕様 ccb |
| G-028 | API: 空応答のフォールバック | 応答にテキストもツール実行も無い場合、および thinking のみで `max_tokens` に達した場合でも、空文字ではなく既定のフォールバック文言をボスメッセージとして保存し `done` に含める | `server/src/sessions/chat-messages-route.issue-117.test.ts` :: falls back to the documented 'no response' text (not an empty message) when the SDK returns a thinking-only, max_tokens-truncated turn | #117 |
| G-029 | API: `POST /api/sessions/:id/messages` の検証 | 存在しないセッション id は 404、`content` 欠落は 400 を返し、いずれもストリームへ進まない（LLM 未呼び出し）。クライアント生成失敗時は API キーを含まない 500 JSON を返す | `server/src/sessions/chat-messages-route.test.ts` :: returns 404 for a non-existent session id, returns 500 JSON without leaking the api key when the Claude client cannot be created | ADR 0002 |
| G-030 | 活動シグナル: `chat_message` の自動記録 | チャット送信は、ユーザーメッセージ保存とストリーム開始の前に `activity_events` へ `chat_message` を 1 件記録する | `server/src/sessions/chat-messages-route.test.ts` :: persists the user message and records a chat_message activity event before streaming | ADR 0004 / 退役仕様 mvp |
| G-031 | 活動シグナル: `task_update` の自動記録 | `PATCH /api/tasks/:id` が実フィールド変更を伴い成功した場合のみ `task_update`（`task_id` 付き）を 1 件記録する。404 失敗時・無変更の PATCH では記録しない | `server/src/activity/activity-routes.test.ts` :: records a task_update event when PATCH /api/tasks/:id succeeds, does not record a task_update event when the PATCH body has no fields | ADR 0004 / 退役仕様 mvp |
| G-032 | API: `GET /api/activity/today` | ローカル日付境界（当日 0:00 以降・境界含む）で当日分の活動イベントのみを `created_at` 昇順で返す | `server/src/activity/activity-routes.test.ts` :: returns only today's events (local day boundary), ordered by created_at ascending | ADR 0007 / 退役仕様 mvp |
| G-033 | API: `POST /api/checkins` | `type` とオプション項目を検証して活動イベントを 1 件作成し 201 で返す。type 不正・`task_start` の `task_id` 欠落・`expected_minutes` が正整数でない・不正 JSON は 400、存在しない `task_id` 参照は 404 | `server/src/activity/checkins-routes.test.ts` :: records a checkin with only a type and returns 201, returns 400 when task_start is missing task_id, returns 404 when task_start references a non-existent task | 退役仕様 mvp |
| G-034 | API: `task_start` の状態遷移と原子性 | `task_start` は todo タスクのみ in_progress へ遷移させ（in_progress / done / dropped は変更しない）、`task_start` と `task_update` の両イベントを残す。状態更新に失敗した場合はイベント書き込みごとロールバックし部分的な書き込みを残さない | `server/src/activity/checkins-routes.test.ts` :: transitions a todo task to in_progress and keeps completed_at null, rolls back the task_start event when the status update fails | ADR 0005 / 退役仕様 mvp |
| G-035 | API: 夕会は 1 日 1 回 | 同じローカル日に evening セッションが既に存在すれば（終了済みでも）新規作成は 409（`code: evening_session_already_exists`）を返し、行は挿入されない。日付境界を跨げば作成できる。morning / adhoc に同制限は無い | `server/src/sessions/sessions-routes.test.ts` :: returns 409 with code evening_session_already_exists when an evening session already exists today, without inserting a new row | ADR 0008 / 退役仕様 dr |
| G-036 | API: セッション終了時の要約生成 | morning / evening の終了時に蓄積メッセージから要約を生成して保存する。adhoc では生成しない。生成失敗時も 200 を返し `ended_at` はセットされる。既に要約があれば再生成・上書きしない | `server/src/sessions/sessions-routes.test.ts` :: AC-1: ending a morning session generates and persists a summary from its messages, does not regenerate or overwrite the summary when re-ending an already-summarized session | 退役仕様 mvp / #96 |
| G-037 | API: 夕会終了 → 日報生成フック | ユーザーメッセージを含む evening セッションが**初めて** `ended_at` 遷移するときに限り日報生成を 1 回だけ呼ぶ。再終了・morning / adhoc の終了・ユーザーメッセージ 0 件では呼ばない。生成が例外を投げても終了 API は 200 を返す | `server/src/sessions/sessions-routes-daily-report-hook.test.ts` :: does not re-invoke generation when an already-ended evening session is ended again, returns 200 from the end API even when generation throws | ADR 0008 / 退役仕様 dr |
| G-038 | API: 要約保存と日報生成の共存 | 1 回の夕会終了リクエストは要約保存と日報生成を独立に実行する。要約が既存でスキップされても、日報生成は（初回遷移なら）実行される | `server/src/sessions/sessions-routes-daily-report-hook.test.ts` :: still generates the daily report when the summary is skipped because one already exists | 退役仕様 dr |
| G-039 | API: 入力バリデーション境界 | セッションの `type` は morning / evening / adhoc のみ（他は 400）。チャットの `content` は空白のみ・欠落・非文字列を拒否し、10,000 文字までを許容、10,001 文字以上は 400 | `server/src/sessions/sessions-validation.test.ts` :: accepts a content at exactly the maximum length, rejects a content longer than the maximum length | 退役仕様 mvp |
| G-040 | API: セッション・メッセージ一覧 | セッション一覧は `started_at` 降順（id 降順でタイブレーク）で返し `?type=` でフィルタできる。メッセージ一覧は `created_at` 昇順で返し、存在しない / 数値でないセッション id は 404 | `server/src/sessions/sessions-routes.test.ts` :: returns sessions ordered by started_at descending (most recent first), returns 404 for a non-numeric session id | 退役仕様 mvp |

---

## 4. 日報・作業ログ

> 関連: [ADR 0006](./adr/0006-renderer-owns-structure.md)（構造はレンダラー・LLM は値のみ）、[ADR 0007](./adr/0007-local-calendar-day-basis.md)（ローカル暦日）、[ADR 0008](./adr/0008-evening-dialogue-prerequisite.md)（夕会の前提条件）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-041 | API: `GET /api/reports` | 日報一覧を新しい日付順で返す。各要素は `date` / `created_at` / `updated_at` のみで `content` を含まない。0 件なら空配列 | `server/src/reports/reports-routes.test.ts` :: returns reports newest-first, with only date/created_at/updated_at (no content), does not list the same date twice after regeneration | 退役仕様 dr |
| G-042 | API: `GET /api/reports/:date` | 存在すれば `content` を含む全体を 200 で返し、無ければ 404（`code: report_not_found`） | `server/src/reports/reports-routes.test.ts` :: returns the report body for an existing date, returns 404 with code report_not_found when the date has no report | 退役仕様 dr |
| G-043 | API: `POST /api/reports/generate` | 前提（当日の夕会が終了済み＋ユーザー発言 1 件以上）を満たせば 200 で生成・保存する。満たさなければ 409（`code: evening_session_required`）。同日への再生成は行を増やさず上書きする | `server/src/reports/reports-routes.test.ts` :: returns 409 with code evening_session_required when the prerequisite is not met, overwrites the same day's report on regeneration | ADR 0008 / 退役仕様 dr |
| G-044 | API: `GET /api/work-logs/:date` | 夕会の有無・終了状態にかかわらず常に 200 で本文を返す（生成条件なし）。記録が無い日は固定文言「（記録なし）」を含む。日付形式が不正・実在しない暦日は 400（`code: invalid_date`） | `server/src/reports/work-logs-routes.test.ts` :: returns 200 with the fixed '（記録なし）' body when there is no evening session at all (no prerequisite), returns 400 with code invalid_date for a non-existent calendar date | ADR 0008 / 退役仕様 wl |
| G-045 | API: 作業ログの収集範囲 | 対象ローカル暦日（夕会跨ぎによる延長なし）の decisions と activity_events のみを `created_at` 昇順でマージする。`chat_message` は含めない | `server/src/reports/work-logs-routes.test.ts` :: excludes chat_message events from the response, excludes records from the previous/next day (local calendar-day boundary) | ADR 0007 / 退役仕様 wl |
| G-046 | 日報の構造: 表題と見出し | 表題は `# 日報 YYYY-MM-DD（漢字1字の曜日）`。見出しは「本日のタスク」「活動記録」「夕会サマリ」の順で必ず出現する。「決定事項」見出しは内容の有無によらず出力しない | `server/src/reports/render-daily-report.test.ts` :: includes the section headings 本日のタスク・活動記録・夕会サマリ in this order, and never emits a 決定事項 heading (Issue #144) | ADR 0006 / #144 |
| G-047 | 日報の構造: 本日のタスク | 完了タスクは `- [x] タイトル`、進行中タスクは `- [ ] タイトル（進行中）` として、完了を進行中より先に列挙する。優先度マーク（⭐️）は出力しない | `server/src/reports/render-daily-report.test.ts` :: renders completed tasks as '- [x] タイトル', lists completed tasks before in-progress tasks | ADR 0006 / 退役仕様 dr |
| G-048 | 日報の構造: 活動記録 | 着手が無ければ `- 着手: なし`、あれば `- 着手: HH:mm`。休憩 0 回なら `- 休憩: なし`（「0回（合計0分）」とは出力しない）、1 回以上なら `- 休憩: N回（合計 M分）` | `server/src/reports/render-daily-report.test.ts` :: renders '- 休憩: なし' (not '0回（合計0分）') when breakCount is 0, renders the HH:mm start time when there is a first task_start | ADR 0006 / 退役仕様 dr |
| G-049 | 日報の構造: 夕会サマリとフォールバック | 抽出成功時は「報告の要点」「ボスの講評」「決定の要点」「翌日への持ち越し」の 4 項目をこの順で出す。抽出失敗（未呼び出し・形式不正・例外・タイムアウト）時は固定文言「※ ボスの講評の生成に失敗したため、記録の機械整形で出力しています」の 1 行のみとし 4 項目を一切出さない | `server/src/reports/render-daily-report.test.ts` :: renders the four values in the order 報告の要点・ボスの講評・決定の要点・翌日への持ち越し, uses the exact fixed literal text specified by the spec | ADR 0006 / #144 |
| G-050 | 動的値の埋め込み安全性 | タスク名・決定内容・メモ・LLM が返した値に含まれる改行は半角空白へ正規化して 1 行に畳み、行頭の Markdown 記号（`#` `-` `*` `+` `>` `|`・番号付きリスト）はエスケープする。見出しや箇条書きに偽装できない | `server/src/reports/render-daily-report.test.ts` :: normalizes a task title containing a newline to a single line, escapes a leading markdown symbol in the keyDecisions value; `server/src/reports/render-work-log.test.ts` :: escapes a leading markdown symbol in a decision content | ADR 0006 / 退役仕様 dr, wl |
| G-051 | 作業ログの構造: 表題と行フォーマット | 表題は `# 作業ログ YYYY-MM-DD（漢字1字の曜日）`。記録が無ければ「（記録なし）」。イベントは種別ごとに「着手: {タスク名}」「タスク更新: {タスク名}」「休憩開始」「休憩終了」「チェックイン」として出し、`task_start` / `break_start` は `expected_minutes` があれば「（予定 N分）」を付す。決定は状態別に「決定:」「決定（改訂済み）:」「決定（撤回）:」とする | `server/src/reports/render-work-log.test.ts` :: renders the fixed '（記録なし）' line when there are no decisions and no activity events, renders a revised decision as '決定（改訂済み）: {content}' | ADR 0006 / 退役仕様 wl |
| G-052 | 作業ログの構造: 並び順 | 決定と活動イベントを `created_at` 昇順でマージし、同一時刻ではイベントを決定より先に、同種・同時刻では id 昇順に並べる（順序が決定的） | `server/src/reports/render-work-log.test.ts` :: places an activity event before a decision when created_at is identical, orders same-kind entries with identical created_at by id ascending | ADR 0006 / 退役仕様 wl |
| G-053 | 日報生成: 前提条件と対象暦日 | 当日の夕会が存在しない・未終了・ユーザー発言 0 件のいずれかなら生成せず `evening_session_required` を返し行を作らない。夕会が日をまたいでも対象暦日は**開始日**となり、集計もその日の 00:00:00.000–23:59:59.999 に限る | `server/src/reports/generate-daily-report.test.ts` :: 当日の夕会が存在しない場合、evening_session_required を返し daily_reports に行が作られない, 23:50開始・翌00:30終了の夕会に対して生成すると、date と表題が開始日になる | ADR 0007, ADR 0008 / 退役仕様 dr |
| G-054 | 日報生成: 集計条件 | 完了欄は対象暦日に `completed_at` を持つ done タスクのみ、進行中欄は対象暦日に `task_start` / `task_update` を持つ in_progress タスクのみを含める。決定の収集は当日 `created_at` かつ `status = active` のものを昇順で対象とする | `server/src/reports/collect-daily-report-data.test.ts` :: includes a done task whose completed_at falls on the target day, includes an in_progress task that has only a task_update event on the target day | ADR 0007 / 退役仕様 dr |
| G-055 | 日報生成: LLM 失敗時の保存 | LLM 抽出が失敗・遅延しても例外を投げず、フォールバック日報が保存される（夕会サマリは固定文言 1 行のみ） | `server/src/reports/generate-daily-report.test.ts` :: %s の場合でも例外を投げず、フォールバック日報が保存され「夕会サマリ」が固定文言1行のみになる | ADR 0006 / 退役仕様 dr |

---

## 5. 決定・進言・タスク・設定・DB・サーバ基盤

> 関連: [ADR 0005](./adr/0005-sqlite-schema-policy.md)（スキーマ方針）、[ADR 0002](./adr/0002-api-key-and-llm-call-path.md)（秘密情報の非露出）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-056 | API: 進言の受理条件 | 進言は active な決定に対してのみ受理する。存在しない決定は 404、既に revised / withdrawn なら 409、`content` が空・欠落なら 400 | `server/src/decisions/appeals-route.test.ts` :: returns 404 for a non-existent decision id, returns 409 when the decision is not active (already revised) | 退役仕様 mvp |
| G-057 | API: 進言の事前検証 | `content` 欠落時は 400 を返し、Claude への裁定要求（`submit_verdict`）を一切呼び出さない | `server/src/decisions/appeals-route.test.ts` :: returns 400 when content is missing | 退役仕様 mvp |
| G-058 | API: 裁定失敗時の原子性 | `submit_verdict` 未呼び出し・不正な裁定値・revised なのに `revised_content` 欠落・呼び出し自体の例外は、いずれも 500 を返し進言も決定のステータス変更も DB に一切残さない | `server/src/decisions/appeals-route.test.ts` :: returns 500 and makes no DB changes when Claude does not call submit_verdict, returns 500 and makes no DB changes when the verdict is invalid | ADR 0005 / 退役仕様 mvp |
| G-059 | API: 進言のエラー応答の非露出 | クライアント生成失敗時・呼び出し例外時のエラー応答に API キー・内部リクエスト ID などの機微情報を含めない | `server/src/decisions/appeals-route.test.ts` :: returns 500 without leaking the api key when the Claude client cannot be created | ADR 0002 |
| G-060 | API: 裁定 upheld | 裁定が upheld なら進言を保存して決定は active のまま維持し、`{appeal, decision}` を 200 で返す（`revisedDecision` は含まない） | `server/src/decisions/appeals-route.test.ts` :: persists an upheld appeal, keeps the decision active, and returns {appeal, decision} | 退役仕様 mvp |
| G-061 | API: 裁定 revised | 裁定が revised なら元の決定を `status = revised` にし、元の `task_id`（null なら null のまま）を引き継ぐ新しい active な決定を作成して `{appeal, decision, revisedDecision}` を 200 で返す | `server/src/decisions/appeals-route.test.ts` :: persists a revised appeal, marks the original decision revised, and creates a new active decision | 退役仕様 mvp |
| G-062 | API: 裁定中のレースガード | 裁定呼び出し中に決定が別経路で active でなくなった場合は 409 を返し、進言・決定変更のいずれも DB に残さない | `server/src/decisions/appeals-route.test.ts` :: returns 409 and makes no DB changes when the decision stopped being active while the Claude call was in flight (race guard) | ADR 0005 |
| G-063 | API: `GET /api/decisions` | 決定一覧を `created_at` 降順で返し、各決定に自分自身に紐づく進言履歴（無ければ空配列）を付与する | `server/src/decisions/decisions-routes.test.ts` :: returns decisions ordered by created_at descending; `server/src/decisions/appeals-route.test.ts` :: attaches each decision's own appeal history | 退役仕様 mvp |
| G-064 | API: `GET /api/tasks` | タスク一覧を `created_at` 昇順で返す（0 件なら空配列） | `server/src/tasks/tasks-routes.test.ts` :: returns all tasks ordered by created_at ascending | 退役仕様 mvp |
| G-065 | API: `POST /api/tasks` の既定値 | `title` のみで作成でき、`description` / `priority` / `due_at` / `boss_comment` / `estimated_minutes` は null、`category='work'`、`status='todo'` を既定として 201 で返す。`status='done'` 指定時は `completed_at` を設定する | `server/src/tasks/tasks-routes.test.ts` :: creates a task with only a title, filling in defaults, sets completed_at when a task is created directly with status done | 退役仕様 mvp |
| G-066 | API: `POST /api/tasks` の検証 | `title` 欠落・空文字、不正な `status` / `priority`、`estimated_minutes` が非負整数でない、`description` が非文字列、不正 JSON はいずれも 400 | `server/src/tasks/tasks-routes.test.ts` :: returns 400 with a machine-readable error when title is missing, returns 400 when estimated_minutes is not a non-negative integer | 退役仕様 mvp |
| G-067 | API: `PATCH /api/tasks/:id` の部分更新 | 存在しない id（数値・非数値とも）は 404。指定フィールドのみ更新し他は保持する。更新のたび `updated_at` が変わり `created_at` は不変 | `server/src/tasks/tasks-routes.test.ts` :: returns 404 for a non-existent id, partially updates only the specified fields keeping the rest | 退役仕様 mvp |
| G-068 | API: `PATCH /api/tasks/:id` の検証 | 不正な `status` / `priority`、空文字 `title`、`category` を含む更新はいずれも 400（`category` は更新不可フィールド） | `server/src/tasks/tasks-routes.test.ts` :: returns 400 when category is included in the patch, returns 400 when title is patched to an empty string | 退役仕様 mvp |
| G-069 | API: `completed_at` の連動 | `status` を done へ変更すると `completed_at` を設定し、done 以外へ変更すると null に戻す | `server/src/tasks/tasks-routes.test.ts` :: sets completed_at when status transitions to done, clears completed_at when status transitions away from done | 退役仕様 mvp |
| G-070 | API: `GET /api/settings` の既定値 | 未設定時は `boss_name="ボス"`・`boss_strictness=3`・`work_start="09:00"` 等の既定値一式を返す。不正値が保存されていても該当キーは既定へフォールバックする | `server/src/settings/settings-routes.test.ts` :: returns default effective values when nothing is set, falls back to defaults for stored invalid values | 退役仕様 mvp |
| G-071 | API: 派生キャッシュの非露出 | `dashboard_comment_*`（ダッシュボードコメントの派生キャッシュ）はユーザー設定ではないため設定レスポンスに一切含めない | `server/src/settings/settings-routes.test.ts` :: excludes the dashboard boss-comment cache keys (derived cache, not a user setting) | 退役仕様 mvp |
| G-072 | API: `PUT /api/settings` の部分更新 | 指定したキーのみ更新し残りは既定のまま保持する。複数キーの同時更新もできる | `server/src/settings/settings-routes.test.ts` :: updates only the provided key leaving the rest at defaults, updates multiple keys at once | 退役仕様 mvp |
| G-073 | API: 自由記述設定の往復 | `boss_custom_instructions` は空文字を送ると null（未設定）に戻り、null 自体も受け付ける（GET の応答をそのまま PUT へ戻せる） | `server/src/settings/settings-routes.test.ts` :: resets boss_custom_instructions to null when set to an empty string, accepts boss_custom_instructions: null (round-tripping GET's response back into PUT) | 退役仕様 mvp |
| G-074 | API: 設定更新の all-or-nothing | 1 キーでも値が不正なら 400 を返し、同時に送られた有効なキーも含めて一切保存しない。未知キー・不正 JSON・不正な時刻形式・負の分数値も 400 | `server/src/settings/settings-routes.test.ts` :: returns 400 and saves nothing when a value is invalid (all-or-nothing), returns 400 for an unrecognized key | ADR 0005 / 退役仕様 mvp |
| G-075 | API: `GET /api/health` | DB 接続が生きていれば `status:"ok"` / `db:true`、DB が閉じられていれば `db:false` を返す（サーバは落ちない） | `server/src/app.test.ts` :: returns 200 with status ok and db true from GET /api/health, returns db: false when the database query fails | 退役仕様 mvp |
| G-076 | サーバ: 静的配信と SPA ルーティング | `index.html` / アセット / `favicon.svg` / `manifest.webmanifest` を適切な content-type で配信し、未知の非 API パスは `index.html` へフォールバックする。`/api` 配下は静的配信より優先され、未知の `/api` パスは 404 を返す | `server/src/app.test.ts` :: falls back to index.html for an unknown non-API path (SPA routing), returns 404 for an unknown /api path instead of index.html | #145 / 退役仕様 mvp |
| G-077 | DB: マイグレーションの網羅と冪等性 | 初回起動で `tasks` / `sessions` / `messages` / `decisions` / `appeals` / `settings` / `notifications` / `activity_events` / `daily_reports` を作成する。複数回実行しても冪等（エラーなし・重複なし） | `server/src/db/migrate.test.ts` :: is idempotent: running migrations twice does not raise an error, creates the daily_reports table (v3) | ADR 0005 / 退役仕様 mvp, dr |
| G-078 | DB: バージョン単調増加のアップグレード | v2 スキーマの DB に対して実行すると `user_version` が 3 へ進み `daily_reports` が追加され、既存テーブルは変更されない（既存データを壊さない） | `server/src/db/migrate.test.ts` :: upgrades a v2 database to v3 (adds daily_reports) without touching existing tables | ADR 0005 / 退役仕様 dr |
| G-079 | DB: 値の CHECK 制約 | `tasks.status` / `sessions.type` / `messages.role` / `decisions.status` / `appeals.verdict` / `activity_events.type` は許可された値のみ受け付け、それ以外は拒否される | `server/src/db/migrate.test.ts` :: rejects an invalid tasks.status, rejects an invalid appeals.verdict, rejects an invalid activity_events.type | ADR 0005 / 退役仕様 mvp |
| G-080 | DB: 参照整合性と一意制約 | 外部キー制約が有効で、存在しない `session_id` / `evening_session_id` を参照する挿入は失敗する。`daily_reports.date` は UNIQUE | `server/src/db/migrate.test.ts` :: enforces foreign keys: inserting a message with an unknown session_id fails, enforces daily_reports.date UNIQUE | ADR 0005 / 退役仕様 dr |

---

## 6. スケジューラ・通知・ダッシュボード

> 関連: [ADR 0004](./adr/0004-deterministic-detection-engine.md)（発火はルール・文面は LLM）、[ADR 0001](./adr/0001-local-only-data-boundary.md)（通知は macOS ローカル実行系）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-081 | 通知: 実行系のフォールバック | terminal-notifier を優先実行し、失敗（ENOENT・タイムアウトを含む）した場合は osascript へフォールバックする。両方失敗しても例外を投げず `delivered:false` を返す | `server/src/notifications/notifier.test.ts` :: falls back to osascript when terminal-notifier is not available, resolves without throwing and reports delivered:false when both commands fail | 退役仕様 mvp |
| G-082 | 通知: 本文のエスケープと整形 | 通知本文に二重引用符や改行が含まれても osascript のコマンドを壊さず安全に送出する | `server/src/notifications/notifier.test.ts` :: safely escapes double quotes in the body without breaking the osascript argument list, normalizes newlines in the body | 退役仕様 mvp |
| G-083 | 通知: 外部コマンドのタイムアウト | 外部コマンド呼び出しにはタイムアウトが設定されており、応答しないプロセスが呼び出し元を無期限にブロックしない | `server/src/notifications/notifier.test.ts` :: invokes child_process.execFile with a timeout so a hung notifier process cannot block the caller forever | 退役仕様 mvp |
| G-084 | スケジューラ: 毎分ティック | 検知ルールの条件が満たされると、毎分のティックで文面生成・通知送信・DB への記録までが実行される | `server/src/scheduler/scheduler-tick.test.ts` :: fires, generates a body, sends the notification, and records it when a rule condition is met; `server/src/scheduler/scheduler.test.ts` :: registers a cron job that runs every minute | ADR 0004 / 退役仕様 mvp |
| G-085 | スケジューラ: 重複送信防止 | 同一 `rule_key` の通知はエスカレーション間隔内では再送しない | `server/src/scheduler/scheduler-tick.test.ts` :: does not resend within the escalation interval on the next tick (duplicate suppression) | ADR 0004 / 退役仕様 mvp |
| G-086 | スケジューラ: エスカレーションのリセット | 活動イベントが記録されると、その後の発火時のエスカレーションレベルは L1 に戻る | `server/src/scheduler/scheduler-tick.test.ts` :: resets the escalation level to L1 after an activity signal is recorded | ADR 0004 / 退役仕様 mvp |
| G-087 | スケジューラ: 送信失敗時の継続 | 通知の送信系が両方失敗しても `tick()` は例外を投げず、通知レコードは DB に残る | `server/src/scheduler/scheduler-tick.test.ts` :: does not crash and still records the notification when sending fails (both channels reject) | 退役仕様 mvp |
| G-088 | スケジューラ: 文面生成失敗時も通知は送る | 文面の LLM 生成が失敗しても定型文フォールバックで当該 firing の通知は送信・記録され、他の firing の処理には影響しない | `server/src/scheduler/scheduler-tick.test.ts` :: continues processing the remaining firings when one firing fails (per-firing isolation); `server/src/notifications/notification-body.test.ts` :: falls back to the fixed template when streamBossMessage rejects, without leaking the error message | ADR 0004 / 退役仕様 mvp |
| G-089 | スケジューラ: 同時実行防止 | 前回の `tick()` が実行中の間に開始された次のティックは処理をスキップし、二重送信を起こさない | `server/src/scheduler/scheduler-tick.test.ts` :: skips a tick that starts while the previous one is still running (concurrency guard) | 退役仕様 mvp |
| G-090 | スケジューラ: 予期しない例外の封じ込め | DB が利用できない等の予期しないエラーがティック入力の構築中に起きても、例外を外へ投げずログして継続する | `server/src/scheduler/scheduler-tick.test.ts` :: logs and continues (does not throw) when an unexpected error occurs while building the tick input | 退役仕様 mvp |
| G-091 | API: `GET /api/dashboard` | 進捗（done / total / ratio）・朝夕会の実施フラグ・当日の最大エスカレーションレベル・ボスのひとこと・日付を含む固定形状の JSON を 200 で返す | `server/src/dashboard/dashboard-routes.test.ts` :: returns 200 with the full dashboard shape, reflects task progress, session flags, and the max escalation level | 退役仕様 mvp |
| G-092 | API: ダッシュボードの LLM 失敗時 | API キー欠如や呼び出し失敗時も 500 を返さず、空でないフォールバックコメントを含む 200 を返す | `server/src/dashboard/dashboard-routes.test.ts` :: returns 200 with a fallback comment (not 500) when the API key is missing | ADR 0003 / 退役仕様 ccb FR-11 |
| G-093 | ダッシュボードコメント: 長さ上限 | 生成コメントが全角 80 字を超える場合は固定テンプレートへフォールバックし、キャッシュしない。ちょうど 80 字は許容してキャッシュする | `server/src/dashboard/boss-comment.claude-code.test.ts` :: falls back to the template (and does not cache) when the response exceeds the 全角80字 limit, accepts a response exactly at the 全角80字 limit (boundary) | ADR 0003, ADR 0006 / 退役仕様 ccb FR-14 |
| G-094 | ダッシュボードコメント: 失敗時のフォールバック | API キー欠如・呼び出し失敗・claude-code バックエンド失敗のいずれでも例外を投げず、空でないフォールバック文字列を返す | `server/src/dashboard/boss-comment.test.ts` :: returns the fallback comment without throwing when the Claude call fails; `server/src/dashboard/boss-comment.claude-code.test.ts` :: falls back to the template without throwing when the claude-code query fails | ADR 0003 / 退役仕様 ccb |
| G-095 | 通知文面: 種別・レベル別の定型文 | LLM 生成に失敗した場合、ルール種別（`todo_stall` / `avoidance` / `deadline_overdue` / `silence` / `morning_meeting` / `evening_meeting` 等）とエスカレーションレベルに応じた定型文（該当時はタスク名を補間）を返し、内部エラーの詳細を漏らさない | `server/src/notifications/notification-body.test.ts` :: interpolates the task title into the todo_stall fallback template, produces different fallback text across escalation levels for the same rule type | ADR 0004 / 退役仕様 mvp |

---

## 7. Web: API クライアントと純粋ロジック

> 関連: [ADR 0002](./adr/0002-api-key-and-llm-call-path.md)（フロントはバックエンドとのみ通信）、[ADR 0007](./adr/0007-local-calendar-day-basis.md)（ローカル暦日）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-096 | 純粋関数: ボス表情の決定 | エスカレーション Lv2 以上を最優先とし、夕会後は進捗比 0.5 / 0.8 を境界に、朝会後は 0.3 未満で、表情（displeased / satisfied / normal / encouraging）が一意に決まる | `web/src/boss-expression.test.ts` :: returns displeased when the escalation level is 2 (boundary), prioritizes the escalation rule over the evening-satisfied rule | 退役仕様 mvp |
| G-097 | Web API: チャットセッション | `/api/sessions` 系で種別別の最新セッション取得・全件取得・作成・終了ができ、失敗時はサーバーのエラーメッセージで reject する | `web/src/chat-api.test.ts` :: returns the first session of the type-filtered list, POSTs to the session's /end endpoint and returns the updated record | 退役仕様 mvp |
| G-098 | Web API: チャットの SSE 受信 | `sendChatMessage` は SSE の text / tool / done / error をハンドラへ配送する。不正なイベントデータは `onError` へ通知され、Promise は reject / 例外にならない | `web/src/chat-api.test.ts` :: POSTs the content and dispatches text deltas then done, reports malformed event data via onError instead of rejecting | ADR 0002 / 退役仕様 ccb FR-04 |
| G-099 | Web API: チェックイン・活動記録 | `postCheckin` は入力を POST して作成された活動イベントを返し、`fetchTodayActivity` は当日の一覧を返す。失敗時はサーバーのエラーメッセージで reject する | `web/src/checkins-api.test.ts` :: posts the input and returns the created activity event, throws with the server error message when the request fails | 退役仕様 mvp |
| G-100 | Web API: 日報 | 一覧取得・単日取得・生成を行い、失敗時はサーバーの `code` を含むエラー（`report_not_found` / `evening_session_required`）を throw する | `web/src/daily-reports-api.test.ts` :: throws a ReportApiError carrying code 'report_not_found' on a 404, throws a ReportApiError carrying code 'evening_session_required' on a 409 | ADR 0008 / 退役仕様 dr |
| G-101 | Web API: ダッシュボード | ダッシュボードレスポンスをパースして返し、失敗時はサーバーのエラーメッセージで reject する | `web/src/dashboard-api.test.ts` :: returns the parsed dashboard response when the request succeeds, throws with the server error message when the request fails | 退役仕様 mvp |
| G-102 | 純粋関数: 進捗レベル | 進捗比 0.3 / 0.8 を境界に low / mid / high の 3 段階へ分類する | `web/src/dashboard-progress-level.test.ts` :: returns mid when the ratio equals the encouraging threshold (0.3, boundary), returns high when the ratio equals the satisfied threshold (0.8, boundary) | 退役仕様 mvp |
| G-103 | Web API: 決定・進言 | 決定一覧を取得し、進言を POST して裁定結果を返す。失敗時はサーバーのエラーメッセージで reject する | `web/src/decisions-api.test.ts` :: posts the content and returns the verdict result, throws with the server error message when the appeal fails | 退役仕様 mvp |
| G-104 | 純粋関数: 休憩中判定 | 活動イベント列中の直近の `break_start` に `break_end` が続いていなければ休憩中と判定する | `web/src/derive-break-status.test.ts` :: returns true when the last break_start has no following break_end, returns false when a break_end follows the break_start | 退役仕様 mvp |
| G-105 | 純粋関数: 夕会評価トーン | 進捗比 0.5 / 0.8 を境界に scold / neutral / praise の 3 段階のトーンを返す | `web/src/evening-evaluation.test.ts` :: returns praise when the ratio is 0.8 (boundary), returns neutral when the ratio equals 0.5 (boundary) | 退役仕様 mvp |
| G-106 | 静的アセット: favicon と Web App Manifest | `favicon.svg` は有効な SVG であり、`manifest.webmanifest` は `name="ai-boss"` / `display="standalone"` と 192px / 512px の PNG アイコンを宣言し、参照先の PNG が宣言どおりのサイズで実在する | `web/src/public-assets.test.ts` :: manifest.webmanifest declares a standalone app with 192px/512px PNG icons, icon-192.png and icon-512.png …exist as 192x192/512x512 PNGs | #145 |
| G-107 | 純粋関数: 既定タスクの選択 | タスク一覧から priority=high を優先し、同順位なら id の小さい方を既定タスクに選ぶ（空配列なら未選出） | `web/src/select-default-task.test.ts` :: returns the high priority task over medium/low/unset ones, breaks ties between equal priorities by the smaller id | 退役仕様 mvp |
| G-108 | 純粋関数: 復元するセッションの選択 | 現在時刻のローカル日付基準で、当日の未終了 morning / evening のうち開始が新しい方を active に選び、当日の adhoc を別枠で返す。前日以前のセッションは無視する | `web/src/select-restore-session.test.ts` :: when both morning and evening are open today, picks the more recently started one regardless of input order, ignores an open morning session from a previous day | ADR 0007 |
| G-109 | Web API: 設定 | 設定を取得し、指定キーのみのパッチを PUT して更新後の設定を返す。失敗時はサーバーのエラーメッセージで reject する | `web/src/settings-api.test.ts` :: PUTs the patch with correct key names and value types and returns the updated settings | 退役仕様 mvp |
| G-110 | Web API: タスク | 一覧取得・作成・部分更新を行い、失敗時はサーバーのエラーメッセージで reject する | `web/src/tasks-api.test.ts` :: posts the input and returns the created task, patches the task by id and returns the updated task | 退役仕様 mvp |
| G-111 | 純粋関数: 日付キーの整形 | `Date` をローカル日付基準でゼロ埋めの `YYYY-MM-DD` へ整形する | `web/src/to-date-key.test.ts` :: formats a date as YYYY-MM-DD with zero-padded month and day, zero-pads single-digit months and days | ADR 0007 |
| G-112 | 純粋関数: 本日のタスク一覧 | todo / in_progress は常に含み、done は `completed_at` がローカル当日のもののみ含める。dropped と `completed_at` 未設定の done は除外する | `web/src/today-tasks.test.ts` :: includes done tasks completed today (local date), excludes done tasks completed on a past day | ADR 0007 |
| G-113 | Web API: 作業ログ | `/api/work-logs/:date` から作業ログを取得し、失敗時はサーバーの `code`（例: `invalid_date`）を含むエラーを throw する。エラーボディが JSON でない場合は code なしで throw する | `web/src/work-logs-api.test.ts` :: throws a ReportApiError carrying the server's code on a 400 invalid_date, throws a ReportApiError without a code when the error body is not JSON | 退役仕様 wl |

---

## 8. Web: フック（状態管理・サーバー同期）

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-114 | `useChat`: 入力ドラフト | 入力欄の内容は `setDraft` で更新した値がそのまま保持され、送信するまで消えない | `web/src/use-chat.test.ts` :: initializes draft as an empty string, updates draft via setDraft | #153 |
| G-115 | `useChat`: 会話履歴の復元 | 画面を開いた時点で当日開始済みの adhoc セッションがあれば、その会話履歴が復元表示される。前日以前のセッションは復元しない | `web/src/use-chat.test.ts` :: restores the history of the latest adhoc session on mount, does not restore the latest adhoc session when it was started on a previous local day | ADR 0007 / #93 |
| G-116 | `useChat`: 履歴復元の失敗 | 起動時の会話履歴取得に失敗した場合、画面はエラー状態になる | `web/src/use-chat.test.ts` :: sets an error status when history restoration fails | 退役仕様 mvp |
| G-117 | `useChat`: 送信とストリーミング表示 | 送信するとユーザー発言が即座に追加され、ボスの返信は SSE で届いた内容が最終メッセージとして表示される。送信中フラグとストリーミング用バッファは完了時にクリアされる | `web/src/use-chat.test.ts` :: creates a session on first send, then appends the user entry and the streamed boss reply, reuses the restored session on send | 退役仕様 mvp |
| G-118 | `useChat`: ツール呼び出しの表示 | ストリーム中にツール呼び出しイベントが届くと、チャット上にツール実行のエントリとして表示される | `web/src/use-chat.test.ts` :: records tool entries emitted during the stream | 退役仕様 ccb FR-04 |
| G-119 | `useChat`: SSE エラー表示 | ストリーム中にエラーイベントが届くと、途中まで表示していたテキストは消え、エラーメッセージが表示される | `web/src/use-chat.test.ts` :: surfaces an SSE error event and clears the streaming buffer | 退役仕様 mvp |
| G-120 | `useChat`: 送信失敗時の入力保持 | セッション作成やメッセージ送信が失敗しても、直前に入力した発言は画面から消えず、エラーが表示される | `web/src/use-chat.test.ts` :: keeps the optimistic user entry when session creation fails, surfaces a request failure as an error | 退役仕様 mvp |
| G-121 | `useChat`: 多重送信の防止 | 送信処理の実行中に再度送信操作をしても、二重にメッセージが送られない | `web/src/use-chat.test.ts` :: ignores a second send while one is already in flight | 退役仕様 mvp |
| G-122 | `useChat`: 朝会・夕会の切替 | 朝会セッションを開始すると当日分の会話へ切り替わり、終了すると元の adhoc 会話へ戻る。当日に開始・終了済みの朝会は復元せず新規 adhoc 扱いになる | `web/src/use-chat.test.ts` :: restores today's existing morning session instead of creating a new one, returns to today's adhoc conversation when ending a meeting that was restored on mount | ADR 0007 / 退役仕様 mvp |
| G-123 | `useChat`: セッション操作の失敗 | セッション切替や終了の通信が失敗するとエラーが表示され、終了失敗時はセッションが切り替わったままになる | `web/src/use-chat.test.ts` :: surfaces an error when starting a session fails, surfaces an error when ending a session fails | 退役仕様 mvp |
| G-124 | `useChat`: 操作の競合防止 | セッション切替中は送信操作を、送信中はセッション切替操作を、それぞれ受け付けない | `web/src/use-chat.test.ts` :: ignores startSession while a message send is in flight, ignores send while a session switch is in flight | 退役仕様 mvp |
| G-125 | `useCopyToClipboard`: 成功・失敗の反映 | コピー操作の成否が画面へ反映され、クリップボード API が使えない非セキュアコンテキストでも例外を投げずに失敗状態になる（日報ビュー・作業ログビュー共通） | `web/src/use-copy-to-clipboard.test.ts` :: transitions to failure when the clipboard write rejects, transitions to failure without throwing when navigator.clipboard is undefined (non-secure context) | 退役仕様 dr, wl |
| G-126 | `useCopyToClipboard`: 表示切替時のリセット | コピー対象の本文が切り替わると、前の本文に対する成功・失敗表示は引き継がれず idle に戻る | `web/src/use-copy-to-clipboard.test.ts` :: resets to idle when the content changes (stale result must not stick) | 退役仕様 wl |
| G-127 | `useCheckinPanel`: 当日活動の表示 | 画面を開くと当日のチェックイン活動が一覧表示され、休憩中かどうかがその履歴から判定される。取得失敗時はエラー状態になる | `web/src/use-checkin-panel.test.ts` :: loads today's activity events on mount, derives isOnBreak from the loaded events | 退役仕様 mvp |
| G-128 | `useCheckinPanel`: チェックインの反映 | チェックイン送信が成功すると活動履歴が最新化され、タスクボードも同時に最新化される。失敗した場合はタスクボードを更新せずエラーを表示する | `web/src/use-checkin-panel.test.ts` :: calls the provided refreshTasks callback after a successful submitCheckin (Issue #134), does not call refreshTasks when submitCheckin fails (Issue #134) | #134 |
| G-129 | `useCheckinPanel`: 完了操作 | タスクの完了操作が成功すると活動履歴が最新化され成功を返す。完了処理自体が失敗した場合は失敗として扱いエラーを表示する | `web/src/use-checkin-panel.test.ts` :: completeTask calls editTask, reloads events, and returns true on success (Issue #138), sets submitError and returns false when completeTask's editTask rejects (Issue #138) | #138 |
| G-130 | `useDailyReports`: 当日日報の表示 | 画面を開くと当日の日報本文と過去日の一覧が表示される。当日分が未生成なら「夕会が必要」の状態になる。一覧取得に失敗するとエラー状態になる | `web/src/use-daily-reports.test.ts` :: shows the evening-session-required state when today's report doesn't exist yet (404), sets an error status when the initial summaries fetch fails outright | ADR 0008 / 退役仕様 dr |
| G-131 | `useDailyReports`: 過去日の選択 | 過去日の一覧から日付を選ぶと、表示中の日報本文がその日のものへ切り替わる | `web/src/use-daily-reports.test.ts` :: selects a past date and switches the displayed report content | 退役仕様 dr |
| G-132 | `useDailyReports`: 再生成 | 再生成すると本文が更新され、当日分の一覧項目は重複せず 1 件のまま最新の日時へ更新される。夕会未完了で再生成できない場合は「夕会が必要」の状態になる | `web/src/use-daily-reports.test.ts` :: regenerates the report, updating both the content and the summary list without duplicating the date, surfaces the evening-session-required state when regenerate fails with a 409 | ADR 0008 / 退役仕様 dr |
| G-133 | `useDashboard`: ダッシュボード表示 | 画面を開くと進捗・朝夕会の実施状況・エスカレーション状況・ボスコメントが表示される。取得に失敗するとエラー状態になる | `web/src/use-dashboard.test.ts` :: loads the dashboard on mount, sets an error status when the initial fetch fails | 退役仕様 mvp |
| G-134 | `useDecisions`: 決定一覧 | 画面を開くと決定とその進言の一覧が表示される。取得に失敗するとエラー状態になる | `web/src/use-decisions.test.ts` :: loads the decision list on mount, sets an error status when the initial fetch fails | 退役仕様 mvp |
| G-135 | `useDecisions`: 進言操作 | 進言を送信して成功すると一覧が最新の進言内容を含む形で更新される。送信に失敗した場合は一覧を更新せず、エラーが呼び出し元へ伝播する | `web/src/use-decisions.test.ts` :: refetches the full decision list after a successful appeal, propagates the error and does not refetch when the appeal submission fails | 退役仕様 mvp |
| G-136 | `useHealthCheck`: 接続状態 | ヘルスチェックが成功すれば connected、失敗（例外・非 ok レスポンス）すれば disconnected と表示される | `web/src/use-health-check.test.ts` :: returns connected when the health check fetch succeeds, returns disconnected when the health check fetch resolves not ok | 退役仕様 mvp |
| G-137 | `useSettings`: 設定の読み込みと保存 | 設定画面を開くと現在の値が表示され、保存が成功すると画面の値が更新される。失敗した場合は元の値を維持したままエラーを表示し、保存中はその旨を表示する | `web/src/use-settings.test.ts` :: updates settings and returns true after a successful save, sets saveError and returns false when the save fails, keeping the previous settings | 退役仕様 mvp |
| G-138 | `useTasks`: タスク一覧と操作反映 | タスクボードを開くと一覧が表示され、追加・編集が成功すると画面の一覧へ即座に反映される。再取得に失敗するとエラー状態になる | `web/src/use-tasks.test.ts` :: appends the created task after addTask resolves, replaces the matching task after editTask resolves | 退役仕様 mvp |

---

## 9. Web: 画面

| ID | 公開面 | 保証（約束） | 参照テスト | 宣言元 |
|---|---|---|---|---|
| G-139 | 画面: 日報ビュー（前提条件の案内） | 当日の日報が未生成の場合、「夕会を完了すると日報を生成できます」という案内が表示される。再生成が 409 で失敗した場合も同じ案内に戻る | `web/src/DailyReportView.test.tsx` :: shows the evening-session-required hint when today's report doesn't exist yet, shows the evening-session-required hint when regenerate fails with a 409 | ADR 0008 / 退役仕様 dr |
| G-140 | 画面: 日報ビュー（本文表示） | 当日の日報が存在する場合、その本文が Markdown 未整形の生テキストとして表示される | `web/src/DailyReportView.test.tsx` :: displays today's report content as raw markdown text | 退役仕様 dr |
| G-141 | 画面: 日報ビュー（コピー成功） | 「コピー」で本文をクリップボードへコピーし、成功時は `role="status"` で「コピーしました」を一時表示する | `web/src/DailyReportView.test.tsx` :: copies the report content and shows a temporary success notification (role=status) | 退役仕様 dr |
| G-142 | 画面: 日報ビュー（コピー失敗の退避） | クリップボード書き込みが失敗した場合（拒否・非セキュアコンテキスト）、`role="alert"` の通知とともに本文を全選択したテキストエリアへフォールバックし、再クリックで再試行できる | `web/src/DailyReportView.test.tsx` :: falls back to a selected textarea when the clipboard write fails (role=alert), retries the copy on a second click of the copy button after a failure | 退役仕様 dr |
| G-143 | 画面: 日報ビュー（再生成） | 「再生成」で本文と過去日一覧が更新され、当日の日付ボタンが重複表示されない | `web/src/DailyReportView.test.tsx` :: regenerates the report and updates both the content and the past list without duplicating today's date | 退役仕様 dr |
| G-144 | 画面: 日報ビュー（過去日選択） | 過去日一覧から日付を選択すると表示内容がその日の日報へ切り替わる | `web/src/DailyReportView.test.tsx` :: switches the displayed content when a past date is selected from the list | 退役仕様 dr |
| G-145 | 画面: 作業ログビュー（初期表示） | マウント時に「対象日」入力欄が当日を示し、当日の作業ログ本文が表示される | `web/src/WorkLogView.test.tsx` :: fetches and displays today's work log on mount | ADR 0007 / 退役仕様 wl |
| G-146 | 画面: 作業ログビュー（日付変更） | 対象日を変更するとその日の作業ログを取得し直す。読み込み中は前の日付の本文を消し、コピーボタンを無効化する（日付と本文の不一致でのコピーを防ぐ） | `web/src/WorkLogView.test.tsx` :: clears the previously loaded log while the newly selected date is still loading (PR #165 review), disables the copy button until the work log is loaded | #165 / 退役仕様 wl |
| G-147 | 画面: 作業ログビュー（エラーとコピー） | 取得失敗時は `role="alert"` のエラー表示になる。コピー成功時は `role="status"` で「コピーしました」、失敗時は `role="alert"` と手動コピー用テキストエリアへフォールバックする | `web/src/WorkLogView.test.tsx` :: shows an error (role=alert) when the fetch fails, falls back to a selected textarea when the clipboard write fails (role=alert) | 退役仕様 wl |
| G-148 | 画面: ボスアバター | `expression`（normal / satisfied / displeased / encouraging）に応じて `role="img"` の日本語ラベル（通常 / 満足 / 不機嫌 / 激励）と、それぞれ異なる画像が表示される | `web/src/BossAvatar.test.tsx` :: maps each expression to a distinct image, renders the encouraging expression with its Japanese label | 退役仕様 mvp |
| G-149 | 画面: ダッシュボード（状態と進捗） | 取得中は読み込み中表示、失敗時は `role="alert"`、成功時は完了数 / 合計 / 割合のプログレスバー（高進捗・低進捗で異なる装飾）とボスのひとこと・表情アバターを表示する | `web/src/Dashboard.test.tsx` :: shows an error message when the fetch fails, renders the progress gauge with the done/total count and percentage | 退役仕様 mvp |
| G-150 | 画面: ダッシュボード（夕会評価） | 夕会が完了している場合のみ「夕会評価」領域が表示され、進捗割合に応じて称賛 / 叱責 / 中立のスタイルへ切り替わる | `web/src/Dashboard.test.tsx` :: does not render the evening evaluation panel when the evening session has not been held, renders a praise-styled evening evaluation panel when the ratio is high | 退役仕様 mvp |
| G-151 | 画面: ナビゲーション | メインナビに「ダッシュボード」「チャット」「タスク」「決定ログ」「日報」「作業ログ」「設定」の 7 項目が存在し、既定表示はダッシュボード。各ボタンで main 領域が切り替わる | `web/src/AppLayout.test.tsx` :: renders the seven nav items, renders the dashboard as the default main view | 退役仕様 mvp, dr, wl |
| G-152 | 画面: ヘッダー | ヘッダーに「ai-boss」の見出しと、ヘルスチェック結果に応じた接続状態が表示される | `web/src/AppLayout.test.tsx` :: shows the connected status in the header once the health check succeeds, shows the disconnected status in the header when the health check fails | 退役仕様 mvp |
| G-153 | 画面: 接続ステータス | 接続状態に応じて「接続 OK」「サーバー未接続」「確認中...」のいずれかが表示される | `web/src/ConnectionStatus.test.tsx` :: shows a connected message when status is connected, shows a checking message when status is checking | 退役仕様 mvp |
| G-154 | 画面: サイドパネル | サイドパネルは常時表示され、タスクボードでの作成・チェックインでの着手・状態変更が、画面遷移やリロードなしに「今日のタスク」一覧とチェックイン選択肢へ反映される | `web/src/AppLayout.test.tsx` :: reflects a task created on the board in the checkin selector without a reload, reflects a task's status change from a checkin on the task board without a reload (Issue #134) | #134 / 退役仕様 mvp |
| G-155 | 画面: 今日のタスクサマリー | 今日期限・今日完了のタスクのみを一覧と進捗ゲージに集計する（過去日完了は含めない）。完了は ■、未完了は □ のマーカーで表示し、読み込み中・エラー・0 件にはそれぞれ専用の文言を出す | `web/src/TodaySummary.test.tsx` :: lists today's tasks with a filled marker for done and an empty marker otherwise, shows an empty message and 0% progress when there are no tasks for today | ADR 0007 / 退役仕様 mvp |
| G-156 | 画面: チャット（送信と表示） | 送信したメッセージとボスの返信が表示され、送信中は入力欄・送信ボタンが無効化される。改行は Shift+Enter で挿入され、Enter 単独・IME 確定中の Enter では送信されない | `web/src/ChatView.test.tsx` :: does not send the draft when Shift+Enter is pressed (newline), does not send the draft when Enter confirms an IME composition | 退役仕様 mvp |
| G-157 | 画面: チャット（履歴とツール通知） | 履歴の読み込み中はローディング、失敗時は「会話履歴の読み込みに失敗しました」を表示する。ボスがタスク作成・更新ツールを使った場合のみ操作通知を出し、読み取り専用ツールでは出さない | `web/src/ChatView.test.tsx` :: shows an error state when the history restoration fails, does not claim a task was updated when a read-only tool (e.g. get_activity_log) runs | #141 / 退役仕様 mvp |
| G-158 | 画面: チャット（ストリームエラー） | ストリーム応答がエラーを報告した場合、`role="alert"` でエラーメッセージを表示する | `web/src/ChatView.test.tsx` :: shows an alert when the stream reports an error | 退役仕様 mvp |
| G-159 | 画面: チャット（セッションバッジ） | 朝会・夕会の開始 / 終了ボタンで対応するバッジ（朝会中 / 夕会中）へ切り替わり、終了すると通常の adhoc 開始ボタンへ戻る | `web/src/ChatView.test.tsx` :: starts a morning session and shows the in-session badge with an end button, shows the evening badge when starting an evening session | 退役仕様 mvp |
| G-160 | 画面: チャット（タブ横断の状態保持） | 他タブへ切り替えて戻っても、会話内容と入力中の未送信ドラフトが失われずに保持される | `web/src/AppLayout.test.tsx` :: keeps the chat conversation across a chat -> tasks -> chat round trip (Issue #93), keeps the chat draft across a chat -> tasks -> chat round trip (Issue #153) | #93, #153 |
| G-161 | 画面: チェックイン（既定選択と休憩制御） | 着手候補の既定選択は優先度が最も高いタスクになる。休憩中でなければ「着手」「休憩」を、休憩中は「戻りました」を主要操作として表示する | `web/src/CheckinPanel.test.tsx` :: defaults to the highest-priority task and shows break controls when not on break, shows the return button as the primary action while on break and sends break_end | 退役仕様 mvp |
| G-162 | 画面: チェックイン（各操作） | 「着手」「休憩」「戻りました」「完了」の各操作はチェックイン API またはタスク更新を呼ぶ。失敗時は `role="alert"`、成功時は成功メッセージと共有タスク一覧の再取得を伴う | `web/src/CheckinPanel.test.tsx` :: shows an error message when the checkin submission fails, calls tasksState.refresh after a successful checkin (Issue #134) | #134 / 退役仕様 mvp |
| G-163 | 画面: チェックイン（完了ボタン） | 「完了」は in_progress のタスクがある場合のみ表示され、選択中タスクが todo のときは無効化される。クリックでタスクを done へ更新し、二重クリックは防止される | `web/src/CheckinPanel.test.tsx` :: shows the 完了 button only when there is an in_progress task (Issue #138), ignores a second 完了 click while one is in flight (double-click guard, Issue #138) | #138 |
| G-164 | 画面: チェックイン（当日の活動一覧） | 当日の活動一覧に種別・時刻・関連タスク名が表示される。取得失敗時はエラーメッセージを表示する | `web/src/CheckinPanel.test.tsx` :: renders today's activity with type, time, and task title, shows an error message when today's activity fails to load | 退役仕様 mvp |
| G-165 | 画面: タスクボード（カラムと D&D） | タスクは状態（未着手 / 進行中 / 完了 / 中止）ごとのカラムへ振り分けて表示され、プルダウン・ドラッグ&ドロップでの状態変更がタスク更新を呼ぶ。更新失敗時はカードが元のカラムに残り `role="alert"` を表示する | `web/src/TaskBoard.test.tsx` :: calls editTask with the drop column's status when a card is dropped there, keeps the card in its original column and shows an alert when the drop update fails | 退役仕様 mvp |
| G-166 | 画面: タスクボード（追加とエラー） | フォームからタスクを追加でき、失敗時は `role="alert"` を表示する。一覧取得に失敗している場合も `role="alert"` を表示する | `web/src/TaskBoard.test.tsx` :: shows an alert when creating a task fails, shows an alert when the task list failed to load | 退役仕様 mvp |
| G-167 | 画面: タスクカード（表示条件） | 優先度・締切・ボスコメントは値がある場合のみ「ボス決定: 優先度〇」「ボス決定: 締切〇」「ボスコメント: 〇」として表示し、無ければ表示しない | `web/src/TaskCard.test.tsx` :: shows the priority as a boss decision in Japanese, hides the priority line when priority is null | 退役仕様 mvp |
| G-168 | 画面: タスクカード（編集） | 「編集」で既存値が入った編集フォームへ切り替わり、保存で更新を確定、キャンセルで破棄して表示モードへ戻る。更新失敗時は編集モードのまま留まる | `web/src/TaskCard.test.tsx` :: enters edit mode with fields pre-filled when the edit button is clicked, stays in edit mode when the update fails | 退役仕様 mvp |
| G-169 | 画面: タスクフォーム | タイトルが未入力・空白のみなら追加を行わない。入力があれば作成を呼び、成功時はフォームをクリアする。送信失敗時は入力値を保持する | `web/src/TaskForm.test.tsx` :: does not call onCreate when the title is empty, keeps the entered values when the submit fails | 退役仕様 mvp |
| G-170 | 画面: 決定ログ（一覧） | 決定が 0 件のときは「決定はまだありません」を表示し、取得失敗時は `role="alert"` を表示する。決定がある場合は内容・根拠・ステータスバッジ・関連タスクを表示する | `web/src/DecisionLog.test.tsx` :: shows an empty message when there are no decisions, renders the decision content, rationale, status badge, and related task | 退役仕様 mvp |
| G-171 | 画面: 決定ログ（進言フォーム） | 「進言する」フォームは active な決定にのみ表示され、送信結果（維持 / 修正）に応じて裁定・ボス応答・新しい決定が反映される。送信失敗時は `role="alert"` とともにフォームを開いたまま入力内容を保持する | `web/src/DecisionLog.test.tsx` :: submits an appeal and reflects a revised verdict (original marked revised, new decision added), shows an alert and keeps the form open when the appeal submission fails | 退役仕様 mvp |
| G-172 | 画面: 設定 | 取得中はローディング、失敗時は `role="alert"`、成功時は各フィールドに保存済みの値が表示される。「保存」で PUT し、保存中は全フィールドと保存ボタンを無効化する。成功時は成功メッセージと反映タイミングの注記を、失敗時は `role="alert"` と入力値の保持を行う | `web/src/SettingsView.test.tsx` :: renders the loaded settings values in the form fields, disables the form fields while saving so in-flight edits are not silently overwritten, shows an error message and keeps the entered values when the save fails | 退役仕様 mvp |

---

## Gaps（テストで担保されていない公開面）

> **ここに書かれているのは約束ではありません。** 公開面として存在するが、テストで担保されていないものの一覧です。埋めるべき負債として扱い、Gaps の項目に依存した実装をしないでください。
>
> 各項目は、対応するテストが追加された時点で保証（`G-NNN`）へ昇格させます。

### 検知・スケジューラ

| # | 公開面 | 担保されていない内容 |
|---|---|---|
| GAP-01 | 検知: エスカレーションのリセット | 「チェックイン・タスク操作・チャット応答など活動があればリセット」のうち、`task_start` によるリセットのみ検証されている。`chat_message` / `task_update` / `checkin` / `break_end` によるリセットを直接担保するテストが無い（実装はイベント種別を区別しないため実害は薄い） |
| GAP-02 | 検知: 勤務時間帯外の抑制の網羅 | 「休憩中に他ルールが抑制される」「勤務時間帯外に全ルールが抑制される」は検証済みだが、勤務時間帯外かつ非休憩時の個別ルール（回避・締切超過等）ごとの抑制は網羅されていない |
| GAP-03 | 検知: 重複送信防止のルール横断 | ルールエンジン経由の重複抑制・エスカレーション連携は `unstarted` でのみ検証されている。`avoidance` / `deadline_overdue` / `silence` 等での結線を担保するテストが無い |
| GAP-04 | スケジューラ: 勤務時間帯外・休憩中の停止 | スケジューラ層でこの抑制が効くことを直接検証するテストが無い（検知エンジン単体では G-007 で担保済み） |
| GAP-05 | スケジューラ: L2 / L3 への実際の昇格 | L1 発火・重複抑制・L1 リセットは検証済みだが、時間経過による L2 / L3 への昇格がスケジューラ経由で起きることは検証されていない |
| GAP-06 | スケジューラ: `rule_key` 命名の一貫性 | `unstarted:{taskId}` の 1 パターンのみ確認されており、全ルール種別で一貫した `rule_key` が重複防止に使われることが担保されていない |

### API・サーバ

| # | 公開面 | 担保されていない内容 |
|---|---|---|
| GAP-07 | `POST /api/reports/generate`（フォールバック） | LLM 抽出失敗時のフォールバック夕会サマリが実際に HTTP レスポンス本文に現れることを HTTP 層で検証していない（サービス層直接呼び出しでのみ検証） |
| GAP-08 | 日報 API のレスポンス内容 | ステータスとキー形状のみ検証されており、完了 / 進行中タスク・着手時刻・休憩集計が実際にレスポンス `content` へ反映されることを HTTP 境界で検証していない |
| GAP-09 | 作業ログ API の行フォーマット | `note` や `expected_minutes` を伴うイベントが HTTP 応答本文で「（予定 N分） — {note}」の形になることを HTTP 境界で検証していない |
| GAP-10 | SSE イベントの順序制約 | `text`（0 件以上）→ `tool` → `done`（または `error`）という順序そのものを跨イベントで直接アサートしたテストが無い（各イベント種別の存在は個別に確認済み） |
| GAP-11 | 夕会 1 日 1 回の真の同時実行 | 検査＋INSERT の単一トランザクション性について、並行リクエスト下での排他性を検証するテストが無い（逐次実行での検証のみ） |
| GAP-12 | 活動シグナルの重複・欠落 | 1 ターン中に複数のツール呼び出しが行われた場合に `activity_events` の記録が重複・欠落しないことを直接検証するテストが無い |
| GAP-13 | `PUT /api/settings` の境界値 | HTTP 経由の検証は各バリデーション種別につき代表 1 ケースのみ。境界値の全体像（0 / 6 の拒否・非整数・数値文字列等）は内部単体テストにのみ存在する |
| GAP-14 | 進言 500 系のエラーメッセージ契約 | 機微情報を含まないことは検証済みだが、クライアントへ返る文言そのものの契約は担保されていない |
| GAP-15 | 通知の実行系（クリティカル領域） | `exec-file` のタイムアウト / ENOENT / env 置換は内部テストで担保されているが、「催促が macOS 通知として実際に届く」利用者視点の振る舞いを担保する公開面テストは無い |

### LLM バックエンド

| # | 公開面 | 担保されていない内容 |
|---|---|---|
| GAP-16 | 非ストリーム経路の API キー除外 | `createClaudeCodeMessage`（非 stream 系）の `env` について、`ANTHROPIC_API_KEY` が含まれないことの**直接アサーション**が無い（テレメトリ変数の確認による間接的な担保に留まる）。不変制約に直結するため優先度が高い |
| GAP-17 | claude-code 経路のリトライ上限 | claude-code バックエンド経路の再試行回数上限・最終失敗時のエラー型を個別に検証するテストが無い（1 回の再試行成功ケースのみ確認） |

### Web

| # | 公開面 | 担保されていない内容 |
|---|---|---|
| GAP-18 | Web API クライアントの呼び出し先 URL | ダッシュボード・決定・設定・タスクの各 `fetch*` について、呼び出す URL 自体が検証されておらず、レスポンスのパースのみ確認されている |
| GAP-19 | `useChat` のドラフト保持（unmount 跨ぎ） | フック単体テストは同一インスタンス内の読み書きのみを検証しており、タブ遷移による unmount / remount を跨ぐ保持は `AppLayout.test.tsx`（G-160）でのみ担保されている |
| GAP-20 | ダッシュボードの表情選択 | satisfied（高進捗）は検証済みだが、displeased / encouraging / normal が文脈（進捗・夕会評価・エスカレーション）に応じて実際に選ばれることは画面レベルで検証されていない |
| GAP-21 | 作業ログビューのコピー再試行 | 日報ビューには「コピー失敗後に再クリックで成功する」テストがあるが、作業ログビューには同等の再試行シナリオが無い |
| GAP-22 | チェックイン画面の休憩超過表示 | 休憩終了時刻の超過などのエスカレーション表示に関する振る舞いは画面テストの対象外（休憩の開始 / 終了操作のみ検証） |

### 要人間判定（本台帳への採否を保留した項目）

| # | 項目 | 保留の理由 |
|---|---|---|
| HR-01 | FR-06「多層方式」の実効性 | `docs/features/claude-code-backend.md` の FR-06 は許可判定の多層方式を謳っていたが、許可リストに載るアプリ定義ツールについては**実質単層**であることが Issue #166 で判明している。台帳には**実挙動どおりの約束**（G-013 / G-014: 未許可ツールを拒否する）のみを載せ、「多層である」ことは保証として載せていない。意図と実挙動の差は [ADR 0003](./adr/0003-llm-backend-isolation.md) の「既知の逸脱」に記録した。#166 の対応後、この項目の再判定が必要 |
| HR-02 | ボスのツール群（`boss/*-tool.ts`）の扱い | LLM エージェントのみが呼ぶツールの入力検証・DB 永続化を公開面とみなすかは判断が割れる。本台帳では「ユーザーが画面で観測できる結果」（タスクが作成される・決定が記録される）を各 API・画面の保証で担保しているとみなし、ツール単体の振る舞いは載せていない。ツールを外部へ公開する場合は再判定が必要 |
| HR-03 | 人格プロンプトの内容 | システムプロンプトの文言（口調・厳しさの表現）を固定するテストが存在するが、ユーザーが観測するのは最終的なボスの発話であり、プロンプト文言は中間表現と判断して載せていない。人格の一貫性を製品保証にする場合は再判定が必要 |
| HR-04 | 内部レースガードの扱い | フックの stale-response ガード・二重送信ガードは、ユーザーから見れば「操作が壊れない」という約束だが、実装の防御策としての性格が強いため載せていない。ただし G-121 / G-124 / G-163 のように、明示的な受入基準があるものは保証として載せている |
