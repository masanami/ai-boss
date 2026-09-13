# 着手の約束を保存し、約束の時刻を過ぎても未着手ならボスが催促する

> **正はコードとテスト**であり、本ファイルは権威を持たない（`CLAUDE.md`「開発方針」）。実装と食い違う場合はコードが正。
>
> 対象 Issue: #510
>
> 方向（案 A）と論点 A1〜A6 はプロダクトオーナーが、設計論点 B1〜B6 は意思決定者（親エージェント）が、いずれも 2026-09-13 に決定した。勤務時間外・休憩中の催促の出し方（決定 4 の 6・7）は、同日にプロダクトオーナーへ追加で確認した回答で確定した。最優先タスクを繰り下げない（決定 4 の 5）は本仕様の解釈を親が承認した。

## 概要

ボスとの会話で決めた「このタスクは何時から着手する」を**着手の約束**としてタスクに保存し、約束の時刻を過ぎても着手していなければ、既存の段階的な催促に乗せてボスが催促する。約束を持つタスクには、作成時刻を起点とする未着手・回避の催促を出さない。約束の時刻はタスクカードに 1 行で表示する。

## 背景・目的

### 方向（プロダクトオーナーが 2026-09-13 に確定・案 A）

当日スケジュールは「見える化」のためではなく、**着手の約束（時間枠）を保存し、約束の時刻を過ぎても未着手ならボスが催促する**ために持つ。見るだけのタイムライン（案 B）は主目的にせず、表示は約束を見せる手段として従属させる。

### 何が欠けているか

ボスと「20 時から構成 30 分」と決めても、その時刻はどこにも構造化して保存されない。

- タスクが持つ時間の情報は `estimated_minutes`（所要時間）と `due_at`（締切の**暦日**）だけで、着手時刻を持つ列は無い（`server/src/tasks/task.ts`）。`due_at` は ADR 0010 で暦日に一本化されており、時刻を載せる器ではない
- ボスの決定は `record_decision` で `decisions.content`（自由文）に残るだけで、時刻を構造化して持つ列は無い（`server/src/boss/decision-tool.ts`・`server/src/decisions/decision.ts`）
- 未着手検知は**タスク作成時刻 `created_at` からの経過**でしか判定しない（`server/src/detection/unstarted.ts`）。「20 時と約束したのに 20 時を過ぎても手を付けていない」を起点にできず、逆に「20 時からと約束したタスクに 15 時の時点で未着手の催促が来る」ことも起きうる

### 観測（2026-09-13 のデモ・親エージェントが実ブラウザで観測。Issue #510 本文より・本仕様では未検証）

タスク 2 件でメンタリングしただけでも、ボスの返信・決定は時間配分に集中した（「構成30分＋本文執筆120分、9/14午前に本文」「経費精算は明日9/14夕方に15分」「現時点で19時台のため今日中の構成決定を確実に今夜こなす」）。時刻の話はメンタリングの相談（19 時台）で出ており、翌日の約束も含まれていた。

### 現状の確証（`62edbe4` の実コード。`64ed191` までの差分は docs と `web/src/TaskBoard.css` のみで、以下に影響しない）

| # | 事実 | 根拠 |
|---|---|---|
| C1 | 未着手検知は `status === "todo"` かつ `created_at` からの経過が閾値以上で真。閾値は `estimated_minutes × scale` を `min`〜`max` にクランプ、`estimated_minutes` が `null` なら `fallback`（既定 `scale: 1.0, min: 15, max: 120, fallback: 60`） | `server/src/detection/unstarted.ts`・`server/src/detection/detection-types.ts` の `DEFAULT_DETECTION_SETTINGS` |
| C2 | 未着手・回避の判定対象は「最優先タスク」1 件だけ。最優先は `todo`/`in_progress` の中から priority → `due_at` → id の順で決まる | `server/src/detection/rule-engine.ts` の `evaluateRules`・`server/src/detection/priority.ts` の `pickTopPriorityTask` |
| C3 | 最優先タスクが未着手のとき、直近 30 分に他タスクへの `task_start`/`task_update` があれば「回避」、無ければ「未着手」のどちらか一方だけが発火する | `server/src/detection/rule-engine.ts`・`server/src/detection/avoidance.ts` |
| C4 | 締切超過は最優先に限らず該当タスクすべてをループで評価し、`deadline_overdue:{taskId}` で発火する | `server/src/detection/rule-engine.ts`・`server/src/detection/deadline-overdue.ts` |
| C5 | エスカレーションは `rule_key` 単位。履歴が無ければ L1、**前回通知より後に活動シグナル（全種）が 1 件でもあれば L1 にリセットして即発火**、それ以外はレベル別間隔（既定 15/10/10 分）経過で次のレベル、L3 で頭打ち。スケジューラは履歴を全期間読む | `server/src/detection/escalation.ts` の `resolveEscalation`・`server/src/scheduler/scheduler-tick.ts` |
| C6 | 勤務時間帯外は朝会・夕会の定時催促以外の全ルールが停止し、休憩申告中は休憩延伸と朝会・夕会以外が停止する。朝会・夕会の定時催促は両ゲートの外で評価され、`rule_key` に日付を含むため暦日ごとにリセットされる | `server/src/detection/rule-engine.ts`・`server/src/detection/meeting.ts`・`docs/adr/0004-deterministic-detection-engine.md` 決定 6 |
| C7 | 所要時間見積もりの「ボス提案 → ユーザー確認」はプロンプト指示だけで実現しており、確認済みを表すフラグは無い。確認の指示 `TASK_ESTIMATE_CONFIRMATION_INSTRUCTION` は会の種別を問わず通常チャットに積まれる | `server/src/boss/persona-prompt.ts` の `buildPersonaPrompt` |
| C8 | 朝会フロー指示に、着手時刻・時間配分を決める指示は無い | `server/src/boss/persona-prompt.ts` の `MORNING_FLOW_INSTRUCTION` |
| C9 | ボスに渡すタスク一覧の各行は状態・id・タイトル・優先度・エビデンス・締切だけで、`estimated_minutes` を含まない | `server/src/boss/persona-prompt.ts` の `formatTaskLine` |
| C10 | web の画面はどこにも `estimated_minutes` を表示しない。タスクカードは締切を「ボス決定: 締切 YYYY-MM-DD」の 1 行で表示する | `web/src/TaskCard.tsx` |
| C11 | ボスのタスク操作は `create_task`/`update_task` の 2 ツールで、HTTP 層と同じ検証（`validateCreateTaskInput`/`validatePatchTaskInput`）を通る。ツールの説明文は `claude-code-backend.ts` の Zod shape と**意図的に二重に**書かれ、テストが一致を検証している | `server/src/boss/task-tools.ts`・`server/src/llm/backends/claude-code-backend.ts` |
| C12 | タスクの更新（`PATCH /api/tasks/:id` と `update_task` の共通層 `updateTask`）は、フィールドを 1 つでも含めば同一トランザクションで `task_update` 活動イベントを記録する。値の変更前後を `note` に残す前例がある（エビデンス要否） | `server/src/tasks/tasks-repository.ts` の `updateTask`・`buildEvidenceRequiredChangeNote` |
| C13 | `notifications.type` に CHECK 制約は無い（新しいルール種別の追加にマイグレーションは不要）。通知文面側の `RULE_TYPES`・ラベル・フォールバック定型文は種別ごとに列挙されており、文面生成の依頼に渡るのはタスク名・種別・レベルだけ（時刻は渡らない）。ただし依頼の組み立てには `Task` 行がそのまま渡っている | `server/src/db/migrate.ts`（version 1 の `notifications`）・`server/src/notifications/notification-body.ts`・`server/src/scheduler/rule-type-mapping.ts`・`server/src/scheduler/scheduler-tick.ts` の `processFiring` |
| C14 | 通常チャット・通知文面・会の開始発言のプロンプトには、現在日時がオフセット付き ISO で入る（ボスは現在時刻とオフセットを知っている） | `server/src/boss/persona-prompt.ts` の `formatCurrentDateTimeSection`・`server/src/sessions/chat-messages-route.ts` |

### Issue 本文と実コードの食い違い

