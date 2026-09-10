# `due_at` / `updated_at` の扱いに残る設計論点の解消（#340）

## 概要

タスクの時刻値（`due_at` / `updated_at`）の扱いに残る 3 つの設計論点のうち、**論点(1)（同一ミリ秒更新でダッシュボードのキャッシュが stale のまま有効になる）**と**論点(3)（既存 DB に残る不正な `due_at` が検知を壊す）**を直す。**論点(2)（`due_at` が「暦日」と「瞬時」の両方を許すため下流の解釈が割れる）は未決**であり、本仕様では決定せず、選択肢と判断材料だけを記録する。

## 背景・目的

`tasks.due_at` と `tasks.updated_at` はどちらも制約の弱い TEXT 列であり、書き込み側の規律と読み出し側の解釈が揃っていない。その結果、次の 3 つが同時に成り立っている（いずれも本仕様の作成時に実コードで確証した。確証の詳細は「現状の確証」節）。

1. `updated_at` に単調増加の保証が無く、ダッシュボードの「今日のひとこと」が内容の変化を取りこぼす
2. `due_at` の値の意味（暦日か瞬時か）が保存形式から決まらず、UI の表示・編集と検知エンジンの解釈が割れる
3. 入力検証（PR #338）より前に保存された `due_at` の不正値が読み出し側で無防備に `new Date()` へ渡り、検知エンジンの出力を壊す

論点(1) と論点(3) は「どう作るか」だけの問題で、上流の体験を変えずに直せる。論点(2) は保存形式そのものの決定であり、**締切超過の検知タイミング＝催促の強度**というプロダクト体験に及ぶため、決定を人間に委ねる。

## ユーザーストーリー

- 利用者として、タスクを編集した直後にダッシュボードを見たとき、編集内容を踏まえたボスのひとことを見たい（編集前の前提で書かれた古いひとことを見せられたくない）。
- 利用者として、過去に登録した壊れた締切のせいで、本当に急ぐべきタスクが最優先と判定されなくなったり、決して来ない締切で催促され続けたりするのを避けたい。

## 現状の確証

Issue #340 の本文は 2026-09-05 時点の観察である。本仕様の作成時（2026-09-10、`main` = `8e87ccd`）に実コードで裏取りした結果を、以下に記録する。**この節は本仕様の前提であり、実装時にコードが動いていれば再確認すること**（docs は非権威）。

### 論点(1): 同一ミリ秒の連続更新とキャッシュ — Issue 記述どおり（確証できた）

- `server/src/tasks/tasks-repository.ts` の `updateTask` は `const now = new Date().toISOString()` をそのまま `updated_at` へ入れる。前回値との比較も単調増加の補正も無い。
- `server/src/dashboard/task-fingerprint.ts` の `computeTaskFingerprint` は各タスクを `{ id, updated_at }` だけへ射影して SHA-256 を取る。
- `server/src/dashboard/boss-comment-cache.ts` の `getCachedBossComment` は、暦日キーとフィンガープリントの**両方が一致したときだけ**キャッシュ本文を返す。
- 唯一の消費者は `server/src/dashboard/boss-comment.ts` の `getOrGenerateBossComment`（ダッシュボードの「今日のひとこと」）。

したがって、同一ミリ秒内に 2 回目の更新が入って `updated_at` が同値になると、内容が変わってもフィンガープリントが変わらず、古いひとことがキャッシュヒットとして返る経路は**実在する**。

補足（Issue に無い観察・実装時の判断材料）:

- `getOrGenerateBossComment` は `buildPersonaPrompt` に `taskEvidenceCounts` を渡していない（`persona-prompt.ts` 側で `?? {}` に落ちる）。このためダッシュボードのひとことのタスク行は、実際の添付件数によらず常に「添付0件」と描画される。**これは本仕様のスコープ外の別の欠陥**だが、「ひとことが何を根拠に書かれるか」を数える際にこの経路では添付件数が入力にならない、という事実として記録しておく。

### 論点(2): `due_at` の暦日と瞬時の混在 — Issue 記述どおり。ただし**波及範囲が過小**

Issue が挙げた経路は確証できた:

- `server/src/lib/iso-date.ts` の `isValidIsoDateOrDateTime` は `YYYY-MM-DD` と ISO 8601 日時の両方を受理する。
- `web/src/TaskCard.tsx` の `toDateInputValue` は `(dueAt ?? "").slice(0, 10)` で先頭 10 文字を切って `<input type="date">` に入れ、送信時（`handleSubmit`）はその日付文字列をそのまま `due_at` として書き戻す。
- `server/src/detection/deadline-overdue.ts` と `server/src/detection/priority.ts` は保存値を `new Date(...).getTime()` で**瞬時**として解釈する。

