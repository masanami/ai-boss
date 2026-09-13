# 設定保存のバリデーションエラーの応答の形（#507）

## 概要

設定画面の保存で出る `PUT /api/settings` の 400 のうち、利用者の入力値に対する 4 つの規則（勤務時間の前後関係・必須の文字列・時刻の形式・正の整数）の 5 箇所の応答を変える。英語の生の文言をやめ、「日本語の `error`（どの項目をどう直せばよいか分かる文）＋機械可読な `code`」にする。**保存の可否（どの値を拒否するか）とステータス 400 は変えない。** エラーの伝え方だけを変える。web は変えない。

## 背景・目的

### 課題の性格

設定画面で勤務開始 `22:00`・勤務終了 `02:00` を保存すると、保存は正しく拒否される（#448 S1・PR #488）。しかし保存ボタンの上に `work_start must be earlier than work_end` がそのまま出る（2026-09-13 のデモで観測）。内部のキー名が画面に出ており、どの項目をどう直せばよいかも読み取りにくい。**#477 や #494 と違い、利用者に見えている不具合である。**

### 現状の確証（`62edbe4` 時点の実コード）

**(A) 表示の経路。サーバの `error` が加工されずに画面に出る。**
`settings-routes.ts:131` が `{ error }` を 400 で返す。`web/src/settings-api.ts:8` の `toErrorMessage` が `body.error` を `Error` に載せる。`web/src/use-settings.ts:59` がそれを `saveError` に入れ、`web/src/SettingsView.tsx:352` の `<p role="alert">{saveError}</p>` が表示する。web はこの経路で `code` を読まない。

**(B) settings の 400 の文言と、画面の通常操作から届くかどうか。**
web は常にフォーム全体（17 キー）を送る（`SettingsView.tsx:65` の `saveSettings(form)`、`web/src/settings.ts:65`）。

| 文言（行） | 対象キー | 画面から届くか | 根拠 | 本件の対象 |
|---|---|---|---|---|
| `${key} must be a non-empty string`（`settings-validation.ts:64`） | `boss_name` / `model` | **届く** | `<input>` に `required` が無い（`SettingsView.tsx:100-105` / `:326-331`）。欄を空（空白のみを含む）にして保存すると、そのまま送られる | 対象 |
| `boss_tone_preset must be one of: …`（`:76`） | `boss_tone_preset` | 届かない | `<select>` の選択肢は `TONE_PRESETS` だけ（`:109-123`） | 対象外 |
| `boss_strictness must be an integer between …`（`:90`） | `boss_strictness` | 届かない | `<select>` の選択肢を `Number()` で読む（`:127-141`） | 対象外 |
| `boss_custom_instructions must be a string or null`（`:106`） | `boss_custom_instructions` | 届かない | `<textarea>` は常に文字列を返す（`:145-153`） | 対象外 |
| `${key} must be in "HH:mm" format`（`:114`） | `work_start` / `work_end` / `morning_meeting_time` / `evening_meeting_time` | **届く（時刻を消したとき）** | `type="time"` に `required` が無い（`:161-170` / `:174-183` / `:208-214` / `:218-224`）。時刻を消すと `value` が `""` になり、そのまま送られて `TIME_PATTERN`（`detection-types.ts:77`）で落ちる | 対象 |
| `${key} must be a positive integer`（`:123`） | 検知閾値 6 キー | 届かない（推論） | `type="number" min={1}` で、`<form>` に `noValidate` が無い（`:92`・`:232-318`）。送信時にブラウザの制約検証が走り、0・負数・小数で送信が止まるはずである。欄を空にすると `Number("")` が 0 になり、React DOM 18.3.1 が表示値を `"0"` に書き戻す（`node_modules/react-dom/cjs/react-dom.development.js:1831`） | **対象**（**推論・実ブラウザ未確認のため対象に含めた**。決定 2） |
| `${key} must be a boolean`（`:143`） | 真偽値 2 キー | 届かない | `type="checkbox"` の `checked` を送る（`:191-200` / `:339-348`） | 対象外 |
| `request body must be a JSON object`（`:245`） | — | 届かない | `JSON.stringify(form)` を送る（`settings-api.ts:36`） | 対象外 |
| `unrecognized setting key: ${key}`（`:252`） | — | 届かない | フォームは GET の応答を展開して作る（`SettingsView.tsx:40-45`）。GET のキーは `SETTINGS_KEYS` と一致する（`settings-routes.ts:31-49`） | 対象外 |
| `work_start must be earlier than work_end`（`:272`・全量更新） | `work_start` + `work_end` | **届く** | web は 2 キーを常に一緒に送る | 対象 |
| `work_start must be earlier than work_end`（`settings-routes.ts:145`・部分更新） | 同上 | 届かない（同じ規則） | 2 キーが一緒に送られると `:272` が先に弾く。通った組なら `:143` が patch の値どうしを比べるので、`:144` は偽にならない。片方だけを送る API の直叩きでしか届かない | 対象（`:272` と同じ事実。決定 2） |

