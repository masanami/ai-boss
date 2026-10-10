# タスク着手時にタスクごとのメンタリング（見積もり・進め方の確認）を促す

> **正はコードとテスト**であり、本ファイルは権威を持たない（`CLAUDE.md`「開発方針」）。実装と食い違う場合はコードが正。
>
> 対象 Issue: #561
>
> 判断 1〜4（促しの強さ・トリガー・「未確認」の定義・頻度と朝会の印付けの形）は**プロダクトオーナーが 2026-09-22 に決定**した（決定 1〜4）。実装面の設計（決定 5〜8）は意思決定者（親エージェント）の設計方針を本仕様が実コードで確証して確定したもので、S1 の範囲（朝会の印付けを S2 へ分けること）は親の委任範囲で本仕様が判断した（決定 5）。ただし決定 8 の「判定の完了順の裁き方」は #568 でプロダクトオーナーが 2026-09-22 に選択した。
>
> **本仕様は `docs/features/task-scoped-mentoring.md`（#438）を改訂しない。** 同仕様が定めるタスク起点メンタリングの器（タスクカードの「メンタリングする」→ `startMentoring`）を**そのまま呼ぶ**だけで、器の文面・保持スコープ・朝会ゲート（判断7）には触れない。
>
> **2026-10-10 改訂**: S1 は出荷済み（要件チケット #566・PR #572）。本改訂で S2（ボス側のプロンプト）・S3（タスクカードの未確認の印）の機能要件・受入基準を足し（決定 9〜12）、S4 の出し方についてプロダクトオーナーが 2026-10-10 に下した決定を決定 13 として記録した。決定 9〜12 は親エージェントの委任範囲で本仕様が実コード（`4cded7f`）を根拠に確定したもので、判断7「深掘りを強制しない（現状維持）」と決定 1〜4 の範囲を出ない。

## 概要

タスクを **`todo` から `in_progress` にした瞬間**、そのタスクの見積もり（`estimated_minutes`）または進め方（そのタスクに紐づく `kind='mentoring'` の記録）が**未確認**なら、画面に 1 行の促しと「メンタリングする」ボタンを出す。ボタンを押せば既存のタスク起点メンタリングへワンクリックで入れる。促しはスキップでき、着手をブロックしない。同じタスクを何度も促さない（1 タスク 1 回）。S1 は web のみで完結し、サーバ・DB を変えない。

S2 はボス側を整える（server のみ）。(a) 朝会のプロンプトに「見積もり・進め方が未確認の `todo` タスク」の一覧を渡し、ボスが深掘りせず「着手時に相談」と予約する指示を積む。(b) タスク起点メンタリングのターンで対象タスクの見積もりが空なら、ボスにその事実と「見積もりを提案し、確認された値だけ保存する」指示を渡す。S3 はタスクボードの `todo` のカードに同じ定義の「未確認」の印を出す（web のみ）。S4（着手の約束を過ぎたときの一言）は出し方だけを決定 13 に記録し、受入基準は後の改訂で書く。

## 背景・目的

### 困りごと（Issue #561）

タスクごとの見積もり・進め方がうまくいかず、それが一日全体の進行に波及することが多い。タスク起点メンタリング（タスクカード「メンタリングする」・#438）は出荷済みだが、**利用者が自分で押さない限り起きない**ため、見積もりがずれやすいタスクほど相談されないまま着手されてしまう。

### オーナーの方向性（2026-09-22）

- **朝会は全体を通した進め方の軽い調整にとどめる**（全タスクの深掘りは求めない）。#438 判断7 は (1) 現状維持で確定済み
- **タスクごとの深掘りは「着手の時点」で促す**
- 朝会の調整の中では、見積もり・進め方が未確認のタスクに**印を付ける程度**（深掘りは「着手時に相談」と予約する）に留める

### 現状の確証（S1 定義時は `dddba97`。2026-10-10 の改訂で行番号を `4cded7f` で取り直し、S2・S3 の根拠 C13〜C19 を足した）

| # | 事実 | 根拠 |
|---|---|---|
| C1 | 所要時間見積もりの確認指示 `TASK_ESTIMATE_CONFIRMATION_INSTRUCTION` は「チャットからタスクを新規作成するとき」に限った文言で、会の種別を問わず通常チャットに積まれる。隣接する着手の約束の確認指示は「担保はこの指示だけとし、機械的なゲートは置かない」と明記している。確認済みを表すフラグは無い | `server/src/boss/persona-prompt.ts` の `TASK_ESTIMATE_CONFIRMATION_INSTRUCTION`（871-873 行）・`TASK_COMMITMENT_CONFIRMATION_INSTRUCTION` とそのコメント（875-881 行）・`buildPersonaPrompt` の push（1008-1009 行）。`docs/features/task-start-commitment.md` C7 |
| C2 | web が起こす `todo` → `in_progress` は 2 経路ある。タスクカードのステータス select と、タスクボードのカラムへのドラッグ＆ドロップ。どちらも共有 `tasksState` の `editTask` → `PATCH /api/tasks/:id` に収束し、成功応答で共有 `tasks` 状態が置き換わる | `web/src/TaskCard.tsx` 425 行（select の `onStatusChange`）・`web/src/TaskBoard.tsx` 195 行（drop）と 267-269 行（select）・`web/src/use-tasks.ts` 59-62 行・`web/src/tasks-api.ts` `patchTask` |
| C3 | チェックインの `task_start` は**サーバ側**で `todo`／`paused` → `in_progress` へ遷移させる（後追い記録では遷移しない場合がある）。web は遷移をレスポンスから知らず、送信成功後の `refreshTasks()`（共有 `tasks` の再取得）で知る。チェックインパネルはどのビューでも表示されるサイドパネルに常駐する | `server/src/activity/checkins-routes.ts` 129-142 行・`web/src/use-checkin-panel.ts` 118-129 行（`refreshAfterAttempt`）・`web/src/AppLayout.tsx` 335 行 |
| C4 | `tasksState`（`useTasks`）は `AppLayout` にリフトアップされ、`TaskBoard` と `CheckinPanel` が同じものを受け取る。したがって web が観測しうる `todo` → `in_progress` は、経路を問わず**この 1 つの `tasks` 状態の変化**として現れる | `web/src/AppLayout.tsx`・`web/src/CheckinPanel.tsx` 43-52 行のコメント |
| C5 | タスクカードの「メンタリングする」は `AppLayout` の `startMentoringForTask`（chat ビューへ切替 → `chatState.startMentoring(task)`）を呼ぶ。この導線は `chatState.status === "ready"` かつ `sessionType === "adhoc"` のときだけ渡され（それ以外は `null`＝ボタン非表示）、`sending || switching` のとき非活性。`startMentoring` は `「<タスク名>」の進め方を見てほしい` を `mentoring: true`・`mentoringTaskId` 付きで送る | `web/src/TaskCard.tsx` 438-445 行・`web/src/AppLayout.tsx` 101-120 行・`web/src/use-chat.ts` 583-608 行 |
| C6 | web は `GET /api/decisions` で**全件**の決定・メンタリング記録を取得できる。応答の各行は `task_id`・`kind`（`decision`／`mentoring`）・`status` を持ち、サーバ側で `kind`・`status` の絞り込みはしていない。取得関数 `fetchDecisions` は既にあるが、`useDecisions`（マウント時取得）は決定ログ画面でしか使われていない | `server/src/decisions/decisions-routes.ts` 17 行・`server/src/decisions/decisions-repository.ts` `listDecisions`（84-91 行）・`web/src/decisions-api.ts` `fetchDecisions`・`web/src/decision.ts` `DecisionRecord`・`web/src/DecisionLog.tsx` 166 行 |
| C7 | サーバはタスク単位の記録を `listDecisionsByTaskId` で引けるが、これはメンタリングのターンにプロンプトへ積む用途にしか使われていない（HTTP には公開されていない） | `server/src/decisions/decisions-repository.ts` 125-131 行・`server/src/sessions/chat-messages-route.ts` 428-431 行 |
| C8 | ボスに渡すタスク一覧は `listTasks(db)`（全タスク）で、各行は状態・id・タイトル・優先度・エビデンス・締切・着手の約束だけを含み、**`estimated_minutes` もメンタリング記録の有無も含まない**。朝会フロー指示 `MORNING_FLOW_INSTRUCTION` は `resolveSessionFlowInstruction` 経由で積まれ、見積もりの提案・確認を指示している。`MENTORING_FLOW_INSTRUCTION` は `mentoring` が真のときに朝会指示より前に積まれる | `server/src/sessions/chat-messages-route.ts` 382 行・`server/src/boss/persona-prompt.ts` `formatTaskLine`（315-333 行）・`MORNING_FLOW_INSTRUCTION`（803-806 行）・`MENTORING_FLOW_INSTRUCTION`（756-764 行）・`buildPersonaPrompt` 976-977 行・1002-1007 行 |
| C9 | `estimated_minutes` を書ける経路は `PATCH /api/tasks/:id`（`null` または 0 以上の整数）と、ボスの `create_task`／`update_task` ツール（同じ検証を通る）。**web には見積もりの入力 UI が無い**（web の実装コードで `estimated_minutes` を参照するのは `web/src/task.ts` の型定義と、S1 の判定〔`web/src/task-start-mentoring.ts`・`web/src/use-task-start-mentoring-prompt.ts`〕のみ。2026-10-10 に `4cded7f` で確認）。「ユーザーが確認した値だけ保存する」の担保は C1 のプロンプト指示だけである | `server/src/tasks/tasks-validation.ts` 138-141 行・`server/src/boss/task-tools.ts` 44 行・87 行・`web/src/task.ts` 22 行 |
| C10 | 「ボスが次のタスクとして指示する」機構は存在しない（該当する状態・ツール・イベントが無い）。ボスが `update_task` で `status` を `in_progress` にすることはできるが、web の `tasks` 状態はチャット送信後に再取得されない（再取得されるのはチャットの時系列だけ）ため、web がその遷移を知るのは次にタスクが再取得されたとき | `server/src/boss/task-tools.ts`・`web/src/use-chat.ts` `refreshTimeline`（682 行付近） |
| C11 | 「強制しない」側の方針の記述: 着手の約束の仕様が「確認の担保はこの指示だけとし、機械的なゲートは置かない（見積もりと同じ）」と定めている。`docs/features/task-scoped-mentoring.md` の判断7 は「催促の強度＝体験の根幹」としてオーナー決定事項に置き、オーナーは (1) 現状維持（タスク起点導線は `adhoc` のみ・朝会ゲートに算入しない）を選んだ。ADR 0009 は**強制が欲しい領域（朝会の必須メンタリング）**について「プロンプト指示だけでは強制にならない・機械的なゲートが要る」と述べており、本機能はその領域に触れない。旧 MVP 仕様（`ai-boss-mvp.md`）は `faa4f00`・#170 で退役しており存在しない | `docs/features/task-start-commitment.md` 決定 6（191-199 行）・`docs/features/task-scoped-mentoring.md` 495-510 行・`docs/adr/0009-morning-mentoring-prerequisite.md` 13 行・37 行 |
| C12 | web のテストは Vitest ＋ Testing Library ＋ jsdom。`TaskBoard.test.tsx` はドラッグ＆ドロップを `dataTransfer` のモックで検証しており、`AppLayout.test.tsx` は URL でルーティングする fetch モックで統合的に検証している | `web/package.json`・`web/src/TaskBoard.test.tsx` 11-22 行・249-255 行・`web/src/AppLayout.test.tsx` 57 行付近 |
| C13 | 「対象タスク」セクション（タスク起点メンタリングのターン）の 1 行はタスク一覧と同じ `formatTaskLine` で組み立てられ、`estimated_minutes` を含まない。したがって S1 の促しから入ったメンタリングでも、ボスは対象タスクの見積もりが空かどうかを知らない。`formatTaskLine` は通知文面（`purpose: "notification"`）・日報抽出（`"daily-report"`）のプロンプトとも共有されている | `server/src/boss/persona-prompt.ts` `formatTaskLine`（315-333 行）・`formatTargetTaskSection`（788-790 行）・`buildPersonaPrompt` 945-949 行（タスク一覧）・981-989 行（対象タスク）・`server/src/notifications/notification-body.ts` `buildNotificationLlmRequest`（214 行） |
| C14 | 見積もりの「確認済みの値だけ保存」の指示は 2 つだけある。`TASK_ESTIMATE_CONFIRMATION_INSTRUCTION`（**新規作成時**に限る文言・chat なら会の種別を問わず積む）と `MORNING_FLOW_INSTRUCTION`（朝会だけ・既存タスクの `update_task` も含む）。**随時（`adhoc`）区間のタスク起点メンタリングで既存タスクの見積もりを `update_task` で保存する場面を覆う指示は無い**。`update_task` の `estimated_minutes` には説明文が無く（`create_task` は「所要時間見積もり（分）」のみ）、着手の約束（`committed_start_at`）の「ユーザーが確認した…のみを設定すること」に当たる文言も無い | `server/src/boss/persona-prompt.ts` 803-806 行・871-873 行・`server/src/boss/task-tools.ts` 44-47 行・63-68 行・87 行・92-97 行 |
| C15 | チャットの 1 ターンのプロンプト材料は 1 つのトランザクションで読む（#618）。読むのは `listTasks`・`listRecentDecisions(tx, 5)`・`listRecentSessionSummaries`・設定・当日の随時チャット・エビデンス件数と、対象タスクがあるときだけ `listDecisionsByTaskId`。**「どのタスクにメンタリング記録があるか」をまとめて引く読み取りは無い**。`listRecentDecisions` は SQL で `kind = 'decision'` に絞っており、メンタリング記録は「直近の決定」に入らない（#408 AC-42 の契約） | `server/src/sessions/chat-messages-route.ts` 380-455 行・`server/src/decisions/decisions-repository.ts` `listRecentDecisions`（100-110 行）・`listDecisionsByTaskId`（125-131 行） |
| C16 | `buildPersonaPrompt` は chat の分岐で、(1) `mentoring` が真なら `MENTORING_FLOW_INSTRUCTION`、対象タスクがあれば「対象タスク」→ `MENTORING_TARGET_TASK_INSTRUCTION` →「対象タスクの過去記録」、(2) 会の種別のフロー指示（朝会なら `MORNING_FLOW_INSTRUCTION`）、(3) 見積もり・着手の約束の確認指示、(4) 平文の指示、の順に積む。「対象タスク」と `MENTORING_TARGET_TASK_INSTRUCTION` の間には何も挟まない（#545 決定19）。朝会で必須メンタリングが有効なら朝会でも `mentoring` は真になるが、`mentoringTaskId` は付かない（タスク起点の導線は `adhoc` 区間のみ） | `server/src/boss/persona-prompt.ts` 972-1013 行・`server/src/sessions/chat-messages-route.ts` 413-421 行 |
| C17 | 見積もり 0 分はサーバの検証が許す（`null` または 0 以上の整数）。S1 の web の判定 `isMentoringUnconfirmed` は `estimated_minutes === null` と、`kind === "mentoring"` かつ `task_id` が一致する行の有無で判定し、`status` を見ない | `server/src/tasks/tasks-validation.ts` 138-141 行・`web/src/task-start-mentoring.ts` `isMentoringUnconfirmed` |
| C18 | S1 の促しは、遷移を観測した時点で `fetchDecisions()` を呼び、`estimated_minutes` が `null` なら取得せずに未確認と判定し、取得失敗は促さない側に倒す。タスクボード（`TaskBoard`）は `activeView === "tasks"` のときだけ描画される（ビューの切替で毎回マウントし直される）。チャットは別のビュー（`chat`）で、メンタリングの記録はそこで作られる。`TaskCard` を描画するのは `TaskBoard` だけ。マウント時に `fetchDecisions()` を 1 回呼ぶ `useDecisions` が既にある（決定ログ画面が使用） | `web/src/use-task-start-mentoring-prompt.ts` 102-125 行・`web/src/AppLayout.tsx` 259-279 行・`web/src/use-decisions.ts` |
| C19 | `commitment_missed`（約束の時刻を過ぎても未着手）の通知は、文面生成の依頼に対象タスクの行と約束の時刻を含め、L1〜L3 のフォールバック定型文を持つ。依頼にメンタリング記録は含まれない。検知系の通知には基底 `rule_key` ごとの 1 日の上限がある（#562） | `server/src/notifications/notification-body.ts` 96-109 行・172-176 行・`server/src/detection/rule-engine.ts` 81 行付近 |