- `docs/features/ai-boss-mvp.md` は存在しない（`faa4f00`・#170 で退役）。検知の抑制条件の正本は ADR 0004 決定 6 であり、本仕様はそれを改訂する（決定 4）
- 「一日の時間軸の上でどう並ぶかは見えない」は事実だが、そもそも所要時間の見積もりすら画面にもボスの文脈にも出ていない（C9・C10）。本仕様はこれを直さない（「やらないこと」）

## 前提（関連する未実装の課題）

- **稼働時間は連続 1 区間のまま**とする。中抜け・副業などのフレキシブルな勤務時間（#440・`docs/features/working-hours-intervals.md`）は未実装である。本機能は、約束の催促を勤務時間ゲートに依存させない（決定 4）ことで、#440 が未実装でも成立する
- **朝会・夕会の時刻は設定値のまま**とする。当日限りの会の時刻（#258、実装 #432〜#434）は未実装である

## ユーザーストーリー

ボスとの会話で「何時から何をやる」を決めたオーナーとして、決めた時刻を過ぎても手を付けていなければ、勤務時間の設定にかかわらずボスに催促されたい。自分の意志に頼らず、決めたとおりに着手できるようにするためである。

## 機能要件

- [ ] タスクは着手の約束（その日時から着手すると約束した瞬時）を 0 件または 1 件持てる
- [ ] 着手の約束は、翌日以降の日時も保存できる
- [ ] 着手の約束は変更・取り消しができ、変更の前後がタスクの更新記録に残る
- [ ] タスクのステータスが `todo` 以外へ変わると、着手の約束は退役する（消え、更新記録に残る）
- [ ] 退役した約束は、後でタスクを `todo` に戻しても復活しない
- [ ] 着手の約束を持てるのは、ステータスが `todo` のタスクだけである（`todo` 以外のタスクに約束を置こうとする要求は拒否される）
- [ ] ボスは、どの会話（朝会・夕会・随時）でも、着手の約束を提案してオーナーの確認を得てから保存するよう指示される
- [ ] 着手の約束を持つ未着手のタスクは、最優先かどうかにかかわらず、約束の時刻ちょうどから催促の対象になる
- [ ] 約束の催促は既存の段階的なエスカレーション（L1 → L2 → L3）に従う
- [ ] 着手の約束を持つタスクには、作成時刻を起点とする未着手の催促と回避の催促を出さない
- [ ] 着手の約束を持たないタスクの未着手・回避の検知は、従来どおり作成時刻を起点に動く
- [ ] 約束の催促は、勤務時間帯外でも、その約束についてまだ 1 度も通知していなければ 1 回だけ出る（段階を上げない）
- [ ] 約束の催促は時刻の経過では失効せず、未着手のまま次の勤務時間帯に入れば段階的な催促に戻る
- [ ] 約束の催促は、休憩申告中も出る（勤務時間帯外の休憩中は 1 回だけ）
- [ ] 約束の催促の通知文面は、約束の時刻を踏まえて生成される
- [ ] ボスは会話中、各タスクの着手の約束を知っている（ボスに渡すタスク一覧に載る）
- [ ] オーナーはタスクカードで、着手の約束の日時を確認できる

## 技術的な制約・方針

- **ローカル完結**（ADR 0001）。外部カレンダー連携はしない
- **検知は純粋関数のまま**（ADR 0004 決定 2・3）。約束の判定に LLM を使わない
- **`due_at` を使わない・変えない**。着手の約束は締切とは別の概念として別の列で持つ（ADR 0010 帰結）
- **テストの固定時刻はローカル日時（`new Date(y, m, d, h, min)`）から導出し、TZ 非依存に組む**（ADR 0007 決定 5）。勤務時間帯の判定とタスクカードの表示はローカル時刻に依存するため `npm run test:tz` も通す（同 決定 6）。判定は `main` のベースラインとの差分で行う（本リポジトリには特定のタイムゾーンでだけ失敗する既存のテストがあるための、本仕様の運用。`docs/features/working-hours-intervals.md` と同じ扱い）
- テストでは Claude API・現在時刻・macOS 通知コマンドをモックし、SQLite はモックしない
- **マイグレーションの version 番号は予約しない**。実装時点で `server/src/db/migrate.ts` にある最新 version の次を使う（#432 の仕様が version 9 を前提にしているが、先にマージされた方が番号を取り、後続が付け替える。既存 version は書き換えない＝ADR 0005 決定 4）

## クリティカル設計決定

### 決定 1: 着手の約束は `tasks.committed_start_at` と `tasks.committed_at` の 2 列で持つ（DB スキーマ）

- **採用案**: `tasks` に `committed_start_at TEXT` と `committed_at TEXT`（いずれも NULL 許容・既定なし）を、同じマイグレーション version の `ALTER TABLE ... ADD COLUMN` で追加する。既存行はすべて両列とも `NULL` になる
  - `committed_start_at` は約束の日時（決定 2）。`NULL` は「約束なし」。1 タスクにつき約束は 0 件または 1 件
  - `committed_at` は**その約束を置いた時刻**（UTC ISO。`updated_at` と同じ形）で、約束のインスタンスを識別する。`committed_start_at` が `NULL` から値へ、または別の値へ変わる更新（作成時に約束を置く場合を含む）で、その更新の時刻（`updated_at` と同じ値）を書く。`committed_start_at` の値が変わらない更新では書き換えない。約束の取り消し・退役（決定 3-2）では `committed_start_at` と一緒に `NULL` にする
  - 不変条件: `committed_start_at` と `committed_at` は、両方 `NULL` か両方非 `NULL` のどちらかである
  - `committed_at` は API の応答の `Task` に含めるが、入力としては受け付けない（送られても無視する）。ボスに渡すタスク一覧・タスクカード・`note` には出さない
- **理由**: 1 タスク 1 約束（A3 件数 (b)）にそのまま合い、`Task` 型・検証・`updateTask`・`formatTaskLine`・タスクカードという既に通っている経路へ 1 フィールド足すだけで済む。`updateTask` の共通層を通るため `task_update` イベントも自動で残る（C12）。テーブル再構築を伴わないため `PRAGMA foreign_keys` の切り替えも要らない
- **`committed_at` を持つ理由**: 通知履歴は `rule_key` 単位で読まれる（C5）。`rule_key` を約束の時刻だけで作ると、約束を 20:00 → 21:00 → 20:00 と戻したとき最初の約束の通知履歴と衝突し、勤務時間外の 1 回（決定 4 の 6）が出なくなる（Codex レビュー指摘）。置いた時刻を `rule_key` に含めれば、同じ時刻へ戻した約束も別のインスタンスとして扱える
- **代替案**: 新テーブル `task_start_commitments`（1 タスク複数枠・履歴） — 却下。複数枠・履歴を使う要件が無い（YAGNI）。検知入力とタスク API の組み立てが増える。約束の世代番号（整数のカウンタ）を持つ — 却下。時刻なら更新記録（`task_update` イベント）と突き合わせて読め、既存の `updated_at` と同じ値を書くだけで済む
- **影響範囲**: `server/src/db/migrate.ts`（新 version）、`server/src/tasks/task.ts`・`tasks-repository.ts`・`tasks-validation.ts`、`web/src/task.ts`

### 決定 2: 保存形式はオフセット付き ISO 8601 の日時で受け付け、UTC ISO に正規化して保存する

- **採用案**:
  - `POST /api/tasks`・`PATCH /api/tasks/:id`（およびそれを通る `create_task`/`update_task`）は `committed_start_at` に、**時刻とオフセット（`Z` または `±HH:MM`）を含む ISO 8601 の日時文字列**、または `null` を受け付ける
  - 受け付けた値は `new Date(value).toISOString()` の形（例: `2026-09-14T11:00:00.000Z`）に正規化して保存し、API もその形で返す
  - 次は 400 で拒否し、何も書き込まない: 時刻のみ（`"20:00"`）、日付のみ（`"2026-09-14"`）、オフセット無しの日時（`"2026-09-14T20:00"`）、暦として実在しない日時（`"2026-02-30T10:00:00+09:00"`）、日時として解釈できない文字列、文字列でも `null` でもない値
  - 過去の日時は拒否しない（決め直しの途中で過ぎた時刻を置く・記録として残すことを妨げない）
  - **`new Date(value)` が有効な日時を返すことだけでは検査にならない**。2026-09-13 に Node で確認したところ、`new Date("2026-02-30T10:00:00+09:00")` は 3 月 2 日に繰り上げて有効な日時を返し、`"2026-09-14T20:00"` と `"2026-09-14"` も有効な日時を返した。書式（時刻とオフセットの有無）と暦の実在は別に検査する
