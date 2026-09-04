# ボスの現在時刻認識（プロンプトへの現在日時埋め込み）

## 概要

ボスのシステムプロンプトに現在日時を明示的に埋め込み、「今何時か」「締切まであと何時間か」「着手から何分経ったか」といった現在時刻を起点とした判断をできるようにする。あわせて、プロンプトへ出力する既存の日時（直近の決定・直近の報告履歴・タスクの締切）を UTC ISO からローカル整形へ揃える。

## 背景・目的

`buildPersonaPrompt`（`server/src/boss/persona-prompt.ts`）は `context.now: Date` を受け取っているが、その用途は `resolveTimeOfDay` による 4 段階の時間帯ヒント（朝／日中／夕方／夜）の算出だけで、**実際の日付・時刻は組み立てたプロンプトに 1 文字も含まれない**。呼び出し元 6 経路はすべて `now` を渡しており、入力はあるのに出力されていない状態にある。

そのためボスは、現在時刻を基準にした判断——締切超過の判定、残り時間の算出、進行中タスクの経過時間——ができない。とくに未完了タスクは経過時間の終端が「今」であり、`get_activity_log` が `task_start` を返しても比較の基準が無いため、ツールの説明が求めている「実績時間と見積もりの突き合わせ」が完了前にはできない。

さらに、プロンプトに出る既存の日時（`recentDecisions.decidedAt` / `recentSessionSummaries.reportedAt`）は保存値そのままの UTC ISO 文字列である。`task.due_at` も、web の日付入力からは `YYYY-MM-DD` だが、ボスの `create_task` / `update_task` ツールが「ISO 8601 日時文字列」として公開しており形式の検証も無いため、`Z` 終端の UTC ISO が入りうる。ここへローカル整形の「今」だけを足すと、同一プロンプト内でローカル表記と UTC 表記が混在し、モデルが後者をローカル時刻と誤読すればオフセット分ずれた解釈になる。「今」の追加と既存表示のローカル化はセットで行う必要がある。

## ユーザーストーリー

セルフマネジメント支援アプリの利用者として、ボスとのチャット・催促通知・朝会夕会の場で、現在時刻を踏まえた具体的な判断（あと何時間ある、もう何分経った、締切を過ぎている）を受け取りたい。

## 機能要件

- [ ] `buildPersonaPrompt` が、現在日時を明示するセクションをプロンプトへ出力できる
- [ ] 現在日時セクションの出力可否は、`purpose` の値ではなく `PersonaPromptContext` の明示的なオプションで決まる（同一 `purpose` でも呼び出し元ごとに異なる値を指定できる）
- [ ] 現在日時の出力オプションを指定しなかったときの既定は「出さない」（fail-closed）
- [ ] 既存の時間帯ヒント（`TIME_OF_DAY_HINTS`）は現在日時セクションと併記して維持する
- [ ] `recentDecisions.decidedAt` をローカル整形で出力する
- [ ] `recentSessionSummaries.reportedAt` をローカル整形で出力する
- [ ] `task.due_at` が ISO 8601 日時文字列のとき、ローカル整形で出力する

呼び出し元 6 経路それぞれで現在日時を出すか出さないかは、クリティカル設計決定 2 の表で定める（経路ごとの検証は「受入基準 > 呼び出し元 6 経路の指定」が担う）。

## 非機能要件

- 外部送信は Anthropic への推論リクエストのみという不変制約を変えない。現在日時はサーバーのローカル時計から得た値であり、新たな外部依存を持ち込まない
- DB の保存形式（`decisions.created_at` / `sessions.started_at` / `sessions.ended_at` の `toISOString()` による UTC 保存）は変更しない。整形は表示時のみ行う

## 技術的な制約・方針