### Issue 本文と実コードの食い違い

- 「ボスが次のタスクとして指示したタイミング」は C10 のとおり該当する機構が無い。S1 のトリガーには採らず、ボスの「次タスク指示」機能も作らない（決定 2・「やらないこと」）
- 朝会の印付けを「プロンプト指示のみ」で実現するには、ボスが「どのタスクが未確認か」を知っている必要があるが、C8 のとおりタスク一覧に見積もりもメンタリング記録の有無も入っていない。**指示文だけを足しても成立しない**ため、未確認の印（データ）をプロンプトへ渡すサーバ変更が要る。これは web のみで完結する S1 と触る層が異なるので **S2 に分ける**（決定 5）

## ユーザーストーリー

- 利用者として、タスクに着手した瞬間に「このタスクは見積もり・進め方をまだボスと確認していない」と気づかされ、ワンクリックで相談に入りたい。相談しないと決めたときは 1 回のスキップで済ませ、同じタスクで繰り返し言われたくない
- 利用者として、見積もり・進め方を既に確認したタスクに着手するときは、何も言われずに作業へ入りたい

## 機能要件（S1）

- [x] FR-1 タスクが `todo` から `in_progress` に変わったとき、そのタスクが「未確認」なら促しを表示する
- [x] FR-2 「未確認」とは、`estimated_minutes` が `null`、**または**そのタスクに紐づく `kind='mentoring'` の記録が 1 件も無いことである（いずれか＝OR）
- [x] FR-3 促しは 1 件の案内文（タスク名を含む。長さは受入基準の対象外）と「メンタリングする」「あとで」の 2 操作からなる
- [x] FR-4 「メンタリングする」はタスクカードの同名ボタンと同じ結果になる（chat ビューへ切り替わり、既存の `startMentoring(task)` が呼ばれる）
- [x] FR-5 「あとで」は促しを閉じるだけで、サーバへ何も送らない
- [x] FR-6 同じタスクの促しは同じページ内で 1 回だけ表示する（「あとで」で閉じた後も、再び `todo` → `in_progress` を起こしても出ない）
- [x] FR-7 促しはステータス遷移をブロックしない（促しの表示・非表示・操作にかかわらず、遷移の送信はそのまま完了する）
- [x] FR-8a カードの select 経由の `todo` → `in_progress` で同じ促しが出る（AC-3）
- [x] FR-8b カラムへのドロップ経由の `todo` → `in_progress` で同じ促しが出る（AC-4）
- [x] FR-8c チェックインの `task_start` 送信成功後の再取得経由の `todo` → `in_progress` で同じ促しが出る（AC-5）
- [x] FR-9 促しはタスクカードの「メンタリングする」が出せる条件（`adhoc` 区間・チャット状態 ready）のときだけ表示する

## 機能要件（S2）

### (a) 朝会での未確認タスクの印付け（決定 9・11）

- [ ] FR-10 朝会（`sessionType: "morning"`）の chat のプロンプトに、`status` が `todo` で「未確認」（FR-2 と同じ定義）のタスクを 1 行ずつ並べたセクション「見積もり・進め方が未確認のタスク」を積む。各行は `#<id>`・タイトル・未確認の内訳（見積もり・進め方のどちらが未確認か）を含む
- [ ] FR-11 同じ条件で、ボスへの指示 `MORNING_UNCONFIRMED_TASKS_INSTRUCTION` を積む。指示は (1) 上のセクションのタスクについて朝会では進め方の深掘り（タスクごとの点検）をしない、(2) それらのタスクの進め方の相談は「着手時に相談」と一言で予約する、(3) 相談を強制せず、着手を止めない、の 3 点を含む。見積もりの提案は予約の対象にせず、既存の `MORNING_FLOW_INSTRUCTION` どおり朝会で行う（決定 9）
- [ ] FR-12 未確認の `todo` タスクが 0 件のとき、朝会でも FR-10 のセクション・FR-11 の指示のどちらも積まない
- [ ] FR-13 朝会以外（`adhoc`・`evening`・未指定）、および chat 以外の用途（`notification`・`daily-report`）では、FR-10 のセクション・FR-11 の指示のどちらも積まない
- [ ] FR-14 チャットルートは朝会のターンで、メンタリング記録を持つタスクの id の集合をプロンプト材料と同じトランザクションで読み、`buildPersonaPrompt` へ渡す（朝会以外で読まないことは仮定 13）。記録の `status` は問わない（決定 3 と同じ）

### (b) タスク起点メンタリングでの見積もりの提案（決定 10）

