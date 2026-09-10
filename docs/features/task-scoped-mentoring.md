# タスク単位のメンタリング（タスク画面から「メンタリングする」）

## 概要

タスクカードから「メンタリングする」で、**そのタスクを対象にした随時メンタリング**を開始できるようにする。対象タスクは定型文への埋め込みではなく **`mentoringTaskId` をリクエストボディに載せて決定的に**サーバへ渡し、ボスのシステムプロンプトへ「対象タスク」として積む。メンタリングの結論（`decisions.kind = 'mentoring'`）が対象タスクへ確実に紐づくことは、**サーバ側の `task_id` 補完**で担保する（プロンプト指示だけに依存しない）。

新しいテーブル・新しいキー体系は作らない。器（`record_mentoring` の `task_id` 引数・`decisions.kind='mentoring'`・決定ログのタスク別セクション）は既に実装済みであり、欠けている「タスクを起点に始める導線」だけを本スライスで足す（#438）。

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

- **(A) 過去のメンタリング記録はボスのプロンプトに入らない。** `listRecentDecisions` は `WHERE kind = 'decision'` で **SQL レベルで mentoring 行を除外**する（`decisions-repository.ts:107`、#408 AC-42）。Issue #438 の期待動作「関連する**過去の決定**を踏まえて深掘り」は、プロンプト文脈を変えない限り成立しない（本スライスでは扱わない。下記「S1 で満たさないこと」）。
- **(B) `mentoring: true` は既に「LLM を経由しない決定的なリクエストフラグ」である。** `chat-api.ts:196` → `sessions-validation.ts:92-97` → `chat-messages-route.ts:279` → `PersonaPromptContext.mentoring`。対象タスクを同じ経路に載せるのは新機構ではなく、既存経路への 1 フィールド追加になる。
- **(C) 画面間遷移の仕組みが無い。** `setActiveView` は `AppLayout.tsx:158` のナビボタンからしか呼ばれていない。ただし `chatState`（`useChat`）は `AppLayout.tsx:59` に既にリフト済みで、`activeView` も同じ関数コンポーネントの state（`:67`）であるため、コールバックを 1 本子へ通せば「ビュー切替＋送信」は既存状態だけで成立する。
- **(D) プロンプトのタスク一覧には既に `#id` が入っている。** `purpose === "chat"` のとき `includeId` が真になり（`persona-prompt.ts:289`・`:632`）、`- [進行中] #12 タイトル（優先度: 高 / エビデンス: … / 締切: …）` の形で出る。ボスが `record_mentoring` の `task_id` に何を入れるべきかは一意に解決できる。
- **(E) タスク起点の導線を `adhoc` 区間に限れば、朝会ゲートには一切算入されない。** ゲートの件数は `session_id` スコープであり（`sessions-routes.ts:144`）、`record_mentoring` に渡る `sessionId` はチャットルートが渡す現在セッションである（`chat-messages-route.ts:325-326`）。`adhoc` セッションに記録された mentoring 行は朝会セッションの件数に入らないため、**ゲートのコードを 1 行も変えずに現状の判定が保たれる**。本スライスの受入基準が下記「未決の論点（判断7）」から独立できる根拠はここにある。

## ユーザーストーリー

タスクを抱えるオーナーとして、**特定のタスクを指してボスに進め方を相談したい**。チャットの「今の進め方を見てほしい」はその日全体が対象なので、1 件のタスクを綿密に詰めたいときに毎回タスクの内容を説明し直す必要があり、しかも結論がそのタスクに紐づかないため後から辿れない。

## 機能要件

- [ ] タスクカードの表示モードから、そのタスクを対象にしたメンタリングを開始できる
- [ ] 「メンタリングする」を押すと、表示中のビューがチャットへ切り替わる
- [ ] 「メンタリングする」を押すと、対象タスクを添えたメンタリングの発言が 1 回送信される
- [ ] ボスのシステムプロンプトに、対象タスクのタスク行情報（ステータス・id・タイトル・優先度・エビデンス・締切）が「対象タスク」セクションとして積まれる
- [ ] メンタリングの結論が対象タスクへ紐づいて記録される（`decisions.task_id` が埋まる）
- [ ] 会（朝会・夕会）の最中は、タスクカードにメンタリングの開始導線を出さない
- [ ] チャット画面ヘッダの随時メンタリングボタン（その日全体が対象）は `adhoc` 区間で従来どおり表示され、押すと従来どおり `mentoring: true` 付きで送信される

