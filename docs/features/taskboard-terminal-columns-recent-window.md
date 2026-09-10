# TaskBoard の「完了」「中止」列を直近 7 日に絞る

## 概要

タスクボード（`web/src/TaskBoard.tsx`）の「完了」列と「中止」列を、**ローカル暦日で当日を含む直近 7 日**に入るタスクだけの表示に変える。範囲外のタスクは列に出さず、範囲外を閲覧する手段も設けない。見出しは「完了（直近 7 日）」「中止（直近 7 日）」として絞り込み中であることを示す。サーバ（`GET /api/tasks`）は無改変で、表示層だけで解く（#428）。

## 背景・目的

`TaskBoard` の 5 列（`todo` / `in_progress` / `paused` / `done` / `dropped`）は、いずれも **`status` の一致だけ**でタスクを選んでいる（`TaskBoard.tsx:140-141`）。

```tsx
tasks
  .filter((task) => task.status === column.status)
  .map((task) => ( ... ))
```

日付条件も件数上限も無く、`GET /api/tasks` は全件を返す（`server/src/tasks/tasks-repository.ts:29-32` の `SELECT * FROM tasks ORDER BY created_at ASC, id ASC`、`tasks-routes.ts:41` は `listTasks(db)` をそのまま返し、クエリパラメータもページングも持たない）。`todo` / `in_progress` / `paused` は「片付けば列から消える」ため自然に上限が掛かるが、**`done` と `dropped` は終端状態で、そこから出ていかない**。したがってアプリを使い続けるほどこの 2 列だけが単調に伸び、直近に終えた仕事が見つけにくくなる。

サイドパネル「今日のタスク」（`web/src/TodaySummary.tsx`）は別の選び方をしている。`web/src/today-tasks.ts` の `selectTodayTasks` が `completed_at` と `isSameLocalDay` で「今日（ローカル日付）完了したタスク」だけを含める（`today-tasks.ts:18-21`）。**この関数はサイドパネルの進捗ゲージのデータ源そのものであり、サーバのノルマ進捗（`server/src/dashboard/progress.ts`）と条件が 1:1 で対応する**ため、本仕様では触らない（#245 の機能仕様 `today-tasks-completed-collapse.md` 決定 5 と同じ理由）。#245 は本件を「別 Issue として独立に扱う」と明記して切り出しており（同仕様 決定 4）、本仕様がその受け皿である。

### 現状の確証（Issue #428 本文との対照）

Issue #428 は 2026-09-09 起票で、本文の記述は当時の観察である。実装で裏取りした結果を記録する。

| # | Issue 本文の記述 | 実コードの実態 | 判定 |
|---|---|---|---|
| 1 | `COLUMNS` は 5 列、各列は `status === column.status` の 1 条件だけ。`done` に日付条件・件数上限は無い | `TaskBoard.tsx:11-17` が 5 列、`:140-141` が当該 `filter` のみ | 一致 |
| 2 | 「中止」列（`dropped`）も全件描画 | 列ごとの分岐は無く同一コードパス。`dropped` も全件 | 一致 |
| 3 | `GET /api/tasks` は `SELECT * FROM tasks ORDER BY created_at ASC, id ASC` で全件 | `tasks-repository.ts:29-32` / `tasks-routes.ts:41`。クエリパラメータ・ページングなし | 一致 |
| 4 | サイドパネル側は `selectTodayTasks` が「今日（ローカル日付）完了したタスク」だけを含める | `today-tasks.ts:18-21`。`completed_at` は `tasks` テーブルに実在（`server/src/db/migrate.ts:38`） | 一致 |
| 5 | （Issue に記述なし） | **`dropped` には中止時刻を保持する列が無い。** `dropped_at` はスキーマ・型・コードのどこにも存在せず、さらに `updateTask` は `patch.status !== "done"` のとき **`completed_at` を `null` にクリアする**（`tasks-repository.ts:241-248`）。中止時刻を示すのは `updated_at` だけである | **Issue の前提が不足**（「同様に中止列も全件描画する」とだけ書かれ、中止列は完了列と同じ手段では絞れないことに触れていない） |
| 6 | （Issue に記述なし） | **列の `aria-label` は既存テストが全数固定・完全一致で参照している。** `TaskBoard.test.tsx:100-107` が `["未着手","進行中","一時停止","完了","中止"]` を `toEqual` で固定し、`getByRole("region", { name: "完了" })` が :78 / :268 / :296 の 3 箇所にある | **Issue の前提が不足**（波及範囲が過小） |

