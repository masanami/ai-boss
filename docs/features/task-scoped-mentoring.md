# タスク単位のメンタリング（タスク画面から「メンタリングする」）

## 概要

タスクカードから「メンタリングする」で、**そのタスクを対象にした随時メンタリング**を開始できるようにする。対象タスクは定型文への埋め込みではなく **`mentoringTaskId` をリクエストボディに載せて決定的に**サーバへ渡し、ボスのシステムプロンプトへ「対象タスク」として積む。メンタリングの結論（`decisions.kind = 'mentoring'`）が対象タスクへ確実に紐づくことは、**サーバ側の `task_id` 補完**で担保する（プロンプト指示だけに依存しない）。

新しいテーブル・新しいキー体系は作らない。器（`record_mentoring` の `task_id` 引数・`decisions.kind='mentoring'`・決定ログのタスク別セクション）は既に実装済みであり、欠けている「タスクを起点に始める導線」だけを本スライスで足す（#438）。

> **本改訂（2026-09-20）は S2 を S2a / S2b の 2 スライスに割り、実装対象は S2b（対象タスクの過去記録のプロンプト投入）である。** S1 / S1a / S1b はいずれも出荷済みで、Issue #438 の期待動作のうち残っているのは「ボスが**関連する過去の決定**を踏まえて深掘りできる」（＝ S2b）と「**あとから振り返れる**」（＝ S2a・振り返り導線）の 2 つである。決定 13〜19 と受入基準の「### 対象タスクの過去記録のプロンプト投入（S2b）」「### 振り返り導線（S2a）」節を本改訂で追加した。**S2a の決定も本改訂で確定させたが、起票・実装は S2b のマージ後**（スライス表）。
>
> 過去の改訂: S1b（Issue #476・2026-09-12・決定 10・11・12）／S1a（Issue #474・要件チケット #489・2026-09-11・決定 8・9）。いずれも出荷済みで、S1 の受入基準は覆っていない（S1 は `73c1b20`）。

## 背景・目的

随時メンタリングの導線はチャット画面ヘッダのボタンだけで（`web/src/ChatView.tsx:518`、Issue #411 / 親 #276 判断6）、押すと固定の定型文 `MENTORING_MESSAGE_CONTENT = "今の進め方を見てほしい"` を `mentoring: true` 付きで送る。**どのタスクについてのメンタリングかという情報は送っていない。**

`mentoring: true` の効果は `MENTORING_FLOW_INSTRUCTION`（`server/src/boss/persona-prompt.ts:558-566`）をシステムプロンプトへ積むことだけで、その指示は「ユーザーから**今日の**仕事の進め方（何を・どの順で・どう進めるつもりか）の申告を受けたら…」＝**その日全体**を単位にしている。特定タスクの深掘りを前提にしていない。

一方でデータモデルは既にタスク単位に対応済みである。`record_mentoring` は `task_id` を任意引数で受け取り（`server/src/boss/mentoring-tool.ts:30`）、`decisions.kind='mentoring'` として保存される（同 `:77`）。決定ログ（`web/src/DecisionLog.tsx`）はタスク別セクションに束ねて表示する（#358）。つまり**記録の器だけが先にある**状態で、そこへ書き込む起点が無い。

### 現状の確証（Issue #438 本文との対照）

Issue #438 の本文は起票時点の観察である。実装で裏取りした結果を記録する。

| # | Issue 本文の記述 | 実コードの実態 | 判定 |
|---|---|---|---|
| 1 | 随時メンタリングの導線はタスク情報を送っていない | `ChatView.tsx:20` の定型文を `:518` で `send(MENTORING_MESSAGE_CONTENT, true)`。第2引数は `mentoring: boolean` のみで、タスクを表す引数は無い | 一致 |
| 2 | `MENTORING_FLOW_INSTRUCTION` は「その日全体」を単位にしている | `persona-prompt.ts:558-566`。特定タスクへの言及は無い | 一致 |
| 3 | `record_mentoring` は `task_id` を任意引数で受け `kind='mentoring'` で保存する | `mentoring-tool.ts:30` `task_id: { type: "integer" }`・`:32` `required: ["content"]`。`:59-66` で `findTaskById` による存在検証、`:77` で `kind: "mentoring"` 固定 | 一致 |
| 4 | `task_id` を埋めるようボスへ促す指示が無い | `MENTORING_FLOW_INSTRUCTION` は `content` / `rationale` にしか言及せず、`persona-prompt.ts` に `task_id` を促す文字列は存在しない | 一致 |
| 5 | `TaskCard.tsx` から決定もメンタリング記録も見えない | 表示モード（`TaskCard.tsx:310-338`）は title / description / ボス決定の優先度・締切 / boss_comment / ステータス select / 編集ボタンのみ。編集モードはエビデンス一覧のみ。`decision` の import は無い | 一致 |
| 6 | `DecisionLog.tsx` はタスク別セクションを持つ | `groupDecisionsByTask` でタスク別 `<section>` に束ね、`kind` はラベル表示（`KIND_LABEL.mentoring = "メンタリング"`）。決定とメンタリングは同一セクション内で時系列混在（#358 判断3） | 一致 |
| 7 | 朝会ゲートはセッション内 `kind='mentoring'` の件数で判定する | **件数のみではなく 2 条件の AND**。`mentoring-gate.ts:25` が `mentoringRecordCount > 0 && userMessageCount > 0`。件数は `countMentoringDecisionsBySessionId`（`session_id` スコープ）と当該セッションの `role='user'` 件数（`sessions-routes.ts:144-146`） | **補正あり**（ユーザー発言 1 件以上も完了条件） |

### Issue 本文に無い、設計に影響する実態（A〜E）

- **(A) 過去のメンタリング記録はボスのプロンプトに入らない。** `listRecentDecisions` は `WHERE kind = 'decision'` で **SQL レベルで mentoring 行を除外**する（`decisions-repository.ts:107`、#408 AC-42）。Issue #438 の期待動作「関連する**過去の決定**を踏まえて深掘り」は、プロンプト文脈を変えない限り成立しない（S1 では扱っていない。下記「S1 で満たさないこと」）。
- **(B) `mentoring: true` は既に「LLM を経由しない決定的なリクエストフラグ」である。** `chat-api.ts:196` → `sessions-validation.ts:92-97` → `chat-messages-route.ts:279` → `PersonaPromptContext.mentoring`。対象タスクを同じ経路に載せるのは新機構ではなく、既存経路への 1 フィールド追加になる。
- **(C) 画面間遷移の仕組みが無い。** `setActiveView` は `AppLayout.tsx:158` のナビボタンからしか呼ばれていない。ただし `chatState`（`useChat`）は `AppLayout.tsx:59` に既にリフト済みで、`activeView` も同じ関数コンポーネントの state（`:67`）であるため、コールバックを 1 本子へ通せば「ビュー切替＋送信」は既存状態だけで成立する。
- **(D) プロンプトのタスク一覧には既に `#id` が入っている。** `purpose === "chat"` のとき `includeId` が真になり（`persona-prompt.ts:289`・`:632`）、`- [進行中] #12 タイトル（優先度: 高 / エビデンス: … / 締切: …）` の形で出る。ボスが `record_mentoring` の `task_id` に何を入れるべきかは一意に解決できる。
- **(E) タスク起点の導線を `adhoc` 区間に限れば、朝会ゲートには一切算入されない。** ゲートの件数は `session_id` スコープであり（`sessions-routes.ts:144`）、`record_mentoring` に渡る `sessionId` はチャットルートが渡す現在セッションである（`chat-messages-route.ts:325-326`）。`adhoc` セッションに記録された mentoring 行は朝会セッションの件数に入らないため、**ゲートのコードを 1 行も変えずに現状の判定が保たれる**。本スライスの受入基準が下記「未決の論点（判断7）」から独立できる根拠はここにある。

### Issue #474 の確証（S1a・2026-09-11 時点の実コード）

S1（#470 / 親 #444）は `73c1b20` でマージ済み。その実装に対するセルフレビューの残指摘（#474）を S1a として扱うため、実コードで裏取りした結果を記録する。

| # | 観察 | 実コードの実態 | 判定 |
|---|---|---|---|
| 1 | チャット画面ヘッダの 2 ボタンは送信中に非活性化される | `ChatView.tsx:501` / `:508`（朝会・夕会の開始）・`:521`（随時メンタリング）・`:534`（会の終了）がいずれも `disabled={switching \|\| sending \|\| editingMessageId !== null}` | 一致 |
| 2 | タスクカード導線の可否条件は送信状態を見ていない | `AppLayout.tsx:98-101` の `onStartMentoring` は `chatState.status === "ready" && chatState.sessionType === "adhoc"` のみで絞る。`sending` / `switching` を参照していない | 一致 |
| 3 | 送信中の `send` は無言で破棄される | `use-chat.ts:339-343` の `send` は `if (sendingRef.current \|\| switchingRef.current) { return; }`。**楽観的追加（タイムラインへのユーザー発言の追加）より前**に return するため、画面にも痕跡が残らず、戻り値 `Promise<void>` からも呼び出し元は破棄を判別できない | 一致（破棄はタイムラインにも残らない） |
| 4 | 破棄されてもビュー切替だけは起きる | `AppLayout.tsx:92-96` は `setActiveView("chat")` を**先に**呼び、その後で `void chatState.send(...)`。`send` の早期 return はビュー切替を取り消さない＝「押したのに何も起きない画面」が残る | 一致 |
| 5 | `task?.title ?? ""` は実 UI 経路では到達不能 | `AppLayout.tsx:91` の `find` が探す `tasksState.tasks` と、`TaskBoard.tsx:188-205` がカードを描画する配列は**同一レンダーの同一配列**。ボタンはそのタスクのカード上にしか無い（`TaskCard.tsx:347-354`）ため、`find` が外れる状態でボタンが押されることはない | 一致（到達不能。ただし下記 決定 9 のとおり形として残さない） |

**(F) `editingMessageId` はタスク画面表示中は常に `null` である。** ヘッダの可否条件に含まれる `editingMessageId` は `ChatView` のローカル state（`ChatView.tsx:275`。「編集中は会話状態ではなく一時的な UI 状態であり、タブ切替のアンマウントで失われることを許容する」と明記されている）。`AppLayout.tsx:200-204` は `activeView === "chat"` のときだけ `ChatView` を描画する条件レンダリングであり、タスク画面（`activeView === "tasks"`）ではアンマウントされて編集状態は破棄される。したがって**タスクカードのボタンが押せる時点では `editingMessageId !== null` は常に偽**であり、`sending || switching` だけでヘッダと同じ可否条件になる（決定 8 が `editingMessageId` を `useChat` へリフトせずに済む根拠）。

### Issue #476 の確証（S1b・2026-09-12 時点の実コード）

Issue #476（対象タスクの紐づけがターン単位でしか成立しない）の本文は 2026-09-10 起票時点の観察である。実コードで裏取りした結果を記録する。

| # | Issue 本文の記述 | 実コードの実態 | 判定 |
|---|---|---|---|
| 1 | `mentoringTaskId` はそれを載せたリクエストのターン内でしか成立しない | `chat-messages-route.ts:301` の `mentoringTaskIdForTurn` はリクエストボディから導出される局所変数で、プロンプト（`:315`）とツール実行クロージャ（`:379`）へ渡って終わる。`mentoringTaskId` の非テスト全ヒット（`sessions-validation.ts` / `chat-messages-route.ts` / `persona-prompt.ts` / `boss-tools.ts` / `mentoring-tool.ts` / `chat-api.ts` / `use-chat.ts` / `AppLayout.tsx`）を辿っても、DB 書き込み・モジュールスコープの変数・キャッシュのいずれにも入らない | 一致（**永続化経路は存在しない**を再確認） |
| 2 | web はタスクカード起点の最初の 1 回だけ送る | `AppLayout.tsx:90-97` の `startMentoringForTask` が `send(..., { mentoring: true, mentoringTaskId: taskId })` を 1 回呼ぶだけ。2 ターン目以降は入力欄からの `submitDraft`（`ChatView.tsx:458-465`）が `send(content)` をオプション無しで呼ぶ | 一致 |
| 3 | 2 ターン目以降の `record_mentoring` は `task_id` が `null` で保存される | `mentoring-tool.ts:74` の `explicitTaskId ?? mentoringTaskId ?? null` により、`mentoringTaskId` が `undefined` なら `null` になる。ただし**ボスが自分で `task_id` を指定すれば埋まる**（補完は「ボスが指定しなかったとき」だけ効く）。正確には「必ず `null`」ではなく「**サーバ側補完という担保が外れ、プロンプト依存に戻る**」 | **補正あり**（下記 (G) と併せて読むと、その担保もプロンプトも同時に外れる） |

#### Issue 本文が名指ししていない実態（G〜K）

- **(G) `adhoc` 区間では、2 ターン目に落ちるのは `mentoringTaskId` だけではない——`mentoring` フラグ自体が落ちる。** `chat-messages-route.ts:293-295` の `mentoring` は「朝会 かつ 強制オン」**または**「そのリクエストの `mentoring: true`」であり、タスク起点メンタリングは `adhoc` 限定（決定 1）なので前者は常に偽。2 ターン目の `submitDraft` は `mentoring` を送らないため、`persona-prompt.ts:731-744` の分岐が丸ごと偽になり、**`MENTORING_FLOW_INSTRUCTION`（「点検の結論を `record_mentoring` で 1 件以上記録すること」を含む）・「対象タスク」セクション・`MENTORING_TARGET_TASK_INSTRUCTION` の 3 つが同時にプロンプトから消える**。
  - 帰結: 2 ターン目以降のボスは「記録せよ」という指示自体を受けていない。`record_mentoring` ツールは常に露出しているので（`boss-tools.ts:18-23`）呼べはするが、**呼ぶ動機も、呼んだときに `task_id` を埋める材料（「対象タスク」セクションの `#id`。確証 (D)）も同時に失われている**。
  - したがって #476 を「`task_id` 補完のスコープ」だけの問題として直すと、**「そもそも結論が記録されない」ほうの欠落が残る**。保持スコープの決定は `mentoringTaskId` と `mentoring` の**両方**について要る。