Issue に書かれていない、より広い（そして実運用ではより頻度の高い）ずれ:

- **`YYYY-MM-DD` は `new Date()` に UTC の 0 時として解釈される。** `TZ=Asia/Tokyo` で実測: `new Date("2026-09-05")` → `Sat Sep 05 2026 09:00:00 GMT+0900`。つまり web の日付入力から入った「9/5 締切」のタスクは、**9/5 の午前 9 時に締切超過と判定され催促が始まる**。UTC+14 の地域なら 9/5 14:00、UTC-11 の地域なら **9/4 13:00**（前日）である。
- Issue が例示したオフセット付き瞬時（`2026-09-05T00:30:00+14:00`）はボスの `create_task` / `update_task` がその形を出したときにしか発生しないが、上記の date-only 経路は **web の日付入力を使うたびに常に**発生する。
- これは ADR 0007 決定 1（「当日」は常にサーバーのローカル暦日を指し、UTC 基準の日付キーを使わない）に正面から反する。
- さらに、オフセットを持たない日時（`2026-09-05T00:30`）も `isValidIsoDateOrDateTime` を通り、`new Date()` は**ローカル時刻**として解釈する。したがって同じ `due_at` 列に、UTC 基準（date-only）・ローカル基準（オフセット無し日時）・明示オフセット（オフセット付き日時）の**3 通りの時間軸が混在しうる**。

#### `due_at` を書く／読む経路の全数列挙（2026-09-10 時点）

書く経路（`tasks.due_at` に値が入る経路。`INSERT INTO tasks` / `UPDATE tasks` は `tasks-repository.ts` の 2 箇所と `db/migrate.ts` のテーブル再構築のみ）:

| # | 経路 | 入口 | `isValidIsoDateOrDateTime` の検証 |
|---|------|------|-----|
| W1 | `POST /api/tasks` | `tasks-routes.ts` → `validateCreateTaskInput` → `insertTask` | あり |
| W2 | `PATCH /api/tasks/:id` | `tasks-routes.ts` → `validatePatchTaskInput` → `updateTask` | あり |
| W3 | ボスの `create_task` ツール | `server/src/boss/task-tools.ts` `executeCreateTask` → `validateCreateTaskInput` → `insertTask` | あり |
| W4 | ボスの `update_task` ツール | `server/src/boss/task-tools.ts` `executeUpdateTask` → `validatePatchTaskInput` → `updateTask` | あり |
| W5 | `POST /api/checkins` のタスク状態遷移 | `server/src/activity/checkins-routes.ts` → `updateTask` に `status` のみを渡す | `due_at` を含まない（`TaskPatch` に無いフィールドは据え置き） |
| W6 | スキーマ移行 | `server/src/db/migrate.ts` のテーブル再構築（`INSERT INTO tasks_new ... SELECT`） | なし（既存値をそのまま複写する。設計どおり） |
| W7 | アプリ外からの直接 DB 操作 | — | なし（アプリの管轄外） |

読む経路（保存値を解釈・表示する経路）:

| # | 経路 | 解釈 |
|---|------|------|
| R1 | `server/src/detection/deadline-overdue.ts` `findOverdueTasks` | 瞬時（`new Date(due_at).getTime() < now`） |
| R2 | `server/src/detection/priority.ts` `dueAtRank` | 瞬時（`new Date(dueAt).getTime()`。`null` は `Number.MAX_SAFE_INTEGER`） |
| R3 | `server/src/boss/persona-prompt.ts` `formatStoredDateTime` | date-only はそのまま出す／妥当な ISO 日時はローカル表記へ整形／それ以外は原文のまま |
| R4 | `GET /api/tasks` 等の API 応答 | 保存値をそのまま返す（`tasks-repository.ts` の `mapTaskRow` は `evidence_required` しか変換しない） |
| R5 | `web/src/TaskCard.tsx` `toDateInputValue` | 先頭 10 文字＝暦日（表示・編集の初期値の両方） |
| R6 | `web/src/TaskCard.tsx` の「ボス決定: 締切 …」表示 | 同上（`toDateInputValue`） |

`tasks-repository.ts` の `listTasks` / `findTaskById` は保存値を素通しするため、R1〜R6 はすべて同じ生の文字列を受け取る。

### 論点(3): 既存 DB に残る不正な `due_at` — **Issue の記述より検証範囲は広く、被害の記述は不正確**