- **理由**: 書き手はボス（LLM）であり、ボスは現在日時をオフセット付きで受け取っている（C14）。オフセット無しの値はサーバの TZ で解釈が変わり、ADR 0007 が避けてきた「解釈を各所に散らす」形になる。`due_at` が時刻付きの値を「受理して暦日へ落とす」を選んだ理由（ADR 0010 決定 4）は旧形式の既存データがあったためで、新しい列には当たらない。拒否すればツール結果の文言でボスが言い直せる
- **代替案**: 当日の `HH:mm` だけを受け付ける — 却下（翌日以降の約束〔A3 日付 (y)〕を表現できない）。オフセット無しのローカル日時 — 却下（上記）
- **影響範囲**: `server/src/tasks/tasks-validation.ts`（検証と正規化）、`server/src/tasks/tasks-routes.ts` のテスト

### 決定 3: 約束の変更は上書きし、変更の前後を `task_update` の `note` に残す

- **採用案**: `committed_start_at` の値が変わる更新（未設定 → 設定・変更・取り消し）では、`updateTask` が記録する `task_update` イベントの `note` に変更前と変更後の値を残す（エビデンス要否の `buildEvidenceRequiredChangeNote` と同形。値が変わらない更新では残さない）。後ろ倒しの回数・幅は制限しない（A6 (a)）
- **理由**: 既存の前例に揃え、新しいイベント種別・履歴テーブルを足さない。ボスは変更の裁定を既存の応答規律どおり `record_decision` で記録する
- **代替案**: 履歴テーブル — 却下（決定 1 の代替案と同じ）。痕跡を残さない — 却下（A6 (a) は「変更は記録に残る」を前提に決まった）
- **影響範囲**: `server/src/tasks/tasks-repository.ts`。**`note` は現状エビデンス要否の変更だけが書く。1 回の更新で両方が変わる場合は両方を 1 つの `note` に含める**

### 決定 3-2: 約束は `todo` のタスクにだけ置ける。`todo` 以外への変更で退役させ、`todo` 以外のタスクへの設定は 400 で拒否する

- **不変条件**: **`committed_start_at` が非 `NULL` なら、そのタスクの `status` は `todo` である。** 以下の退役と拒否の 2 つで、どの経路からもこれを破れないようにする
- **採用案（退役）**:
  - `updateTask` で**ステータスが変わり、変更後のステータスが `todo` 以外（`in_progress`・`paused`・`done`・`dropped`）になる更新**では、約束を持っていれば同じ更新で `committed_start_at` と `committed_at` を `NULL` にする（退役）。遷移元は問わない（`todo` からに限らない）
  - 退役したとき、決定 3 の `note` に「約束の退役（ステータス変更による）」と、決定 3 と同じ前後の対（変更前の値と、変更後の値 `null`）を残す。同じ更新でエビデンス要否も変わった場合は、決定 3 のとおり 1 つの `note` に両方を含める
  - エビデンス強制のゲートで拒否された更新（何も書き込まれない。C12）では退役しない
  - ステータスが変わらない更新（タイトルだけの変更など）と、変更後が `todo` になる更新では退役しない
  - `todo` に戻したタスクは約束を持たないため、未着手検知は `created_at` 起点に戻る（決定 4 の 5 の抑止も外れる）。新しい約束が要ればボスと決め直す
- **採用案（拒否）**:
  - **更新後のステータスが `todo` でないタスクに、`committed_start_at` の非 `NULL` の値を設定する要求は 400 で拒否し、何も書き込まない**（`task_update` イベントも記録しない）。「更新後のステータス」は、要求に `status` があればその値、無ければ既存の値である。したがって次の 3 つがいずれも 400 になる
    1. `in_progress`・`paused`・`done`・`dropped` のタスクへ、`status` を含めずに `committed_start_at` を送る `PATCH` / `update_task`
    2. `status` に `todo` 以外の値と `committed_start_at` を同時に送る `PATCH` / `update_task`（遷移元が `todo` でも同じ）
    3. `status` に `todo` 以外の値と `committed_start_at` を同時に送る `POST /api/tasks` / `create_task`
  - `todo` 以外のタスクへ `status: "todo"` と `committed_start_at` を同時に送る要求は、更新後が `todo` なので受け付ける
  - `committed_start_at: null` は、タスクのステータスにかかわらず受け付ける（不変条件を破らない）
  - 拒否の応答は既存のタスク API の作法に揃え、`{ error, code: "commitment_requires_todo" }` と 400 を返す。`update_task` ツールは `isError: true` で理由の文言を返す（ボスがツール結果を見て言い直せる）
  - 判定は形式の検証（決定 2）の後、エビデンス強制のゲートより前に置く（どちらも何も書き込まない拒否であり、入力の誤りを先に返す）
- **ステータスが変わる経路（実コードで洗い出した）**: いずれも `server/src/tasks/tasks-repository.ts` の `updateTask` を通る。
  1. `PATCH /api/tasks/:id`（`server/src/tasks/tasks-routes.ts`。web のタスクボードのドラッグ＆ドロップとステータス選択はどちらも `web/src/tasks-api.ts` の `patchTask` 経由でここに来る）
  2. チェックインの `task_start`（`todo`/`paused` → `in_progress`）と `task_pause`（`in_progress` → `paused`）（`server/src/activity/checkins-routes.ts` が `updateTask` を呼ぶ）
  3. ボスの `update_task` ツール（`server/src/boss/task-tools.ts` が `updateTask` を呼ぶ）

  作成（`POST /api/tasks` と `create_task`）は `insertTask` を通る。**退役と拒否は経路ごとに書き分けず、全経路が共有する層に置く**: 退役と更新時の拒否は `updateTask`（更新後のステータスの判定に既存の行が要る）、作成時の拒否は作成の検証（`validateCreateTaskInput`。要求の `status` だけで決まる。`status` 省略時は `todo`）。経路側に置くと、新しい経路を足したときに漏れるため。チェックインの経路は `committed_start_at` を送らないので、拒否には当たらず退役だけが効く
- **理由**:
  - 約束は「未着手のタスクをいつ始めるか」であり、着手・一時停止・完了・取り下げのいずれかでステータスが `todo` を離れた時点で役目を終える。残すと、着手して約束を果たした後に `todo` へ戻したタスクへ、果たした約束について誤って催促する（Codex レビュー指摘）。遷移元を `todo` に限らないのは、`paused` のタスクに残った約束が `in_progress` を経て `todo` に戻る場合にも同じ誤催促が起きるため
  - 退役だけでは、既に `todo` 以外のタスクへ約束を後から置く要求（ステータスが変わらないので退役しない）を塞げず、後で `todo` へ戻したとき、未着手でもなかった時点の約束で誤って催促する（Codex 再レビュー指摘）。黙って捨てるとボスとオーナーの意図が消えるため、親の決定により 400 で拒否してボスに言い直させる
  - 作成時の扱いも拒否に揃えた（前版は「`NULL` で保存」）。更新時と作成時で「`todo` 以外のタスクに約束を置く要求」の結果が違うと、同じ要求をボスが `create_task` と `update_task` のどちらで送ったかで、約束が黙って消えるかどうかが変わるため
- **代替案**:
  - 退役させず、`commitment_missed` の判定で「約束の時刻より後に `task_start` があれば対象外」とする — 却下。活動履歴の読み方を検知側に足すことになり、`todo` に戻したタスクの約束が画面とボスの文脈に残り続ける
  - `todo` 以外のタスクへの約束の設定を受け付けて `NULL` で保存する（黙って捨てる） — 却下。ボスは保存できたと受け取り、オーナーに約束が成立したと伝えてしまう
  - 経路（ルートハンドラ・ツール）ごとに退役・拒否を書く — 却下（上記の漏れ）