Issue 本文はコードを行番号なしで引用しているため、行番号の陳腐化・前提の数値の変化はいずれも無い（列数 5・SQL 文言とも現状と一致）。

## ユーザーストーリー

タスクボードで仕事の全体像を見るオーナーとして、**「完了」「中止」列には直近 1 週間に終えた分だけ**が並んでいてほしい。列がアプリの使用期間に比例して伸び続けると、直近に終えた仕事を探すのにスクロールが必要になる。

## 機能要件

- [ ] 「完了」列は、完了日（`completed_at`）がローカル暦日で当日を含む直近 7 日に入るタスクだけを表示する
- [ ] 「中止」列は、最終更新日（`updated_at`）がローカル暦日で当日を含む直近 7 日に入るタスクだけを表示する
- [ ] 範囲外の完了・中止タスクは列に表示しない
- [ ] 「完了」「中止」の見出しは絞り込みの範囲を示す（「完了（直近 7 日）」「中止（直近 7 日）」）
- [ ] 「未着手」「進行中」「一時停止」列の表示内容・見出しは変わらない（絞り込みの対象外）
- [ ] 列が空になったときの表示は現状のまま（空の一覧を描画し、新たな空メッセージは追加しない）
- [ ] タスクをドラッグで「完了」列へ落として完了させた直後、そのタスクは「完了」列に表示される（完了時刻が当日になるため）
- [ ] 範囲外の完了・中止タスクを閲覧する手段は設けない（下記「スコープ外」）

## 技術的な制約・方針

- **変更対象**: `web/src/TaskBoard.tsx`、`web/src/recent-terminal-tasks.ts`（新規・純粋関数）、`web/src/recent-terminal-tasks.test.ts`（新規）、`web/src/TaskBoard.test.tsx`（追加＋既存 1 件の改修）
- **変更しない**: `server/` 配下すべて（とくに `server/src/tasks/tasks-repository.ts` と `tasks-routes.ts`）、`web/src/today-tasks.ts`、`web/src/TodaySummary.tsx`、`web/src/AppLayout.tsx`、`web/src/TaskCard.tsx`、`web/src/use-tasks.ts`、`web/src/task.ts`、`web/src/TaskBoard.css`
- **日付キーの導出は `web/src/to-date-key.ts` の `toDateKey` を呼ぶ**（ADR 0007 決定 2: 各所で個別に `toISOString` を切り出さず、環境ごとの共通関数へ集約する）。`toISOString().slice(0, 10)` を新たに書かない
- **境界は暦日を進退させて求める**（ADR 0007 決定 3: 固定秒数の加算をしない。DST のある地域で 24 時間 ≠ 1 暦日になるため）。`new Date(y, m, d - 6)` の形でローカル暦日を戻し、`YYYY-MM-DD` の文字列比較で範囲判定する
- 「今」の取得はコンポーネント内で `new Date()` を直接呼ぶ（clock prop を新設しない）。前例: `TodaySummary.tsx:17` の `selectTodayTasks(tasks, new Date())`
- テストの固定時刻は `new Date(y, m, d, h)` 由来で組み、`vi.useFakeTimers({ toFake: ["Date"] })` ＋ `vi.setSystemTime(...)` で固定する（前例: `AppLayout.test.tsx:478-479`、`DailyReportView.test.tsx:86-87`）。**UTC 文字列リテラルで固定しない**（ADR 0007 決定 5）
- 日付境界に触る変更のため `npm run test:tz`（非 UTC タイムゾーンでの追加実行）も通す（ADR 0007 決定 6）
- **共通の切り詰めコンポーネント・共通フックを新設しない**（#245 決定 2・#252 の YAGNI をそのまま踏襲。本件は「終端列を直近 N 日で絞る」、#245 は「完了／未完了でグループ化して畳む」、#252 は「既定は最新 N 件で切り詰める」で切り詰め軸が異なる）