- `tasks.due_at` が制約なし TEXT である点は Issue のとおり（`server/src/db/migrate.ts` の `due_at TEXT`）。
- 「#338 で入れた検証は **POST / PATCH の入力経路にのみ**効く」は**不正確**。検証は `server/src/tasks/tasks-validation.ts` の `validateOptionalFieldTypes` に置かれ、`validateCreateTaskInput` と `validatePatchTaskInput` の両方から呼ばれる。そして `server/src/boss/task-tools.ts` はその 2 つの検証関数を再利用しているため、**ボスのツール経路（W3・W4）も同じ検証を通る**。すなわち上表の W1〜W4 はすべてカバー済みで、残る無検証の書き込みは W6（既存値の複写）と W7（アプリ外）だけである。**「入力検証をすり抜ける現役の入口」は存在しない**——残っているのは過去に書かれた値だけ、という点が実態である。
- 「不正値は `NaN` を出し、その締切は永久に期限超過と判定されない」は**半分だけ正しい**。`isValidIsoDateOrDateTime` を満たさない値には 2 つのクラスがあり、被害の向きが逆になる（`TZ=Asia/Tokyo` で実測）:

| クラス | 例 | `new Date(...)` | `findOverdueTasks` の挙動 |
|--------|----|-----------------|--------------------------|
| (3a) parse 不能 | `"not-a-date-at-all"` / `"2026-13-01"` / `"2026-09-05T25:00"` | `NaN` | **永久に期限超過にならない**（Issue の記述どおり） |
| (3b) `Date` が寛容に解釈する | `"2026-02-30"` → 3/2、`"12/31/2026"` → 12/31、`"0"` → **2000-01-01** | 妥当な瞬時 | **誤った日に**、`"0"` のような値では**永久に期限超過**として催促され続ける |

- `server/src/detection/priority.ts` の被害も Issue の「並び順へ混入させる」より具体的である。`dueAtRank` が `NaN` を返すと `dueDiff !== 0` が真になり、比較関数が `NaN` を返す。実測（`node` で再現）:
  - `[{id:1, due:"not-a-date-at-all"}, {id:2, due:"2026-07-01"}, {id:3, due:"2026-06-01"}]` → 並べ替え結果 `1,3,2`（**不正値のタスクが最優先に選ばれる**）
  - 同じ 3 件を `[3, 1, 2]` の順で渡すと結果は `3,1,2`（**入力順で結果が変わる**）
  - `pickTopPriorityTask` は未着手検知・回避検知の対象タスクを決めるため、これは「催促の対象が壊れた 1 件に持っていかれる」ことを意味する。

### コードコメントの陳腐化（本仕様のスコープ外・報告のみ）

`server/src/boss/persona-prompt.ts` の `formatStoredDateTime` の doc コメントに「`tasks-validation.ts` に形式の検証は無い」という記述が残っているが、PR #338 で検証が入ったため現状と食い違う。本仕様の作成セッションは `docs/features/` 以外を変更しないため直していない。実装チケットで `server/src/boss/persona-prompt.ts` に触れる際に併せて直すこと。

## 機能要件

### 論点(1)

- [ ] ダッシュボードの「今日のひとこと」のキャッシュは、`updated_at` が変化しなくてもタスクの内容が変化していれば無効になる
- [ ] タスクの内容も `updated_at` も変化していない再取得では、従来どおりキャッシュが有効なままである（LLM を呼び直さない）

### 論点(3)

- [ ] 検知エンジンは、暦として解釈できない `due_at` を「締切なし」として扱い、`NaN` を下流の比較・並べ替えへ流さない
- [ ] `due_at` の解釈は 1 つのモジュールに集約し、検知エンジンの各所が個別に `new Date(due_at)` を呼ばない

## 非機能要件

- 検知ロジックは純粋関数のまま保つ（ADR 0004）。本仕様で追加する `due_at` の解釈も、入力 → 出力の純粋関数として実装しユニットテストで担保する。
- 暦日の区切りに関わるテストは ADR 0007 決定 5 に従い、固定時刻を `new Date(y, m, d, h)` 由来のローカル日時から導出する（UTC 文字列リテラルで固定しない）。日付境界に触る変更のため `npm run test:tz` も通す。
  - ただし `main` には UTC-11 / UTC+14 でのみ落ちる既存欠陥が別にあるため、`test:tz` の結果は**必ず `main` のベースラインと突き合わせて**、本変更が持ち込んだ失敗かどうかを判別すること。

## 技術的な制約・方針

- 変更対象: `server/src/dashboard/task-fingerprint.ts`（論点1）、`server/src/tasks/due-at.ts`（新規・論点3）、`server/src/detection/deadline-overdue.ts` / `server/src/detection/priority.ts`（論点3）およびそれぞれのテスト。
- DB スキーマは変更しない。マイグレーションも行わない（下記「スコープ外」）。
- 既存の入力検証（`server/src/tasks/tasks-validation.ts` / `server/src/lib/iso-date.ts`）は変更しない。本仕様が足すのは**読み出し側のガード**だけである。

