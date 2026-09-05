# チェックインの後追い記録（時刻指定）

> **状態: 要件確定・実装前（#243）。実装を駆動する作業文書（非権威）。**
>
> **正はコードとテスト**であり、本ファイルは権威を持たない（`CLAUDE.md`「開発方針」）。実装と食い違う場合はコードが正。
>
> 論点 0〜5 の決定はオーナーが計画承認ゲートで承認済みのものを転記した（2026-09-05・main = `04aab29` で裏取り）。判断 6（休憩の後追い記録の形）と判断 5 の「直近の `break_start`」の解釈は親セッション（flywheel エージェント）が 2026-09-05 に確定した。

## 概要

`POST /api/checkins` に任意の時刻フィールド `occurred_at` を追加し、中断・休憩をその場でチェックインし忘れたときに**当日内の過去時刻を指定して後追いで記録**できるようにする。チェックインパネルには展開式の「時刻を指定」欄を足す。指定時刻はそのまま `activity_events.created_at` に格納し、検知・日報・活動ログはそれを「その時刻に起きた出来事」として既存規則のまま読む。

## 背景・目的

実際には中断・休憩していたのに、その場でチェックインし忘れることがある。現状は `activity_events.created_at` がサーバ管理（`server/src/activity/activity-events-repository.ts`）で、`validateCheckinInput`（`server/src/activity/checkins-validation.ts`）にも時刻欄が無いため、記録は常に「いま」のものになり遡れない。

`activity_events` は検知エンジン・エスカレーション・日報・活動ログが**時刻で範囲を切って読む**ため、過去時刻のイベントを差し込むと各消費者に影響する。本仕様は Issue #243 の論点 1〜5 と、その前提となる記録の形（論点 0 と呼ぶ）それぞれについて期待する挙動を確定し、どの層に規律が及び、どの層には手を入れないかを明記する。

## ユーザーストーリー

セルフマネジメント中のユーザーとして、14:00 に中断・休憩したのに申告し忘れたことに 16:00 に気付いたとき、時刻を指定して後追いで記録し、活動ログと日報が実態どおりになるようにしたい。

## 機能要件

- [ ] `POST /api/checkins` で `occurred_at`（ISO 8601 日時）を指定すると、その時刻のイベントとして記録される
- [ ] `occurred_at` を省略した場合は現行どおりサーバ時刻で記録される
- [ ] チェックインパネルから時刻を指定して 着手 / 一時停止 / 休憩 / 戻り を記録できる（パネルの既存 4 操作。`type: "checkin"` を送る操作は現行パネルに無く、本仕様でも追加しない）
- [ ] 過去時刻の `task_start` / `task_pause` は、それが当該タスクの最新の着手・一時停止イベントより新しいときだけ `tasks.status` を遷移させる
- [ ] `occurred_at` が未来時刻のとき 400 で拒否される
- [ ] `occurred_at` が当日ローカル暦日の 00:00 より前のとき 400 で拒否される
- [ ] `occurred_at` を指定した `break_end` が、その時刻の直前の `break_start` より前（または開いている休憩が無い）のとき 400 で拒否される
- [ ] 後追い記録によって既存の `notifications` 行（送信済み通知）は削除・変更されない
- [ ] エスカレーション段階は専用ロジックを足さず、既存規則（最新通知の `sent_at` との前後関係）に従って後追いイベント込みで再評価される（通知履歴の書き換えではない）
- [ ] 生成済み日報は後追い記録によって自動再生成されない（内容が変わらない）

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono + better-sqlite3 / Vite + React）。**新しい列・テーブル・マイグレーションは追加しない**（[ADR 0005](../adr/0005-sqlite-schema-policy.md) の対象外）
- 変更対象:
  - `server/src/activity/checkins-validation.ts`（`occurred_at` の形の検証）
  - `server/src/activity/checkins-routes.ts`（未来・当日境界・`break_end` 順序の DB 整合検証、`tasks.status` 遷移判定）
  - `server/src/activity/activity-events-repository.ts`（`recordActivityEvent` が `created_at` を受け取れるようにする）
  - `web/src/activity-event.ts`（`CheckinInput` に `occurred_at`）・`web/src/CheckinPanel.tsx`・`web/src/CheckinPanel.css`