- 変更対象: `server/src/boss/persona-prompt.ts` と、その 6 つの呼び出し元（`server/src/sessions/chat-messages-route.ts`・`server/src/decisions/appeals-route.ts`・`server/src/sessions/meeting-opening.ts`・`server/src/notifications/notification-body.ts`・`server/src/dashboard/boss-comment.ts`・`server/src/reports/extract-evening-summary.ts`）
- ローカル日付（`YYYY-MM-DD`）の導出は既存の `toDateKey`（`server/src/detection/time-utils.ts`）を再利用する。新しい日付整形ロジックを別に書かない（ADR 0007 帰結）
- フロントエンド（web ワークスペース）の変更は無い。本機能はサーバーのプロンプト組み立てに閉じる
- `server/src/sessions/chat-messages-route.ts` の `toClaudeMessages` は変更しない（会話履歴へのタイムスタンプ付与は行わない）
- `server/src/boss/boss-tools.ts` は変更しない（`get_current_time` のようなツールは追加しない）
- `server/src/dashboard/boss-comment-cache.ts` とボスコメントのキャッシュキーは変更しない
- 暦日の区切りに関わるテストの固定時刻は `new Date(y, m, d, h, m)` 形式のローカル日時から導出する。UTC 文字列リテラルで固定しない（ADR 0007 決定 5）
- オフセット表記（`±HH:MM`）は `Date` の標準メソッドに直接の該当が無いため、`getTimezoneOffset()`（分単位・符号は反転する）から組み立てる。整形ヘルパーを `server/src/detection/time-utils.ts` へ追加してもよい
- オフセットを検証するテストは実行環境のタイムゾーンに依存しない形で書く。期待値に `+09:00` のような固定値を書かず、`now` から期待オフセットを導出する（ADR 0007 決定 5 と同じ精神をオフセットにも及ぼす）

## クリティカル設計決定

### 決定 1: 現在日時の粒度と表記

- **採用案**: ローカル表記とオフセット付き ISO を併記し、**日付・曜日・時分・オフセット付き ISO の 4 点**を含める。秒は含めない。
  出力例: `現在日時: 2026-09-05（金）14:32（ISO: 2026-09-05T14:32+09:00）`
  行頭のラベル `現在日時:` は、呼び出し元テストが有無を判定するキーとして固定する（区切り文字・括弧の細部は実装裁量）。
- **理由**:
  - 用途（締切まであと何時間・着手から何分）の分解能は分で足り、秒は毎回変わるノイズになる。
  - 曜日は、締切の会話が「金曜まで」の形で行われるため、日付からの曜日導出をモデルに委ねない。
  - オフセット付き ISO を併記するのは、ボスが経過時間を計算する相手である `get_activity_log` の出力が UTC ISO へ正規化されているため（`server/src/boss/activity-log-tool.ts`）。ローカル表記だけではオフセット分ずれた差分計算になりうる。
- **代替案**: 秒まで含める案は、必要な分解能を超えノイズになるため却下。ISO 単独表記は、日本語会話での自然さ（曜日・午前午後）が落ちるため却下。
- **影響範囲**: `persona-prompt.ts` の整形関数を追加。プロンプト文字列のみが変わり、API・スキーマ・画面は変わらない。

### 決定 2: 出力可否の制御は `purpose` ではなく明示オプション

- **採用案**: `PersonaPromptContext` に真偽のオプション（既定 `false`）を追加し、呼び出し元 6 経路すべてで値を明示的に書く。

  | 呼び出し元 | 現在日時 |
  |---|---|
  | `server/src/sessions/chat-messages-route.ts` | 出す |
  | `server/src/decisions/appeals-route.ts` | 出す |
  | `server/src/sessions/meeting-opening.ts` | 出す |
  | `server/src/notifications/notification-body.ts` | 出す |
  | `server/src/dashboard/boss-comment.ts` | 出さない |
  | `server/src/reports/extract-evening-summary.ts` | 出さない |

- **理由**: `purpose` で分岐させると `notification` の 2 経路（催促文面とダッシュボードのボスコメント）が一括りになり、キャッシュ事情の異なる後者を別扱いできない（決定 3）。また `purpose` が将来増えたとき既定で漏れる。既定 `false` の明示オプションなら、新しい呼び出し元は「出さない」側から始まる。
- **代替案**: `purpose === "daily-report"` のときだけ除外する案は、上記のとおり `boss-comment` を分離できないため却下。
- **影響範囲**: `PersonaPromptContext` の型に任意プロパティが 1 つ増える（既存の呼び出し元は未指定でも型エラーにならないが、本機能では 6 経路すべてに明示的に書く）。

### 決定 3: `daily-report` と `boss-comment` に現在日時を出さない理由