- [ ] FR-15 chat の `mentoring` が真で対象タスク（`mentoringTaskId`）が `tasks` に在り、その `estimated_minutes` が `null` のとき、指示 `MENTORING_TARGET_ESTIMATE_INSTRUCTION` を積む。指示は (1) 対象タスクの所要時間の見積もりが未設定であること、(2) この相談の中で見積もりを提案すること、(3) ユーザーが確認（同意または修正）した値だけを `update_task` で `estimated_minutes` に保存し、確認前に保存しないこと、(4) ユーザーが見積もりを保留・拒否したらこの相談の中で繰り返し求めないこと、を含む
- [ ] FR-16 対象タスクの `estimated_minutes` が非 `null`（0 を含む）のとき、対象タスクが無いとき、`mentoring` が偽のときは、FR-15 の指示を積まない
- [ ] FR-17 FR-15 の指示は対象タスクのまとまり（「対象タスク」→ `MENTORING_TARGET_TASK_INSTRUCTION` →「対象タスクの過去記録」）の後に積み、そのまとまりの並びを変えない

## 機能要件（S3）

- [ ] FR-18 タスクボードで、`status` が `todo` で「未確認」（FR-2 と同じ定義）のタスクのカードに、未確認の印（文言「未確認」を含むテキスト）を表示する
- [ ] FR-19 `status` が `todo` 以外のカード、および確認済みのタスクのカードには印を表示しない
- [ ] FR-20 印の判定は S1 の判定関数 `isMentoringUnconfirmed`（C17）を再利用し、メンタリング記録はタスクボードのマウント時に `GET /api/decisions` で取得する
- [ ] FR-21 `GET /api/decisions` の取得中・取得失敗のときは、`estimated_minutes` が `null` のカードにだけ印を出し、非 `null` のカードには印を出さない（S1 の AC-14 と同じく、記録が分からないときは促さない側に倒す。エラーは画面に出さない）
- [ ] FR-22 印は会の種別・チャットの状態を問わず表示する（朝会中も出す）

## 非機能要件

- ローカル完結: 促しの判定は既存の `GET /api/tasks`・`GET /api/decisions` の応答だけで行い、新しい外部送信・新しいエンドポイント・DB 変更を伴わない
- アクセシビリティ: 促しは `role="status"` の要素として現れ、支援技術に通知される（`aria-live` 相当）
- ローカル完結（S2）: 朝会のプロンプトへ足すのはローカル DB から導いたタスクの id・タイトル・未確認の内訳だけで、Anthropic への推論リクエスト以外の外部送信を増やさない。新しいエンドポイント・DB 変更は無い
- トークン量（S2）: 朝会のプロンプトは未確認の `todo` タスク 1 件につき 1 行（`#<id>`・タイトル・内訳）と、1 件以上あるときだけ指示 1 つ分増える。上限は設けない（決定 9）。それ以外の会・用途のプロンプトは変わらない
- アクセシビリティ（S3）: 印は色やアイコンだけで表さず、文言「未確認」を含むテキストとして描く

## 技術的な制約・方針

- 使用技術（S1）: web（Vite + React + TypeScript）のみ。**サーバ非変更・マイグレーション無し**
- 変更対象（S1）: `web/src/AppLayout.tsx`（共有 `tasksState` の遷移検知・促しの状態と描画）、促しの表示コンポーネント（新規）、遷移検知と「未確認」判定の純関数（新規）、スタイル
- 既存コードとの関係（S1）: 「メンタリングする」は `AppLayout` の `onStartMentoring`／`startMentoringDisabled`（C5）を**そのまま**使う。`GET /api/decisions` は `fetchDecisions`（C6）で取得する。`startMentoring` の文面・オプション（`docs/features/task-scoped-mentoring.md` 決定 3・6）は変えない
- 使用技術・変更対象（S2）: server のみ。**web 非変更・マイグレーション無し**。`server/src/boss/persona-prompt.ts`（`PersonaPromptContext` の項目追加・未確認の判定・セクションと 2 つの指示の追加）、`server/src/decisions/decisions-repository.ts`（メンタリング記録を持つタスク id の読み取りを追加）、`server/src/sessions/chat-messages-route.ts`（朝会のターンでその読み取りを呼んで渡す）。`formatTaskLine`・`MORNING_FLOW_INSTRUCTION`・`TASK_ESTIMATE_CONFIRMATION_INSTRUCTION`・`listRecentDecisions`・ボスのツール定義は変えない
- 使用技術・変更対象（S3）: web のみ。**サーバ非変更・マイグレーション無し**。`web/src/TaskBoard.tsx`（マウント時の記録の取得と判定）、`web/src/TaskCard.tsx`（印の描画）、スタイル。判定関数は `web/src/task-start-mentoring.ts` の `isMentoringUnconfirmed` を再利用する
- テスト（S1）: Vitest ＋ Testing Library（C12 の既存パターン）。時刻・暦日を扱わないため TZ 非依存。3 経路（select・drop・チェックイン後の再取得）は `AppLayout` を描画した統合テストで、判定の規則は純関数のユニットテストで固定する
- テスト（S2）: `buildPersonaPrompt` のユニットテストで、指示文・セクションが**積まれる条件と積まれない条件の両方向**を固定する。指示文はテストが文言を重複記述して恒真にならないよう `export` した定数で照合する（`MENTORING_TARGET_TASK_INSTRUCTION`・`CHAT_PLAIN_TEXT_INSTRUCTION` と同じ作法）。リポジトリの読み取りとルートの結線は実 SQLite（`:memory:` か一時ファイル）を使う統合テストで固定する。時刻を固定する場合はローカル日付基準（`new Date(y, m, d, h)` 由来）で組み、TZ 非依存にする
- テスト（S3）: Vitest ＋ Testing Library。`TaskBoard`（印の有無・取得中・取得失敗）と `AppLayout`（ビューの切替による再取得・朝会中の表示）の描画テストで固定する。時刻・暦日を扱わないため TZ 非依存

## クリティカル設計決定

> 後続の実装はこの決定に従い、独自判断で逸脱しない。決定 1〜4 はプロダクトオーナー（2026-09-22）、決定 5 は本仕様（親の委任範囲）、決定 6〜8 は親の設計方針を実コードで確証したものである。ただし決定 8 の「判定の完了順の裁き方」は #568 でプロダクトオーナーが 2026-09-22 に選択した。決定 9〜12（S2・S3）は親の委任範囲で本仕様が実コードを根拠に確定し、決定 13（S4 の出し方）はプロダクトオーナーが 2026-10-10 に決定した。

### 決定 1: 促すだけで、着手をブロックしない（判断 1）

- **採用案**: 着手の遷移はそのまま完了させ、その後に促し（案内文＋「メンタリングする」「あとで」）を出す。スキップ可
- **理由**: 見積もり・着手の約束の担保は「指示のみ・機械的なゲートは置かない」が既存方針（C1・C11）。着手をブロックする案は判断7「深掘りを強制しない（現状維持）」と衝突する。ADR 0009 が機械的なゲートを要求するのは「強制が欲しい」朝会の領域であり、本機能は強制を意図しない
- **代替案**: (b) 未確認なら `in_progress` への遷移を拒み、メンタリング完了を要求する — 却下（上記）。(c) 促しをモーダルにして操作を止める — 却下（ブロックと同じ体験になる。「あとで」を要求すること自体が摩擦）

### 決定 2: トリガーは web が観測する `todo` → `in_progress` の遷移だけ（判断 2）

- **採用案**: 共有 `tasks` 状態で、あるタスクの `status` が `todo` から `in_progress` へ変わったことを遷移とみなす。経路は問わない（C2 の select・drop、C3 のチェックイン後の再取得）。`paused` → `in_progress`（再開）は対象外
- **理由**: 「着手の時点」を最も直接に表すのがこの遷移であり、web は C4 のとおり 1 つの `tasks` 状態としてすべての経路を観測できる。「ボスが次のタスクとして指示した」は該当機構が無い（C10）。着手の約束（`committed_start_at`）の到来は検知・通知の層に踏み込むため後続スライス候補（S4）
- **帰結（受容）**: ボスの `update_task` による `in_progress` 化も、web がその後タスクを再取得した時点で遷移として観測されれば促しの対象になる（C10。初回読み込みは「前の状態」が無いため対象外＝AC-11）
- **代替案**: PATCH 送信箇所とチェックイン成功箇所に個別のコールバックを置く — 却下（チェックインは後追い記録で遷移しないことがあり〔C3〕、送信側では遷移の成否が分からない。結果の状態を見るほうが正確で 1 箇所に収まる）

### 決定 3: 「未確認」は既存データから導出し、新しいフラグ・列を持たない（判断 3）

- **採用案**: 見積もり未確認＝そのタスクの `estimated_minutes` が `null`。進め方未確認＝`GET /api/decisions` の応答に、そのタスクの `task_id` を持つ `kind === "mentoring"` の行が 1 件も無い。**いずれか一方でも該当すれば「未確認」**（OR）。`status`（`active`／`revised`／`withdrawn`）は問わない（サーバの `listDecisionsByTaskId` も `status` で絞らない〔C7〕）
- **取得の仕方**: メンタリング記録は遷移を観測した時点で `fetchDecisions()` を呼んで判定する（その場で取得）。`estimated_minutes` が `null` なら記録を取得せずに「未確認」と判定してよい。取得に失敗したときは**促さない**（fail-closed。誤った促しを出さないことを優先する。促しは補助であり、失敗を画面に出す必要も無い）
- **理由**: `tasks` に「促した／スキップした／確認済み」の列を持つ案は、状態の書き込み経路とマイグレーションを増やすうえ、C1 のとおり「確認済み」を機械的に表すフラグが無い現状と二重管理になる。既存データからの導出なら S1 は web だけで閉じる
- **注記**: `estimated_minutes` が非 `null` であることは「ユーザーが確認した値である」ことを機械的には保証しない（C9。担保はプロンプト指示のみ）。本仕様はこの意味を変えず、「値がある＝確認済み」と読む
- **代替案**: (a) `tasks` に `mentoring_prompted_at` のような列を追加 — 却下（上記）。(b) タスク単位の判定 API（`GET /api/tasks/:id/mentoring-status`）を追加 — 却下（C6 のとおり既存 API で判定でき、サーバ変更を要しない）。(c) `useDecisions` を `AppLayout` へ持ち上げて保持 — 却下（チャットでメンタリングを終えた直後に古い一覧で判定してしまう。その場で取得すれば鮮度の問題が無い）

### 決定 4: 1 タスク 1 回。朝会の印付けはデータをプロンプトへ渡す形（判断 4）