- **手を入れない層**（各判断の「及ぶ層」で個別に明記する）: `server/src/detection/`（検知エンジン・エスカレーション）・`server/src/notifications/`・`server/src/reports/`（日報生成・活動記録の対応付け）・`server/src/scheduler/`・`GET /api/activity/today`
- 既存コードとの関係:
  - 当日境界は `server/src/activity/local-day.ts` の `startOfLocalDayIso` / `startOfNextLocalDayIso` を再利用し、暦日計算を新たに書かない（[ADR 0007](../adr/0007-local-calendar-day-basis.md) 帰結）
  - ISO 8601 日時の形の検証は `server/src/lib/iso-date.ts` の `isValidIsoDateTime` を再利用する（`due_at` と同じ述語。日付のみの値は受理しない）
  - 格納時は既存の `created_at` と同じ `toISOString()` 形式（UTC・ミリ秒付き）に正規化する。`created_at` を SQL の**文字列比較**で範囲切りする既存の読み取り（`server/src/activity/activity-events-repository.ts` の `listEventsSince`・`server/src/reports/collect-daily-report-data.ts`・`server/src/reports/collect-work-log-data.ts`）があるため、オフセット付き文字列をそのまま格納すると範囲判定が壊れる
  - 検知エンジンは純粋関数・決定的のまま（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 2）。後追いイベントは `created_at` の値として入力に入るだけで、エンジンに新しい入力経路や種別を足さない
- テストの固定時刻は `new Date(y, m, d, h)` 由来のローカル日付基準で組む（ADR 0007 決定 5）。当日 00:00 境界を扱うため `npm run test:tz` も通し、完了報告では `TZ=UTC` / `TZ=Asia/Tokyo` / `TZ=America/New_York` の 3 通りで server テストを実行する

## 画面・API設計

### API

新規エンドポイントは追加しない。既存の `POST /api/checkins` に任意フィールド `occurred_at` を追加する。

```jsonc
// POST /api/checkins
{ "type": "task_pause", "task_id": 12, "note": null, "occurred_at": "2026-09-05T14:00:00+09:00" }
// → 201, 作成された activity_event（created_at は "2026-09-05T05:00:00.000Z" に正規化される）
```

- `occurred_at`: 省略可。指定する場合は `isValidIsoDateTime` を満たす ISO 8601 **日時**文字列（`YYYY-MM-DD` の日付のみは 400）。`null` は省略と同義。上の例の `+09:00` は API が任意のオフセット表記を受理することを示すもので、web クライアントは常に `toISOString()`（`Z` 形式）で送信する
- 検証の全体順序: 形の検証（400）→ `task_id` の存在確認（404）→ 未来時刻（400）→ 当日境界（400）→ `break_end` の順序（400）の順に判定し、最初に該当したものを返す（複数に同時違反する入力でも応答が実装依存で揺れないようにする）
- `break_end` の順序判定で `occurred_at` が直前の `break_start` と**同時刻ちょうど**の場合は 400 とする（検知エンジンの `getActiveBreak` は `break_start` より厳密に後の `break_end` しか休憩の終了とみなさないため、同時刻の記録は休憩を閉じない）
- 検証の順序と責務: 形（型・ISO 形式）は `checkins-validation.ts`（400）。未来時刻・当日境界・`break_end` の順序は DB／現在時刻を見る整合検証として `checkins-routes.ts`（400）。`task_id` の存在確認（404）は現行どおりルート
- エラーメッセージは既存の英語スタイルに揃える（例: `occurred_at must not be in the future`）。メッセージ本文は契約にしない（web はステータスとメッセージをそのまま表示するだけで、文言で分岐しない）

### チェックインパネル（`web/src/CheckinPanel.tsx`）