## クリティカル設計決定

### 決定 1: フィンガープリントの入力を `Task` の全フィールドへ広げる（論点1）

- **採用案**: `updated_at` の単調増加は保証しない。`computeTaskFingerprint` の射影を `{ id, updated_at }` から **`Task` の全フィールド**へ広げる。`updated_at` は射影に残す（既存挙動を狭めないため）。
- **理由**:
  - 時刻の単調性に依存して直すと、同一ミリ秒以外の時計巻き戻し（NTP 補正・手動変更）で同じ穴が残る。原因側（フィンガープリントの入力が内容を反映していない）を直す。
  - 「何を含めるか」は消費者から導いた。ダッシュボードのひとことは `server/src/boss/persona-prompt.ts` の `buildPersonaPrompt` → `formatTaskLine` が描画する `status` / `title` / `priority` / `due_at` / `evidence_required` に依存する（`id` はこの経路では `includeId: false` のため文面に出ないが、タスクの追加・削除の検出に要る）。**その上で射影を全フィールドへ広げる**のは、(a) 消費者由来の集合の上位集合なので取りこぼしが原理的に起きない、(b) `persona-prompt.ts` の描画内容が将来変わっても射影の保守が要らない（許可リストの陳腐化が起きない）、(c) 過剰無効化のコストは「編集のたびに LLM 呼び出しが 1 回増えうる」だけで、キャッシュは元々暦日単位かつ変更のたびに切れる設計だから——の 3 点による。
  - 内容ハッシュを別に持たず射影自体を広げるのは KISS（ハッシュ関数は 1 つのまま、変わるのは射影だけ）。
- **代替案**:
  - `updateTask` で `updated_at` に単調増加を保証する（前回値と同値なら +1ms 等）→ 却下。時計巻き戻しの穴が残り、`updated_at` の意味（更新時刻）に嘘が混ざる。
  - 消費者が実際に描画するフィールドだけの許可リストにする → 却下。`server/src/boss/persona-prompt.ts` の変更に追従し続ける必要があり、追従漏れが「古いコメントが出る」という気付きにくい形で表面化する。
  - 許容する（ローカル単一利用者なので実害が小さい） → 却下。修正コストが射影 1 行分と小さく、許容の根拠を残す手間と釣り合わない。
- **影響範囲**: `server/src/dashboard/task-fingerprint.ts` とそのテスト。`server/src/dashboard/boss-comment-cache.ts` / `server/src/dashboard/boss-comment.ts` は変更不要（フィンガープリントを不透明な文字列として扱っているため）。保存済みのキャッシュ（`settings` テーブルの `dashboard_comment_fingerprint`）は変更後の初回リクエストで一度ミスするだけで、移行は不要。
- **射影の網羅性の担保はテスト側が持つ**: 本番コードの `computeTaskFingerprint` は `Task` の全フィールドを機械的に含めればよく（オブジェクトスプレッドで足りる。フィールド名を明示列挙しない）、`Record<keyof Task, ...>` 型を経由するのは **AC-1 のテストフィクスチャ（フィールドごとの「変更前／変更後」の値のテーブル）のほう**である。こうすると `Task` にフィールドが増えたときにテーブルの不足が `npm run typecheck` の失敗として出るため、許可リスト方式の陳腐化を型検査で塞げる。
  - 補足: 射影のキー順が変わるとハッシュ値も変わるが、影響は保存済みキャッシュが 1 回ミスして再生成されるだけで無害である（キャッシュは元々暦日単位で切れる）。

### 決定 2: 不正な `due_at` は読み出し側でガードし「締切なし」として扱う（論点3）

- **採用案**: `server/src/tasks/due-at.ts` を新設し、`due_at` を「瞬時（epoch ミリ秒）または締切なし」へ変換する単一の関数を置く。`due_at` が `null` のとき、および `isValidIsoDateOrDateTime` を満たさないときは「締切なし」を返す。`server/src/detection/deadline-overdue.ts` と `server/src/detection/priority.ts` はこの関数だけを通して `due_at` を解釈し、自前で `new Date(due_at)` を呼ばない。
- **理由**:
  - ガードを置く位置の候補は 3 つあった。**(a) 検知エンジンの各所**（重複が 2 箇所に散り、3 箇所目が足された時に漏れる）、**(b) 読み出し境界（`tasks-repository.ts` の `mapTaskRow`）で `null` へ正規化**、**(c) `due_at` の意味を所有する 1 モジュールに集約して検知エンジンが呼ぶ**。
  - **(b) は却下**。API 応答（R4）と web の表示（R5）に保存値と違う値が出ることになり、境界で嘘をつく。さらに `web/src/TaskCard.tsx` の編集は常に `due_at` を送るため、`null` へ正規化した値を画面に出すと**次の編集で不正値が黙って消える**（利用者が締切を消した覚えがないのに消える）。壊れた値の掃除は利用者に見える形で（＝マイグレーションで）行うべきで、読み出しで隠すべきではない。
  - **(c) を採用**。「`due_at` をどう解釈するか」はフィールドの所有者側の関心なので `server/src/tasks/` に置く。論点(2) が決まったときに追加される正規化・解釈変更も同じモジュールに入るため、解釈の定義が 2 箇所に分かれない。