- **採用案（頻度）**: 促しを表示したタスクの id をページ内のメモリ（React の state）に集合として持ち、同じ id には再表示しない。「メンタリングする」「あとで」のどちらで閉じても同じ。表示は同時に 1 件で、新しい遷移の促しが古いものを置き換える。自動で消えない（利用者の操作か、次の促しへの置き換えで消える）
- **帰結（受容）**: ページをリロードすると集合は消える。リロード後に同じタスクが再び `todo` → `in_progress` を起こせば再度促される（リロードだけでは再表示されない＝AC-11）
- **採用案（朝会の印付け）**: 判断 4 の (a)「朝会プロンプトへ未確認タスクの情報を渡し、ボスが『着手時に相談』と予約する（指示のみ・深掘りしない）」を採る。ただし C8 のとおりデータをプロンプトへ渡すサーバ変更が要るため **S2** とする（決定 5）。(b) タスクカードのバッジは S3
- **代替案（頻度）**: 促した事実を `localStorage` に持つ — 却下（YAGNI。リロードで再度促されうることは許容範囲であり、永続化は「いつ消すか」の論点を生む）

### 決定 5: S1 は web で完結させ、朝会の印付けとボス側の見積もり提案は S2（server）に分ける

- **採用案**: S1＝促しの表示・判定・導線（web のみ）。S2＝(a) 朝会プロンプトへ未確認タスクの情報を渡し「着手時に相談」と予約する指示、(b) タスク起点メンタリングのターンで対象タスクの `estimated_minutes` が空ならそれを対象タスクのセクションに示し、見積もりを提案して確認済みの値だけ保存する指示（server のみ）
- **理由**: C8 のとおり朝会の印付けはサーバのプロンプト構築（`chat-messages-route.ts`・`persona-prompt.ts`・記録の有無を引く新しい読み取り）を触る。S1 の web 変更と触るファイルが完全に分かれ、それぞれ独立に出荷できる。S1 だけでも「着手時に相談へ入れる」価値が出る。また C8 から、S1 の促しで始めたメンタリングでボスは対象タスクの見積もりが空であることを**知らない**（タスク行に `estimated_minutes` が無い）ため、見積もりの提案はボス側の指示・データが要る＝これも S2 の (b) として同じ層でまとめる
- **代替案**: S1 にサーバ変更を含める — 却下（1 スライスが web ＋ server の両層にまたがり、PR が大きくなる。S1 の受入基準がプロンプト文言の検証にまで広がる）

### 決定 6: 促しは `AppLayout` が保持・描画し、導線の可否条件はタスクカードと同じにする

- **採用案**: 遷移の検知・促しの状態（対象タスク・促し済み集合）・描画は `AppLayout`（共有 `tasksState` を持つ層・C4）が担い、どのビューを表示していても見える位置に置く（具体的な位置はスタイルの範囲で実装が決める）。「メンタリングする」は `onStartMentoring`（`null` ならボタンごと出せない）と `startMentoringDisabled`（送信中・切替中は非活性）をタスクカードと同じ値で使う。`onStartMentoring` が `null` のとき（朝会・夕会セッション中、またはチャット状態が ready でない）は**促し自体を表示しない**（その遷移は「促し済み」にも入れない）
- **理由**: 遷移は tasks ビュー（select・drop）とサイドパネル（チェックイン）の両方から起きる（C2・C3）ため、特定ビューの中に置くと片方の経路で見えない。導線の可否を揃えるのは `docs/features/task-scoped-mentoring.md` 決定 1（`adhoc` 限定）・決定 8（S1a）と同じ規律で、これにより朝会ゲート（判断7）に一切算入されない
- **代替案**: 朝会・夕会中は案内文だけ出してボタンを隠す — 却下（押せない案内は混乱を生む。朝会中の着手操作は稀であり、出さないほうが体験が単純）

### 決定 7: 起動時の文面・オプションは既存の `startMentoring` のまま

- **採用案**: 促しの「メンタリングする」は `startMentoringForTask(task)`（C5）をそのまま呼ぶ。送られる文面は `「<タスク名>」の進め方を見てほしい`、オプションは `mentoring: true`・`mentoringTaskId`
- **理由**: 器（`docs/features/task-scoped-mentoring.md` 決定 3・6・10）を変えない。見積もりの提案をボスに促すのは S2 (b) でプロンプト側が担う
- **代替案**: 促しから起動したときだけ「見積もりと進め方を見てほしい」と送る — 却下（文面の分岐が器の契約に入り、既存テストの前提を崩す。ボスは C8 のとおり見積もりが空かを見えないため、文面を変えても提案の担保にならない）

### 決定 8: 遷移の検知は共有 `tasks` 状態の前回値との比較で行う

- **採用案**: `AppLayout` が共有 `tasks` の前回値を保持し、更新のたびに「前回 `todo` で今回 `in_progress`」のタスクを遷移として抽出する。前回値が無い初回読み込みでは遷移を抽出しない。抽出・判定は純関数として切り出す
- **理由**: 決定 2 の代替案で述べたとおり、経路ごとのコールバックでは遷移の成否が分からない。結果の状態を比較すれば 3 経路を 1 箇所で扱える
- **注記**: 判定（`fetchDecisions()`）は非同期であり、取得完了時点で、下記「採用案（判定の完了順）」の規則に従って促しを表示する。取得中にそのタスクの状態がさらに変わっても追わない（明示的な仮定）
- **採用案（判定の完了順・2026-09-22 改訂）**: **異なるタスクの遷移が連続したときは取得の完了順が遷移の発生順と逆転しうる**ため、判定の完了を次の規則で裁く（#568 の選択肢 (a)）
  - **遷移を 1 件検知するごとに通し番号を 1 つ進め、その遷移に振る**（`fetchDecisions()` を呼ぶかどうかにかかわらず。`estimated_minutes` が `null` で取得を省いて同期的に「未確認」と判定するケースでも進める）
  - 判定で「未確認」と分かった時点（`estimated_minutes` が `null` なら同期的に、そうでなければ `fetchDecisions()` の完了時）で、**その遷移の番号が、表示中（または最後に表示した）促しの番号より新しい場合だけ**促しを表示し、表示したらその番号を「最後に表示した番号」として記録する。新しくなければその判定を捨てる。まだ一度も促しを表示していない間は、どの遷移の番号も「最後に表示した番号」より新しいとみなす
  - 促しを表示しなかった遷移（確認済み・取得失敗・促し済み集合に入っているタスク・決定 6 で促しを出せない）は「最後に表示した番号」を更新しない。したがって**後続の遷移が促しを生まなければ、先行の遷移の判定は捨てられない**
  - 表示の直前にも促し済み集合を確かめ、同じタスクの判定が並行して完了しても 2 回表示しない（FR-6）
- **確立パターンとの違い**: `web/src/use-tasks.ts` の `refresh()` は `generationRef`（29-48 行）を「呼び出しごとに進め、完了時に**最新の呼び出しの番号**と比較する」。本決定は番号の振り方（遷移ごとに進める）は同じだが、**比較先が「最新の遷移の番号」ではなく「最後に表示した促しの番号」**である。`refresh()` は最新の応答だけが意味を持つ（古い応答は常に捨ててよい）のに対し、促しは後続の遷移が促しを生まない限り先行の判定にも意味がある
- **帰結（受容）**: AC-16（新しい遷移の促しが古いものを置き換える）と AC-16b（後に遷移したタスクの促しが先に表示された後で先行の判定が完了しても置き換えない）は取得の完了順に依存せず成立する。先行 A・後続 B がともに取得待ちのとき、(i) A が先に完了すれば A がいったん表示され、B の完了で B に置き換わる。(ii) B が先に完了すれば B が表示され、その後に A の取得が完了しても A は表示しない（B の促しを「あとで」で閉じた後でも同じ。「最後に表示した番号」は B のまま）。最終的な表示はどちらの完了順でも B である。捨てた A は表示していないため促し済み集合に入れず（FR-6 は表示した促しを数える・明示的な仮定 8・10）、後で再び `todo` → `in_progress` になれば促せる
- **改訂の経緯**: 2026-09-22 改訂（#568）。改訂前は「取得完了時点でその遷移が最新の世代番号でなければ表示を更新しない」＝比較先を**最後に検知した遷移**としていたが、PR #567 の Codex レビュー（P2）の指摘どおり、後続の遷移が促しを生まない場合（後続タスクが確認済み・既に促し済み・取得失敗）に先行の適格タスクの促しまで捨て、FR-1・AC-2 に反し結果が応答タイミングに依存した。プロダクトオーナーが計画承認（2026-09-22）で比較先を「最後に表示した促し」へ改める案を選択した
- **代替案（判定の完了順）**: (b) 待ち行列（未確認の促しを順に全部出す） — 却下（「1 タスク 1 回・同時 1 件」の規則〔決定 4・AC-16〕と相性が悪く、UI・状態が増える）。(c) 番号を持たず取得の完了順に上書きする — 却下（最終的な表示が応答タイミングに依存し、#568 の指摘そのもの）。(d) 改訂前の本決定（最後に検知した遷移の番号と比較する） — 却下（上記の経緯）

### 決定 9: 朝会の印付けは、朝会のときだけ別セクションと指示を足す形にし、タスク行（C8）は変えない（S2 (a)）

