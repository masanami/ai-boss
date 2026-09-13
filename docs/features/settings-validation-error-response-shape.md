# 設定保存のバリデーションエラーの応答の形（#507）

> **ドラフト（親の回答待ち）**。「クリティカル設計決定」節の各決定は**推奨案を暫定で書いたもの**であり、まだ確定していない。機能要件・画面・API設計・スライス・受入基準も暫定の推奨案に基づいて起草している。回答を受けて確定・書き直す。仕様クリティーク（`/define-feature` Step 6.5）は決定の確定後に実施する。

## 概要

設定画面の保存で、利用者が通常の操作でたどり着く `PUT /api/settings` の 400 を、英語の生の文言から「日本語の `error`（直し方が分かる文）＋機械可読な `code`」に変える。**保存の可否（どの値を拒否するか）は変えない。** エラーの伝え方だけを変える。

## 背景・目的

### 課題の性格

設定画面で勤務開始 `22:00`・勤務終了 `02:00` を保存すると、保存は正しく拒否される（#448 S1・PR #488）。しかし保存ボタンの上に `work_start must be earlier than work_end` がそのまま出る（2026-09-13 のデモで観測）。内部のキー名が画面に出ており、どの項目をどう直せばよいかも読み取りにくい。**#477 や #494 と違い、利用者に見えている不具合である。**

### 現状の確証（`62edbe4` 時点の実コード）

**(A) 表示の経路。サーバの `error` が加工されずに画面に出る。**
`settings-routes.ts:131` が `{ error }` を 400 で返す。`web/src/settings-api.ts:8` の `toErrorMessage` が `body.error` を `Error` に載せる。`web/src/use-settings.ts:59` がそれを `saveError` に入れ、`web/src/SettingsView.tsx:352` の `<p role="alert">{saveError}</p>` が表示する。web はこの経路で `code` を読まない。

**(B) settings の 400 の文言と、画面の通常操作から届くかどうか。**
web は常にフォーム全体（17 キー）を送る（`SettingsView.tsx:65` の `saveSettings(form)`、`web/src/settings.ts:65`）。

| 文言（行） | 対象キー | 画面から届くか | 根拠 |
|---|---|---|---|
| `${key} must be a non-empty string`（`settings-validation.ts:64`） | `boss_name` / `model` | **届く** | `<input>` に `required` が無い（`SettingsView.tsx:100-105` / `:326-331`）。欄を空（空白のみを含む）にして保存すると `""` が送られる |
| `boss_tone_preset must be one of: …`（`:76`） | `boss_tone_preset` | 届かない | `<select>` の選択肢は `TONE_PRESETS` だけ（`:109-123`） |
| `boss_strictness must be an integer between …`（`:90`） | `boss_strictness` | 届かない | `<select>` の選択肢を `Number()` で読む（`:127-141`） |
| `boss_custom_instructions must be a string or null`（`:106`） | `boss_custom_instructions` | 届かない | `<textarea>` は常に文字列を返す（`:145-153`） |
| `${key} must be in "HH:mm" format`（`:114`） | `work_start` / `work_end` / `morning_meeting_time` / `evening_meeting_time` | **届く（時刻を消したとき）** | `type="time"` に `required` が無い（`:161-170` / `:174-183` / `:208-214` / `:218-224`）。時刻を消すと `value` が `""` になり、そのまま送られて `TIME_PATTERN`（`detection-types.ts:77`）で落ちる。`step` の指定が無いので、入力済みなら値は常に `HH:mm` になる |
| `${key} must be a positive integer`（`:123`） | 検知閾値 6 キー | **届かない** | `type="number" min={1}` で、`<form>` に `noValidate` が無い（`:92`・`:232-318`）。送信ボタンで送るとブラウザの制約検証が走り、0・負数（`rangeUnderflow`）と小数（`stepMismatch`。既定の step は 1、基準値は `min`）で送信が止まる。欄を空にすると `Number("")` が 0 になり、React DOM 18.3.1 が表示値を `"0"` に書き戻す（`node_modules/react-dom/cjs/react-dom.development.js:1831`）ので、やはり制約検証で止まる |
| `${key} must be a boolean`（`:143`） | 真偽値 2 キー | 届かない | `type="checkbox"` の `checked` を送る（`:191-200` / `:339-348`） |
| `request body must be a JSON object`（`:245`） | — | 届かない | `JSON.stringify(form)` を送る（`settings-api.ts:36`） |
| `unrecognized setting key: ${key}`（`:252`） | — | 届かない | フォームは GET の応答を展開して作る（`SettingsView.tsx:40-45`）。GET のキーは `SETTINGS_KEYS` と一致する（`settings-routes.ts:31-49`） |
| `work_start must be earlier than work_end`（`:272`・全量更新） | `work_start` + `work_end` | **届く** | web は 2 キーを常に一緒に送る |
| `work_start must be earlier than work_end`（`settings-routes.ts:145`・部分更新） | 同上 | 届かない（同じ規則） | 2 キーが一緒に送られると `:272` が先に弾き、通った組なら `:143` が patch の値どうしを比べるので `:144` は偽にならない。片方だけを送る API の直叩きでしか届かない |

