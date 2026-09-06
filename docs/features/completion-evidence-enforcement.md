# 完了報告にエビデンス（ファイル添付・リンク）を強制するオプション

> 対象 Issue: [#256](https://github.com/masanami/ai-boss/issues/256)
>
> **この文書は非権威（実装を駆動する作業文書）である。** 正本はコードと `*.test.ts`（リポジトリ CLAUDE.md「開発方針」）。実装と食い違ったらコードを読んで実態を確かめてから本書を直す。

## 概要

タスクごとに「完了報告にエビデンス（ファイル添付またはリンク）が要るか」をボスが裁定し、設定 ON の間はエビデンスが 1 件も無いタスクを `done` にできなくする。強制はサーバ側のタスク更新経路 1 箇所で効かせ、UI・ボスチャットのツール・API 直叩きのどの経路でも同じ判定にする。

## 背景・目的

現状、完了は `tasks.status` を `done` にするだけで成立し、エビデンスに相当する概念はどこにも無い。「やった」と言えば完了になるため、自己申告が実態から乖離しても検知できない。

本アプリの唯一のユーザーはオーナー本人である。したがってこの機能は**敵対者に対するセキュリティ機構ではなく、自己規律のための仕組み**である。この位置づけが、以下すべての設計判断を貫く原則になる:

> **抜け道を物理的に塞ぐことよりも、抜け道を通ったことが必ず痕跡として残ることを優先する。**

塞ぐコストが小さい場所は塞ぐが、塞ぐために製品を不便にしたり、実装を複雑にしたりはしない。代わりに「自分で要否フラグを落とした」「設定を OFF にした」が後から見て分かる状態を維持する。

## ユーザーストーリー

セルフマネジメントしたいオーナーとして、成果物が伴うはずのタスクにエビデンス添付を必須にすることで、「やったつもり」で完了扱いにしてしまうのを自分自身に対して防ぎたい。

## 機能要件

- [ ] 設定画面で「完了報告にエビデンスを必須にする」を ON/OFF できる（キー未設定時の既定は OFF）
- [ ] タスク策定時にボス（LLM）が「エビデンスの要否」を裁定し、タスクに保持する
- [ ] 人間はボスの裁定を上書きできる（タスク詳細で要否をトグルできる）
- [ ] 設定 ON かつエビデンス要のタスクは、エビデンスが 0 件だと `done` にできない
- [ ] 強制はサーバ側で効き、UI・ボスチャットのツール・API 直叩きのどの経路でも同じ判定になる
- [ ] タスクにファイル（アプリ管理下へコピー）またはリンク（URL）をエビデンスとして添付できる
- [ ] 添付済みエビデンスを一覧・閲覧・削除できる UI がある
- [ ] `done` のタスクからエビデンスを削除しようとすると拒否される
- [ ] エビデンス要否フラグをユーザーが落とした事実が活動ログに残る
- [ ] エビデンスの**本体（ファイルの中身）は LLM へ一切送らない**

## 非機能要件

- **ローカル完結（[ADR 0001](../adr/0001-local-only-data-boundary.md)）**: エビデンスの保管先はローカルファイルシステムのみ。外部ストレージ・外部送信経路を追加しない。エビデンスを起点とした新しい外部通信は一切発生しない
- **サイズ上限**: 1 ファイル 10 MB、1 タスクあたり 10 件。いずれもサーバ側で拒否する
- **拡張子ホワイトリスト**: 実行可能形式・アクティブコンテンツ形式は保存させない（後述「クリティカル設計決定 1」）
- **暦日非依存**: 本機能の判定は「`done` へ遷移する瞬間」だけを見ており、ローカル暦日境界（[ADR 0007](../adr/0007-local-calendar-day-basis.md)）に依存しない。受入基準にも暦日境界を含めない

## 技術的な制約・方針

- **変更対象**: `server/src/tasks/`（スキーマ・検証・リポジトリ・ルート）、`server/src/db/migrate.ts`（新 version）、`server/src/settings/`、`server/src/boss/`（`task-tools.ts` / `persona-prompt.ts`）、`server/src/config.ts`、`server/src/app.ts`、`web/src/`（設定・タスクボード・チェックインパネル・タスク詳細）
- **既存コードとの関係**:
  - 完了に至る 4 経路はすべて `server/src/tasks/tasks-repository.ts` の `updateTask()` を通る（実コードで確認済み。「クリティカル設計決定 2」に根拠）
  - `settings` は `key TEXT PRIMARY KEY, value TEXT` の全 TEXT KV（`migrate.ts` v1）。boolean の前例は無い
  - ボスへ渡すタスク行は `server/src/boss/persona-prompt.ts` の `formatTaskLine()` が組み立てる。`Task` の全列が自動で流れるわけではなく、**明示的に足した項目だけ**がプロンプトに載る
  - multipart / `FormData` / upload 相当の実装は server・web いずれにも存在しない（grep 0 件。実コードで確認済み）
- **マイグレーション規律（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4）**: 既存 version は書き換えず、新しい version を追加する。SQLite に真偽型は無いため、既存慣習（`messages.interrupted`）に合わせて INTEGER を使う

## 画面・API設計

### API

新設エンドポイント（すべて `/api/tasks/:id` 配下。既存の tasks ルーターに同居させる）:

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/tasks/:id/evidences` | エビデンスのメタデータ一覧（本体は含まない） |
| `POST` | `/api/tasks/:id/evidences` | エビデンスの追加（ファイル: `multipart/form-data` / リンク: `application/json`） |
| `GET` | `/api/tasks/:id/evidences/:evidenceId/content` | ファイル本体の取得（`kind = "file"` のみ） |
| `DELETE` | `/api/tasks/:id/evidences/:evidenceId` | エビデンスの削除 |

エビデンスのメタデータ表現（レスポンス JSON。DB 列と 1:1）:

```jsonc
{
  "id": 1,
  "task_id": 42,
  "kind": "file",              // "file" | "link"
  "stored_filename": "…",      // kind="file" のときのみ非 null（サーバ生成名）
  "original_filename": "…",    // kind="file" のときのみ非 null
  "mime_type": "image/png",    // kind="file" のときのみ非 null（拡張子から導出した値）
  "size_bytes": 12345,         // kind="file" のときのみ非 null
  "url": null,                 // kind="link" のときのみ非 null
  "created_at": "2026-09-06T…"
}
```

ファイル追加リクエスト（`multipart/form-data`）はフィールド名 `file` に 1 ファイルを載せる。Hono 4.x の `c.req.parseBody()` が `File` として受け取れるため、新しい依存パッケージは追加しない。

リンク追加リクエスト（`application/json`）は `{ "url": "https://…" }`。

エラー応答は既存の `{ error: string }` に**安定した `code`** を添える形にする（`server/src/reports/reports-routes.ts` の前例と同形。web は文言ではなく `code` で分岐する）。

| 状況 | ステータス | `code` |
|---|---|---|
| 設定 ON・エビデンス要・0 件で `done` にしようとした | 409 | `evidence_required` |
| `done` のタスクのエビデンスを削除しようとした | 409 | `task_already_done` |
| 1 タスクの上限 10 件を超える追加 | 409 | `evidence_limit_exceeded` |
| ファイルサイズが 10 MB を超える | 400 | `evidence_file_too_large` |
| 拡張子がホワイトリスト外 | 400 | `evidence_extension_not_allowed` |
| URL のスキームが `http` / `https` 以外 | 400 | `evidence_url_scheme_not_allowed` |

既存 API の変更:

- `tasks` の各レスポンス（`GET /api/tasks` / `POST` / `PATCH`）に `evidence_required`（`0 | 1`）が増える
- `POST /api/tasks` が `evidence_required` を受け付ける（省略時 `false`）
- `PATCH /api/tasks/:id` が `evidence_required` を受け付ける
- `GET /api/settings` / `PUT /api/settings` に `evidence_enforcement_enabled`（JSON 上は boolean）が増える

### 画面

- **設定画面**（`web/src/SettingsView.tsx`）: 新しい `fieldset`「エビデンス」に、`evidence_enforcement_enabled` のチェックボックスを 1 つ置く。ラベルは「完了報告にエビデンスを必須にする」
- **タスク作成フォーム**（`web/src/TaskForm.tsx`）: 「エビデンスを必須にする」チェックボックス（既定 OFF）。LLM を通らない直接作成の裁定はここでユーザー自身が行う
- **タスク詳細**（`web/src/TaskCard.tsx` の編集 UI）: 要否トグル、エビデンス一覧（ファイル名 / リンク）、追加（ファイル選択・URL 入力）、削除
- **タスクボード**（`web/src/TaskBoard.tsx`）: `done` への DnD が 409 で弾かれたとき、既存の `actionError`（`<p role="alert">`）に理由を表示する
- **チェックインパネル**（`web/src/CheckinPanel.tsx`）: 「完了」ボタンが 409 で弾かれたとき、既存の `submitError` に理由を表示する

---

## クリティカル設計決定

### 決定 1: エビデンスの実体と保存先 — アプリ管理下へコピーし、メタデータを別テーブルに持つ（論点 2）

- **採用案**: ファイル本体は**アプリ管理下の保管ディレクトリへコピー**し、メタデータは `tasks` への列追加ではなく**別テーブル `task_evidences`** に持つ。リンクは URL 文字列としてメタデータのみを持つ
- **理由**:
  - パス参照のみは、ユーザーがファイルを移動・削除した時点で壊れる（Issue #256 本文の指摘）。エビデンスは「後から見返せること」が価値なので、参照先の寿命をアプリが握る必要がある
  - SQLite への BLOB 保存は DB サイズ・バックアップ・マイグレーションを重くする。[ADR 0005](../adr/0005-sqlite-schema-policy.md) は「バックアップ・機材移行は利用者が SQLite ファイルを直接扱う」前提であり（ADR 0001 帰結）、10 MB × N のバイナリを同じファイルに抱えるのはこの前提と相性が悪い
  - 1 タスクに複数のエビデンスを持たせたいので、`tasks` への列追加では表現できない
- **代替案**:
  - **パス参照のみ** — 却下。移動・削除で壊れる
  - **SQLite に BLOB** — 却下。上記のとおり DB ファイルが肥大化する
  - **`tasks` に `evidence_url` / `evidence_path` を 1 組足す** — 却下。1 タスク 1 件に固定され、「スクショ 2 枚 + PR リンク」が表現できない

#### 1-a: 保管ディレクトリ

**既存の DB ファイルと同じデータディレクトリの配下**に `evidence/` サブディレクトリを設ける。**新しい環境変数を発明しない。**

- 実コードの DB パス解決は `server/src/config.ts` の `loadConfig(env)`: `env.DB_PATH ?? "./data/ai-boss.db"`。サーバの cwd は `server/` なので既定では `server/data/ai-boss.db` に解決される
- したがって保管ディレクトリは `dirname(dbPath) + "/evidence"`。既定では `server/data/evidence/`。`.gitignore` は `server/data/` を無視しているため、既定パスならエビデンスがコミット対象に入ることはない
- 導出は `config.ts` に純粋関数（例: `resolveEvidenceDir(dbPath)`）として置き、1 箇所に集約する
- `dbPath` が `:memory:` のとき（テスト）はディレクトリを導出できない。`createApp` の `CreateAppOptions` に保管ディレクトリを渡す口を足し（既存の `staticRoot` と同じ作法）、`index.ts` が `resolveEvidenceDir(config.dbPath)` を渡す。テストは一時ディレクトリを渡す

#### 1-b: テーブル定義（マイグレーション v7）

[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4 に従い、既存 version を書き換えず新 version として追加する。既存テーブルの再構築（v4 のような 12-step）は不要で、`CREATE TABLE` と `ALTER TABLE … ADD COLUMN` で足りる。

```sql
CREATE TABLE IF NOT EXISTS task_evidences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'link')),
  stored_filename TEXT,     -- kind='file' のみ。サーバ生成名（保管ディレクトリ内の相対名）
  original_filename TEXT,   -- kind='file' のみ。表示用
  mime_type TEXT,           -- kind='file' のみ。拡張子から導出した値
  size_bytes INTEGER,       -- kind='file' のみ
  url TEXT,                 -- kind='link' のみ
  created_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN evidence_required INTEGER NOT NULL DEFAULT 0;