## クリティカル設計決定

> Issue #428 の論点に対する決定。後続の実装はこの決定に従い、独自判断で逸脱しない。

### 1. 絞り方（日付で絞る / 件数を上限にする / 折りたたむ）

- **採用案**: **日付で絞る**（当日を含む直近 N 日）。範囲外は列に出さない
- **理由**: 件数上限（最新 M 件）だと「そのタスクがいつ列から消えるか」が他のタスクの完了ペースに依存し、利用者が予測できない。日付なら「先週分まで見える」と説明でき、消えるタイミングが自分の暦と一致する
- **代替案**:
  - 件数上限（最新 M 件） — 却下（上記の予測不能性）
  - 折りたたむ（#245 と同じ disclosure） — 却下。#245 は「今日のタスク」という**有限な当日の集合**の中での並べ替えなので畳めば足りるが、本件で畳む対象は**アプリの使用期間に比例して増える集合**であり、展開したときの描画件数が単調増加する問題が残る。畳んでも「直近に終えた仕事を探しにくい」は解けない
- **影響範囲**: `TaskBoard.tsx` の列描画のみ。サイドパネル・進捗ゲージ・ダッシュボードには及ばない

### 2. N の値と置き場所

- **採用案**: **N = 7**（当日を含む直近 7 暦日）。`TaskBoard.tsx` のモジュールレベル定数 `RECENT_TERMINAL_WINDOW_DAYS` で固定し、**設定 UI は作らない**
- **理由**: 前例に倣う（#252 の決定 3「N = 20・コード内定数で固定する。設定 UI は作らない」＝ `docs/features/today-activity-log-display.md`、`CheckinPanel.tsx:15` の `DEFAULT_BREAK_MINUTES = 15`）。7 は「先週分まで見える」と説明できる最小の単位であり、週次の振り返りに足る
- **代替案**: 設定画面で可変にする — 却下。設定の追加は `settings` の読み書き経路（`web/src/use-settings.ts` / サーバの設定 API）まで波及し、本課題（列の単調増加を止める）に対して過剰。必要になってから別 Issue で扱う
- **影響範囲**: 定数 1 つ。**見出し文言はこの定数から導出する**（決定 6）ので、値を変えれば見出しも追随する

### 3. 何の日時を基準にするか（`done` と `dropped` で異なる）

- **採用案**: **`done` は `completed_at`、`dropped` は `updated_at`** を基準にする。受入基準は「完了日」「中止日」ではなく**フィールドの語（`completed_at` / `updated_at`）で書く**
- **理由**: `dropped` には中止時刻を保持する列が存在せず、`updateTask` は `done` 以外への遷移で `completed_at` を `null` にクリアする（`tasks-repository.ts:241-248`。確証 #5）。したがって中止タスクの時刻を示すのは `updated_at` だけである。`updated_at` は「そのタスクに最後に何かした時刻」であり、`updateTask` の呼び出し元は 3 箇所（`tasks-routes.ts:81` の PATCH、`checkins-routes.ts:164` のチェックイン、`boss/task-tools.ts:111` のボスツール）で、**全タスクを一括更新する背景ジョブは存在しない**ため、中止タスクの `updated_at` は実質「中止した時刻、またはその後に手を入れた時刻」になる
- **`dropped_at` 列を新設しなかった理由**: 意味的には `dropped_at` が正しいが、(1) DB スキーマは CLAUDE.md「品質方針」がクリティカル箇所（変更時は人間レビュー必須）に挙げており、(2) 決定 5「絞り込みはフロントのみ・API 無改変」と両立しない（migration・repository・型・API の同時変更になり、チケットも 1 本で収まらない）。列の単調増加を止めるという本課題に対して代償が大きい
- **代替案**:
  - `dropped` は絞らず全件のまま — 却下。同じ単調増加の穴が残り、列ごとに作法が 2 つになる
  - 両列を `updated_at` で統一 — 却下。述語は 1 本で済むが、完了タスクのタイトルを編集すると完了日が動いたように振る舞う退行が入り、`selectTodayTasks`（`completed_at` 基準）とも食い違う
  - `dropped_at` 列を新設 — 却下（上記の理由。必要になったら別 Issue）