- **代替案**: クリーンアップのマイグレーションで不正値を `NULL` にする → **本仕様のスコープ外**（下記）。読み出し側のガードは不正値の有無に関わらず必要であり、マイグレーションはその要否を実測してから判断すればよい。
- **影響範囲**: 新規 `server/src/tasks/due-at.ts`、`server/src/detection/deadline-overdue.ts`、`server/src/detection/priority.ts` と各テスト。DB スキーマ・API 契約・web は変更しない。
- **本仕様は `due_at` の解釈そのものを変えない**。妥当な値に対しては現行と同じ `new Date(value).getTime()` を返す。解釈（date-only を UTC 0 時と読むか、ローカル暦日の終わりと読むか等）の変更は論点(2) の決定に属する。

### 決定 3: 「不正値」の定義は `isValidIsoDateOrDateTime` に固定し、論点(2) の結論では広げない

- **採用案**: 決定 2 のガードが「締切なし」に落とす対象は、**`isValidIsoDateOrDateTime` を満たさない値**とする。論点(2) がどの案に決まっても、この述語は変えない。
- **理由**: 論点(2) の案 A（暦日へ一本化）を採ると時刻付きの値が、案 B（瞬時へ一本化）を採ると date-only の値が、それぞれ「新形式ではない値」になる。しかしそれらは**過去に正しく登録された実在の締切**であり、「不正値＝締切なし」に落とすと利用者の締切が黙って消える。したがって論点(2) の結論は**「不正値」の定義ではなく「正規化」として実装する**（旧形式 → 新形式へ変換する）。
- **影響範囲（論点(2) に左右されない範囲を AC 単位で明示する）**:
  - **左右されない**: AC-5・AC-6・AC-8・AC-9・AC-11（＝「不正値」の定義と、その扱い）。論点(2) がどの案に決まっても述語 `isValidIsoDateOrDateTime` は変えないため。
  - **左右される**: **AC-7 のみ**（`toDueAtInstant` が妥当な値をどう解釈するか）。案 A・案 B のどちらかに決まると、正規化後の値に対する解釈が変わる（例: date-only を UTC 0 時ではなくローカル暦日の終わりとして読む）ため、AC-7 は論点(2) の仕様で**更新・置き換えの対象**になる。本仕様の実装時点では現行解釈を固定する。

## IF / API

新規モジュール `server/src/tasks/due-at.ts`:

```ts
/**
 * 保存された `due_at` を「締切の瞬時（epoch ミリ秒）」へ変換する。
 * 締切なし（`null`）と、暦として解釈できない値は等しく `null` を返す。
 */
export function toDueAtInstant(dueAt: string | null): number | null;
```

- 呼び出し側の規約: `null` は「締切なし」を意味する。並べ替えで「締切なし」を最後尾に置く既存規約（`Number.MAX_SAFE_INTEGER`）は `priority.ts` 側が持ち続ける。
- `deadline-overdue.ts` / `priority.ts` 以外からの `new Date(task.due_at)` の直呼びは、本仕様の完了時点で存在しない状態にする（`server/src/boss/persona-prompt.ts` の `formatStoredDateTime` は表示整形であり、瞬時への変換ではないため対象外）。

## 実装計画（チケット分解の見通し）

`/create-ticket` で最終決定するが、現時点の見通しは 2 チケット（相互に独立で並列実装できる）:

1. 論点(1): フィンガープリントの射影を `Task` 全フィールドへ広げる（`task-fingerprint.ts` とテスト、`boss-comment.ts` レベルの結合テスト）
2. 論点(3): `server/src/tasks/due-at.ts` の新設と検知エンジン 2 本の切り替え

## スコープ外