- **(H) `adhoc` セッションはローカル暦日のほぼ全体に渡り、UI からは終了されない。** `use-chat.ts:370-372` が最初の送信時に遅延生成し、`select-restore-session.ts:51-55` が「今日の `ended_at === null` な adhoc」を復元対象にする。会の終了ボタン（`ChatView.tsx:533`）は会中の分岐にしか描画されず、**`adhoc` を終了する導線はどこにも無い**。会（朝会・夕会）を挟んでも adhoc セッションは開いたままで、会の終了後は同じ adhoc セッションへ戻る。
  - 帰結: 「**セッション終了まで保持**」は `adhoc` では実質「**その日いっぱい保持**」を意味する。朝にタスク A のメンタリングを始めたら、夕方の無関係な `record_mentoring` にも A が補完されうる。
- **(I) 同一 `adhoc` セッション内に、対象タスクを持たないメンタリングの導線が別にある。** `ChatView.tsx:516-524` のヘッダボタンは `send(MENTORING_MESSAGE_CONTENT, { mentoring: true })`——**`mentoringTaskId` 無し**の全日単位メンタリング（#411 / 親 #276）である。保持を入れると、タスク A のメンタリングの後にこのボタンで始めた全日単位メンタリングの結論へ A が補完されうる。解除条件はこの経路を必ず扱う必要がある。
- **(J) 保持先として使える既存機構は無い。** サーバに横断的な可変状態（モジュールスコープの `Map` 等）は存在せず、`sessions` テーブルは `id / type / started_at / ended_at / summary` の 5 列のみ（`migrate.ts:136-142`）。保持を入れるなら **新しいマイグレーション v9**（最新は v8・`migrate.ts:307-310`）で列を足すか、プロセス内メモリに新設するかのいずれかになる。列追加の作法は `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT`（`migrate.ts:238` の `messages.interrupted` が先例）で、既存 version は書き換えない（ADR 0005 決定 4）。
- **(K) 朝会ゲートには、保持を `session_id` で閉じる限り波及しない。** ゲートの判定は `isMentoringComplete({ mentoringRecordCount, userMessageCount })`（`mentoring-gate.ts:25`）で、件数は朝会セッションの `session_id` スコープ（`sessions-routes.ts:163-165`）。保持は既存の `record_mentoring` 行の `task_id` を埋めるだけで、**行を増やしも減らしもしない**ため、どの案でもゲートの真偽は変わらない。ただしこれは**保持を `session_id` ごとに閉じることが前提**である——セッションを跨ぐ「現在の対象タスク」を 1 つだけ持つ形にすると、`adhoc` で選んだタスクが朝会の全日単位メンタリングの記録へ混入し、決定ログのタスク軸（#358）の意味が壊れる（ゲートの真偽は変わらないが記録が汚れる）。**保持は必ず `session_id` をキーに含める**ことを制約として置く。

- **(L) タスクは削除できない。** `tasks-routes.ts` が公開するのは `GET /`（`:40`）・`POST /`（`:44`）・`PATCH /:id`（`:72`）のみで、**削除エンドポイントは存在しない**。したがって「一度存在を検証したタスク id が、同じ会話の途中で存在しなくなる」ことは起こらない。**毎ターン `mentoringTaskId` を送る形（決定 10）にしても、2 ターン目以降に `chat-messages-route.ts:180-182` の 404 で発言ごと拒否される事態は構造的に生じない**（#477 が扱う 404 応答の到達可能性は、本決定によって増えない）。

#### S1 の「出荷条件」と実装範囲の差（受入基準の未達ではない）

S1 の出荷条件は「結論はサーバ側補完で**確実に**そのタスクへ紐づく」と書かれている（「概要」およびスライス表 S1 行）。実装がこれを満たすのは **`mentoringTaskId` を載せた起動ターン内に限られる**。一方 **S1 の受入基準（「### `task_id` の補完」節。いずれも「`mentoringTaskId` があるターンで…」という条件節を持つ）はターン単位で書かれており、充足している**。すなわちこれは**受入基準の未達ではなく、概要の約束文と実装範囲の差**であり、**S1 の受入判定を覆さない**。#476（S1b）はこの差を埋めるスライスである。

なお #476 は #471 が入れた欠陥ではない。`mentoring: true` は #411 / 親 #276 以来ターン単位のリクエストフラグであり（確証 (B)）、#471 はその既存設計を踏襲した。検出は #471 のセルフレビュー（severity: low・当時はスコープ外判断）。

### S2 の確証（2026-09-20 時点の実コード）

S2（振り返り導線＋過去記録の投入）の前提を実コードで裏取りした結果を記録する。**仕様の従来の記述と食い違った点は判定欄に「補正」と書いた。**

| # | 従来の記述・起票時の観察 | 実コードの実態 | 判定 |
|---|---|---|---|
| 1 | `listRecentDecisions` が `kind='mentoring'` を SQL レベルで除外する（確証 (A)） | `decisions-repository.ts:108` の `WHERE kind = 'decision'`。**非テストの呼び出し元は `chat-messages-route.ts:285` の 1 箇所のみ** | 一致 |
| 2 | 決定ログはタスク別セクションを持つ | `DecisionLog.tsx:107` が `groupDecisionsByTask(decisions)` を呼び、`:116-122` で `key={section.taskId ?? "unassigned"}` の `<section>` を描画する。**`id` 属性は無い** | 一致（id を付ける余地は `DecisionTaskSection` の `<section>`〔`:56`〕） |
| 3 | S2 は「決定ログの当該セクションへ**アンカー移動**」 | **ハッシュフラグメントを使う前例が無い**。`web/src` 全体で `react-router` も `location.hash` も `scrollIntoView` も用例ゼロ。画面切替は `AppLayout.tsx:68` の `useState<AppView>` だけで、`DecisionLog` は `activeView === "decisions"` のときだけ描画される条件レンダリング（`:237-243`）＝**リンクを押す時点で移動先の DOM が存在しない** | **補正**（決定 15 で「状態 prop ＋プログラム的スクロール」へ改めた） |
| 4 | `mentoring-gate.ts` は 1 行も変えない | `isMentoringComplete` は件数 2 つを受け取る純粋関数（`mentoring-gate.ts:24-26`）で、非テストの呼び出しは `sessions-routes.ts:163` のみ。S2 の設計（読み取り専用の新クエリ・プロンプト・web の導線）はどこからもここへ到達しない | 一致（不可侵が成立する） |
| 5 | S2 の触るファイル数は 8-12 | S2a（web）8・S2b（server）6 の**計 14**。両者は触るファイルが 1 つも重ならず、依存も無い | **補正**（決定 13 で 2 スライスへ分割・スライス表を改めた） |

#### 設計に影響する実態（M〜R）

- **(M) 同じ「mentoring 除外」の契約は 3 箇所にある。** `listRecentDecisions`（#408 AC-42）だけでなく、日報（`collect-daily-report-data.ts:132`・#408 AC-43）と作業ログ（`collect-work-log-data.ts:90`・#408 AC-44）も**それぞれ別の SQL** で `kind = 'decision'` に絞っている。S2b はこの 3 つのいずれも変更しない（「変更しない」節）。
- **(N) 対象タスクに紐づく記録を引く関数が無い。** `decisions-repository.ts` が持つのは `findDecisionById` / `insertDecision` / `listDecisions`（全件・`LEFT JOIN tasks`）/ `listRecentDecisions`（`kind='decision'` の直近 N 件）/ `countMentoringDecisionsBySessionId` の 5 つで、**`task_id` で絞る読み取りは存在しない**。S2b は新規関数を足すことになる（決定 17）。
- **(O) 過去記録を足す前のプロンプトは 2,220 文字。過去記録がどれだけ足すかは測定していない。** `server/dist` の `buildPersonaPrompt` を実際に呼んで計測した結果（タスク 7 件・直近の決定 5 件・当日随時チャット無し・`mentoring: true` ＋対象タスクあり）が 2,220 文字、同条件で `mentoring: false` が 1,565 文字。「当日の随時チャット」ブロックは単独で `MAX_TODAYS_ADHOC_MESSAGES_TOTAL_LENGTH = 4_000`（`persona-prompt.ts:475`）まで許容されている。
  - **この 2,220 文字は S2b が足す過去記録を含まない値であり、「5 件が 4,000 文字の幅に収まる」根拠にはならない**（2026-09-20 の PR #544 レビュー指摘により訂正。以前の本節は収まる根拠として引用していた）。
  - **記録の長さには上限が無い。** `record_decision` / `record_mentoring` の `content` / `rationale` はツールスキーマ（`decision-tool.ts` / `mentoring-tool.ts`）にも `decisions` の TEXT 列（`migrate.ts`）にも長さ制限が無く、**件数を 5 件に絞ってもブロックの長さは無制限**である。長い記録が蓄積したタスクではコンテキスト超過でメンタリングの応答自体が失敗しうる。
  - **測れていないことが、文字数上限を設ける根拠である**（決定 18）。確証 (P) のとおり実運用データの統計も取れていないため、「測っていないから上限は要らない」とは言えない。
- **(P) 1 タスクあたりの記録件数・本文長の実測は取れていない。** ローカルの `server/data/ai-boss.db` は v8 以前のスキーマで `decisions.kind` 列を持たず、`kind` 別の集計が実行できなかった。**決定 16 の「5 件」は実測ではなく既存の慣習（`listRecentDecisions(db, 5)`・`listRecentSessionSummaries(db, 5)`〔`chat-messages-route.ts:285`・`:289`〕）からの決めである。**
- **(Q) `useDecisions` は取得し直さない。** `use-decisions.ts:22-41` はマウント時に 1 回 `fetchDecisions()` するだけで、再取得の導線を持たない。ただし `DecisionLog` は非表示時にアンマウントされる条件レンダリングなので、**決定ログを開くたびに新しいインスタンスがマウントされ、そのつど取得される**。逆に言えば、決定ログを `AppLayout` より上へ持ち上げて常時保持すると「アプリ起動時の 1 回きり」になり、**メンタリング直後に記録したものが反映されない**（決定 14 が「記録の有無で導線を出し分けない」を選ぶ根拠）。
- **(R) jsdom は `scrollIntoView` を実装しない。** `web/src` に用例が無く、既存の自動スクロールは `ChatView.tsx:438-444` の `el.scrollTop = el.scrollHeight`。そのテストは `HTMLElement.prototype.scrollHeight` を差し替えて観測している（`ChatView.test.tsx:1471-1495`）。スクロール容器は `.app-main`（`AppLayout.css:65-68` の `overflow-y: auto`）。防御的フォールバックの先例は `AppLayout.tsx:123` の `typeof event.currentTarget.setPointerCapture === "function"`。
- **(S) 「相談中」は #491 で全日単位へ拡張済み。** `mentoringTarget` は `{ kind: "task" | "day" }` を持ち（`use-chat.ts:78-118`）、`ChatView.tsx:585-596` が kind で文面を出し分ける。**決定 11 の 2「ヘッダ押下は対象タスク無しの状態へ解除」は `docs/features/day-mentoring-consultation.md` 決定 2 により「全日単位の相談中へ置き換え」へ上書き済み**である（出荷済み）。

## ユーザーストーリー

タスクを抱えるオーナーとして、**特定のタスクを指してボスに進め方を相談したい**。チャットの「今の進め方を見てほしい」はその日全体が対象なので、1 件のタスクを綿密に詰めたいときに毎回タスクの内容を説明し直す必要があり、しかも結論がそのタスクに紐づかないため後から辿れない。

## 機能要件

> **本改訂（S2b）の対象は末尾の「（S2b）」を付した 3 項目のみ**。`- [x]` は S1（`73c1b20`）・S1a（#489・`75794aa`）・S1b（#476・`4106645`）で**出荷済み**である。「（S2a）」を付した 2 項目は**次スライスの要件**であり、本改訂では起票も実装もしない（スライス表）。

- [x] タスクカードの表示モードから、そのタスクを対象にしたメンタリングを開始できる
- [x] 「メンタリングする」を押すと、表示中のビューがチャットへ切り替わる
- [x] 「メンタリングする」を押すと、対象タスクを添えたメンタリングの発言が 1 回送信される
- [x] ボスのシステムプロンプトに、対象タスクのタスク行情報（ステータス・id・タイトル・優先度・エビデンス・締切）が「対象タスク」セクションとして積まれる
- [x] メンタリングの結論が対象タスクへ紐づいて記録される（`decisions.task_id` が埋まる）
- [x] 会（朝会・夕会）の最中は、タスクカードにメンタリングの開始導線を出さない
- [x] チャット画面ヘッダの随時メンタリングボタン（その日全体が対象）は `adhoc` 区間で従来どおり表示され、押すと従来どおり `mentoring: true` 付きで送信される
- [x] 送信中（`chatState.sending` が真）は、タスクカードのメンタリング導線を押せない（押せてしまい発言だけが無音で捨てられる状態を作らない）
- [x] セッション切替中（`chatState.switching` が真）は、タスクカードのメンタリング導線を押せない
- [x] タスクカードのメンタリング導線と、チャット画面ヘッダの随時メンタリングボタンの可否条件が一致する
- [x] 対象タスクを解決できないまま、タイトルの欠けた発言（`「」の進め方を見てほしい`）が送信されることがない
- [x] タスク起点のメンタリングを開始すると、どのタスクを相談中かがチャット画面に**見える形**で表示される（S1b）
- [x] 相談中のあいだは、入力欄から送った 2 ターン目以降の発言でも対象タスクがサーバへ伝わり、そのターンの結論が対象タスクへ紐づく（S1b）
- [x] 相談中のあいだは、2 ターン目以降もボスのシステムプロンプトにメンタリングの手順指示と「対象タスク」セクションが積まれ続ける（S1b）
- [x] 相談中の状態は、利用者の明示操作・別のメンタリングの開始・会の開始・会の終了のいずれでも解除できる（S1b）
- [x] 解除したあとの発言は、対象タスクにもメンタリングにも紐づかない（解除が効いていることが外から分かる）（S1b）
- [ ] タスク起点のメンタリングで、ボスが対象タスクに紐づく過去の決定・過去のメンタリング記録を踏まえて深掘りできる（S2b）
- [ ] 過去記録の投入によって、既存の「直近の決定」枠（`kind='mentoring'` を除外する #408 AC-42 の契約）が変わらない（S2b）
- [ ] 対象タスクに過去の記録が無いときは、ボスのシステムプロンプトに空の記録セクションが積まれない（S2b）
- [ ] タスクカードから、そのタスクについて過去に何を相談し何を決めたかを決定ログで読み返せる（S2a）
- [ ] その導線をたどると、決定ログの中の対象タスクのセクションが見える位置に表示される（S2a）