- **意図した振る舞い**: 範囲外の中止タスクを編集すると `updated_at` が更新され、**「中止」列に再表示される**。これは `updated_at` を基準に採った帰結であり、バグではない。**受入基準で明示的に固定する**（実装者が「消えたままにする」方向へ直さないため）
- **影響範囲**: 新規純粋関数の中の 1 分岐。`Task` 型・スキーマ・サーバには及ばない

### 4. `status === "done"` かつ `completed_at === null` のタスクの扱い

- **採用案**: **範囲外として扱い、表示しない**
- **理由**: `selectTodayTasks`（`today-tasks.ts:19`）が `completed_at !== null` を条件に持ち、`null` を対象外へ倒しているのと同じ倒し方に揃える。述語が「基準時刻が取れて、かつ範囲内」の 1 本で書ける
- **代替案**: 不明扱いで常に表示（fail-open） — 却下。「7 日より古い完了タスクは出ない」に例外が生まれ、そのタスクだけ永久に列へ残る（＝本課題の再発）
- **影響範囲**: 新規純粋関数の `null` 分岐。**この分岐は実データでは発生しないと確証しているが（下記「明示的な仮定」2）、型・スキーマが NULL 許容なので分岐は実装する**

### 5. 絞り込みを行う層（フロント / API）

- **採用案**: **フロント（`TaskBoard.tsx`）だけで絞る。`GET /api/tasks` は無改変**
- **理由**: 同 API は `todo` / `in_progress` / `paused` も含む全件取得で、サイドパネル「今日のタスク」・進捗ゲージ・`TaskForm` 後の再取得など複数の消費者が共有している（`AppLayout.tsx` の `tasksState` を全消費者へリフトアップ済み）。API 側で絞ると他の消費者へ波及する
- **代替案**: `GET /api/tasks` にページング・期間パラメータを足す — 却下。他の消費者への波及に加え、`server/src/tasks/tasks-routes.test.ts` の既存契約も動く。**ローカル単一ユーザーのデータ量では全件取得の転送コストは問題にならない**ため、絞る動機は表示側にしかない
- **影響範囲**: `web/src` のみ。`server/` は 1 行も変えない

### 6. 絞り込んでいることの見せ方

- **採用案**: `COLUMNS` に**表示用の見出しと `aria-label` を分ける**。見出し（`<h2>`）だけを「完了（直近 7 日）」「中止（直近 7 日）」にし、**`aria-label` は `"完了"` / `"中止"` のまま**にする。日数は `RECENT_TERMINAL_WINDOW_DAYS` から導出する
- **理由**: 何も示さないと「昨日完了したはずのカードが無い」理由が UI のどこにも無い。一方 `aria-label` は既存テストが全数固定・完全一致で参照しており（確証 #6）、変えると無関係な 4 箇所が落ちる。見出しテキストだけを変えれば既存参照は無改変で通る
- **代替案**:
  - `aria-label` も含めて変える — 却下（既存テスト 4 箇所への無用な波及）
  - 何も示さない — 却下（カードが黙って消える）
  - 「他 N 件は非表示」等の件数表示を出す — 却下。到達手段を作らない（決定 7）のに件数だけ出すと「押せば見られる」という誤った期待を与える
- **影響範囲**: `COLUMNS` の型が 1 フィールド増える。`<h2>` の文言のみ。**日数をテンプレートに直書きせず定数から導出する**（二重管理にしない。変異確認で担保＝下記「検証方法」）