- **採用案**: `server/src/reports/extract-evening-summary.ts`（`purpose: "daily-report"`）と `server/src/dashboard/boss-comment.ts` には現在日時を出さない。
- **理由**:
  - 日報生成の対象暦日は夕会の `started_at` 由来で `now` に依存しない（ADR 0007 決定 4 の日跨ぎ帰属）。ここに「今」を入れると、23:50 開始・翌 00:30 終了の夕会で「今＝翌日」と「対象暦日＝前日」が同一プロンプトに並び、抽出値が誤った日付を引きうる。加えてこの経路の役割は 4 値の抽出であり「今」を必要としない。
  - ボスコメントは 1 日 1 回のキャッシュ（キー＝ローカル暦日＋タスク fingerprint）を持つ。分粒度の時刻をプロンプトへ入れると、朝に生成された「もう 10:05 だ」が夕方まで表示される陳腐化がユーザーの目に見える形で生じる。キャッシュキーへ時間帯を足しても、バケット内（数時間幅）の陳腐化は原理的に残るため解決にならない。ボスコメントは時間帯ヒントを引き続き受け取るため、時間帯粒度の文脈は保たれる。
- **代替案**: ボスコメントのキャッシュキーに時間帯バケットを追加する案は、上記のとおり欠陥が消えないため却下。
- **影響範囲**: 両経路のプロンプトは現在日時に関して現状と同じ。キャッシュ機構は無変更。

### 決定 4: 既存の日時表示のローカル化は「表示のみ」

- **採用案**: `formatDecisionLine`（`decidedAt`）と `formatSessionSummaryLine`（`reportedAt`）の出力をローカル整形へ変える。DB の保存形式は変更しない。
- **理由**: 保存形式の変更はマイグレーションを伴い、`toISOString()` 前提の時点比較・ソートの正当性にも波及して不可逆になる。表示のみの変更であれば可逆で、ADR 0007 決定 1（当日はサーバーのローカル暦日）の方向とも整合する。「今」だけローカルで履歴が UTC という混在を残さないことが、決定 1 と同時に行う目的である。
- **代替案**: 現状維持（UTC のまま）は混在によるモデルの誤読を残すため却下。DB 保存形式の変更は上記のとおり却下。
- **影響範囲**: `persona-prompt.ts` の 3 つの整形関数（`formatDecisionLine` / `formatSessionSummaryLine` / `formatTaskLine`）。`formatSessionSummaryLine` に付いている「保存値は `toISOString()` 由来の UTC なのでそのまま出す」旨のコメントは、古い根拠が次の実装者を元へ戻さないよう本決定に合わせて書き換える。
- **規律が及ぶ層**: 「LLM プロンプトへ出す日時はローカル整形」は `buildPersonaPrompt` が組み立てる全セクションに及ぶ。
- **`task.due_at` の扱い**: `due_at` は web の日付入力からは `YYYY-MM-DD`（ローカル暦日）で保存されるが、ボスの `create_task` / `update_task` ツールは `due_at` を「ISO 8601 日時文字列」として公開しており（`server/src/boss/task-tools.ts`）、`server/src/tasks/tasks-validation.ts` に形式の検証は無い。したがって `Z` 終端の UTC ISO が `due_at` に入りうる（`server/src/tasks/tasks-routes.test.ts` に実例がある）。全セクションへ規律を及ぼす以上、`formatTaskLine` の `due_at` も対象に含める: **日付のみ（`YYYY-MM-DD`）はそのまま出し、時刻を持つ ISO 日時のときだけローカル整形する**（日付のみの値へ `00:00` を捏造しないため）。

### 決定 5: ツールではなくシステムプロンプトへの埋め込み

- **採用案**: 現在日時はシステムプロンプトに埋め込む。`get_current_time` のようなツールは追加しない。
- **理由**: ツールを渡しているのはチャット経路だけで、催促文面・ボスコメント・朝会夕会の開始ひとことの各経路は `tools` を一切渡していない。ツール方式では決定 2 で「出す」とした `server/src/notifications/notification-body.ts` を満たせない。加えてツールはモデルが呼ぶかどうかに依存するため決定的なテストにならないが、埋め込みなら純粋関数 `buildPersonaPrompt` の出力を固定時刻に対して直接検証できる。
- **代替案**: ツール方式・両方式併用はいずれも上記の理由で却下。
- **影響範囲**: `boss-tools.ts` は無変更。