## 技術的な制約・方針

- **変更対象（web・S1 時点＝出荷済み）**: `TaskCard.tsx` / `TaskBoard.tsx` / `AppLayout.tsx` / `chat-api.ts` / `use-chat.ts` / `ChatView.tsx`（既存 `send` 呼び出し 1 行の追随のみ）とそれぞれのテスト。**本改訂（S1a）ではこのうち `chat-api.ts` / `use-chat.ts` / `ChatView.tsx` は対象外**
- **変更対象（server）**: `server/src/sessions/sessions-validation.ts` / `server/src/sessions/chat-messages-route.ts` / `server/src/boss/persona-prompt.ts` / `server/src/boss/boss-tools.ts` / `server/src/boss/mentoring-tool.ts` とそれぞれのテスト
- **変更しない（全スライス共通）**: `server/src/sessions/mentoring-gate.ts`（朝会ゲートの判定）、`server/src/decisions/decisions-repository.ts` の `listRecentDecisions`（`kind='decision'` 除外＝#408 AC-42）、`server/src/reports/collect-daily-report-data.ts` の `kind='decision'` 絞り込み（#408 AC-43）、`server/src/reports/collect-work-log-data.ts` の `kind='decision'` 絞り込み（#408 AC-44）、`RECORD_MENTORING_TOOL` の `required`（`["content"]` のまま）、DB スキーマ（マイグレーション無し）
  - **`DecisionLog.tsx` / `group-decisions-by-task.ts` を変更しないのは S1 / S1a / S1b の制約**である。S2a は `DecisionLog.tsx` にセクション id とスクロールを足す（決定 15）が、`group-decisions-by-task.ts` は S2a でも変更しない（`taskId` を既に持つため）
- **DB スキーマ変更は無い**。`decisions.task_id` は既存列であり、本スライスは書き込み経路を確実にするだけである
- **セッションの遅延生成は既存の `useChat` に任せる**。`send` は活性セッションが無ければ最初の送信時にセッションを作る（`use-chat.ts` の `activeSessionId` JSDoc）。タスク起点でも同じ経路を通るため、セッション生成の分岐を新設しない
- **多重送信の抑止（最後の防波堤）は既存の `useChat` が持つ**。送信中の `send` は無視される（`use-chat.test.ts:628-631`）。この早期 return と `send` の戻り値型（`Promise<void>`）は **S1a でも変更しない**
  - S1（#470）当時はこの制約を「タスクカード側は送信状態を一切見ない」と読んでおり、その帰結が #474（押せてしまい無音で捨てられる）である。**S1a では、可否条件を `AppLayout` が `chatState` から与える**形に改める（下記 決定 8）。`TaskCard` / `TaskBoard` は渡された可否をそのまま反映するだけで、**独自のガード（自前の送信中フラグ・二重クリック抑止）は持たない**——この点は S1 の制約のまま
- **変更対象（S1a）**: `AppLayout.tsx` / `TaskBoard.tsx` / `TaskCard.tsx` とそれぞれのテスト。サーバ側は触らない
- **変更対象（S1b）**: `use-chat.ts` / `ChatView.tsx` / `AppLayout.tsx` とそれぞれのテスト。**サーバ側は 1 行も触らない・マイグレーションもしない**（決定 10）。`chat-api.ts` は既に `options` を body へ載せる形（`chat-api.ts:204-209`）なので変更不要である
  - S1b が変える `AppLayout.tsx` は**起動ハンドラが対象タスクを `useChat` へ渡す行**だけで、S1a が変える可否条件の算出（決定 8）とは別の行である。両スライスは互いの前提になっておらず、どちらを先に出してもよい
- **変更対象（S2b・本改訂の実装対象）**: `server/src/decisions/decisions-repository.ts`（新規クエリ関数）/ `server/src/sessions/chat-messages-route.ts`（結線）/ `server/src/boss/persona-prompt.ts`（セクションの描画）とそれぞれのテスト。**web 側は 1 行も触らない・マイグレーションもしない**（計 6 ファイル）
- **変更対象（S2a・次スライス）**: `web/src/TaskCard.tsx` / `web/src/TaskBoard.tsx` / `web/src/AppLayout.tsx` / `web/src/DecisionLog.tsx` とそれぞれのテスト。**サーバ側は 1 行も触らない**（計 8 ファイル）。S2a と S2b は触るファイルが 1 つも重ならず、どちらを先に出してもよい（本改訂は S2b を先に出す。決定 13）
- 外部送信は Claude API への推論リクエストのみ（ADR 0001）。本スライスは送信内容にタスクのタイトル・締切・優先度を含めるが、これは既にプロンプトのタスク一覧として送っている情報の範囲内であり、送信先も範囲も広がらない
  - **S2b は送信内容に、対象タスクに紐づく過去の決定・メンタリング記録の `content` と `rationale` を追加する。** いずれもローカル SQLite の `decisions` 行であり、送信先は Claude API への推論リクエストのみで変わらない（ADR 0001）。`decisions` の内容は既に「直近の決定」セクションとして同じ経路で送られており、**送信先も情報の種類も広がらない**（増えるのは同種の情報の量である）
- テストで固定時刻を使う場合は `new Date(y, m, d, h)` 由来で導出する（UTC 文字列リテラルで固定しない。ADR 0007 決定 5）。本スライスは日付境界に触らないため `npm run test:tz` は必須ゲートではない
- Claude API・時刻・macOS 通知コマンドはテストでモックする。SQLite はモックしない（CLAUDE.md「テスト方針」）

## 画面・API設計

### 画面（タスクカード）

タスクカードの**表示モード**のアクション行（現在「編集」ボタンだけがある `TaskCard.tsx:331-335` の `div.task-card-actions`）に「メンタリングする」ボタンを追加する。編集モードのフォーム内には置かない。

ボタンを押すと、(1) 表示中のビューがチャットへ切り替わり、(2) 対象タスクを添えたメンタリングの発言が 1 回送信される。

### 画面（チャット面の「相談中」表示・S1b）

相談中（`mentoringTarget !== null`）のあいだ、チャット画面に**対象タスクのタイトルを含む状態表示**と**解除の導線**を出す。

- **表示位置**: チャットのセッションヘッダ行（`ChatView.tsx` のボタン行の直下、既存の `chat-mentoring-blocked` の状態表示〔`ChatView.tsx:547`〕と同じ帯）。会話の流れ（タイムライン）へは混ぜない——状態であって発言ではないため
- **文面**: 対象タスクのタイトルを含む（例: `「{タイトル}」について相談中`）。タイトルは開始時に `useChat` が受け取った値を使う（タスク一覧の再検索をしない。決定 9 と同じ規律）
- **解除の導線**: 同じ帯に置くボタン（例: `相談を終える`）。押すと `mentoringTarget` が `null` になり、表示が消える
- **可視性が要件である**: 決定 10 が (a) ではなく (b) を採った理由は「状態が利用者に見えること」なので、この表示は**任意の装飾ではなく受入基準**である（下記「### 相談中の保持と解除（S1b・Issue #476）」）
- 相談中でないとき（`null`）はこの帯を描画しない（既存の画面と 1 px も変わらない）

### 画面（タスクカードの振り返り導線・S2a）

タスクカードの**表示モード**のアクション行（`編集` と `メンタリングする` が並ぶ `div.task-card-actions`）に、そのタスクの記録を決定ログで読み返す導線を 1 つ追加する。

- **表示条件**: 常時（`adhoc` 限定にしない。決定 14）。記録の有無でも出し分けない
- **押したときの挙動**: 表示中のビューが決定ログへ切り替わり、決定ログ内の対象タスクのセクションが見える位置へスクロールする（決定 15）
- **タスク画面上に記録を一覧表示しない**（「やらないこと」。決定ログを正とし二重表示を作らない）

### 画面（決定ログのセクション id・S2a）

決定ログのタスク別セクション（`DecisionTaskSection` の `<section>`）に `id` 属性を付ける。id はタスク id 由来とし、`task_id` を持たない記録のセクションにも固定の id を与える（決定 15）。既存の見出し・並び順・記録の描画内容は変えない。

### IF（層間の境界となる契約）

```text
TaskCard          onStartMentoring?: ((task: Task) => void) | null  ← S1a で引数を変更
                    ── `?`（未提供＝undefined 許容）は既存どおり維持する
                    ── null のときボタンを描画しない（＝会の最中）
                  startMentoringDisabled: boolean                   ← S1a で追加
                    ── 真のときボタンは描画したまま disabled にする（＝送信中・切替中）
   ↓ props
TaskBoard         onStartMentoring / startMentoringDisabled をそのまま TaskCard へ
                  渡す（判断に関与しない）
   ↓ props
AppLayout         chatState.status === "ready" かつ sessionType === "adhoc" の
                  ときだけハンドラを渡し、それ以外は null を渡す。
                  startMentoringDisabled = chatState.sending || chatState.switching。
                  ハンドラは setActiveView("chat") と chatState.send(...) を呼ぶ
   ↓
use-chat            mentoringTarget: { id: number; title: string } | null   ← S1b で追加
                    ── 「相談中」の対象タスク。null は相談中でない
                    ── startMentoring(task) で設定／置き換え
                    ── clearMentoringTarget() で解除。startSession / endSession も解除する
use-chat.send(content, options?)
                  options: { mentoring?: true; mentoringTaskId?: number }
                  ── S1b: options が未指定でも mentoringTarget が非 null なら
                     { mentoring: true, mentoringTaskId: mentoringTarget.id } を
                     **send 自身が付加する**（呼び出し側の渡し忘れに依存しない。決定 10）
   ↓
chat-api.sendChatMessage(sessionId, content, handlers, signal?, replaceFromMessageId?, options?)
                  options: 上と同じ形。undefined-as-absent（キーは値があるときだけ body に載る）
   ↓ POST /api/sessions/:id/messages
body              { content, mentoring?: true, mentoringTaskId?: number }
   ↓
chat-messages-route
                  mentoring の合成は現状のまま（朝会かつ強制オン、または requestedMentoring）。
                  mentoringTaskId は mentoring が真のときだけ後段へ渡す
   ↓
buildPersonaPrompt(persona, { ..., mentoring, mentoringTaskId })
                  純粋関数のまま。mentoringTaskId は context.tasks から引いて描画する
executeBossTool(db, sessionId, name, input, mentoringTaskId?)
                  record_mentoring の task_id 未指定時のフォールバックとして使う
```

### IF（S2b・対象タスクの過去記録の投入）

```text
decisions-repository
  listDecisionsByTaskId(db, taskId, limit): TaskRelatedRecord[]   ← S2b で新設
    ── WHERE task_id = ?（kind で絞らない）
    ── ORDER BY created_at DESC, id DESC / LIMIT ?
    ── 既存の listRecentDecisions は一切変更しない（#408 AC-42）
   ↓
chat-messages-route
    mentoringTaskIdForTurn が定まるターンにだけ呼び、結果を
    buildPersonaPrompt へ渡す（件数上限はここで与える。決定 16）
   ↓
buildPersonaPrompt(persona, { ..., mentoring, mentoringTaskId, <過去記録のフィールド> })
    純粋関数のまま（DB を読まない）。mentoring が真 かつ mentoringTaskId が
    context.tasks に在る かつ 記録が 1 件以上のときだけセクションを描画する。
    順序は 対象タスク → MENTORING_TARGET_TASK_INSTRUCTION → 過去記録 に
    固定し、既存 2 つの間には挟まない（決定 19）
```

> **型・関数・フィールドの名前は仮置きである。** `listDecisionsByTaskId` / `TaskRelatedRecord` / `PersonaPromptContext` の新フィールド名・セクションの見出し文言は、受入基準が依存しない軽微・可逆な選択として実装側の裁量に委ねる（決定 8 の `startMentoringDisabled` と同じ扱い）。

### IF（S2a・振り返り導線）

```text
TaskCard          onShowTaskRecords?: ((task: Task) => void) | null   ← S2a で追加
                    ── 既存の onStartMentoring と同じ形（未提供＝undefined 許容）
   ↓ props
TaskBoard         そのまま TaskCard へ中継する（判断に関与しない）
   ↓ props
AppLayout         ハンドラは activeView を決定ログへ切り替え、同時に
                  「どのタスクのセクションへ寄せるか」を state に持つ。
                  消費の通知を受けたらその state を null に戻す（決定 15）
   ↓ props
DecisionLog       対象タスクの id と「消費した」ことを伝えるコールバックを
                  受け取る。取得完了後にそのセクションの要素へプログラム的に
                  スクロールし、**スクロールの成否にかかわらず**コールバックを
                  呼ぶ（決定 15）。セクションには id 属性を付ける
```

> `DecisionLog` の新しい prop 名・state 名・id の前置詞は仮置きである（上と同じ扱い）。**id がタスク id 由来であること**は決定 15 で固定する。

### API（`POST /api/sessions/:id/messages`）

| 追加フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `mentoringTaskId` | integer | 任意 | このターンのメンタリングの対象タスク id。`mentoring: true` と同時にのみ指定できる |

`mentoringTaskId` の形の検証は、既存の `replaceFromMessageId` と同じ `isPositiveInteger`（`server/src/sessions/sessions-validation.ts:59`）を使う。したがって 0・負数・小数・文字列・真偽値はいずれも 400 になる。

| 状況 | 応答 |
|---|---|
| `mentoringTaskId` が正の整数でない（0・負数・小数・文字列・真偽値） | 400 |
| `mentoringTaskId` があり `mentoring: true` が無い | 400 |
| `mentoringTaskId` が存在しないタスクを指す | 404 |

いずれの拒否も**ユーザー発言を保存する前**に行う（`insertMessage` より前。既存のやりなおし経路のガードと同じ位置づけ）。

## クリティカル設計決定