- **影響範囲**: `server/src/tasks/tasks-repository.ts`（`updateTask` の退役・拒否・`note` の組み立て、`insertTask` の `committed_at`）、`server/src/tasks/tasks-validation.ts`（作成時の拒否）、`server/src/tasks/tasks-routes.ts`（`commitment_requires_todo` の 400）、`server/src/boss/task-tools.ts`（拒否の文言）

### 決定 4: 約束の催促は新ルール `commitment_missed` とし、全タスクを評価して勤務時間ゲート・休憩ゲートの例外に置く（ADR 0004 決定 6 の改訂）

- **採用案**:
  1. **発火条件**: `status === "todo"` かつ `committed_start_at` が非 `NULL` かつ `now >= committed_start_at`（猶予 0 分）。`in_progress`・`paused`・`done`・`dropped` は対象外（未着手の定義 C1 と揃える）
  2. **評価対象**: 最優先かどうかにかかわらず、条件を満たすタスクすべてをループで評価する（締切超過 C4 と同形）
  3. **`rule_key`**: `commitment_missed:{taskId}:{committed_start_at}:{committed_at}`（どちらも保存された文字列そのまま）。約束を置き直すと（別の時刻へ変えた場合も、元と同じ時刻へ戻した場合も）`committed_at` が変わって別の `rule_key` になり、それまでの約束の通知履歴を引き継がない
  4. **勤務時間帯内のエスカレーション**: 勤務時間帯内では、既存の `resolveEscalation` をそのまま通す（L1 → L2 → L3）。したがって「前回通知より後に活動シグナルが 1 件でもあれば L1 にリセットして即発火する」挙動（C5）も**継承する**
  5. **未着手・回避との関係**: `pickTopPriorityTask` が選んだ最優先タスクが `committed_start_at` を持つとき、`unstarted` と `avoidance` を評価しない（約束の時刻の前後を問わない）。**最優先タスクの選び方は変えず、次点のタスクへ繰り下げて評価することもしない**
  6. **勤務時間帯外は約束 1 件につき 1 回だけ**: `commitment_missed` は勤務時間帯外でも評価する。ただし勤務時間帯外では、**その `rule_key` の通知履歴が 1 件も無いときだけ** L1 で発火し、`resolveEscalation` を通さない（段階を上げない・活動シグナルによる再発火もしない）。勤務時間帯内に既に通知済みの約束は、勤務時間帯外では発火しない。約束は時刻の経過では失効しない（退役するのは決定 3-2 のステータス変更のときだけ）ため、未着手のまま次の勤務時間帯に入れば 4 の段階的な催促に戻る（前回通知の後に活動シグナルが無ければ、勤務時間帯に入った最初の評価で次の段階になる）。約束の暦日による区切りは設けない
  7. **休憩ゲート**: `commitment_missed` は休憩申告中も評価する。勤務時間帯内の休憩中は 4 に、勤務時間帯外の休憩中は 6 に従う
  8. `silence`・`deadline_overdue`・`break_overrun`・朝会・夕会の各ルールは変えない
- **理由**:
  - 1〜4 は B4 の回答どおり。3 により、リスケした約束は新しい段階の列として L1 から始まり、勤務時間帯外の「1 回」の枠もリセットされる。`committed_at` を含めるのは親の決定（Codex 再レビュー指摘への対応。決定 1）
  - 5 の「約束の前後を問わない」は B4 の回答（約束前は催促せず、約束後は新ルールに一本化）の直訳。「次点へ繰り下げない」は本仕様の解釈で、親が承認した。繰り下げると、約束したタスク A に取り組んでいる間に、次点のタスク B に対して「他のタスク（A）に活動がある」として回避の催促が出る
  - 6 はプロダクトオーナーの 2026-09-13 の回答（勤務時間外は 1 回だけ・段階を上げるのは勤務時間内だけ）どおり。「勤務時間帯内に通知済みなら時間外は黙る」は、同回答の具体化として親の推奨を採った。時間外の 1 回は「約束の時刻が来たことを知らせる」ためのもので、勤務時間帯内に既に知らせた約束へ、終業後にもう一度知らせる理由が無い
  - **暦日の区切りを外した理由**: 区切りを置いたのは、「失効させない」と合わさって L3 が一晩中続くのを止めるためだった。時間外の通知が約束 1 件につき 1 回に限られた時点でその問題は起きない。残すと、区切りの境界規則と `npm run test:tz` の対象になる暦日判定が増える一方で、防げるのは「約束の暦日を過ぎてから初めて評価される」とき（サーバがその間止まっていた・過去の日時で約束を置いた）の 1 回だけになる。その 1 回は、約束の時刻を過ぎて未着手であることを初めて知らせる通知として妥当である
  - 7 はプロダクトオーナーの回答（休憩中も出す・時間外の休憩中は 1 回に従う）どおり。勤務時間帯外は休憩延伸検知も止まっているため、休憩ゲートを当てると閉じ忘れた休憩 1 件で夜の約束の催促が無言で消える
- **代替案**:
  - 未着手ルールの起点だけを約束時刻へ差し替える — 却下。最優先でないタスクの約束を見ない（A3 件数 (b) に反する）
  - 最優先タスクの選び方に約束を反映する — 却下。回避の判定対象まで巻き込んで変わり、約束を過ぎたタスクが複数あると 1 件しか見ない
  - 勤務時間帯外も段階的に催促し、約束の暦日のうちだけ評価する（本仕様の前版の解釈） — 却下。オーナーが 2026-09-13 に「勤務時間外は 1 回だけ」とした
  - 勤務時間帯外の 1 回を「勤務時間帯外にまだ通知していないとき」とする（勤務時間帯内に通知済みでも終業後にもう 1 回出す） — 却下。上記のとおり、既に知らせた約束へ終業後に重ねて知らせる理由が無い
  - 休憩ゲートを当てる — 却下（上記の無言の停止）
- **影響範囲**: `server/src/detection/`（新しい判定関数・`rule-engine.ts`・`detection-types.ts` の `DETECTION_RULE_TYPES`）、`server/src/scheduler/rule-type-mapping.ts`。**ADR 0004 に改訂節を追記した**（`docs/adr/0004-deterministic-detection-engine.md`「改訂（2026-09-13）」）

### 決定 5: 通知文面の生成に約束の時刻を渡す

- **採用案**: 通知文面側の `RULE_TYPES` に `commitment_missed` を加え、ラベル（例: 「約束の時刻を過ぎても未着手」）と L1〜L3 のフォールバック定型文を用意する。`commitment_missed` の文面生成の依頼には、対象タスクの約束の時刻をローカルの日時（`YYYY-MM-DD HH:mm`）で含める。スケジューラは既に `Task` 行を依頼に渡している（C13）ため、`processFiring` の変更は要らない
- **理由**: 時刻が渡らないと、文面が「未着手」と区別のつかない一般的な催促になり、「約束を破った」ことが伝わらない
- **影響範囲**: `server/src/notifications/notification-body.ts`

### 決定 6: ボスへの露出はツールの入力・確認の指示・タスク一覧の 1 項目に限る

- **採用案**:
  - `create_task`・`update_task` の入力に `committed_start_at` を加える。説明文に保存形式（時刻とオフセットを含む ISO 8601 の日時、例 `2026-09-14T20:00:00+09:00`）を明示し、`update_task` には「`null` で取り消す」も明示する。`claude-code-backend.ts` の Zod shape と同じ文言を二重に書く（C11。一致テストを保つ）
  - **`update_task` の `committed_start_at` は、JSON Schema（`task-tools.ts`）と Zod shape（`claude-code-backend.ts`）の両方で `null` を受け付ける**。約束の編集 UI を置かない（決定 7）ため、オーナーが約束の取り消しを頼んだときの製品上の経路はボスの `update_task` だけであり、どちらかの定義が `null` を弾くと、そのバックエンドでは約束を取り消せなくなる（Codex レビュー 3 回目の指摘）。2 つの定義は許容値を別々に持つため、両方を個別に検査する。`create_task` の `committed_start_at` は値のみとする（作成時に取り消す約束は無い）
  - 「着手の約束はボスが提案し、ユーザーが確認（同意または修正）した日時だけを保存する」指示を、見積もりの確認指示と同じく会の種別を問わず通常チャットに積む（A1 (b)）。**確認の担保はこの指示だけ**とし、機械的なゲートは置かない（見積もりと同じ。C7）
  - `formatTaskLine` は、約束を持つタスクの行にだけ約束の日時を載せる
  - `estimated_minutes` をタスク一覧に載せることは本仕様に含めない