### 決定 6: 現在日時をデータ境界で囲まない

- **採用案**: 報告履歴に使われている `---REPORT-HISTORY-START---` のような非信頼データ境界とガード文は、現在日時セクションには付けない。
- **理由**: 現在日時はサーバーのローカル時計から生成した値でユーザー入力を含まないため、プロンプトインジェクションの経路にならない。
- **影響範囲**: なし（既存のガードは報告履歴に対してそのまま維持する）。

## 受入基準

### 現在日時セクションの出力可否

- [ ] `buildPersonaPrompt` は、現在日時の出力オプションを指定しなかったとき、プロンプトに `現在日時:` を含めない
- [ ] `buildPersonaPrompt` は、現在日時の出力オプションを明示的に無効化したとき、プロンプトに `現在日時:` を含めない
- [ ] `buildPersonaPrompt` は、現在日時の出力オプションを有効にしたとき、プロンプトに `現在日時:` で始まる行を含める

### 現在日時の表記（有効時）

- [ ] 現在日時の行は、`now` のローカル暦日を `YYYY-MM-DD` 形式で含める
- [ ] 現在日時の行は、`now` のローカル暦日に対応する曜日（日・月・火・水・木・金・土）を含める
- [ ] 現在日時の行は、`now` のローカル時刻を `HH:mm` 形式で含める
- [ ] 現在日時の行は、`now` をオフセット付き ISO（`YYYY-MM-DDTHH:mm±HH:MM`）で含める
- [ ] 現在日時の行は、秒を含めない

### 呼び出し元 6 経路の指定

> 催促通知（`notification-body.ts`）とダッシュボードのボスコメント（`boss-comment.ts`）はどちらも `purpose: "notification"` を使う。この 2 経路が逆の値を持つことが、「出力可否が `purpose` から導かれていない」ことの検証を兼ねる。

- [ ] `POST /api/sessions/:id/messages`（`chat-messages-route.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含む
- [ ] 異議申し立ての裁定（`appeals-route.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含む
- [ ] 朝会・夕会の開始ひとこと生成（`meeting-opening.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含む
- [ ] 催促通知の文面生成（`notification-body.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含む
- [ ] ダッシュボードのボスコメント生成（`boss-comment.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含まない
- [ ] 日報の夕会サマリ抽出（`extract-evening-summary.ts`）が LLM へ渡すシステムプロンプトは `現在日時:` を含まない

### 時間帯ヒントの維持

- [ ] 時間帯ヒント（朝・日中・夕方・夜）は、現在日時セクションの有無にかかわらずプロンプトに含まれる

### 既存日時表示のローカル化

- [ ] 直近の決定の行は、`decidedAt`（UTC ISO 保存値）をローカル整形した日時で表示する
- [ ] 直近の報告履歴の行は、`reportedAt`（UTC ISO 保存値）をローカル整形した日時で表示する
- [ ] タスクの行は、`due_at` が時刻を持つ ISO 日時のとき、ローカル整形した日時で表示する
- [ ] タスクの行は、`due_at` が日付のみ（`YYYY-MM-DD`）のとき、その値をそのまま表示する
- [ ] `decidedAt` が `Date` として解釈できない文字列のとき、その値をそのまま表示する（`Invalid Date` を出力しない）
- [ ] `reportedAt` が `Date` として解釈できない文字列のとき、その値をそのまま表示する（`Invalid Date` を出力しない）
- [ ] `due_at` が `Date` として解釈できない文字列のとき、その値をそのまま表示する（`Invalid Date` を出力しない）
- [ ] `decidedAt` / `reportedAt` / 時刻を持つ `due_at` に有効な UTC ISO 保存値を与えたとき、`buildPersonaPrompt` の出力に `Z` 終端の UTC ISO 日時文字列が含まれない（`Date` として解釈できない値のフォールバック表示は、整形対象ではないためこの基準の対象外）

### 品質ゲート

- [ ] `npm run lint` が pass する
- [ ] `npm run typecheck` が pass する
- [ ] `npm test` が pass する