- **採用案**: `buildPersonaPrompt` の chat の分岐で、`sessionType === "morning"` のときだけ、`MORNING_FLOW_INSTRUCTION` の直後に (1) セクション「見積もり・進め方が未確認のタスク」（行の形は `- #<id> <タイトル>（未確認: <内訳>）`。内訳は「見積もり」「進め方」の一方または両方）と (2) 指示 `MORNING_UNCONFIRMED_TASKS_INSTRUCTION` を積む。対象は `status === "todo"` のタスクに限る。未確認の `todo` タスクが 0 件なら両方とも積まない
- **対象を `todo` に限る理由**: 予約する中身は「着手時に相談」であり、既に着手した（`in_progress`・`paused`）か終えた（`done`）タスクには予約の意味が無い。S1 の促しも `todo` → `in_progress` だけを対象にしている（決定 2）
- **タスク行（`formatTaskLine`）を変えない理由**: C13 のとおり `formatTaskLine` は通知文面・日報抽出のプロンプトとも共有されており、行に見積もりや記録の有無を足すと、朝会と無関係なすべてのプロンプトのトークンと文面生成の入力が変わる。別セクションなら朝会だけに閉じる
- **既存の朝会の指示との関係**: `MORNING_FLOW_INSTRUCTION`（各タスクの所要時間をざっくり見積もって提案し、確認された値だけ保存する）は**変えない**。新しい指示が抑えるのは進め方の深掘り（タスクごとの点検）であり、朝会での見積もりの提案は既存のまま残る。朝会で見積もりが確認・保存されれば、そのタスクは S1 の促し・S3 の印の判定で「見積もり確認済み」になる。必須メンタリングが有効な朝会でも `MENTORING_FLOW_INSTRUCTION`（その日の進め方の点検）が先に積まれる並び（C16・判断8）は変わらない。判断7（朝会はタスクごとの深掘りを求めない）と同じ向きの指示を足すだけで、朝会ゲート（`mentoring-gate.ts`）には触れない
- **トークン量**: 増えるのは未確認の `todo` タスク 1 件につき 1 行と、指示 1 つ分。**上限は設けない**。C8 のタスク一覧が既に全タスクを上限なく並べており、このセクションはその部分集合（`todo` かつ未確認）を短い行で再掲するだけなので、増分はタスク一覧の増分を超えない。上限を設けると「どのタスクを落とすか」の規則と切り詰めの告知が要り、その論点に見合う規模の問題が観測されていない（YAGNI）
- **代替案**: (a) `formatTaskLine` に見積もりと記録の有無を足す — 却下（上記。全用途のプロンプトが変わる）。(b) 朝会の全タスクについて見積もり・記録の有無を出し、未確認の判定をボスに任せる — 却下（判定は既存データから機械的に決まる〔決定 3〕のに LLM に任せる理由が無い。「検知ロジックは純粋関数・LLM は文面のみ」の原則とも合う）。(c) `MORNING_FLOW_INSTRUCTION` を書き換えて朝会での見積もりの提案もやめる — 却下（S2 の範囲は指示を「足す」ことで、朝会の見積もりの扱いを変えるのはオーナーの方向性〔朝会は軽い調整〕の外の判断になる）

### 決定 10: タスク起点メンタリングの見積もりの提案は、見積もりが空のときだけ指示を足し、保存の担保は既存と同じく指示だけにする（S2 (b)）

- **採用案**: `mentoring` が真で対象タスクが解決でき（`resolveMentoringTargetTask`）、その `estimated_minutes === null` のときだけ、対象タスクのまとまり（「対象タスク」→ `MENTORING_TARGET_TASK_INSTRUCTION` →「対象タスクの過去記録」）の後に `MENTORING_TARGET_ESTIMATE_INSTRUCTION` を積む。指示は FR-15 の 4 点を含む
- **「確認済みの値だけ保存」の担保**: C14 のとおり、既存の見積もり（`TASK_ESTIMATE_CONFIRMATION_INSTRUCTION`・`MORNING_FLOW_INSTRUCTION`）と着手の約束（`TASK_COMMITMENT_CONFIRMATION_INSTRUCTION`）はいずれも「確認前に保存してはならない」をプロンプトの指示だけで担保し、機械的なゲートを置かない（`docs/features/task-start-commitment.md` 決定 6）。本決定も同じ作法に揃え、同じ言い回し（「ユーザーが確認（同意または修正）した値だけを」「確認前に保存してはならない」）を使う。随時区間の `update_task` を覆う指示が無い穴（C14）は、この指示がタスク起点メンタリングの範囲で埋める
- **見積もりが空であることの伝え方**: 指示文そのものが「対象タスクの所要時間の見積もりは未設定」と述べる。`formatTaskLine` に見積もりを足さない（決定 9 と同じ理由）
- **提案の頻度**: 指示は「この相談の中で提案する」「保留・拒否されたらこの相談の中で繰り返し求めない」とする。タスク起点メンタリングは相談中の保持で 2 ターン目以降も `mentoring`・`mentoringTaskId` が付く（`docs/features/task-scoped-mentoring.md`）ため、見積もりが空のままなら指示は毎ターン積まれる。繰り返さない旨を指示に含めることで、判断7「深掘りを強制しない」と S1 の「1 タスク 1 回」の向きに揃える
- **代替案**: (a) `update_task` の `estimated_minutes` の説明文に「ユーザーが確認した値のみ」を足す（`committed_start_at` と同じ形） — 却下（ツール定義は `server/src/llm/backends/claude-code-backend.ts` の Zod shape〔123 行・149 行〕と二重に持っており、説明文を足すなら両方を揃えて変える必要がある〔`due_at`・`committed_start_at` は両者の説明文の一致をテストが検証している。`task-tools.ts` のコメント〕。ツール定義の変更は全 chat に効き、S2 の範囲〔タスク起点メンタリングのプロンプト指示〕を超える。指示だけで既存の見積もりの作法と揃う）。(b) `TASK_ESTIMATE_CONFIRMATION_INSTRUCTION` を「作成・更新のとき」へ広げる — 却下（全 chat のプロンプトが変わり、既存テストの前提を崩す）。(c) 見積もりが非 `null` でも「見積もりを見直す」指示を積む — 却下（見積もり確認済みのタスクに提案を重ねるのは提案の頻度を上げる＝強制の側に寄る）。(d) 保存をサーバ側で「直前のユーザー発言に数値があるとき」だけ許すゲート — 却下（機械的なゲートを置かない既存方針〔C1・C11〕に反する）

### 決定 11: サーバ側の「未確認」の判定は S1 と同じ定義を純関数で持ち、メンタリング記録は新しい読み取りで引く（S2）

- **採用案**: (1) `decisions-repository.ts` に、`kind = 'mentoring'` かつ `task_id IS NOT NULL` の行の `task_id` を重複なく返す読み取りを足す（`status` は問わない）。(2) チャットルートは `session.type === "morning"` のターンに限り、プロンプト材料と同じトランザクション（#618）でこれを読み、`PersonaPromptContext` の新しい項目（メンタリング記録を持つタスクの id の集合）として渡す。(3) `buildPersonaPrompt` 側は、その集合と `tasks` から「`estimated_minutes === null` または id が集合に無い」で未確認を判定する（純関数のまま。DB を読まない）
- **項目が未指定のとき**: 朝会でも FR-10 のセクション・FR-11 の指示を積まない（記録の有無が分からないときは印を付けない側に倒す。`includeCurrentDateTime` の「未指定は出さない」と同じ fail-closed の作法）
- **定義を変えない**: 判定は S1 の `isMentoringUnconfirmed`（C17）と同じ規則（OR・`status` を問わない・`kind: "decision"` の行は進め方の確認とみなさない・見積もり 0 は確認済み）。server と web は npm workspaces で分かれ共有経路が無いため、規則は server 側にも同じ形で置く（`persona-prompt.ts` の `TASK_RELATED_RECORD_KIND_LABELS` が web と同じ語彙をあえて二重に持つのと同じ判断）
- **`listRecentDecisions` を変えない**: 「直近の決定」からメンタリング記録を除く #408 AC-42 の契約はそのまま。新しい読み取りは別の関数で、「直近の決定」セクションには何も足さない
- **代替案**: (a) `listDecisionsByTaskId` をタスクの数だけ呼ぶ — 却下（N+1 の読み取り。1 クエリで足りる）。(b) 朝会以外のターンでも読む — 却下（朝会以外では使わない。無駄な DB アクセスを避ける〔`listDecisionsByTaskId` を対象タスクがあるときだけ呼ぶ C15 と同じ作法〕）

### 決定 12: タスクカードの印は `todo` のカードに限り、S1 と同じ判定を、タスクボードのマウント時の取得で行う（S3）

- **採用案**: `TaskBoard` がマウント時に `GET /api/decisions`（`fetchDecisions`）を 1 回呼び、`status === "todo"` のタスクについて `isMentoringUnconfirmed(task, decisions)` で印の有無を決め、`TaskCard` へ渡す。印は文言「未確認」を含むテキストで、カードの中に描く（位置・補足の文言は実装が決める）
- **鮮度**: メンタリングの記録は chat ビューで作られ、`TaskBoard` は tasks ビューへ切り替えるたびにマウントし直される（C18）ため、マウント時の取得で「メンタリングを終えて tasks ビューへ戻ると印が消える」が成り立つ。タスクの `status`・`estimated_minutes` の変化は共有 `tasks` 状態の更新で即座に反映される（再取得は要らない）
- **取得中・取得失敗**: `estimated_minutes` が `null` のタスクは記録を見ずに未確認と決まる（決定 3 の取得の仕方と同じ）ので、取得の成否にかかわらず印を出す。非 `null` のタスクは、取得が完了して記録が無いと分かったときだけ印を出し、取得中・失敗時は出さない。S1 の AC-14（非 `null` のタスクで取得に失敗したら促さない）と揃える。エラーは画面に出さない
- **会の種別を問わない**: 印は表示だけで操作を伴わず、朝会ゲートに算入されない。朝会でボスが「着手時に相談」と予約した対象（決定 9）を画面上でも確かめられるよう、朝会中も出す（S1 の促しを `adhoc` 区間に限る決定 6 は「メンタリングする」の導線の可否に揃えるためで、導線を持たない印には当てはまらない）
- **代替案**: (a) `in_progress`・`paused` のカードにも印を出す — 却下（決定 9 と同じく、予約の対象は着手前のタスク）。(b) `AppLayout` で記録を保持して S1 と共有する — 却下（S1 の決定 3 の代替案 (c) と同じく鮮度の問題が出る。S1 は遷移時の取得を保ち、S3 はマウント時の取得で独立させる）。(c) タスク単位の判定 API を足す — 却下（S1 の決定 3 の代替案 (b) と同じ）。(d) 取得失敗時は印をすべて隠す — 却下（`estimated_minutes` が `null` のタスクは記録を見ずに未確認と分かり、S1 も取得なしで促す）

### 決定 13: S4（着手の約束を過ぎたとき）の出し方は、既存の `commitment_missed` の通知の文面に一言足す形にする（プロダクトオーナー・2026-10-10）

- **決定（オーナーの指示の要旨）**: 既存の `commitment_missed`（約束の時刻を過ぎても未着手）の通知の文面に、見積もり・進め方が未確認なら着手前の相談を勧める一言を足す。**新しい通知・検知ルールは作らず、通知の数と 1 日の上限（#562）に影響させない**
- **帰結**: 「やらないこと」の「検知ルール（`rule_key`）・macOS 通知・ボスの自発発話の新設」は S4 でもやらない。S4 は通知文面の生成（`server/src/notifications/notification-body.ts`、C19）の範囲に閉じる
- **S4 の定義で詰める点（推論・要検証。受入基準は S4 の改訂で書く）**: (1) 文面生成の依頼に「未確認」の判定に要るメンタリング記録の有無を足す経路（C19 のとおり現状は含まれない）。(2) L1〜L3 のフォールバック定型文に一言を足すか。(3) 予約方式の文面（`docs/features/scheduled-nudges.md` 決定 4）のうち、LLM へ人格設定とルール・段階の名前だけを送る形（C）でタスク単位の一言をどう扱うか

