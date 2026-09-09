# 当日限りの朝会・夕会の時刻変更（今日だけ会の時刻をずらす）

## 概要

その日だけ朝会・夕会の定時催促の時刻をずらせるようにする。当日分の時刻は恒常設定（`settings` の `morning_meeting_time` / `evening_meeting_time`）とは別の新テーブルに日付キーで持ち、**翌日は行が無い＝既定へ戻る**。変更手段はダッシュボード上の UI のみとし、**ボスに設定を書き換える LLM ツールは渡さない**（別 Issue へ切り出す）。遅らせられる幅には上限を設け、当日変更が催促の恒久的な消音手段にならないようにする。

## 背景・目的

### 現状: チャットで伝えても通知は設定時刻のまま飛ぶ

朝会・夕会の定時催促は「**設定時刻を過ぎている** かつ **当日その種別のセッションが未開始**」で発火する（`server/src/detection/meeting.ts:22-30` の `isMeetingDue`）。参照するのは `loadDetectionSettings`（`server/src/scheduler/detection-settings.ts:96-97`）が `settings` テーブルから読む `morning_meeting_time` / `evening_meeting_time` だけで、既定は `09:00` / `18:00`（`server/src/detection/detection-types.ts:106-107`）。

検知エンジン `evaluateRules`（`server/src/detection/rule-engine.ts:25`）の入力は `now` / `tasks` / `activityEvents` / `notifications` / `settings` / `todaysSessionTypes` のみで（`detection-types.ts:110-122`）、`messages` も `decisions` も入らない。`record_decision` で「今日は 16 時に終わる」と記録しても、`decisions` を読むのはボスのプロンプト組み立て（`server/src/sessions/chat-messages-route.ts:262`）と決定ログ API だけで、スケジューラ（`server/src/scheduler/scheduler-tick.ts:56-66`）は読まない。