> Issue #438 の要決定点に対する決定。後続の実装はこの決定に従い、独自判断で逸脱しない。判断7（朝会ゲートとの関係）は決定していない — 下記「未決の論点」を参照。
>
> **見出しの番号は本仕様での通し番号であり、Issue #438 の「判断 N」とは別体系である。** 対応がある決定には見出しに `（判断N）` を併記した。併記の無い見出し（4・6・7・8・9・10・11・12・13・16・17・18・19）は本仕様での追加決定であり、**とくに見出し 7 は未決の「判断7」とは無関係**である。決定 8・9 は S1a（Issue #474）、決定 10・11・12 は S1b（Issue #476）、**決定 13〜19 は S2（13 はスライスの切り方、14・15 は S2a、16〜19 は S2b）**の決定で、いずれも意思決定者の承認済みである。

### 1. 起点の置き場所（判断1）

- **採用案**: タスクカードの**表示モードのアクション行**に「メンタリングする」ボタンを置く。表示条件は **`adhoc` 区間のみ**（会の最中は出さない）
- **理由**: 編集モード内に置くと、未保存の編集内容を抱えたまま画面がチャットへ切り替わり、編集の破棄・保存の扱いという別の論点が発生する。表示モードのアクション行なら既存の「編集」ボタンと同じ導線で、状態の衝突が無い。`adhoc` 限定はチャット画面ヘッダの既存ボタン（`ChatView.tsx:499` の分岐内）と同じ規律であり、確証 (E) のとおり**朝会ゲートに一切算入されない**ため、本スライスを判断7 の決定から独立させられる
- **代替案**: 常時表示 — 却下。朝会セッション中のタスク起点メンタリングがゲートを満たすか否か（判断7）が受入基準に流入し、人間の決定が出るまで出荷できなくなる
- **影響範囲**: `TaskCard.tsx`（ボタン追加）・`TaskBoard.tsx`（props の中継）・`AppLayout.tsx`（ハンドラと `sessionType` による出し分け）

### 2. 会話面（判断2）

- **採用案**: **既存のチャット面に寄せる**。タスク側にメンタリング専用の対話面は作らない
- **理由**: 確証 (C) のとおり `chatState` と `activeView` は既に `AppLayout` の同じスコープにあり、コールバック 1 本で「ビュー切替＋送信」が成立する。専用面を作ると `sessions` / `messages` を持つ会話面が 2 つになり、どちらが活性かという状態と、会（朝会・夕会）との排他が新たに必要になる
- **代替案**: タスク画面内のインライン対話面 — 却下（上記の状態管理の増加。最小スライスに載せない）
- **影響範囲**: `AppLayout.tsx` にハンドラ 1 つ。新規コンポーネントは作らない

### 3. タスク文脈の渡し方（判断3）

- **採用案**: 対象タスクの id を **`mentoringTaskId` としてリクエストボディに載せ**、サーバがプロンプトへ「対象タスク」セクションとして積む。定型文への埋め込みを**紐づけの根拠にしない**
- **理由**: 確証 (B) のとおり `mentoring: true` に前例があり、新機構ではない。定型文にタイトルを埋めて LLM に解決させる方式は、同名タスク・部分一致で黙って取り違える（#258 の判断 2 と同型）。確証 (D) のとおりプロンプトのタスク一覧には `#id` が入っているため、id を積めばボスの側で一意に解決できる
- **代替案**: 定型文にタスク名を埋め込むだけ — 却下（取り違えが検出されないまま記録に残る）
- **影響範囲**: `chat-api.ts` / `use-chat.ts` / `sessions-validation.ts` / `chat-messages-route.ts` / `persona-prompt.ts`

### 4. `send` / `sendChatMessage` の引数の形

- **採用案**: 両層とも**末尾の位置引数をオプションオブジェクトに置き換える**。`use-chat` は `send(content, options?)`、`chat-api` は `sendChatMessage(sessionId, content, handlers, signal?, replaceFromMessageId?, options?)`。`options` は両層で同じ形 `{ mentoring?: true; mentoringTaskId?: number }` とし、**キーは値があるときだけ body に載せる**（既存の undefined-as-absent 契約を維持）
- **理由**: `sendChatMessage` は既に位置引数が 6 個あり、7 個目（`mentoringTaskId`）を足すと `undefined, undefined, true, 12` のような呼び出しになり、引数の取り違えが型で止まらない。既存の呼び出し箇所は実測で少なく、置き換えの費用は小さい — `send` の第2引数に `true` を渡しているのは本番 1 箇所（`ChatView.tsx:518`）とテスト 1 箇所（`use-chat.test.ts:2800`）、`sendChatMessage` の `mentoring` 引数を使っているのはテスト 3 箇所（`chat-api.test.ts:457` / `:494` 付近）のみである
- **代替案**: 位置引数を 1 つ追加する — 却下（上記の可読性・取り違えの risk）。**この決定は受入基準を変えない**（body の形と観測される振る舞いは同じ）ため、実装時に上記の実測を超える書き換えが必要と判明した場合は位置引数追加へ戻してよい
- **影響範囲**: 上記 5 箇所の呼び出しと、`ChatView.tsx` の 1 行

### 5. `task_id` を確実に埋める方法（判断4）

- **採用案**: `RECORD_MENTORING_TOOL` のスキーマ（`required: ["content"]`）は**変えない**。代わりに、**`mentoringTaskId` があるターンで `record_mentoring` が `task_id` 未指定で呼ばれたら、サーバ側で `mentoringTaskId` を補完して保存する**。ボスが `task_id` を明示していれば**その値を尊重し、補完で上書きしない**。プロンプト側の指示（対象タスクの id を `task_id` に指定せよ）も併せて積むが、**担保はサーバ側補完に置く**
- **理由**: プロンプト指示だけでは「必ず埋まる」ことをテストで担保できない。担保できない約束を受入基準に書かない（CLAUDE.md「担保はテストが持つ」）。一方でスキーマの `required` に `task_id` を足すと、朝会の全日単位メンタリング（タスク横断の結論。#276 の既存フロー）が記録できなくなる。補完なら既存フローを壊さずに、タスク起点のターンだけを決定的にできる
- **代替案**: スキーマで必須化 — 却下（既存の全日単位メンタリングを壊す）。プロンプト指示のみ — 却下（テストで担保できない）
- **影響範囲**: 補完は `executeBossTool`（`boss-tools.ts:34`）の `record_mentoring` 分岐と `executeRecordMentoringTool` に置く。**バックエンド固有のコードには置かない** — claude-code / api の両バックエンドはここで合流するため（`chat-messages-route.ts:325-326` が `executeTool` として `executeBossTool` を渡し、claude-code バックエンドは `hooks.executeTool` 経由で同じ関数を呼ぶ）。片方のバックエンドにだけ効く補完にならない唯一の位置である

### 6. タイムラインに残る発言の文面

- **採用案**: タスク起点の発言は**対象タスクのタイトルを含む文面**にする（例: `「{タイトル}」の進め方を見てほしい`）。ただしこの文面は**画面の可読性のためだけ**にあり、ボスとタスクの紐づけの根拠にはしない（紐づけは `mentoringTaskId` とサーバ側補完が持つ）
- **理由**: タイムラインに「今の進め方を見てほしい」だけが並ぶと、後から会話を読み返したときにどのタスクの相談だったか分からない。文面に依存しない紐づけを別に持っているため、文面は表示の都合だけで決めてよい
- **代替案**: 既存の定型文をそのまま使う — 却下（会話の読み返しでタスクが分からない）
- **影響範囲**: `AppLayout.tsx` のハンドラ（文面の組み立て）

### 7. 不整合なリクエストの扱い（本仕様での追加決定。未決の「判断7」とは無関係）

- **採用案**: `mentoringTaskId` の形の検証は既存の `isPositiveInteger`（`server/src/sessions/sessions-validation.ts:59`。`replaceFromMessageId` と同じ関数）を再利用し、正の整数でなければ **400 で拒否**する。`mentoring: true` を伴わない場合も **400 で拒否**する（無視しない）。存在しないタスク id の場合は **404 で拒否**する。いずれも**ユーザー発言を保存する前**に判定する
- **理由**: 無視すると「対象タスクを指定したつもりで、紐づかないメンタリングが 1 件残る」という、利用者から見えない失敗になる。fail-closed にすれば呼び出し側の誤りが即座に分かる。保存前に判定するのは、拒否されたリクエストのユーザー発言だけが DB に残る中間状態を作らないため
- **代替案**: 不整合なフィールドを黙って捨てる — 却下（上記の見えない失敗）
- **影響範囲**: `sessions-validation.ts`（形の検証と組み合わせの検証）・`chat-messages-route.ts`（存在検証。DB を読むため純粋関数側には置かない）

### 8. 送信中・切替中の可否条件（S1a・Issue #474）

> オーナー（人間）が 2026-09-11 に承認済みの方針であり、実装はこの決定に従う。

- **採用案**: **`AppLayout` が `chatState.sending` / `chatState.switching` を見て、タスクカードの「メンタリングする」を非活性化する**。会（朝会・夕会）中に**非表示**にする既存の扱い（決定 1・`onStartMentoring = null`）はそのまま残し、送信中・切替中は**ボタンを描画したまま `disabled`** にする（ヘッダの 4 ボタンと同じ形）
- **理由**: ヘッダと同じ可否条件へ揃えるだけで 2 つの導線が対称になり、`useChat` の多重送信ガードに触らずに済む。確証 (F) のとおり、ヘッダの条件に含まれる `editingMessageId !== null` はタスク画面表示中は常に偽なので、`sending || switching` だけでヘッダと**等価**になる（`editingMessageId` を `useChat` へリフトする必要が無い）。非表示ではなく非活性にするのは、送信のたびにボタンが消えて戻る（レイアウトが動く）のを避けるためで、これもヘッダの扱いと同じである
- **代替案**: (b) `useChat.send` が破棄を戻り値で返す — 却下（`send` の戻り値型の変更は全呼び出し元に及ぶ横断変更）。(c) 現状維持 — 却下（#474 の「押したのに何も起きない画面」が残る）。(d) 送信中は `onStartMentoring` を `null` にして非表示 — 却下（上記のレイアウト移動。かつ「会中だから出さない」と「いま送れないだけ」という意味の違う 2 つを同じ表現に潰す）
- **影響範囲**: `AppLayout.tsx`（可否の算出）・`TaskBoard.tsx`（props の中継）・`TaskCard.tsx`（`disabled` の反映）
- **明示的な仮定**: 新しい prop 名は `startMentoringDisabled` とする（命名・内部構造は軽微・可逆な判断として本仕様で確定させる。受入基準は prop 名に依存しない）

### 9. `task?.title ?? ""` フォールバックの除去（S1a・Issue #474）

> オーナー（人間）が 2026-09-11 に承認済みの方針であり、実装はこの決定に従う。

- **採用案**: **対象タスクを引けないときは導線を出さない**——すなわち `「」の進め方を見てほしい` を送りうる経路そのものを消す。具体的には、**ボタンを描画しているカードが持つタスクをそのままハンドラへ渡す**（`onStartMentoring(task)`）ことで、`AppLayout` 側の id → タスク再検索（`tasksState.tasks.find`）とその失敗時フォールバック（`?? ""`）を無くす。ボタンはそのタスクのカード上にしか存在しないため、「タスクを引けないのにボタンがある」状態が構造的に作れなくなる
- **理由**: 確証 5 のとおり現状の `?? ""` は実 UI 経路では到達不能だが、到達不能な分岐は「壊れた文面を送ってよい」と読める形として残り続ける。ハンドラの引数をタスクにすれば、再検索も失敗分岐も消えて到達不能分岐そのものが無くなる。**ハンドラ側で `find` が外れたときに何もせず return する案は採らない**——それは #474 と同じ「押したのに何も起きない画面」を新たに作るためである
- **代替案**: `find` 失敗時に早期 return — 却下（上記）。`?? "（タイトル不明）"` のような代替文面 — 却下（紐づけは `mentoringTaskId` が持つとはいえ、表示のためだけに無意味な発言をタイムラインへ残す）
- **影響範囲**: `TaskCard.tsx`（`onStartMentoring(task.id)` → `onStartMentoring(task)`）・`TaskBoard.tsx`（型の中継）・`AppLayout.tsx`（`find` とフォールバックの削除）
- **不変**: 送信するリクエストの中身は変わらない（`mentoringTaskId` は `task.id`、文面は `「{タイトル}」の進め方を見てほしい` のまま。決定 3・決定 6 を変更しない）

### 10. メンタリング文脈の保持スコープ（S1b・Issue #476・論点1）

> 意思決定者が 2026-09-12 に決定した方針であり、実装はこの決定に従う。当初案 (a)（サーバのセッション側に保持）は、下記の反証により**取り下げられた**。

- **採用案**: **web が「相談中（対象タスク）」の状態を持ち、継続中は毎ターン `mentoring: true` ＋ `mentoringTaskId` を送る**（案 (b)）。**サーバは変更しない・マイグレーションもしない**
- **保持の置き場所は `useChat`**（`AppLayout` ではない）。`useChat.send` が、呼び出し側が `options` を渡さなくても保持中の文脈を**自動的にリクエストへ付加する**
  - **理由（構造）**: #476 の欠陥はまさに「2 ターン目の呼び出し側（`ChatView.tsx:458-465` の `submitDraft`）が渡し忘れる」ことである。`AppLayout` に状態を置くと、`ChatView` から直接呼ばれる `chatState.send` はその状態を知らないため、同じ渡し忘れが再発する。**すべての送信経路が必ず通る 1 箇所（`useChat.send`）で付加する**ことで、呼び出し側の規律に依存しない