- **理由**: A1 (b)・B6 の回答どおり。ADR 0009 が「プロンプト指示だけでは強制にならない」とした領域とは違い、ここで担保したいのは「勝手に約束を作らない」ことである。ADR 0010 の実測では、ツールの説明文が曖昧だったため LLM が就業終わりの時刻を自分で補っていた
- **影響範囲**: `server/src/boss/task-tools.ts`・`server/src/llm/backends/claude-code-backend.ts`・`server/src/boss/persona-prompt.ts`

### 決定 7: 画面はタスクカードに 1 行表示するだけとし、入力欄は置かない

- **採用案**: `TaskCard` は、約束を持つタスクに「ボス決定: 着手の約束 YYYY-MM-DD HH:mm」（ローカル日時）の 1 行を、締切の行と並べて表示する。約束を持たないタスクには表示しない。約束を入力・変更する UI は置かない（A1 (b)。オーナーが自分で置く (c) は採らなかった）
- **理由**: A3 表示 (ii)。翌日以降の約束があるため、時刻だけでなく日付も出す
- **影響範囲**: `web/src/TaskCard.tsx`・`web/src/task.ts`

## 機能全体の設計

### IF / API

- `Task`（server・web）に `committed_start_at: string | null` と `committed_at: string | null` を加える。`GET /api/tasks`・`POST /api/tasks`・`PATCH /api/tasks/:id` の応答のタスクはこの 2 項目を含む
- `POST /api/tasks` / `PATCH /api/tasks/:id` の入力に `committed_start_at?: string | null` を加える（決定 2）。`committed_at` は入力に加えない（決定 1）
- 更新後のステータスが `todo` でないタスクへの `committed_start_at` の設定は `400 { error, code: "commitment_requires_todo" }`（決定 3-2）
- 検知エンジンの入力（`DetectionInput`）は変えない（`tasks` に含まれる `Task` 行から読む）。出力の `DetectionRuleType` に `commitment_missed` が加わる

### 実装計画（チケット分解の見通し）

S1 は統合ブランチ `feat/issue-{親Issue番号}` に集約し、次の 4 件程度の子 PR に分ける案とする（最終分解は `/create-ticket`）。

1. 保存層: マイグレーション・`Task` 型（server）・検証と正規化・`updateTask` の `note`・`committed_at` の書き込み・ステータス変更による約束の退役・`todo` 以外のタスクへの設定の拒否（決定 1〜3-2）
2. 検知と通知文面: `commitment_missed` の判定・`rule-engine.ts` への組み込み・ルール種別の対応表・文面（決定 4・5）。1 に依存
3. ボス: ツール定義と Zod・確認の指示・`formatTaskLine`（決定 6）。1 に依存
4. 画面: `web/src/task.ts`・`TaskCard`（決定 7）。1 に依存

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 着手の約束の保存（ボスのツール経由・確認後）、`commitment_missed` による催促（勤務時間外・休憩中を含む）、タスクカードへの 1 行表示 | 16-24 | これだけで価値が出る（ボスと決めた時刻を過ぎて未着手なら、勤務時間の設定にかかわらず催促が来る） |

実装対象: S1

**S1 を切り分けなかった理由**: 保存・催促・ボスへの露出はどれか 1 つだけでは価値が出ない（保存だけでは見るための機能〔案 B〕になり、催促だけでは約束を作る経路が無い）。1 本の昇格 PR としては大きいが、統合ブランチの子 PR を 4 件に分ければ各 PR を目安（≤400 行）に収められる見込みで、出荷の単位を割る理由にはならない。

## やらないこと

- **見るためだけのタイムライン・一日の予定表の画面**（理由: 方向（案 A）で主目的にしないと決まっている）
- **翌日以降の計画の一覧表示**（理由: 同上。翌日の約束は保存・催促するが、一覧は出さない）
- **オーナーが画面で約束を入力・変更する UI**（理由: A1 で (b) ボスの提案と確認を採り、(c) を採らなかった）
- **所要時間の見積もりから時間枠を自動配置すること**（理由: A1 で (d) を採らなかった）
- **1 タスクに複数の時間枠を持つこと**（理由: A3 で 1 タスク 1 件と決まった。決定 1）
- **約束の後ろ倒しの制限・後ろ倒しそのものの検知**（理由: A6 (a)）
- **朝会の終了条件に約束の確定を加えること**（理由: A5 (a)。ADR 0009 の前提条件は変えない）
- **外部カレンダー連携**（理由: ADR 0001 のローカル完結）
- **勤務時間のフレキシブル対応（#440）と、当日限りの会の時刻（#258・#432〜#434）の実装、およびそれらへの追随**（理由: 別 Issue の範囲。本機能は勤務時間ゲートに依存しない形で両者の未実装を前提に成立させる）
- **`due_at` に時刻を持たせること**（理由: ADR 0010。締切と着手の約束は別の概念）
- **`estimated_minutes` をボスのタスク一覧や画面に出すこと**（理由: B6。時間配分に関係するが、本 Issue の範囲を広げる）
- **通知後の活動シグナルで L1 に即リセット・即再発火する既存のエスカレーション挙動の変更**（理由: 未着手・回避と共通の既存挙動。`commitment_missed` も勤務時間帯内ではこれを継承する〔決定 4 の 4〕が、挙動そのものは変えない。勤務時間帯外の `commitment_missed` は 1 回だけで、この挙動の対象外〔決定 4 の 6〕）

## 受入基準

> 実装対象スライス S1 の範囲。
>
> **検知の基準の固定時刻**は、すべて `new Date(2026, 8, 14, h, min)`（2026-09-14 のローカル日時。翌日は `new Date(2026, 8, 15, h, min)`）から導出し、勤務時間帯・エスカレーション間隔は既定値（`09:00`-`18:00`・15/10/10 分）とする。`committed_start_at` はその `Date` の `toISOString()` を入れる。
>
> **「変異」**は、その基準を担保するテストが落ちるべき実装の誤りと、**変異の前後で結果が変わる具体的な入力**の組である。担保するテストは、添えた入力で変異を検出できること。

### 保存と検証（決定 1〜3）