- 「時刻を指定して記録」の**展開式トグル**を追加する。折りたたみ時は現行の操作・見た目を変えない（通常操作の導線を増やさない。Issue #244 と干渉しないよう**既存ボタンの当たり判定・サイズには触れない**）
- 展開すると `記録する時刻` の時刻入力（当日内なので**時刻のみ**）が現れる。値が入っている間は、既存の 着手 / 一時停止 / 休憩 / 戻りました の各ボタンが `occurred_at`（当日ローカル暦日のその時刻）を付けて送信する。「完了」ボタンは `PATCH /api/tasks/:id` であり対象外
- 各ボタンの表示・活性条件（着手は `todo` / `paused` のとき、一時停止は選択中タスクが `in_progress` のとき、戻りましたは休憩中のとき）は**展開時も現行のまま**変えない。中断・再開・休憩・戻りを時系列順に入力すれば、遷移後のステータスが次の操作のボタンを出すため、判断 4 が扱う全状態へ到達できる（例: `in_progress` のタスクに 14:00 の一時停止 → `paused` になり「再開」が出る → 15:00 の再開）。既に `in_progress` のタスクへ**さらに古い着手**を足す操作は本 Issue（中断・休憩の後追い）の範囲外
- 展開欄には `戻り時刻（任意）` の時刻入力も置く。休憩中でない表示のとき「休憩」ボタンは、戻り時刻があれば `break_start` → `break_end` の 2 件を直列で送り、空なら `break_start` のみ送る（判断 6）
- 展開欄は休憩中（「戻りました」だけが出る状態）でも使えるようにする（休憩からの戻りも後追いしたいため。判断 6 の 2 回目失敗後の再送もこの経路）
- 送信前の軽い妥当性（未来時刻・空値）は web で弾き、ボタンを無効化してその理由を示す。**サーバ側が正**であり、web の検証はサーバの検証の写しではない（`break_end` の順序などはサーバの 400 メッセージをそのまま `role="alert"` で表示する）
- 成功時のフィードバックに時刻を含め、あわせて**日報が生成済みなら再生成が必要である旨**を一言添える（判断 3。生成済みかどうかを問い合わせず、時刻指定の記録では常に表示する＝軽微な判断）
- 「今日の活動」一覧は `GET /api/activity/today` が `created_at` 昇順で返すため、後追いイベントは指定時刻の位置に並ぶ。後追いであることを一覧上で区別する表示は**持たない**（現時点の要件ではなく、区別には列追加が要る）
- 見た目は既存の `CheckinPanel.css` の語彙（`.checkin-panel label` / `.checkin-panel-group` / `--color-*`）に合わせる。素の `<input type="time">` を置くだけにせず、展開欄を 1 つのグループとして整える

## クリティカル設計決定

> 各判断に「及ぶ層」を明記する。実装はこの線引きに従い、「手を入れない層」には変更を加えない。

### 判断 0: 記録の形（時刻を `created_at` に格納する）

- **採用案**: 任意の入力フィールド `occurred_at` を受け、**指定時刻をそのまま `activity_events.created_at` に格納する**。省略時は現行どおりサーバ時刻。列・テーブルは足さない
- **理由**: 消費者（検知・エスカレーション・日報・活動ログ）はすべて `created_at` を読むため、後追いイベントは「その時刻に起きたもの」として自然に扱われ、各消費者に分岐を足さずに済む。スキーマ変更（[ADR 0005](../adr/0005-sqlite-schema-policy.md) の再構築手順）も不要
- **代替案**:
  - **`occurred_at` 列を追加し `created_at` は記録時刻のまま残す** — 却下。全消費者が「どちらの時刻を読むか」の分岐を持つことになり、マイグレーションも要る。「後追いであること」を区別する要件が現時点で無い
  - **後追い専用テーブル** — 却下。同上に加え、検知エンジンに新しい入力経路を足すことになる（ADR 0004 帰結に反する）
- **影響範囲（及ぶ層）**: `checkins-validation.ts`（`CheckinInput` に `occurred_at: string | null`）・`recordActivityEvent`（`created_at` を任意で受け取る。省略時は現行どおり `new Date().toISOString()`）・web の `CheckinInput` 型と `checkins-api.ts`。**手を入れない層**: DB スキーマ・`GET /api/activity/today`・検知・日報
- **仮定**: フィールド名は既存の snake_case（`task_id` / `expected_minutes`）に揃えて `occurred_at` とする（「出来事が起きた時刻」を表す。`recorded_at` は記録操作の時刻と紛らわしいため採らない）。**「後追い記録であること」自体を UI や履歴で区別する必要が実装中に判明した場合は、列追加（マイグレーション）を伴うためここで決めず親へ質問する**