- **`mentoringTaskId` だけでなく `mentoring: true` も毎ターン送る**（確証 (G)）。これにより 2 ターン目以降も `MENTORING_FLOW_INSTRUCTION`・「対象タスク」セクション・`MENTORING_TARGET_TASK_INSTRUCTION` の 3 つがプロンプトに積まれ続ける。**2 つの欠落は独立ではなく連動している**——`chat-messages-route.ts:301` が `mentoringTaskIdForTurn = mentoring ? mentoringTaskId : undefined` であるため、`mentoring` が落ちれば `mentoringTaskId` も同時に落ちる
- **理由（(a) を採らない）**: (a) の失敗は「**誤ったタスクへ静かに紐づく**」であり、確証 (H)（`adhoc` を終える導線が UI に無い＝実質その日いっぱい保持）により日中ずっと続く。(b) の失敗は「**紐づかない**」＝現状と同じで、しかも「相談中」表示が消えることで利用者に見える。決定ログのタスク軸（#358）の信頼性という目的に照らすと、前者の害が大きい
- **担保の位置は変えない**: サーバ側の `task_id` 補完（決定 5）はそのまま。「プロンプト指示に依存しない」という S1 の設計は保たれ、web が変わるのは「毎ターン送るかどうか」だけである
- **代替案**: (a) `sessions` に列追加（v9）で保持 — 却下（上記）。(a′) `messages` 行へ `mentoring` / `mentoring_task_id` を持たせ直近のメンタリング発言から導出 — 却下（S1b では採らない。ただし下記 決定 12 の進化の道筋として残す）。(c) 現状維持＋プロンプトで 1 ターン結論を促す — 却下（確証 (G) のとおり 2 ターン目にはその指示ごと消えるため促す先が無い。かつ `MENTORING_FLOW_INSTRUCTION` 手順1 が「申告を受けたら」で始まりボスがまず訊き返す構造〔`persona-prompt.ts:569-578`〕と矛盾する）
- **影響範囲**: `use-chat.ts`（状態と `send` の付加）・`ChatView.tsx`（「相談中」表示と解除操作）・`AppLayout.tsx`（起動ハンドラが対象タスクを `useChat` へ渡す）とそれぞれのテスト。**server は 1 行も変えない**
- **確証 (K) との整合**: 保持は web 側にあり、送信先は常に「その時点の活性セッション」である。会の開始・終了で解除する（決定 11）ため、`adhoc` で選んだタスクが朝会セッションの記録へ混入することはない。朝会ゲート（`mentoring-gate.ts`）は 1 行も変わらない

### 11. 保持の解除条件（S1b・Issue #476・論点2）

> 意思決定者が 2026-09-12 に決定した方針であり、実装はこの決定に従う。

- **採用案**: 次の 4 つで解除する。**いずれも画面に見える遷移であること**が要件である
  1. **利用者の明示解除操作**（「相談中」表示に付く解除の導線）
  2. **別のメンタリングの開始** — 別タスクのカードから開始した場合は**置き換え**、チャット画面ヘッダの全日単位メンタリング（`ChatView.tsx:516-524`・確証 (I)）を押した場合は**対象タスク無しの状態へ解除**する
  3. **会（朝会・夕会）の開始**
  4. **会の終了**
- **理由**: 確証 (I) のとおり同一 `adhoc` セッション内に対象タスクを持たないメンタリング導線が別にあるため、そこへ古い対象タスクが持ち越されると全日単位の結論が誤ったタスクへ紐づく。会の開始・終了で解除するのは、会中のメンタリングは性質（その日全体の申告）が違い、かつ確証 (K) の「adhoc に閉じる」前提を守るためである。`useChat` は会の開始・終了で既に `setMentoringRequired(false)` を行っており（`use-chat.ts:633`〔`startSession`〕・`:686`〔`endSession`〕）、解除はその隣に置ける
- **却下した案**: **結論記録（`record_mentoring`）まで** — `MENTORING_FLOW_INSTRUCTION` が「点検の結論を **1 件以上**記録すること」と書いているため、同一メンタリング内の 2 件目以降が紐づかなくなる。**セッション終了まで** — 確証 (H) により `adhoc` では「その日いっぱい」を意味し、(a) と同じ過剰紐づけになる
- **影響範囲**: `use-chat.ts`（解除関数と `startSession` / `endSession` での解除）・`ChatView.tsx`（解除の導線とヘッダボタン押下時の解除）
- **後続の上書き（#491・出荷済み）**: 2 のうちヘッダ押下の扱いは「対象タスク無しの状態へ解除」から「全日単位の相談中へ置き換え」に変わった（`docs/features/day-mentoring-consultation.md` 決定 2）。実コードでは `mentoringTarget` が `{ kind: "task" | "day" }` を持ち、`ChatView` が kind で文面を出し分ける（確証 (S)）

### 12. 受容する劣化と、その先の進化の道筋（S1b・Issue #476）

- **採用案**: **リロードで「相談中」の状態は失われることを受容し、仕様に明記する**。失われたときの帰結は「以後のターンが対象タスクへ紐づかない」＝**現状（S1）と同じ**であり、**誤ったタスクへ紐づく方向には壊れない**。利用者から見ても「相談中」表示が消えるため、状態が失われたことは画面上で分かる
- **理由**: 唯一の劣化が「安全側かつ可視」であるなら、サーバへ可変状態とマイグレーションを足す費用に見合わない（YAGNI）。リロード耐性が実運用で必要だと分かってから足せばよい
- **進化の道筋**: リロード耐性が要ると判明した場合は、決定 10 の代替案 (a′)（`messages` 行へそのターンの `mentoring` / `mentoring_task_id` を持たせ、直近のメンタリング発言から文脈を導出する）を追補する。**この道筋は (b) と排他ではない**——web の「相談中」表示と解除操作はそのまま残し、初期値をサーバから復元する形になる。列追加の先例は `messages.interrupted`（`migrate.ts:238`。ADR 0005 決定 4 により既存 version は書き換えず v9 を足す）
- **代替案**: 最初から (a′) を入れる — 却下（上記 YAGNI。かつ S1b が web 単独スライスでなくなり、マイグレーションを伴う分だけ出荷が遅れる）

### 13. S2 を S2a / S2b の 2 スライスに割る（S2・2026-09-20）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: S2 を **S2a（振り返り導線・web のみ・8 ファイル）** と **S2b（対象タスクの過去記録のプロンプト投入・server のみ・6 ファイル）** に割り、**S2b を先に実装対象とする**。仕様は本ファイルのスライス表に両方を置き、新規ファイルへ分割しない
- **理由**: 確証 5 のとおり S2 全体の実測は 14 ファイルで、S1a（3＋テスト 3）・S1b（3＋テスト 3）の倍になる。スライスは出荷の単位であり、web と server が混ざらない切り方は品質ゲート・レビューの単位としても素直である。両者は**触るファイルが 1 つも重ならず依存も無い**ため、割ることで出荷が遅れない。S2b を先にするのは、Issue #438 の主訴「各々のタスクについて深堀りしづらい」に直接効くのが投入側であり、振り返り導線はナビゲーションから決定ログへ到達できる現状に対する 1 クリックの短縮にとどまるため
- **代替案**: (a) 14 ファイルを 1 スライスで出す — 却下（出荷の単位として大きすぎる）。(b) S2a を新規ファイルへ切り出す（#491 の先例） — 却下（S2 は既に本ファイルのスライス表に在り、出荷済みスライスの決定を書き換える必要も無いため、ファイルを増やす理由が無い）
- **影響範囲**: スライス表・受入基準の節構成。実装の内容は変わらない

### 14. 振り返り導線の起点（S2a・Issue #438 判断1・判断5）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: **タスクカードの表示モードのアクション行に導線を 1 つ置き、常時表示する**（`adhoc` 限定にしない）。**記録の有無で出し分けない**——記録が 0 件のタスクでも同じように押せる
- **理由**: 記録の有無で出し分けるには「どのタスクに記録があるか」を `AppLayout` が知る必要があり、決定ログの取得を `AppLayout` へ持ち上げることになる。確証 (Q) のとおり `useDecisions` はマウント時に 1 回取得するだけなので、持ち上げた瞬間に「アプリ起動時の 1 回きり」へ退化し、**メンタリングした直後の記録が導線に反映されない**——「相談した内容をあとから振り返る」という本機能の目的そのものを壊す。`adhoc` 限定にしないのは、開始導線が `adhoc` 限定である理由（確証 (E) の朝会ゲート非算入）が**読むだけの導線には当てはまらない**ためである（記録もゲートも一切触らない）
- **代替案**: (a) 記録があるタスクにだけ出す（件数バッジ付き） — 却下（上記の鮮度の退化。決定ログと二重に取得すれば避けられるが取得が 1 本増える）。(b) チャットの「相談中」帯にだけ置く — 却下（タスク画面から辿れず、Issue #438 の期待動作「タスクを開けば…読み返せる」を満たさない）
- **影響範囲**: `TaskCard.tsx`（ボタン追加）・`TaskBoard.tsx`（props の中継）・`AppLayout.tsx`（ハンドラ）

### 15. 決定ログのセクション id と移動の実現手段（S2a・Issue #438 判断5）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: **状態 prop ＋プログラム的スクロール**。`AppLayout` が「どのタスクのセクションへ寄せるか」を state に持ち、ビュー切替と同時にセットして `DecisionLog` へ prop で渡す。`DecisionLog` は決定ログの取得が終わったあと、対象タスクのセクションの要素に対して `scrollIntoView` を呼ぶ。セクションには**タスク id 由来の `id` 属性**を付け、`task_id` を持たない記録のセクションにも固定の id を与える
- **ハッシュフラグメントは使わない**: 確証 3 のとおり、`web/src` にはルーティングも `location.hash` の参照も存在せず、`DecisionLog` は非表示時にアンマウントされる条件レンダリングである。**リンクを押す時点で移動先の DOM が存在しない**ためブラウザのアンカー解決は働かず、結局 JS で解決することになる。加えてルーティングが無いため URL のハッシュだけが残り、リロードすると「ダッシュボードが開いているのにハッシュは決定ログを指す」という不整合が生まれる
- **id をタスク id 由来にする理由**: セクションはタスク軸で束ねられており（#358・`groupDecisionsByTask` が `taskId` を持つ）、移動先は「そのタスクのセクション」であって個別の決定ではない。決定 id 由来にすると粒度が合わず、`group-decisions-by-task.ts` に新しい識別子を持ち込むことになる
- **`scrollIntoView` は防御的に呼ぶ**: 確証 (R) のとおり jsdom はこの API を実装しない。`typeof el.scrollIntoView === "function"` を確かめてから呼ぶ（`AppLayout.tsx:123` の `setPointerCapture` と同じ作法）。テストは `ChatView.test.tsx:1471-1495` の先例に倣い、プロトタイプ側を差し替えて呼び出しを観測する
- **対象タスクの記録が 1 件も無い場合**: **決定ログを開くだけで、スクロールは行わない**（エラーにも空セクションの生成にもしない）
- **スクロール対象は一度の遷移で消費する（2026-09-20 の PR #544 レビュー指摘を受けて追加）**: `AppLayout` の state は `DecisionLog` がアンマウントされても残るため、**消費しないと「カードから遷移 → 別ビューへ → ナビゲーションから決定ログを再表示」で再マウント時に同じ prop を受け取り、再びスクロールしてしまう**（受入基準「ナビゲーションから開いたときはスクロールしない」に反する）。したがって:
  - `DecisionLog` は決定ログの取得が完了したあと、**スクロールしたかどうかにかかわらず対象をクリアする**。クリアするのは「スクロールした場合」だけではない——**対象タスクのセクションが存在しない場合・記録が 0 件の場合・`scrollIntoView` が使えない環境の場合も含め、取得完了の時点で必ずクリアする**（クリアの条件を分岐させると、条件から漏れた経路に古い対象が残り続ける）
  - **クリアの責務は `AppLayout` 側に置く**（state の持ち主が唯一の更新者であるという既存の作法に揃える）。`DecisionLog` は「消費し終えた」ことを伝えるコールバックを prop で受け取って呼ぶだけで、自分では状態を持たない。`DecisionLog` に状態を持たせて自前でクリアすると、state の真実が 2 箇所に分かれる
- **代替案（消費の置き場所）**: (a) `AppLayout` がビュー切替を検知してクリアする — 却下（`DecisionLog` の取得完了より先にクリアされうるため、スクロールの機会を奪う競合が生まれる）。(b) クリアせず「前回スクロールしたタスク id」を `DecisionLog` 側で覚えて抑止する — 却下（アンマウントで失われるので抑止が効かず、同じ再スクロールが起きる）
- **注記（2026-09-21・PR #559 の Codex P2 を受けてオーナー決定）**: **ナビゲーション経由のビュー切替でも対象をクリアする。** 取得完了時の消費だけでは、「導線を押す → 決定ログの取得が終わる前に別ビューへ離れる」と `DecisionLog` が消費を通知しないままアンマウントされて対象が残り、次にナビゲーションから決定ログを開いたときにスクロールしてしまう。ナビゲーションのボタンはカードの導線を経由しない遷移なので、`AppLayout` がその場で対象を `null` に戻しても導線側のスクロールの機会は奪わない（上の代替案 (a)「ビュー切替を検知してクリア」とは異なり、取得完了との競合が生じない）。取得完了時の消費通知は従来どおり残す（両方でクリアする）
- **代替案**: (a) ハッシュフラグメント — 却下（上記）。(b) id を付けるだけでスクロールしない — 却下（セクションが増えるほど目的のセクションを探す手間が残り、「振り返れる」という価値が薄い）
- **影響範囲**: `AppLayout.tsx`（state とハンドラ）・`DecisionLog.tsx`（prop・id・スクロール）。`group-decisions-by-task.ts` は変更しない

### 16. 過去記録を遡る範囲（S2b）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: **対象タスクに紐づく記録だけを、`kind` を問わず、新しい順に最大 5 件**。期間による絞り込みは行わない
- **理由**: 「直近 5 件」は既存の 2 セクションと同じ慣習である（`listRecentDecisions(db, 5)`・`listRecentSessionSummaries(db, 5)`）。期間上限を入れると、**締切の遠いタスクほど相談の間隔が空く**ため「古いが唯一の記録」を落とす方向に壊れ、振り返りの価値を損なう。`kind` を問わないのは、Issue #438 の期待動作が「関連する**過去の決定**」と「過去に何を相談したか」の両方を求めているためである
- **明示的な仮定**: **5 件は実測ではなく既存の慣習からの決めである。** 確証 (P) のとおり、ローカルの開発用 DB が v8 以前のスキーマ（`decisions.kind` 列が無い）で、1 タスクあたりの記録件数・本文長の実測を取れなかった。実運用で不足・過多が分かった時点で件数を変えてよい（受入基準は件数上限が効くことを固定するが、値そのものの妥当性は担保しない）
- **代替案**: (a) 件数＋期間（例: 直近 30 日） — 却下（上記）。(b) 件数の代わりに文字数上限だけで絞る — 却下（**文字数上限は決定 18 で別途設ける**が、それは長さの制御であって「何件まで遡るか」という決定の代わりにはならない。両者は AND で効く）
- **影響範囲**: `chat-messages-route.ts`（件数の指定）