- [ ] マイグレーション適用後、既存の `tasks` の行の `committed_start_at` はすべて `NULL` である
- [ ] マイグレーション適用後、既存の `tasks` の行の `committed_at` はすべて `NULL` である
- [ ] `committed_start_at` を `null` から値へ設定する `PATCH /api/tasks/:id` では、応答の `committed_at` がその更新の `updated_at` と同じ値になる（変異: `committed_at` を書かない — 入力「約束なしの `todo` のタスクへ `{ committed_start_at: "2026-09-14T20:00:00+09:00" }`」で `committed_at` が `null` のまま）
- [ ] `committed_start_at` を別の値へ変える `PATCH /api/tasks/:id` では、`committed_at` がその更新の `updated_at` に書き換わる（変異: 最初に設定したときだけ書く — 入力「時刻 T1 に 20:00 を設定し、時刻 T2 に `{ committed_start_at: "2026-09-14T21:00:00+09:00" }` を送る」で `committed_at` が T1 のまま）
- [ ] `committed_start_at` の値が変わらない `PATCH /api/tasks/:id` では、`committed_at` は書き換わらない（変異: `committed_start_at` が送られるたびに書く — 入力「時刻 T1 に 20:00 を設定し、時刻 T2 に同じ `"2026-09-14T20:00:00+09:00"` を送る」で `committed_at` が T2 になる）
- [ ] `POST /api/tasks` で `committed_start_at` を含めて `todo` のタスクを作成すると、応答の `committed_at` が `created_at` と同じ値になる（変異: 作成時に `committed_at` を書かない — 入力「`{ title: "t", committed_start_at: "2026-09-14T20:00:00+09:00" }`」で `committed_at` が `null`）
- [ ] `PATCH /api/tasks/:id` は入力の `committed_at` を無視する（入力「約束なしの `todo` のタスクへ `{ title: "改題", committed_at: "2000-01-01T00:00:00.000Z" }`」で `committed_at` は `null` のまま。変異: 入力の `committed_at` を保存する — 同じ入力で `"2000-01-01T00:00:00.000Z"` が保存される）
- [ ] `POST /api/tasks` は入力の `committed_at` を無視する（入力「`{ title: "t", committed_at: "2000-01-01T00:00:00.000Z" }`」で作成されたタスクの `committed_at` は `null`。変異: 入力の `committed_at` を保存する — 同じ入力で `"2000-01-01T00:00:00.000Z"` が保存される）
- [ ] `PATCH /api/tasks/:id` に `committed_start_at: "2026-09-14T20:00:00+09:00"` を送ると 200 を返し、応答と `GET /api/tasks` の該当タスクの `committed_start_at` が `"2026-09-14T11:00:00.000Z"` である（`Z` 付きの `"2026-09-14T11:00:00Z"` も同じ値に正規化される）
- [ ] `POST /api/tasks` に `committed_start_at: "2026-09-14T20:00:00+09:00"` を含めて作成すると、作成されたタスクの `committed_start_at` が `"2026-09-14T11:00:00.000Z"` である
- [ ] `PATCH /api/tasks/:id` に `committed_start_at: null` を送ると、約束を持っていたタスクの `committed_start_at` が `null` になる
- [ ] `PATCH /api/tasks/:id` に `committed_start_at: null` を送って約束を取り消すと、`committed_at` も `null` になる（変異: 取り消しで `committed_at` を残す — 入力「約束を持つ `todo` のタスクへ `{ committed_start_at: null }`」で `committed_at` が残る）
- [ ] `PATCH /api/tasks/:id` は `committed_start_at` が `"20:00"`・`"2026-09-14"`・`"2026-09-14T20:00"`・`"2026-02-30T10:00:00+09:00"`・`"not-a-date"`・`12345` のいずれかのとき 400 を返す
- [ ] `POST /api/tasks` は `committed_start_at` が上記のいずれかの値のとき 400 を返す
- [ ] `PATCH /api/tasks/:id` が `committed_start_at` を理由に 400 を返したとき、同じリクエストに含まれる他のフィールドも含めてタスクは更新されず、`task_update` イベントも記録されない
- [ ] `committed_start_at` の値が変わる更新（未設定 → 設定・変更・取り消しの 3 通り）では、記録される `task_update` イベントの `note` に変更前と変更後の値が含まれる
- [ ] `evidence_required` と `committed_start_at` を 1 回の `PATCH /api/tasks/:id` で同時に変更すると、記録される 1 件の `task_update` イベントの `note` に両方の変更前と変更後が含まれる（変異: 片方の `note` だけを採用して他方を捨てる — 入力「`evidence_required: false → true` と `committed_start_at: null → "2026-09-14T20:00:00+09:00"` を同時に送る」でどちらかの変更前後が `note` から消える）
- [ ] `committed_start_at` を送ったが値が変わらない更新では、`task_update` イベントの `note` が `null` のままである

### 約束の退役（決定 3-2）

- [ ] `PATCH /api/tasks/:id` で約束を持つ `todo` のタスクのステータスを `in_progress`・`paused`・`done`・`dropped` のいずれかに変えると、応答と `GET /api/tasks` の `committed_start_at` が `null` になる（変異: 退役処理を外す — 入力「約束 `2026-09-14T20:00:00+09:00`・`todo` のタスクへ `{ status: "in_progress" }`」で値が残る）
- [ ] 約束を持つ `todo` のタスクへチェックインの `task_start` を送ってステータスが `in_progress` になると、`committed_start_at` が `null` になる（変異: 退役を `PATCH /api/tasks/:id` のルートハンドラにだけ置く — 入力「約束を持つ `todo` のタスクへ `task_start`」で値が残る）
- [ ] ボスの `update_task` ツールで約束を持つ `todo` のタスクのステータスを変えると、`committed_start_at` が `null` になる（変異: 退役を `PATCH /api/tasks/:id` のルートハンドラにだけ置く — 入力「約束を持つ `todo` のタスクへ `update_task` の `{ id, status: "in_progress" }`」で値が残る）
- [ ] 遷移元が `todo` 以外でも、変更後が `todo` 以外になるステータス変更で約束が退役する（変異: 退役を遷移元が `todo` の更新に限る — 入力「約束を持つ `paused` のタスクへ `{ status: "in_progress" }`」で値が残る）
- [ ] 約束が退役した更新で記録される `task_update` イベントの `note` に「約束の退役（ステータス変更による）」と、変更前の `committed_start_at` の値および変更後の値 `null` が含まれる（変異: 退役時に `note` を書かない — 入力「約束 `2026-09-14T20:00:00+09:00`・`todo` のタスクへ `{ status: "in_progress" }`」で `note` が `null` になる）
- [ ] 約束が退役した更新では、`committed_at` も `null` になる（変異: 退役で `committed_at` を残す — 入力「約束を持つ `todo` のタスクへ `{ status: "in_progress" }`」で `committed_at` が残る）
- [ ] ステータスが変わらない更新では約束が退役しない（変異: 項目を含む任意の更新で退役する — 入力「約束を持つ `todo` のタスクへ `{ title: "改題" }`」で値が消える）
- [ ] エビデンス強制のゲートで `done` への更新が拒否されたとき、約束は退役しない（変異: 退役をゲートの判定より前に書き込む — 入力「エビデンス強制オン・`evidence_required: true`・エビデンス 0 件・約束を持つ `todo` のタスクへ `{ status: "done" }`」で値が消える）

### `todo` 以外のタスクへの約束の設定の拒否（決定 3-2）

- [ ] `PATCH /api/tasks/:id` で、`status` を含めずに `in_progress`・`paused`・`done`・`dropped` のいずれかのタスクへ `committed_start_at` の値を送ると 400 を返す（変異: 拒否を外す — 入力「約束なしの `in_progress` のタスクへ `{ committed_start_at: "2026-09-14T20:00:00+09:00" }`」で 200 になり、`in_progress` のタスクに値が残る）
- [ ] `PATCH /api/tasks/:id` で、`status` に `todo` 以外の値と `committed_start_at` の値を同時に送ると、遷移元が `todo` でも 400 を返す（変異: 判定に更新前のステータスを使う — 入力「約束なしの `todo` のタスクへ `{ status: "in_progress", committed_start_at: "2026-09-14T20:00:00+09:00" }`」で 200 になる）
- [ ] 上の 2 つの拒否の応答ボディは `code: "commitment_requires_todo"` を含む
- [ ] 上の 2 つの拒否では、同じ要求に含まれる他のフィールドも含めてタスクは更新されず、`task_update` イベントも記録されない（変異: 拒否の判定を書き込みの後に置く — 入力「約束なしの `in_progress` のタスクへ `{ title: "改題", committed_start_at: "2026-09-14T20:00:00+09:00" }`」でタイトルが変わる）
- [ ] `PATCH /api/tasks/:id` で、`todo` 以外のタスクへ `status: "todo"` と `committed_start_at` の値を同時に送ると 200 を返し、約束が保存される（変異: 判定に更新前のステータスを使う — 入力「`in_progress` のタスクへ `{ status: "todo", committed_start_at: "2026-09-14T20:00:00+09:00" }`」で 400 になる）
- [ ] `PATCH /api/tasks/:id` は、`todo` 以外のタスクへの `committed_start_at: null` を拒否しない（変異: 値の有無を問わず `committed_start_at` を含む要求を拒否する — 入力「`in_progress` のタスクへ `{ committed_start_at: null }`」で 400 になる）
- [ ] ボスの `update_task` ツールで、`todo` 以外のタスクへ `committed_start_at` の値を送ると `isError: true` を返し、タスクを更新しない（変異: 拒否を `PATCH /api/tasks/:id` のルートハンドラにだけ置く — 入力「約束なしの `paused` のタスクへ `update_task` の `{ id, committed_start_at: "2026-09-14T20:00:00+09:00" }`」で値が保存される）
- [ ] `POST /api/tasks` で、`status` に `todo` 以外の値と `committed_start_at` の値を同時に送ると 400 を返し、タスクを作成しない（変異: 作成時に拒否を当てない — 入力「`{ title: "t", status: "in_progress", committed_start_at: "2026-09-14T20:00:00+09:00" }`」で 201 になり、`in_progress` のタスクに値が残る）
- [ ] ボスの `create_task` ツールで、`status` に `todo` 以外の値と `committed_start_at` の値を同時に送ると `isError: true` を返し、タスクを作成しない（変異: 拒否を `POST /api/tasks` のルートハンドラにだけ置く — 入力「`create_task` の `{ title: "t", status: "done", committed_start_at: "2026-09-14T20:00:00+09:00" }`」でタスクが作成される）
- [ ] 約束 14:00 を持つ `todo` のタスクに `task_start` をチェックインし、その後 `PATCH /api/tasks/:id` で `todo` に戻すと、スケジューラの `now` 14:30 の評価で `commitment_missed` の通知が記録されない（変異: 退役処理を外す — 同じ入力で `commitment_missed` の行が記録される）
- [ ] タスクボードでステータスを `todo` 以外へ変え、更新の応答の `committed_start_at` が `null` のとき、そのタスクカードから「着手の約束」の行が消える（変異: 画面側で送ったパッチを手元のタスクへマージし、応答を使わない — 入力「約束を持つ `todo` のタスクをドラッグ＆ドロップで進行中へ移す・モックの応答は `committed_start_at: null`」で行が残る）