### 7. 範囲外のタスクへの到達手段

- **採用案**: **用意しない**
- **理由**: 閲覧手段の新設（期間切替・全件表示・アーカイブ画面）は MVP スコープの増減であり、本課題（列の単調増加を止める）とは別の要件である。データは失われず、DB には残り続ける
- **代替案**: 「全件表示する」ボタン（#252 と同形） — 却下。#252 は当日分（有限）の全件表示だが、本件の「全件」はアプリの使用期間に比例して増えるため、開いた瞬間に元の問題が再現する
- **影響範囲**: なし（作らない）。「スコープ外」節に記録する

### 8. 抽象化の範囲

- **採用案**: 新規の純粋関数モジュール `web/src/recent-terminal-tasks.ts` を 1 つ足すだけにし、**#245 / #252 と共有する切り詰めコンポーネント・フックは作らない**。`selectTodayTasks` は無改変
- **理由**: YAGNI。切り詰め軸が 3 件とも異なる（本件＝終端列を直近 N 日、#245 ＝完了／未完了のグループ化、#252 ＝最新 N 件）。`selectTodayTasks` を触らないのは、それがサイドパネル進捗ゲージのデータ源であり、対象集合を変えるとゲージが壊れるため（#245 決定 5）
- **影響範囲**: `web/src` に新規モジュール 1 つ。`today-tasks.ts` は import もしない（暦日の扱いを揃える参照先として読むだけ）

## IF / API

```ts
// web/src/recent-terminal-tasks.ts（新規・純粋関数）
import type { Task } from "./task";

/**
 * 「完了」「中止」列の絞り込みに使う基準時刻を返す。
 * done は completed_at、dropped は updated_at（dropped には中止時刻の列が
 * 無く、updateTask が done 以外への遷移で completed_at を null にする）。
 * それ以外の status は絞り込みの対象外なので null を返す。
 */
export function terminalReferenceAt(task: Task): string | null;

/**
 * reference が「now を含む直近 windowDays 暦日（ローカル）」に入るか。
 * reference が null（＝基準時刻が取れない）なら false。
 * 日付キーの導出は to-date-key.ts の toDateKey に集約する（ADR 0007 決定 2）。
 */
export function isWithinRecentLocalDays(
  reference: string | null,
  now: Date,
  windowDays: number,
): boolean;
```

```tsx
// web/src/TaskBoard.tsx（抜粋・見出しと aria-label を分ける）
const RECENT_TERMINAL_WINDOW_DAYS = 7;

const COLUMNS: {
  status: TaskStatus;
  label: string;              // aria-label（既存テストが全数固定・無改変）
  limitedToRecentWindow?: boolean;
}[] = [
  { status: "todo", label: "未着手" },
  { status: "in_progress", label: "進行中" },
  { status: "paused", label: "一時停止" },
  { status: "done", label: "完了", limitedToRecentWindow: true },
  { status: "dropped", label: "中止", limitedToRecentWindow: true },
];

// 見出しの日数は定数から導出する（ハードコードして二重管理にしない）
const columnHeading = (column: (typeof COLUMNS)[number]): string =>
  column.limitedToRecentWindow === true
    ? `${column.label}（直近 ${RECENT_TERMINAL_WINDOW_DAYS} 日）`
    : column.label;

// 列の絞り込み（now はレンダリング時の new Date()）
const visibleTasks = tasks.filter(
  (task) =>
    task.status === column.status &&
    (column.limitedToRecentWindow !== true ||
      isWithinRecentLocalDays(
        terminalReferenceAt(task),
        now,
        RECENT_TERMINAL_WINDOW_DAYS,
      )),
);
```

- 純粋関数は入力配列・入力 `Task` を破壊しない
- 列内の並びは**サーバの返却順（`created_at ASC, id ASC`）を保つ**。新たな並び替え規則を発明しない
- 境界の意味: `windowDays = 7`・`now` が 9/10 のとき、包含されるのは **9/4〜9/10 の 7 暦日**（`now` の暦日から 6 日戻した日が下限）。9/3 は除外