## 機能全体の設計

### アーキテクチャ決定

- 変更は web のみ。`AppLayout` に (1) 前回 `tasks` との比較で遷移を抽出、(2) 未確認判定（`estimated_minutes` → 必要なら `fetchDecisions()`）、(3) 促しの対象タスクと促し済み集合の state、および判定の完了順を裁く通し番号と最後に表示した促しの番号（決定 8。促し済み集合とは別に持つ）、(4) 促しコンポーネントの描画、を足す
- 遷移抽出・未確認判定は UI に依存しない純関数として置き、ユニットテストで規則（決定 2・3）を固定する。3 経路の結線は `AppLayout` の統合テストで固定する（C12 のパターン）

### IF（モジュール境界・名称は案）

- 純関数: `detectTaskStarts(previous: Task[], current: Task[]): Task[]`（前回 `todo`・今回 `in_progress` のタスク）。`isMentoringUnconfirmed(task: Task, decisions: DecisionRecord[]): boolean`（決定 3 の OR）
- 表示コンポーネント: `task`・`onStartMentoring`（タスクカードと同じ）・`startMentoringDisabled`・`onDismiss` を受け取り、`role="status"` の要素を描く
- S2 の定数（`server/src/boss/persona-prompt.ts` から `export`。**名称は確定**＝受入基準が参照する）: `MORNING_UNCONFIRMED_TASKS_INSTRUCTION`（決定 9）・`MENTORING_TARGET_ESTIMATE_INSTRUCTION`（決定 10）。セクション見出しは `見積もり・進め方が未確認のタスク:`（確定）
- S2 の `PersonaPromptContext` の追加項目（名称は案）: `mentoredTaskIds?: number[]`（メンタリング記録を持つタスクの id。未指定なら朝会のセクション・指示を積まない＝決定 11）
- S2 のリポジトリ関数（名称は案）: `listMentoredTaskIds(db): Promise<number[]>`（`SELECT DISTINCT task_id FROM decisions WHERE kind = 'mentoring' AND task_id IS NOT NULL`）
- S3 の `TaskCard` の追加プロップ（名称は案）: `mentoringUnconfirmed?: boolean`（真なら印を描く。未指定は偽）

### 実装計画（チケット分解の見通し）

S1 は 1 チケットで足りる規模（3-5 ファイル＋テスト）。分けるなら (1) 純関数＋ユニットテスト → (2) 表示コンポーネント → (3) `AppLayout` の結線＋統合テストの順で、依存は直列。

S2 は 1 チケットで足りる規模（3 ファイル＋テスト 3）。分けるなら (1) `buildPersonaPrompt` の (b)（見積もりの指示。データの追加が要らない）→ (2) リポジトリの読み取り → (3) `buildPersonaPrompt` の (a) とルートの結線、の順。(1) と (2) は独立。

S3 は 1 チケットで足りる規模（2-3 ファイル＋テスト 2）。

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | `todo` → `in_progress` の遷移（select・drop・チェックイン後の再取得）を web が検知し、未確認（見積もり空 または メンタリング記録なし）なら促し（案内文＋「メンタリングする」「あとで」）を `adhoc` 区間に表示。「メンタリングする」は既存のタスク起点メンタリングを起動。1 タスク 1 回（ページ内）。**web のみ・サーバ非変更・マイグレーション無し** | 3-5（＋テスト 2-3） | これだけで「着手の時点で相談へ入れる」価値が出る |
| S2 | ボス側のプロンプト: (a) 朝会に未確認タスクの情報（見積もりの有無・メンタリング記録の有無）を渡し、深掘りせず「着手時に相談」と予約する指示を足す。(b) タスク起点メンタリングのターンで対象タスクの見積もりが空ならそれを示し、見積もりを提案して確認済みの値だけ保存する指示を足す。**server のみ・web 非変更・マイグレーション無し** | 3-4（＋テスト 3） | S1 がマージされてから |
| S3 | タスクカードに未確認の印（バッジ）を表示する（判断 4 の (b)）。web のみ | 2-3（＋テスト 2） | S2 がマージされてから（出荷順の指定。S3 が使うのは S1 の判定関数で、S2 への技術的な依存は無い） |
| S4 | 着手の約束（`committed_start_at`・`docs/features/task-start-commitment.md`）を過ぎたときにも促す。**出し方は決定済み**（決定 13・オーナー 2026-10-10）: 既存の `commitment_missed` の通知の文面に、未確認なら着手前の相談を勧める一言を足す。新しい通知・検知ルールは作らず、通知の数と 1 日の上限（#562）に影響させない。受入基準は未記載（S4 の改訂で書く） | 2-3（概算・推論） | S1 がマージされてから（出し方は決定済み） |

実装対象: S2

## やらないこと

- **着手のブロック・メンタリング完了の強制**（理由: 決定 1。判断7「深掘りを強制しない（現状維持）」と既存方針 C11 に従う）
- **`tasks` への新列（促した／スキップした／確認済みフラグ）や DB マイグレーション**（理由: 決定 3。既存データから導出できる）
- **ボスの「次のタスクとして指示する」機能**（理由: 該当機構が無く〔C10〕、着手のトリガーは `todo` → `in_progress` で足りる。決定 2）
- **`paused` → `in_progress`（再開）での促し**（理由: 再開は着手ではない。決定 2）
- **検知ルール（`rule_key`）・macOS 通知・ボスの自発発話の新設**（理由: S1 は web の画面内の促しに限る。S4 も既存の `commitment_missed` の文面に一言足すだけで、新しい通知・ルールは作らない〔決定 13〕）
- **朝会ゲート（`mentoring-gate.ts`）の変更・判断7 の再検討**（理由: オーナー決定済み〔現状維持〕。促しは `adhoc` 区間のみ〔決定 6〕で朝会ゲートに算入されない）
- **`startMentoring` の文面・オプション・保持スコープの変更**（理由: 決定 7。器は `docs/features/task-scoped-mentoring.md` が定め、本仕様は呼ぶだけ）
- **`docs/features/task-scoped-mentoring.md` の改訂**（理由: 同じ周に別の改訂〔#438 S3〕が進行中。本仕様は参照のみ）
- **促しの永続化（`localStorage`・サーバ保存）**（理由: 決定 4。リロード後の再促しを許容する）
- **新しい API エンドポイントの追加**（理由: 決定 3 の代替案 (b)。`GET /api/decisions` で判定できる）
- **見積もりの入力 UI**（理由: 見積もりはボスとの会話で確認・保存する既存方針〔C9〕。S2 (b) がボス側の提案を担う）
- **`formatTaskLine`（タスク一覧・対象タスクの行）の変更**（理由: 決定 9。通知文面・日報抽出と共有しており、朝会に閉じない）
- **`MORNING_FLOW_INSTRUCTION`・`TASK_ESTIMATE_CONFIRMATION_INSTRUCTION`・`MENTORING_FLOW_INSTRUCTION`・`MENTORING_TARGET_TASK_INSTRUCTION` の文言の変更**（理由: 決定 9・10。S2 は指示を足すだけ）
- **ボスのツール定義（`create_task`・`update_task`・`record_mentoring`）の変更、見積もりの保存への機械的なゲート**（理由: 決定 10。担保は既存と同じく指示だけ）
- **`listRecentDecisions` の変更（「直近の決定」にメンタリング記録を入れること）**（理由: 決定 11。#408 AC-42 の契約を保つ）
- **朝会以外の会（夕会・随時）での未確認タスクの一覧の提示**（理由: 決定 9。オーナーの方向性は朝会の印付け。随時区間は S1 の促しが担う）
- **`todo` 以外のタスクへの印・朝会の一覧への掲載**（理由: 決定 9・12。予約の対象は着手前のタスク）

## 受入基準（S1）

> S1 の範囲に収める（S1 は #566・PR #572 で出荷済みのため `[x]`）。促しの可否は**出る側・出ない側の両方向**を固定する。「デモで確認」は jsdom で再現できない実ブラウザの確認項目で、自動テストの受入基準とは分ける。決定 2 の帰結（ボスの `update_task` による遷移を web が事後の再取得で観測した場合）は同じ差分検知で扱われるが、受入基準には載せず明示的な仮定 7 に留める。

### 促しが出る（決定 2・3）

- [x] AC-1 `estimated_minutes` が `null` のタスクが `todo` → `in_progress` になると、促しが表示される（メンタリング記録の有無にかかわらず）
- [x] AC-2 `estimated_minutes` が非 `null` で、`GET /api/decisions` の応答にそのタスクの `task_id` を持つ `kind: "mentoring"` の行が 1 件も無いタスクが `todo` → `in_progress` になると、促しが表示される
- [x] AC-3 `todo` → `in_progress` がタスクカードのステータス select で起きたとき、促しが表示される
- [x] AC-4 `todo` → `in_progress` がタスクボードのカラムへのドラッグ＆ドロップで起きたとき、促しが表示される
- [x] AC-5 チェックインの `task_start` 送信成功後の再取得でタスクが `todo` → `in_progress` になっていたとき、促しが表示される
- [x] AC-6 「あとで」で促しを閉じた後、別の未確認タスクが `todo` → `in_progress` になると、そのタスクの促しが表示される
- [x] AC-7 促しにはそのタスクのタイトルが含まれる
- [x] AC-8 促しは `role="status"` の要素として描かれる

### 促しが出ない（決定 2・3・4・6・8）