`type="time"` を消したときの挙動と、ブラウザの制約検証は、HTML 仕様と React DOM のソースから導いた。**実ブラウザでは未確認**（Playwright は未導入）。

**(C) 既存テストが英語のキー名を文言として照合している箇所。**
次の 12 アサーションが `expect(…error).toContain("work_start")` と `toContain("work_end")` を持つ。**エラー文からキー名を消すとこれらは落ちる。**

- `settings-validation.test.ts:388-389`（テスト名 `error message identifies the work_start/work_end relationship as invalid (AC-2)`）
- `settings-routes.test.ts:608-609` / `:688-689` / `:726-727` / `:800-801` / `:835-836`

そのほかの 400 のテストは、ステータスか `valid === false` か `typeof body.error === "string"` までしか見ていない（例: `settings-routes.test.ts:256` / `:274` / `:288`）。`settings-validation.test.ts:48` の `toContain("not_a_real_key")` は、対象外の未知キーの文言を照合している。
web のテストにある英語文言（`settings-api.test.ts:99` / `:105`、`use-settings.test.ts:98` / `:112`、`SettingsView.test.tsx:300` / `:317`）は、どれも `fetch` のモックに置いたフィクスチャで、サーバの契約には依存していない。

**(D) エラー応答の形には先例が 2 系統ある。**

- **サーバが日本語の `error` ＋ `code` を持つ**: `chat-messages-route.ts`（`session_already_ended` / `message_not_editable` / `mentoring_task_not_found` / `session_not_found`。#477・#494）、`reports-routes.ts:74`（`evening_session_required`）、`tasks-routes.ts:19-20` / `:63`（`evidence_required`）
- **サーバは英語の `error` ＋ `code` を返し、web が `code` から日本語を引く**: `task-evidences-routes.ts:58` / `:81` / `:89` / `:129` / `:188` と `web/src/tasks-api.ts:59-87`（`ERROR_MESSAGE_BY_CODE` / `describeTasksApiError`。`completion-evidence-enforcement.md` の導出決定 2-g）。**利用者が入力した値（ファイル形式・サイズ・URL スキーム）の検証エラー**で、この系統を採った先例である
- UI から届かない 400（`sessions-validation.ts`）は、#477・#494 とも「開発者向けの契約違反エラー」として英語のまま残した（`chat-route-error-response-shape.md:140`、`session-not-found-response-shape.md:190`）

**(E) #448 の仕様との関係。**
`working-hours-intervals.md:78` は「エラー応答は既存の `{ error }` 形式に揃える。設定 API は `code` を持たない」と書いている。同仕様の受入基準（「`{ error }` 形式であり、`work_start` / `work_end` の関係が不正であると分かるメッセージを含む」）は、文言そのものを固定していない。本件は `:78` の「`code` を持たない」を**意図的に上書きする**（#448 S1 の時点で既存の作法に合わせた方針であり、恒久的な契約ではない）。同仕様の該当行に、本仕様への参照の注記を置いた。

**(F) 保存が 400 以外の理由で失敗したときも英語が出る（本件の範囲外）。**
サーバが止まっていれば、`fetch` の `TypeError` の `message`（Chrome では `Failed to fetch`）が `use-settings.ts:59-61` を通って出る。JSON でない 500 なら、`settings-api.ts:10` の `request failed with status 500` が出る。同じ代替文言は web の API クライアント 8 ファイルにある（`settings-api.ts`・`checkins-api.ts`・`tasks-api.ts`・`work-logs-api.ts`・`decisions-api.ts`・`chat-api.ts`・`daily-reports-api.ts`・`dashboard-api.ts`）。

### 目的