## スコープ外

- **範囲外の完了・中止タスクを閲覧する手段の新設**（期間切替・全件表示ボタン・アーカイブ画面）。必要になったら別 Issue で扱う（決定 7）
- **`dropped_at` 列の新設**（migration・repository・型・API の変更）。必要になったら別 Issue で扱う（決定 3）
- **`GET /api/tasks` のページング・期間パラメータ**（決定 5）
- **サイドパネル「今日のタスク」側の変更**。#245（機能仕様 `today-tasks-completed-collapse.md`）で完了済みで、`selectTodayTasks` は無改変
- **N を設定画面から変える機能**（決定 2）
- **列が空のときの空メッセージ**・完了日の表示・カードの見た目の変更（`TaskCard.tsx` は無改変）

## 実装計画（チケット分解の見通し）

**1 チケットで足りる規模。** 変更は `web/src` の 4 ファイル（新規純粋関数モジュール 1 つ ＋ そのテスト、`TaskBoard.tsx` の `COLUMNS` と `filter`、`TaskBoard.test.tsx`）で、サーバは無改変。分解するなら「純粋関数の追加」と「`TaskBoard` の絞り込み・見出し」の 2 段に割れるが、後者は前者なしでは検証できないため直列になり、PR も同じファイル群を触る。最終分解は `/create-ticket` で行う。

## 受入基準

> 固定時刻は `vi.useFakeTimers({ toFake: ["Date"] })` ＋ `vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0))`（＝ローカル 2026-09-10 12:00）を基準に書く。この `now` での包含範囲は **2026-09-04〜2026-09-10** である。フィクスチャの日時も `new Date(y, m, d, h)` 由来で組み、UTC 文字列リテラルを使わない。

### 除外側（「出ないこと」）

- [ ] `completed_at` が 2026-09-03 23:59:59（＝下限の 1 暦日前）の `done` タスクは「完了」列に表示されない
- [ ] `completed_at` が 2026-08-01（＝十分に古い）の `done` タスクは「完了」列に表示されない
- [ ] `updated_at` が 2026-09-03 23:59:59 の `dropped` タスクは「中止」列に表示されない
- [ ] `completed_at` が `null` の `done` タスクは「完了」列に表示されない（決定 4）
- [ ] `completed_at` が 2026-09-02（範囲外）で `updated_at` が 2026-09-10（範囲内）の `done` タスクは「完了」列に表示されない（＝`done` の判定に `updated_at` を使っていないこと）

### 包含側（「必ず出ること」）

- [ ] `completed_at` が 2026-09-10 09:00（当日）の `done` タスクは「完了」列に表示される
- [ ] `completed_at` が 2026-09-04 00:00（＝下限の暦日ちょうど・その日の最初の瞬間）の `done` タスクは「完了」列に表示される
- [ ] `updated_at` が 2026-09-04 00:00 の `dropped` タスクは「中止」列に表示される
- [ ] `updated_at` が 2026-09-10 09:00 の `dropped` タスクは「中止」列に表示される
- [ ] `completed_at` が範囲外（2026-09-01）の `dropped` タスクでも、`updated_at` が範囲内（2026-09-10）なら「中止」列に表示される（＝`dropped` の判定に `completed_at` を使っていないこと。使っていれば `dropped` の `completed_at` は常に `null` なので中止列は常に空になる）
- [ ] 範囲外（`updated_at` = 2026-09-01）の `dropped` タスクを、`updated_at` = 2026-09-10 に更新した `tasks` で再描画すると「中止」列に表示される（決定 3 の**意図した振る舞い**）
- [ ] 「未着手」「進行中」「一時停止」列は、`completed_at` が `null` で `updated_at` が 2026-01-01（範囲外）のタスクでも表示される（＝絞り込みが終端列に限定されていること）
- [ ] カードをドラッグして「完了」列へ落とし、`status: "done"` / `completed_at`: 当日 に更新された `tasks` で再描画すると、そのカードは「完了」列に表示される