ブラウザの制約検証と `type="time"` を消したときの挙動は、HTML 仕様と React DOM のソースから導いた。**実ブラウザでは未確認**（Playwright は未導入）。

**(C) 既存テストが英語のキー名を文言として照合している箇所。**
`settings-validation.test.ts:388-389`（テスト名 `error message identifies the work_start/work_end relationship as invalid (AC-2)`）と、`settings-routes.test.ts` の `:608-609` / `:688-689` / `:726-727` / `:800-801` / `:835-836` が、`expect(…error).toContain("work_start")` と `toContain("work_end")` を持つ（6 テスト・12 アサーション）。**エラー文からキー名を消すとこれらは落ちる。** そのほかの 400 のテストは、ステータスか `valid === false` か `typeof body.error === "string"` までしか見ていない（例: `settings-routes.test.ts:256` / `:274` / `:288`）。`settings-validation.test.ts:48` の `toContain("not_a_real_key")` は未知キーの文言を照合している。
web のテストにある英語文言（`settings-api.test.ts:99` / `:105`、`use-settings.test.ts:98` / `:112`、`SettingsView.test.tsx:300` / `:317`）は、どれも `fetch` のモックに置いたフィクスチャで、サーバの契約には依存していない。

**(D) エラー応答の形には先例が 2 系統ある。**

- **サーバが日本語の `error` ＋ `code` を持つ**: `chat-messages-route.ts`（`session_already_ended` / `message_not_editable` / `mentoring_task_not_found` / `session_not_found`。#477・#494）、`reports-routes.ts:74`（`evening_session_required`）、`tasks-routes.ts:19-20` / `:63`（`evidence_required`）
- **サーバは英語の `error` ＋ `code` を返し、web が `code` から日本語を引く**: `task-evidences-routes.ts:58` / `:81` / `:89` / `:129` / `:188` と `web/src/tasks-api.ts:59-87`（`ERROR_MESSAGE_BY_CODE` / `describeTasksApiError`。`completion-evidence-enforcement.md` の導出決定 2-g）。**利用者が入力した値（ファイル形式・サイズ・URL スキーム）の検証エラー**で、この系統を採った先例である
- `code` による UI の分岐は ADR 0008 決定 2 の規律である。一方、UI から届かない 400（`sessions-validation.ts`）は、#477・#494 とも「開発者向けの契約違反エラー」として英語のまま残した（`chat-route-error-response-shape.md:140`、`session-not-found-response-shape.md:190`）

**(E) #448 の仕様との関係。**
`working-hours-intervals.md:78` は「エラー応答は既存の `{ error }` 形式に揃える。設定 API は `code` を持たない」と書いている。受入基準 `:183` は「`{ error }` 形式であり、`work_start` / `work_end` の関係が不正であると分かるメッセージを含む」で、**文言そのものは固定していない**。本件は `:78` の「`code` を持たない」を**意図的に上書きする**（#448 S1 の時点で既存の作法に合わせた方針であり、恒久的な契約ではない）。

**(F) 保存が 400 以外の理由で失敗したときも英語が出る（本件の範囲外）。**
サーバが止まっていれば `fetch` の `TypeError` の `message`（Chrome では `Failed to fetch`）が `use-settings.ts:59-61` を通って出る。JSON でない 500 なら `settings-api.ts:10` の `request failed with status 500` が出る。同じ代替文言は web の API クライアント 8 ファイルにある（`settings-api.ts:8` / `:10`、`checkins-api.ts:9` / `:11`、`tasks-api.ts:29` / `:34`、`work-logs-api.ts:26` / `:31`、`decisions-api.ts:8` / `:10`、`chat-api.ts:34` / `:39`、`daily-reports-api.ts:28` / `:33`、`dashboard-api.ts:8` / `:10`）。

### 目的

- 設定画面から届く保存拒否の理由を、**どの項目をどう直せばよいか分かる日本語**で表示する
- 応答に機械可読な `code` を足し、#495・#501 と同じ形にそろえる
- 変えた応答をテストが文言と `code` まで照合し、**変異で落ちること**を確認する

