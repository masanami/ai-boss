# タスクの一時停止（休憩とは別概念）

## 概要

進行中のタスクを「一時停止中」として明示できるようにする。タスクステータスに `paused` を追加し、チェックインパネルから一時停止・再開を操作できるようにする。作業自体を離れる「休憩」（グローバル状態）とは別概念として扱い、検知・進捗集計・作業ログのそれぞれで扱いを定義する。

## 背景・目的

チェックインパネルの現在の操作は 着手 / 完了 / 休憩 / 戻りました の4種で、進行中タスクを中断して別のことをする際に「このタスクだけ止めた」ことを表す手段が無い。

休憩で代用すると意味が壊れる。休憩は `task_id` を持たないグローバル状態で、申告中はサボり検知が休憩延伸以外すべて停止する（`server/src/detection/rule-engine.ts`）。「このタスクだけ止める」は作業を離れているわけではないため、検知を止めてはならない。両者は影響範囲が異なる別概念である。

## ユーザーストーリー

セルフマネジメント中のユーザーとして、進行中タスクを一時停止して、割り込み対応や別タスクへの切り替えを行いつつ、そのタスクを放棄していないことを自分とボスの双方に明示したい。

## 機能要件

- [ ] 進行中（`in_progress`）のタスクをチェックインパネルから一時停止できる
- [ ] 一時停止中のタスクをチェックインパネルから再開して `in_progress` へ戻せる
- [ ] 一時停止中であることがタスクボードとチェックインパネルで判別できる
- [ ] 一時停止は休憩状態を発生させず、休憩延伸検知の対象にもならない
- [ ] 一時停止中タスクのサボり検知上の扱いが決定的なルールとして定義される
- [ ] 一時停止が作業ログに時系列の事実として残る

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono + better-sqlite3 / Vite + React）
- 変更対象:
  - `server/src/db/migrate.ts`（マイグレーション v4）
  - `server/src/tasks/task.ts`（`TASK_STATUSES`）・`web/src/task.ts`（同）
  - `server/src/activity/activity-event.ts`（`ACTIVITY_EVENT_TYPES` / `CHECKIN_TYPES`）・`web/src/activity-event.ts`（同）
  - `server/src/activity/checkins-routes.ts`（`task_pause` の副作用・`task_start` の遷移元拡張）・`server/src/activity/checkins-validation.ts`（`task_id` 必須分岐の拡張）
  - `server/src/detection/priority.ts`・`deadline-overdue.ts`・`silence.ts`
  - `server/src/dashboard/progress.ts`
  - `server/src/boss/persona-prompt.ts`（`TASK_STATUS_LABELS`）
  - `server/src/reports/collect-work-log-data.ts`・`render-work-log.ts`
  - `web/src/CheckinPanel.tsx`・`web/src/TaskBoard.tsx`・`web/src/TaskCard.tsx`・`web/src/today-tasks.ts`
- 既存コードとの関係: 検知ルールエンジンは純粋関数を保つ（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 2・3）。一時停止の判定に LLM を使わない。
- テストの時刻固定は `new Date(y, m, d, h)` 由来のローカル日付基準で組む（[ADR 0007](../adr/0007-local-calendar-day-basis.md) 決定 5）。UTC 文字列での固定は使わない。

## 画面・API設計

### チェックインパネル（`web/src/CheckinPanel.tsx`）

タスク選択の右のボタン群を、選択中タスクの status で切り替える。

| 選択中タスクの status | 主ボタン | 追加ボタン |
|---|---|---|
| `todo` | 着手 | （完了は無効） |
| `in_progress` | 着手（無効） | 完了 / 一時停止 |
| `paused` | 再開 | （完了は無効） |

- 「一時停止」ボタンは選択中タスクが `in_progress` のときだけ表示する（「完了」ボタンの既存の出し分けと同じ考え方）。
- 「再開」は新しいエンドポイントを持たず、既存の `POST /api/checkins`（`type: "task_start"`）をそのまま送る。ラベルだけが「着手」→「再開」に変わる。
- タスク選択肢（`selectableTasks`）に `paused` を含める（含めないと再開対象を選べない）。

