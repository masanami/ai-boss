# 保証台帳（ai-boss）

> **この台帳が、このリポジトリの駆動文書です。** 機能仕様（`docs/features/`）は退役し、恒常的な設計決定は `docs/adr/` へ、すでに守られている公開面の振る舞いは本台帳へ移しました。
>
> ここに書かれているのは「**現に守られていて、テストで担保されている外向きの約束**」です。実装の内部設計・アルゴリズムはここには書きません（コードとテストが正本）。将来やりたいことも書きません（GitHub Issue が正本）。

## 読み方

各保証は `### G-{裁可番号}-{枝番}: {約束文}` の見出しと、その直下のメタ行で構成されます。裁可番号は、その保証を裁可した PR または Issue（GDD期は `guarantee:approved` ラベルの Issue）の番号です。

| 行 | 意味 |
|---|---|
| 見出しの ID | 保証の識別子。参照時はこの ID を使う。**採番は再利用しない**（保証を削除しても番号は空けたままにする） |
| 見出しの約束文 | 外から観測できる約束。条件と結果を含む |
| `- 種別:` | 約束が観測される面の種類（API契約 / UI / 検知ロジック / 純粋関数 / データ形式 / 実行系 / 設定 / DBスキーマ） |
| `- 領域:` | どのサブシステムの約束か（可読性のための補助情報） |
| `- 関連:` | 背景にある恒常的な設計決定（ADR）や、宣言のきっかけになった Issue |
| `- テスト:` | その約束を担保しているテスト。**テストが消えたら保証も消える**（保証を残したままテストを消さない） |
| `- 宣言元:` | この保証を裁可した PR または Issue |

## 運用規律

- **保証を変える PR は、この台帳と参照テストを同時に変える。** 台帳だけ・テストだけを変えない。
- **保証を削除するのは、その約束を意図的にやめるときだけ。** テストが落ちたから台帳から消す、は禁止。
- **「Gaps」は約束ではない。** テストで担保されていない公開面の一覧であり、埋めるべき負債として扱う。Gaps の項目に依存した実装をしない。
- 内部実装のテスト（private ヘルパの分岐網羅・リポジトリ層の単体テスト等）は、公開面の保証が別途あるものについては本台帳に載せていません。それらは自由にリファクタリングしてよい。

---

## 保証（Guarantees）

### G-170-1: 最優先タスク以外への直近の活動が閾値ウィンドウ内にあれば回避とみなし、ウィンドウ外や無関係な種別は回避としない

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/avoidance.test.ts::returns true when another task had a task_start within the window`
- テスト: `server/src/detection/avoidance.test.ts::returns false when the activity is older than the window`
- テスト: `server/src/detection/avoidance.test.ts::returns false for activity types unrelated to task work (e.g. checkin)`
- テスト: `server/src/detection/avoidance.test.ts::returns false when the activity is on the top-priority task itself`
- 宣言元: #170

### G-170-2: 休憩申告の時間（未申告ならフォールバック値）を超過したら呼び戻し対象と判定する

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/break-overrun.test.ts::does not fire before the expected_minutes has elapsed`
- テスト: `server/src/detection/break-overrun.test.ts::fires once the expected_minutes has been exceeded`
- テスト: `server/src/detection/break-overrun.test.ts::falls back to the fallback minutes when expected_minutes is not set`
- 宣言元: #170

### G-170-3: 締切を過ぎた todo と in_progress のタスクをすべて抽出し、done と dropped は含めない

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/deadline-overdue.test.ts::returns a todo task whose due_at is in the past`
- テスト: `server/src/detection/deadline-overdue.test.ts::does not include done or dropped tasks even if overdue`
- テスト: `server/src/detection/deadline-overdue.test.ts::returns every overdue task, not just the top-priority one`
- テスト: `server/src/detection/deadline-overdue.test.ts::includes an overdue in_progress task`
- 宣言元: #170

### G-170-4: 同一事由の催促は L1 から L3 へ段階的に強まり、活動シグナルがあれば L1 へリセットされ、rule_key ごとに独立して管理される

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/escalation.test.ts::escalates from level 1 to level 2 exactly at the 15min interval`
- テスト: `server/src/detection/escalation.test.ts::resets to level 1 and fires immediately when an activity signal occurred after the last notification`
- テスト: `server/src/detection/escalation.test.ts::only considers history for the matching rule_key`
- テスト: `server/src/detection/escalation.test.ts::escalates from level 2 to level 3 after the 10min interval`
- 宣言元: #170

### G-170-5: 設定時刻を過ぎてもその日その種別のセッションが未開始なら催促対象と判定し、時刻設定が不正なら警告して発火しない

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/meeting.test.ts::fires when the meeting time has passed and no session of that type started today`
- テスト: `server/src/detection/meeting.test.ts::does not fire once the session type has already started today`
- テスト: `server/src/detection/meeting.test.ts::does not fire (and warns) when the configured meeting time is malformed`
- 宣言元: #170

### G-170-6: 今日の最優先タスクを優先度の高い順・締切の早い順・id 昇順で一意に選ぶ

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/priority.test.ts::picks the higher priority task over a lower priority one`
- テスト: `server/src/detection/priority.test.ts::breaks a priority tie by earlier due_at`
- テスト: `server/src/detection/priority.test.ts::excludes done and dropped tasks from the candidates`
- テスト: `server/src/detection/priority.test.ts::breaks a full tie by ascending id`
- 宣言元: #170

### G-170-7: 休憩申告中は休憩延伸以外の検知を抑制し、勤務時間帯外は休憩延伸を含む検知を抑制する。朝会の定時催促は両方のゲートの対象外として発火する

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/rule-engine.test.ts::suppresses all rules except break_overrun while on break`
- テスト: `server/src/detection/rule-engine.test.ts::suppresses all detection rules (including break_overrun) outside working hours`
- テスト: `server/src/detection/rule-engine.test.ts::fires the morning meeting rule even outside working hours and even while on break`
- 宣言元: #170

### G-170-8: 無音許容時間を見積もりから算出して 20〜90 分にクランプし、閾値を超えた無音を検知する

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/silence.test.ts::clamps the scaled threshold down to the 90min ceiling`
- テスト: `server/src/detection/silence.test.ts::clamps the scaled threshold up to the 20min floor`
- テスト: `server/src/detection/silence.test.ts::fires exactly at the threshold`
- テスト: `server/src/detection/silence.test.ts::does not fire just before the threshold`
- 宣言元: #170

### G-170-9: 勤務時間帯は開始を含み終了を含まない範囲で判定し、設定が不正なら既定の 09:00-18:00 へフォールバックする

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/time-utils.test.ts::returns true at the exact start boundary`
- テスト: `server/src/detection/time-utils.test.ts::returns false at the exact end boundary (end is exclusive)`
- テスト: `server/src/detection/time-utils.test.ts::falls back to the default working hours (09:00-18:00) when the setting is malformed`
- 宣言元: #170

### G-170-10: 未着手許容時間を見積もりから算出して 15〜120 分にクランプし、閾値経過後も todo のままなら検知する

- 種別: 検知ロジック
- 領域: サボり検知
- 関連: ADR 0004
- テスト: `server/src/detection/unstarted.test.ts::clamps large estimated_minutes down to the 120min ceiling`
- テスト: `server/src/detection/unstarted.test.ts::fires exactly at the threshold`
- テスト: `server/src/detection/unstarted.test.ts::does not fire when the task is already in_progress`
- テスト: `server/src/detection/unstarted.test.ts::clamps small estimated_minutes up to the 15min floor`
- 宣言元: #170

### G-170-11: claude-code バックエンドの子プロセス環境から ANTHROPIC_API_KEY を除外し、渡された process.env を変更しない

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0001, ADR 0003
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::excludes ANTHROPIC_API_KEY from a process.env-based copy`
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::does not mutate the given process.env object`
- 宣言元: #170

### G-170-12: claude-code バックエンドの子プロセス環境にテレメトリ無効化変数を設定し、PATH と HOME を保持する

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0001, ADR 0003
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::adds DISABLE_TELEMETRY=1 and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::preserves PATH/HOME and other existing variables needed to run/authenticate the subprocess`
- テスト: `server/src/llm/claude-client.test.ts::excludes ANTHROPIC_API_KEY, adds the telemetry-disable vars, and preserves PATH/HOME (FR-09, AC-06)`
- 宣言元: #170

### G-170-13: Claude Code のビルトインツールを無効化し、許可ツールをアプリ定義の完全修飾 MCP ツールのみに限定する

- 種別: 認可
- 領域: LLM バックエンド
- 関連: ADR 0001, ADR 0003
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::passes a canUseTool handler that denies built-in and foreign MCP tools`
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::allows exactly the app-defined fully-qualified MCP tools`
- 宣言元: #170

### G-170-14: ツールを渡さない呼び出しでは MCP サーバと許可リストを登録せず、すべてのツールを拒否する

- 種別: 認可
- 領域: LLM バックエンド
- 関連: ADR 0001, ADR 0003
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::registers no MCP server / allowedTools when no tools are given (dashboard comment / notification body)`
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::denies every tool when the call site provides no tools (dashboard comment / notification body)`
- 宣言元: #170

### G-170-15: claude-code バックエンドはセッション履歴の永続化を無効化して呼び出す

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0001, ADR 0003
- テスト: `server/src/llm/backends/claude-code-backend.test.ts::forwards the given env to query()'s env option, and disables session persistence (FR-09/AC-06, FR-15/AC-13)`
- 宣言元: #170

### G-170-16: claude-code バックエンドが失敗しても api バックエンドへ自動フォールバックしない

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/llm/claude-client.test.ts::does not fall back to the api backend when claude-code fails, even after retries are exhausted (FR-12, AC-07)`
- 宣言元: #170

### G-170-17: LLM_BACKEND を明示しない場合は claude-code を既定とし、API キー未設定でも MissingApiKeyError を投げない

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/config.test.ts::defaults llmBackend to claude-code when LLM_BACKEND is not set (Issue #118)`
- テスト: `server/src/llm/claude-client.test.ts::defaults to the claude-code backend (DEFAULT_LLM_BACKEND, Issue #118) when the backend argument is omitted and LLM_BACKEND is unset, and never throws MissingApiKeyError even without ANTHROPIC_API_KEY`
- 宣言元: #170

### G-170-18: claude-code 経路では DB を書き込むツールの実行後、またはテキスト配信後に失敗した場合は再試行しない

- 種別: API契約
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/llm/claude-client.test.ts::does not retry once a DB-writing tool has been executed during the failed attempt (AC-11 — no duplicate side effects)`
- テスト: `server/src/llm/claude-client.test.ts::does not retry once text has already been streamed to the caller during the failed attempt (self-review — no duplicated text on retry)`
- 宣言元: #170

### G-170-19: claude-code 経路ではタイムアウト予算を呼び出し全体で共有し、期限到達で abort して LlmTimeoutError を返し、副作用の無い失敗のみ指数バックオフで再試行する

- 種別: API契約
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/llm/claude-client.test.ts::aborts the attempt's signal and rejects with LlmTimeoutError when the timeout elapses`
- テスト: `server/src/llm/claude-client.test.ts::treats timeoutMs as a whole-call budget shared across retries, not reset per attempt`
- テスト: `server/src/llm/claude-client.test.ts::retries with exponential backoff after a failure when there was no side effect`
- テスト: `server/src/llm/claude-client.test.ts::retries once with exponential backoff after a transient failure with no side effect (AC-11)`
- 宣言元: #170