```

- `stored_filename` は**保管ディレクトリ内の相対ファイル名のみ**を持ち、絶対パスを持たない。DB ファイルを移動しても保管ディレクトリとの相対関係が保たれる
- `evidence_required` が INTEGER なのは SQLite に真偽型が無いため（既存慣習 `messages.interrupted INTEGER NOT NULL DEFAULT 0` と同形）。`DEFAULT 0` により既存行はすべて「不要」になる = 決定 4（遡及しない）と整合する
- `kind` ごとにどの列が非 null かを DB の CHECK では縛らない。単一ライター前提で作り込みを最小に保つ [ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 5 に従い、整合はサーバ側の検証層 1 箇所で担保する

#### 1-c: 拡張子ホワイトリスト

保存を**許可する**拡張子（大文字小文字を区別せず判定する）:

| 分類 | 拡張子 |
|---|---|
| 画像 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.heic` |
| PDF | `.pdf` |
| テキスト系 | `.txt` `.md` `.csv` `.log` `.json` |
| 文書 | `.docx` `.xlsx` `.pptx` |

上記以外はすべて拒否する（ホワイトリストなので、明示的に許可した形式だけが通る）。とくに次は**明示的に拒否**する:

- 実行可能形式: `.app` `.exe` `.sh` `.command` `.scpt` `.bat` `.ps1` `.jar` `.pkg` `.dmg`
- アクティブコンテンツ形式: `.html` `.htm` `.svg` `.xhtml`（同一オリジンから配信するとスクリプトが動きうるため、画像であっても `.svg` は許可しない）