### 判断 1: 過去の催促・通知は撤回しない

- **採用案**: **送信済み通知は撤回・削除しない**。後追いイベントを記録しても `notifications` の既存行はそのまま残る
- **理由**: 通知履歴は事実であり、macOS 通知は撤回できない。`notifications` は検知エンジンの入力（エスカレーション段階・重複送信抑止）でもあり（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 4）、遡及削除は再送抑止を壊す
- **代替案**: **後追いイベント以降の通知を削除する** — 却下。上記のとおり再送抑止の状態を壊し、「催促を後追いで消せる」抜け道にもなる
- **影響範囲（及ぶ層）**: **通知・`notifications` テーブルには一切手を入れない**。テストで「後追い記録後も既存通知行が残る」を固定する

### 判断 2: エスカレーション段階は既存規則に委ねる

- **採用案**: 専用ロジックを足さず、`server/src/detection/escalation.ts` の現行規則（最新通知の `sent_at` より後の `created_at` を持つ活動シグナルがあれば L1 へリセット）に委ねる。後追いイベントの `created_at` が `sent_at` より**後**なら自然にリセットされ、**前**ならリセットされない
- **理由**: エンジンは `created_at` しか見ないため、後追いイベントは追加規則なしで整合する。「過去に遡って段階を下げる」ことは通知履歴の書き換えを意味し、判断 1 と矛盾する
- **代替案**: **後追いイベントの時刻以降の通知を無視して段階を再計算する** — 却下。決定的エンジンの入力に「無視すべき通知」という新しい概念を足すことになり、判断 1 とも矛盾する
- **影響範囲（及ぶ層）**: **`server/src/detection/escalation.ts` は無変更**。回帰テストで「`sent_at` より前の後追いイベントはリセットしない／後ならリセットする」の両側を、API 経由で記録したイベントを `resolveEscalation` に渡す形で固定する

### 判断 3: 生成済み日報は自動再生成しない

- **採用案**: 日報は生成時点のスナップショットとし、**後追い記録で自動再生成しない**。必要なら既存の手動再生成（`POST /api/reports/generate`・#171）で反映する。UI は後追い記録の成功応答で「日報は再生成が必要」と一言添えるに留める
- **理由**: 日報の生成は夕会を前提とした LLM 呼び出しを含み（[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md)）、チェックインの副作用として走らせると費用と失敗経路が増える。再生成の導線は既にある
- **代替案**: **当日の日報が生成済みなら後追い記録時に自動再生成する** — 却下。上記のとおり。副作用の連鎖で `POST /api/checkins` の応答が LLM 待ちになる
- **影響範囲（及ぶ層）**: **日報生成・セッション側（`server/src/reports/`）は無変更**。web の成功フィードバック文言のみ。生成済みかどうかの問い合わせは行わない（常時表示。軽微な判断）

### 判断 4: 過去時刻の `task_start` / `task_pause` と現在ステータス

- **採用案**: `occurred_at` を指定した `task_start` / `task_pause` は、**その時刻が当該タスクの最新の `task_start` / `task_pause` イベント（`created_at` 最大）より新しい場合のみ**現行どおり `tasks.status` を遷移させる（`task_start`: `todo` / `paused` → `in_progress`、`task_pause`: `in_progress` → `paused`）。古い（または同時刻の）場合はイベントだけ記録し、ステータスは変更しない。**`task_start` と `task_pause` に対称に適用する**。当該タスクに `task_start` / `task_pause` が無ければ「最新より新しい」とみなす
- **理由**: 「14:00 に中断し忘れたが 15:00 に再開済み」で 16:00 に 14:00 の `task_pause` を後追いすると、現行規則では現在ステータスが `paused` へ倒れる。後追いイベントより新しい着手／一時停止があるなら、現在の状態はその新しい方が決めている
- **代替案**:
  - **後追いイベントでは一切ステータスを変えない** — 却下。「14:00 に一時停止して以後そのまま」を後追いした場合、ステータスが `in_progress` のまま残り実態と食い違う
  - **`task_update` も比較対象に含める** — 見送り。ボード操作由来の `task_update` は遷移元ステータスの既存ガード（`todo` / `paused` からしか着手しない等）で大半が吸収される。含めると比較対象が「ステータス変更を伴わない更新」まで広がり判定が曖昧になる（下記仮定）