- [x] AC-9 `estimated_minutes` が非 `null` で、そのタスクの `task_id` を持つ `kind: "mentoring"` の行が 1 件以上あるタスクが `todo` → `in_progress` になっても、促しは表示されない
- [x] AC-10 AC-9 の判定は行の `status` を問わない（`withdrawn` の mentoring 行 1 件だけでも「確認済み」として促しは表示されない）
- [x] AC-11 初回読み込みの時点で既に `in_progress` のタスクは、未確認でも促しは表示されない
- [x] AC-12 `todo` → `in_progress` 以外の遷移（`paused` → `in_progress`、`in_progress` → `paused`、`in_progress` → `todo`、`todo` → `done`）では、タスクが未確認でも促しは表示されない
- [x] AC-13 同じページ内で、促しを表示したタスクが再び `todo` → `in_progress` になっても、促しは表示されない（1 回目を「あとで」で閉じた場合・「メンタリングする」で閉じた場合のどちらも）
- [x] AC-14 `estimated_minutes` が非 `null` のタスクで `GET /api/decisions` の取得が失敗したとき、促しは表示されない
- [x] AC-15 タスクカードの「メンタリングする」が出ない条件（朝会・夕会セッション中、またはチャット状態が ready でない）では、未確認タスクが `todo` → `in_progress` になっても促しは表示されない
- [x] AC-16 促しが表示されている間に別の未確認タスクが `todo` → `in_progress` になると、表示される促しは新しいタスクの 1 件だけに置き換わる（2 件同時に表示されない）
- [x] AC-16b 先に遷移したタスク A（`estimated_minutes` 非 `null`・`GET /api/decisions` の取得待ち）の取得が、後に遷移したタスク B（`estimated_minutes` が `null`）の促しが表示された後に「未確認」の結果（A の `task_id` を持つ `kind: "mentoring"` の行が 0 件）で完了しても、表示される促しは B の 1 件のままで A に置き換わらない
- [x] AC-16c 先に遷移したタスク A（`estimated_minutes` 非 `null`・`GET /api/decisions` の取得待ち）の後に、確認済みのタスク B（`estimated_minutes` 非 `null` かつ B の `task_id` を持つ `kind: "mentoring"` の行が 1 件以上）が `todo` → `in_progress` になり B の促しが表示されなかったとき、A の取得が「未確認」の結果で完了すると A の促しが表示される
- [x] AC-16d 同じページで促しを表示済みのタスク B（1 回目の促しを「あとで」で閉じ、`todo` に戻したもの）がある状態で、タスク A（`estimated_minutes` 非 `null`・`GET /api/decisions` の取得待ち）が遷移した後に B が再び `todo` → `in_progress` になり B の促しが表示されなかったとき、A の取得が「未確認」の結果で完了すると A の促しが表示される
- [x] AC-16e 先に遷移したタスク A（`estimated_minutes` 非 `null`・`GET /api/decisions` の取得待ち）の後に、タスク B（`estimated_minutes` 非 `null`）が `todo` → `in_progress` になり B の判定の `GET /api/decisions` の取得が失敗したとき、A の取得が「未確認」の結果で完了すると A の促しが表示される

> AC-16b〜16e は、A の取得の完了を B の遷移より後にずらす入力で検証する（決定 8）。AC-16c〜16e は比較先を「最後に検知した遷移」に戻す変異（改訂前の決定 8・代替案 (d)）で落ち、AC-16b は番号の比較をやめて取得の完了順に上書きする変異（代替案 (c)）で落ちる。後続の遷移が決定 6 の条件（朝会・夕会中、またはチャット状態が ready でない）で促しを生まないケースは、同じ条件が A の取得完了時にも続くのが通常で先行の表示を観測しにくいため受入基準に載せない（決定 8 の規則は同じに働く）。

### 操作（決定 1・6・7）

- [x] AC-17 促しの「メンタリングする」を押すと、タスクカードの「メンタリングする」を押したときと同じ結果になる（chat ビューへ切り替わり、`「<タスク名>」の進め方を見てほしい` が `mentoring: true`・`mentoringTaskId: <タスク id>` で送信される）
- [x] AC-18 促しの「メンタリングする」を押すと、促しが消える
- [x] AC-19 促しの「あとで」を押すと、促しが消える
- [x] AC-20 促しの「あとで」を押しても、サーバへの送信（fetch）は発生しない
- [x] AC-21 チャットが送信中または会の切替中のとき、促しの「メンタリングする」は非活性である（タスクカードの同名ボタンと同じ条件）
- [x] AC-22 促しの表示・非表示にかかわらず、`todo` → `in_progress` にしたタスクは `in_progress` として表示される（遷移をブロックしない）

## 受入基準（S2）

> S2 の範囲に収める。指示文・セクションは**積まれる側と積まれない側の両方向**を固定する。「`buildPersonaPrompt` に渡す」と書いた項目は純関数のユニットテスト、「チャットルートへ送る」と書いた項目は実 SQLite（`:memory:` か一時ファイル）とモックの LLM で `POST /api/sessions/:id/messages` を通し、LLM へ渡った system プロンプトを観測する統合テストで判定する。指示文の照合は `export` した定数で行う。以下「未確認セクション」はセクション見出し `見積もり・進め方が未確認のタスク:` で始まるセクション、「予約の指示」は `MORNING_UNCONFIRMED_TASKS_INSTRUCTION`、「見積もりの指示」は `MENTORING_TARGET_ESTIMATE_INSTRUCTION` を指す（この 2 つの定数名と見出しは IF で確定）。`mentoredTaskIds` は IF の案の名称で、実装が名称を変えたらその名称に読み替える（仮定 14）。時刻を固定する場合はローカル日付基準（`new Date(y, m, d, h)` 由来）で組み、TZ 非依存にする。

### 朝会の未確認セクションと予約の指示が積まれる（決定 9・11）

- [ ] AC-23 `buildPersonaPrompt` に `purpose: "chat"`・`sessionType: "morning"`・`mentoredTaskIds: []` と、`status: "todo"`・`estimated_minutes: null` のタスクを渡すと、プロンプトは未確認セクションを含み、そのセクションにそのタスクの `#<id>` とタイトルを含む行がある
- [ ] AC-24 AC-23 の条件で、`status: "todo"`・`estimated_minutes: 30`・id が `mentoredTaskIds` に無いタスクを渡すと、未確認セクションにそのタスクの `#<id>` とタイトルを含む行がある
- [ ] AC-25 AC-23 の条件で未確認の `todo` タスクが 1 件以上あるとき、プロンプトは予約の指示を含む
- [ ] AC-26 AC-25 のプロンプトで、予約の指示は朝会のフロー指示（`これは朝会` で始まる文）より後に現れる
- [ ] AC-27 `estimated_minutes: null` かつ id が `mentoredTaskIds` に無い `todo` タスクの行は、内訳に「見積もり」と「進め方」の両方を含む
- [ ] AC-28 `estimated_minutes: null` かつ id が `mentoredTaskIds` に在る `todo` タスクの行は、内訳に「見積もり」を含み「進め方」を含まない
- [ ] AC-29 `estimated_minutes: 0` かつ id が `mentoredTaskIds` に無い `todo` タスクの行は、内訳に「進め方」を含み「見積もり」を含まない（見積もり 0 は確認済み）
- [ ] AC-30 予約の指示の定数は、文字列 `着手時に相談` を含む

### 朝会の未確認セクションと予約の指示が積まれない（決定 9・11）

- [ ] AC-31 `sessionType: "morning"` で、未確認の `todo` タスク（`estimated_minutes: null`）と一緒に、`estimated_minutes: 30` かつ id が `mentoredTaskIds` に在る `todo` タスクを渡すと、未確認セクションは存在し、後者の `#<id>` を含む行は無い
- [ ] AC-32 AC-31 の後者を `estimated_minutes: 0` かつ id が `mentoredTaskIds` に在る `todo` タスクに替えても、未確認セクションは存在し、そのタスクの `#<id>` を含む行は無い
- [ ] AC-33 `sessionType: "morning"`・`mentoredTaskIds: []` で、未確認の `todo` タスク 1 件と一緒に渡した `estimated_minutes: null` のタスクは、`status` が `in_progress`・`paused`・`done` のいずれかなら未確認セクションに `#<id>` を含む行を持たない（3 つの状態それぞれで確かめる）
- [ ] AC-34 `sessionType: "morning"` で未確認の `todo` タスクが 0 件のとき、プロンプトは未確認セクションも予約の指示も含まない
- [ ] AC-35 未確認の `todo` タスクがあっても、`sessionType` が `adhoc`・`evening`・未指定のいずれかなら、プロンプトは未確認セクションも予約の指示も含まない（3 つそれぞれで確かめる）
- [ ] AC-36 未確認の `todo` タスクがあり `sessionType: "morning"` でも、`purpose` が `notification`・`daily-report` なら、プロンプトは未確認セクションも予約の指示も含まない（2 つそれぞれで確かめる）
- [ ] AC-37 `sessionType: "morning"`・`purpose: "chat"` で未確認の `todo` タスクがあっても、`mentoredTaskIds` が未指定なら、プロンプトは未確認セクションも予約の指示も含まない
- [ ] AC-38 `sessionType: "morning"` で、`estimated_minutes` だけが異なる（`null` と `30`）同じ `todo` タスクを渡した 2 つのプロンプトの「現在のタスク一覧」セクションは同じ文字列である（タスク一覧の行は見積もり・メンタリング記録の有無を含まない。`formatTaskLine` 不変）

### 朝会のチャットルートの結線（決定 11）

- [ ] AC-39 朝会のセッションへチャットルートで送ると、`kind: "mentoring"` の行が 1 件も無く `estimated_minutes: 30` の `todo` タスクについて、LLM へ渡った system プロンプトの未確認セクションにそのタスクの `#<id>` を含む行がある
- [ ] AC-40 朝会のセッションへチャットルートで送ると、`kind: "mentoring"`・`status: "withdrawn"` の行を 1 件だけ持つ `estimated_minutes: 30` の `todo` タスクは、system プロンプトの未確認セクションに行を持たない（記録の `status` を問わない）
- [ ] AC-41 朝会のセッションへチャットルートで送ると、`kind: "decision"` の行だけを持つ `estimated_minutes: 30` の `todo` タスクは、system プロンプトの未確認セクションに `#<id>` を含む行がある（決定の記録は進め方の確認とみなさない）
- [ ] AC-42 随時（`adhoc`）のセッションへチャットルートで送ると、未確認の `todo` タスクがあっても、system プロンプトは未確認セクションも予約の指示も含まない

### タスク起点メンタリングの見積もりの指示（決定 10）