### 並び・件数

- [ ] 「完了」列に残るタスクの並びは、入力 `tasks` の順（サーバの `created_at ASC, id ASC`）と一致する
- [ ] 範囲内 2 件・範囲外 3 件の `done` タスクを渡したとき、「完了」列の `listitem` は 2 件である

### 見出しと既存契約の保全

- [ ] 「完了」列の見出し（`heading` ロール）のテキストが `完了（直近 7 日）` である
- [ ] 「中止」列の見出しのテキストが `中止（直近 7 日）` である
- [ ] 「未着手」「進行中」「一時停止」の見出しテキストが変わらない（`未着手` / `進行中` / `一時停止`）
- [ ] 列の `aria-label` は無改変である（`getAllByRole("region")` の `aria-label` が `["未着手","進行中","一時停止","完了","中止"]` と一致し、`getByRole("region", { name: "完了" })` が完全一致で引ける）
- [ ] `web/src/today-tasks.ts`・`web/src/TodaySummary.tsx`・`server/` 配下が無改変である
- [ ] `web/src/TaskBoard.test.tsx` の既存テスト `distributes tasks into their status columns` を、日付絞り込みが入った意図が読めるテスト名へ改名する（`distributes tasks into their status columns, with 完了/中止 limited to the recent window (#428)`。この文字列と一致すること）
- [ ] 上記テストの本体を新仕様に合わせて書き換える（改名前は `makeTask` の既定値 `completed_at: null` / `updated_at: "2026-07-05T00:00:00.000Z"` のまま `done` / `dropped` が各列に出ることを固定しており、新仕様では表示されないため）。書き換え後は固定時刻を設定し、`done` に範囲内の `completed_at`、`dropped` に範囲内の `updated_at` を与える
- [ ] `TaskBoard.test.tsx` の他の既存テスト（ドラッグ＆ドロップ・エビデンス関門・ハイライト・マウント時 refresh 等 21 件）は無改変のまま pass する

### 純粋関数（`recent-terminal-tasks.ts`）

- [ ] `terminalReferenceAt` は `done` のタスクに対し `completed_at` を返す
- [ ] `terminalReferenceAt` は `dropped` のタスクに対し `updated_at` を返す
- [ ] `terminalReferenceAt` は `todo` / `in_progress` / `paused` のタスクに対し `null` を返す
- [ ] `isWithinRecentLocalDays` は `reference` が `null` のとき `false` を返す
- [ ] `isWithinRecentLocalDays(windowDays = 7)` は、`now` の暦日から 6 日戻した暦日の 00:00 を `true`、その 1 ミリ秒前を `false` と判定する
- [ ] `isWithinRecentLocalDays` は `now` より未来の `reference` を `true` と判定する（時計のずれ・当日中の更新で未来値が入っても消えない。上限側は絞らない）
- [ ] 月初・年初をまたぐ境界で正しく判定する（例: `now` = 2026-03-02 のとき下限は 2026-02-24、`now` = 2027-01-02 のとき下限は 2026-12-27）
- [ ] 入力の `Task` オブジェクト・`now` を書き換えない

### 検証方法・品質ゲート