## 技術的な制約・方針

- **変更対象（web）**: `TaskCard.tsx` / `TaskBoard.tsx` / `AppLayout.tsx` / `chat-api.ts` / `use-chat.ts` / `ChatView.tsx`（既存 `send` 呼び出し 1 行の追随のみ）とそれぞれのテスト
- **変更対象（server）**: `server/src/sessions/sessions-validation.ts` / `server/src/sessions/chat-messages-route.ts` / `server/src/boss/persona-prompt.ts` / `server/src/boss/boss-tools.ts` / `server/src/boss/mentoring-tool.ts` とそれぞれのテスト
- **変更しない**: `server/src/sessions/mentoring-gate.ts`（朝会ゲートの判定）、`server/src/decisions/decisions-repository.ts` の `listRecentDecisions`（`kind='decision'` 除外＝#408 AC-42）、`RECORD_MENTORING_TOOL` の `required`（`["content"]` のまま）、`DecisionLog.tsx` / `group-decisions-by-task.ts`、DB スキーマ（マイグレーション無し）
- **DB スキーマ変更は無い**。`decisions.task_id` は既存列であり、本スライスは書き込み経路を確実にするだけである
- **セッションの遅延生成は既存の `useChat` に任せる**。`send` は活性セッションが無ければ最初の送信時にセッションを作る（`use-chat.ts` の `activeSessionId` JSDoc）。タスク起点でも同じ経路を通るため、セッション生成の分岐を新設しない
- **多重送信の抑止も既存の `useChat` に任せる**。送信中の `send` は無視される（`use-chat.test.ts:628-631`）。タスクカード側に独自のガードを足さない
- 外部送信は Claude API への推論リクエストのみ（ADR 0001）。本スライスは送信内容にタスクのタイトル・締切・優先度を含めるが、これは既にプロンプトのタスク一覧として送っている情報の範囲内であり、送信先も範囲も広がらない
- テストで固定時刻を使う場合は `new Date(y, m, d, h)` 由来で導出する（UTC 文字列リテラルで固定しない。ADR 0007 決定 5）。本スライスは日付境界に触らないため `npm run test:tz` は必須ゲートではない
- Claude API・時刻・macOS 通知コマンドはテストでモックする。SQLite はモックしない（CLAUDE.md「テスト方針」）

## 画面・API設計

### 画面（タスクカード）

タスクカードの**表示モード**のアクション行（現在「編集」ボタンだけがある `TaskCard.tsx:331-335` の `div.task-card-actions`）に「メンタリングする」ボタンを追加する。編集モードのフォーム内には置かない。

ボタンを押すと、(1) 表示中のビューがチャットへ切り替わり、(2) 対象タスクを添えたメンタリングの発言が 1 回送信される。

### IF（層間の境界となる契約）