### G-170-20: claude-code が利用不可のとき api への切替案内を含む警告を出し、失敗自体は元のエラーで返す

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/llm/claude-client.test.ts::logs the CLAUDE_CODE_UNAVAILABLE_HINT via console.warn and still rejects with the original ClaudeCodeUnavailableError (Issue #118)`
- 宣言元: #170

### G-170-21: ANTHROPIC_API_KEY の値そのものをログに出力しない

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0002
- テスト: `server/src/config.test.ts::reports hasAnthropicApiKey as true and never logs the key value when ANTHROPIC_API_KEY is set`
- 宣言元: #170

### G-170-22: LLM_BACKEND が許容値以外なら起動時に許容値を含むエラーで停止する

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0003
- テスト: `server/src/config.test.ts::throws with an error message including the allowed values when LLM_BACKEND is invalid`
- 宣言元: #170

### G-170-23: 既定の claude-code が有効かつ API キーが設定されている場合のみ課金経路の切替を促す警告を出す

- 種別: 設定
- 領域: LLM バックエンド
- テスト: `server/src/config.test.ts::warns to set LLM_BACKEND=api when the default claude-code backend is in effect and ANTHROPIC_API_KEY is set (Issue #118)`
- テスト: `server/src/config.test.ts::does not warn about switching backends when LLM_BACKEND=api is set explicitly even if ANTHROPIC_API_KEY is set (Issue #118)`
- テスト: `server/src/config.test.ts::does not warn about switching backends when ANTHROPIC_API_KEY is not set (Issue #118)`
- テスト: `server/src/config.test.ts::does not warn about switching backends when LLM_BACKEND=claude-code is set explicitly even if ANTHROPIC_API_KEY is set (Issue #118)`
- 宣言元: #170

### G-170-24: 応答が空になる異常時の診断ログに thinking 本文やプロンプトの内容を含めない

- 種別: 設定
- 領域: LLM バックエンド
- 関連: ADR 0002
- テスト: `server/src/llm/backends/api-backend.test.ts::Issue #117 reproduction: normalizes a thinking-only, stop_reason=max_tokens response to empty content and logs a diagnostic`
- 宣言元: #170

### G-170-25: ポートと DB パスを環境変数から解決し、ポートが不正なら既定へフォールバックして警告する

- 種別: 設定
- 領域: サーバ基盤
- 関連: ADR 0005
- テスト: `server/src/config.test.ts::defaults port to 8787 when PORT is not set`
- テスト: `server/src/config.test.ts::falls back to the default port and warns when PORT is not a valid number`
- テスト: `server/src/config.test.ts::uses DB_PATH from env when set`
- 宣言元: #170

### G-170-26: チャット応答はテキスト差分とツールイベントを SSE で流し、永続化済みボスメッセージを含む done で締める

- 種別: API契約
- 領域: セッション・チャット
- 関連: ADR 0002
- テスト: `server/src/sessions/chat-messages-route.test.ts::streams text deltas and a final done event with the persisted boss message`
- テスト: `server/src/sessions/chat-messages-route.test.ts::executes a create_task tool call via the streamBossMessage callbacks, emits a tool event, and finalizes with the resulting text`
- 宣言元: #170

### G-170-27: LLM 呼び出しが失敗したとき、配信済みテキストが無ければボスメッセージを永続化せず、途中まで配信されていればその部分テキストを永続化する。いずれも生のエラー文言を含まない error イベントを送る

- 種別: API契約
- 領域: セッション・チャット
- 関連: ADR 0002
- テスト: `server/src/sessions/chat-messages-route.test.ts::emits a sanitized SSE error event when the Claude call fails, without persisting a boss message`
- テスト: `server/src/sessions/chat-messages-route.test.ts::persists the partial boss text when the stream fails midway`
- 宣言元: #170

### G-170-28: 応答にテキストが無い場合でも空文字ではなく、ツール実行の有無に応じたフォールバック文言を保存して返す

- 種別: API契約
- 領域: セッション・チャット
- テスト: `server/src/sessions/chat-messages-route.test.ts::persists a tool-summary fallback text (and reflects it in the done event) when tools ran but no text was streamed`
- テスト: `server/src/sessions/chat-messages-route.test.ts::persists a generic fallback text when the response has neither text nor tool use`
- テスト: `server/src/sessions/chat-messages-route.issue-117.test.ts::falls back to the documented 'no response' text (not an empty message) when the SDK returns a thinking-only, max_tokens-truncated turn`
- 宣言元: #170

### G-170-29: 存在しないセッションは 404、content 欠落は 400 を返してストリームへ進まず、クライアント生成失敗時は API キーを含まない 500 を返す

- 種別: API契約
- 領域: セッション・チャット
- 関連: ADR 0002
- テスト: `server/src/sessions/chat-messages-route.test.ts::returns 404 for a non-existent session id`
- テスト: `server/src/sessions/chat-messages-route.test.ts::returns 400 when content is missing`
- テスト: `server/src/sessions/chat-messages-route.test.ts::returns 500 JSON without leaking the api key when the Claude client cannot be created`
- 宣言元: #170

### G-170-30: チャット送信はユーザーメッセージ保存の後、ストリーム開始の前に chat_message の活動イベントを記録する

- 種別: データ形式
- 領域: 活動記録
- 関連: ADR 0004
- テスト: `server/src/sessions/chat-messages-route.test.ts::persists the user message and records a chat_message activity event before streaming`
- 宣言元: #170

### G-170-31: タスクの PATCH が実変更を伴い成功した場合のみ task_update の活動イベントを記録する

- 種別: データ形式
- 領域: 活動記録
- 関連: ADR 0004
- テスト: `server/src/activity/activity-routes.test.ts::records a task_update event when PATCH /api/tasks/:id succeeds`
- テスト: `server/src/activity/activity-routes.test.ts::does not record a task_update event when PATCH /api/tasks/:id fails (404)`
- テスト: `server/src/activity/activity-routes.test.ts::does not record a task_update event when the PATCH body has no fields (no real change requested)`
- 宣言元: #170

### G-170-32: 当日のローカル暦日開始時刻以降の活動イベントを created_at 昇順で返す

- 種別: API契約
- 領域: 活動記録
- 関連: ADR 0007
- テスト: `server/src/activity/activity-routes.test.ts::returns only today's events (local day boundary), ordered by created_at ascending`
- テスト: `server/src/activity/activity-routes.test.ts::returns an empty array when there are no events today`
- 宣言元: #170
- 注記: 実装（`listEventsSince`）の SQL は `created_at >= ?` のみで**上限を持たない**。本保証は下限（当日 00:00 以降）と昇順のみを約束し、翌日以降の除外は約束しない（GAP-23）

### G-170-33: チェックインは種別と付随項目を検証して活動イベントを作成し、不正入力は 400、存在しないタスク参照は 404 を返す

- 種別: API契約
- 領域: 活動記録
- テスト: `server/src/activity/checkins-routes.test.ts::records a checkin with only a type and returns 201 with the created event`
- テスト: `server/src/activity/checkins-routes.test.ts::returns 400 when task_start is missing task_id`
- テスト: `server/src/activity/checkins-routes.test.ts::returns 404 when task_start references a non-existent task`
- テスト: `server/src/activity/checkins-routes.test.ts::returns 404 (not a 500) when a non-task_start checkin references a non-existent task_id`
- 宣言元: #170

### G-170-34: task_start は todo タスクのみ in_progress へ遷移させ、状態更新に失敗したらイベントごとロールバックする

- 種別: API契約
- 領域: 活動記録
- 関連: ADR 0005
- テスト: `server/src/activity/checkins-routes.test.ts::transitions a todo task to in_progress and keeps completed_at null`
- テスト: `server/src/activity/checkins-routes.test.ts::rolls back the task_start event when the status update fails, leaving no partial write`
- テスト: `server/src/activity/checkins-routes.test.ts::does not revert a done task's status or completed_at`
- テスト: `server/src/activity/checkins-routes.test.ts::does not revert a dropped task's status`
- テスト: `server/src/activity/checkins-routes.test.ts::leaves status unchanged and records no extra task_update event for an in_progress task`
- 宣言元: #170

### G-170-35: 同じローカル日に夕会セッションが既にあれば新規作成は 409 を返し行を挿入しない

- 種別: API契約
- 領域: セッション・チャット
- 関連: ADR 0008
- テスト: `server/src/sessions/sessions-routes.test.ts::returns 409 with code evening_session_already_exists when an evening session already exists today, without inserting a new row`
- テスト: `server/src/sessions/sessions-routes.test.ts::returns 409 when today's evening session is already ended`
- テスト: `server/src/sessions/sessions-routes.test.ts::allows today's evening session when only a previous day's evening session exists (date boundary)`
- 宣言元: #170

### G-170-36: 朝会と夕会の終了時に要約を生成して保存し、生成失敗でも 200 を返し、既存の要約は上書きしない

- 種別: API契約
- 領域: セッション・チャット
- テスト: `server/src/sessions/sessions-routes.test.ts::AC-1: ending a morning session generates and persists a summary from its messages`
- テスト: `server/src/sessions/sessions-routes.test.ts::AC-3: still returns 200 with ended_at set (and summary left null) when summary generation fails`
- テスト: `server/src/sessions/sessions-routes.test.ts::does not regenerate or overwrite the summary when re-ending an already-summarized session`
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::saves the session summary AND generates the daily report when an evening session ends`
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::still generates the daily report when the summary is skipped because one already exists`
- 宣言元: #170

### G-170-37: 日報生成フックは夕会の初回終了時に発火し、終了済み夕会を再終了しても再発火せず、生成が例外を投げても終了 API は 200 を返す

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0008
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::does not re-invoke generation when an already-ended evening session is ended again (test 6)`
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::returns 200 from the end API even when generation throws (test 7)`
- 宣言元: #170

### G-170-38: 夕会終了は要約保存と日報生成を独立に実行し、要約がスキップされても日報生成は行う

- 種別: API契約
- 領域: 日報・作業ログ
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::saves the session summary AND generates the daily report when an evening session ends`
- テスト: `server/src/sessions/sessions-routes-daily-report-hook.test.ts::still generates the daily report when the summary is skipped because one already exists`
- 宣言元: #170

### G-170-39: セッション種別は許容値以外を拒否し、チャット本文は空白のみを拒否して 10000 文字までを許容する

- 種別: API契約
- 領域: セッション・チャット
- テスト: `server/src/sessions/sessions-validation.test.ts::rejects an invalid type`
- テスト: `server/src/sessions/sessions-validation.test.ts::accepts a content at exactly the maximum length`
- テスト: `server/src/sessions/sessions-validation.test.ts::rejects a content longer than the maximum length`
- テスト: `server/src/sessions/sessions-validation.test.ts::rejects an empty (whitespace-only) content`
- 宣言元: #170

### G-170-40: セッション一覧は started_at 降順で種別フィルタ可能に返し、メッセージ取得は存在しないセッション id に 404 を返す

- 種別: API契約
- 領域: セッション・チャット
- テスト: `server/src/sessions/sessions-routes.test.ts::returns sessions ordered by started_at descending (most recent first)`
- テスト: `server/src/sessions/sessions-routes.test.ts::returns 404 for a non-existent session id`
- テスト: `server/src/sessions/sessions-routes.test.ts::returns 404 for a non-numeric session id`
- テスト: `server/src/sessions/sessions-routes.test.ts::filters sessions by ?type=`
- 宣言元: #170

### G-170-41: 日報一覧を新しい日付順で返し、各要素は本文を含まず、再生成しても同じ日付が重複しない

- 種別: API契約
- 領域: 日報・作業ログ
- テスト: `server/src/reports/reports-routes.test.ts::returns an empty array when no reports exist`
- テスト: `server/src/reports/reports-routes.test.ts::returns reports newest-first, with only date/created_at/updated_at (no content)`
- テスト: `server/src/reports/reports-routes.test.ts::does not list the same date twice after regeneration`
- 宣言元: #170

### G-170-42: 指定日の日報が存在すれば本文を含めて返し、無ければ report_not_found の 404 を返す

- 種別: API契約
- 領域: 日報・作業ログ
- テスト: `server/src/reports/reports-routes.test.ts::returns the report body for an existing date`
- テスト: `server/src/reports/reports-routes.test.ts::returns 404 with code report_not_found when the date has no report`
- 宣言元: #170

### G-170-43: 日報生成は前提条件を満たせば保存して返し、満たさなければ evening_session_required の 409 を返す

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0008
- テスト: `server/src/reports/reports-routes.test.ts::generates and saves today's report, returning the same shape as GET /:date`
- テスト: `server/src/reports/reports-routes.test.ts::returns 409 with code evening_session_required when the prerequisite is not met`
- テスト: `server/src/reports/reports-routes.test.ts::overwrites the same day's report on regeneration`
- 宣言元: #170

### G-170-44: 作業ログは生成条件なしで常に本文を返し、記録が無い日は固定文言を返し、不正な日付は invalid_date の 400 を返す

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0008
- テスト: `server/src/reports/work-logs-routes.test.ts::returns 200 with the fixed '（記録なし）' body when there is no evening session at all (no prerequisite)`
- テスト: `server/src/reports/work-logs-routes.test.ts::returns 400 with code invalid_date for a malformed date param`
- テスト: `server/src/reports/work-logs-routes.test.ts::returns 400 with code invalid_date for a non-existent calendar date (e.g. Feb 30)`
- テスト: `server/src/reports/work-logs-routes.test.ts::returns 200 even when an evening session exists but has not ended (no prerequisite, unlike daily reports)`
- 宣言元: #170

### G-170-45: 作業ログは対象暦日の決定と活動イベントのみを時系列でマージし、chat_message を含めない

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0007
- テスト: `server/src/reports/work-logs-routes.test.ts::merges decisions and activity events into one created_at-ascending list`
- テスト: `server/src/reports/work-logs-routes.test.ts::excludes chat_message events from the response`
- テスト: `server/src/reports/work-logs-routes.test.ts::excludes records from the previous/next day (local calendar-day boundary)`
- 宣言元: #170

### G-170-46: 日報は固定の表題と 3 つの見出しを定義順に出力し、決定事項の見出しは出力しない

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-daily-report.test.ts::renders the title with the local date and a single-kanji weekday`
- テスト: `server/src/reports/render-daily-report.test.ts::never emits a 決定事項 heading even when eveningSummary.keyDecisions is present`
- テスト: `server/src/reports/render-daily-report.test.ts::includes the section headings 本日のタスク・活動記録・夕会サマリ in this order, and never emits a 決定事項 heading (Issue #144: 決定事項 was abolished)`
- 宣言元: #170

### G-170-47: 完了タスクと進行中タスクを固定のチェックボックス記法で表し、完了を先に列挙する

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-daily-report.test.ts::renders completed tasks as '- [x] タイトル'`
- テスト: `server/src/reports/render-daily-report.test.ts::lists completed tasks before in-progress tasks`
- テスト: `server/src/reports/render-daily-report.test.ts::renders in-progress tasks as '- [ ] タイトル（進行中）' with a single half-width space before the checkbox content`
- 宣言元: #170

### G-170-48: 活動記録は着手と休憩が無い場合に固定文言を出し、ある場合は時刻と回数と合計時間を出す

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-daily-report.test.ts::renders '- 着手: なし' when there is no first task_start`
- テスト: `server/src/reports/render-daily-report.test.ts::renders the HH:mm start time when there is a first task_start`
- テスト: `server/src/reports/render-daily-report.test.ts::renders the break count and total minutes when breakCount is greater than 0`
- テスト: `server/src/reports/render-daily-report.test.ts::renders '- 休憩: なし' (not '0回（合計0分）') when breakCount is 0`
- 宣言元: #170

### G-170-49: 夕会サマリは抽出成功時に 4 項目を定義順で出し、失敗時は固定の注記 1 行のみとして 4 項目を出さない

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-daily-report.test.ts::renders the four values in the order 報告の要点・ボスの講評・決定の要点・翌日への持ち越し`
- テスト: `server/src/reports/render-daily-report.test.ts::uses the exact fixed literal text specified by the spec`
- テスト: `server/src/reports/render-daily-report.test.ts::renders exactly the fixed one-line note and omits all four items when eveningSummary is null`
- 宣言元: #170

### G-170-50: 動的値の改行を 1 行へ正規化し、行頭の Markdown 記号をエスケープして構造を壊させない

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-daily-report.test.ts::normalizes a task title containing a newline to a single line`
- テスト: `server/src/reports/render-work-log.test.ts::escapes a leading markdown symbol in a decision content`
- 宣言元: #170

### G-170-51: 作業ログは固定の表題を出し、記録が無ければ固定文言を、各行を種別ごとの固定フォーマットで出す

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-work-log.test.ts::renders the title with the local date and a single-kanji weekday`
- テスト: `server/src/reports/render-work-log.test.ts::renders the fixed '（記録なし）' line when there are no decisions and no activity events`
- テスト: `server/src/reports/render-work-log.test.ts::renders a revised decision as '決定（改訂済み）: {content}'`
- テスト: `server/src/reports/render-work-log.test.ts::renders an active decision as '決定: {content}'`
- テスト: `server/src/reports/render-work-log.test.ts::renders a withdrawn decision as '決定（撤回）: {content}'`
- テスト: `server/src/reports/render-work-log.test.ts::renders task_start as '着手: {タスク名}'`
- テスト: `server/src/reports/render-work-log.test.ts::renders task_update as 'タスク更新: {タスク名}'`
- テスト: `server/src/reports/render-work-log.test.ts::renders break_start as '休憩開始' (no task name)`
- テスト: `server/src/reports/render-work-log.test.ts::renders break_end as '休憩終了'`
- テスト: `server/src/reports/render-work-log.test.ts::renders checkin as 'チェックイン'`
- 宣言元: #170

### G-170-52: 作業ログの並び順は created_at 昇順で、同時刻ではイベントを決定より先に、同種では id 昇順にする

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/render-work-log.test.ts::merges decisions and activity events by created_at ascending`
- テスト: `server/src/reports/render-work-log.test.ts::places an activity event before a decision when created_at is identical`
- テスト: `server/src/reports/render-work-log.test.ts::orders same-kind entries with identical created_at by id ascending, regardless of input order`
- 宣言元: #170

### G-170-53: 日報の対象暦日は夕会の開始日となり、前提条件を満たさなければ行を作らない

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0007, ADR 0008
- テスト: `server/src/reports/generate-daily-report.test.ts::当日の夕会が存在しない場合、evening_session_required を返し daily_reports に行が作られない`
- テスト: `server/src/reports/generate-daily-report.test.ts::23:50開始・翌00:30終了の夕会に対して生成すると、date と表題が開始日になる`
- 宣言元: #170

### G-170-54: 日報の完了欄は当日完了の done タスクを含み別日完了を含まない。進行中欄は当日に動きのある in_progress タスクを含み、当日に活動が無いものを含まない

- 種別: データ形式
- 領域: 日報・作業ログ
- 関連: ADR 0007, GAP-32
- テスト: `server/src/reports/collect-daily-report-data.test.ts::includes a done task whose completed_at falls on the target day`
- テスト: `server/src/reports/collect-daily-report-data.test.ts::excludes a done task completed on a different day`
- テスト: `server/src/reports/collect-daily-report-data.test.ts::includes an in_progress task that has a task_start event on the target day`
- テスト: `server/src/reports/collect-daily-report-data.test.ts::includes an in_progress task that has only a task_update event on the target day`
- テスト: `server/src/reports/collect-daily-report-data.test.ts::excludes an in_progress task with no activity_events on the target day (long-running task with no movement today)`
- 宣言元: #170

### G-170-55: LLM 抽出が遅延・失敗しても例外を投げずフォールバック日報を保存する

- 種別: API契約
- 領域: 日報・作業ログ
- 関連: ADR 0006
- テスト: `server/src/reports/generate-daily-report.test.ts::上限時間を渡した状態で LLM 応答が遅い場合、フォールバック日報が保存される（フェイクタイマーで決定的に）`
- 宣言元: #170

### G-170-56: 進言は active な決定にのみ受理し、存在しなければ 404、active でなければ 409 を返す

- 種別: API契約
- 領域: 決定・進言
- テスト: `server/src/decisions/appeals-route.test.ts::returns 404 for a non-existent decision id`
- テスト: `server/src/decisions/appeals-route.test.ts::returns 409 when the decision is not active (already revised)`
- テスト: `server/src/decisions/appeals-route.test.ts::returns 409 when the decision is withdrawn`
- 宣言元: #170

### G-170-57: 進言の content が欠落していれば 400 を返し裁定要求を呼び出さない

- 種別: API契約
- 領域: 決定・進言
- テスト: `server/src/decisions/appeals-route.test.ts::returns 400 when content is missing`
- 宣言元: #170

### G-170-58: 裁定が未呼び出し・不正・例外のいずれでも 500 を返し DB を一切変更しない

- 種別: API契約
- 領域: 決定・進言
- 関連: ADR 0005
- テスト: `server/src/decisions/appeals-route.test.ts::returns 500 and makes no DB changes when the Claude call fails`
- テスト: `server/src/decisions/appeals-route.test.ts::returns 500 and makes no DB changes when Claude does not call submit_verdict`
- テスト: `server/src/decisions/appeals-route.test.ts::returns 500 and makes no DB changes when the verdict is invalid`
- 宣言元: #170

### G-170-59: 進言のエラー応答に API キーなどの機微情報を含めない

- 種別: API契約
- 領域: 決定・進言
- 関連: ADR 0002
- テスト: `server/src/decisions/appeals-route.test.ts::returns 500 without leaking the api key when the Claude client cannot be created`
- 宣言元: #170

### G-170-60: 裁定が維持なら進言を保存して決定を active のまま返す

- 種別: API契約
- 領域: 決定・進言
- テスト: `server/src/decisions/appeals-route.test.ts::persists an upheld appeal, keeps the decision active, and returns {appeal, decision}`
- 宣言元: #170

### G-170-61: 裁定が修正なら元の決定を revised にし、task_id を引き継いだ新しい active な決定を作成する

- 種別: API契約
- 領域: 決定・進言
- テスト: `server/src/decisions/appeals-route.test.ts::persists a revised appeal, marks the original decision revised, and creates a new active decision`
- テスト: `server/src/decisions/appeals-route.test.ts::carries a null task_id through to the revised decision when the original decision has no related task`
- 宣言元: #170

### G-170-62: 裁定中に決定が active でなくなった場合は 409 を返し DB を変更しない

- 種別: API契約
- 領域: 決定・進言
- 関連: ADR 0005
- テスト: `server/src/decisions/appeals-route.test.ts::returns 409 and makes no DB changes when the decision stopped being active while the Claude call was in flight (race guard)`
- 宣言元: #170

### G-170-63: 決定一覧を created_at 降順で返し、各決定に自分自身の進言履歴を付与する

- 種別: API契約
- 領域: 決定・進言
- テスト: `server/src/decisions/decisions-routes.test.ts::returns decisions ordered by created_at descending`
- テスト: `server/src/decisions/appeals-route.test.ts::attaches an empty appeals array when a decision has no appeals`
- テスト: `server/src/decisions/appeals-route.test.ts::attaches each decision's own appeal history`
- 宣言元: #170

### G-170-64: タスク一覧を created_at 昇順で返す

- 種別: API契約
- 領域: タスク
- テスト: `server/src/tasks/tasks-routes.test.ts::returns an empty array when no tasks exist`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns all tasks ordered by created_at ascending`
- 宣言元: #170

### G-170-65: タスクはタイトルのみで作成でき、既定値が補われ、done 指定時は completed_at が設定される

- 種別: API契約
- 領域: タスク
- テスト: `server/src/tasks/tasks-routes.test.ts::creates a task with only a title, filling in defaults`
- テスト: `server/src/tasks/tasks-routes.test.ts::creates a task with all optional fields set`
- テスト: `server/src/tasks/tasks-routes.test.ts::sets completed_at when a task is created directly with status done`
- 宣言元: #170

### G-170-66: タスク作成は title の欠落・空文字、description の型不正、estimated_minutes の非負整数違反、不正 JSON に対して 400 を返す

- 種別: API契約
- 領域: タスク
- 関連: GAP-34
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 with a machine-readable error when title is missing`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when title is an empty string`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when description is not a string`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when estimated_minutes is not a non-negative integer`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when the request body is not valid JSON`
- 宣言元: #170

### G-170-67: タスク更新は指定フィールドのみを変え、存在しない id は 404 を返し、created_at は変わらず updated_at が応答に含まれる

- 種別: API契約
- 領域: タスク
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 404 for a non-existent id`
- テスト: `server/src/tasks/tasks-routes.test.ts::partially updates only the specified fields, keeping the rest`
- テスト: `server/src/tasks/tasks-routes.test.ts::updates updated_at when a task is patched`
- 宣言元: #170

### G-170-68: タスク更新は status の不正値、title の空文字、更新不可フィールド category の指定に対して 400 を返す

- 種別: API契約
- 領域: タスク
- 関連: GAP-34
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when category is included in the patch`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when status is invalid`
- テスト: `server/src/tasks/tasks-routes.test.ts::returns 400 when title is patched to an empty string`
- 宣言元: #170

### G-170-69: status を done にすると completed_at が設定され、done から外すと null に戻る

- 種別: API契約
- 領域: タスク
- テスト: `server/src/tasks/tasks-routes.test.ts::sets completed_at when status transitions to done`
- テスト: `server/src/tasks/tasks-routes.test.ts::clears completed_at when status transitions away from done`
- 宣言元: #170

### G-170-70: 設定は未設定時に既定値一式を返し、保存値が不正でも該当キーは既定へフォールバックする

- 種別: API契約
- 領域: 設定
- テスト: `server/src/settings/settings-routes.test.ts::returns default effective values when nothing is set`
- テスト: `server/src/settings/settings-routes.test.ts::falls back to defaults for stored invalid values (e.g. an out-of-range strictness)`
- 宣言元: #170

### G-170-71: ダッシュボードコメントの派生キャッシュキーを設定レスポンスに含めない

- 種別: API契約
- 領域: 設定
- テスト: `server/src/settings/settings-routes.test.ts::excludes the dashboard boss-comment cache keys (derived cache, not a user setting)`
- 宣言元: #170

### G-170-72: 設定更新は指定キーのみを変え、残りは既定のまま保持する

- 種別: API契約
- 領域: 設定
- テスト: `server/src/settings/settings-routes.test.ts::updates only the provided key, leaving the rest at defaults`
- テスト: `server/src/settings/settings-routes.test.ts::updates multiple keys at once`
- 宣言元: #170

### G-170-73: 自由記述設定は空文字で未設定へ戻り、null も受け付けて取得結果をそのまま書き戻せる

- 種別: API契約
- 領域: 設定
- テスト: `server/src/settings/settings-routes.test.ts::resets boss_custom_instructions to null when set to an empty string`
- テスト: `server/src/settings/settings-routes.test.ts::accepts boss_custom_instructions: null (round-tripping GET's response back into PUT)`
- 宣言元: #170

### G-170-74: 設定更新は 1 キーでも不正なら 400 を返し、他の有効なキーも含めて一切保存しない

- 種別: API契約
- 領域: 設定
- 関連: ADR 0005
- テスト: `server/src/settings/settings-routes.test.ts::returns 400 and saves nothing when a value is invalid (all-or-nothing)`
- テスト: `server/src/settings/settings-routes.test.ts::returns 400 for an unrecognized key`
- テスト: `server/src/settings/settings-routes.test.ts::returns 400 for an invalid time format`
- 宣言元: #170

### G-170-75: ヘルスチェックは DB 接続の生死を返し、DB が落ちてもサーバは落ちない

- 種別: API契約
- 領域: サーバ基盤
- テスト: `server/src/app.test.ts::returns 200 with status ok and db true from GET /api/health`
- テスト: `server/src/app.test.ts::returns db: false when the database query fails`
- 宣言元: #170

### G-170-76: 未知の非 API パスは index.html へフォールバックし、API ルートが静的配信より優先される

- 種別: API契約
- 領域: サーバ基盤
- テスト: `server/src/app.test.ts::falls back to index.html for an unknown non-API path (SPA routing)`
- テスト: `server/src/app.test.ts::still serves API routes with precedence over static files`
- テスト: `server/src/app.test.ts::returns 404 for an unknown /api path instead of index.html`
- 宣言元: #170

### G-170-77: マイグレーションは台帳記載の全テーブルを作成する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005, #175（複合文だった約束を分割し、再実行の無変化側を G-175-4 へ分離する改訂を裁可）
- テスト: `server/src/db/migrate.test.ts::creates the tasks table`
- テスト: `server/src/db/migrate.test.ts::creates the sessions table`
- テスト: `server/src/db/migrate.test.ts::creates the messages table`
- テスト: `server/src/db/migrate.test.ts::creates the decisions table`
- テスト: `server/src/db/migrate.test.ts::creates the appeals table`
- テスト: `server/src/db/migrate.test.ts::creates the settings table`
- テスト: `server/src/db/migrate.test.ts::creates the notifications table`
- テスト: `server/src/db/migrate.test.ts::creates the activity_events table`
- テスト: `server/src/db/migrate.test.ts::creates the daily_reports table (v3)`
- 宣言元: #170

### G-170-78: 旧バージョンの DB を既存テーブルを壊さずに新バージョンへ引き上げる

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::upgrades a v2 database to v3 (adds daily_reports) without touching existing tables`
- テスト: `server/src/db/migrate.test.ts::upgrades a v3 database to v4 (adds paused status and task_pause type) without touching existing tables`
- 宣言元: #170

### G-170-79: 列挙値を持つ 6 カラムは、許可された値以外を CHECK 制約で拒否する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::rejects an invalid tasks.status`
- テスト: `server/src/db/migrate.test.ts::rejects an invalid appeals.verdict`
- テスト: `server/src/db/migrate.test.ts::rejects an invalid activity_events.type`
- テスト: `server/src/db/migrate.test.ts::rejects an invalid sessions.type`
- テスト: `server/src/db/migrate.test.ts::rejects an invalid messages.role`
- テスト: `server/src/db/migrate.test.ts::rejects an invalid decisions.status`
- 宣言元: #170

### G-170-80: 外部キー制約が有効で、日報の日付には一意制約がある

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::enforces foreign keys: inserting a message with an unknown session_id fails`
- テスト: `server/src/db/migrate.test.ts::daily_reports.evening_session_id references sessions and rejects an unknown id`
- テスト: `server/src/db/migrate.test.ts::enforces daily_reports.date UNIQUE`
- 宣言元: #170

### G-175-1: マイグレーション version の適用が失敗したとき、DB はその version を適用する前の状態のまま残る

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::rolls back every statement of a failed version, leaving schema and user_version at the previous version boundary`
- 宣言元: #175

### G-175-2: マイグレーションが中断された DB に対する `runMigrations` の再実行は、最新 version まで引き上げて正常終了する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::re-running after an interrupted migration brings the database up to the latest version`
- 宣言元: #175

### G-175-3: マイグレーションの適用に失敗したとき、失敗した version 番号を含むエラーを投げる

- 種別: 実行系
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::wraps a migration failure in an error naming the failed version`
- 宣言元: #175

### G-175-4: 適用済みの DB に対する `runMigrations` の再実行は、テーブル構成を変えずに正常終了する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005
- テスト: `server/src/db/migrate.test.ts::is idempotent: running migrations twice does not raise an error`
- 宣言元: #175

### G-170-81: 通知は terminal-notifier を優先し失敗したら osascript へフォールバックし、両方失敗しても例外を投げない

- 種別: 実行系
- 領域: 通知
- テスト: `server/src/notifications/notifier.test.ts::falls back to osascript when terminal-notifier is not available`
- テスト: `server/src/notifications/notifier.test.ts::resolves without throwing and reports delivered:false when both commands fail`
- テスト: `server/src/notifications/notifier.test.ts::resolves without throwing and reports delivered:false when both commands time out (killed for exceeding the configured timeout)`
- 宣言元: #170

### G-170-82: 通知本文に引用符や改行が含まれても外部コマンドを壊さない

- 種別: 実行系
- 領域: 通知
- テスト: `server/src/notifications/notifier.test.ts::safely escapes double quotes in the body without breaking the osascript argument list`
- テスト: `server/src/notifications/notifier.test.ts::normalizes newlines in the body so a multi-line Claude-generated message doesn't break the osascript string literal`
- 宣言元: #170

### G-170-83: 外部コマンドにタイムアウトを設定し、応答しないプロセスが呼び出し元をブロックし続けない

- 種別: 実行系
- 領域: 通知
- テスト: `server/src/notifications/notifier.test.ts::invokes child_process.execFile with a timeout so a hung notifier process cannot block the caller forever`
- テスト: `server/src/notifications/notifier.test.ts::rejects (without leaving the promise pending forever) when execFile reports a timeout`
- 宣言元: #170

### G-170-84: 毎分のティックで検知から文面生成と通知送信と記録までを実行する

- 種別: 実行系
- 領域: スケジューラ
- 関連: ADR 0004
- テスト: `server/src/scheduler/scheduler-tick.test.ts::fires, generates a body, sends the notification, and records it when a rule condition is met`
- テスト: `server/src/scheduler/scheduler.test.ts::registers a cron job that runs every minute`
- 宣言元: #170

### G-170-85: 同一の事由の通知はエスカレーション間隔内では再送しない

- 種別: 実行系
- 領域: スケジューラ
- 関連: ADR 0004
- テスト: `server/src/scheduler/scheduler-tick.test.ts::does not resend within the escalation interval on the next tick (duplicate suppression)`
- 宣言元: #170

### G-170-86: 活動イベントが記録されるとエスカレーションレベルが L1 に戻る

- 種別: 実行系
- 領域: スケジューラ
- 関連: ADR 0004
- テスト: `server/src/scheduler/scheduler-tick.test.ts::resets the escalation level to L1 after an activity signal is recorded`
- 宣言元: #170

### G-170-87: 通知の送信が失敗してもティックは例外を投げず、通知レコードは残る

- 種別: 実行系
- 領域: スケジューラ
- テスト: `server/src/scheduler/scheduler-tick.test.ts::does not crash and still records the notification when sending fails (both channels reject)`
- 宣言元: #170

### G-170-88: 通知文面の LLM 呼び出しが失敗した場合は定型文へフォールバックした本文を返し、ある発火の処理が例外で失敗しても残りの発火の処理は継続する

- 種別: 実行系
- 領域: スケジューラ
- 関連: ADR 0004, #173
- テスト: `server/src/scheduler/scheduler-tick.test.ts::continues processing the remaining firings when one firing fails (per-firing isolation)`
- テスト: `server/src/notifications/notification-body.test.ts::falls back to the fixed template when streamBossMessage rejects, without leaking the error message`
- 宣言元: #170

### G-170-89: 前回のティックが実行中の間に始まったティックはスキップされ二重送信を起こさない

- 種別: 実行系
- 領域: スケジューラ
- テスト: `server/src/scheduler/scheduler-tick.test.ts::skips a tick that starts while the previous one is still running (concurrency guard)`
- 宣言元: #170

### G-170-90: ティック入力の構築中に予期しないエラーが起きても例外を外へ投げずログして継続する

- 種別: 実行系
- 領域: スケジューラ
- テスト: `server/src/scheduler/scheduler-tick.test.ts::logs and continues (does not throw) when an unexpected error occurs while building the tick input`
- 宣言元: #170

### G-170-91: ダッシュボードは進捗とセッション実施状況とエスカレーションレベルを含む固定形状で返す

- 種別: API契約
- 領域: ダッシュボード
- テスト: `server/src/dashboard/dashboard-routes.test.ts::returns 200 with the full dashboard shape`
- テスト: `server/src/dashboard/dashboard-routes.test.ts::reflects task progress, session flags, and the max escalation level`
- 宣言元: #170

### G-170-92: ダッシュボードは LLM が使えなくても 500 にせずフォールバックコメントを含む 200 を返す

- 種別: API契約
- 領域: ダッシュボード
- 関連: ADR 0003
- テスト: `server/src/dashboard/dashboard-routes.test.ts::returns 200 with a fallback comment (not 500) when the API key is missing`
- 宣言元: #170

### G-170-93: ダッシュボードコメントが長さ上限を超えたらテンプレートへフォールバックしキャッシュしない

- 種別: API契約
- 領域: ダッシュボード
- 関連: ADR 0003, ADR 0006
- テスト: `server/src/dashboard/boss-comment.claude-code.test.ts::falls back to the template (and does not cache) when the response exceeds the 全角80字 limit`
- テスト: `server/src/dashboard/boss-comment.claude-code.test.ts::accepts a response exactly at the 全角80字 limit (boundary)`
- 宣言元: #170

### G-170-94: ダッシュボードコメントの生成が失敗しても例外を投げず空でないフォールバック文字列を返す

- 種別: API契約
- 領域: ダッシュボード
- 関連: ADR 0003
- テスト: `server/src/dashboard/boss-comment.test.ts::returns the fallback comment without throwing when the API key is missing`
- テスト: `server/src/dashboard/boss-comment.test.ts::returns the fallback comment without throwing when the Claude call fails`
- テスト: `server/src/dashboard/boss-comment.claude-code.test.ts::falls back to the template without throwing when the claude-code query fails (e.g. spawn/auth failure)`
- 宣言元: #170

### G-170-95: 通知文面の定型文はルール種別とエスカレーションレベルで変わり、タスク名を補間する

- 種別: 実行系
- 領域: 通知
- 関連: ADR 0004
- テスト: `server/src/notifications/notification-body.test.ts::interpolates the task title into the todo_stall fallback template`
- テスト: `server/src/notifications/notification-body.test.ts::produces different fallback text across escalation levels for the same rule type`
- 宣言元: #170

### G-170-96: ボスの表情はエスカレーションを最優先とし進捗比の境界で一意に決まる

- 種別: 純粋関数
- 領域: Web ロジック
- テスト: `web/src/boss-expression.test.ts::returns displeased when the escalation level is 2 (boundary)`
- テスト: `web/src/boss-expression.test.ts::returns satisfied when the evening session is held and progress ratio is 0.8 (boundary)`
- テスト: `web/src/boss-expression.test.ts::prioritizes the escalation rule over the evening-satisfied rule`
- 宣言元: #170

### G-170-97: チャットセッションの取得と作成と終了ができ、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/chat-api.test.ts::returns the first session of the type-filtered list`
- テスト: `web/src/chat-api.test.ts::POSTs an adhoc session and returns the created record`
- テスト: `web/src/chat-api.test.ts::POSTs to the session's /end endpoint and returns the updated record`
- テスト: `web/src/chat-api.test.ts::throws the server-provided error message on failure`
- 宣言元: #170

### G-170-98: チャットの SSE イベントをハンドラへ配送し、不正なイベントデータは失敗させずエラー通知する

- 種別: API契約
- 領域: Web API クライアント
- 関連: ADR 0002
- テスト: `web/src/chat-api.test.ts::POSTs the content and dispatches text deltas then done`
- テスト: `web/src/chat-api.test.ts::dispatches tool events`
- テスト: `web/src/chat-api.test.ts::reports malformed event data via onError instead of rejecting`
- 宣言元: #170

### G-170-99: チェックインの送信と当日活動の取得ができ、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/checkins-api.test.ts::posts the input and returns the created activity event`
- テスト: `web/src/checkins-api.test.ts::throws with the server error message when the request fails`
- テスト: `web/src/checkins-api.test.ts::returns the parsed activity event list when the request succeeds`
- 宣言元: #170

### G-170-100: 日報 API の失敗はサーバーの安定コードを保持したエラーとして返る

- 種別: API契約
- 領域: Web API クライアント
- 関連: ADR 0008
- テスト: `web/src/daily-reports-api.test.ts::returns the parsed report when the request succeeds`
- テスト: `web/src/daily-reports-api.test.ts::throws a ReportApiError carrying code 'report_not_found' on a 404`
- テスト: `web/src/daily-reports-api.test.ts::throws a ReportApiError carrying code 'evening_session_required' on a 409`
- 宣言元: #170

### G-170-101: ダッシュボードの取得結果をパースして返し、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/dashboard-api.test.ts::returns the parsed dashboard response when the request succeeds`
- テスト: `web/src/dashboard-api.test.ts::throws with the server error message when the request fails`
- 宣言元: #170

### G-170-102: 進捗レベルは 0.3 と 0.8 を境界に 3 段階へ分類される

- 種別: 純粋関数
- 領域: Web ロジック
- テスト: `web/src/dashboard-progress-level.test.ts::returns low when the ratio is just below the encouraging threshold (0.3)`
- テスト: `web/src/dashboard-progress-level.test.ts::returns mid when the ratio equals the encouraging threshold (0.3, boundary)`
- テスト: `web/src/dashboard-progress-level.test.ts::returns high when the ratio equals the satisfied threshold (0.8, boundary)`
- 宣言元: #170

### G-170-103: 決定一覧の取得と進言の送信ができ、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/decisions-api.test.ts::returns the parsed decision list when the request succeeds`
- テスト: `web/src/decisions-api.test.ts::posts the content and returns the verdict result`
- テスト: `web/src/decisions-api.test.ts::throws with the server error message when the appeal fails`
- 宣言元: #170

### G-170-104: 直近の休憩開始に休憩終了が続いていなければ休憩中と判定する

- 種別: 純粋関数
- 領域: Web ロジック
- テスト: `web/src/derive-break-status.test.ts::returns true when the last break_start has no following break_end`
- テスト: `web/src/derive-break-status.test.ts::returns false when a break_end follows the break_start`
- テスト: `web/src/derive-break-status.test.ts::returns true when a second break_start has no following break_end`
- 宣言元: #170

### G-170-105: 夕会評価のトーンは 0.5 と 0.8 を境界に 3 段階で返る

- 種別: 純粋関数
- 領域: Web ロジック
- テスト: `web/src/evening-evaluation.test.ts::returns praise when the ratio is 0.8 (boundary)`
- テスト: `web/src/evening-evaluation.test.ts::returns neutral when the ratio equals 0.5 (boundary)`
- テスト: `web/src/evening-evaluation.test.ts::returns scold when the ratio is just below 0.5`
- 宣言元: #170

### G-170-106: favicon と Web App Manifest が宣言どおりのアイコンとともに実在する

- 種別: データ形式
- 領域: Web 静的アセット
- テスト: `web/src/public-assets.test.ts::favicon.svg is a valid SVG image`
- テスト: `web/src/public-assets.test.ts::manifest.webmanifest declares a standalone app with 192px/512px PNG icons`
- テスト: `web/src/public-assets.test.ts::icon-192.png and icon-512.png referenced by manifest.webmanifest exist as 192x192/512x512 PNGs`
- 宣言元: #170

### G-170-107: 既定タスクは優先度が高いものを選び、同順位なら id の小さい方を選ぶ

- 種別: 純粋関数
- 領域: Web ロジック
- テスト: `web/src/select-default-task.test.ts::returns undefined for an empty list`
- テスト: `web/src/select-default-task.test.ts::returns the high priority task over medium/low/unset ones`
- テスト: `web/src/select-default-task.test.ts::breaks ties between equal priorities by the smaller id`
- 宣言元: #170

### G-170-108: 復元するセッションは当日の未終了の朝会・夕会のうち開始が新しい方を active に選び、当日の adhoc を別枠で返す。前日以前は無視する

- 種別: 純粋関数
- 領域: Web ロジック
- 関連: ADR 0007, #174
- テスト: `web/src/select-restore-session.test.ts::when both morning and evening are open today, picks the more recently started one regardless of input order`
- テスト: `web/src/select-restore-session.test.ts::falls back to today's adhoc session when today's morning session is already ended`
- テスト: `web/src/select-restore-session.test.ts::ignores an open morning session from a previous day`
- 宣言元: #170

### G-170-109: 設定の取得と指定キーのみのパッチ更新ができ、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/settings-api.test.ts::returns the parsed settings when the request succeeds`
- テスト: `web/src/settings-api.test.ts::PUTs the patch with correct key names and value types and returns the updated settings`
- テスト: `web/src/settings-api.test.ts::throws with the server error message when the update fails`
- 宣言元: #170

### G-170-110: タスクの一覧取得と作成と部分更新ができ、失敗時はサーバーのエラーメッセージで失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/tasks-api.test.ts::returns the parsed task list when the request succeeds`
- テスト: `web/src/tasks-api.test.ts::posts the input and returns the created task`
- テスト: `web/src/tasks-api.test.ts::patches the task by id and returns the updated task`
- 宣言元: #170

### G-170-111: 日付キーはローカル日付基準でゼロ埋めの YYYY-MM-DD へ整形される

- 種別: 純粋関数
- 領域: Web ロジック
- 関連: ADR 0007
- テスト: `web/src/to-date-key.test.ts::formats a date as YYYY-MM-DD with zero-padded month and day`
- テスト: `web/src/to-date-key.test.ts::zero-pads single-digit months and days`
- 宣言元: #170

### G-170-112: 本日のタスクは todo と in_progress を常に含み、done は当日完了のもののみを含め、dropped は含めない

- 種別: 純粋関数
- 領域: Web ロジック
- 関連: ADR 0007
- テスト: `web/src/today-tasks.test.ts::includes todo and in_progress tasks`
- テスト: `web/src/today-tasks.test.ts::includes done tasks completed today (local date)`
- テスト: `web/src/today-tasks.test.ts::excludes done tasks completed on a past day`
- テスト: `web/src/today-tasks.test.ts::excludes done tasks without completed_at`
- テスト: `web/src/today-tasks.test.ts::excludes dropped tasks`
- 宣言元: #170

### G-170-113: 作業ログの取得失敗はサーバーの安定コードを保持したエラーとして返り、非 JSON のエラーでも失敗する

- 種別: API契約
- 領域: Web API クライアント
- テスト: `web/src/work-logs-api.test.ts::GETs /api/work-logs/:date and returns the work log`
- テスト: `web/src/work-logs-api.test.ts::throws a ReportApiError carrying the server's code on a 400 invalid_date`
- テスト: `web/src/work-logs-api.test.ts::throws a ReportApiError without a code when the error body is not JSON`
- 宣言元: #170

### G-170-114: チャットの入力ドラフトは更新した値がそのまま保持される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::initializes draft as an empty string`
- テスト: `web/src/use-chat.test.ts::updates draft via setDraft`
- 宣言元: #170

### G-170-115: 画面を開くと当日の随時セッションの会話履歴が復元され、前日以前のセッションは復元しない

- 種別: UI
- 領域: Web フック
- 関連: ADR 0007
- テスト: `web/src/use-chat.test.ts::restores the history of the latest adhoc session on mount`
- テスト: `web/src/use-chat.test.ts::is ready with no entries when no adhoc session exists`
- テスト: `web/src/use-chat.test.ts::does not restore the latest adhoc session when it was started on a previous local day`
- 宣言元: #170

### G-170-116: 会話履歴の取得に失敗した場合は画面がエラー状態になる

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::sets an error status when history restoration fails`
- 宣言元: #170

### G-170-117: 送信するとユーザー発言が即座に追加され、ストリーム完了後にボスの返信がエントリとして追加される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::creates a session on first send, then appends the user entry and the streamed boss reply`
- テスト: `web/src/use-chat.test.ts::reuses the restored session on send`
- 宣言元: #170

### G-170-118: ストリーム中のツール呼び出しがチャット上にツール実行のエントリとして表示される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::records tool entries emitted during the stream`
- 宣言元: #170

### G-170-119: ストリーム中にエラーが届くと途中のテキストが消えエラーが表示される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::surfaces an SSE error event and clears the streaming buffer`
- 宣言元: #170

### G-170-120: 送信が失敗しても直前に入力した発言は画面から消えない

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::keeps the optimistic user entry when session creation fails`
- テスト: `web/src/use-chat.test.ts::surfaces a request failure as an error`
- 宣言元: #170

### G-170-121: 送信処理の実行中に再度送信しても二重に送られない

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::ignores a second send while one is already in flight`
- 宣言元: #170

### G-170-122: 朝会を開始すると当日分の会話へ切り替わり、終了すると随時の会話へ戻る

- 種別: UI
- 領域: Web フック
- 関連: ADR 0007
- テスト: `web/src/use-chat.test.ts::creates a new morning session when none exists for today`
- テスト: `web/src/use-chat.test.ts::restores today's existing morning session instead of creating a new one`
- テスト: `web/src/use-chat.test.ts::returns to today's adhoc conversation when ending a meeting that was restored on mount`
- 宣言元: #170

### G-170-123: セッションの開始と終了に失敗するとエラーが表示される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::surfaces an error when starting a session fails`
- テスト: `web/src/use-chat.test.ts::surfaces an error when ending a session fails`
- 宣言元: #170

### G-170-124: セッション切替中の送信と送信中のセッション切替は受け付けない

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-chat.test.ts::ignores startSession while a message send is in flight`
- テスト: `web/src/use-chat.test.ts::ignores send while a session switch is in flight`
- テスト: `web/src/use-chat.test.ts::ignores a second startSession call while one is already in flight`
- 宣言元: #170

### G-170-125: クリップボードのコピー結果が画面へ反映され、API が使えない環境でも例外を投げず失敗状態になる

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-copy-to-clipboard.test.ts::starts idle and transitions to success when the clipboard write resolves`
- テスト: `web/src/use-copy-to-clipboard.test.ts::transitions to failure when the clipboard write rejects`
- テスト: `web/src/use-copy-to-clipboard.test.ts::transitions to failure without throwing when navigator.clipboard is undefined (non-secure context)`
- 宣言元: #170

### G-170-126: コピー対象の本文が切り替わると前の結果表示は引き継がれない

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-copy-to-clipboard.test.ts::resets to idle when the content changes (stale result must not stick)`
- 宣言元: #170

### G-170-127: 画面を開くと当日の活動が一覧表示され、休憩中かどうかが履歴から判定される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-checkin-panel.test.ts::loads today's activity events on mount`
- テスト: `web/src/use-checkin-panel.test.ts::derives isOnBreak from the loaded events`
- テスト: `web/src/use-checkin-panel.test.ts::sets an error status when the initial fetch fails`
- 宣言元: #170

### G-170-128: チェックインが成功すると活動履歴とタスクボードが最新化され、失敗時はボードを更新しない

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-checkin-panel.test.ts::refetches events and returns true after a successful submitCheckin`
- テスト: `web/src/use-checkin-panel.test.ts::calls the provided refreshTasks callback after a successful submitCheckin (Issue #134)`
- テスト: `web/src/use-checkin-panel.test.ts::does not call refreshTasks when submitCheckin fails (Issue #134)`
- 宣言元: #170

### G-170-129: タスクの完了操作が成功すると活動履歴が最新化され、失敗時はエラーが表示される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-checkin-panel.test.ts::completeTask calls editTask, reloads events, and returns true on success (Issue #138)`
- テスト: `web/src/use-checkin-panel.test.ts::sets submitError and returns false when completeTask's editTask rejects (Issue #138)`
- 宣言元: #170

### G-170-130: 画面を開くと当日の日報と過去日一覧が表示され、未生成なら夕会が必要である旨が表示される

- 種別: UI
- 領域: Web フック
- 関連: ADR 0008
- テスト: `web/src/use-daily-reports.test.ts::loads today's report and the past summaries on mount`
- テスト: `web/src/use-daily-reports.test.ts::shows the evening-session-required state when today's report doesn't exist yet (404)`
- テスト: `web/src/use-daily-reports.test.ts::sets an error status when the initial summaries fetch fails outright`
- 宣言元: #170

### G-170-131: 過去日を選ぶと表示中の日報がその日のものへ切り替わる

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-daily-reports.test.ts::selects a past date and switches the displayed report content`
- 宣言元: #170

### G-170-132: 再生成すると本文と一覧が更新され、同じ日付が重複せず、夕会未完了なら夕会が必要である旨が表示される

- 種別: UI
- 領域: Web フック
- 関連: ADR 0008
- テスト: `web/src/use-daily-reports.test.ts::regenerates the report, updating both the content and the summary list without duplicating the date`
- テスト: `web/src/use-daily-reports.test.ts::surfaces the evening-session-required state when regenerate fails with a 409`
- 宣言元: #170

### G-170-133: 画面を開くとダッシュボードが表示され、取得に失敗するとエラー状態になる

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-dashboard.test.ts::loads the dashboard on mount`
- テスト: `web/src/use-dashboard.test.ts::sets an error status when the initial fetch fails`
- 宣言元: #170

### G-170-134: 画面を開くと決定と進言の一覧が表示され、取得に失敗するとエラー状態になる

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-decisions.test.ts::loads the decision list on mount`
- テスト: `web/src/use-decisions.test.ts::sets an error status when the initial fetch fails`
- 宣言元: #170

### G-170-135: 進言の送信が成功すると一覧が更新され、失敗時は更新せずエラーが伝播する

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-decisions.test.ts::refetches the full decision list after a successful appeal`
- テスト: `web/src/use-decisions.test.ts::propagates the error and does not refetch when the appeal submission fails`
- 宣言元: #170

### G-170-136: ヘルスチェックの成否が接続状態として画面に反映される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-health-check.test.ts::returns connected when the health check fetch succeeds`
- テスト: `web/src/use-health-check.test.ts::returns disconnected when the health check fetch throws`
- テスト: `web/src/use-health-check.test.ts::returns disconnected when the health check fetch resolves not ok`
- 宣言元: #170

### G-170-137: 設定の保存が成功すると画面の値が更新され、失敗時は元の値を維持したままエラーが表示される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-settings.test.ts::loads settings on mount and sets status ready`
- テスト: `web/src/use-settings.test.ts::updates settings and returns true after a successful save`
- テスト: `web/src/use-settings.test.ts::sets saveError and returns false when the save fails, keeping the previous settings`
- 宣言元: #170

### G-170-138: タスクの追加と編集が成功すると画面の一覧へ即座に反映される

- 種別: UI
- 領域: Web フック
- テスト: `web/src/use-tasks.test.ts::loads the task list on mount`
- テスト: `web/src/use-tasks.test.ts::appends the created task after addTask resolves`
- テスト: `web/src/use-tasks.test.ts::replaces the matching task after editTask resolves`
- 宣言元: #170

### G-170-139: 当日の日報が未生成なら夕会の完了を促す案内が表示される

- 種別: UI
- 領域: Web 画面
- 関連: ADR 0008
- テスト: `web/src/DailyReportView.test.tsx::shows the evening-session-required hint when today's report doesn't exist yet`
- テスト: `web/src/DailyReportView.test.tsx::shows the evening-session-required hint when regenerate fails with a 409`
- 宣言元: #170

### G-170-140: 当日の日報が存在する場合は本文がそのまま表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DailyReportView.test.tsx::displays today's report content as raw markdown text`
- 宣言元: #170

### G-170-141: 日報のコピーが成功すると読み上げ可能な成功通知が一時表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DailyReportView.test.tsx::copies the report content and shows a temporary success notification (role=status)`
- 宣言元: #170

### G-170-142: 日報のコピーが失敗すると警告表示とともに手動コピー用のテキストエリアへ退避でき、再試行できる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DailyReportView.test.tsx::falls back to a selected textarea when the clipboard write fails (role=alert)`
- テスト: `web/src/DailyReportView.test.tsx::falls back to a selected textarea when navigator.clipboard is undefined (non-secure context)`
- テスト: `web/src/DailyReportView.test.tsx::retries the copy on a second click of the copy button after a failure`
- 宣言元: #170

### G-170-143: 日報を再生成すると本文と過去日一覧が更新され当日の日付が重複しない

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DailyReportView.test.tsx::regenerates the report and updates both the content and the past list without duplicating today's date`
- 宣言元: #170

### G-170-144: 過去日を選択すると表示内容がその日の日報へ切り替わる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DailyReportView.test.tsx::switches the displayed content when a past date is selected from the list`
- 宣言元: #170

### G-170-145: 作業ログビューは開いた時点で当日の作業ログを表示する

- 種別: UI
- 領域: Web 画面
- 関連: ADR 0007
- テスト: `web/src/WorkLogView.test.tsx::fetches and displays today's work log on mount`
- 宣言元: #170

### G-170-146: 対象日を変えると読み込み中は前の本文を消してコピーを無効化し、日付と本文の不一致を防ぐ

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/WorkLogView.test.tsx::refetches and displays the selected date's work log when the date input changes`
- テスト: `web/src/WorkLogView.test.tsx::clears the previously loaded log while the newly selected date is still loading (PR #165 review)`
- テスト: `web/src/WorkLogView.test.tsx::disables the copy button until the work log is loaded`
- 宣言元: #170

### G-170-147: 作業ログの取得失敗とコピーの成否が読み上げ可能な通知として表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/WorkLogView.test.tsx::shows an error (role=alert) when the fetch fails`
- テスト: `web/src/WorkLogView.test.tsx::copies the work log content and shows a temporary success notification (role=status)`
- テスト: `web/src/WorkLogView.test.tsx::falls back to a selected textarea when the clipboard write fails (role=alert)`
- 宣言元: #170

### G-170-148: ボスのアバターは表情ごとに異なる画像と日本語ラベルで表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/BossAvatar.test.tsx::renders the normal expression with its Japanese label`
- テスト: `web/src/BossAvatar.test.tsx::maps each expression to a distinct image`
- テスト: `web/src/BossAvatar.test.tsx::renders the encouraging expression with its Japanese label`
- テスト: `web/src/BossAvatar.test.tsx::renders the satisfied expression with its Japanese label`
- テスト: `web/src/BossAvatar.test.tsx::renders the displeased expression with its Japanese label`
- 宣言元: #170

### G-170-149: ダッシュボードは読み込み中と失敗時の表示を持ち、成功時は進捗ゲージを表示する

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/Dashboard.test.tsx::shows a loading message while the dashboard is being fetched`
- テスト: `web/src/Dashboard.test.tsx::shows an error message when the fetch fails`
- テスト: `web/src/Dashboard.test.tsx::renders the progress gauge with the done/total count and percentage`
- 宣言元: #170

### G-170-150: 夕会評価は夕会が完了している場合のみ表示され、進捗に応じて称賛と叱責が切り替わる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/Dashboard.test.tsx::does not render the evening evaluation panel when the evening session has not been held`
- テスト: `web/src/Dashboard.test.tsx::renders a praise-styled evening evaluation panel when the ratio is high`
- テスト: `web/src/Dashboard.test.tsx::renders a scold-styled evening evaluation panel when the ratio is low`
- 宣言元: #170

### G-170-151: ナビゲーションに 7 項目が並び、既定表示はダッシュボードで、各項目で表示が切り替わる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/AppLayout.test.tsx::renders the seven nav items`
- テスト: `web/src/AppLayout.test.tsx::renders the dashboard as the default main view`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the daily report view when the report nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the boss dialogue when the chat nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the task board when the task nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the decision log when the decision log nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the work log view when the work log nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches the main area to the settings view when the settings nav item is clicked`
- テスト: `web/src/AppLayout.test.tsx::switches back to the dashboard when the dashboard nav item is clicked`
- 宣言元: #170

### G-170-152: ヘッダーにアプリ名と接続状態が表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/AppLayout.test.tsx::renders the header title`
- テスト: `web/src/AppLayout.test.tsx::shows the connected status in the header once the health check succeeds`
- テスト: `web/src/AppLayout.test.tsx::shows the disconnected status in the header when the health check fails`
- 宣言元: #170

### G-170-153: 接続状態は接続と未接続と確認中の 3 状態で表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/ConnectionStatus.test.tsx::shows a connected message when status is connected`
- テスト: `web/src/ConnectionStatus.test.tsx::shows a disconnected message when status is disconnected`
- テスト: `web/src/ConnectionStatus.test.tsx::shows a checking message when status is checking`
- 宣言元: #170

### G-170-154: サイドパネルの今日のタスクとチェックイン選択肢が、リロードなしに他画面の操作を反映する

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/AppLayout.test.tsx::shows today's tasks and norma progress in the side panel instead of the placeholders`
- テスト: `web/src/AppLayout.test.tsx::reflects a task created on the board in the checkin selector without a reload`
- テスト: `web/src/AppLayout.test.tsx::reflects a task's status change from a checkin on the task board without a reload (Issue #134)`
- 宣言元: #170

### G-170-155: 今日のタスクサマリーは当日分のみを集計し、完了と未完了をマーカーで区別する

- 種別: UI
- 領域: Web 画面
- 関連: ADR 0007
- テスト: `web/src/TodaySummary.test.tsx::lists today's tasks with a filled marker for done and an empty marker otherwise`
- テスト: `web/src/TodaySummary.test.tsx::shows a progress gauge and completion text for today's tasks`
- テスト: `web/src/TodaySummary.test.tsx::shows an empty message and 0% progress when there are no tasks for today`
- 宣言元: #170

### G-170-156: チャットは Enter 単独で送信し、Shift+Enter は改行を挿入する。IME 確定の Enter では送信されない

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/ChatView.test.tsx::sends the draft and renders the boss reply`
- テスト: `web/src/ChatView.test.tsx::sends the draft when Enter is pressed without a modifier`
- テスト: `web/src/ChatView.test.tsx::does not send the draft when Shift+Enter is pressed (newline)`
- テスト: `web/src/ChatView.test.tsx::does not send the draft when Enter confirms an IME composition`
- 宣言元: #170

### G-170-157: タスク書き込みツールの実行時はタスク名を含む専用文言の通知を出し、読み取り専用ツールではタスクの作成・更新を主張する文言を使わない

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/ChatView.test.tsx::renders a tool notice when the boss operates a task`
- テスト: `web/src/ChatView.test.tsx::does not claim a task was updated when a read-only tool (e.g. get_activity_log) runs (self-review: get_activity_log previously fell into the create_task/update_task-only notice text)`
- 宣言元: #170

### G-170-158: ストリームがエラーを報告すると読み上げ可能な警告として表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/ChatView.test.tsx::shows an alert when the stream reports an error`
- 宣言元: #170

### G-170-159: 朝会と夕会の開始でバッジが切り替わり、終了すると随時の開始ボタンへ戻る

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/ChatView.test.tsx::starts a morning session and shows the in-session badge with an end button`
- テスト: `web/src/ChatView.test.tsx::ends a morning session and returns to the adhoc start buttons`
- テスト: `web/src/ChatView.test.tsx::shows the evening badge when starting an evening session`
- 宣言元: #170

### G-170-160: 他タブへ切り替えて戻っても会話内容と未送信ドラフトが保持される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/AppLayout.test.tsx::keeps the chat conversation across a chat -> tasks -> chat round trip (Issue #93)`
- テスト: `web/src/AppLayout.test.tsx::keeps the chat draft across a chat -> tasks -> chat round trip (Issue #153)`
- 宣言元: #170

### G-170-161: 着手候補の既定選択は優先度が最も高いタスクになり、休憩中は戻る操作が主要操作になる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/CheckinPanel.test.tsx::defaults to the highest-priority task and shows break controls when not on break`
- テスト: `web/src/CheckinPanel.test.tsx::shows the return button as the primary action while on break and sends break_end`
- 宣言元: #170

### G-170-162: チェックイン操作は成功時にタスク一覧を再取得し、失敗時は読み上げ可能な警告を表示する

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/CheckinPanel.test.tsx::sends a task_start checkin with the selected task and note`
- テスト: `web/src/CheckinPanel.test.tsx::shows an error message when the checkin submission fails`
- テスト: `web/src/CheckinPanel.test.tsx::calls tasksState.refresh after a successful checkin (Issue #134)`
- 宣言元: #170

### G-170-163: 完了ボタンは着手中のタスクがある場合のみ表示され、二重クリックは防止される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/CheckinPanel.test.tsx::shows the 完了 button only when there is an in_progress task (Issue #138)`
- テスト: `web/src/CheckinPanel.test.tsx::disables the 完了 button when the selected task is todo (Issue #138)`
- テスト: `web/src/CheckinPanel.test.tsx::ignores a second 完了 click while one is in flight (double-click guard, Issue #138)`
- 宣言元: #170

### G-170-164: 当日の活動一覧に種別と時刻と関連タスク名が表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/CheckinPanel.test.tsx::renders today's activity with type, time, and task title`
- テスト: `web/src/CheckinPanel.test.tsx::shows an error message when today's activity fails to load`
- テスト: `web/src/CheckinPanel.test.tsx::renders task_pause as 一時停止 in today's activity (AC-14)`
- 宣言元: #170

### G-170-165: タスクは状態ごとのカラムに振り分けられ、移動の更新に失敗するとカードは元のカラムに残る

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/TaskBoard.test.tsx::distributes tasks into their status columns`
- テスト: `web/src/TaskBoard.test.tsx::calls editTask with the drop column's status when a card is dropped there`
- テスト: `web/src/TaskBoard.test.tsx::keeps the card in its original column and shows an alert when the drop update fails`
- 宣言元: #170

### G-170-166: タスクの追加と一覧取得の失敗は読み上げ可能な警告として表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/TaskBoard.test.tsx::calls addTask with the form input when a task is created`
- テスト: `web/src/TaskBoard.test.tsx::shows an alert when creating a task fails`
- テスト: `web/src/TaskBoard.test.tsx::shows an alert when the task list failed to load`
- 宣言元: #170

### G-170-167: 優先度と締切とボスコメントは値がある場合のみ表示される

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/TaskCard.test.tsx::shows the priority as a boss decision in Japanese`
- テスト: `web/src/TaskCard.test.tsx::hides the priority line when priority is null`
- テスト: `web/src/TaskCard.test.tsx::shows the boss comment when present`
- テスト: `web/src/TaskCard.test.tsx::hides the boss comment line when boss_comment is null`
- テスト: `web/src/TaskCard.test.tsx::shows the due date as a boss decision`
- テスト: `web/src/TaskCard.test.tsx::hides the due date line when due_at is null`
- 宣言元: #170

### G-170-168: 編集は既存値が入った状態で開始し、キャンセルで破棄され、更新失敗時は編集モードに留まる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/TaskCard.test.tsx::enters edit mode with fields pre-filled when the edit button is clicked`
- テスト: `web/src/TaskCard.test.tsx::discards edits and returns to view mode when cancel is clicked`
- テスト: `web/src/TaskCard.test.tsx::stays in edit mode when the update fails`
- 宣言元: #170

### G-170-169: タイトルが空なら作成せず、成功時はフォームをクリアし、失敗時は入力値を保持する

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/TaskForm.test.tsx::calls onCreate with the entered title when submitted`
- テスト: `web/src/TaskForm.test.tsx::does not call onCreate when the title is empty`
- テスト: `web/src/TaskForm.test.tsx::keeps the entered values when the submit fails`
- 宣言元: #170

### G-170-170: 決定が無い場合は空の案内を表示し、決定がある場合は内容と根拠と状態を表示する

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DecisionLog.test.tsx::shows an empty message when there are no decisions`
- テスト: `web/src/DecisionLog.test.tsx::shows an alert when the initial fetch fails`
- テスト: `web/src/DecisionLog.test.tsx::renders the decision content, rationale, status badge, and related task`
- 宣言元: #170

### G-170-171: 進言フォームは active な決定にのみ表示され、送信失敗時は入力を保持したままフォームが開いたままになる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/DecisionLog.test.tsx::shows an appeal form only for active decisions`
- テスト: `web/src/DecisionLog.test.tsx::submits an appeal and reflects a revised verdict (original marked revised, new decision added)`
- テスト: `web/src/DecisionLog.test.tsx::shows an alert and keeps the form open when the appeal submission fails`
- 宣言元: #170

### G-170-172: 設定は保存中に全フィールドが無効化され、成功時は反映タイミングの注記が、失敗時は入力の保持が行われる

- 種別: UI
- 領域: Web 画面
- テスト: `web/src/SettingsView.test.tsx::disables the form fields while saving so in-flight edits are not silently overwritten`
- テスト: `web/src/SettingsView.test.tsx::shows a success message and the next-effective note after a successful save`
- テスト: `web/src/SettingsView.test.tsx::shows an error message and keeps the entered values when the save fails`
- 宣言元: #170

### G-179-1: 選択中のタスクが着手中のときだけチェックインパネルに一時停止ボタンを表示する

- 種別: UI
- 領域: Web 画面
- 関連: #179
- テスト: `web/src/CheckinPanel.test.tsx::shows the 一時停止 button only when the selected task is in_progress (AC-1, G-179-1)`
- テスト: `web/src/CheckinPanel.test.tsx::does not show the 一時停止 button when a different task is in_progress but the selected task is not (AC-1, G-179-1)`
- 宣言元: #179

### G-179-4: 選択中のタスクが一時停止中のとき着手ボタンのラベルを再開にする

- 種別: UI
- 領域: Web 画面
- 関連: #179
- テスト: `web/src/CheckinPanel.test.tsx::shows 再開 as the primary button label when the selected task is paused (AC-4, G-179-4)`
- 宣言元: #179

### G-179-12: 一時停止中のタスクをタスクボードの一時停止カラムへ振り分ける

- 種別: UI
- 領域: Web 画面
- 関連: #179
- テスト: `web/src/TaskBoard.test.tsx::distributes a paused task into the 一時停止 column, next to 進行中 (AC-12, G-179-12)`
- 宣言元: #179

### G-179-14: v4 へ引き上げた DB はタスクのステータスとして一時停止中を受理する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005, #179
- テスト: `server/src/db/migrate.test.ts::accepts tasks.status = 'paused' after migrating to v4`
- 宣言元: #179

### G-179-15: v4 へ引き上げた DB は活動イベントの種別として一時停止を受理する

- 種別: DBスキーマ
- 領域: DB
- 関連: ADR 0005, #179
- テスト: `server/src/db/migrate.test.ts::accepts activity_events.type = 'task_pause' after migrating to v4`
- 宣言元: #179

## Gaps（テストのない公開面）

> **ここに書かれているのは約束ではありません。** 公開面として存在するが、テストで担保されていないものの一覧です。埋めるべき負債として扱い、Gaps の項目に依存した実装をしないでください。対応するテストが追加された時点で保証へ昇格させます。

- [ ] GAP-01: エスカレーションのリセットが task_start 以外の活動シグナル種別でも効くこと
- [ ] GAP-02: 勤務時間帯外かつ非休憩時の個別ルールごとの抑制の網羅
- [ ] GAP-03: 未着手以外のルール種別での重複送信防止とエスカレーション連携の結線
- [ ] GAP-04: スケジューラ層での勤務時間帯外と休憩中の検知停止
- [ ] GAP-05: 時間経過によるエスカレーションの L2 と L3 への昇格がスケジューラ経由で起きること
- [ ] GAP-06: 全ルール種別で一貫した rule_key が重複防止に使われること
- [ ] GAP-07: LLM 抽出失敗時のフォールバック夕会サマリが HTTP レスポンス本文に現れること
- [ ] GAP-08: 日報のタスク一覧と活動記録がレスポンス本文へ反映されることの HTTP 境界での検証
- [ ] GAP-09: 作業ログの予定分数とメモが HTTP 応答本文で固定フォーマットになること
- [ ] GAP-10: SSE イベントの順序制約そのものを跨イベントで直接検証すること
- [ ] GAP-11: 夕会の 1 日 1 回制約の並行リクエスト下での排他性
- [ ] GAP-12: 1 ターン中の複数ツール呼び出しで活動イベントが重複も欠落もしないこと
- [ ] GAP-13: 設定更新のバリデーション境界値の HTTP 経由での網羅
- [ ] GAP-14: 進言の 500 応答で返るエラーメッセージ文言の契約
- [ ] GAP-15: 催促が macOS 通知として実際に届くこと
- [ ] GAP-16: 非ストリーム経路の環境変数から ANTHROPIC_API_KEY が除外されることの直接検証
- [ ] GAP-17: claude-code 経路の再試行回数上限と最終失敗時のエラー型
- [ ] GAP-18: Web API クライアントが呼び出すエンドポイント URL 自体の検証
- [ ] GAP-19: チャットのドラフトがタブ遷移による再マウントを跨いで保持されることのフック単体での検証
- [ ] GAP-20: ダッシュボードの表情が文脈に応じて選ばれること
- [ ] GAP-21: 作業ログビューでのコピー失敗後の再試行
- [ ] GAP-22: 休憩超過などのエスカレーション表示がチェックイン画面に現れること
- [ ] GAP-23: `GET /api/activity/today` の上限境界（翌日 00:00 以降のイベントを除外すること）。`listEventsSince` は `created_at >= ?` のみで上限が無く、参照テストも前日・当日の行しか挿入していないため未担保（#172）
- [ ] GAP-24: 夕会の定時催促が勤務時間帯外・休憩申告中でも発火すること。実装（`server/src/detection/rule-engine.ts` の朝会・夕会の発火は両ゲートの外側にある）は朝会と同じ扱いだが、テストは朝会側（`fires the morning meeting rule even outside working hours and even while on break`）しか無いため、G-170-7 は朝会に限定して約束している
- [ ] GAP-25: チャットのボス返信がストリーム**途中経過**として逐次表示されること。`use-chat` の参照テストはストリーム完了後の最終状態のみを検証しており（完了時点で `streamingText` が空であることを assert）、途中経過が画面へ反映されることは未担保。G-170-117 は完了後の追加のみを約束している
- [ ] GAP-26: 通知文面の生成が**例外を投げた**発火について、その発火の通知が送信・記録されること。現在の `server/src/scheduler/scheduler-tick.ts` は `processFiring` の例外を捕捉してログするだけで、当該発火の通知は送信も記録もされない（実装の欠陥。#173 で追跡）。G-170-88 は LLM 呼び出し失敗時の定型文フォールバックと、他の発火の処理継続に限定して約束している
- [ ] GAP-27: 終了済みの当日 adhoc セッションが会話復元の対象にならないこと。`web/src/select-restore-session.ts` の `ended_at === null` フィルタは朝会・夕会にしか掛かっておらず、adhoc は終了済みでも選ばれうる（仕様確定と実装修正は #174 で追跡）。G-170-108 は朝会・夕会の未終了条件に限定して約束している
- [ ] GAP-28: 読み取り専用ツールの実行時に汎用文言の通知（「ボスがツールを実行しました」）が表示されること、およびツール失敗時に失敗文言が表示されること。`web/src/ChatView.tsx` の `toolNoticeText` は全ツールで通知を返すが、引用テストが検証しているのはタスク書き込みツールの専用文言と、読み取り専用ツールで「タスクを作成／更新しました」と誤表示しないことまで。G-170-157 はその範囲に限定して約束している
- [ ] GAP-29: `api` バックエンドにおける呼び出し全体のタイムアウト・副作用後の再試行抑止。`server/src/llm/backends/api-backend.ts` は Anthropic SDK の `timeout` / `maxRetries` に委譲するのみで `runWithTimeoutAndRetry` を通らず、`LlmTimeoutError` への変換も副作用追跡も行わない。G-170-18 / G-170-19 は claude-code 経路に限定して約束している
- [ ] GAP-30: 日報生成フックが朝会・随時セッションの終了では発火しないこと。検証テストは実在するが `it.each` でテスト名が動的生成されており台帳から参照できない（本台帳の参照形式の限界。HR-05 参照）。G-170-37 は夕会の初回発火と再終了時の非再発火に限定して約束している
- [ ] GAP-31: タスク更新で `updated_at` の値が実際に更新されること。参照テストは `updated_at` が非空文字列であることと `created_at` が不変であることのみを検証しており、更新前後の値の変化は比較していない。G-170-67 はその範囲に限定して約束している
- [ ] GAP-33: セッション種別の**受理**側（`morning` / `evening` / `adhoc` がそれぞれ受理されること）。検証テストは `server/src/sessions/sessions-validation.test.ts` に実在するが `it.each("accepts a valid type: %s")` でテスト名が動的生成され台帳から参照できない（HR-05）。G-170-39 は**拒否側**に限定して約束している
- [ ] GAP-34: タスク API のバリデーションのうち、**`status` / `priority` の不正値**（作成・更新の両方）。検証テストは `server/src/tasks/tasks-routes.test.ts` に実在するが、`returns 400 when status is invalid` / `returns 400 when priority is invalid` という**同名のテストが作成側と更新側の両方に存在**し、参照形式 `<パス>::<テスト名>` では一意に指せない。あわせて、列挙していないフィールド（`due_at` の形式・`boss_comment` の型など）の不正値も未検証。G-170-66 / G-170-68 は**一意に参照でき、かつ検証済みのケースだけを列挙**して約束している
- [ ] GAP-32: 日報の完了欄・進行中欄が**対象外ステータス**を除外すること（`completed_at` が当日でも todo / in_progress / dropped は完了欄に入らない、`task_start` が当日でも todo / done / dropped は進行中欄に入らない）。検証テストは `server/src/reports/collect-daily-report-data.test.ts` に実在するが `it.each` でテスト名が動的生成されており台帳から参照できない（HR-05）。**参照できない以上、この排他性は台帳の約束としては未担保**であり、対象外ステータスのテストを削除しても索引ゲートは通る。G-170-54 は日付による包含・除外に限定して約束している
- [ ] GAP-35: サイドパネル「今日のタスク」（`web/src/today-tasks.ts`）が一時停止中（`paused`）のタスクを対象外にすること。`paused` はタスク編集フォームやタスクボードのカラム移動から到達可能な公開状態だが、`selectTodayTasks` の `paused` 分岐にはテストが無く（G-170-112 は todo/in_progress/done/dropped の包含・除外のみを約束）、`paused` を対象へ含めるかどうかの方針自体は #187 の担当

## 要人間判定（本台帳への採否を保留した項目）

- **HR-01: FR-06「多層方式」の実効性** — 退役した `claude-code-backend.md` の FR-06 は許可判定の多層方式を謳っていたが、許可リストに載るアプリ定義ツールについては**実質単層**であることが Issue #166 で判明している。台帳には**実挙動どおりの約束**（G-170-13 / G-170-14: 未許可ツールを拒否する）のみを載せ、「多層である」ことは保証として載せていない。意図と実挙動の差は [ADR 0003](./adr/0003-llm-backend-isolation.md) の「既知の逸脱」に記録した。#166 の対応後、この項目の再判定が必要。
- **HR-02: ボスのツール群（`server/src/boss/*-tool.ts`）の扱い** — LLM エージェントのみが呼ぶツールの入力検証・DB 永続化を公開面とみなすかは判断が割れる。本台帳では「ユーザーが画面で観測できる結果」（タスクが作成される・決定が記録される）を各 API・画面の保証で担保しているとみなし、ツール単体の振る舞いは載せていない。ツールを外部へ公開する場合は再判定が必要。
- **HR-03: 人格プロンプトの内容** — システムプロンプトの文言（口調・厳しさの表現）を固定するテストが存在するが、ユーザーが観測するのは最終的なボスの発話であり、プロンプト文言は中間表現と判断して載せていない。人格の一貫性を製品保証にする場合は再判定が必要。
- **HR-05: `it.each` のテストは台帳から参照できない** — テスト名が実行時に組み立てられる（`it.each` / テンプレートリテラル）テストは、参照形式 `<パス>::<テスト名>` で静的に指せないため台帳へ引用できない。**コードとしては検証されているのに台帳からは「担保されていない」ように見える**箇所が生じる。既知の該当例: 列挙値カラムの**受理**側（`accepts tasks.status = %s` 等 6 カラム分。G-170-79 は拒否側のみを約束）、日報の対象外ステータス除外（G-170-54 / GAP-32）、日報生成フックの朝会・随時での非発火（G-170-37 / GAP-30）。解消するにはテスト側を個別の `it()` へ分割するか、参照形式に動的名を扱う仕組みが要る。
  **本項に記録することは解決ではない。** 参照できないテストは索引ゲートの検査対象外であり、削除されても `broken` にならないため、**台帳の約束としては未担保**である。したがって該当する約束文は引用が担保する範囲まで狭め、こぼれた排他性は **Gaps として立てる**（GAP-30 / GAP-32 がその実例）。本項は「なぜテストがあるのに Gap なのか」を説明するための記録であり、**約束を広いまま置く根拠にはしない**。
- **HR-04: 内部レースガードの扱い** — フックの stale-response ガード・二重送信ガードは、ユーザーから見れば「操作が壊れない」という約束だが、実装の防御策としての性格が強いため原則載せていない。ただし G-170-121 / G-170-124 / G-170-163 のように明示的な受入基準があるものは保証として載せている。