**導出決定 1-c-i: 保管ファイル名はサーバが生成する。** ユーザー由来のファイル名を保存パスに使うと、`../` を含む名前でパストラバーサルになる。元のファイル名は `original_filename` に保持して表示にだけ使う。

**導出決定 1-c-ii: 配信時の Content-Type は拡張子ホワイトリストから導出し、クライアント申告の MIME を使わない。** 併せて `X-Content-Type-Options: nosniff` を常に付ける。画像と PDF のみ `Content-Disposition: inline`、それ以外は `attachment` にする（ローカル完結の同一オリジンで任意の型をインライン配信しないため）。

### 決定 2: 強制の関門はサーバ側のタスク更新経路 1 箇所（論点 3）

- **採用案**: `server/src/tasks/tasks-repository.ts` の `updateTask()` を唯一の関門にする。`done` への遷移を試みたとき、設定 ON かつ当該タスクが `evidence_required = 1` かつエビデンス 0 件なら、**409 と安定した `code: "evidence_required"`** で拒否する
- **理由**: 完了に至る 4 経路が**実コード上すべて `updateTask()` を通る**ことを確認済み:
  1. チェックインパネルの「完了」ボタン → `web/src/use-checkin-panel.ts:252` の `editTask(taskId, { status: "done" })` → `web/src/tasks-api.ts` の `patchTask` → `PATCH /api/tasks/:id` → `server/src/tasks/tasks-routes.ts:41` → `updateTask`
  2. タスクボードの DnD / カードのステータス変更 → `web/src/TaskBoard.tsx:112,146` の `editTask` → 同上
  3. ボスチャットの `update_task` ツール → `server/src/boss/task-tools.ts:106` → `updateTask`
  4. `PATCH /api/tasks/:id` 直叩き → `server/src/tasks/tasks-routes.ts:41` → `updateTask`

  加えて `server/src/activity/checkins-routes.ts:164` も `updateTask` を呼ぶが、渡す status は `"in_progress" | "paused"` に型で固定されており（同ファイル 120 行目）`done` には到達しない。`UPDATE tasks` を直接書いている箇所は `updateTask` の 1 箇所だけである（grep で確認済み）
- **代替案**:
  - **UI 側で完了ボタン・DnD を無効化する** — 却下。経路 3・4 を素通りする
  - **`validatePatchTaskInput` で弾く** — 却下。判定に DB（設定値と当該タスクのエビデンス件数）が要るが、この関数は純粋な形式検証で DB を持たない。DB を渡すと責務が変わる
  - **CHECK 制約・トリガで DB に持たせる** — 却下。設定値との組み合わせ判定になり SQLite の宣言的制約では表せない

**導出決定 2-a: 判定条件は「`done` への遷移」であって「`done` であること」ではない。** `patch.status === "done" && existing.status !== "done"` のときだけ関門を通す。これは `updateTask` が既に `completed_at` の更新に使っている条件（`tasks-repository.ts:112-118`）と同じで、決定 4（遡及しない）をこの 1 条件で自然に満たす。既に `done` のタスクにタイトルだけ `PATCH` しても弾かれない。