- [ ] AC-43 `buildPersonaPrompt` に `purpose: "chat"`・`mentoring: true`・`mentoringTaskId: <id>` と、その id の `estimated_minutes: null` のタスクを渡すと、プロンプトは見積もりの指示を含む
- [ ] AC-44 AC-43 で対象タスクの `status` が `in_progress`（S1 の促しから入ったとき）でも、プロンプトは見積もりの指示を含む（対象タスクの `status` を問わない）
- [ ] AC-45 AC-43 で対象タスクの `estimated_minutes` が `30` なら、プロンプトは見積もりの指示を含まない
- [ ] AC-46 AC-43 で対象タスクの `estimated_minutes` が `0` なら、プロンプトは見積もりの指示を含まない
- [ ] AC-47 `estimated_minutes: null` のタスクがあっても、`mentoring: false`（`mentoringTaskId` を指定）なら、プロンプトは見積もりの指示を含まない
- [ ] AC-48 `mentoring: true` で `mentoringTaskId` が未指定なら、`estimated_minutes: null` のタスクがあっても、プロンプトは見積もりの指示を含まない
- [ ] AC-49 `mentoring: true` で `mentoringTaskId` が `tasks` に無い id なら、`estimated_minutes: null` のタスクがあっても、プロンプトは見積もりの指示を含まない
- [ ] AC-50 AC-43 のプロンプトで、見積もりの指示は `MENTORING_TARGET_TASK_INSTRUCTION` より後に現れる
- [ ] AC-51 AC-43 のプロンプトで、「対象タスク」セクションの直後のセクションは `MENTORING_TARGET_TASK_INSTRUCTION` である
- [ ] AC-52 AC-43 に対象タスクの過去記録（`taskRelatedRecords` 1 件以上）を足したプロンプトで、見積もりの指示は「対象タスクの過去記録」セクションより後に現れる
- [ ] AC-53 見積もりの指示の定数は、文字列 `estimated_minutes` と `確認前に保存してはならない` を含む
- [ ] AC-54 随時（`adhoc`）のセッションへチャットルートで `mentoring: true`・`mentoringTaskId: <id>` を送ると、対象タスクの `estimated_minutes` が `null` のとき、LLM へ渡った system プロンプトは見積もりの指示を含む
- [ ] AC-55 AC-54 で対象タスクの `estimated_minutes` が `30` のとき、system プロンプトは見積もりの指示を含まない

> AC-23〜AC-38・AC-43〜AC-53 は `buildPersonaPrompt` の純関数で、AC-39〜AC-42・AC-54・AC-55 は結線で判定する。AC-44 は見積もりの指示に対象タスクの `status === "todo"` の条件を足す変異で落ちる。AC-29・AC-32・AC-46 の見積もり 0 は、`estimated_minutes === null` を真偽値の判定（`!estimated_minutes`）に変える変異で落ちる。AC-33 は対象を `todo` に限る条件を外す変異で、AC-37 は未指定を空集合として扱う変異で落ちる。既存の「直近の決定」にメンタリング記録を入れない契約（#408 AC-42）は既存テストが固定しており、S2 は変えない（決定 11）。

## 受入基準（S3）

> S3 の範囲に収める。印の有無は**出る側・出ない側の両方向**を固定する。`TaskBoard` の描画テストは `GET /api/decisions` の応答（成功・失敗・未完了）を fetch のモックで与える。「印」は決定 12 の文言「未確認」を含むテキストを指す。時刻・暦日を扱わないため TZ 非依存。

### 印が出る（決定 12）

- [ ] AC-56 `status: "todo"`・`estimated_minutes: null` のタスクのカードに印が表示される
- [ ] AC-57 `status: "todo"`・`estimated_minutes: 30` で、`GET /api/decisions` の応答にそのタスクの `task_id` を持つ `kind: "mentoring"` の行が 1 件も無いタスクのカードに印が表示される
- [ ] AC-58 `status: "todo"`・`estimated_minutes: 30` で、そのタスクの `task_id` を持つ行が `kind: "decision"` だけのタスクのカードに印が表示される
- [ ] AC-59 `GET /api/decisions` の取得が失敗しても、`status: "todo"`・`estimated_minutes: null` のタスクのカードに印が表示される

### 印が出ない（決定 12）

- [ ] AC-60 `status: "todo"`・`estimated_minutes: 30` で、そのタスクの `task_id` を持つ `kind: "mentoring"` の行が 1 件以上あるタスクのカードに印は表示されない
- [ ] AC-61 AC-60 の判定は行の `status` を問わない（`withdrawn` の mentoring 行 1 件だけでも印は表示されない）
- [ ] AC-62 `status: "todo"`・`estimated_minutes: 0` で、そのタスクの `task_id` を持つ `kind: "mentoring"` の行が 1 件以上あるタスクのカードに印は表示されない
- [ ] AC-63 `estimated_minutes: null` のタスクでも、`status` が `in_progress`・`paused`・`done` のいずれかならカードに印は表示されない（3 つの状態それぞれで確かめる）
- [ ] AC-64 `GET /api/decisions` の取得が失敗したとき、`status: "todo"`・`estimated_minutes: 30` のタスクのカードに印は表示されない
- [ ] AC-65 `GET /api/decisions` の取得が完了していない間、`status: "todo"`・`estimated_minutes: 30` のタスクのカードに印は表示されない

### 状態の変化と表示の条件（決定 12）

- [ ] AC-66 印が表示されている `todo` のタスクをカードの select で `in_progress` にすると、`GET /api/decisions` を再取得しなくても、そのカードから印が消える（共有 `tasks` 状態の更新で即座に反映される）
- [ ] AC-67 `AppLayout` で、tasks ビューを表示した時点の `GET /api/decisions` の応答ではタスク X（`todo`・`estimated_minutes: 30`）の mentoring 行が 0 件で印が表示され、他のビューへ切り替えて戻ったときの応答では X の mentoring 行が 1 件あるとき、X のカードの印は表示されない（ビューの切替ごとに再取得する）
- [ ] AC-68 朝会のセッション中（タスクカードの「メンタリングする」が出ない条件）でも、未確認の `todo` タスクのカードに印が表示される

> AC-62 は `estimated_minutes === null` を真偽値の判定に変える変異で、AC-63 は対象を `todo` に限る条件を外す変異で、AC-65 は取得完了前に記録 0 件として判定する変異で落ちる。

## デモで確認する項目（実ブラウザ・自動テストの受入基準とは別）

> jsdom で再現できない実ブラウザの確認項目。`/demo` で確認し、上の受入基準の代わりにはしない。

- 実 Chrome で、カードのドラッグ操作・select・チェックインの「着手」の 3 経路から促しが見える位置に出ること（どのビューを表示していても見えること）
- 促しの「メンタリングする」→ chat ビューでボスの応答が返り、`record_mentoring` の記録がそのタスクに紐づくこと（既存の器の動作確認。DB の `decisions.task_id` で同期）
- 同じタスクをもう一度 `todo` に戻して `in_progress` にしても促しが出ないこと
- （S2）朝会で、未確認の `todo` タスクについてボスが深掘りせず「着手時に相談」と予約すること（LLM の応答は受入基準の対象外。指示が積まれることは AC-25 が固定する）
- （S2）見積もりが空のタスクで「メンタリングする」から相談すると、ボスが見積もりを提案し、同意した後にだけ `tasks.estimated_minutes` が保存されること（DB ポーリングで同期）。提案を断ると同じ相談の中で繰り返し求められないこと
- （S3）実 Chrome で、tasks ビューの `todo` のカードに印が見え、メンタリングを終えて tasks ビューへ戻ると印が消えること

## 明示的な仮定（受入基準を変えない・実装が変えてよい範囲）

1. 案内文の文言は仮に `「<タスク名>」に着手しました。見積もり・進め方をボスと確認しませんか？` とし、操作の表記は「メンタリングする」「あとで」とする。受入基準が固定するのはタイトルを含むこと・2 操作があること・`role="status"` であることで、文言そのものは実装が整えてよい
2. `estimated_minutes` が `0` のタスクは非 `null` として「見積もり確認済み」に数える（サーバの検証が 0 を許す〔C9〕ため）
3. メンタリング記録の有無は `status` を問わない（決定 3）。`kind: "decision"` の行は進め方の確認とみなさない
4. `GET /api/decisions` の取得失敗は促さない側に倒し、エラーを画面に出さない（決定 3）
5. 促し済み集合はページ内メモリのみで、リロードで消える（決定 4）
6. 促しは自動で消えない（決定 4）
7. ボスの `update_task` による `in_progress` 化も、web が後で再取得して遷移として観測すれば促しの対象になる（決定 2 の帰結）
8. 判定の取得が完了した時点で促しを表示し、取得中の状態変化は追わない。判定の完了順は、遷移の番号が最後に表示した促しの番号より新しいかで裁く。より新しい促しが既に表示されたために捨てた判定のタスクは、表示していないので促し済み集合に入れない（後で再び `todo` → `in_progress` になれば促せる）。表示の直前にも促し済み集合を確かめる（いずれも決定 8）
9. 促しの表示位置（サイドパネル上部かメイン領域上部のいずれか）はどのビューでも見えることを満たす範囲で実装が決める（決定 6）
10. 促しを表示しなかった遷移（確認済み・朝会中・取得失敗）は促し済み集合に入れない
11. （S2）未確認セクションの行の形は `- #<id> <タイトル>（未確認: 見積もり・進め方）`（内訳は該当するものだけ）を案とする。受入基準が固定するのは `#<id>`・タイトル・内訳の語（「見積もり」「進め方」）の有無で、区切り・括弧は実装が整えてよい
12. （S2）予約の指示・見積もりの指示の文言は FR-11・FR-15 の要素を満たす範囲で実装が決める。受入基準が固定するのは AC-30・AC-53 の語だけで、FR-11 (1)(3)・FR-15 (2)(4) の要素は**テストでは担保しない**（指示文の言い回しの検証は恒真か脆いテストになる）。実装チケットのレビューで指示文が要素を満たすかを読み、LLM の振る舞いは「デモで確認する項目」で見る
13. （S2）メンタリング記録を持つタスク id の読み取りは朝会のターンでだけ呼ぶ（決定 11）。朝会以外で呼ばないことは受入基準にしない（呼んでも結果は使われず、観測できる振る舞いが同じため）
14. （S2）`PersonaPromptContext` の追加項目・リポジトリ関数の名称と型（`mentoredTaskIds?: number[]`・`listMentoredTaskIds`）は案で、実装が変えてよい。未指定のとき朝会のセクション・指示を積まない（AC-37）ことは変えない
15. （S2）未確認セクションの行の並びは `listTasks` の並び（タスク一覧と同じ）に従う
16. （S3）印の位置・補足の文言（`title` 属性等）・スタイルは実装が決める。受入基準が固定するのは文言「未確認」を含むテキストであること
17. （S3）S3 の取得（`TaskBoard` のマウント時）と S1 の取得（遷移時）は独立で、1 回の操作で `GET /api/decisions` が 2 回呼ばれることを許容する（ローカルの読み取りで、共有すると決定 3 の代替案 (c) の鮮度の問題が戻る）