結果、定時通知を止める唯一の方法は「その種別のセッションを当日中に開始する」ことであり（`listTodaysSessionTypes`）、**前倒しはできても後ろへずらせない**。しかも夕会は 1 日 1 回で日報生成の前提条件でもあるため（[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 1・決定 4）、催促を止める目的で夕会を開いて即閉じると当日の日報が壊れる。

### Issue #258 本文と現在のコードの食い違い（要件の前提として記録する）

Issue #258 は 2026-08-31 起票で、本文のコード記述は当時の観察である。本仕様の作成時（2026-09-09）に実コードで裏取りしたところ、次の 5 点が現在の実装と食い違っていた。**とくに ② と ③ は、本文を信じたまま設計すると誤る種類の食い違いである。**

1. 「`BOSS_TOOLS` は 4 つ」→ **5 つ**。`RECORD_MENTORING_TOOL` が追加済み（`server/src/boss/boss-tools.ts:18-23`、#276/#407）
2. 「`work_end` を動かすと**未着手・回避・無音・休憩延伸**のゲートが動く」→ **5 ルール**。上記 4 つに加え **`deadline_overdue`（締切超過）** も同じゲート下にある（`rule-engine.ts:50-79`。`isWithinWorkingHours` の呼び出しは `rule-engine.ts:47` の 1 箇所だけで、そこが 5 ルールを一括でゲートする）
3. 「**チャットの内容は検知エンジンに一切入らない**」→ 内容は入らないが、**チャットしたという事実は入る**。発言ごとに `chat_message` の活動イベントが記録され（`chat-messages-route.ts:259`）、`escalation.ts:64-66` の `hasActivitySince` がこれを見て**エスカレーションを L1 へリセットして即再発火**する。「チャットは検知に影響しない」と読むと決定 6 の設計を誤る
4. 「定時通知を抑止する唯一の方法はセッションを開始すること」→ 正しいが、上記のとおり夕会でそれを行うと日報が壊れる（ADR 0008）
5. 「LLM 経由にすると誤認識で通知が黙って消える危険がある」→ 正しく、かつ**現在の UI では危険度がより高い**。`create_task` / `update_task` 以外のツールは、チャット画面に一律「**ボスがツールを実行しました**」としか表示されない（`web/src/ChatView.tsx:46-49`）。何が何時に変わったのかは画面に出ない

### なぜ「黙って消える」ことが致命的か

サボり検知は本アプリの中核価値である（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 背景）。誤検知（余計に鳴る）はユーザーが気付いて直せるが、**誤抑止（黙る）は気付く手がかりが画面上に一つも残らない**。実コードで辿ると次の 5 段になる。

1. ユーザーが「今日は打ち合わせ続きで夕方まで手が離せない」と発話する（時刻変更の依頼ではない）
2. ボスが時刻変更ツールを呼ぶ（誤認識）
3. 画面表示は「ボスがツールを実行しました」だけ（`ChatView.tsx:46-49`）
4. `isMeetingDue` が新しい時刻まで `false`（`meeting.ts:28`）→ **その日の夕会催促が一度も発火しない**
5. 発火しないので `notifications` に行が入らず、ダッシュボードの `todayMaxEscalationLevel` も 0 のまま＝「今日は催促されなかった良い日」と見分けがつかない。夕会が開かれなければ当日の日報も生成できない（ADR 0008 決定 1）

この経路を塞ぐことが、決定 8（LLM ツールを渡さない）・決定 7（遅延上限）・機能要件の「予定時刻をダッシュボードに出す」の共通の目的である。

## ユーザーストーリー

日によって始業・終業がずれるオーナーとして、**今日だけ**朝会・夕会の時刻をずらし、その日の催促をずらした時刻に受け取りたい。翌日は何もしなくても既定の時刻に戻ってほしい。そして**今日の会が何時に設定されているかを画面で確認できる**ようにしたい。

## 機能要件

- [ ] 当日の朝会の時刻を、恒常設定とは別に指定できる
- [ ] 当日の夕会の時刻を、恒常設定とは別に指定できる
- [ ] 指定した当日の朝会の時刻が、朝会の定時催促の発火判定（`isMeetingDue`）に反映される
- [ ] 指定した当日の夕会の時刻が、夕会の定時催促の発火判定（`isMeetingDue`）に反映される
- [ ] 指定した当日の時刻は翌日には効かず、翌日は恒常設定の時刻で発火する
- [ ] 指定した当日の時刻を取り消して、その日のうちに恒常設定へ戻せる
- [ ] 恒常設定の時刻より 180 分（`MAX_MEETING_DELAY_MINUTES`。決定 7）を超えて遅らせることはできない
- [ ] 恒常設定の時刻より早い時刻（`00:00` を含む）を指定できる
- [ ] ダッシュボードに今日の朝会の予定時刻が表示される
- [ ] ダッシュボードに今日の夕会の予定時刻が表示される
- [ ] ダッシュボードの表示で、予定時刻が恒常設定と違う場合はその旨が分かる
- [ ] 当日の時刻を変更しても、恒常設定（`GET /api/settings` が返す値）は変わらない
- [ ] 当日の時刻を変更しても、勤務時間帯ゲート（`work_start` / `work_end`）は変わらない

## 技術的な制約・方針

- **変更対象（サーバ）**: `server/src/db/migrate.ts`（version 9 の追加のみ）、新設 `server/src/meeting-schedule/`（純粋関数・リポジトリ・ルータ）、`server/src/app.ts`（ルータのマウント 1 行）、`server/src/scheduler/scheduler-tick.ts`（`buildTickInput` での合成）、`server/src/detection/meeting.ts`（`buildMeetingRuleKey` のシグネチャ変更）、`server/src/detection/rule-engine.ts`（`buildMeetingRuleKey` の呼び出し 2 箇所）
- **変更対象（web）**: 新設の当日予定コンポーネント・API クライアント・フックと、`web/src/Dashboard.tsx` への配線
- **変更しない**: `server/src/settings/` 配下すべて（`settings-validation.ts` の `SETTINGS_KEYS` に新キーを足さない）、`web/src/SettingsView.tsx`、`server/src/detection/time-utils.ts` の `isWithinWorkingHours`、`server/src/detection/detection-types.ts` の `DetectionInput`、`server/src/dashboard/` 配下、`migrate.ts` の version 1〜8
- **`DetectionInput` を広げない**。ADR 0004 の帰結「検知エンジンに新しい入力経路を足さない」と字面で衝突するため、当日値は `settings.morningMeetingTime` / `settings.eveningMeetingTime` に**合成済みの実効時刻**として載せる（決定 2）
- **時刻の書式・検証は既存の `TIME_PATTERN`（`detection-types.ts:77`）を再利用する**。新しい正規表現を作らない
- **`:date` の形式検証と実在暦日チェックは既存の `parseDateKey`（`detection/time-utils.ts`）を再利用する**。新しい日付検証ロジックを書かない（`server/src/reports/work-logs-routes.ts` / `server/src/reports/reports-routes.ts` が同じ用途で使っている）
- **日付キーは `toDateKey`（`detection/time-utils.ts:68`）を使う**（[ADR 0007](../adr/0007-local-calendar-day-basis.md) 決定 2）。新たな日付整形ロジックを書かない
- **日付境界に触る変更であるため `npm run test:tz`（非 UTC タイムゾーンでの追加実行）も通す**（ADR 0007 決定 6）。新規テストの固定時刻は `new Date(y, m, d, h, m)` 由来で組み、UTC 文字列リテラルで固定しない（同 決定 5）
- **エラー応答は既存の `{ error, code }` 形式に揃える**（`server/src/reports/reports-routes.ts:62,74,105` の作法）。`code` は snake_case
- ディレクトリ名は `meeting-schedule/` とする。既存の `scheduler/` と紛らわしくならないようにするため（`schedule/` は不可）
- 新規テーブルの行は過去日分も削除しない（クリーンアップ処理を書かない。単一ユーザー・1 日最大 2 行で有界であり、削除処理は消し過ぎの経路を作るだけになる）

## 画面・API設計

### API

**`GET /api/meeting-schedule/:date`** / **`PUT /api/meeting-schedule/:date`**（`app.ts` の `api.route("/meeting-schedule", ...)` でマウント）

`:date` はローカル暦日キー（`YYYY-MM-DD`）。本仕様では**当日のみ受け付ける**（決定 5）。パスに日付を持つのは、後から翌日以降を解禁するときに URL 形を変えずに済むようにするためである。

両メソッドの成功応答は同じ形にする（PUT 後に GET を撃ち直さずに済むように）。

```json
{
  "date": "2026-09-09",
  "morning": { "time": "09:00", "defaultTime": "09:00", "overridden": false, "latestAllowedTime": "12:00" },
  "evening": { "time": "21:00", "defaultTime": "18:00", "overridden": true,  "latestAllowedTime": "21:00" }
}
```

| フィールド | 意味 |
|---|---|
| `time` | その日の**実効時刻**（上書きがあれば上書き時刻、無ければ `defaultTime`） |
| `defaultTime` | 恒常設定の時刻（`loadDetectionSettings` が返す値） |
| `overridden` | `time !== defaultTime`（実効時刻が恒常設定と違うか）。行の存在ではなく**値の比較**で決める |
| `latestAllowedTime` | 指定できる最も遅い時刻（決定 7）。UI は時刻入力の `max` に使う |

PUT のリクエストボディ。`null` は「その種別の上書きを削除して既定へ戻す」を意味する。指定しなかった種別は変更しない。

```json
{ "morning": "10:00", "evening": null }
```

**恒常設定と同じ時刻が指定された場合は、上書き行を保存せず削除する**（`null` と同じ扱い）。実効時刻は同じであり、行を残すと「上書きされているのに `overridden` が `false`」という状態が生まれて「既定に戻す」操作が消えるため。これにより、書き込み経路を通る限り「上書き行が存在する ⇔ 実効時刻が既定と異なる」が保たれる（合成規則 2・3 のフォールバックが効いた行だけがこの同値から外れ、そのときも `overridden` は値比較により正しく `false` になる）。

エラー応答（すべて 400・`{ error, code }`）:

| `code` | 条件 |
|---|---|
| `invalid_date` | `:date` が `YYYY-MM-DD` 形式でない、または実在しない暦日 |
| `not_today` | `:date` が当日でない |
| `invalid_request` | ボディが JSON オブジェクトでない、または `morning` / `evening` 以外のキーを含む |
| `invalid_time` | 値が `"HH:mm"` 形式でも `null` でもない |
| `delay_limit_exceeded` | 値が `latestAllowedTime` より遅い |

PUT は**全項目を検証してから書く**（all-or-nothing）。`settings-routes.ts:58-80` の既存作法（検証を全通ししてから 1 トランザクションで書く）をそのまま踏襲する。

### IF（層間の境界となる契約）

実装計画の A（保存層）・B（純粋関数）・C（API）・D（スケジューラ結合）が共有する境界であるため、シグネチャをここで固定する。層ごとに別チケットへ分かれても食い違わないようにするためであり、関数の中身は実装者の裁量とする。

```ts
// server/src/meeting-schedule/meeting-schedule.ts（純粋関数。DB にも現在時刻にも触れない）

/** 恒常設定からの最大遅延（分）。設定へは露出しない（決定 7） */
export const MAX_MEETING_DELAY_MINUTES = 180;

export type MeetingType = "morning" | "evening";

/** 種別ごとの恒常設定の時刻（"HH:mm"） */
export type MeetingTimeDefaults = Record<MeetingType, string>;

/** その日に保存されている上書き。行が無い種別はキーを持たない */
export type MeetingTimeOverrides = Partial<Record<MeetingType, string>>;

/** 指定できる最も遅い時刻。min(既定 + MAX_MEETING_DELAY_MINUTES, "23:59") */
export function latestAllowedMeetingTime(defaultTime: string): string;

/** requestedTime が latestAllowedMeetingTime(defaultTime) 以下か */
export function isAllowedMeetingTime(defaultTime: string, requestedTime: string): boolean;

/** 種別ごとの実効時刻。決定 2 の合成規則 1〜4 に従う */
export function resolveEffectiveMeetingTimes(
  defaults: MeetingTimeDefaults,
  overrides: MeetingTimeOverrides,
): Record<MeetingType, string>;
```

```ts
// server/src/meeting-schedule/meeting-schedule-repository.ts

export function findOverridesByDate(db: Database.Database, date: string): MeetingTimeOverrides;
export function upsertOverride(db: Database.Database, date: string, type: MeetingType, time: string): void;
export function deleteOverride(db: Database.Database, date: string, type: MeetingType): void;
```

`overridden` は純粋関数の返り値ではなく、**API 層が `time !== defaultTime` で導出する**（純粋関数は実効時刻だけを返し、表示上の派生値を持たない）。

`created_at` / `updated_at` はリポジトリ内で `new Date().toISOString()` を呼んで埋める（`tasks-repository.ts:77` / `daily-reports-repository.ts:35` / `decisions-repository.ts:42` と同じ既存の作法。呼び出し元から `now` を渡す形にしない）。この 2 列は監査用であり、実効時刻の判定にも当日判定にも使われない——当日判定は `date` 列と `toDateKey(now)` の比較で行う——ため、テストの時刻固定性には影響しない。

### 画面（ダッシュボード）

`web/src/Dashboard.tsx` に、進捗セクションと同格のセクションを 1 つ足す。既存の `GET /api/dashboard` の応答スキーマは変更せず、このセクションが `/api/meeting-schedule/:date` を直接読む（決定 9）。

```jsx
<section className="dashboard-meeting-schedule" aria-label="今日の会の予定時刻">
  <h2>今日の会</h2>
  {/* 種別ごとに 1 行。overridden のときだけ注記を出す */}
  <p>朝会 09:00</p>
  <p>夕会 21:00<span>（既定 18:00 から変更）</span></p>

  {/* 変更フォーム。max は latestAllowedTime */}
  <label>朝会<input type="time" max="12:00" /></label>
  <label>夕会<input type="time" max="21:00" /></label>
  <button type="button">保存</button>
  {/* overridden の種別にだけ出す */}
  <button type="button">既定に戻す</button>
</section>
```

注記の文言は**「（既定 {defaultTime} から変更）」で固定**する。「今日の会が既定と違う時刻に設定されている」ことに気付けること自体が要件（背景・目的の「なぜ黙って消えることが致命的か」を塞ぐ手段）なので、文言を受入基準としてテストで固定する。

## クリティカル設計決定

> Issue #258 の論点 1〜7 と、要件化の過程で追加した論点 8〜10 に対する決定。後続の実装はこの決定に従い、独自判断で逸脱しない。

### 1. 当日限りの時刻の保存先（DBスキーマ）

- **採用案**: 新テーブル `meeting_time_overrides` を**マイグレーション version 9** として追加する。`(date, meeting_type)` に UNIQUE を張る

```sql
CREATE TABLE IF NOT EXISTS meeting_time_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                    -- ローカル日付キー（toDateKey 形式）
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('morning', 'evening')),
  meeting_time TEXT NOT NULL,            -- "HH:mm"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (date, meeting_type)
);
```

- **理由**: 日付をキーに持てば、**翌日は行が無い状態が自動的に「既定」になる**。「翌日に一時上書きを消す」処理を書かずに済み、消し忘れで恒常設定が壊れる経路が構造的に存在しなくなる。日付 UNIQUE の先行例は version 3 の `daily_reports`（`date TEXT NOT NULL UNIQUE`）にある。外部キーを持たないため、[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4 の「version 単位の単一トランザクション」に文字列エントリのまま乗り、version 4 のような `PRAGMA foreign_keys` のトグルを必要としない。ADR 0005 決定 6「算出できるものは保存しない」にも反しない——上書き値は他のデータから再算出できない
- **代替案**:
  - `sessions` へ予定列を足す — **構造的に不可**として却下。セッション行はセッション**開始時**に作られる（`scheduler/todays-sessions.ts` が `listSessions` から当日分を拾う形）ため、開始前の予定を置く行が存在しない
  - `settings` の一時上書きキー（`morning_meeting_time_override` 等） — 却下。翌日に消す処理が要り、消し忘れが恒常設定の破壊になる。さらに `settings` はフラットな key-value（`settings-validation.ts:11-29`）で日付を持てず、`GET /api/settings` が全キーを返して `SettingsView` が全項目まとめて PUT する構造（`web/src/SettingsView.tsx:39-68`）のため、**設定画面を一度開いて保存するだけで上書き値が恒常値へ焼き付く**
- **影響範囲**: `migrate.ts` に version 9 を追記（既存 version は無改変）。新設の `server/src/meeting-schedule/meeting-schedule-repository.ts`。`meeting_time` という列名は SQLite の `time()` 関数と紛らわしくならないようにした結果であり、`meeting_type` とも読みが揃う

### 2. 恒常設定と当日値をどこで合成するか

- **採用案**: **`scheduler-tick.ts` の `buildTickInput` で合成する**。合成そのものは純粋関数 `resolveEffectiveMeetingTimes` に切り出し、`buildTickInput` は「DB から既定と上書きを読む → 純粋関数へ渡す → `settings.morningMeetingTime` / `settings.eveningMeetingTime` を実効時刻で置き換えて `evaluateRules` へ渡す」だけを行う。`DetectionInput` の型・`evaluateRules`・`isMeetingDue` は無改変
- **理由**: 合成点をここに置くと、(1) `GET /api/settings` は恒常設定を返したままになる、(2) 検知エンジンの入力形が変わらない、(3) 合成規則は純粋関数として単体で網羅テストでき、発火まで含めた結合は `scheduler-tick.test.ts` で検証できる——という 3 点が同時に満たせる
- **代替案**:
  - `loadDetectionSettings`（現在のシグネチャは `loadDetectionSettings(db)`）の中で合成する — **却下**。`settings-routes.ts:19` が同じ関数を `GET /api/settings` の応答生成に使っており、上書き値が設定画面に表示される。そして `SettingsView` は取得値をフォームへ流し込み保存時に全項目を PUT で返すため（`SettingsView.tsx:39-68`）、**ユーザーが設定画面を開いて保存した瞬間に、その日限りの値が恒常設定として恒久的に焼き付く**
  - `DetectionInput` に上書き用フィールドを足し `isMeetingDue` 側で合成する — 却下。純粋関数側で優先順位を固定できる利点はあるが、ADR 0004 の帰結「検知エンジンに新しい入力経路を足さない」と字面で衝突する。合成規則は独立した純粋関数として同等にテストできるため、衝突を避ける側を採る
- **影響範囲**: `scheduler-tick.ts` の `buildTickInput`（`scheduler-tick.ts:56-66`）と、新設の `server/src/meeting-schedule/meeting-schedule.ts`。`detection/` 配下は `meeting.ts` の `buildMeetingRuleKey`（決定 6）以外は無改変

#### 合成規則（`resolveEffectiveMeetingTimes`）

種別ごとに次の順で実効時刻を決める。**フォールバックはすべて「既定時刻」へ倒す**（迷ったら催促する側へ倒す。黙って消えるより余計に鳴るほうが回復可能であるため）。

1. その日・その種別の上書き行が無い → 既定時刻
2. 上書き行の値が `TIME_PATTERN` に合致しない → 既定時刻（警告ログ。`detection-settings.ts:14-17` の既存作法に合わせる）
3. 上書き行の値が `latestAllowedTime`（決定 7）より遅い → 既定時刻（警告ログ）
4. それ以外 → 上書き行の値

3 は理論上の防御ではなく**通常操作で到達する**: 恒常設定が 18:00 のとき 21:00 への上書きは許可されるが、その後ユーザーが恒常設定を 09:00 へ変更すると上限は 12:00 になり、保存済みの 21:00 が上限を超えた状態になる。この場合に上書きを無視して既定へ戻すことで、「上限を超える遅延で催促が消える」経路を API 層だけでなく**発火判定の側でも**塞ぐ。

### 3. 当日変更が何を動かすか（作用範囲）

- **採用案**: **朝会・夕会の定時催促の時刻だけを動かす。`work_start` / `work_end`（勤務時間帯ゲート）は当日変更の対象にしない**
- **理由**: `work_end` の消費者は `loadDetectionSettings`（`detection-settings.ts:56`）→ `settings.workingHours` → `isWithinWorkingHours`（`rule-engine.ts:47`）の 1 経路だけだが、そこが **5 ルール**（`break_overrun` / `unstarted` / `avoidance` / `silence` / `deadline_overdue`）を一括でゲートしている（`rule-engine.ts:50-79`）。当日値で動かすと 5 ルールの当日挙動が同時に変わり、検証面が跳ね上がる。一方、朝会・夕会は勤務時間帯ゲートの**外**にあるため（`rule-engine.ts:81-87`）、`work_end` を超える時刻へ夕会を延期しても通知は問題なく飛ぶ——つまり `work_end` を動かさなくても本 Issue の目的は達成できる
- **既知の帰結（許容する。バグではない）**: 当日変更が朝会・夕会にしか効かないため、次の非対称が残る。**これは仕様であり、後から不具合として報告されるべきものではない。**
  - **早める側**: 「今日は 16 時に終わる」として夕会を 16:00 にしても `work_end` は 18:00 のままなので、**16:00〜18:00 は未着手・回避・無音・休憩延伸・締切超過の催促が飛び続ける**（夕会を実施済みでも他 5 ルールは止まらない）
  - **遅らせる側**: 「今日は 21 時まで働く」として夕会を 21:00 にすると**夕会の催促は 21:00 に飛ぶ**が、18:00 以降は他 5 ルールが勤務時間帯ゲートで停止しているため、**延長した勤務時間は監視されない**
- **代替案**: `work_end` も当日値で動かす／両方動かす — いずれも却下（上記の波及）。勤務時間帯そのものを日ごとに変えたい要望は別 Issue とする
- **影響範囲**: `work_end` 側は完全に無改変。ADR 0004 は改訂不要（ゲートの構造は変わらず、朝会・夕会の時刻の出所が変わるだけ）

### 4. 抑止か延期か

- **採用案**: **延期のみ**。「今日はこの会をやらない（当日スキップ）」は持たない
- **理由**: 抑止を持つと、それは仕様上の消音手段になる。中核価値がサボり検知である以上、催促を丸ごと無くす操作は本 Issue の範囲で足すべきものではない。延期だけなら「いつかは必ず催促が来る」が保たれる
- **代替案**: 抑止フラグ列を持つ／「23:59 に設定する」で代用させる — 前者は却下（上記）。後者は決定 7 の上限により**そもそも到達できない**（恒常設定 18:00 なら上限は 21:00）
- **影響範囲**: 保存スキーマが `meeting_time TEXT NOT NULL` で足りる（NULL 許容列も `skipped` フラグ列も不要）。`isMeetingDue` の呼び出し側に分岐が増えない

### 5. 当日限りか、曜日別の既定まで含むか

- **採用案**: **当日限りに限定する**。曜日別の既定スケジュールは本仕様に含めない。ただし **API のパスは `/:date` の形にしておく**
- **理由**: 曜日別既定は `settings` のフラットな key-value 構造（`settings-validation.ts:11-29`）の変更を伴い、設計の質が変わる。一方 `(date, meeting_type)` というキー形は将来の曜日別既定を妨げない——合成順を「当日上書き > 曜日別既定 > 恒常設定」に伸ばすだけで、本仕様の上書き層はそのまま再利用できる。パスに日付を持たせておけば、「明日は 10 時から」のような翌日以降の指定を解禁するときに URL 形を変えずに済む
- **代替案**: パスを `/today` に固定する — 却下。当日限定の運用は**サーバ側の検証（`not_today`）で担保**すればよく、URL 形まで当日に固定すると解禁時に互換性の断絶が起きる
- **影響範囲**: `:date` が当日でなければ 400 `not_today` を返す検証が 1 つ増える。受入基準は「今日」に閉じて検証を単純に保つ

### 6. 発火済みの扱い（エスカレーション履歴）

- **採用案**: **`rule_key` に実効時刻を含める**。`buildMeetingRuleKey(sessionType, now, meetingTime)` が `{種別}_meeting:{YYYY-MM-DD}@{HH:mm}` を返す形へ変える（例: `evening_meeting:2026-09-09@21:00`）。通知履歴の行は**一切削除・改変しない**
- **理由**: 実効時刻が変わると `rule_key` も変わり、新しいキーには履歴が無いため `resolveEscalation`（`escalation.ts:58-61`）が **必ず L1 から**再開する。履歴を消さずに、しかも決定的にこれが決まる。
  何もしない案（`rule_key` を日付だけのままにする）を採ると、**観測される挙動が入力経路に依存する**: 18:00 に L1 で発火したあと 21:00 へ延期した場合、途中に活動シグナルがあれば `hasActivitySince`（`escalation.ts:64-66`）で L1 リセット、無ければ経過 180 分 > `level1ToLevel2Minutes`(15) で **L2 から**再開する（`escalation.ts:68-75`）。そして「チャットで変更する」経路は発言自体が `chat_message` を記録する（`chat-messages-route.ts:259`）ため活動あり側に倒れる。受入基準が「経路により L1 または L2」という検証できない形になるため採らない
- **`rule_key` の形を変えても安全であることの確認**: `rule_key` を**解析している箇所は無い**。使われ方は等値比較（`escalation.ts:27`・`notifications-repository.ts:89`）とログ出力（`scheduler-tick.ts:112,161,179,198`）だけで、`:` や日付部分を切り出す処理は存在しない（`grep` で全消費者を確認済み）
- **代替案**:
  - 何もしない — 却下（上記の経路依存）
  - 上書き設定時に当該 `rule_key` の通知履歴を削除・無効化する — 却下。監査可能な履歴を壊し、ダッシュボードの `todayMaxEscalationLevel` も遡って変わる
- **帰結（決定 7 とセットである）**: 実効時刻が変わるたびに L1 へ戻るため、**延期を繰り返せばエスカレーションは永久に L1 のまま**になりうる。これは決定 7 の遅延上限が塞ぐ——上限があるため延期を繰り返しても既定 +3 時間より先へは行けず、その時刻には必ず催促が始まる。**決定 6 と決定 7 はどちらか一方だけを実装してはならない**
- **影響範囲**: `detection/meeting.ts` の `buildMeetingRuleKey` のシグネチャと、その呼び出し 2 箇所（`rule-engine.ts:83,86`）。既存テスト `server/src/detection/meeting.test.ts` の `describe("buildMeetingRuleKey")` 配下 3 件（`meeting.test.ts:40,46,64`）は新形式へ更新する。
  **アップグレード当日の一過性の帰結**: version 9 適用日にすでに旧形式のキー（`morning_meeting:2026-09-09`）で発火済みの会があると、次の tick で新形式のキーには履歴が無いため L1 で 1 回だけ再発火する。既に会を実施済みなら `isMeetingDue` が `false` なので発火しない。影響は「通知が 1 回余分に出る」side であり、通知が消える side には倒れない

### 7. 遅延の上限（ガードレール）

- **採用案**: **恒常設定の時刻から `MAX_MEETING_DELAY_MINUTES = 180`（3 時間）を超えて遅らせられない**。上限は種別ごとに `min(既定時刻 + 180 分, 23:59)` として算出する。**上限を超える指定は 400 で拒否し、上限へ丸めない**。前倒し方向に下限は設けない。この上限は**設定へ露出せずコード内定数で固定**する
- **理由**:
  - **上限を置く理由**: 上限が無ければ当日変更は「毎日 23:59 に設定する」という恒久的な消音手段になり、サボり検知という中核価値が仕様上の抜け道で失われる。加えて決定 6 により延期のたびにエスカレーションが L1 へ戻るため、上限が無いと「延期を繰り返して永久に L1」も成立してしまう
  - **丸めずに拒否する理由**: 丸めると「21:00 と指定したのに実際は 21:00 でない」状態が黙って生まれる。これは本仕様が塞ごうとしている「本人の意図と実際の発火時刻が食い違い、しかも気付けない」経路そのものである。拒否ならユーザーはエラーを見て気付ける
  - **前倒しに下限を設けない理由**: 早める側は「催促が予定より早く飛ぶ」という**可視な**結果にしかならず、中核価値を毀損しない
  - **設定へ露出しない理由**: 設定キーを足すと `SETTINGS_KEYS` / バリデータ / `GET/PUT /api/settings` / `SettingsView` の全項目 PUT 経路に波及するうえ、**上限そのものをユーザーが緩められるなら上限を置く意味が薄い**。ADR 0004 決定 5 が `scale` / `min` / `max` を「検知エンジンの組み込み既定値に固定し設定からの上書きは行わない」としているのと同じ扱いにする
  - 3 時間という値の根拠: 恒常設定 18:00 の夕会なら 21:00 まで、09:00 の朝会なら 12:00 まで。「その日の予定がずれた」を吸収するには足り、「今日はもうやらない」には足りない幅として置く
- **上限が 23:59 を超える場合**: 恒常設定が 22:30 のときの `22:30 + 180 分` は翌日 01:30 になるが、`"HH:mm"` は 23:59 までしか表現できず、当日限りという性質からも日をまたげない。この場合は上限を **`23:59` にクランプする**。これは「上限値の算出」であって「ユーザー指定値の丸め」ではないため、上の「丸めない」方針と矛盾しない
- **代替案**:
  - 1 日あたりの変更回数で制限する — 却下。回数は状態を持つ必要があり（何回変えたかの記録）、純粋関数で担保できない。遅延幅の上限は `(既定時刻, 指定時刻)` だけの関数で決まる
  - 上限を超える指定を上限へ丸める — 却下（上記）
  - 上限を `work_end` からの相対で決める — 却下。`work_end` を本仕様の判断材料に持ち込むと決定 3（勤務時間帯を動かさない）との境界が曖昧になる
- **影響範囲**: 新設の純粋関数 `latestAllowedMeetingTime(defaultTime)` / `isAllowedMeetingTime(defaultTime, requestedTime)`。API の PUT 検証と、決定 2 の合成規則 3 と、UI の時刻入力の `max` 属性がすべてこの 1 つの関数を参照する（DRY）

### 8. 誰が設定するか（LLM ツールを渡すか）

- **採用案**: **本仕様では UI からのみ設定できる。ボスに「当日の会の時刻を書き換えるツール」は渡さない。** チャット経由での反映は**本仕様のスコープ外**とし、別 Issue へ切り出す（オーナー判断・2026-09-09）
- **理由（段階導入の根拠）**:
  1. Issue #258 の完了条件のうち機械的に検証できる項目は、UI のみでもすべて満たせる
  2. 保存層と合成層が先にテストで固定されていれば、後からツールを足す変更は**表示と確認の設計だけ**に集中できる。両方を同時に決めると、誤抑止の危険と保存設計の是非が絡んで検証が薄くなる
  3. チャット経由を採る場合の最低ラインは「即時適用＋変更内容の明示表示＋取り消し導線」＋「変更を OS 通知でも知らせる」＋「遅延上限」、あるいは「ツールは提案だけ書き、確定は人間のタップ」＋「遅延上限」であり、Issue #258 単体より明らかに大きい
- **Issue #258 の完了条件との対応**: 完了条件の 3 番目「チャット経由で反映する場合、ボスが『◯時に変更した』と明示的に確認できる（誤認識で通知が黙って消えない）」は**条件付きの項目**である。本仕様はチャット経由を採らないため、**この項目は該当なし**として扱う。誤変更に気付けることの担保は、チャット上の確認ではなく**ダッシュボードへの予定時刻の常時表示**（機能要件・決定 9）が引き受ける
- **ADR 0004 との関係（別 Issue で判断するときの材料として残す）**: LLM ツールを渡す案は ADR 0004 の**条文には抵触しない**。決定 2（純粋関数）は上書き値が設定側に入るだけなので影響を受けず、決定 3（発火判定に LLM を使わない）も発火判定を下すのは依然ルールエンジンである。実際、`update_task` は既に `tasks.estimated_minutes` / `status` / `due_at` という検知の入力を LLM が書き換えられる経路になっている（`boss/task-tools.ts`）。**条文ではなく、ADR 0004 の背景が挙げた失敗モード「同じ状況で催促が出たり出なかったりする」が設定値の経路から再導入される点**が論点であり、`update_task` との違いは可視性にある——タスクの変更はタスクボードに残りチャットにも「ボスがタスクを更新しました: {タイトル}」と出る（`ChatView.tsx:36-60`）が、時刻変更は現状の UI では「ボスがツールを実行しました」としか出ない（同 :46-49）
- **影響範囲**: `server/src/boss/` 配下は完全に無改変（`BOSS_TOOLS` に何も足さない）。`web/src/ChatView.tsx` も無改変

### 9. API と UI の置き場

- **採用案**: **専用ルータ `/api/meeting-schedule/:date` を新設する。`/api/settings` には混ぜない。** UI はダッシュボードに置き、**`GET /api/dashboard` の応答スキーマは変更しない**。ダッシュボードの当日予定セクションが `/api/meeting-schedule/:date` を直接読む
- **理由**:
  - `/api/settings` に混ぜられないのは決定 1・決定 2 と同じ理由（`SettingsView` の全項目 PUT 往復で恒常設定へ焼き付く）
  - UI をダッシュボードに置くのは、**「今日の状態」を出す場所だから**である。設定画面は恒常設定の場所であり、そこに当日限りの値を並べると 2 つの寿命の違う値が同じ画面に混在して取り違えを招く。ダッシュボードは既に `morningSessionHeld` / `eveningSessionHeld` という当日の会の状態を持っている
  - `GET /api/dashboard` に相乗りしない理由は 3 つ。(1) 表示と更新（PUT）で情報源が分かれると値がずれうるが、同じルータなら PUT の応答をそのまま表示に使える。(2) `dashboard/` 配下とその既存テストに一切触れずに済む。(3) ダッシュボードの応答には**1 日 1 回キャッシュされる LLM 生成のボスコメント**（`dashboard/boss-comment.ts`）が含まれており、予定時刻を変えるたびにその応答全体を取り直す構造にしたくない
- **代替案**:
  - `GET /api/dashboard` の応答に予定時刻を足す — 却下（上記 3 点）
  - 設定画面に当日分の欄を足す — 却下（寿命の違う値の混在）
- **影響範囲**: `server/src/app.ts` にマウント 1 行。`server/src/dashboard/` と `server/src/settings/` は無改変。web は `Dashboard.tsx` への配線と新規コンポーネント・フック・API クライアント

## Non-goals（今回やらないこと）

- **チャット経由での時刻変更（LLM ツールの追加）を行わない**（決定 8）。`BOSS_TOOLS` に何も足さず、`web/src/ChatView.tsx` にも手を入れない。別 Issue へ切り出す
- **`work_start` / `work_end`（勤務時間帯ゲート）を当日値で動かす設計を行わない**（決定 3）。参考として実測値を残す: `work_end` を動かすと `isWithinWorkingHours`（`rule-engine.ts:47`）を通じて **5 ルール**（`break_overrun` / `unstarted` / `avoidance` / `silence` / `deadline_overdue`）の当日挙動が同時に変わる
- **曜日別の既定スケジュール（水曜だけ夕会 16:00 等）を作らない**（決定 5）。`settings` の構造変更を伴うため別 Issue
- **当日の会の抑止（スキップ）を作らない**（決定 4）
- **翌日以降の日付を指定できるようにしない**（決定 5）。API のパス形だけ将来に備える
- **ADR 0004 / ADR 0005 / ADR 0007 を書き換えない。** いずれも本仕様は整合の側にあり、改訂を要さない
- **恒常設定の UI（`web/src/SettingsView.tsx`）と設定 API（`server/src/settings/`）に手を入れない**
- **過去日の上書き行を削除するクリーンアップ処理を作らない**

## 実装計画（チケット分解の見通し）

層は 5 つあり、依存は次のとおり（最終分解は `/create-ticket` で行う）。

| 層 | 内容 | 依存 |
|---|---|---|
| A. 保存層 | migration version 9 ＋ `meeting-schedule-repository.ts` | なし |
| B. 純粋関数 | `resolveEffectiveMeetingTimes` / `latestAllowedMeetingTime` / `isAllowedMeetingTime` | なし |
| C. API | `meeting-schedule-routes.ts` ＋ `app.ts` マウント | A, B |
| D. スケジューラ結合 | `buildTickInput` での合成 ＋ `buildMeetingRuleKey` の実効時刻対応 | A, B |
| E. web UI | API クライアント・フック・当日予定セクション ＋ `Dashboard.tsx` 配線 | C |

C と D は A・B が揃えば並列に進められる（触るファイルが重ならない）。E は C の応答形が確定してから。

## 受入基準

### 合成規則と上限（純粋関数・`server/src/meeting-schedule/meeting-schedule.ts`）

- [ ] 上書きが無い種別の実効時刻は、恒常設定の時刻と一致する
- [ ] 上書きがある種別の実効時刻は、上書きの時刻と一致する
- [ ] 一方の種別にだけ上書きがあるとき、他方の種別の実効時刻は恒常設定の時刻のままである
- [ ] `"HH:mm"` 形式でない上書きが保存されているとき、その種別の実効時刻は恒常設定の時刻になる
- [ ] 上限より遅い上書きが保存されているとき、その種別の実効時刻は恒常設定の時刻になる
- [ ] `latestAllowedMeetingTime` は、恒常設定の時刻の 180 分後を返す（例: `"18:00"` → `"21:00"`）
- [ ] `latestAllowedMeetingTime` は、180 分後が 23:59 を超えるとき `"23:59"` を返す（例: `"22:30"`）
- [ ] `isAllowedMeetingTime` は、上限ちょうどの時刻を許可する
- [ ] `isAllowedMeetingTime` は、上限の 1 分後の時刻を拒否する
- [ ] `isAllowedMeetingTime` は、恒常設定より早い時刻を許可する

### rule_key（`server/src/detection/meeting.ts`）

- [ ] `buildMeetingRuleKey` は `{種別}_meeting:{YYYY-MM-DD}@{HH:mm}` 形式の文字列を返す
- [ ] `buildMeetingRuleKey` が返すキーの `HH:mm` 部分は、渡された実効時刻と一致する
- [ ] 同じ日・同じ種別でも、実効時刻が異なれば `buildMeetingRuleKey` の返り値は異なる
- [ ] `buildMeetingRuleKey` が返すキーの日付部分は、ローカル暦日である（真夜中付近で UTC 日付にならない。既存の担保を維持する）

### 発火判定への反映（`server/src/scheduler/scheduler-tick.test.ts`）

- [ ] 恒常設定 18:00・当日の夕会上書きが 21:00 のとき、20:59 の tick で夕会の通知が発火しない
- [ ] 恒常設定 18:00・当日の夕会上書きが 21:00 のとき、21:00 の tick で夕会の通知が発火する
- [ ] 恒常設定 09:00・当日の朝会上書きが 07:00 のとき、07:00 の tick で朝会の通知が発火する
- [ ] 前日の日付の上書き行しか無い日は、恒常設定の時刻で発火する
- [ ] 当日の夕会上書きがあっても、朝会の発火判定は恒常設定の時刻のままである
- [ ] 恒常設定の時刻で発火済みの日に夕会を延期したとき、延期後の初回発火の `escalation_level` が 1 である
- [ ] 恒常設定 `work_end` 18:00・夕会上書き 21:00 のとき、19:00 の tick で無音ルールが発火しない（勤務時間帯ゲートが当日変更の影響を受けない）

### API（`GET/PUT /api/meeting-schedule/:date`）

- [ ] GET は、上書きが無い種別の `time` に恒常設定の時刻を返す
- [ ] GET は、上書きがある種別の `time` に上書きの時刻を返す
- [ ] GET は、上書きの有無によらず `defaultTime` に恒常設定の時刻を返す
- [ ] GET は、実効時刻が恒常設定の時刻と異なる種別の `overridden` に `true` を返す
- [ ] GET は、上書きが無い種別の `overridden` に `false` を返す
- [ ] GET は、上書き行はあるが実効時刻が恒常設定の時刻と一致する種別の `overridden` に `false` を返す
- [ ] PUT で恒常設定と同じ時刻を指定すると、当該種別の上書き行が `meeting_time_overrides` に残らない
- [ ] GET は、`latestAllowedTime` に `latestAllowedMeetingTime(defaultTime)` と同じ値を返す
- [ ] PUT で時刻を指定すると、応答の当該種別の `time` が指定値と一致する
- [ ] PUT で指定した時刻は、その後の GET でも `time` として返る（永続化されている）
- [ ] PUT で `null` を指定すると、応答の当該種別の `overridden` が `false` になる
- [ ] PUT でボディに含めなかった種別の `time` は変化しない
- [ ] 同じ日・同じ種別へ 2 回 PUT しても `meeting_time_overrides` の行数は 1 のままである
- [ ] PUT は、上限より遅い時刻に対し 400 と `code: "delay_limit_exceeded"` を返す
- [ ] 上限より遅い時刻を含む PUT は、同じリクエストの他方の種別も保存しない
- [ ] PUT は、`"HH:mm"` 形式でない時刻に対し 400 と `code: "invalid_time"` を返す
- [ ] PUT は、`morning` / `evening` 以外のキーを含むボディに対し 400 と `code: "invalid_request"` を返す
- [ ] PUT は、`:date` が当日でないとき 400 と `code: "not_today"` を返す
- [ ] GET は、`:date` が当日でないとき 400 と `code: "not_today"` を返す
- [ ] GET は、`:date` が `YYYY-MM-DD` 形式でないとき 400 と `code: "invalid_date"` を返す

### 画面（ダッシュボード）

- [ ] ダッシュボードに今日の朝会の実効時刻が表示される
- [ ] ダッシュボードに今日の夕会の実効時刻が表示される
- [ ] 上書きがある種別には「（既定 {defaultTime} から変更）」の注記が表示される
- [ ] 上書きが無い種別には上記の注記が表示されない
- [ ] 時刻入力の `max` 属性が、当該種別の `latestAllowedTime` と一致する
- [ ] 保存に成功すると、表示される実効時刻が保存した値に変わる
- [ ] 保存に失敗すると `role="alert"` の要素にエラーが表示される
- [ ] 上書きがある種別には「既定に戻す」操作が表示される
- [ ] 上書きが無い種別には「既定に戻す」操作が表示されない
- [ ] 「既定に戻す」を実行すると、表示される実効時刻が恒常設定の時刻に戻る

### 既存契約の保全

- [ ] 当日の上書きがある状態でも、`GET /api/settings` の `morning_meeting_time` / `evening_meeting_time` は恒常設定の値を返す
- [ ] `GET /api/dashboard` の応答スキーマが無改変である
- [ ] `server/src/settings/` 配下が無改変である
- [ ] `web/src/SettingsView.tsx` が無改変である
- [ ] `DetectionInput` の型定義が無改変である
- [ ] `evaluateRules` のシグネチャが無改変である
- [ ] `migrate.ts` の version 1〜8 の内容が無改変である
- [ ] `BOSS_TOOLS` の内容が無改変である
- [ ] `server/src/detection/meeting.test.ts` の `buildMeetingRuleKey` に関する既存 3 件以外の既存テストが、無改変のまま pass する

### 検証方法・品質ゲート

- [ ] 新規テストの固定時刻が `new Date(y, m, d, h, m)` 由来で組まれている（UTC 文字列リテラルで固定しない）
- [ ] `npm run test:tz`（非 UTC タイムゾーンでの追加実行）が pass する
- [ ] `npm run lint` が pass する
- [ ] `npm run typecheck` が pass する
- [ ] `npm test` が pass する