## ユーザーストーリー

**ai-boss の利用者**として、設定の保存が拒否されたときに、どの項目をどう直せばよいかを日本語で知りたい。そうすれば、内部のキー名や英語の文を読み解かずに設定を直せる。

## 機能要件（暫定: 決定 1〜3 の推奨案に基づく）

- [ ] `work_start` と `work_end` を一緒に送り、`work_start >= work_end` で拒否する 400（`settings-validation.ts:272`）の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] 部分更新で `work_start >= work_end` になって拒否する 400（`settings-routes.ts:145`）の `error` が、全量更新と同じ日本語文言である
- [ ] 同じ 400 が全量更新と同じ `code` を持つ
- [ ] `boss_name` の空文字（空白のみを含む）を拒否する 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] `model` の空文字（空白のみを含む）を拒否する 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] `work_start` の時刻の形式エラーを返す 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] `work_end` の時刻の形式エラーを返す 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] `morning_meeting_time` の時刻の形式エラーを返す 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ
- [ ] `evening_meeting_time` の時刻の形式エラーを返す 400 の `error` が、決定 3 の日本語文言である
- [ ] 同じ 400 が決定 3 の `code` を持つ

## 技術的な制約・方針

- **保存の可否は変えない**: どの値を拒否するか（`VALIDATORS` の判定・`isValidWorkingHoursRange`・`resolveEffectiveWorkingHours`）と、ステータスコード 400 は変えない。既存の拒否・非保存のテストはそのまま通る
- **変更対象（暫定）**: `server/src/settings/settings-validation.ts`・`server/src/settings/settings-routes.ts` と、それぞれのテスト（`settings-validation.test.ts`・`settings-routes.test.ts`）。**web は変更しない**（決定 1 の推奨案。確証 (A) の経路が `error` をそのまま表示する）
- **テストの書き換え範囲**: 確証 (C) にあるキー名の `toContain` 12 アサーションは、変更後の文言の照合に置き換える
- 対象外の文言（`settings-validation.ts:76` / `:90` / `:106` / `:123` / `:143` / `:245` / `:252`）は変えない
- **DB スキーマ変更・マイグレーションは無い**
- 外部送信は Claude API への推論リクエストだけ（ADR 0001）。本件は送る内容を変えない
- 本件は日付境界に触らないので、`npm run test:tz` は必須ゲートではない。品質ゲートは `npm run lint` / `npm run typecheck` / `npm test` を**それぞれ単一コマンドで**実行して判定する

## 画面・API設計（暫定: 決定 1・3 の推奨案）

`PUT /api/settings` の 400 のうち、次の応答の形だけを変える。ステータス 400 は変えない。

```jsonc
// 変更前
{ "error": "work_start must be earlier than work_end" }
{ "error": "boss_name must be a non-empty string" }
{ "error": "work_start must be in \"HH:mm\" format" }

// 変更後（暫定）
{ "error": "勤務開始は勤務終了より前の時刻にしてください（日をまたぐ勤務時間は設定できません）", "code": "invalid_working_hours" }
{ "error": "ボスの名前を入力してください", "code": "setting_required" }
{ "error": "勤務開始の時刻を入力してください", "code": "invalid_time" }
```

| 対象 | `code`（暫定） | `error`（暫定） |
|---|---|---|
| 勤務時間の前後関係（`:272`・routes `:145`） | `invalid_working_hours` | 勤務開始は勤務終了より前の時刻にしてください（日をまたぐ勤務時間は設定できません） |
| `boss_name` が空（`:64`） | `setting_required` | ボスの名前を入力してください |
| `model` が空（`:64`） | `setting_required` | モデルを入力してください |
| `work_start` の形式（`:114`） | `invalid_time` | 勤務開始の時刻を入力してください |
| `work_end` の形式（`:114`） | `invalid_time` | 勤務終了の時刻を入力してください |
| `morning_meeting_time` の形式（`:114`） | `invalid_time` | 朝会の時刻を入力してください |
| `evening_meeting_time` の形式（`:114`） | `invalid_time` | 夕会の時刻を入力してください |

項目名は設定画面のラベル（`SettingsView.tsx:99` / `:160` / `:173` / `:207` / `:217` / `:325`）にそろえる。

## クリティカル設計決定（未確定・親の回答待ち）

> 各決定の「採用案」は**推奨案を暫定で書いたもの**。回答で確定したら、この注記と「（暫定）」を外す。

### 1. 対応の方向（暫定）