### 検知（決定 4）

- [ ] `evaluateRules` は、`todo` で約束を 14:00 に持つタスクに対し、`now` が 14:00 のとき `ruleType: "commitment_missed"`・`escalationLevel: 1`・そのタスクの `taskId` を返し、13:59 のときは返さない（変異: 発火条件の `now >= 約束` を `now > 約束` にする — 入力 `now` = 14:00 で発火しなくなる）
- [ ] `evaluateRules` は、約束を 14:00 に持つタスクが `in_progress`・`paused`・`done`・`dropped` のいずれかのとき、`now` が 14:30 でも `commitment_missed` を返さない（変異: 状態の条件を外す — 入力 `in_progress`・14:30 で発火する）
- [ ] `evaluateRules` は、最優先でないタスクの約束でも `commitment_missed` を返す（変異: 評価対象を最優先タスクだけにする — 入力「タスク A: `priority: high`・約束なし・`in_progress`／タスク B: `priority: low`・約束 14:00・`todo`／`now` 14:30」で B への発火が消える）
- [ ] `evaluateRules` は、最優先タスクが約束を持つとき、約束の時刻より前でも `unstarted` を返さない（変異: 約束を持つタスクへの `unstarted` の抑止を外す — 入力「`todo`・`created_at` 09:00・`estimated_minutes: null`・約束 14:00・`now` 13:00」で `unstarted` が返る）
- [ ] `evaluateRules` は、最優先タスクが約束を持つとき、他タスクへの直近の活動があっても `avoidance` を返さない（変異: 約束を持つタスクへの `avoidance` の抑止を外す — 入力は直前の基準に「他タスクへの `task_start` 12:50」を加えたもので `avoidance` が返る）
- [ ] `evaluateRules` は、最優先タスクの約束の時刻を過ぎたとき、そのタスクに `commitment_missed` だけを返し `unstarted` を返さない（変異: 抑止を約束の時刻より前に限る — 入力「`todo`・`created_at` 09:00・`estimated_minutes: null`・約束 14:00・`now` 14:30」で `unstarted` も返る）
- [ ] `evaluateRules` は、最優先タスクが約束を持つとき、次点のタスクを最優先とみなして `unstarted` を評価しない（変異: 約束を持つタスクを最優先の候補から外す — 入力「タスク A: `priority: high`・約束 20:00・`todo`／タスク B: `priority: low`・約束なし・`todo`・`created_at` 09:00・`estimated_minutes: null`／`now` 13:00」で B への `unstarted` が返る）
- [ ] `evaluateRules` は、約束を持たない最優先タスクについて、従来どおり `created_at` から閾値ちょうどで `unstarted` を返す（入力「`todo`・`created_at` 09:00・`estimated_minutes: null`・約束なし」で `now` 10:00 は返し、09:59 は返さない。変異: 約束の有無にかかわらず抑止する — `now` 10:00 で返らなくなる）
- [ ] `evaluateRules` が返す `commitment_missed` の `ruleKey` は `commitment_missed:{taskId}:{committed_start_at}:{committed_at}` である（入力: `taskId` 7・約束 14:00・`committed_at` 09:30 のとき `commitment_missed:7:{new Date(2026, 8, 14, 14, 0).toISOString()}:{new Date(2026, 8, 14, 9, 30).toISOString()}`。変異: `ruleKey` から `committed_at` を外す — 同じ入力で末尾の `:{09:30 の値}` が欠ける）
- [ ] `evaluateRules` は、約束の時刻を変えたタスクに対し、変更前の約束の通知履歴を引き継がず L1 を返す（入力は 2 段: ①約束 14:00・`committed_at` 09:30・通知履歴なし・`now` 14:00 で評価し、返った `ruleKey` を L1・14:00 送信の通知履歴にする ②同じタスクを約束 14:10・`committed_at` 14:05 に変え、①の通知履歴・活動シグナルなし・`now` 14:20 で評価する。②で L1 が返る。変異: `ruleKey` を `commitment_missed:{taskId}` にする — ②で L2 が返る。**通知履歴は①の出力から作り、`ruleKey` の文字列をテストに直書きしない**〔直書きすると、`ruleKey` の形を変える変異で履歴が一致しなくなり、変異を検出できない〕）
- [ ] `evaluateRules` は、勤務時間帯内で、同じ `ruleKey` で L1 を 14:00 に送った後、活動シグナルが無ければ `now` 14:15 で `commitment_missed` を L2 で返し、14:14 では返さない（変異: エスカレーションを通さず常に L1 で返す — 入力 `now` 14:14 で L1 が返る）
- [ ] `evaluateRules` は、勤務時間帯内で、同じ `ruleKey` で L1 を 14:00 に送った後に活動シグナル（`chat_message` 14:05）があると、`now` 14:06 で `commitment_missed` を L1 で返す（既存の即リセットの継承。変異: `commitment_missed` だけ活動によるリセットを無効にする — 入力 `now` 14:06 で間隔未経過として返らなくなる）
- [ ] `evaluateRules` は、約束 20:00 のタスクに対し、その `ruleKey` の通知履歴が無ければ、勤務時間帯外の `now` 20:00 で `commitment_missed` を L1 で返す（変異: `commitment_missed` を勤務時間帯ゲートの内側で評価する — 入力 `now` 20:00 で返らなくなる）
- [ ] `evaluateRules` は、勤務時間帯外では、同じ `ruleKey` の通知履歴（L1・20:00 送信）があれば、活動シグナルが無くても `now` 20:15 で `commitment_missed` を返さない（変異: 勤務時間帯外でもエスカレーションを通す — 入力 `now` 20:15 で L2 が返る）
- [ ] `evaluateRules` は、勤務時間帯外では、同じ `ruleKey` の通知履歴（L1・20:00 送信）の後に活動シグナル（`chat_message` 20:05）があっても、`now` 20:06 で `commitment_missed` を返さない（変異: 勤務時間帯外にも活動によるリセットを効かせる — 入力 `now` 20:06 で L1 が返る）
- [ ] `evaluateRules` は、約束 17:00 のタスクに勤務時間帯内（L1・17:00 送信）で通知済みなら、勤務時間帯外になった `now` 18:00 で `commitment_missed` を返さない（変異: 勤務時間帯外の 1 回を「勤務時間帯外に送った通知履歴が無いとき」とする — 入力 `now` 18:00 で L1 が返る）
- [ ] `evaluateRules` は、約束が 2026-09-14 20:00 で通知履歴（L1・2026-09-14 20:00 送信）があり、その後に活動シグナルが無いタスクに対し、勤務時間帯に入った `now` 2026-09-15 09:00 で `commitment_missed` を L2 で返し、`now` 2026-09-15 08:59 では返さない（変異: 勤務時間帯内にも 1 回の判定を当てる — 入力 `now` 09:00 で返らなくなる。変異: 勤務時間帯外でもエスカレーションを通す — 入力 `now` 08:59 で L2 が返る）
- [ ] `evaluateRules` は、約束が 2026-09-14 20:00 で通知履歴が無いタスクに対し、約束の暦日を過ぎた勤務時間帯外の `now` 2026-09-15 02:00 で `commitment_missed` を L1 で返す（変異: 勤務時間帯外の評価を約束のローカル暦日のあいだに限る — 入力 `now` 2026-09-15 02:00 で返らなくなる）
- [ ] `evaluateRules` は、勤務時間帯外で約束の時刻を 20:00 から 21:00 へ変えたタスクに対し、変更前の約束の通知履歴があっても L1 を返す（入力は 2 段: ①約束 20:00・`committed_at` 19:00・通知履歴なし・`now` 20:00 で評価し、返った `ruleKey` を L1・20:00 送信の通知履歴にする ②約束 21:00・`committed_at` 20:05 に変え、①の通知履歴・`now` 21:00 で評価する。②で L1 が返る。変異: `ruleKey` を `commitment_missed:{taskId}` にする — ②で履歴ありとして返らなくなる。通知履歴は①の出力から作る）
- [ ] `evaluateRules` は、勤務時間帯外で約束を 20:00 → 21:00 → 20:00 と元の時刻へ戻したタスクに対し、最初の約束の通知履歴があっても L1 を返す（入力は 2 段: ①約束 20:00・`committed_at` 19:00・通知履歴なし・`now` 20:00 で評価し、返った `ruleKey` を L1・20:00 送信の通知履歴にする ②約束 20:00・`committed_at` 20:10 に変え、①の通知履歴・`now` 20:10 で評価する。②で L1 が返る。変異: `ruleKey` から `committed_at` を外す — ②が①と同じ `ruleKey` になり返らなくなる。通知履歴は①の出力から作る）
- [ ] `evaluateRules` は、勤務時間帯内の休憩申告中（終了していない `break_start`）でも `commitment_missed` を返す（入力「`break_start` 13:55・約束 14:00・通知履歴なし・`now` 14:00」。変異: 勤務時間帯内の休憩ゲートの内側で評価する — 入力 `now` 14:00 で返らなくなる）
- [ ] `evaluateRules` は、勤務時間帯外の休憩申告中（終了していない `break_start`）でも `commitment_missed` を返す（入力「`break_start` 19:55・約束 20:00・通知履歴なし・`now` 20:00」。変異: 勤務時間帯外でだけ休憩ゲートを当てる — 入力 `now` 20:00 で返らなくなる）
- [ ] `evaluateRules` は、勤務時間帯外の休憩申告中も 1 回の判定に従い、`break_start` 19:55・約束 20:00・通知履歴（L1・20:00 送信）・活動シグナルなしで `now` 20:15 に `commitment_missed` を返さない（変異: 休憩中は勤務時間帯外でもエスカレーションを通す — 入力 `now` 20:15 で L2 が返る）
- [ ] `evaluateRules` は、`commitment_missed` を返す勤務時間帯外の `now` でも、約束を持たないタスクの `unstarted`・`deadline_overdue` を返さない（変異: `commitment_missed` の発火で勤務時間帯ゲートを開ける — 入力「タスク A: 約束 20:00・`todo`／タスク B: 約束なし・`due_at` 2026-09-13・`todo`／`now` 2026-09-14 20:00」で B への `deadline_overdue` が返る）