- **影響範囲（及ぶ層）**: **`checkins-routes.ts` の遷移判定のみ**。`updateTask` と `task_update` イベントの既存契約、`recordActivityEvent` との同一トランザクションは維持。`occurred_at` 省略時は現行どおり無条件に遷移判定へ進む（既存契約を変えない）
- **仮定**: 比較対象は同じ `task_id` の `task_start` / `task_pause` に限る。`task_update`（ボード操作・ボスのツール）は比較しない

### 判断 5: 入力の妥当性

- **採用案**:
  - `occurred_at` は任意。指定時は `isValidIsoDateTime` を満たす ISO 8601 日時（形の検証・400）
  - **未来時刻は 400**（サーバの現在時刻より後。同時刻は可）
  - **遡れる範囲は当日ローカル暦日の 00:00 以降**（`startOfLocalDayIso(now)` より前は 400。前日以前は日報・作業ログの帰属する暦日が変わるため）
  - **`occurred_at` を指定した `break_end` は、その時刻の直前にある `break_start` より後であり、かつその間に `break_end` が無いこと**（違反は 400。「その時刻に開いている休憩」を閉じる記録だけを受理する）
  - `occurred_at` を指定した `break_start` の順序は検証しない（現行の書き込み側が `break_start` の連続を拒否しない規律に揃える。[ADR 0007](../adr/0007-local-calendar-day-basis.md) 帰結「休憩は同時に 1 つしか開かない」の読み取り側解釈に委ねる）
- **理由**: 未来時刻は検知エンジンが「負の経過分」として扱うか除外するかが規則ごとに異なり（`avoidance.ts` は除外、`escalation.ts` は「最新通知より後」として即リセット）、受理すると検知が歪む。当日外は集計の帰属先が変わる。`break_end` の順序は日報の対応付け（`server/src/reports/activity-record.ts` `pairBreaks`）と検知（`getActiveBreak`）が「開いている休憩を閉じる」解釈をするため、閉じる相手の無い `break_end` は無意味な記録になる
- **代替案**:
  - **遡れる範囲を数時間に限る** — 却下。「午前の休憩を夕方に思い出す」を排除する理由が無い
  - **前日以前も許す** — 却下。生成済み日報・作業ログの帰属が変わり、判断 3 の「再生成が必要」の範囲が当日に閉じなくなる
  - **`break_end` の順序を「最新の `break_start` より後」で判定する** — 却下。後追いで開始と戻りを両方記録するとき、既にその後の休憩（開始・戻り）が記録済みだと正当な戻りが弾かれる
- **影響範囲（及ぶ層）**: `checkins-validation.ts`（形）と `checkins-routes.ts`（未来・当日境界・`break_end` 順序）。**`occurred_at` を省略した `break_end` の既存契約（`break_start` が無くても 201）は変えない**。web 側は未来・空値の事前チェックのみ（サーバが正）
- **仮定**: 当日境界の判定と未来判定は、ルートが 1 回だけ読んだ `now` から導く（`GET /api/activity/today` と同じ「同一の時計読み取りから両境界を出す」規律）

#### 調査結果: `break_end` 無しの後追い `break_start` に対する検知エンジンの挙動（事実）

`server/src/detection/break-overrun.ts` の `getActiveBreak` は `break_start` / `break_end` **だけ**を見る。最新の `break_start` の後に `break_end` が無ければ、その間に `task_start` / `task_pause` があっても**その休憩は継続中**と判定される（`break-overrun.test.ts` の「ignores task_pause events」が固定している既存の解釈）。

したがって、`break_end` を伴わずに過去時刻の `break_start` を差し込むと、次の scheduler tick（`server/src/scheduler/scheduler-tick.ts` は全履歴を読む）では:

- 勤務時間帯内なら `isBreakOverrun`（現在時刻 − `created_at` > `expected_minutes`）が真になりやすく、`break_overrun` の催促が飛ぶ（既に `task_start` で再開していても同じ）
- 休憩ゲートにより未着手・回避・無音・締切超過の各検知が止まる（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 6）
- web の `deriveIsOnBreak` も同じ解釈なので、その後に閉じた休憩が無ければパネルは「戻りました」だけの表示へ切り替わる。**その後に閉じた休憩（開始・戻り）が既にある場合は切り替わらず**、開きっぱなしの後追い休憩は日報の対応付けで**次の `break_start` の時刻まで**続いた休憩として計上される（`pairBreaks`）