- **論点(2)（`due_at` の保存形式の決定）は本仕様では決めない。** 「未決の論点」節に選択肢と判断材料を残す。決定後に別途仕様化・ADR 化する。
- **ADR 0007 決定 1 違反（`YYYY-MM-DD` の `due_at` が UTC 0 時として解釈される件）も本仕様では直さない。** これは「直し忘れ」ではなく、`due_at` の解釈をどう定めるかが論点(2) の決定内容そのもの（案 A・B・C のいずれもこの違反を解消する）だからである。決定 2 が「本仕様は `due_at` の解釈を変えない」としているのと同じ理由による。
- **不正な `due_at` を掃除するマイグレーションは本仕様のスコープ外とする**（決定として記録する）。実 DB に不正値が現存するかを実測してから、別 Issue で要否を判断する。理由: 読み出し側のガード（決定 2）は不正値の有無に関わらず必要で、先に入れて損が無い。一方マイグレーションは「実際に何行あるか・どんな値か」を見ないと変換先（`NULL` にするか、救える値は救うか）を決められない。
- **`server/src/boss/persona-prompt.ts` の陳腐化したコードコメントの修正**（本仕様の作成セッションは `docs/features/` のみを変更したため）。
- **ダッシュボードのひとことで添付件数が常に 0 になる件**（現状の確証・論点(1) の補足を参照）。別の欠陥として起票する。

## 受入基準

### 論点(1): フィンガープリント

- [ ] AC-1: `computeTaskFingerprint` は、`Task` のフィールドがちょうど 1 つだけ異なる 2 つのタスク配列に対して、必ず異なるフィンガープリントを返す
  - 検証方法: `keyof Task` を全数列挙したテーブル駆動のユニットテスト（各フィールドについて「変更前」「変更後」の値の組を持ち、1 フィールドずつ変えて比較する）。**このテーブルは `Record<keyof Task, ...>` 型で宣言する**——`Task` にフィールドが増えたとき、テーブルの不足が `npm run typecheck` の失敗として継続的に検出されるようにするため（許可リストの陳腐化を型検査で塞ぐ。一度きりの手動確認ではなく、以降のフィールド追加でも効き続ける）
- [ ] AC-2: `updated_at` が同一のまま内容だけが変わったとき、`getOrGenerateBossComment` はキャッシュを返さず LLM を呼び直す
  - 検証方法: フェイクタイマーで時刻を同一ミリ秒に固定したまま `updateTask` を 2 回呼び（例: `title` を変える）、`getOrGenerateBossComment` を前後で呼んで LLM クライアントのモックが 2 回呼ばれることを検証する。`updated_at` が実際に同値であることもテスト内で表明する（同値でなければ狙った経路を踏んでいない）
- [ ] AC-3: 暦日・内容ともに変化していない連続リクエストでは、`getOrGenerateBossComment` はキャッシュを返し LLM を呼ばない（既存挙動の非退行）
- [ ] AC-4: 変異確認。`server/src/dashboard/task-fingerprint.ts` の射影を `id` と `updated_at` だけへ戻すと AC-1 と AC-2 のテストだけが落ち、他のテストは落ちない

### 論点(3): 不正な `due_at` の読み出し側ガード

- [ ] AC-5: `toDueAtInstant` は `null` に対して `null` を返す
- [ ] AC-6: `toDueAtInstant` は `isValidIsoDateOrDateTime` を満たさない文字列に対して `null` を返す（`"not-a-date-at-all"` / `"2026-13-01"` / `"2026-09-05T25:00"` / `"2026-02-30"` / `"12/31/2026"` / `"0"` / `""` を検証する。前 3 つは `new Date()` が `NaN` を返すクラス、後 4 つは `new Date()` が妥当な瞬時を返してしまうクラス）
- [ ] AC-7: `toDueAtInstant` は妥当な値に対して `new Date(value).getTime()` と同じ数値を返す（本仕様は `due_at` の解釈を変えない。**この基準だけは論点(2) の決定で置き換わる**——「決定 3」節を参照）
- [ ] AC-8: `findOverdueTasks` は、`due_at` が `isValidIsoDateOrDateTime` を満たさないタスクを、`new Date()` がそれを過去の瞬時として解釈できてしまう場合（例: `"0"` → 2000-01-01、`"2026-02-30"` → 2026-03-02）でも、締切超過として返さない
  - 検証方法: 固定時刻はローカル日時（`new Date(y, m, d, h)`）から導出し、UTC 文字列リテラルで固定しない
- [ ] AC-9: `pickTopPriorityTask` は、`due_at` が `isValidIsoDateOrDateTime` を満たさないタスクを「締切なし」と同じ順位（最後尾）に扱う
  - 検証方法: 同一 `priority` で「不正な `due_at`」「有効で早い `due_at`」「`due_at` が `null`」の 3 件を用意し、**入力配列の順序を入れ替えた複数のケースで**選ばれるタスクが常に「有効で早い `due_at`」であることを検証する（現行実装では比較関数が `NaN` を返すため入力順で結果が変わる）