**導出決定 2-b: `updateTask` の戻り値を判別可能にする。** 現在の戻り値は `Task | undefined`（`undefined` = 該当タスク無し）で、「拒否」を表現できない。判別可能なユニオン（成功 / 該当なし / エビデンス不足）へ変える。既存の呼び出し元 3 箇所（`tasks-routes.ts` / `task-tools.ts` / `checkins-routes.ts`）はすべて型エラーで気付ける。

**導出決定 2-c: 拒否は「何も書かない」。** 拒否時は `tasks` 行（`status` / `updated_at` / `completed_at`）を一切更新せず、`task_update` 活動イベントも記録しない。関門は既存のトランザクションに入る前に評価する。

**導出決定 2-d: ボスチャット経由の拒否はボスがユーザーに伝える。** `executeUpdateTask` は既存のエラー返却様式（`{ content, isError: true }`）で理由文字列を返す。ツール結果は会話に戻るため、ボスが「エビデンスが無いので完了にできない」と伝える形になる。ここに専用の仕組みは足さない。

**導出決定 2-e: DnD で弾かれたカードは元の列に残る。** `web/src/use-tasks.ts:59-62` の `editTask` は `patchTask` が解決してから state を更新する楽観更新なしの実装なので、409 で reject された時点でカードは移動していない。したがって「元の列へ戻す」ための追加実装は不要で、要件は「移動していないこと」と「理由が表示されること」の 2 点に落ちる。理由の表示は `TaskBoard.tsx` の既存 `actionError`（`<p role="alert">`）に載せる。