### 判断 6: 休憩の後追い記録の形（開始時刻＋任意の戻り時刻を一度に記録する）

- **採用案**: 時刻指定モードの「休憩」は、展開欄の `戻り時刻（任意）` に入力があれば web が `break_start`（開始時刻）→ `break_end`（戻り時刻）の順に**直列で** 2 回 `POST /api/checkins` する（1 回目の 201 を待ってから 2 回目。並列に投げない）。戻り時刻が空なら `break_start` のみ送る（「まだ休憩中」の宣言。次の tick で休憩超過の催促が出るのは、開いている休憩を自ら宣言した帰結として自然）
- **理由**: 上の調査結果のとおり、`break_start` だけを後追いすると「既に再開しているのに休憩超過が飛ぶ」「後続の休憩があると閉じ忘れに気付けず日報が過大計上される」が起きる。戻り時刻を同じ操作で受け取れば閉じ忘れの窓が実質消え、サーバは判断 5 の順序検証だけで足りる
- **代替案**:
  - **`break_start` の後追いを単独イベントとし、パネルが「戻りました」に切り替わるのを合図にユーザーが `break_end` を後追いする** — 却下。後続の休憩が記録済みだと合図が出ず、日報の過大計上に気付けない残差が残る
  - **`task_start` が休憩を閉じるようエンジンを変える** — 却下。`getActiveBreak` / `pairBreaks` / `deriveIsOnBreak` の 3 箇所の解釈（ADR 0007 帰結）を変える横断変更で、本仕様の「検知エンジン無変更」の線引きを超える
  - **開始と戻りを 1 リクエストで受けるバッチ API** — 却下。専用エンドポイントを増やし、単一イベントの契約（判断 4・5 の検証）を二重に持つことになる
- **2 回の POST が原子的でないことへの対処**（この残差は web で潰す）:
  - **送信前の事前チェック**: 戻り時刻が入っているとき、「戻り時刻 > 開始時刻」「両方とも当日内かつ未来でない」を web で検証し、満たさなければ **1 回も POST せず**入力エラーとして表示する（サーバの 400 は最終防衛線。正常入力で 2 回目だけが失敗する経路を事前に塞ぐ）
  - **2 回目（`break_end`）が失敗した場合**: 記録済みの `break_start` は取り消さない（判断 1 と同じく記録は事実）。展開欄を閉じず、開始時刻・戻り時刻の入力を保持したままエラーを表示する。この時点で活動一覧は開いた休憩を含むためパネルは「戻りました」表示になり、ユーザーは保持された戻り時刻のまま「戻りました」で `break_end` だけを再送できる
- **影響範囲（及ぶ層）**: **web のみ**（`CheckinPanel` の展開欄と `use-checkin-panel` の送信手順）。サーバは判断 5 の順序検証だけで、専用エンドポイント・バッチ API は作らない。検知・日報は無変更
- **仮定**: `break_start` の `expected_minutes` は現行どおり「休憩時間」の選択値をそのまま送る。戻り時刻から導出して上書きしない（消費者を増やさない）

## 機能全体の設計

### アーキテクチャ決定

- サーバは「形の検証（純粋）」→「DB を見る整合検証」→「遷移判定」→「同一トランザクションで記録」の現行の並びを保ち、各段に `occurred_at` の分岐を足す。判定に使う現在時刻はハンドラ冒頭で 1 回だけ読む
- `checkins-routes.ts` は形の検証を通った `occurred_at` を直ちに `new Date(occurred_at).toISOString()` で正規化し、以後の未来判定・当日境界判定・`break_end` 順序判定・判断 4 の最新イベント探索・`recordActivityEvent` への引き渡しはすべてこの正規化済み値（Z 形式）を使う。比較は正規化済み Z 形式同士の文字列比較、または `getTime()` の数値比較で行い、生の入力文字列を比較しない
- 判断 4・5 の DB 整合検証に必要な読み取り（当該タスクの最新 `task_start` / `task_pause`、指定時刻の直前の `break_start` とその後の `break_end`）は `activity-events-repository.ts` の読み取りヘルパとして足す（他 feature ディレクトリを import しない同ファイルの規律は維持）
- web は `CheckinInput` に `occurred_at?: string | null` を足し、`CheckinPanel` が時刻入力から当日ローカル暦日の `Date` を組み立てて `toISOString()` で送る。フックの `submitCheckin` の契約（再入ガード・tasks 再取得 → 活動再取得の順）は変えない