### 通知文面（決定 5）

- [ ] `commitment_missed` の通知文面の生成依頼に、対象タスクの約束のローカル日時（入力 `new Date(2026, 8, 14, 20, 0)` のとき `2026-09-14 20:00`）が含まれる
- [ ] `commitment_missed` の LLM 呼び出しが失敗したとき、L1・L2・L3 のそれぞれでタスク名を含む空でないフォールバック定型文が返る
- [ ] スケジューラの 1 回の評価で `commitment_missed` が発火すると、`notifications` に `type: "commitment_missed"` と発火時の `rule_key`・`escalation_level` の行が記録される

### ボスのツールと文脈（決定 6）

- [ ] `create_task` と `update_task` のツール定義が `committed_start_at` の入力を持ち、その説明文が「時刻とオフセットを含む ISO 8601 の日時」であることを明示する
- [ ] `update_task` のツール定義の `committed_start_at` の説明文が、`null` で約束を取り消せることを明示する
- [ ] `task-tools.ts` の `update_task` の JSON Schema で、`committed_start_at` の型が `null` を含む（例: `type: ["string", "null"]`）（変異: JSON Schema だけ `type: "string"` に戻し、Zod 側は nullable のままにする — 入力「`TASK_TOOLS` の `update_task` の `input_schema.properties.committed_start_at` の型を読む」で `null` を含まない）
- [ ] `claude-code-backend.ts` の `update_task` の Zod shape は `committed_start_at: null` を受け付ける（入力 `z.object(TOOL_ZOD_SHAPES.update_task).safeParse({ id: 1, committed_start_at: null })` が成功する。変異: Zod だけ `.nullable()` を外し、JSON Schema 側は `null` を含むままにする — 同じ入力で失敗する）
- [ ] Zod shape で検証した `update_task` の入力 `{ id, committed_start_at: null }` を `executeBossTool` で実行すると、約束を持つ `todo` のタスクの `committed_start_at` と `committed_at` が `NULL` になる（claude-code バックエンドの経路。変異: Zod shape から `.nullable()` を外す — 入力「約束 `2026-09-14T20:00:00+09:00` を持つ `todo` のタスクへ `{ id, committed_start_at: null }`」で検証に失敗して実行されず、値が残る）
- [ ] `executeBossTool` に `update_task` の入力 `{ id, committed_start_at: null }` を直接渡して実行すると、約束を持つ `todo` のタスクの `committed_start_at` と `committed_at` が `NULL` になる（API バックエンドの経路。変異: `executeUpdateTask` が `null` を「項目なし」として落としてから `updateTask` を呼ぶ — 入力「約束 `2026-09-14T20:00:00+09:00` を持つ `todo` のタスクへ `{ id, committed_start_at: null }`」で値が残る）
- [ ] `update_task` の `{ id, committed_start_at: null }` の実行で約束を取り消すと、記録される `task_update` イベントの `note` に変更前の値と変更後の値 `null` が含まれる（変異: `executeUpdateTask` が `null` を「項目なし」として落としてから `updateTask` を呼ぶ — 同じ入力で `note` が `null` のまま）
- [ ] `claude-code-backend.ts` の `create_task`・`update_task` の Zod shape の `committed_start_at` の説明文が、`task-tools.ts` の説明文と一致する
- [ ] `update_task` ツールに解釈できない `committed_start_at`（例: `"20:00"`）を渡すと、`isError: true` を返しタスクを更新しない
- [ ] 通常チャットのシステムプロンプトに、着手の約束はユーザーが確認した日時だけを保存するよう指示する文言が、会の種別が朝会・夕会・随時・未指定のいずれでも含まれる
- [ ] ボスに渡すタスク一覧で、約束を持つタスクの行にはその約束の日時が含まれ、約束を持たないタスクの行には約束の項目が含まれない

### 画面（決定 7）

- [ ] `TaskCard` は、`committed_start_at` を持つタスクに `ボス決定: 着手の約束 YYYY-MM-DD HH:mm`（ローカル日時。入力 `new Date(2026, 8, 14, 20, 0).toISOString()` のとき `ボス決定: 着手の約束 2026-09-14 20:00`）の 1 行を表示し、`null` のタスクには「着手の約束」を表示しない

### 横断

- [ ] 検知・保存・画面の新規テストの固定時刻がローカル日時から導出されており、`npm run test:tz` を S1 の適用前（`main`）と適用後の双方で実行して、適用後に新規に失敗するテストが無い