```text
TaskCard          onStartMentoring: ((taskId: number) => void) | null
                    ── null のときボタンを描画しない（＝会の最中）
   ↓ props
TaskBoard         onStartMentoring をそのまま TaskCard へ渡す（判断に関与しない）
   ↓ props
AppLayout         chatState.sessionType === "adhoc" のときだけハンドラを渡し、
                  それ以外は null を渡す。ハンドラは
                  setActiveView("chat") と chatState.send(...) を呼ぶ
   ↓
use-chat.send(content, options?)
                  options: { mentoring?: true; mentoringTaskId?: number }
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
> **見出しの番号は本仕様での通し番号であり、Issue #438 の「判断 N」とは別体系である。** 対応がある決定には見出しに `（判断N）` を併記した。併記の無い見出し（4・6・7）は本仕様での追加決定であり、**とくに見出し 7 は未決の「判断7」とは無関係**である。

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

## 未決の論点（人間の決定待ち）

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

## S1 で満たさないこと（Issue #438 の期待動作との差）

Issue #438 の期待動作のうち「ボスがそのタスクの文脈（内容・締切・優先度・**関連する過去の決定**）を踏まえて深掘りできる」は、**S1 では部分的にしか満たさない**。S1 が積むのは対象タスクの**タスク行情報**（ステータス・id・タイトル・優先度・エビデンス・締切）までであり、**そのタスクに紐づく過去の決定・過去のメンタリング記録はプロンプトに入らない**。確証 (A) のとおり `listRecentDecisions` は `kind='mentoring'` を SQL レベルで除外しており、この除外（#408 AC-42）は本スライスでは変更しない。過去記録の投入は S2 で扱う。

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | タスクカード（`adhoc` 区間のみ）から「メンタリングする」→ チャット面へ遷移し、`mentoringTaskId` を載せた随時メンタリングを開始。ボスは対象タスクのタスク行情報を認識し、結論はサーバ側補完で確実にそのタスクへ紐づく | 20-24 | これだけで価値が出る（タスクを指して相談でき、結論が決定ログのそのタスクのセクションに溜まる） |
| S2 | 振り返り導線（タスク画面 → 決定ログの当該セクションへアンカー移動。`DecisionLog` にセクション id を付与）＋ 対象タスクに紐づく過去の決定・メンタリング記録のプロンプト投入 | 8-12 | S1 がマージされてから |
| S3 | メンタリングの経過（やり取り）を残す仕組み／朝会ゲートとの関係（**判断7 の人間決定が入ってから**着手する） | 未定 | S2 がマージされ、かつ判断7 が決定されてから |

実装対象: S1

## やらないこと

- **朝会ゲートの判定ロジックの変更**（理由: 判断7 は人間の決定事項であり未決。`mentoring-gate.ts` は 1 行も変えない）
- **`listRecentDecisions` の `kind='decision'` 除外の変更**（理由: #408 AC-42 の契約であり、メンタリング行が直近の決定の枠を食う問題を解いている。過去記録の投入は S2 で別経路として設計する）
- **`DecisionLog.tsx` / `group-decisions-by-task.ts` の再構成**（理由: #358 で完了済み。タスク別セクションは既に機能しており、S1 は書き込み側だけを直す）
- **タスク画面上での決定・メンタリング記録の表示**（理由: 決定ログのタスク軸セクションを正とし二重表示を作らない。導線は S2）
- **メンタリングの経過（やり取り）の記録**（理由: 現状の記録は結論 1 件（`content` / `rationale`）であり、経過を残す器の設計は S1 の価値に不要。S3）
- **メンタリング専用の対話面の新設**（理由: 決定 2。`sessions` / `messages` の扱いが増える）
- **`RECORD_MENTORING_TOOL` のスキーマ変更（`task_id` の必須化）**（理由: 決定 5。朝会の全日単位メンタリングを壊す）
- **DB スキーマの変更・新規テーブルの追加**（理由: `decisions.task_id` が既にあり、新しいキー体系を作る理由が無い）

## 受入基準

> 実装対象スライス S1 の範囲。S2 / S3 の基準はここに書かない。

### 画面（タスクカード・タスクボード・AppLayout）

- [ ] `adhoc` 区間のとき、タスクカードの表示モードに「メンタリングする」ボタンが表示される
- [ ] 会（朝会・夕会）の最中は、タスクカードに「メンタリングする」ボタンが表示されない
- [ ] 「メンタリングする」を押すと、表示中のビューがチャットへ切り替わる
- [ ] 「メンタリングする」を押すと、対象タスクのタイトルを含む発言が 1 回送信される
- [ ] タスクカードの既存の表示テキスト（タイトル・説明・ボスコメント）は変わらない
- [ ] タスクカードの既存のボス決定表示（優先度・締切）は変わらない
- [ ] タスクカードの既存の操作項目（ステータス select・編集ボタン）は変わらない

### 送信内容（`chat-api.ts` / `use-chat.ts`）

- [ ] タスク起点の送信では、リクエストボディに `mentoring: true` が含まれる
- [ ] タスク起点の送信では、リクエストボディの `mentoringTaskId` が対象タスクの id と一致する
- [ ] チャット画面ヘッダのボタンからの送信では、リクエストボディに `mentoringTaskId` キーが含まれない
- [ ] メンタリングでない通常の送信のリクエストボディは `{ content }` と完全一致する（`mentoring` / `mentoringTaskId` のいずれのキーも持たない）

### リクエストの受理・拒否（`sessions-validation.ts` / `chat-messages-route.ts`）

- [ ] `mentoringTaskId` が正の整数でないボディ（文字列・小数・真偽値・0・負数）は 400 で拒否される
- [ ] `mentoringTaskId` を含み `mentoring: true` を含まないボディは 400 で拒否される
- [ ] 存在しないタスク id を `mentoringTaskId` に指定したリクエストは 404 で拒否される
- [ ] 上記いずれかの理由で拒否されたリクエストのユーザー発言は、`messages` に保存されない
- [ ] `mentoringTaskId` を含まない既存のボディ（`content` のみ／`content` ＋ `mentoring: true`／`content` ＋ `replaceFromMessageId`）は、従来どおり受理される

### システムプロンプト（`persona-prompt.ts`・純粋関数）

- [ ] `mentoringTaskId` が指定され、その id が `tasks` に存在するとき、システムプロンプトに対象タスクの 1 行（ステータス・`#id`・タイトル・優先度・エビデンス・締切）を含む「対象タスク」セクションが現れる
- [ ] `mentoringTaskId` が指定されたとき、システムプロンプトに `record_mentoring` の `task_id` へ対象タスクの id を指定するよう促す指示が含まれる
- [ ] `mentoringTaskId` が指定されていないメンタリングのターンでは、「対象タスク」セクションが現れない
- [ ] `mentoringTaskId` が `tasks` に存在しない id のとき、「対象タスク」セクションが現れない
- [ ] `mentoring` が偽のターンでは、`mentoringTaskId` が渡されても「対象タスク」セクションが現れない
- [ ] 既存の `MENTORING_FLOW_INSTRUCTION` は、メンタリングのターンで従来どおり積まれる