**導出決定 2-f: web の API 層はエラーの `code` を保持する。** 現在の `web/src/tasks-api.ts` は `{ error }` の文言だけを `Error` にして投げるため `code` で分岐できない。`web/src/daily-reports-api.ts` の `ReportApiError`（`message` + `code`）と同じ形のエラークラスをタスク API 側にも用意し、UI は文言でなく `code` で分岐する（[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 2 と同じ規律）。

**導出決定 2-g: 作成時に直接 `done` にする経路も同じ判定にする。** `POST /api/tasks` は `status: "done"` を受け付ける（`insertTask` は `record.status === "done"` で `completed_at` を入れる。`tasks-repository.ts:45`）。新規タスクにエビデンスは付けられないので、設定 ON で `evidence_required: true` かつ `status: "done"` の作成は必ず「エビデンス 0 件で `done`」になる。関門の判定式を共有の純粋述語に切り出し、`insertTask` 経路からも同じ `code: "evidence_required"` で 409 を返す。**関門を 2 つに増やすのではなく、1 つの述語を 2 箇所から呼ぶ**（この経路は UI からは到達しない — `TaskForm` は `status` を送らず、`create_task` ツールのスキーマにも `status` は無い）。

### 決定 3: 裁定者はボス（LLM）。人間が上書きでき、上書きは活動ログに残る（論点 1）

- **採用案**:
  - 既定の裁定者は**ボス（LLM）**。`create_task` ツールに `evidence_required`（boolean）を足し、朝会等のタスク策定でボスが裁定してタスクに保持させる
  - LLM を通らない `TaskForm` → `POST /api/tasks` の直接作成は**既定「不要」**とし、フォームにユーザー自身が要否を切り替えるチェックボックスを置く
  - **人間はボスの裁定を上書きできる**（タスク詳細から要否をトグルできる）。ただし**上書きは活動ログに記録される**
- **理由**: 「エビデンスが伴うタスクか」はタスクの内容を読まないと判断できず、ルールベースでは決まらない。一方で作成後に非同期で裁定させると、裁定が入る前に完了できる時間帯が生まれ、追加の LLM 呼び出しコストも増える。策定時に同じ会話の中で決めさせるのが最も素直である。上書きを許すのは設計思想（塞ぐより痕跡）に従った帰結で、上書きしたことが残れば自己規律としては十分に働く
- **代替案**:
  - **作成後に非同期でボスに裁定させる** — 却下。裁定前の空白時間が抜け道になり、コストも増える
  - **上書きを禁止する** — 却下。ボスの誤裁定を人間が直せなくなり、その回避のために設定ごと OFF にする動機が生まれる（より大きな抜け道になる）
  - **`TaskForm` からも LLM を呼んで裁定させる** — 却下。手で 1 行足すだけの作成に LLM 往復が挟まると体験が悪化する。YAGNI

**導出決定 3-a: ボスがタスクの要否を見られるようにする。** `Task` の全列が自動でプロンプトに載るわけではない — `server/src/boss/persona-prompt.ts:229` の `formatTaskLine()` が載せる項目を明示的に選んでいる（現状はステータス・id・タイトル・優先度・締切）。ここに**エビデンス要否と添付件数**を足す。足さない限りボスは自分が裁定した内容を次のターンで参照できない。

**導出決定 3-b: 上書きの痕跡は既存の `task_update` 活動イベントの `note` に載せる。新しいイベント種別を作らない。** 根拠:

- `activity_events.type` は CHECK 制約付き（`migrate.ts` v4 の `V4_REBUILD_SQL`）で、種別の追加はテーブル再構築（v4 と同じ 12-step 手順）を要する。`ACTIVITY_EVENT_TYPES` は検知ルールエンジンの単一入力（[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 1）でもあり、種別追加は検知側への波及を伴う
- `updateTask` は既に patch のたびに `task_update` イベントを記録しており（`tasks-repository.ts:143`）、`activity_events.note`（TEXT・制約なし）は `recordActivityEvent` が受け付ける既存の列である。**要否フラグを変更した `PATCH` のときだけ `note` に変更内容を書く**ことで、既存の枠のまま痕跡を残せる
- 記録先が `activity_events` なので、ボスの `get_activity_log` ツール（`server/src/boss/activity-log-tool.ts:256` は `ActivityEvent` 行をそのまま返す）からも見える = ボスが「自分で必須を外しましたね」と突けるようになる。設計思想（痕跡を残す）の実効性がここで担保される

### 決定 4: 設定 OFF → ON の遡及はしない（論点 4）

- **採用案**: 設定を ON にした時点で既に `done` のタスクは対象外。ON 以降に `done` へ遷移するタスクにだけ効く
- **理由**: 過去を後から不正状態にしない。既存の完了タスクを遡って「エビデンス不足」と表示しても、当時エビデンスを残す運用ではなかったので直しようがなく、ノイズにしかならない
- **実装上の帰結**: 決定 2-a のとおり関門が「`done` への遷移」だけを見るので、遡及しないための特別な実装は不要。`evidence_required` が `DEFAULT 0` で既存行に入る（決定 1-b）ことと合わせ、設定 ON の瞬間に不正状態になる行は存在しない
- **代替案**:
  - **ON 時に既存 done タスクを「エビデンス不足」として一覧表示する** — 却下。過去分は直せないので警告が恒久的に残り、無視される警告になる

### 決定 5: 抜け道の扱い（論点 5）

| 抜け道 | 扱い | 理由 |
|---|---|---|
| `dropped` へ逃がす | **許す**（強制は `done` にのみ効かせる） | `dropped` は「やらなかった」であって完了報告ではない。完了として集計されない（日報の `completedTasks` は `status = 'done'` で絞る。`collect-daily-report-data.ts:74`）ので、逃げたことは記録に残る |
| `done` 後にエビデンスを削除する | **拒否する**（409 `task_already_done`） | 「完了時点だけチェック」だと、完了 → 削除で実質ノーチェックになる。ステータスを `done` から戻せば削除できるので、可逆性は保たれる |
| 要否フラグを自分で落とす | **許すが活動ログに残す** | 決定 3 の帰結。設計思想（塞ぐより痕跡）どおり |
| 設定自体を OFF にする | **許す** | 唯一のユーザーが自分の規律の強度を決めるのは正当な操作であり、塞ぐ対象ではない |

### 決定 6: LLM へ渡す範囲の境界（論点 6）

**LLM へはエビデンスの本体を一切送らない。** これは [ADR 0001](../adr/0001-local-only-data-boundary.md)（プロセス外への送信は Anthropic への推論リクエストのみ）を、本機能に対して具体化した境界である。

- **LLM へ渡してよい**（メタデータのみ）:
  - エビデンスの**件数**
  - ファイルの**元ファイル名**（`original_filename`）
  - リンクの **URL**
  - タスクの**エビデンス要否フラグ**
- **LLM へ渡してはならない**:
  - ファイルの**中身**（バイト列・テキスト抽出結果・OCR 結果・要約のいずれも）
  - **保管パス**（`stored_filename` を含む、ファイルシステム上の場所を示す値）

現状のコードでこの境界に触れる箇所と、それぞれの扱い:

| 経路 | 現状 | 本機能での扱い |
|---|---|---|
| ボスチャットのプロンプト | `persona-prompt.ts:229` の `formatTaskLine()` がタスクを 1 行に整形。載る項目は明示列挙 | 要否と件数を足す（決定 3-a）。ファイル名・URL・本体は足さない |
| `get_activity_log` ツール | `activity-log-tool.ts:256` が `ActivityEvent` 行と `taskMeta`（id / title / status / estimated_minutes / completed_at）を返す | `note` 経由で「要否フラグを変更した」事実が載る（決定 3-b）。`note` にエビデンスの中身を書かない |
| 日報の LLM 抽出 | `extract-evening-summary.ts` が LLM へ渡すのは夕会の会話ログと当日の決定 content のみ。タスク行は渡していない | **変更しない**。エビデンスは LLM 抽出の入力に入らない |
| 日報のレンダリング | `collect-daily-report-data.ts:70-78` が `completedTasks` をタイトルのみ収集し、`render-daily-report.ts` が決定的に整形（[ADR 0006](../adr/0006-renderer-owns-structure.md)） | **本チケットでは変更しない**（日報へのエビデンス掲載は本機能のスコープ外。必要になったら別 Issue で、メタデータのみという本境界の内側で設計する） |
| ダッシュボード（web） | ローカル表示 | 本体を**表示・閲覧してよい**。画像・PDF のプレビュー、リンクの遷移はローカル完結の内側 |

### 決定 7: boolean 設定キーの型（論点 7）

- **採用案**: `settings` は全 TEXT の KV なので、boolean は **`"true"` / `"false"` の文字列**で保存する。`settings-validation.ts` に boolean 用のバリデータを追加し、web 側 `Settings` 型では boolean として扱う変換層を置く。**キーが未設定のときの既定は OFF（`false`）**
- **理由**: `settings` テーブルは `key TEXT PRIMARY KEY, value TEXT`（`migrate.ts` v1）で、値の型は文字列に固定されている。既存バリデータも数値（`boss_strictness` / `*_minutes`）を `String(value)` にして保存しており（`settings-validation.ts:90,122`）、「JSON では型付き・保存は文字列」という変換の前例がある。boolean もこの前例に揃える
- **代替案**:
  - **`"1"` / `"0"` で持つ** — 却下。既存の数値設定（分・強度）と同じ見た目になり、DB を直接覗いたときに区別できない
  - **`settings.value` の型を変える / 別テーブルを作る** — 却下。KV の単純さが失われ、既存 14 キーすべてに波及する

**導出決定 7-a: 新しい設定キー名は `evidence_enforcement_enabled` とする。** `SETTINGS_KEYS`（`settings-validation.ts:11-27`）の既存 15 キーは、ドメイン接頭辞付きの snake_case（`boss_*` / `work_*` / `detection_*` / `escalation_*`）か、単独の名詞（`model`）である。本機能は新しいドメインなので `evidence_` を接頭辞にし、`detection_unstarted_fallback_minutes` と同じ `<ドメイン>_<対象>_<属性>` の形に揃える。**新しい命名体系は導入しない。**

**導出決定 7-b: `GET /api/settings` の実効値は専用の reader から読む。** `settings-routes.ts:15` の `readEffectiveSettings` は、アプリ本体が使うのと同じ reader（`resolveBossSettings` / `loadDetectionSettings`）から組み立てることで API と実挙動の乖離を防いでいる。同じ規律に従い、エビデンス強制設定も専用の reader 関数を 1 つ用意し、**`GET /api/settings` と決定 2 の関門が同じ reader を読む**ようにする（片方だけが古い値を見る事故を型で防ぐ）。

---

## 機能全体の設計

### アーキテクチャ決定

- **エビデンスは `tasks` の付属物**として扱い、`/api/tasks/:id/evidences` 配下に置く。トップレベルの `/api/evidences` を作らない（タスクから独立したエビデンスというユースケースが無い。YAGNI）
- **保管ディレクトリと DB の整合はサーバ側の 1 モジュール**（例: `server/src/tasks/evidence-storage.ts`）に閉じる。ファイル書き込み・削除と DB 行の挿入・削除を、この 1 箇所の中でトランザクションと組にする
- **ファイル削除の順序**: DB 行を先に消してからファイルを消す。逆順だと、ファイル削除成功 → DB 削除失敗で「行はあるが実体が無い」孤児行が残る。この順序なら最悪ケースは「実体だけが残る」で、参照されないので表示にも判定にも影響しない
- **孤児ファイルの掃除機構は作らない**（YAGNI）。上記の最悪ケースはローカルの数 MB が残るだけで、機能的な害が無い

### IF / API

並列実装するチケット間で共有が要る境界:

```ts
// server/src/tasks/task-evidence.ts
export const EVIDENCE_KINDS = ["file", "link"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface TaskEvidence {
  id: number;
  task_id: number;
  kind: EvidenceKind;
  stored_filename: string | null;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  created_at: string;
}

/** 拡張子ホワイトリスト（決定 1-c）。判定は小文字化して行う。 */
export const ALLOWED_EVIDENCE_EXTENSIONS: readonly string[];
export const MAX_EVIDENCE_FILE_BYTES: number;   // 10 * 1024 * 1024
export const MAX_EVIDENCES_PER_TASK: number;    // 10
```

```ts
// server/src/tasks/tasks-repository.ts — updateTask の戻り値（決定 2-b）
export type UpdateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "evidence_required" };
```

```ts
// 決定 2-g で 2 箇所から呼ぶ共有述語
export function isEvidenceGateBlocking(
  db: Database.Database,
  input: { taskId: number | null; evidenceRequired: boolean },
): boolean;
```

### データモデル

決定 1-b の `task_evidences` テーブルと `tasks.evidence_required` 列がすべて。これ以外に永続化するものは無い（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 6「算出できるものは保存しない」— エビデンス件数は都度算出する）。

### 実装計画（チケット分解の見通し）

最終的な分解は `/create-ticket` で行う。見通しとしては次の 5 つ:

1. **スキーマ + 設定キー**: マイグレーション v7、`SETTINGS_KEYS` への `evidence_enforcement_enabled` 追加と boolean バリデータ、`readEffectiveSettings` への配線、専用 reader（決定 7）
2. **エビデンスの保管とリポジトリ**: `resolveEvidenceDir`、`CreateAppOptions` への配線、`task_evidences` のリポジトリ、拡張子・サイズ・件数・URL スキームの検証（決定 1）
3. **エビデンス API**: `GET` / `POST` / `GET …/content` / `DELETE` の 4 エンドポイント、`done` 後の削除拒否（決定 1・5）
4. **強制の関門と裁定の保持**: `updateTask` の関門と戻り値変更、`POST /api/tasks` 経路、`evidence_required` の POST/PATCH 受付、`create_task` ツールへの追加、`formatTaskLine` への追加、上書きの `note` 記録（決定 2・3）
5. **web**: 設定トグル、`TaskForm` のチェックボックス、タスク詳細のエビデンス UI、`code` を保持するエラークラスと DnD / チェックインパネルのエラー表示（決定 2-e・2-f・7）

チケット 4 は 1〜3 に依存する。5 は 1〜4 に依存する。1・2 は並列可能。

## 実装時に必ず対処する波及点（型エラーで気付けないものを含む）

- `updateTask` の戻り値変更（決定 2-b）は呼び出し元 3 箇所（`tasks-routes.ts:41` / `task-tools.ts:106` / `checkins-routes.ts:164`）に波及する。前 2 つは型エラーで気付けるが、`checkins-routes.ts` は**戻り値を捨てている**ため型エラーにならない。`done` に到達しない経路なので挙動は変わらないが、レビュー時に見落とさないこと
- `formatTaskLine()`（決定 3-a）の出力は `persona-prompt.test.ts` が文字列で検証している。行の書式を変えると既存テストが落ちる
- `readEffectiveSettings` にキーが増えると、web の `Settings` 型（`web/src/settings.ts:45-61`）と `SettingsView.test.tsx` のフィクスチャに波及する
- `tasks` の各レスポンスに `evidence_required` が増えるため、web の `Task` 型（`web/src/task.ts:13-26`）とタスク系テストのフィクスチャに波及する

## 明示的な仮定

以下は本仕様で置いた仮定であり、受入基準を変えない範囲の軽微・可逆な判断である。実装時に不都合が出たら実装者の判断で変えてよい（変えたらこの節を更新する）。

1. **設定キー名を `evidence_enforcement_enabled` とする**（決定 7-a）。`SETTINGS_KEYS` の既存命名規則に沿った選択であり、他の候補（`evidence_required_on_done` 等）でも規則は満たす
2. **テーブル名を `task_evidences` とする**。Issue #256 本文が候補として挙げた名前をそのまま採り、既存の複数形 snake_case（`tasks` / `activity_events` / `daily_reports`）に揃えた
3. **409 の `code` を `evidence_required` / `task_already_done` とする**。`reports-routes.ts` の `evening_session_required`、`sessions-repository.ts` の `evening_session_already_exists` と同じ形（`<主語>_<条件>` / `<主語>_already_<状態>`）に揃えた。新しい体系は作っていない
4. **上限超過の HTTP ステータスの振り分け**: 入力そのものが不正なもの（サイズ・拡張子・URL スキーム）は 400、既存の状態との衝突（件数上限・`done` 後の削除・エビデンス不足）は 409 とした。既存ルートが形式検証に 400 を使っている慣習に合わせた
5. **`.svg` を画像から除外する**（決定 1-c）。「画像は許可」の文言上は含まれうるが、同一オリジンからのインライン配信でスクリプトが動きうるため、実行可能形式の拒否と同じ理由で外した
6. **ファイルは 1 リクエスト 1 件**とする（`multipart` のフィールド名 `file`）。複数同時アップロードは UI の複雑さに見合わない（YAGNI）。件数上限 10 は複数回の追加で到達する
7. **日報へのエビデンス掲載は本機能のスコープ外**とする（決定 6）。Issue #256 の論点 6 は「渡す範囲の境界を引く」ことであり、掲載自体は要求されていない
8. **`evidence_required` の JSON 表現**: DB は INTEGER だが、API のレスポンス・リクエストでは既存の `tasks` 列と同じく**そのままの値**（`0 | 1`）で扱う。`messages.interrupted` の前例に倣い、boolean への変換層は設定キー（決定 7）にだけ置く

## 受入基準

> 実装時はこの一覧をテストに 1:1 で落とす。時刻・暦日に依存する基準は含まない（非機能要件「暦日非依存」）。

### スキーマ（マイグレーション v7）

- [ ] マイグレーション適用後、`task_evidences` テーブルが存在する
- [ ] マイグレーション適用後、`tasks` に `evidence_required` 列が存在する
- [ ] v7 適用前から存在していた `tasks` 行の `evidence_required` は `0` になる
- [ ] `task_evidences.kind` に `'file'` / `'link'` 以外を INSERT すると CHECK 制約違反で失敗する
- [ ] `task_evidences.task_id` が存在しない `tasks.id` を指す INSERT は外部キー制約違反で失敗する
- [ ] `runMigrations` を 2 回連続で実行しても成功する（冪等）

### 設定

- [ ] `evidence_enforcement_enabled` が未設定のとき `GET /api/settings` は `evidence_enforcement_enabled: false` を返す
- [ ] `PUT /api/settings` に `evidence_enforcement_enabled: true` を送ると、`settings` テーブルに文字列 `"true"` が保存される
- [ ] `PUT /api/settings` で `true` を保存した直後の `GET /api/settings` は `evidence_enforcement_enabled: true` を返す
- [ ] `PUT /api/settings` に boolean 以外（`"true"` / `1` / `null`）を送ると 400 を返す
- [ ] 上記 400 のとき、リクエストに含まれた他のキーも保存されない（既存の all-or-nothing 契約の維持）

### エビデンス要否フラグ（裁定）

- [ ] `POST /api/tasks` で `evidence_required` を省略すると、作成されたタスクの `evidence_required` は `0` になる
- [ ] `POST /api/tasks` に `evidence_required: true` を送ると、作成されたタスクの `evidence_required` は `1` になる
- [ ] `create_task` ツールに `evidence_required: true` を渡すと、作成されたタスクの `evidence_required` は `1` になる
- [ ] `create_task` ツールで `evidence_required` を省略すると `0` になる
- [ ] `PATCH /api/tasks/:id` で `evidence_required` を `1` から `0` に変更できる
- [ ] `evidence_required` を変更する `PATCH` は、`note` に変更内容を含む `task_update` 活動イベントを記録する
- [ ] `evidence_required` を含まない `PATCH` が記録する `task_update` 活動イベントの `note` は `null` のままである
- [ ] ボスチャットのシステムプロンプトのタスク行に、そのタスクのエビデンス要否が含まれる
- [ ] ボスチャットのシステムプロンプトのタスク行に、そのタスクのエビデンス添付件数が含まれる

### 強制（`done` ゲート）

- [ ] 設定 ON・`evidence_required = 1`・エビデンス 0 件のタスクへの `PATCH /api/tasks/:id { status: "done" }` は 409 を返す
- [ ] 上記 409 のレスポンスボディは `code: "evidence_required"` を含む
- [ ] 上記 409 のあと、対象タスクの `status` は `done` に変わっていない
- [ ] 上記 409 のあと、対象タスクの `completed_at` は `null` のままである
- [ ] 上記 409 のあと、`task_update` 活動イベントは記録されていない
- [ ] 設定 OFF なら、`evidence_required = 1`・エビデンス 0 件のタスクを `done` にできる
- [ ] 設定 ON でも、`evidence_required = 0` のタスクはエビデンス 0 件で `done` にできる
- [ ] 設定 ON・`evidence_required = 1` でも、エビデンスが 1 件あれば `done` にできる
- [ ] 設定 ON・`evidence_required = 1`・エビデンス 0 件のタスクを `dropped` にすることはできる
- [ ] 設定 ON・`evidence_required = 1`・エビデンス 0 件で `update_task` ツールを `status: "done"` で実行すると、`isError: true` の結果が返る
- [ ] 上記ツール実行の結果テキストは、エビデンスが不足していることを示す文言を含む
- [ ] 設定 ON・`evidence_required: true`・`status: "done"` を同時に指定した `POST /api/tasks` は 409 と `code: "evidence_required"` を返す
- [ ] 既に `status = "done"` のタスクへの `PATCH { title: "…" }` は、設定 ON・`evidence_required = 1`・エビデンス 0 件でも成功する（遡及しない）
- [ ] `POST /api/checkins` の `task_start` によるステータス遷移は、設定 ON でも 409 にならない（`done` に到達しない経路）

### エビデンスの追加

- [ ] `multipart/form-data` でファイルを `POST /api/tasks/:id/evidences` すると 201 とメタデータが返る
- [ ] 上記の保存後、保管ディレクトリ配下に実ファイルが存在する
- [ ] 保存された `stored_filename` は、リクエストに含まれた元のファイル名と一致しない（サーバ生成名である）
- [ ] `original_filename` にはリクエストに含まれた元のファイル名が保存される
- [ ] `stored_filename` は保管ディレクトリからの相対名であり、パス区切り文字を含まない
- [ ] 10 MB を超えるファイルは 400 と `code: "evidence_file_too_large"` で拒否される
- [ ] ホワイトリスト外の拡張子（`.exe` / `.sh` / `.app` / `.command` / `.scpt`）は 400 と `code: "evidence_extension_not_allowed"` で拒否される
- [ ] `.svg` / `.html` は 400 と `code: "evidence_extension_not_allowed"` で拒否される
- [ ] 拡張子の判定は大文字小文字を区別しない（`.PNG` は許可される）
- [ ] 既にエビデンスが 10 件あるタスクへの追加は 409 と `code: "evidence_limit_exceeded"` で拒否される
- [ ] `{ "url": "https://…" }` を `POST /api/tasks/:id/evidences` すると 201 と `kind: "link"` のメタデータが返る
- [ ] `file:` スキームの URL は 400 と `code: "evidence_url_scheme_not_allowed"` で拒否される
- [ ] `javascript:` スキームの URL は 400 と `code: "evidence_url_scheme_not_allowed"` で拒否される
- [ ] 存在しないタスク id への追加は 404 を返す

### エビデンスの閲覧・削除

- [ ] `GET /api/tasks/:id/evidences` は当該タスクのエビデンスのメタデータ配列を返す
- [ ] `GET /api/tasks/:id/evidences` のレスポンスにファイル本体（バイト列）は含まれない
- [ ] `GET /api/tasks/:id/evidences/:evidenceId/content` はファイル本体を返す
- [ ] 上記レスポンスの `Content-Type` は保存された拡張子から導出される（クライアントが申告した MIME ではない）
- [ ] 上記レスポンスは `X-Content-Type-Options: nosniff` ヘッダを含む
- [ ] 画像・PDF 以外の `content` レスポンスは `Content-Disposition: attachment` を含む
- [ ] `kind: "link"` のエビデンスへの `content` 要求は 404 を返す
- [ ] `DELETE /api/tasks/:id/evidences/:evidenceId` は DB 行を削除する
- [ ] 上記削除のあと、保管ディレクトリの実ファイルも存在しない
- [ ] `status = "done"` のタスクのエビデンス削除は 409 と `code: "task_already_done"` で拒否される
- [ ] 上記 409 のあと、対象のエビデンス行は残っている
- [ ] `done` のタスクを `in_progress` に戻したあとは、同じエビデンスを削除できる

### web

- [ ] 設定画面に「完了報告にエビデンスを必須にする」のチェックボックスがある
- [ ] タスク作成フォームに「エビデンスを必須にする」のチェックボックスがあり、既定は未チェックである
- [ ] タスク詳細でファイルを選択してエビデンスを追加できる
- [ ] タスク詳細で URL を入力してエビデンスを追加できる
- [ ] タスク詳細に添付済みエビデンスの一覧（ファイル名 / URL）が表示される
- [ ] タスク詳細でエビデンスを削除できる
- [ ] タスク詳細で `evidence_required` をトグルできる
- [ ] タスクボードで `done` 列へ DnD して 409 が返ったとき、カードは元の列に表示されたままである
- [ ] 上記のとき、エビデンス不足を示すメッセージが `role="alert"` の要素に表示される
- [ ] チェックインパネルの「完了」ボタンが 409 で失敗したとき、エビデンス不足を示すメッセージが表示される
- [ ] web の API エラーは `code` を保持し、UI はエラー文言ではなく `code` で分岐する

### LLM 境界（決定 6）

- [ ] ボスチャットのシステムプロンプトに、エビデンスファイルの中身が含まれない
- [ ] ボスチャットのシステムプロンプトに、エビデンスの保管パス（`stored_filename`）が含まれない
- [ ] 日報の夕会要約抽出が LLM へ渡す入力に、エビデンスの中身が含まれない

## 関連

- Issue: [#256](https://github.com/masanami/ai-boss/issues/256)
- [ADR 0001: 全データをローカル SQLite に閉じ、外部送信を Anthropic への推論リクエストのみに限定する](../adr/0001-local-only-data-boundary.md)
- [ADR 0004: サボり検知は決定的なルールエンジンで行い、LLM は文面生成のみに使う](../adr/0004-deterministic-detection-engine.md)
- [ADR 0005: SQLite 単一ファイルを唯一の永続化先とし、セッションを第一級の概念として持つ](../adr/0005-sqlite-schema-policy.md)
- [ADR 0006: 生成物の構造はレンダラーが決め、LLM には値だけを出させる](../adr/0006-renderer-owns-structure.md)
- [ADR 0007: 「当日」はサーバーのローカル暦日で統一し、テストはタイムゾーン非依存に書く](../adr/0007-local-calendar-day-basis.md)
- [ADR 0008: 日報の生成には夕会での対話完了を前提条件として課す](../adr/0008-evening-dialogue-prerequisite.md)（409 + 安定 `code` の前例）