### API

新規エンドポイントは追加しない。既存の `POST /api/checkins` に `type: "task_pause"` を追加する。

```jsonc
// POST /api/checkins
{ "type": "task_pause", "task_id": 12, "note": null }
// → 201, 作成された activity_event。対象タスクは status: "paused" になる
```

- `task_pause` は `task_id` 必須（`task_start` と同じ検証規則）。
- 対象タスクが `in_progress` でない場合はステータスを変更しない（イベントのみ記録する）。`task_start` が `todo` / `paused` 以外のステータスを書き換えない既存規律と対称にする。

## クリティカル設計決定

### 判断 1: 一時停止の表現方法（DBスキーマ変更）

- **採用案**: `tasks.status` への `paused` 追加と、`activity_events.type` への `task_pause` 追加の**両方**を行う（マイグレーション v4 で両テーブルを再構築）。
- **理由**:
  - 「一時停止中である」は日をまたいで持続する**状態**であり、状態の正本は `tasks.status` に置くのが既存構造と一致する。タスクボードのカラム分け・ノルマ進捗・検知の対象判定はすべて `status` を見ており、ここに新しい判定経路を足さずに済む。
  - 「一時停止した」は時系列に残すべき**出来事**であり、作業ログ・活動履歴・無音検知の起点として `activity_events` が必要。[ADR 0004](../adr/0004-deterministic-detection-engine.md) 帰結「新しい活動シグナルを追加する場合は `activity_events` の種別追加として実装する」に従う。
  - 既存の「着手」がまさにこの形（`task_start` イベント記録と `todo` → `in_progress` 遷移を1トランザクションで実行）であり、踏襲すれば新しいパターンを増やさない。