### 17. 過去記録の取得経路（S2b・#408 AC-42 を壊さない別経路）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: **`decisions-repository.ts` に新規のクエリ関数を足す**（`WHERE task_id = ?`・`kind` で絞らない・`created_at DESC, id DESC`・`LIMIT`）。`chat-messages-route` が対象タスクの定まるターンにだけ呼び、結果を `buildPersonaPrompt` へ渡す。`buildPersonaPrompt` は**純粋関数のまま**（DB を読まない）
- **理由**: 確証 (N) のとおり `task_id` で絞る読み取りは存在せず、新設が要る。`listRecentDecisions` には一切触れないため、#408 AC-42 の契約（`kind='mentoring'` の SQL レベル除外）は構造的に保たれる
- **代替案**: (a) `listRecentDecisions` に引数を足して分岐させる — 却下（1 つの関数が 2 つの契約を持ち、AC-42 の回帰テストが片方の分岐しか守らなくなる）。(b) `listDecisions`（全件）をプロンプト組み立て側で絞る — 却下（件数上限が JS 側に出る。AC-42 が SQL レベルの除外を選んだ理由と同型の劣化であり、全件をメモリへ載せる無駄も伴う）
- **「直近の決定」セクションとの重複を許容する**: 新しい関数は `kind` を問わず対象タスクの記録を返し、`listRecentDecisions` は `task_id` を問わず直近の決定を返すため、**対象タスクの最近の `kind='decision'` な裁定は両方のセクションに現れうる**。これは既知の帰結として受容する——見出しが異なれば意味も異なる（「このタスクの履歴」と「直近の裁定」）。重複を排除するには `RecentDecision` 型に `id` を足す横断変更が要り、`kind='mentoring'` に限る案は Issue #438 の「関連する過去の決定を踏まえて」を満たさなくなる。**受入基準では重複の有無を固定しない**（どちらに転んでも受入判定が変わらないようにする）
- **影響範囲**: `decisions-repository.ts`（新規関数）・`chat-messages-route.ts`（結線）

### 18. プロンプトへ積む内容と切り詰めの方針（S2b）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。**文字数上限については、同日の PR #544 レビュー指摘（Codex・P2）を受けて「上限を設けない」から「合計 2,000 文字の上限を設ける」へ意思決定者が改めた**（下記「改訂の経緯」）。

- **採用案**: 各記録の行に **`content` と `rationale` の両方**を積む。**ブロック全体に合計文字数の上限を設ける**（下記）。各行に**種別（決定／メンタリング）のラベル**を出し、語彙は決定ログ画面の `KIND_LABEL`（`DecisionLog.tsx:11-14`）と同じ「決定」「メンタリング」を使う。**ただし `KIND_LABEL` をサーバから import・共有はしない**——web と server は npm workspaces で分かれたパッケージで定数を共有する経路が無く、共有を作れば S2b の「`web/` に差分を作らない」制約に反する。`persona-prompt.ts` 側に同じ文字列リテラルを置く。**記録が 0 件のときはセクション自体を積まない**
- **文字数上限と切り詰めの規則**:
  - 上限は **2,000 文字**。対象は各記録の `content` と `rationale` の**文字数の合計**とする（行頭の日時・種別ラベルなど整形部分は含めない。`MAX_TODAYS_ADHOC_MESSAGES_TOTAL_LENGTH` と同じ数え方）
  - **新しい側から詰め、上限に収まらない記録に当たった時点で走査を打ち切り、それより古い側はすべて落とす**（最良詰め合わせは行わない）
  - **省略・切り詰めが 1 件でも起きたら、その旨を示す通知をブロック内に出す**（ボスが「これで全部だ」と誤解しないため）
  - **最新の 1 件だけで上限を超える場合は、その 1 件を上限の長さへ切り詰めて採用する**（ブロックが空になってセクションごと消えることを防ぐ）。これは「取得件数が 1 件のとき」の話ではなく、**最新の 1 件を単独で見て上限を超えるとき**に効く救済である
  - **入力の並び順は先例と逆である点に注意**: `selectTodaysAdhocMessages` は古い順で渡される契約のため `sortByAscendingSentAt` で昇順に整えてから**末尾（最新）**へ向かって走査する。一方、決定 17 の新規クエリは `created_at DESC, id DESC` で引くため、**渡る配列は最初から新しい順**である。**事前ソートは不要で、先頭（index 0）から走査すれば「新しい側から詰める」になる**（先例のコードをそのまま写して走査方向を取り違えないこと）
  - **未決**: 1 件の記録の `content` ＋ `rationale` の合計が上限を超えるとき、**どちらを優先して残すか**（`content` 優先／`rationale` 優先／比率で配分）は**意思決定者へ照会中であり、本仕様では未決**である。決まるまでこの配分を受入基準に書かない（下記「## 未決の論点」）
  - **件数上限 5 件（決定 16）と文字数上限 2,000 は AND** で効く（先に件数で絞り、その中で文字数が収まる分だけを採る）
  - 定数名は仮置きでよい（受入基準は名前に依存しない）
- **理由（`rationale` を積む）**: 本機能の目的は深掘りであり、メンタリング記録の価値は結論よりも「どの点をどう危ういと判断したか」（`rationale`）の側にある（`MENTORING_FLOW_INSTRUCTION` が `rationale` にその内容を書かせている）。`listRecentDecisions` が `content` だけを渡しているのは「直近の裁定を思い出させる」用途だからであり、S2b とは用途が違う
- **理由（文字数上限を設ける）**: 確証 (O) のとおり、`content` / `rationale` はツールスキーマにも `decisions` の TEXT 列にも長さ制限が無く、**件数を 5 件に絞ってもブロックの長さは無制限**である。長い記録が蓄積したタスクではコンテキスト超過でメンタリングの応答自体が失敗しうる——「深掘りのために積んだ文脈が、深掘りを失敗させる」という自己矛盾した壊れ方をする。**過去記録の長さは測定できていないため、「収まる」と仮定せず上限で閉じる**（fail-closed）
- **理由（値を 2,000 文字にする）**: 「当日の随時チャット」の上限（4,000 文字）の半分とする。当日の会話は**いま進行中の文脈**であるのに対し、過去記録は**補助的な参照情報**であり、競合したときに譲るべき側だからである
- **理由（切り詰めの作法を既存に揃える）**: `selectTodaysAdhocMessages`（`persona-prompt.ts:514-561`）が既に「新しい側から詰める・超えたら打ち切る・省略通知を添える・1 件も入らないときは最新 1 件を切り詰める」という規則を実装しており、同じ作法に揃えれば読み手（と実装者）が 2 つの切り詰め規則を覚えずに済む
- **理由（0 件でセクションを出さない）**: 空のセクションは「記録がある」という誤った手がかりをボスへ与え、プロンプトを汚すだけである。空なら出さない作法は `formatTodaysAdhocMessageSection`（空文字列を返し呼び出し側が push しない）に先例がある
- **代替案**: (a) `content` のみ — 却下（深掘りの材料が落ちる）。(b) 文字数上限を設けない — **却下（下記の改訂の経緯）**。(c) 件数上限を廃して文字数上限だけにする — 却下（件数は「何件まで遡るか」という意味の決定〔決定 16〕であり、長さの制御とは別の関心事。両方を残す）
- **改訂の経緯**: 当初案は「文字数上限を設けない」で、根拠は確証 (O) の「2,220 文字は 4,000 文字の許容幅に対して十分小さい」だった。PR #544 のレビュー（Codex・P2）が**その 2,220 文字は過去記録を足す前の値であり、5 件分が収まる根拠になっていない**ことを指摘し、意思決定者が上限を設ける側へ決定を改めた。確証 (O) の記述もあわせて訂正した
- **影響範囲**: `persona-prompt.ts`（セクションの整形と切り詰め）

### 19. 過去記録を積む条件（S2b）

> 意思決定者が 2026-09-20 に決定した方針であり、実装はこの決定に従う。

- **採用案**: **S1 の「対象タスク」セクションと同じ AND 条件**——`mentoring` が真、かつ `mentoringTaskId` が `context.tasks` に存在するときだけ積む
- **セクションの順序を `対象タスク` → `MENTORING_TARGET_TASK_INSTRUCTION` → `過去記録` に固定する**（「対象タスクより後」だけでは足りない）。**`対象タスク` と `MENTORING_TARGET_TASK_INSTRUCTION` の間に過去記録を挟んではならない**——後者が「**上の**『対象タスク』セクションに示したタスク」という位置を前提にした文言を持つ（`persona-prompt.ts:619-621`）ため、間に別セクションが入ると「上の」が指す先が曖昧になる。**既存の 2 つは隣接したまま、過去記録はその後ろに置く**
- **理由**: 対象タスクを解決できないターンに過去記録だけを積んでも、ボスはそれが何のタスクの記録か分からない。`mentoring` が偽のターンには `mentoringTaskId` が後段へ渡らない設計（`chat-messages-route.ts:310`）なので、この AND 条件は既存の結線とも整合する。順序は「何の話か（対象タスク）→ どう扱えという指示（`task_id` を埋めよ）→ これまで何があったか（履歴）」と読める並びであり、既存 2 セクションの隣接という制約とも両立する
- **順序の改訂の経緯**: 当初は「対象タスクより後」とだけ書いていたが、PR #544 のレビュー（Codex・P2）が **`対象タスク → 過去記録 → MENTORING_TARGET_TASK_INSTRUCTION` でも基準を満たしてしまう**ことを指摘した。決定の意図は隣接の維持にあるため、3 つの順序を固定する形へ改めた（受入基準も同様に書き換えた）
- **代替案**: `mentoringTaskId` があれば `mentoring` の真偽を問わず積む — 却下（上記の結線により到達しない条件であり、到達しない分岐を形として残さない。決定 9 と同じ規律）
- **影響範囲**: `persona-prompt.ts`（積む条件の分岐）

## 未決の論点（人間の決定待ち）

> **論点A（S2b・2026-09-20 に発生）: 1 件の記録が単独で文字数上限を超えるとき、`content` と `rationale` のどちらを優先して残すか。**
> 決定 18 の切り詰め規則は「最新の 1 件だけで上限を超えるならその 1 件を切り詰めて採用する」までを定めたが、**1 件が 2 つのフィールドを持つ**点が先例（`selectTodaysAdhocMessages` は 1 フィールドのみ）と異なり、予算の配分が決まっていない。選択肢: (a) `content` を優先して残し、余りを `rationale` に充てる／(b) `rationale` を優先する（決定 18 の「価値は `rationale` 側にある」という理由と整合）／(c) 元の長さの比率で配分。**この論点が決まるまで、配分を固定する受入基準は書かない**（総量の上限が効くことは受入基準で担保されている）。実装が先行する場合は、配分を明示的な仮定として記録し、決定が入った時点で合わせること。

> **判断7: タスク起点のメンタリングは、朝会の必須メンタリングゲートを満たしてよいか。**
> これは催促の強度＝体験の根幹に関わるため、オーナー（人間）の決定事項である。**本仕様では決定しない。** S1 の受入基準はこの論点に依存しない（決定 1 の `adhoc` 限定と確証 (E) により独立している）。決定が入ってから着手するものは S3 に置く。

判断材料（実コード）:

- ゲートは `isMentoringComplete({ mentoringRecordCount, userMessageCount })` の AND（`mentoring-gate.ts:25`）。件数は朝会セッションの `session_id` スコープ（`sessions-routes.ts:144`）
- 逃げ道は既にある。設定 `morning_mentoring_required`（既定 true・`server/src/settings/mentoring-settings.ts:21`）でゲート自体をオフにできる
- 既存の随時メンタリングボタンは `adhoc` 区間のみ表示（`ChatView.tsx:499` の分岐内）
- 現状の帰結: `adhoc` 中のメンタリングは朝会セッションに属さないため、**今もゲートを満たさない**

選択肢:

- **(1) 満たさない（現状維持）** — タスク起点導線を `adhoc` のみに出す。朝会は従来どおり「その日の進め方の申告」を要求する。規律は最も強い。コード変更ゼロ
- **(2) 朝会中にもタスク起点導線を出し、その記録でゲートを満たす** — 「1 タスクの深掘り＝その日の申告」と見なす。朝会がタスク 1 件の相談で終わりうる（規律が緩む）
- **(3) 朝会中は導線を出すが、ゲート判定は全日メンタリング記録に限る** — 判定側に「タスク紐づきの有無」を持ち込む必要があり、`mentoring-gate.ts` の変更が発生する

提示されている推奨は (1) だが、**決定ではない**。

> **S1b の論点1（保持スコープ）・論点2（解除条件）は 2026-09-12 に決定済み**であり、ここには残っていない。決定 10・決定 11・決定 12 を参照すること。**当初案 (a)（サーバのセッション側に保持）は確証 (H) にもとづく反証により取り下げられた。**
>
> **全日単位の随時メンタリング（`ChatView` ヘッダ導線・#411）側の同じ欠落は S1b の範囲外**であり、独立した Issue #491 で扱う（S1b を小さく保つため。確証 (G) の切り分け: 朝会は `morning_mentoring_required` により毎ターン `mentoring` が真になるので影響を受けず、劣化するのは `adhoc` の全日単位メンタリングだけである）。#491 は出荷済みである（確証 (S)）。
>
> **S2 の論点（スライスの切り方・振り返り導線の起点・セクション id と移動の手段・遡る範囲・取得経路・切り詰めの方針・積む条件）は 2026-09-20 に決定済み**であり、ここには残っていない。決定 13〜19 を参照すること。**未決のまま残っているのは判断7 だけ**である。

## S1 で満たさないこと（Issue #438 の期待動作との差）