- [ ] AC-10: `server/src/detection/deadline-overdue.ts` と `server/src/detection/priority.ts` に `due_at` を引数にした `new Date(...)` の呼び出しが残っていない（`due_at` の解釈が `server/src/tasks/due-at.ts` に集約されている）
  - 検証方法: 両ファイルのソースを文字列として読み、`new Date(` に `due_at` / `dueAt` 由来の式を渡す呼び出しにマッチしないことを表明する自動テストを 1 本置く。固定するのは**そのパターンの不在だけ**であり、ファイルの内容自体は固定しない（実装詳細を凍結しないため）
  - 変異確認: この検査は識別子名ベースの文字列マッチであり、パターンが誤っていると恒真のまま緑になる。実装時に `server/src/detection/deadline-overdue.ts` へ一時的に `new Date(task.due_at)` を書き戻し、AC-10 の検査が確実に落ちることを確認してから戻すこと
- [ ] AC-11: 変異確認。`server/src/tasks/due-at.ts` のガード（`isValidIsoDateOrDateTime` による分岐）を外して `new Date(dueAt).getTime()` をそのまま返すようにすると、AC-6・AC-8・AC-9 のテストだけが落ち、他のテストは落ちない

### 共通

- [ ] AC-12: `npm run lint` / `npm run typecheck` / `npm test` がすべて pass する
- [ ] AC-13: `npm run test:tz` が pass する。既存の失敗（`main` のベースラインで既に落ちるもの）がある場合は、本変更の前後で失敗集合が増えていないことを確認する
  - 検証方法: **実装着手前に `main` で `npm run test:tz` を 1 回流し、失敗しているテスト名の一覧を PR 本文に記録する**。比較対象を後から思い出す形にすると判定が揺れるため、ベースラインを先に固定する

## 未決の論点（人間の決定待ち）

### 論点(2): `due_at` の保存形式を「暦日」「瞬時」「両方」のどれにするか

**なぜ決めないか**: これは保存形式の決定であり、締切超過の検知タイミング＝催促の強度というプロダクト体験に直接及ぶ。たとえば案 A を採ると、現状「締切当日の午前 9 時（JST）から催促が始まる」挙動が「締切日を過ぎてから催促が始まる」へ変わる。どちらが望ましいかは実装の都合では決まらない。

**共通の前提（どの案でも直すべき欠陥）**: 現状の `YYYY-MM-DD` → UTC 0 時という解釈は ADR 0007 決定 1 に反しており、案の選択にかかわらず解消される必要がある。

#### 案 A: 暦日（`YYYY-MM-DD`）へ一本化する

- 保存時に日時が来たら**サーバーのローカル暦日**へ正規化する。解釈は「その暦日の終わり」＝ ADR 0007 決定 3 の半開区間に合わせ、**翌ローカル暦日の 00:00 を超えたら締切超過**とする。
- 変更が要るファイル: `server/src/tasks/due-at.ts`（正規化と解釈）、`server/src/tasks/tasks-validation.ts`（正規化の適用）、`server/src/detection/deadline-overdue.ts`、`server/src/detection/priority.ts`、`server/src/boss/task-tools.ts` と `server/src/llm/backends/claude-code-backend.ts`（ツールの `due_at` の説明文を「ISO 8601 日時文字列」から `YYYY-MM-DD` へ）。
- 移行の要否: **要る**。既存の時刻付き `due_at` を暦日へ落とすマイグレーション（またはそれと等価な読み出し側の吸収）。
- 既存テストへの影響: `server/src/detection/deadline-overdue.test.ts`（`due_at` 参照 12 箇所）と `server/src/detection/priority.test.ts`（6 箇所）は現在すべて UTC 瞬時リテラル（`"2026-07-05T00:00:00.000Z"` など）を使っており、暦日へ書き換えたうえで ADR 0007 決定 5 に従いローカル由来の固定時刻へ組み直す必要がある。`server/src/boss/task-tools.test.ts`（11 箇所）・`server/src/tasks/tasks-routes.test.ts`（17 箇所）の一部も影響する。
- UI の見え方: **変わらない**（`web` は既に `<input type="date">` と `slice(0, 10)` 表示のみ）。
- 体験の変化: 締切当日いっぱいの猶予ができる＝**催促が実質 1 日弱遅くなる**。
- pros: ADR 0007 と最も整合。実データの主な生成元（web の日付入力）と一致。編集ラウンドトリップで意味が変わる Issue の主症状が保存形式の一本化で構造的に消える。web の変更が不要。TZ に依存しない。
- cons: 「今日の 15:00 まで」のような時刻締切を表現できなくなる。ボスが時刻付きの締切を置けなくなる。

#### 案 B: 瞬時（オフセット付き ISO 8601）へ一本化する