### IF / API

- `NewActivityEventRecord`（`activity-events-repository.ts`）に `created_at?: string` を追加。省略時はサーバ時刻。呼び出し側（チャット・タスク更新の自動記録）は変更しない
- `CheckinInput`（server / web）に `occurred_at: string | null` / `occurred_at?: string | null` を追加

### 実装計画（チケット分解の見通し）

1. **server**: `occurred_at` の形の検証・未来／当日境界・`break_end` 順序（判断 5）、`created_at` への格納（判断 0）、遷移判定（判断 4）と、判断 1・2 の回帰テスト
2. **web**: 展開式の時刻指定欄・`occurred_at` 送信・事前チェック・成功時の一言（判断 3）・戻り時刻の同時記録と 2 回目失敗時の入力保持（判断 6）
3. **回帰固定テスト**: 判断 5 の調査結果（開いたままの後追い `break_start` に対する `break_overrun` の挙動）と、日報が後追い記録で再生成されないことの固定。1 に吸収してもよい

## 明示的な仮定

- **仮定 1**: フィールド名は `occurred_at`。ISO 8601 日時（オフセット付き可）を受け、格納時に `toISOString()` 形式へ正規化する
- **仮定 2**: 判断 4 の比較対象は同じ `task_id` の `task_start` / `task_pause` のみ（`task_update` は含めない）
- **仮定 3**: 判断 4・5 の後追い固有の判定は `occurred_at` 指定時のみ行い、省略時の既存契約（無条件の遷移判定・孤立 `break_end` の受理）は変えない
- **仮定 4**: 判断 3 の一言は生成済みかどうかを問い合わせず、時刻指定の記録では常に表示する
- **仮定 5**: web の時刻入力は当日内なので時刻のみ（`HH:mm`）。秒は 0 とする
- **仮定 6**: サーバのエラーメッセージは英語（既存の `checkins-validation.ts` のスタイル）。web の事前チェックの文言は日本語
- **仮定 7**: 判断 6 で戻り時刻を指定した休憩でも、`break_start` の `expected_minutes` は「休憩時間」の選択値をそのまま送る（戻り時刻から導出しない）
- **仮定 8**: 時刻指定欄を展開しても、各ボタンの表示・活性条件は現行のまま（現在のタスクステータス・休憩状態に基づく）。時系列順の入力で判断 4 の全状態に到達できるため、活性条件を緩めない。既に `in_progress` のタスクへさらに古い着手を足す操作は範囲外

## 受入基準