Issue #438 の期待動作のうち「ボスがそのタスクの文脈（内容・締切・優先度・**関連する過去の決定**）を踏まえて深掘りできる」は、**S1 では部分的にしか満たさない**。S1 が積むのは対象タスクの**タスク行情報**（ステータス・id・タイトル・優先度・エビデンス・締切）までであり、**そのタスクに紐づく過去の決定・過去のメンタリング記録はプロンプトに入らない**。確証 (A) のとおり `listRecentDecisions` は `kind='mentoring'` を SQL レベルで除外しており、この除外（#408 AC-42）はどのスライスでも変更しない。**過去記録の投入は S2b が別経路で扱う**（決定 16〜19）。

Issue #438 の期待動作「タスクを開けば、そのタスクについて過去に何を相談し何を決めたかを読み返せる」は、**S2a の振り返り導線（タスクカード → 決定ログの当該セクション）で充足とみなす**（意思決定者の 2026-09-20 の決定）。**タスク画面上に決定・メンタリング記録を一覧表示することはしない**（「やらないこと」。決定ログを正とし二重表示を作らない）。

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | タスクカード（`adhoc` 区間のみ）から「メンタリングする」→ チャット面へ遷移し、`mentoringTaskId` を載せた随時メンタリングを開始。ボスは対象タスクのタスク行情報を認識し、結論はサーバ側補完で確実にそのタスクへ紐づく | 20-24 | **出荷済み**（#470 / 親 #444・`73c1b20`） |
| S1a（S1 の追補・#474） | タスクカード導線の可否条件をヘッダ導線と対称にする（送信中・切替中は非活性＝押せない・ビューも切り替わらない）＋ 対象タスクの再検索とタイトル欠落フォールバックの除去。web のみ・サーバ非変更 | 3（＋テスト 3） | **出荷済み**（#489・`75794aa`） |
| S1b（S1 の追補・#476） | web が「相談中（対象タスク）」の状態を持ち、継続中は毎ターン `mentoring: true` ＋ `mentoringTaskId` を送る。2 ターン目以降に出た結論も対象タスクへ紐づき、メンタリングの手順指示もプロンプトに積まれ続ける。相談中は画面に見え、明示操作・別メンタリング開始・会の開始／終了で解除できる。**web のみ・サーバ非変更・マイグレーション無し** | 3（＋テスト 3） | **出荷済み**（#476・`4106645`） |
| S2b | 対象タスクに紐づく過去の決定・メンタリング記録を、`listRecentDecisions` とは別経路の新規クエリで引き、メンタリングのターンのシステムプロンプトへ積む（新しい順 5 件・`content` ＋ `rationale`・種別ラベル付き・0 件なら積まない・合計 2,000 文字を上限に新しい側から詰めて省略通知を出す）。**server のみ・web 非変更・マイグレーション無し** | 3（＋テスト 3） | **実装対象**（決定 13） |
| S2a | 振り返り導線（タスクカード → 決定ログの当該タスクのセクションへ、状態 prop ＋プログラム的スクロールで移動。`DecisionLog` にセクション id を付与）。**web のみ・サーバ非変更** | 4（＋テスト 4） | S2b がマージされてから（決定 13。触る行が別で依存は無い） |
| S3 | メンタリングの経過（やり取り）を残す仕組み／朝会ゲートとの関係（**判断7 の人間決定が入ってから**着手する） | 未定 | S2a・S2b がマージされ、かつ判断7 が決定されてから |

実装対象: S2b（S1・S1a・S1b は出荷済み）

> S1 の出荷条件「結論はサーバ側補完で確実にそのタスクへ紐づく」が成立するのは**起動ターン内に限られる**（#476）。これは S1 の受入基準の未達ではなく約束文と実装範囲の差であり、S1b で埋めた（「### Issue #476 の確証」節）。
>
> **本改訂の実装対象は S2b** であり、決定 16〜19 に従う。S2a は決定 14・15 として本改訂で確定させたが、**起票・実装は S2b のマージ後**である（要件チケットは実装対象スライスの 1 件だけを起票する）。S3 は着手順を変えない（判断7 の人間決定待ち）。**#477 / #491 / #503 は本ファイルの範囲外**であり、それぞれ別の仕様ファイル・Issue で扱われている。

## やらないこと

- **朝会ゲートの判定ロジックの変更**（理由: 判断7 は人間の決定事項であり未決。`mentoring-gate.ts` は 1 行も変えない）
- **`listRecentDecisions` の `kind='decision'` 除外の変更**（理由: #408 AC-42 の契約であり、メンタリング行が直近の決定の枠を食う問題を解いている。過去記録の投入は S2b が**別経路の新規クエリ**として設計する。決定 17）
- **日報（`collect-daily-report-data.ts`・#408 AC-43）・作業ログ（`collect-work-log-data.ts`・#408 AC-44）の `kind='decision'` 絞り込みの変更**（理由: 確証 (M)。同じ「mentoring を除外する」契約が 3 箇所に別々の SQL で存在し、S2b が足すのは 4 つ目の独立した読み取りである。既存 3 つはいずれも触らない）
- **`DecisionLog.tsx` / `group-decisions-by-task.ts` の再構成**（理由: #358 で完了済み。タスク別セクションは既に機能しており、S1 は書き込み側だけを直す）
- **タスク画面上での決定・メンタリング記録の表示**（理由: 決定ログのタスク軸セクションを正とし二重表示を作らない。**S2a でも一覧表示は作らず、導線だけを置く**。決定 14）
- **メンタリングの経過（やり取り）の記録**（理由: 現状の記録は結論 1 件（`content` / `rationale`）であり、経過を残す器の設計は S1 の価値に不要。S3）
- **メンタリング専用の対話面の新設**（理由: 決定 2。`sessions` / `messages` の扱いが増える）
- **`RECORD_MENTORING_TOOL` のスキーマ変更（`task_id` の必須化）**（理由: 決定 5。朝会の全日単位メンタリングを壊す）
- **DB スキーマの変更・新規テーブルの追加**（理由: `decisions.task_id` が既にあり、新しいキー体系を作る理由が無い）
- **`useChat` の多重送信ガード（`sendingRef.current || switchingRef.current` の早期 return）の変更**（理由: 決定 8。最後の防波堤として残す。S1a が足すのは UI の可否条件であってガードではない）
- **`send` / `sendChatMessage` の戻り値型の変更**（理由: 決定 8 の代替案 (b) を却下したため。全呼び出し元に及ぶ横断変更を S1a に載せない）
- **`editingMessageId` の `useChat` へのリフトアップ**（理由: 確証 (F) によりタスク画面表示中は常に `null` であり、リフトしなくてもヘッダと等価な可否条件になる。`ChatView.tsx:268-277` が「編集中は一時的な UI 状態」と明記した設計を覆さない）
- **`mentoringTaskId` の 404 応答の形（#477）**（理由: 別スライスとして並走しており、同じ仕様ファイルの別の節で扱う。なお確証 (L) のとおりタスクは削除できないため、S1b が毎ターン送る形にしても 404 の到達可能性は増えない）
- **全日単位の随時メンタリング（`ChatView` ヘッダ導線・#411）の同じターン単位欠落**（理由: S1b を小さく保つため範囲外とし、Issue #491 として独立に起票した。確証 (G)。S1b の実装形が確定してから、同じ「相談中」機構を広げるかを判断する。→ `docs/features/day-mentoring-consultation.md` で要件化）
- **サーバ側の変更・DB マイグレーション（S1b）**（理由: 決定 10。担保は既存のサーバ側補完〔決定 5〕が持ち続けるため、S1b は web だけで成立する）
- **リロードをまたいだ「相談中」状態の復元**（理由: 決定 12。唯一の劣化が安全側かつ可視であるため受容する。必要になったら (a′) を追補する）
- **やりなおし経路（`rewrite`・#376）への「相談中」文脈の付加**（理由: `rewrite` は `send` とは別の送信経路であり、過去の発言の差し替えという別の意味を持つ。S1b は `send` 経路に限る）
- **過去記録の期間による絞り込み（S2b）**（理由: 決定 16。締切の遠いタスクほど相談の間隔が空くため、期間上限は「古いが唯一の記録」を落とす方向に壊れる）
- **過去記録ブロックの最良詰め合わせ（上限に収まる組み合わせを探す詰め方）**（理由: 決定 18。新しい側から詰めて超えたら打ち切る単純な規則に揃える。`selectTodaysAdhocMessages` と同じ作法）
- **振り返り導線・決定ログのセクション id（S2a の範囲）を S2b で実装すること**（理由: 決定 13 で別スライスに割った。S2b は `web/` に 1 行も差分を作らない）
- **決定ログ API（`GET /api/decisions`）へのフィルタ・ページングの追加**（理由: S2b の新規クエリはプロンプト組み立て専用のサーバ内部の読み取りであり、画面へ公開する必要が無い。決定ログ画面は従来どおり全件を受け取って `groupDecisionsByTask` で束ねる）
- **`RecentDecision` 型への `id` 追加と、過去記録セクションと「直近の決定」セクションの重複排除**（理由: 決定 17。重複は既知の帰結として受容する。排除は横断変更を招き、受入基準も重複の有無を固定しない）

## 受入基準

> **実装対象スライス S2b の基準は「### 対象タスクの過去記録のプロンプト投入（S2b・Issue #438）」節と「### 検証方法・品質ゲート」節**（`- [ ]`）。`- [x]` の節（S1 / S1a / S1b）は**出荷済みの基準**であり、S2b の実装時は**新規テストの追加は不要・既存テストが引き続き通ることの確認のみ**でよい（満たし直す対象ではないが、壊してもいけない）。「### 振り返り導線（S2a・Issue #438）」節は**次スライス S2a の基準**であり、S2b では満たさなくてよい（壊してもいけない）。S3 の基準はここに書かない。

### 画面（タスクカード・タスクボード・AppLayout）

- [x] `adhoc` 区間のとき、タスクカードの表示モードに「メンタリングする」ボタンが表示される
- [x] 会（朝会・夕会）の最中は、タスクカードに「メンタリングする」ボタンが表示されない
- [x] 「メンタリングする」を押すと、表示中のビューがチャットへ切り替わる
- [x] 「メンタリングする」を押すと、対象タスクのタイトルを含む発言が 1 回送信される
- [x] タスクカードの既存の表示テキスト（タイトル・説明・ボスコメント）は変わらない
- [x] タスクカードの既存のボス決定表示（優先度・締切）は変わらない
- [x] タスクカードの既存の操作項目（ステータス select・編集ボタン）は変わらない

### 送信内容（`chat-api.ts` / `use-chat.ts`）

- [x] タスク起点の送信では、リクエストボディに `mentoring: true` が含まれる
- [x] タスク起点の送信では、リクエストボディの `mentoringTaskId` が対象タスクの id と一致する
- [x] チャット画面ヘッダのボタンからの送信では、リクエストボディに `mentoringTaskId` キーが含まれない
- [x] メンタリングでない通常の送信のリクエストボディは `{ content }` と完全一致する（`mentoring` / `mentoringTaskId` のいずれのキーも持たない）

### リクエストの受理・拒否（`sessions-validation.ts` / `chat-messages-route.ts`）

- [x] `mentoringTaskId` が正の整数でないボディ（文字列・小数・真偽値・0・負数）は 400 で拒否される
- [x] `mentoringTaskId` を含み `mentoring: true` を含まないボディは 400 で拒否される
- [x] 存在しないタスク id を `mentoringTaskId` に指定したリクエストは 404 で拒否される
- [x] 上記いずれかの理由で拒否されたリクエストのユーザー発言は、`messages` に保存されない
- [x] `mentoringTaskId` を含まない既存のボディ（`content` のみ／`content` ＋ `mentoring: true`／`content` ＋ `replaceFromMessageId`）は、従来どおり受理される

### システムプロンプト（`persona-prompt.ts`・純粋関数）

- [x] `mentoringTaskId` が指定され、その id が `tasks` に存在するとき、システムプロンプトに対象タスクの 1 行（ステータス・`#id`・タイトル・優先度・エビデンス・締切）を含む「対象タスク」セクションが現れる
- [x] `mentoringTaskId` が指定されたとき、システムプロンプトに `record_mentoring` の `task_id` へ対象タスクの id を指定するよう促す指示が含まれる
- [x] `mentoringTaskId` が指定されていないメンタリングのターンでは、「対象タスク」セクションが現れない
- [x] `mentoringTaskId` が `tasks` に存在しない id のとき、「対象タスク」セクションが現れない
- [x] `mentoring` が偽のターンでは、`mentoringTaskId` が渡されても「対象タスク」セクションが現れない
- [x] 既存の `MENTORING_FLOW_INSTRUCTION` は、メンタリングのターンで従来どおり積まれる

### `task_id` の補完（`boss-tools.ts` / `mentoring-tool.ts`）

- [x] `mentoringTaskId` があるターンで、`record_mentoring` が `task_id` 未指定で呼ばれたとき、保存される `decisions` 行の `task_id` は `mentoringTaskId` と一致する
- [x] `mentoringTaskId` があるターンで、`record_mentoring` が `task_id` を明示して呼ばれたとき、保存される行の `task_id` はボスが指定した値と一致する（補完が上書きしない）
- [x] `mentoringTaskId` が無いターンで、`record_mentoring` が `task_id` 未指定で呼ばれたとき、保存される行の `task_id` は `null` のままになる
- [x] 補完で保存された行の `kind` は `mentoring` である
- [x] `record_decision`（`kind='decision'`）の保存経路は、`mentoringTaskId` があるターンでも補完の影響を受けない

### 既存契約の保全

- [x] `RECORD_MENTORING_TOOL` の `input_schema.required` は `["content"]` のままである
- [x] `mentoring-gate.ts` の `isMentoringComplete` の判定（`mentoringRecordCount > 0 && userMessageCount > 0`）は変わらない
- [x] `listRecentDecisions` は `kind = 'decision'` のみを返す（`kind='mentoring'` を SQL レベルで除外する契約が変わらない）
- [x] チャット画面ヘッダの随時メンタリングボタンは、`adhoc` 区間で従来どおり表示される
- [x] チャット画面ヘッダの随時メンタリングボタンを押すと、従来どおり `mentoring: true` 付きの送信が行われる

### 導線の対称性（S1a・Issue #474）

> **出荷済み S1a（#489・`75794aa`）の基準。** 決定 8・決定 9 に対応する。