### `task_id` の補完（`boss-tools.ts` / `mentoring-tool.ts`）

- [ ] `mentoringTaskId` があるターンで、`record_mentoring` が `task_id` 未指定で呼ばれたとき、保存される `decisions` 行の `task_id` は `mentoringTaskId` と一致する
- [ ] `mentoringTaskId` があるターンで、`record_mentoring` が `task_id` を明示して呼ばれたとき、保存される行の `task_id` はボスが指定した値と一致する（補完が上書きしない）
- [ ] `mentoringTaskId` が無いターンで、`record_mentoring` が `task_id` 未指定で呼ばれたとき、保存される行の `task_id` は `null` のままになる
- [ ] 補完で保存された行の `kind` は `mentoring` である
- [ ] `record_decision`（`kind='decision'`）の保存経路は、`mentoringTaskId` があるターンでも補完の影響を受けない

### 既存契約の保全

- [ ] `RECORD_MENTORING_TOOL` の `input_schema.required` は `["content"]` のままである
- [ ] `mentoring-gate.ts` の `isMentoringComplete` の判定（`mentoringRecordCount > 0 && userMessageCount > 0`）は変わらない
- [ ] `listRecentDecisions` は `kind = 'decision'` のみを返す（`kind='mentoring'` を SQL レベルで除外する契約が変わらない）
- [ ] チャット画面ヘッダの随時メンタリングボタンは、`adhoc` 区間で従来どおり表示される
- [ ] チャット画面ヘッダの随時メンタリングボタンを押すと、従来どおり `mentoring: true` 付きの送信が行われる

### 検証方法・品質ゲート

- [ ] `npm run lint` / `npm run typecheck` / `npm test` がすべて通る
- [ ] Claude API（`@anthropic-ai/sdk` / claude-agent-sdk）はテストでモックする（実リクエストを発生させない）
- [ ] テストで時刻を固定する場合は `new Date(y, m, d, h)` 由来で導出する（UTC 文字列リテラルで固定しない）