- **代替案**:
  - **`activity_events` のみ（`task_pause` イベントから状態を導出）** — 却下。`GET /api/activity/today` は当日イベントしか返さないため、前日に一時停止したタスクの状態が翌日消える。またタスクボード・ノルマ進捗が `status` ベースであり、そこだけ別経路の導出を持ち込むことになる。
  - **`tasks.status` のみ** — 却下。一時停止が `task_update`（作業ログ上は「タスク更新: X」）としてしか残らず、休憩（`break_start` / `break_end`）や着手（`task_start`）と非対称になる。
  - **専用テーブル `task_pauses` を新設** — 却下。1タスク1真偽値のために表を増やすのは [ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 5・6 に反する。`activity_events.type` の CHECK 制約変更は結局避けられないため、再構築を回避できるという利点も無い。
- **影響範囲**: `tasks` と `activity_events` はいずれも CHECK 制約を持つため、SQLite では `ALTER TABLE` で列挙値を追加できず、**新テーブル作成 → データコピー → 旧テーブル削除 → リネーム**の再構築が要る。`decisions.task_id` と `activity_events.task_id` が `tasks` を参照しているため、再構築中の外部キーの取り扱いを実装時に明示する。

### 判断 2: マイグレーション v4 の原子性（原子化そのものは #175 で解消済み）

> **更新（#175 実装済み）**: 本判断が前提としていた「適用と `user_version` 更新の非原子性」は、#175 が先行して解消した（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4: version 単位で `db.transaction()` により原子適用。保証 G-175-1〜G-175-4 として台帳に宣言済み）。本機能に残る責務は **v4 の追加と、テーブル再構築時の外部キーの取り扱い（`PRAGMA foreign_keys` はトランザクション内で切り替え不能なため、12-step 手順の設計）のみ**。以下の本文は判断当時の記録として残す。

- **採用案**: `runMigrations` の「マイグレーション適用」と「`PRAGMA user_version` の更新」を単一トランザクションで囲む変更を、本機能のスコープに含める。
- **理由**: [ADR 0005](../adr/0005-sqlite-schema-policy.md) の「既知の逸脱（#175）」（当時。現在は解消済みで注記は削除された）のとおり、当時の `runMigrations` は適用と version 更新が原子的でない。v1 と v3 は `CREATE TABLE IF NOT EXISTS` のみで**偶然**再実行に耐えているが、v4 はテーブル再構築（`DROP TABLE` / `RENAME`）を含むため再実行に耐えない。中断後の再起動で DB が壊れる、または起動不能になる。維持すべき保証 G-170-77（当時は冪等性を含む複合文。#175 で分割され、再実行の無変化は現在 G-175-4）・G-170-78（既存テーブルを壊さない引き上げ）を v4 で成立させるために必要な前提であり、既存の欠陥に乗ったまま実装することはできない。
- **代替案**:
  - **v4 自体を再実行安全に書く（`CREATE TABLE IF NOT EXISTS` + `INSERT OR REPLACE` 等）** — 却下。`DROP TABLE` の直後に落ちた場合はコピー元が存在せず、どう書いても救えない状態が残る。
  - **#175 の修正を待って本機能を後回しにする** — 却下。#175 の修正内容は3行程度で、待つコストのほうが大きい。（結果としては #175 が先行して修正した）
- **影響範囲**: `server/src/db/migrate.ts`。原子化は #175 で実装済みのため、本機能では v4 の追加のみを行う。
- **注記**: 外部キー制約が有効な状態でのテーブル再構築手順（`PRAGMA foreign_keys` の扱い、`PRAGMA foreign_key_check` による検査）は実装の裁量とする。ただし G-170-80（外部キー制約が有効であること）を壊さないこと。

### 判断 3: 再開操作の扱い

- **採用案**: 既存の「着手」（`POST /api/checkins` の `task_start`）を再利用し、遷移元を `todo` から `todo` または `paused` へ拡張する。専用のイベント種別（`task_resume`）は追加しない。
- **理由**: 「再開」は意味的に「着手」と同一（そのタスクへ作業を戻す）。種別を分けても、検知・作業ログ・活動履歴のいずれにも両者を区別する用途が現時点で無い（YAGNI）。イベント種別を増やすほど CHECK 制約・レンダラー・検知の分岐が増える。
- **代替案**:
  - **専用の `task_resume` イベント型を追加** — 却下。上記のとおり区別する用途が無い。
  - **タスクボードのステータス変更（ドラッグ）だけで戻す** — 却下。チェックインパネルで完結しないと「今やっていることを申告する」導線が分断される。
- **影響範囲**: 既存の保証 G-170-34（`task_start` は `todo` タスクのみ `in_progress` へ遷移させる）の約束文を書き換える。`done` / `dropped` を書き換えないという既存の約束は維持する。

### 判断 4: サボり検知への影響

一時停止は「作業を離れた」ではなく「このタスクを今は進めない」の宣言であるため、**検知は止めない**。ルールごとの扱いを次のとおり定める（いずれも純粋関数側で決定し、LLM には委ねない）。

| ルール | 一時停止中タスクの扱い | 理由 |
|---|---|---|
| 未着手（`unstarted`） | 対象外 | 最優先タスクの候補から外れるため到達しない（下記） |
| 最優先タスクの選定（`priority`） | **候補に含めない** | 一時停止は「今はやらない」の明示。候補に残すと `isTopTaskUnstarted` が常に false を返し、**真に未着手の他タスクへの催促を握りつぶす** |
| 回避（`avoidance`） | 判定材料を変更しない | 一時停止は「他タスクで作業している」証拠ではない。回避判定の対象種別（`task_start` / `task_update`）に `task_pause` を加えない |
| 無音（`silence`） | **発火は抑制しない**。ただし閾値は下記 | 一時停止は休憩ではないため、止めたまま無音が続けば催促する |
| 無音の許容時間（閾値） | 直近の `task_start` が指すタスクがその後 `task_pause` されていれば、進行中タスク無しとみなし**フォールバック値**を使う | 一時停止したタスクの見積もり（最大 90 分にクランプされる）を無音許容時間の根拠に使い続けるのは意味が壊れる |
| 締切超過（`deadline_overdue`） | **対象に含める** | 一時停止は締切を止めない。止めたまま締切を過ぎたら催促されるべき |
| 休憩延伸（`break_overrun`） | 影響しない | `getActiveBreak` は `break_start` / `break_end` のみを見る。一時停止は休憩状態を作らない |
| 勤務時間帯ゲート・休憩ゲート | 変更しない | [ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 6 のとおり |

- **代替案（却下）**: 一時停止中は当該タスクに関する検知を全面停止する — 却下。「一時停止すれば締切超過の催促が止まる」というサボりの抜け道になり、本アプリの中核価値（サボれない仕組み）を損なう。
- **代替案（却下）**: 一時停止中タスクを最優先候補に残す — 却下。上表のとおり他タスクへの未着手催促を握りつぶす。

## 機能全体の設計

### 波及点の一覧（型エラーで気付けないものを明示する）

`TaskStatus` / `ActivityEventType` に値を追加したとき、**型検査が落ちて気付ける箇所**と**黙って挙動が変わる箇所**がある。後者は実装時に必ず個別対応する。

| 箇所 | 検知 | 対応 |
|---|---|---|
| `web/src/today-tasks.ts` | 型エラー（`satisfies never`） | `paused` を対象に含める |
| `web/src/TaskCard.tsx` の `STATUS_LABEL` | 型エラー（`Record<TaskStatus, string>`） | 「一時停止」ラベルを追加 |
| `web/src/CheckinPanel.tsx` の `EVENT_TYPE_LABEL` | 型エラー（`Record<ActivityEventType, string>`） | 「一時停止」ラベルを追加 |
| `server/src/reports/collect-work-log-data.ts` の `WORK_LOG_ACTIVITY_EVENT_TYPES` と収集 SQL の `WHERE e.type IN (...)` | **黙って除外される**（手書きの定数配列。型検査に守られない） | `task_pause` を配列へ追加する |
| `server/src/reports/render-work-log.ts` の `formatActivityBody` | 型エラー（網羅 switch の戻り値）。**ただし上記の `WORK_LOG_ACTIVITY_EVENT_TYPES` を先に更新した後に初めて出る** | `一時停止: {タスク名}` を追加 |
| `server/src/dashboard/progress.ts` の `isTargetTask` | **黙って除外される**（`// dropped` へ落ちる） | `paused` をノルマ対象に含める |
| `web/src/TaskBoard.tsx` の `COLUMNS` | **黙ってボードから消える**（どのカラムにも一致しない） | 「一時停止」カラムを追加 |
| `server/src/detection/priority.ts` | 黙って候補外（意図どおり） | 意図を明示するテストを追加 |
| `server/src/detection/deadline-overdue.ts` | **黙って対象外** | `paused` を対象に含める |
| `server/src/detection/unstarted.ts` | 黙って false（意図どおり） | 変更しない |
| `server/src/detection/silence.ts` の `getInProgressTask` | **黙って変わらない**（現在の status を見ていないため何もしないと一時停止後も旧閾値のまま） | 直近の `task_start` が指すタスクが現在 `in_progress` でなければ進行中タスク無しとみなす |
| `server/src/activity/checkins-validation.ts` の `validateCheckinInput` | **黙って素通りする**（`task_id` 必須の分岐は `task_start` のみ） | `task_id` 必須の分岐を `task_start` / `task_pause` の両方へ拡張 |
| `server/src/activity/checkins-routes.ts` | 黙って遷移しない | `task_start` の遷移元に `paused` を追加 |
| `server/src/reports/collect-daily-report-data.ts` の SQL | **黙って進行中欄から外れる**（意図どおり） | 変更しない（下記の仮定を参照） |
| `server/src/boss/persona-prompt.ts` の `TASK_STATUS_LABELS` | 型エラー（`Record<Task["status"], string>`） | 「一時停止」ラベルを追加 |
| `server/src/boss/task-tools.ts` | 自動反映（`TASK_STATUSES` を spread） | 変更不要 |

### タスクボードのカラム構成

`未着手` / `進行中` / `一時停止` / `完了` / `中止` の5カラムとする。`paused` は `in_progress` の隣に置く（作業の流れとして自然で、`done` / `dropped` の終端状態と混ざらない）。

### 実装計画（チケット分解の見通し）

スキーマと型を先に通さないと他の変更が着地しないため、直列 → 並列の2段が素直。最終分解は `/create-ticket` で行う。

1. **基盤**: マイグレーション v4（両テーブル再構築。`runMigrations` の原子化は #175 で完了済みでその上に乗る）・`TASK_STATUSES` / `ACTIVITY_EVENT_TYPES` の値追加・`POST /api/checkins` の `task_pause` 対応・`task_start` の遷移元拡張
2. **検知**: `priority.ts` / `deadline-overdue.ts` / `silence.ts` の扱いを実装
3. **集計・出力**: `progress.ts` / `today-tasks.ts` / 作業ログ
4. **UI**: チェックインパネルのボタン出し分け・タスクボードのカラム追加・ラベル追加

## 明示的な仮定

意思決定者への確認が取れないまま置いた仮定を、後から根拠を追えるよう明記する。

- **仮定 1**: 一時停止したタスクは、その日の日報の「進行中」欄に載らない（`collect-daily-report-data.ts` の SQL は `t.status = 'in_progress'` を条件にしており、`paused` は外れる）。日報の3見出し構成（G-170-46）とチェックボックス記法（G-170-47）は変えないため、一時停止用の欄も追加しない。「その日の終わりに止まっているタスクは進行中ではない」という解釈を採る。一時停止の事実は作業ログ（時系列）で追える。
- **仮定 2**: 一時停止の実行は `task_pause` と `task_update` の**2件**の活動イベントを記録する（`updateTask` がステータス変更に伴い `task_update` を自動記録するため）。これは既存の「着手」（`task_start` + `task_update`）と同じ挙動であり、対称性を優先して個別の抑制は行わない。
- **仮定 3**: 一時停止に伴って記録される `task_update` は、他タスクを最優先タスクとする回避検知の判定材料になりうる。これは既存の「完了」操作でも同じ挙動であるため、本機能では変更しない。
- **仮定 4**: ボスが `update_task` ツールで `status: "paused"` を指定した場合、`task_pause` の活動イベントは記録されない（`task_update` のみ）。これは既存の「ボスが `in_progress` にしても `task_start` は記録されない」と同じ非対称性であり、本機能では揃えない。
- **仮定 5**: `POST /api/checkins` に `type: "task_pause"` で `in_progress` 以外のタスク（`todo` / `done` / `dropped` / 既に `paused`）を指定した場合、イベントは記録するがステータスは変更しない。`task_start` が `done` / `dropped` を書き換えない既存規律（G-170-34）と対称にする。
- **仮定 6**: 一時停止の解除手段は「再開（`task_start`）」「完了」「中止」の3つとし、`todo` へ戻す専用導線は設けない（タスクボードのステータス変更で可能なため）。

## 受入基準

- [ ] 選択中のタスクが `in_progress` のとき、チェックインパネルに「一時停止」ボタンが表示される
- [ ] 「一時停止」を実行すると、対象タスクの status が `paused` になる
- [ ] 「一時停止」を実行すると、`task_pause` の活動イベントが記録される
- [ ] 選択中のタスクが `paused` のとき、着手ボタンのラベルが「再開」になる
- [ ] `paused` のタスクへの `task_start` チェックインは、そのタスクを `in_progress` へ遷移させる
- [ ] 「一時停止」を実行しても `break_start` の活動イベントは記録されない
- [ ] `paused` のタスクは最優先タスクの候補に含まれない
- [ ] 締切を過ぎた `paused` のタスクは締切超過検知の対象に含まれる
- [ ] 直近の着手タスクがその後 `task_pause` されている場合、無音許容時間はフォールバック値になる
- [ ] `paused` のタスクは今日のノルマ進捗の対象に含まれる
- [ ] `paused` のタスクはサイドパネルの「今日のタスク」に含まれる
- [ ] タスクボードに「一時停止」カラムがあり、`paused` のタスクがそこに表示される
- [ ] 作業ログに一時停止が `一時停止: {タスク名}` の行として出力される
- [ ] チェックインパネルの当日活動一覧で `task_pause` が「一時停止」と表示される
- [ ] v3 の DB を v4 へ引き上げると、`tasks.status` に `paused` を保存できる
- [ ] v3 の DB を v4 へ引き上げると、`activity_events.type` に `task_pause` を保存できる
- [ ] v3 の DB を v4 へ引き上げても、既存の tasks と activity_events の行が保持される
- [ ] マイグレーションの適用が失敗した場合、`PRAGMA user_version` は進まない
- [ ] ボスの `update_task` ツールで `status: "paused"` を指定できる
- [ ] `in_progress` でないタスクへ `task_pause` のチェックインを送っても、そのタスクの status は変更されない
- [ ] 一時停止中のタスクがあっても休憩延伸検知は発火しない

## 宣言予定の保証

> 受入基準のうち公開面に相当するものの約束文を列挙する。保証 ID の採番・公開面の最終判定・裁可は `/create-ticket` 以降の手順が担う。

- 選択中のタスクが着手中のときだけチェックインパネルに一時停止ボタンを表示する（受入基準 AC-1 に対応）
- 一時停止の実行は対象タスクのステータスを一時停止中にする（受入基準 AC-2 に対応）
- 一時停止の実行は一時停止の活動イベントを記録する（受入基準 AC-3 に対応）
- 選択中のタスクが一時停止中のとき着手ボタンのラベルを再開にする（受入基準 AC-4 に対応）
- 着手のチェックインは一時停止中のタスクを着手中へ遷移させる（受入基準 AC-5 に対応）
- 一時停止の実行は休憩開始の活動イベントを記録しない（受入基準 AC-6 に対応）
- 一時停止中のタスクを最優先タスクの候補に含めない（受入基準 AC-7 に対応）
- 締切を過ぎた一時停止中のタスクを締切超過の抽出対象に含める（受入基準 AC-8 に対応）
- 直近の着手タスクがその後一時停止されている場合は無音許容時間をフォールバック値とする（受入基準 AC-9 に対応）
- 一時停止中のタスクを今日のノルマ進捗の対象に含める（受入基準 AC-10 に対応）
- 一時停止中のタスクをサイドパネルの今日のタスクに含める（受入基準 AC-11 に対応）
- 一時停止中のタスクをタスクボードの一時停止カラムへ振り分ける（受入基準 AC-12 に対応）
- 作業ログは一時停止を専用の固定フォーマットの行として出力する（受入基準 AC-13 に対応）
- v4 へ引き上げた DB はタスクのステータスとして一時停止中を受理する（受入基準 AC-15 に対応）
- v4 へ引き上げた DB は活動イベントの種別として一時停止を受理する（受入基準 AC-16 に対応）
- 着手中でないタスクへの一時停止のチェックインはそのタスクのステータスを変更しない（受入基準 AC-20 に対応）
- 一時停止中のタスクがあっても休憩延伸の催促を発火させない（受入基準 AC-21 に対応）
- ~~判定保留候補: マイグレーションの適用が失敗したとき `PRAGMA user_version` が進まないこと（受入基準 AC-18）~~ — **解消済み**: #175 側で独立した保証 G-175-1（適用失敗時に適用前の状態のまま残る）として宣言・台帳登録された。本機能での宣言は不要
- 判定保留候補: v3 から v4 への引き上げで既存行が保持されること（受入基準 AC-17）（既存の G-170-78 が「旧バージョンの DB を既存テーブルを壊さずに新バージョンへ引き上げる」を既に約束しており、参照テストの追加で足りるのか独立した約束を立てるべきか判断が付かない。独立した約束にする場合、AC-17 は tasks と activity_events の2テーブル分を含むため、`1 保証 = 1 約束`の規律に従って2つの約束へ分ける必要がある）
- 判定保留候補: チェックインパネルの当日活動一覧で一時停止が専用ラベルで表示されること（受入基準 AC-14）（既存の G-170-164 が「当日の活動一覧に種別と時刻と関連タスク名が表示される」を既に約束しており、新種別のラベル追加を独立した約束にするか既存保証の範囲とするか判断が付かない）
- 判定保留候補: ボスの `update_task` ツールで一時停止中を指定できること（受入基準 AC-19）（要人間判定 HR-02「ボスのツール単体の振る舞いは台帳に載せない」に該当する一方、status の列挙値は LLM へ露出する契約でもあるため判断が付かない）