- 設定画面から届く保存拒否の理由を、**どの項目をどう直せばよいか分かる日本語**で表示する
- 応答に機械可読な `code` を足し、#495・#501 と同じ `{ error, code }` の形にそろえる
- 変えた応答をテストが文言と `code` まで照合し、**変異で落ちること**を確認する

## ユーザーストーリー

**ai-boss の利用者**として、設定の保存が拒否されたときに、どの項目をどう直せばよいかを日本語で知りたい。そうすれば、内部のキー名や英語の文を読み解かずに設定を直せる。

## 機能要件

- [ ] 勤務時間の前後関係で拒否する 400（全量更新 `settings-validation.ts:272`・部分更新 `settings-routes.ts:145`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `boss_name` の空欄を拒否する 400（`:64`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `model` の空欄を拒否する 400（`:64`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `work_start` の時刻の形式で拒否する 400（`:114`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `work_end` の時刻の形式で拒否する 400（`:114`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `morning_meeting_time` の時刻の形式で拒否する 400（`:114`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `evening_meeting_time` の時刻の形式で拒否する 400（`:114`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `detection_unstarted_fallback_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `detection_silence_fallback_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `detection_break_fallback_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `escalation_l2_after_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `escalation_l3_after_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] `escalation_repeat_minutes` の正の整数で拒否する 400（`:123`）が、決定 3 の日本語の `error` と `code` を返す
- [ ] 上記の拒否で、保存の可否とステータス 400 は変更前と同じである（規則ごとの非回帰は受入基準の各節で個別に確かめる）

## 技術的な制約・方針

- **保存の可否は変えない**: どの値を拒否するか（`VALIDATORS` の判定・`isValidWorkingHoursRange`・`resolveEffectiveWorkingHours`）と、ステータス 400 は変えない。短絡評価（最初に見つかった不正なキーのエラーだけを返す。`settings-validation.ts:233-240`）も変えない
- **変更対象**: `server/src/settings/settings-validation.ts`・`server/src/settings/settings-routes.ts` と、それぞれのテスト（`settings-validation.test.ts`・`settings-routes.test.ts`）。**web は 1 行も変更しない**（決定 1）
- **キー→日本語ラベルの対応表はサーバ側の 1 箇所に置く**（決定 4）。置き場所と命名は実装者が決める
- **既存テストの書き換え（受入基準の変更）**: 確証 (C) の 12 アサーション（キー名 `work_start` / `work_end` を含むことの照合）は、決定 3 の文言の完全一致に置き換える。これは #448 の受入基準を守っていたテスト（テスト名 `…(AC-2)`）の照合を**意図的に変える**ものである（確証 (E)）
- **対象外の文言は変えない**: `settings-validation.ts:76` / `:90` / `:106` / `:143` / `:245` / `:252` の `error` は変更前の英語のままとし、`code` も付けない（決定 2）
- **DB スキーマ変更・マイグレーションは無い**
- 外部送信は Claude API への推論リクエストだけ（ADR 0001）。本件は送る内容を変えない
- 本件は日付境界に触らないので、`npm run test:tz` は必須ゲートではない。品質ゲートは `npm run lint` / `npm run typecheck` / `npm test` を**それぞれ単一コマンドで**実行して判定する

## 画面・API設計

### API（`PUT /api/settings`）

次の 400 の応答の形だけを変える。ステータス 400 は変えない。

```jsonc
// 変更前
{ "error": "work_start must be earlier than work_end" }
{ "error": "boss_name must be a non-empty string" }
{ "error": "work_start must be in \"HH:mm\" format" }
{ "error": "escalation_repeat_minutes must be a positive integer" }