- **採用案（暫定）**: (a) サーバの 400 を「日本語の `error` ＋ `code`」にする。web は変更しない
- **理由**: 確証 (A) の経路がそのまま表示するので、変更はサーバ 2 ファイルとそのテストで済む。#495・#501 と同じ形になる。API の利用者はローカル単一ユーザーの web だけである
- **代替案**:
  - (b) サーバは英語のまま `code` を足し、web が `code` から日本語を引く（`tasks-api.ts:59-87` の先例。確証 (D)）。サーバの文言が開発者向けのまま残り、確証 (C) のテストも書き換えずに済む。ただし web に `code` を保持するエラークラスと引き当て表が要る。さらに、どの項目のエラーかを web が知るには、キーごとの `code` か応答への `key` の追加が要り、応答の形が `{ error, code }` の先例から外れる
  - (c) 勤務時間の前後関係だけを日本語にする。確証 (B) で画面から届く「名前・モデルの空欄」と「時刻を消したとき」が英語のまま残る
- **影響範囲**: 暫定案では `settings-validation.ts`・`settings-routes.ts` と両テスト

### 2. 対象の範囲（暫定）

- **採用案（暫定）**: 確証 (B) で「画面から届く」とした文言（`:64`・`:114`・`:272`）と、`:272` と同じ規則の `settings-routes.ts:145` を対象にする
- **理由**: #477・#494 と同じく、画面から届かない 400 は開発者向けの契約違反エラーとして残す。`:145` は画面から届かないが `:272` と同じ事実なので、そろえないと入口によって文言が変わる（#494 決定 1 と同じ理由）
- **代替案**:
  - 検知閾値の正の整数（`:123`）も含める — 確証 (B) のとおりブラウザの制約検証が送信前に止めるので、画面からは届かない（YAGNI）。含める費用は小さい
  - settings の 400 をすべて対象にする — 未知キー（`:252`）のようにキー名を含む英語が失われ、API を直接叩いたときに原因を追いにくくなる
- **影響範囲**: 上記 4 箇所と、その照合テスト

### 3. `code` の名前と `error` の文言（暫定）

- **採用案（暫定）**: 「画面・API設計」の表のとおり。`code` は規則の単位で名付け（`invalid_date` / `invalid_request` と同じ形）、項目名は含めない。文言は項目名と直し方を書く指示の形にする
- **理由**: web は `code` で分岐しない。どの項目かは文言が伝える。直し方が分かることが #507 の要件である。回復示唆の無い短い形を採った #477 決定 3 は、404（資源の不在）が対象だった
- **代替案**: キーごとの `code`（例 `boss_name_required`）。時刻の形式エラーを「HH:mm 形式で指定してください」とする（API を直接叩いた `"9:00"` にも正確だが、画面から届くのは空欄だけ）。勤務時間の文言から括弧書きを外す
- **影響範囲**: 上記 4 箇所と、その照合テスト

### 4. テストは `code` と `error` まで照合し、変異で担保を証明する（暫定）

- **採用案（暫定）**: 対象の各応答を照合するテストが、`code` だけを取り除く変異と、`error` だけを変更前の英語に戻す変異のどちらでも落ちることを確認する。`:272` と `:145` は同じ文言を返すので、**片方への変異で、もう片方の経路のテストが落ちない**ことも確認する
- **理由**: `MEMORY` の教訓「AC 担保は変異で証明する」と、#477 決定 5・#494 決定 5 と同じ規律
- **変異の手順**: 変異は本番コードに一時的に加える。`git diff` で意図した 1 箇所だけが変わっていることを確かめ、確認が済んだら `git checkout -- <変異したファイル>` で戻す。変異はコミットせず、内容と結果（落ちたテスト・落ちなかったテスト）を PR 本文に書く
- **影響範囲**: `settings-validation.test.ts`・`settings-routes.test.ts` の該当テスト

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小・暫定） | 画面から届く settings の 400（勤務時間の前後関係〔全量・部分更新〕・`boss_name` / `model` の空欄・時刻 4 キーの形式）を日本語の `error` ＋ `code` にし、テストを文言と `code` まで照合する形に締めて変異で確認する | 4 | これだけで、画面から届く保存拒否の理由がすべて日本語で表示される |

実装対象: S1

> 暫定案では、本仕様のスライスは S1 で閉じる（後続スライスは無い）。

## やらないこと