- [x] 送信中（`chatState.sending` が真）のとき、タスクカードの「メンタリングする」ボタンは非活性である
- [x] セッション切替中（`chatState.switching` が真）のとき、タスクカードの「メンタリングする」ボタンは非活性である
- [x] 送信中（`sending`）でも、`adhoc` 区間ならボタン自体はカード上に表示され続ける（非活性であって非表示ではない）
- [x] セッション切替中（`switching`）でも、`adhoc` 区間ならボタン自体はカード上に表示され続ける（非活性であって非表示ではない）
- [x] 送信が終わり `chatState.sending` が偽に戻ると、ボタンは再び活性になる
- [x] セッション切替が終わり `chatState.switching` が偽に戻ると、ボタンは再び活性になる
- [x] 非活性のボタンを押しても、表示中のビューはチャットへ切り替わらない
- [x] 非活性のボタンを押しても、メッセージ送信（`send`）は行われない
- [x] ヘッダの随時メンタリングボタンとタスクカードの導線の可否条件が一致する（同一の `chatState` のもとで、一方が押せて他方が押せない状態が無い）
- [x] タスク画面を表示して戻ると、チャットの編集モードは解除されている（`ChatView` のアンマウントで `editingMessageId` が破棄される＝タスクカード導線にとってヘッダ条件の `editingMessageId !== null` が常に偽である根拠）
- [x] タスクカードは `onStartMentoring` に対象タスク（id とタイトルを持つ）をそのまま渡す
- [x] `AppLayout` のハンドラは渡されたタスクをそのまま使い、id による `tasksState.tasks` からの再検索を行わない
- [x] タスクカードの導線から送信される発言の文面には、そのカードが表示しているタスクのタイトルが入る
- [x] タスクカードの導線から送信されるリクエストボディの `mentoringTaskId` は、そのカードのタスクの id と一致する（S1a の引数変更で変わらない）

次の 3 項目は**既存テストで担保済み**であり、S1a では新規実装・新規テストを要さなかった（回帰確認のみ）:

- [x] `useChat` の `send` は、送信中（`sendingRef`）に呼ばれたら従来どおり何もせず戻る（多重送信ガードを変更しない）
- [x] `useChat` の `send` は、セッション切替中（`switchingRef`）に呼ばれたら従来どおり何もせず戻る（多重送信ガードを変更しない）
- [x] `useChat` の `send` の戻り値型は `Promise<void>` のままである

### 相談中の保持と解除（S1b・Issue #476）

> **出荷済み S1b（#476・`4106645`）の基準。** 決定 10・決定 11・決定 12 に対応する。
>
> **リクエストボディに関する基準は、`fetch` 境界で実際に送られた body を検証すること**（`send` に渡った引数や `sendChatMessage` の呼び出し引数を見ない）。#476 の欠陥は「`send` の呼び出し側が渡し忘れる」ことなので、`send` の引数側で確認する基準は欠陥を再現しても緑のままになりうる。
>
> **包含側と除外側の両方を基準にする**（片側だけを固定すると恒真になりうる）。

相談中の可視化（決定 10・画面仕様）:

- [x] タスクカードから「メンタリングする」を押すと、チャット画面に相談中の状態表示が現れる
- [x] その状態表示には**対象タスクのタイトル**が含まれる
- [x] その状態表示には**解除の導線**（ボタン）が含まれる
- [x] 相談中でないとき、この状態表示は描画されない
- [x] 相談中の状態表示はタイムライン（会話の並び）の中ではなく、セッションヘッダ側の帯に描画される（発言として会話へ混ざらない）

継続中の送信内容（決定 10・包含側）:

- [x] 相談中に入力欄から送った **2 ターン目**のリクエストボディに `mentoringTaskId` が載り、その値は開始したタスクの id と一致する
- [x] 相談中に入力欄から送った **2 ターン目**のリクエストボディに `mentoring: true` が載る
- [x] **3 ターン目以降**も同じく両方が載り続ける（2 ターン目だけの特別扱いになっていない）
- [x] 呼び出し側が `options` を渡さない `send(content)` でも上の 2 つが載る（付加は `useChat.send` 自身が行い、呼び出し側の渡し忘れに依存しない）
- [x] 別タスクのカードからメンタリングを開始すると、以後のリクエストボディの `mentoringTaskId` は**新しいタスクの id** に置き換わる

解除（決定 11・除外側）:

- [x] 解除の導線を押すと、相談中の状態表示が消える
- [x] 解除したあとに入力欄から送ったリクエストボディには `mentoringTaskId` が**載らない**
- [x] 解除したあとに入力欄から送ったリクエストボディには `mentoring` が**載らない**
- [x] チャット画面ヘッダの全日単位メンタリングボタンを押すと対象タスクの相談中が解除され、そのリクエストボディには `mentoring: true` が載る一方で `mentoringTaskId` は**載らない**（**この基準の「解除」の意味は #491 で「全日単位の相談中へ置き換え」へ上書きされた**。`docs/features/day-mentoring-consultation.md`。`mentoringTaskId` が載らないことは上書き後も変わらない）
- [x] 会（朝会・夕会）を開始すると相談中が解除され、状態表示が消える
- [x] 会を終了すると相談中が解除され、状態表示が消える
- [x] 会の最中に送った発言のリクエストボディには `mentoringTaskId` が載らない（`adhoc` で選んだ対象タスクが会のセッションへ持ち越されない＝確証 (K) の前提を守る）

受容する劣化（決定 12）:

- [x] リロードすると相談中の状態は失われ、状態表示も消える（失われたことが画面で分かる）
- [x] 状態が失われたあとの発言は「紐づかない」だけで、**別のタスクへ紐づくことはない**

既存契約の保全（S1b・回帰確認のみ。新規実装を要さない）:

- [x] サーバ側のコードは 1 行も変更されていない（`server/` に差分が無い）
- [x] DB マイグレーションは追加されていない（`migrate.ts` の最大 version が 8 のまま）
- [x] `useChat` の多重送信ガード（`sendingRef` / `switchingRef` の早期 return）は変更されていない
- [x] `send` / `sendChatMessage` の戻り値型は `Promise<void>` のままである
- [x] やりなおし経路（`rewrite`）のリクエストボディは変わらない（相談中でも `mentoringTaskId` / `mentoring` を付加しない）

### 対象タスクの過去記録のプロンプト投入（S2b・Issue #438）

> **実装対象スライス S2b の範囲。** 決定 16・決定 17・決定 18・決定 19 に対応する。
>
> **プロンプトに関する基準は `buildPersonaPrompt` の戻り値の文字列に対して検証すること**（純粋関数なので DB もネットワークも要らない）。クエリに関する基準は実 SQLite（`:memory:` か一時ファイル）に対して検証する（CLAUDE.md「テスト方針」: SQLite はモックしない）。
>
> **決定 17 のとおり、対象タスクの記録が「直近の決定」セクションにも現れうることは受容する。この節のどの基準も、重複の有無を固定しない。**

対象タスクに紐づく記録を引く新規クエリ（`decisions-repository.ts`）:

- [ ] 新規クエリは、指定した `task_id` を持つ `decisions` 行だけを返す（他タスクの行・`task_id` が `null` の行を含まない）
- [ ] 新規クエリは `kind = 'decision'` の行と `kind = 'mentoring'` の行の両方を返す
- [ ] 新規クエリは新しい順（`created_at` 降順、同時刻は `id` 降順）で返す
- [ ] 新規クエリは指定された件数上限を超える行を返さない
- [ ] 件数上限で打ち切られるとき、返るのは新しい側の行である（古い側が落ちる）
- [ ] 指定した `task_id` に紐づく行が 1 件も無いとき、新規クエリは空配列を返す

システムプロンプトへの投入（`persona-prompt.ts`・純粋関数）:

- [ ] `mentoring` が真・`mentoringTaskId` が `tasks` に存在・記録が 1 件以上、の 3 つが揃うとき、システムプロンプトに対象タスクの過去記録のセクションが現れる
- [ ] システムプロンプト上のセクションの順序が「対象タスク」→ `MENTORING_TARGET_TASK_INSTRUCTION` → 過去記録である（過去記録が前 2 つの間に挟まらない）
- [ ] そのセクションの各行に、記録の `content` が含まれる
- [ ] `rationale` を持つ記録の行には、その `rationale` が含まれる
- [ ] `rationale` が `null` の記録の行には、根拠を表す句が現れない
- [ ] 各行には種別ラベルが含まれる（`kind='decision'` は「決定」、`kind='mentoring'` は「メンタリング」。決定ログ画面の `KIND_LABEL` と同じ語彙）
- [ ] 各行には記録の日時が含まれる（既存の「直近の決定」と同じ日時の書式で表示される）
- [ ] 記録が 0 件のとき、このセクションは現れない（見出しだけのセクションを積まない）
- [ ] `mentoring` が偽のターンでは、記録が渡されてもこのセクションは現れない
- [ ] `mentoringTaskId` が `tasks` に存在しない id のとき、このセクションは現れない
- [ ] このセクションの追加によって、既存の「直近の決定」セクションの内容は変わらない
- [ ] このセクションの追加によって、既存の「対象タスク」セクションの内容は変わらない

長さの制御（決定 18）:

- [ ] 記録の `content` ＋ `rationale` の合計が文字数上限を超えるとき、新しい側の記録がセクションに残り、古い側の記録が落ちる
- [ ] 文字数上限によって省略・切り詰めが起きたとき、その旨を示す通知がセクション内に現れる
- [ ] 省略・切り詰めが起きていないとき、その通知は現れない
- [ ] **最新の 1 件が単独で**文字数上限を超えるとき、プロンプトの生成は失敗せず、その 1 件が上限の長さへ切り詰められて現れる（記録が 1 件しか無い場合も、複数件あって最新の 1 件だけが単独で超える場合も、同じように切り詰めて残す）
- [ ] 件数上限（5 件）と文字数上限の両方が効く（件数に収まっていても、文字数上限を超える分は落ちる）

チャットルートでの結線（`chat-messages-route.ts`）:

- [ ] `mentoring: true` ＋ 有効な `mentoringTaskId` を伴うリクエストでは、対象タスクに紐づく記録が最大 5 件プロンプトへ渡される
- [ ] `mentoringTaskId` を伴わないメンタリングのターンでは、過去記録のセクションがプロンプトに現れない
- [ ] メンタリングでない通常のターンでは、過去記録のセクションがプロンプトに現れない

既存契約の保全（S2b）:

- [ ] `listRecentDecisions` は `kind = 'decision'` のみを返す（`kind='mentoring'` を SQL レベルで除外する #408 AC-42 の契約が変わらない）
- [ ] 日報の抽出（`collect-daily-report-data.ts`）は `kind = 'mentoring'` の行を含まない（#408 AC-43）
- [ ] 作業ログの抽出（`collect-work-log-data.ts`）は `kind = 'mentoring'` の行を含まない（#408 AC-44）
- [ ] `mentoring-gate.ts` の `isMentoringComplete` の判定（`mentoringRecordCount > 0 && userMessageCount > 0`）は変わらない
- [ ] `RECORD_MENTORING_TOOL` の `input_schema.required` は `["content"]` のままである
- [ ] `task_id` の補完（決定 5）の挙動は変わらない
- [ ] web 側のコードは 1 行も変更されていない（`web/` に差分が無い）
- [ ] DB マイグレーションは追加されていない（`migrate.ts` の最大 version が 8 のまま）

### 振り返り導線（S2a・Issue #438）

> **次スライス S2a の範囲であり、S2b では満たさなくてよい（壊してもいけない）。** 決定 14・決定 15 に対応する。起票は S2b のマージ後。
>
> `scrollIntoView` は jsdom に無い（確証 (R)）。**呼び出しの観測は `ChatView.test.tsx:1471-1495` と同じくプロトタイプ側を差し替えて行う**こと。

タスクカードの導線（決定 14）:

- [ ] タスクカードの表示モードに、そのタスクの記録を決定ログで見る導線が表示される
- [ ] その導線は会（朝会・夕会）の最中にも表示される（`adhoc` 限定にしない）
- [ ] その導線は、記録が 1 件も無いタスクのカードにも表示される
- [ ] その導線を押すと、表示中のビューが決定ログへ切り替わる
- [ ] タスクカードの既存の操作項目（ステータス select・編集ボタン・「メンタリングする」ボタン）は変わらない
- [ ] タスク画面には決定・メンタリング記録の一覧を表示しない（導線だけを置く）

決定ログ側（決定 15）:

- [ ] 決定ログのタスク別セクションに、そのタスクの id から導かれる `id` 属性が付く
- [ ] `task_id` を持たない記録のセクションにも `id` 属性が付く
- [ ] 導線から遷移したとき、対象タスクのセクションの要素に対して `scrollIntoView` が呼ばれる
- [ ] 記録が 1 件も無いタスクの導線を押したとき、決定ログは開くがスクロールは行われない
- [ ] ナビゲーションから決定ログを開いたとき（導線を経由しないとき）は `scrollIntoView` が呼ばれない
- [ ] カードの導線から決定ログを開いてスクロールしたあと、別のビューへ移動してからナビゲーションで決定ログを開き直すと、`scrollIntoView` が呼ばれない（対象が一度の遷移で消費される）
- [ ] 記録が 1 件も無いタスクの導線から開いたあと、ナビゲーションで決定ログを開き直しても `scrollIntoView` が呼ばれない（スクロールしなかった場合も対象が消費される）
- [ ] `scrollIntoView` を持たない実行環境でも例外を投げない
- [ ] 決定ログの既存の表示（セクションの見出し・セクションの並び順・記録の並び順・記録の描画内容）は変わらない
- [ ] サーバ側のコードは 1 行も変更されていない（`server/` に差分が無い）

### 検証方法・品質ゲート

> S1・S1a・S1b では満たし済み。**S2b でも同じ 3 項目を満たすこと**（スライスごとに再度確認する）。

- [ ] `npm run lint` / `npm run typecheck` / `npm test` がすべて通る
- [ ] Claude API（`@anthropic-ai/sdk` / claude-agent-sdk）はテストでモックする（実リクエストを発生させない）
- [ ] テストで時刻を固定する場合は `new Date(y, m, d, h)` 由来で導出する（UTC 文字列リテラルで固定しない）