- [ ] AC-1: `occurred_at` に当日内の過去の ISO 8601 日時を指定して `POST /api/checkins` すると、応答と DB の `created_at` がその時刻（`toISOString()` 形式）になる
- [ ] AC-2: `occurred_at` を省略（または `null`）した `POST /api/checkins` は、現行どおりサーバ時刻の `created_at` で記録される
- [ ] AC-3: `occurred_at` が ISO 8601 日時でない値（数値・日付のみ・不正な文字列）のとき 400 を返す
- [ ] AC-4: `occurred_at` がサーバの現在時刻より後のとき 400 を返す
- [ ] AC-5: `occurred_at` が当日ローカル暦日の 00:00 より前のとき 400 を返す（00:00 ちょうどは受理する）
- [ ] AC-6: `occurred_at` を指定した `break_end` は、その時刻の直前に `break_start` が無いとき 400 を返す
- [ ] AC-7: `occurred_at` を指定した `break_end` は、直前の `break_start` との間に既に `break_end` があるとき 400 を返す
- [ ] AC-8: `occurred_at` を指定した `break_end` は、直前の `break_start` より後でその間に `break_end` が無ければ、その後に別の休憩（開始・戻り）が記録済みでも 201 で記録される
- [ ] AC-9: `occurred_at` を指定した `task_pause` は、その時刻が当該タスクの最新の `task_start` / `task_pause` より新しいとき、`in_progress` のタスクを `paused` へ遷移させる
- [ ] AC-10: `occurred_at` を指定した `task_pause` は、その時刻が当該タスクの最新の `task_start` / `task_pause` より古いとき、イベントは記録するがタスクのステータスを変更しない
- [ ] AC-11: `occurred_at` を指定した `task_start` は、その時刻が当該タスクの最新の `task_start` / `task_pause` より新しいとき、`paused` のタスクを `in_progress` へ遷移させる
- [ ] AC-12: `occurred_at` を指定した `task_start` は、その時刻が当該タスクの最新の `task_start` / `task_pause` より古いとき、イベントは記録するがタスクのステータスを変更しない
- [ ] AC-13: 後追い記録を行っても、既存の `notifications` 行は削除・変更されない
- [ ] AC-14: 最新通知の `sent_at` より後の時刻で後追い記録した活動シグナルは、`resolveEscalation` の判定を L1 へリセットする
- [ ] AC-15: 最新通知の `sent_at` より前の時刻で後追い記録した活動シグナルは、`resolveEscalation` の判定をリセットしない
- [ ] AC-16: 生成済みの当日日報は、後追い記録を行っても内容が変わらない
- [ ] AC-17: `break_end` を伴わない後追い `break_start` は、次の検知評価で継続中の休憩として扱われる（`getActiveBreak` がそれを返す）
- [ ] AC-18: チェックインパネルの「時刻を指定して記録」を展開して時刻を入力すると、着手（`task_start`）の送信に当日ローカル暦日のその時刻が `occurred_at` として付く
- [ ] AC-19: 時刻指定欄に戻り時刻を入力して休憩を記録すると、`break_start`（開始時刻）の 201 応答の後に `break_end`（戻り時刻）が送信される
- [ ] AC-20: 戻り時刻が空のまま休憩を記録すると、`break_start` のみが送信される
- [ ] AC-21: 戻り時刻が開始時刻以前のとき、休憩ボタンは無効になり `POST /api/checkins` は 1 回も送信されない
- [ ] AC-22: 戻り時刻が未来のとき、休憩ボタンは無効になり `POST /api/checkins` は 1 回も送信されない
- [ ] AC-23: 戻り時刻付きの休憩で 2 回目の `break_end` が失敗したとき、1 回目の `break_start` は送信済みのまま取り消されず、エラーが `role="alert"` に表示される
- [ ] AC-24: 戻り時刻付きの休憩で 2 回目の `break_end` が失敗したとき、時刻指定欄は展開されたまま開始時刻・戻り時刻の入力値が保持される
- [ ] AC-25: 休憩中の表示（「戻りました」）でも時刻指定欄を展開して時刻を入力すると、「戻りました」の送信に `occurred_at` が付く
- [ ] AC-26: 時刻指定欄を展開していない（または時刻が空の）とき、送信に `occurred_at` は付かない
- [ ] AC-27: 時刻指定欄に未来の時刻を入力すると、各送信ボタンが無効になり理由が表示される
- [ ] AC-28: 時刻を指定した記録の成功後、フィードバックに日報の再生成が必要な旨が含まれる
- [ ] AC-29: サーバが 400 を返したとき、そのメッセージが `role="alert"` の要素に表示される
- [ ] AC-30: 時刻指定欄を折りたたんでいるとき、既存のボタン・入力の構成は現行と同じである
- [ ] AC-31: 時刻指定欄を展開して時刻を入力すると、一時停止（`task_pause`）の送信にその時刻が `occurred_at` として付く
- [ ] AC-32: 時刻指定欄を展開して時刻を入力すると、休憩（`break_start`）の送信にその時刻が `occurred_at` として付く
- [ ] AC-33: `occurred_at` を指定した `break_end` は、直前の `break_start` と同時刻ちょうどのとき 400 を返す
- [ ] AC-34: 時刻指定欄を展開しているとき、着手 / 一時停止 / 戻りました の表示・活性条件は折りたたみ時と同じである