- [ ] **変異確認**: 境界比較を `>=` から `>` に変えると、**下限を包含側で検証する 2 件だけ**が落ちる（純粋関数の「下限の暦日 00:00 を `true` と判定する」と、列描画の「`completed_at` が 2026-09-04 00:00 の `done` タスクが表示される」）。除外側・並び・見出しのテストは落ちない
- [ ] **変異確認**: 下限の算出を `windowDays - 1` 日戻す → `windowDays` 日戻す に変えると、**下限の 1 暦日前を除外側で検証する 2 件だけ**が落ちる（純粋関数の「下限の 1 ミリ秒前を `false` と判定する」と、列描画の「`completed_at` が 2026-09-03 23:59:59 の `done` タスクが表示されない」）。包含側のテストは落ちない
- [ ] **変異確認**: `TaskBoard.tsx` の絞り込み（`filter` の第 2 条件）を外して修正前の実装に戻すと、除外側のテストが落ち、包含側のテストは落ちない
- [ ] **変異確認**: `isWithinRecentLocalDays` を常に `false` を返すよう変えると、包含側のテストが落ちる（＝「常に空」の実装がテストを通らない）
- [ ] **変異確認**: `terminalReferenceAt` の `dropped` 分岐を `completed_at` に変えると、「`updated_at` が範囲内の `dropped` タスクが表示される」テストが落ちる
- [ ] **変異確認**: `terminalReferenceAt` の `done` 分岐を `updated_at` に変えると、「`completed_at` が範囲外・`updated_at` が範囲内の `done` タスクが表示されない」テストが落ちる
- [ ] **変異確認**: `RECENT_TERMINAL_WINDOW_DAYS` を 7 から 3 に変えると、見出しの文字列を固定したテストと境界のテストが落ちる（落ちなければ見出しに日数がハードコードされている＝決定 6 違反）。この検出を成り立たせるため、**見出しを固定するテストは定数を import せずリテラル文字列 `完了（直近 7 日）` で書く**
- [ ] 新規・改修したテストの固定時刻が `new Date(y, m, d, h)` 由来で組まれている（UTC 文字列リテラルを使わない）
- [ ] `npm run lint` / `npm run typecheck` / `npm test` が pass する
- [ ] `npm run test:tz`（非 UTC タイムゾーンでの追加実行）が pass する
- [ ] 上記 2 つのゲートは**変更前の `main` でも pass する**ことを確認したうえで比較する（ai-boss には UTC-11/+14 でのみ落ちる既存欠陥が別にあるため、`test:tz` の失敗が本変更由来かをベースラインと突き合わせて判定する）

> **自動テストで担保しない範囲**: 絞り込み後の列の見やすさ・見出し文言の収まり（`TaskBoard.css` の列幅内で折り返さないか）は目視判断を要する。実装後に `/demo`（claude-in-chrome の実操作）でオーナーが確認する。

## 明示的な仮定

1. **`updated_at` は中止時刻の代理である**（決定 3）。`updateTask` の呼び出し元 3 箇所はいずれも特定タスクへの明示的な操作であり、全タスクを一括更新する背景ジョブは存在しないことを実コードで確証した。将来そうしたジョブが入ると中止列の絞り込みが効かなくなるため、その時点で `dropped_at` の新設を再検討する
2. **`status === "done"` かつ `completed_at === null` は現在のコード経路では発生しない。** `insertTask` は `status === "done"` のとき `completed_at` を設定し、`updateTask` は `done` への遷移で設定する。`completed_at` の保守はタスク機能の初出コミット（`f1c937a`・#4）から入っている。**それでも型・スキーマが NULL 許容（`web/src/task.ts` の `completed_at: string | null`、`migrate.ts:38` の `completed_at TEXT`）なので分岐は実装し、受入基準で固定する**（決定 4）
3. **上限側（未来方向）は絞らない。** `reference` が `now` より未来でも表示する。時計のずれや同一日内の更新で未来値が入ったときにカードが消えるほうが不都合が大きく、本課題は「古い側が溜まる」ことなので下限だけで足りる
4. **列が空になったときの空メッセージは追加しない**（現状も空の `<ul>` を描画するだけで、列ごとの空表示は存在しない）。追加は表示要件の増設になるため本仕様の範囲外とする
5. **「今」はレンダリング時に `new Date()` で 1 回取得する**（`TodaySummary.tsx:17` と同形）。日付が変わっても再レンダリングまで表示は更新されない。ボードはマウント時に `refresh()` を呼ぶ設計（`TaskBoard.tsx:35-40`）で、日付をまたいでタブを開いたままにする運用は想定しない。時計の変化を監視するタイマーは新設しない
6. **`docs/` は非権威**（CLAUDE.md「開発方針」）。本仕様は実装を駆動する作業文書であり、正本はコードとテストである。実装と食い違ったらコードとテストを読んで確かめてから本仕様を直す