- web の日付入力は「その日のローカル 23:59:59+09:00」のような値へ展開して送る（**既定時刻をいくつにするかの決定が別途要る**）。
- 変更が要るファイル: `web/src/TaskCard.tsx` と `web/src/TaskForm.tsx`（送信時の展開と、時刻を含む表示への変更）、`server/src/tasks/tasks-validation.ts`（date-only の拒否または正規化）、`server/src/tasks/due-at.ts`。`server/src/detection/` 配下は変更不要。
- 移行の要否: **要る**（既存の date-only 行を瞬時へ展開する）。
- 既存テストへの影響: `server/src/detection/` 配下のテストはそのまま通る。`web/src/TaskCard.test.tsx`（9 箇所）・`web/src/TaskForm.test.tsx`（2 箇所）と、検証まわりのサーバーテストが影響する。
- UI の見え方: **変わる**。締切に時刻が現れる。時刻入力を足すなら入力の手数も増える。
- pros: 時刻締切を表現できる。検知エンジンは無変更。
- cons: web の変更が 3 案で最大。単一ユーザーのローカルアプリで時刻締切の需要は未確認（YAGNI）。既定時刻という恣意的な決定を 1 つ抱える。

#### 案 C: 両方を許したまま、解釈を明示的に揃える

- `server/src/tasks/due-at.ts` に解釈を集約し、**date-only は「そのローカル暦日の終わり」**、**時刻付きはその瞬時**と定義する。web は「時刻を持つ値はローカル日時で表示し、編集時も時刻を保つ」へ変え、`slice(0, 10)` の書き戻しをやめる。
- 変更が要るファイル: `server/src/tasks/due-at.ts`、`server/src/detection/deadline-overdue.ts`、`server/src/detection/priority.ts`、`web/src/TaskCard.tsx`。
- 移行の要否: **不要**（既存行はそのまま意味が定まる）。
- 既存テストへの影響: `server/src/detection/` 配下の既存テストは瞬時のみを使っているのでそのまま通り、date-only のケースを足す形になる。`TaskCard.test.tsx` の編集ラウンドトリップは変わる。
- UI の見え方: **変わる**（日付だけの締切と日時の締切が混在して表示される）。
- pros: 移行が不要で変更量が最小。`YYYY-MM-DD` が UTC 0 時になる現行の欠陥は直る。
- cons: 2 形式が残り続け、将来の実装者が再び解釈を割る余地が残る（Issue #340 の根が完全には消えない）。UI に 2 種類の締切表現が出る。

#### 推奨: 案 A（暦日へ一本化）

根拠:

1. ADR 0007 決定 1（「当日」はローカル暦日・UTC 基準の日付キーを使わない）と最も整合し、現行の「date-only が UTC 0 時として解釈される」欠陥を構造的に消す。
2. 実データの主な生成元は web の `<input type="date">`（`YYYY-MM-DD`）であり、時刻締切の需要は未確認。YAGNI に照らせば表現力を先に足す理由が無い。
3. 保存形式が 1 つになるため、Issue #340 の主症状（編集を経ると締切の意味が黙って変わる）が「そもそも解釈が 1 つしかない」ことで消える。案 C は解釈を揃えるだけなので、将来また割れうる。
4. 3 案で唯一 UI の見え方が変わらない。

保留するリスク: 「締切当日いっぱい猶予される」＝催促が今より遅くなることを許容できるかは、プロダクトの意図（ボスは厳しくあるべきか）に依存する。ここが受け入れられないなら、案 A の変種として「暦日の**終わり**ではなく、暦日の**業務終了時刻**（設定済みの勤務時間帯の終わり）を締切とみなす」も検討に値する。

#### 論点(3) との依存関係

論点(3) のガード（決定 2・決定 3）が「何を不正値とみなすか」は **`isValidIsoDateOrDateTime` を満たさないこと**に固定してあり、論点(2) の結論では変えない。案 A・案 B のどちらを採っても「新形式ではない既存値」が生じるが、それは実在する締切なので**不正値として締切なしに落とさず、正規化で新形式へ変換する**（決定 3）。逆に、もし論点(2) の結論を「不正値」の定義側に反映してしまうと、利用者の締切が黙って消えるため、その実装は採らないこと。

したがって論点(2) の決定は、**「不正値」の定義とその扱いを固定した受入基準（AC-5・AC-6・AC-8・AC-9・AC-11）を無効化しない**。ただし **AC-7（妥当な値の解釈）だけは論点(2) の決定で置き換わる**——案 A・案 B のどちらかに決まれば、正規化後の値をどう瞬時へ写すかが変わるためである（決定 3 の「影響範囲」に同じ整理がある）。