- **保存の可否の規則の変更**（どの値を拒否するか・日またぎの許可を含む）（理由: Issue #507 のスコープ。日またぎは `working-hours-intervals.md` の未決の論点 1）
- **画面から届かない settings の 400 の変更**（`settings-validation.ts:76` / `:90` / `:106` / `:123` / `:143` / `:245` / `:252`）（理由: 暫定の決定 2）
- **保存が 400 以外の理由で失敗したときの英語の代替文言の日本語化**（`Failed to fetch`・`request failed with status N`）（理由: 確証 (F) のとおり web の API クライアント 8 ファイルに共通する資源横断の論点で、別 Issue で扱う）
- **web の変更**（`settings-api.ts` / `use-settings.ts` / `SettingsView.tsx` とそのテストのフィクスチャ）（理由: 暫定の決定 1）
- **設定画面へのクライアント側検証・`required` 属性の追加、エラー表示の位置の変更**（理由: 入力 UI とレイアウトは Issue #507 のスコープ外。`working-hours-intervals.md` 決定 5 の方針も維持する）
- **settings 以外の資源の 400 の変更**（理由: Issue #507 は設定保存に限る）
- **`working-hours-intervals.md` の本文の書き換え**（理由: 機能仕様は非権威の経緯の記録である。`:78` を上書きすることは確証 (E) に記録した）

## 受入基準（暫定）

- [ ] `PUT /api/settings` に `work_start` と `work_end` を一緒に送り、組が `work_start >= work_end`（`22:00` / `02:00`、`09:00` / `09:00`）になるリクエストは、400 で拒否される（非回帰）
- [ ] そのとき `work_start` と `work_end` のどちらも保存されない（非回帰）
- [ ] その 400 の応答の `error` が「勤務開始は勤務終了より前の時刻にしてください（日をまたぐ勤務時間は設定できません）」である
- [ ] その 400 の応答の `code` が `"invalid_working_hours"` である
- [ ] `work_start` だけを送り、保存済みまたは既定の `work_end` との組が `work_start >= work_end` になる部分更新の 400 の応答の `error` が、全量更新と同じ文言である
- [ ] その部分更新の 400 の応答の `code` が `"invalid_working_hours"` である
- [ ] `boss_name` に空文字または空白のみ（`""`・`"   "`）を送るリクエストの 400 の応答の `error` が「ボスの名前を入力してください」である
- [ ] その 400 の応答の `code` が `"setting_required"` である
- [ ] `model` に空文字または空白のみ（`""`・`"   "`）を送るリクエストの 400 の応答の `error` が「モデルを入力してください」である
- [ ] その 400 の応答の `code` が `"setting_required"` である
- [ ] `work_start` に `""` を送るリクエストの 400 の応答の `error` が「勤務開始の時刻を入力してください」である
- [ ] その 400 の応答の `code` が `"invalid_time"` である
- [ ] `work_end` に `""` を送るリクエストの 400 の応答の `error` が「勤務終了の時刻を入力してください」である
- [ ] その 400 の応答の `code` が `"invalid_time"` である
- [ ] `morning_meeting_time` に `""` を送るリクエストの 400 の応答の `error` が「朝会の時刻を入力してください」である
- [ ] その 400 の応答の `code` が `"invalid_time"` である
- [ ] `evening_meeting_time` に `""` を送るリクエストの 400 の応答の `error` が「夕会の時刻を入力してください」である
- [ ] その 400 の応答の `code` が `"invalid_time"` である
- [ ] `settings-validation.ts:272` の応答から `code` だけを取り除く変異を加えると、全量更新の前後関係のテストが落ち、部分更新の前後関係のテストは落ちない
- [ ] `settings-validation.ts:272` の `error` だけを変更前の英語に戻す変異を加えると、全量更新の前後関係のテストが落ち、部分更新の前後関係のテストは落ちない
- [ ] `settings-routes.ts:145` の応答から `code` だけを取り除く変異を加えると、部分更新の前後関係のテストが落ち、全量更新の前後関係のテストは落ちない
- [ ] `settings-routes.ts:145` の `error` だけを変更前の英語に戻す変異を加えると、部分更新の前後関係のテストが落ち、全量更新の前後関係のテストは落ちない
- [ ] 空欄の検証（`:64`）から `code` だけを取り除く変異を加えると、`boss_name` と `model` の空欄のテストが落ちる
- [ ] 空欄の検証（`:64`）の `error` だけを変更前の英語に戻す変異を加えると、`boss_name` と `model` の空欄のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）から `code` だけを取り除く変異を加えると、時刻 4 キーの形式のテストが落ちる
- [ ] 時刻の形式の検証（`:114`）の `error` だけを変更前の英語に戻す変異を加えると、時刻 4 キーの形式のテストが落ちる
- [ ] 上記の変異確認の結果（変異の内容・落ちたテスト・落ちなかったテスト）が PR 本文に書かれている
- [ ] `npm run lint` が pass する
- [ ] `npm run typecheck` が pass する
- [ ] `npm test` が pass する