// 変更後
{ "error": "勤務開始は勤務終了より前の時刻にしてください", "code": "invalid_working_hours" }
{ "error": "ボスの名前を入力してください", "code": "setting_required" }
{ "error": "勤務開始の時刻を 09:00 の形式で入力してください", "code": "invalid_time" }
{ "error": "エスカレーション: 再通知間隔（分）には 1 以上の整数を入力してください", "code": "invalid_positive_integer" }
```

| 規則（行） | キー | `code` | `error` |
|---|---|---|---|
| 勤務時間の前後関係（`:272`・`settings-routes.ts:145`） | `work_start` + `work_end` | `invalid_working_hours` | 勤務開始は勤務終了より前の時刻にしてください |
| 必須の文字列（`:64`） | `boss_name` | `setting_required` | ボスの名前を入力してください |
| 必須の文字列（`:64`） | `model` | `setting_required` | モデルを入力してください |
| 時刻の形式（`:114`） | `work_start` | `invalid_time` | 勤務開始の時刻を 09:00 の形式で入力してください |
| 時刻の形式（`:114`） | `work_end` | `invalid_time` | 勤務終了の時刻を 09:00 の形式で入力してください |
| 時刻の形式（`:114`） | `morning_meeting_time` | `invalid_time` | 朝会の時刻を 09:00 の形式で入力してください |
| 時刻の形式（`:114`） | `evening_meeting_time` | `invalid_time` | 夕会の時刻を 09:00 の形式で入力してください |
| 正の整数（`:123`） | `detection_unstarted_fallback_minutes` | `invalid_positive_integer` | 未着手のフォールバック（分）には 1 以上の整数を入力してください |
| 正の整数（`:123`） | `detection_silence_fallback_minutes` | `invalid_positive_integer` | 無音のフォールバック（分）には 1 以上の整数を入力してください |
| 正の整数（`:123`） | `detection_break_fallback_minutes` | `invalid_positive_integer` | 休憩のフォールバック（分）には 1 以上の整数を入力してください |
| 正の整数（`:123`） | `escalation_l2_after_minutes` | `invalid_positive_integer` | エスカレーション: レベル2まで（分）には 1 以上の整数を入力してください |
| 正の整数（`:123`） | `escalation_l3_after_minutes` | `invalid_positive_integer` | エスカレーション: レベル3まで（分）には 1 以上の整数を入力してください |
| 正の整数（`:123`） | `escalation_repeat_minutes` | `invalid_positive_integer` | エスカレーション: 再通知間隔（分）には 1 以上の整数を入力してください |

`SettingsPatch` の型と成功応答（200 の実効値）は変えない。

### 画面

変更しない。確証 (A) の経路が、上記の `error` をそのまま `role="alert"` に表示する。

## クリティカル設計決定

> 本節は意思決定者が確定した決定であり、実装者が独自判断で逸脱しない。

### 1. サーバが日本語の `error` ＋ `code` を返し、web は変えない

- **採用案**: 対象の 400 を、サーバが日本語の `error` と `code` を持つ形にする。web は変更しない
- **理由**: 確証 (A) の経路がそのまま表示するので、変更はサーバ 2 ファイルとそのテストで済む。#495・#501 と同じ形になる。API の利用者はローカル単一ユーザーの web だけである
- **代替案**:
  - (b) サーバは英語のまま `code` を足し、web が `code` から日本語を引く — 却下。利用者の入力値の検証エラーで、この系統を採った先例はある（確証 (D) のエビデンス系、`tasks-api.ts:59-87`）。確証 (C) のテストを書き換えずに済む利点もある。しかし web に `code` を保持するエラークラスと引き当て表が要る。さらに、どの項目のエラーかを web が知るには、キーごとの `code` か応答への `key` の追加が要り、`{ error, code }` の形から外れる
  - (c) 勤務時間の前後関係だけを日本語にする — 却下。確証 (B) で画面から届く空欄と、時刻を消したときのエラーが英語のまま残る
- **影響範囲**: `settings-validation.ts`・`settings-routes.ts` と両テスト。確証 (C) の 12 アサーションを書き換える

### 2. 対象は 5 箇所（`:272`・`settings-routes.ts:145`・`:64`・`:114`・`:123`）

- **採用案**: 確証 (B) で画面から届く `:64`・`:114`・`:272` に、同じ規則の `settings-routes.ts:145` と、正の整数の `:123` を加える。それ以外の 400（`:76`・`:90`・`:106`・`:143`・`:245`・`:252`）は、開発者向けの契約違反エラーとして英語のまま残す
- **理由**:
  - `:145` は画面から届かないが、`:272` と同じ事実である。そろえないと入口によって文言が変わる（#494 決定 1 と同じ理由）
  - `:123` を画面から届かないとする根拠は、HTML 仕様と React ソースからの推論で、実ブラウザでは確かめていない。含める費用は小さく、推論が外れたときに英語が残る事態を避ける
  - 残す 400 は、UI の入口（選択肢・チェックボックス・`JSON.stringify`・GET と同じキー）が送る値を塞いでいる。#477・#494 が `sessions-validation.ts` の 400 を残した判断と同じである
- **代替案**:
  - `:123` を含めない — 却下（上記。推論が外れる可能性）
  - settings の 400 をすべて対象にする — 却下。未知キー（`:252`）のようにキー名を含む英語が失われ、API を直接叩いたときに原因を追いにくくなる
- **影響範囲**: 上記 5 箇所と、その照合テスト

### 3. `code` は規則の単位で名付け、文言は項目名と直し方を書く

- **採用案**: 「画面・API設計」の表のとおり。`code` は規則ごとに 1 つとし（`invalid_date` / `invalid_request` と同じ形）、項目名を含めない。`error` は項目名と直し方を書く指示の形にする
- **理由**:
  - web は `code` で分岐しない。どの項目かは文言が伝える。直し方が分かることが #507 の要件である。回復の手がかりを書かない短い形を採った #477 決定 3 は、404（資源の不在）が対象だった
  - 勤務時間の文言に「日をまたぐ勤務時間は設定できません」を付けない。#448 の未決の論点 1 で将来日またぎを許しうるので、規則を変えたときに文言が嘘にならない形にする
  - 時刻の文言は「09:00 の形式で入力してください」とする。画面から届く空欄にも、API を直接叩いた `"9:00"` にも正確である
- **代替案**:
  - キーごとの `code`（例 `boss_name_required`）— 却下（web は分岐せず、`code` の数だけが増える）
  - 時刻を「〜の時刻を入力してください」とする — 却下（`"9:00"` のような形式違反に不正確）
  - 勤務時間の文言に日またぎの括弧書きを付ける — 却下（上記）
- **影響範囲**: 上記 5 箇所と、その照合テスト

### 4. キー→日本語ラベルの対応表をサーバ側 1 箇所に置く

- **採用案**: サーバが画面のラベルを複製して持つことを受け入れる。キーから日本語ラベルへの対応表を、サーバ側の 1 箇所にまとめる。ラベルは `SettingsView.tsx` の該当 `<label>` に合わせる（時刻は「勤務開始／勤務終了／朝会／夕会」）
- **理由**: 決定 1 で web を変えないため、項目名はサーバが持つしかない。散らばると同期の漏れが増える
- **ラベルの同期**: ラベルが画面と一致することを照合するテストは求めない。複製の同期は `/demo` での確認項目にする
- **代替案**: 対応表を置かず、各バリデータに文言を直書きする — 却下（`:64`・`:114`・`:123` はキーを引数に取る共通関数であり、キーごとの文言を 1 箇所から引くほうが素直である）
- **影響範囲**: `server/src/settings/` 配下（置き場所・命名は実装者が決める）

### 5. 担保はサーバ応答の完全一致と変異で証明する

- **採用案**: 受入基準は、サーバ応答の `error`・`code` の完全一致で書く。モックに日本語を置く web テストは足さない。実画面の確認は `/demo` で行う。各照合は、次の変異で落ちることを確認する
  - 変異 (a): その箇所の応答から `code` だけを取り除く（`error` は変更後のまま）
  - 変異 (b): その箇所の `error` だけを変更前の英語に戻す（`code` は付けたまま）
  - `:272` と `settings-routes.ts:145` は同じ文言を返す。**`:145` 側だけに変異を加えたとき、部分更新のテストが落ち、全量更新のテストは落ちない**ことを確認する。逆向き（`:272` 側だけ）も確認する
- **理由**:
  - モックに置いた日本語がそのまま出ることを確かめる web テストは、恒真になる（`MEMORY` の教訓「AC 担保は変異で証明する」）。表示経路の非回帰は、既存の `SettingsView.test.tsx:293-321` が守っている
  - `code` と `error` は独立に変えられるので、片方だけを崩す変異で、それぞれの照合が効いていることを示す（#477 決定 5・#494 決定 5 と同じ規律）
- **変異の手順**: 変異は本番コードに一時的に加える。**適用後に `git diff` で変異が意図した 1 箇所に限られることを確かめ、確認が済んだら `git checkout -- <変異したファイル>` で確実に戻す**（戻し漏れのまま次の変異・変更へ進まない）。変異はコミットしない
- **変異結果の記録先**: 変異の内容（箇所 × (a)/(b)）・落ちたテスト・落ちなかったテストを PR 本文に書く。変異はコミットされないので、これが受入基準を満たした唯一の証跡になる
- **影響範囲**: `settings-validation.test.ts`・`settings-routes.test.ts` の該当テスト

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | settings の 400 の 5 箇所（勤務時間の前後関係〔全量・部分更新〕・`boss_name` / `model` の空欄・時刻 4 キーの形式・検知閾値 6 キーの正の整数）を日本語の `error` ＋ `code` にする。テストを文言と `code` の完全一致に締め、変異で確認する | 4-5 | これだけで、画面から届く保存拒否の理由がすべて日本語で表示される |

実装対象: S1

> 本仕様のスライスは S1 で閉じる（後続スライスは無い）。

## やらないこと

- **保存の可否の規則の変更**（どの値を拒否するか・日またぎの許可を含む）（理由: Issue #507 のスコープ。日またぎは `working-hours-intervals.md` の未決の論点 1）
- **画面から届かない settings の 400 の変更**（`settings-validation.ts:76` / `:90` / `:106` / `:143` / `:245` / `:252`）（理由: 決定 2）
- **保存が 400 以外の理由で失敗したときの英語の代替文言の日本語化**（`Failed to fetch`・`request failed with status N`）（理由: 確証 (F) のとおり、web の API クライアント 8 ファイルに共通する資源横断の論点である。別 Issue の候補とする）
- **web の変更**（`settings-api.ts` / `use-settings.ts` / `SettingsView.tsx` とそのテストのフィクスチャ）（理由: 決定 1）
- **サーバのラベルが画面のラベルと一致することを照合するテストの追加**（理由: 決定 4。`/demo` で確認する）
- **設定画面へのクライアント側検証・`required` 属性の追加、エラー表示の位置の変更**（理由: 入力 UI とレイアウトは Issue #507 のスコープ外。`working-hours-intervals.md` 決定 5 の方針も維持する）
- **settings 以外の資源の 400 の変更**（理由: Issue #507 は設定保存に限る）

## 受入基準

### 勤務時間の前後関係

- [ ] `PUT /api/settings` に `work_start` と `work_end` を一緒に送り、組が `work_start >= work_end`（`22:00` / `02:00`、`09:00` / `09:00`）になるリクエストは、400 で拒否される（非回帰）
- [ ] 上記の拒否で、`work_start` と `work_end` のどちらも保存されない（非回帰）
- [ ] 上記の 400 の応答の `error` が `"勤務開始は勤務終了より前の時刻にしてください"` である
- [ ] 上記の 400 の応答の `code` が `"invalid_working_hours"` である
- [ ] `work_start` だけを送り、保存済みまたは既定の `work_end` との組が `work_start >= work_end` になる部分更新は、400 で拒否される（非回帰）
- [ ] その部分更新の 400 の応答の `error` が `"勤務開始は勤務終了より前の時刻にしてください"` である
- [ ] その部分更新の 400 の応答の `code` が `"invalid_working_hours"` である

### 必須の文字列（空欄）

- [ ] `boss_name` に `""` または `"   "` を送るリクエストの 400 の応答の `error` が `"ボスの名前を入力してください"` である
- [ ] `boss_name` に `""` または `"   "` を送るリクエストの 400 の応答の `code` が `"setting_required"` である
- [ ] `model` に `""` または `"   "` を送るリクエストの 400 の応答の `error` が `"モデルを入力してください"` である
- [ ] `model` に `""` または `"   "` を送るリクエストの 400 の応答の `code` が `"setting_required"` である

### 時刻の形式

- [ ] `work_start` に `""` または `"9:00"` を送るリクエストの 400 の応答の `error` が `"勤務開始の時刻を 09:00 の形式で入力してください"` である
- [ ] `work_start` に `""` または `"9:00"` を送るリクエストの 400 の応答の `code` が `"invalid_time"` である
- [ ] `work_end` に `""` または `"9:00"` を送るリクエストの 400 の応答の `error` が `"勤務終了の時刻を 09:00 の形式で入力してください"` である
- [ ] `work_end` に `""` または `"9:00"` を送るリクエストの 400 の応答の `code` が `"invalid_time"` である
- [ ] `morning_meeting_time` に `""` または `"9:00"` を送るリクエストの 400 の応答の `error` が `"朝会の時刻を 09:00 の形式で入力してください"` である
- [ ] `morning_meeting_time` に `""` または `"9:00"` を送るリクエストの 400 の応答の `code` が `"invalid_time"` である
- [ ] `evening_meeting_time` に `""` または `"9:00"` を送るリクエストの 400 の応答の `error` が `"夕会の時刻を 09:00 の形式で入力してください"` である
- [ ] `evening_meeting_time` に `""` または `"9:00"` を送るリクエストの 400 の応答の `code` が `"invalid_time"` である

### 正の整数

- [ ] `detection_unstarted_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"未着手のフォールバック（分）には 1 以上の整数を入力してください"` である
- [ ] `detection_unstarted_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である
- [ ] `detection_silence_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"無音のフォールバック（分）には 1 以上の整数を入力してください"` である
- [ ] `detection_silence_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である
- [ ] `detection_break_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"休憩のフォールバック（分）には 1 以上の整数を入力してください"` である
- [ ] `detection_break_fallback_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である
- [ ] `escalation_l2_after_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"エスカレーション: レベル2まで（分）には 1 以上の整数を入力してください"` である
- [ ] `escalation_l2_after_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である
- [ ] `escalation_l3_after_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"エスカレーション: レベル3まで（分）には 1 以上の整数を入力してください"` である
- [ ] `escalation_l3_after_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である
- [ ] `escalation_repeat_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `error` が `"エスカレーション: 再通知間隔（分）には 1 以上の整数を入力してください"` である
- [ ] `escalation_repeat_minutes` に `0`・`-5`・`1.5` のいずれかを送るリクエストの 400 の応答の `code` が `"invalid_positive_integer"` である

### テストの締まり（変異）

- [ ] 全量更新の前後関係（`settings-validation.ts:272`）の応答から `code` だけを取り除く変異を加えると、全量更新の前後関係のテストが落ち、部分更新の前後関係のテストは落ちない
- [ ] 全量更新の前後関係（`settings-validation.ts:272`）の `error` だけを変更前の英語に戻す変異を加えると、全量更新の前後関係のテストが落ち、部分更新の前後関係のテストは落ちない
- [ ] 部分更新の前後関係（`settings-routes.ts:145`）の応答から `code` だけを取り除く変異を加えると、部分更新の前後関係のテストが落ち、全量更新の前後関係のテストは落ちない
- [ ] 部分更新の前後関係（`settings-routes.ts:145`）の `error` だけを変更前の英語に戻す変異を加えると、部分更新の前後関係のテストが落ち、全量更新の前後関係のテストは落ちない
- [ ] 空欄の検証（`:64`）から `code` だけを取り除く変異を加えると、`boss_name` の空欄のテストが落ちる
- [ ] 空欄の検証（`:64`）から `code` だけを取り除く変異を加えると、`model` の空欄のテストが落ちる
- [ ] 空欄の検証（`:64`）の `error` だけを変更前の英語に戻す変異を加えると、`boss_name` の空欄のテストが落ちる
- [ ] 空欄の検証（`:64`）の `error` だけを変更前の英語に戻す変異を加えると、`model` の空欄のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）から `code` だけを取り除く変異を加えると、`work_start` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）から `code` だけを取り除く変異を加えると、`work_end` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）から `code` だけを取り除く変異を加えると、`morning_meeting_time` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）から `code` だけを取り除く変異を加えると、`evening_meeting_time` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）の `error` だけを変更前の英語に戻す変異を加えると、`work_start` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）の `error` だけを変更前の英語に戻す変異を加えると、`work_end` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）の `error` だけを変更前の英語に戻す変異を加えると、`morning_meeting_time` の形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）の `error` だけを変更前の英語に戻す変異を加えると、`evening_meeting_time` の形式のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`detection_unstarted_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`detection_silence_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`detection_break_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`escalation_l2_after_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`escalation_l3_after_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）から `code` だけを取り除く変異を加えると、`escalation_repeat_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`detection_unstarted_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`detection_silence_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`detection_break_fallback_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`escalation_l2_after_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`escalation_l3_after_minutes` の正の整数のテストが落ちる
- [ ] 正の整数の検証（`:123`）の `error` だけを変更前の英語に戻す変異を加えると、`escalation_repeat_minutes` の正の整数のテストが落ちる
- [ ] 上記の変異確認の結果（変異の内容・落ちたテスト・落ちなかったテスト）が PR 本文に書かれている

### 品質ゲート

- [ ] `npm run lint` が pass する
- [ ] `npm run typecheck` が pass する
- [ ] `npm test` が pass する
