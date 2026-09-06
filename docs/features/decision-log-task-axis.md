# 進言（appeals）の削除と決定ログのタスク軸再構成

> **正はコードとテスト**であり、本ファイルは権威を持たない（`CLAUDE.md`「開発方針」）。実装と食い違う場合はコードが正。本ファイルは実装を駆動するための作業文書である。
>
> 対象 Issue: #358

## 概要

使われていない進言（appeals）機能をアプリから一括で完全に削除し、あわせて決定ログ画面を「時系列のフラット表示」から「タスクごとに束ねた表示」へ組み替える。同時に、後続の #276（仕事の進め方のメンタリング）が記録先として使う `decisions.kind` 列を追加し、画面がその種別を扱える形にしておく。

## 背景・目的

### 進言を削除する理由はチャットによる代替であって、メンタリング（#276）ではない

進言は「ユーザー → ボスへの異議申し立て」の専用経路として作られたが、実際には使われていない。決定に異議がある場合はチャット欄で伝えており、そちらで用が足りている。

ボスの応答規律（`server/src/boss/persona-prompt.ts` の `buildPersonaPrompt` が積む「応答の規律」節）は `purpose` を問わず入るため、**`record_decision` はチャットでも呼ばれる**。つまりチャットの中で裁定を問い直し、ボスが新しい決定として記録し直す経路が既にある。進言固有の価値は「どの決定への異議か」の紐付けと `verdict`（`upheld` / `revised`）の構造化だけであり、使っていない以上、維持コスト（テーブル・API・`verdict-tool`・UI・テスト）のほうが大きい。

**#276 のメンタリングは「ボス → ユーザーの指導」であり、進言の「ユーザー → ボスの異議」とは向きが逆で包含関係にない。** 進言を落とす根拠をメンタリングに求めない（#276 の側に異議申し立ての経路を作る必要も無い）。この区別を記録しておかないと、後から「メンタリングがあるから進言は要らなくなった」という誤った経緯が定着し、#276 の設計にも影響する。

### ステータスバッジが無意味になる

`updateDecisionStatus` の呼び出し元は `server/src/decisions/appeals-route.ts` の 1 箇所だけである。ここから 2 点が従う。

1. `decisions.status` の `withdrawn` は**現時点で既にどこからも書かれていない**（死んだ値）。
2. `insertDecision` は `status` を `'active'` 固定にしているため、**進言を消すと `decisions.status` は永久に `active` だけになる**。

したがって決定ログのステータスバッジ（`web/src/DecisionLog.tsx` の `STATUS_LABEL`）は、常に「有効」しか出ない飾りになる。タスク軸への再構成にあわせて落とす。

### タスク軸で追いたい理由

現状の決定ログは時系列のフラット表示で、関連タスクを `関連タスク: #12` と生 ID で出しているだけである（`web/src/DecisionLog.tsx`）。「このタスクについてボスは何をどう決めたか」を辿る手段が無い。

さらに #276 は各タスクの進め方を点検し、その観点と結論を記録する。**#276 の完了条件「メンタリングで扱った観点と結論が後から参照できる」の参照面は、本 Issue が作るタスク軸のログである**（オーナー決定・2026-09-06）。参照面の形を先に確定させるため、本 Issue を #276 より先に定義する。

`decisions` テーブルは既に `task_id INTEGER REFERENCES tasks(id)`（nullable）を持つため、**タスク軸のグルーピング自体はマイグレーション不要**である。

## ユーザーストーリー

セルフマネジメント中のユーザーとして、決定ログをタスクごとに束ねて読み、そのタスクについてボスが下した決定（および後続 #276 で入るメンタリングの結論）を一続きの流れとして辿りたい。

## 機能要件

- [ ] 決定ログ画面から進言の導線（ボタン・フォーム・履歴表示）が無くなる
- [ ] 進言の API・ツール・テーブル・型が、アプリのどこにも残らない
- [ ] 決定ログのステータスバッジが表示されない
- [ ] 決定がタスクごとに束ねて表示され、タスク名で辿れる
- [ ] タスクに紐づかない決定にも置き場がある
- [ ] 記録の種別（決定／メンタリング）を保持でき、画面がそれを判別して表示できる
- [ ] 既存の「決定の表示・取得」契約（新しい順に全件返す・0 件時の表示）が壊れない

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono + better-sqlite3 / Vite + React + TypeScript）
- 変更対象:
  - 削除: `server/src/decisions/appeals-route.ts` / `appeals-repository.ts` / `appeals-validation.ts` / `appeal.ts` / `verdict-tool.ts` と各テスト
  - `server/src/db/migrate.ts`（マイグレーション v7 の追加）・`server/src/db/migrate.test.ts`
  - `server/src/decisions/decisions-routes.ts`・`decisions-repository.ts`・`decision.ts` と各テスト
  - `server/src/llm/backends/claude-code-backend.ts`（`submit_verdict` の Zod シェイプと専用ハンドラ）と `claude-code-backend.test.ts`
  - `server/src/llm/backends/api-backend.test.ts`（`submit_verdict` を題材にしているテストの題材差し替え）
  - `server/src/app.ts`（`createDecisionsRouter` の引数から進言用の `env` / `llmBackend` が不要になる場合）
  - `web/src/DecisionLog.tsx` / `DecisionLog.css` / `decision.ts` / `decisions-api.ts` / `use-decisions.ts` と各テスト
  - `web/src/AppLayout.tsx`（画面名を変えない決定のため変更なし。判断 4 参照）
- **`requestVerdict`（`server/src/llm/claude-client.ts`）は削除しない。** 名前に反して「ツール 1 本を強制する 1 往復の汎用ヘルパー」であり、**日報生成の値抽出（`server/src/reports/extract-evening-summary.ts`）が現に使っている**。削除対象は `submit_verdict` **ツール**であって、このヘルパーではない。名前だけを頼りに消すと日報生成が壊れる。
- 検知エンジン・通知・日報・作業ログには触れない。
- テストの時刻固定はローカル日付基準で組む（[ADR 0007](../adr/0007-local-calendar-day-basis.md) 決定 5）。本 Issue は暦日境界に依存する変更を含まないため、`created_at` の並び順を固定するテストでは相対的な前後関係のみを検証する。

## 画面・API設計

### 決定ログ画面（`web/src/DecisionLog.tsx`）

タスクごとのセクションを縦に並べる。セクション見出しはタスク名。開閉（アコーディオン）は持たない。

```text
決定ログ
├─ 見積もり資料の作成                （タスク名 = セクション見出し）
│   ├─ [決定]      2026-09-06 09:12  今日はこれを最優先で片付けろ
│   │              根拠: 締切が明日で、他タスクは着手済み
│   └─ [メンタリング] 2026-09-06 09:05  着手前に前提を確認していない  ← #276 で入る
├─ 週次レポート
│   └─ [決定]      2026-09-05 09:20  今日は着手のみ・完了は明日でよい
└─ タスクに紐づかない決定             （task_id が NULL のもの。常に末尾）
    └─ [決定]      2026-09-05 18:30  明日の朝会は 9:30 に変更する
```

- セクションの並び: そのセクションが持つ**最新の記録の `created_at`** が新しい順。`task_id` が NULL の記録を集めたセクションは、この並びに関わらず常に末尾に置く。
- セクション内の並び: 既存契約どおり新しい順（`created_at` 降順・同値は `id` 降順）。
- 種別ラベル: 各記録に `kind` のラベル（`decision` → 「決定」／ `mentoring` → 「メンタリング」）を付ける。
- ステータスバッジ（`STATUS_LABEL`）は表示しない。
- 記録が 0 件のときは既存どおり「決定はまだありません」を出す。

### `GET /api/decisions`

`appeals` フィールドを持たないフラットな配列を、既存どおり新しい順（`created_at` 降順・`id` 降順）で返す。グルーピングはクライアント側で行う。

```jsonc
// GET /api/decisions → 200
[
  {
    "id": 12,
    "session_id": 3,
    "task_id": 5,
    "task_title": "見積もり資料の作成",  // 追加。task_id が NULL なら null
    "content": "今日はこれを最優先で片付けろ",
    "rationale": "締切が明日で、他タスクは着手済み",
    "kind": "decision",                   // 追加
    "status": "active",                   // 残す（判断 5 参照）
    "created_at": "2026-09-06T09:12:00.000Z"
  }
]
```

### 削除する API

- `POST /api/decisions/:id/appeals` — ルートごと削除する（以後 404）。

## クリティカル設計決定

### 判断 1: タスク軸ビューの形（論点 1）

- **採用案**: **タスクごとのセクションに束ねて縦に並べる。全期間を対象とし、期間の絞り込み UI もタスク選択による絞り込みも持たない。** 開閉（アコーディオン）も持たない。
- **理由**:
  - 「このタスクについてボスは何を決めたか」と「最近どんな決定があったか」を 1 画面で同時に満たせる。タスク選択による絞り込みは前者しか満たさず、俯瞰が消える。
  - 決定は日をまたいで効き続けるため（前日に決めた優先順位は今日も効く）、「今日のみ」は参照面として弱い。当日の俯瞰はダッシュボードと日報が既に担っている。
  - 既存の `GET /api/decisions` は無ページングの全件返却であり（`listDecisions`）、全期間表示はその契約とそのまま噛み合う。件数が増えて読みづらくなったら、そのとき折り畳み・絞り込みを別 Issue で足す（YAGNI）。
- **代替案**:
  - **タスク選択で絞り込む（1 タスクずつ表示）** — 却下。上記のとおり俯瞰が失われ、「どのタスクを選ぶか」を先に決めないと何も読めない。
  - **今日のタスクのみに限定する** — 却下。過去の決定を追えなくなり、進言廃止で失われる「決定を問い直す」経路の代わりにもならない。
  - **セクションを折り畳み可能にする** — 見送り。単一ユーザーのローカルアプリで、決定は 1 日数件の規模。開閉状態という UI 状態を増やすコストが現時点で見合わない。
- **影響範囲**: `web/src/DecisionLog.tsx`・`DecisionLog.css`・`DecisionLog.test.tsx`。グルーピングは純粋関数（例: 記録の配列 → セクションの配列）として切り出し、ユニットテストで並び順を固定する。

### 判断 2: `task_id` が NULL の決定の扱い（論点 2）

- **採用案**: **「タスクに紐づかない決定」という専用セクションを設け、常に末尾に置く。**
- **理由**:
  - `record_decision` ツールの `task_id` は任意項目であり、朝会の時間変更のようにタスクへ紐づかない裁定は**恒常的に発生する**。非表示にすると、記録されているのに画面から永久に見えない決定が生まれる。
  - 末尾固定にすることで、タスク軸のセクションの並び規則（最新の記録が新しい順）に例外的な割り込みが入らない。
- **代替案**:
  - **非表示にする** — 却下。上記のとおり記録が失われて見える。
  - **先頭に置く／時系列で他のセクションと混ぜて並べる** — 却下。「タスクを辿る」という画面の主目的に対し、タスクに紐づかない箱が上位に来るのは筋が悪い。
- **影響範囲**: グルーピング純粋関数の並び規則。

### 判断 3: `decisions.kind` 列を本 Issue のマイグレーションに含める（論点 3・#276 との境界）

- **採用案**: **本 Issue のマイグレーション v7 で `DROP TABLE appeals` と同時に `decisions.kind` を追加する。** 表示は**同一タスクのセクション内で決定とメンタリングを時系列に混在させ、種別ラベルで区別する**。

  ```sql
  DROP TABLE appeals;
  ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'decision'
    CHECK (kind IN ('decision', 'mentoring'));
  ```

- **理由**:
  - **`decisions` の再構築が要らない。** SQLite の `ALTER TABLE ... ADD COLUMN` は CHECK 制約付きの列追加を受理する（本 Issue の定義時に better-sqlite3 で実測確認済み: 既存行に DEFAULT 値が入り、以後の INSERT で CHECK が効く）。よって [ADR 0005](../adr/0005-sqlite-schema-policy.md) の 12-step 再構築手順（`migrateToV4`）は不要で、`PRAGMA foreign_keys` のトグルも不要。既存の文字列マイグレーション（version 単位の単一トランザクション）としてそのまま書ける。
  - **#276 が参照面の UI を作り直さずに済む。** 画面が最初から `kind` を扱えていれば、#276 は `kind='mentoring'` の行を書く経路を足すだけで完了条件「扱った観点と結論が後から参照できる」を満たす。列追加を #276 側に回すと、マイグレーションが 2 回に分かれるうえ、本 Issue で作ったばかりの表示ロジックを #276 が再度改修することになる。
  - **時系列混在にするのは、メンタリングと決定が同じタスクの上で因果を持つため。** 「進め方を点検した（メンタリング）→ その結果こう決めた（決定）」という流れは、同じセクションの中で時系列に読めて初めて意味を持つ。種別で分けると、この対応関係が読み手の推測に落ちる。区別は種別ラベルで足りる。
- **YAGNI との関係（意図的な受容）**: 本 Issue の時点で `kind='mentoring'` を**書く**経路は存在しない。列と表示だけが先に入る。これは Issue #358 本文の「本 Issue のビューは #276 の前提で拡張しやすい形にする」という指示に沿った意図的な先行実装であり、上記のとおり分割したときのコストのほうが大きいという判断による。ただし**本 Issue で足すのは `kind` 列と表示のみ**とし、メンタリングを記録するツール・API・プロンプトはいっさい足さない（それらは #276 の責務）。
- **代替案**:
  - **`kind` を #276 のマイグレーションで足す** — 却下。上記のとおりマイグレーションが 2 回・表示ロジックの改修が 2 回になる。
  - **種別ごとにセクションを分ける（同一タスク下で決定とメンタリングを別リストにする）** — 却下。上記の因果が読めなくなる。
  - **専用テーブル `mentorings` を新設する** — 却下（オーナー決定済み・#276 の判断ポイント 5）。JOIN とビューが増える。
- **影響範囲**: `server/src/db/migrate.ts`（v7）・`migrate.test.ts`・`server/src/decisions/decision.ts`・`web/src/decision.ts`・`DecisionLog.tsx`。`insertDecision` は `kind` を明示せず DEFAULT に委ねる（`status` を `'active'` 固定にしている既存の書き方と同じ形。#276 がメンタリング用の書き込み経路を足すときに `kind` を明示する）。

### 判断 4: 画面名は変えない（論点 4）

- **採用案**: **ナビゲーションのラベルは「決定ログ」のまま変えない**（`web/src/AppLayout.tsx` の `NAV_ITEMS`・`aria-label`）。
- **理由**:
  - 本 Issue の時点で画面が実際に持つのは決定だけである。まだ入っていない内容（メンタリング）に合わせて先に改名すると、画面名と中身が一時的に食い違う。
  - 隣接するタブに既に「作業ログ」があるため、「タスクログ」「タスク別ログ」といったタスク軸を含む名前は、機械的な事実列挙である作業ログとの取り違えを招く。
  - 改名はラベル・`aria-label`・該当テストの文言だけで完結し、後から行っても安い。**#276 でメンタリングが実際に画面へ入る時点で、内容に即した名前を決め直す**（#276 側の検討事項として引き継ぐ）。
- **代替案**:
  - **本 Issue で「タスクログ」等へ改名する** — 見送り。上記の取り違えリスクと、中身の先取りになる点。
  - **本 Issue で「ボスの記録」等の種別中立な名前へ改名する** — 見送り。「タスク軸で辿れる」という本 Issue の変更点が名前から落ちる。
- **影響範囲**: なし（変更しないため）。

### 判断 5: `GET /api/decisions` の応答形（論点 5）

- **採用案**: **`DecisionWithAppeals` を廃止し、`DecisionRecord`（DB 行そのまま）に `task_title` を足したフラットな配列を返す。** `status` は応答に残す。グルーピングはクライアントが行う。
- **理由**:
  - `appeals` フィールドは進言の削除で存在意義ごと消えるため、型を 2 つ持つ理由が無くなる。`DecisionRecord` 1 本へ統合する。
  - **`task_title` はサーバー側の `LEFT JOIN tasks` で解決する。** 画面がタスク名を出すには対応関係が要るが、`DecisionLog` は現在タスク一覧を持っておらず、`AppLayout` から `tasksState` を配線するとタスク取得の成否に決定ログの表示が従属する。1 クエリの JOIN のほうが単純で、`useTasks` の取得範囲（何を返すか）にも依存しない。
  - **`status` は残す。** UI は参照しなくなるが、列は残り（CHECK 制約を変えないため）、行をそのまま返すという既存の素直な形を崩してまで射影を増やす利得が無い。
  - **グルーピングをサーバーでやらない。** 応答は行の列挙にとどめ、画面の構造は描画側が決める（[ADR 0006](../adr/0006-renderer-owns-structure.md) 決定 1 と同じ考え方。ADR 自体は Markdown 生成の話だが、「構造は表示側の責務」という切り分けは共通）。並び替え・見出しの持ち方を変えるたびに API 契約を変えずに済む。
- **代替案**:
  - **サーバーがタスクごとにグルーピングした入れ子構造で返す** — 却下。表示の都合が API 契約に染み出し、判断 1 の見直し（折り畳み・絞り込みの追加）のたびに契約変更が要る。
  - **`task_title` を返さず、クライアントが `useTasks` と突き合わせる** — 却下。上記のとおり従属関係が増える。
  - **`status` を応答から落とす** — 見送り。落としても害は無いが、`SELECT *` 相当の素直な形が崩れるだけで得るものが無い。
- **影響範囲**: `server/src/decisions/decisions-routes.ts`・`decisions-repository.ts`（`listDecisions` に JOIN を足す）・`decision.ts`・`decisions-routes.test.ts`／`web/src/decision.ts`・`decisions-api.ts`・`use-decisions.ts` と各テスト。

## 機能全体の設計

### 削除の範囲（実コードで確認済み）

| 対象 | 扱い |
|---|---|
| `server/src/decisions/appeals-route.ts` / `appeals-repository.ts` / `appeals-validation.ts` / `appeal.ts` / `verdict-tool.ts` | ファイルごと削除（各 `*.test.ts` も） |
| `server/src/decisions/decisions-routes.ts` の `registerAppealsRoute` 呼び出し・`listAppealsGroupedByDecisionId` | 削除 |
| `server/src/llm/backends/claude-code-backend.ts` の `submitVerdictShape` / `TOOL_ZOD_SHAPES.submit_verdict` / `NON_EXECUTING_TOOL_NAMES` の `submit_verdict` / `buildSubmitVerdictTool` / `buildMcpServer` の分岐 | 削除。`submit_evening_summary` 側は残す |
| `server/src/llm/backends/api-backend.test.ts` の `submit_verdict` を題材にしたテスト | 題材を `submit_evening_summary` へ差し替える（テストが検証しているのは「ツールを 1 本強制する経路」であって進言ではない） |
| `server/src/llm/claude-client.ts` の `requestVerdict` | **残す**（日報生成が使用中）。進言に言及するコメントのみ整理する |
| `appeals` テーブル | v7 で `DROP TABLE` |
| `web/src/decision.ts` の `Appeal` / `AppealVerdict` / `APPEAL_VERDICTS` / `AppealSubmitResult` / `DecisionWithAppeals` | 削除（`DecisionRecord` へ統合） |
| `web/src/decisions-api.ts` の `submitAppeal`・`use-decisions.ts` の `appeal` | 削除 |
| `web/src/DecisionLog.tsx` の進言 UI・`STATUS_LABEL` / `VERDICT_LABEL`・`DecisionLog.css` の該当スタイル | 削除 |

### マイグレーション v7

- 既存 version（1〜6）の定義は書き換えない（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4）。v7 を追加する。
- v7 は**文字列エントリ**として書く（`migrateToV4` のような関数エントリにしない）。`DROP TABLE appeals` は子テーブルの削除であり（`appeals` を参照する表は無い）、`ALTER TABLE ... ADD COLUMN` も表の再構築ではないため、`PRAGMA foreign_keys` のトグルを必要としない。よって既存の「version 単位の単一トランザクション」でそのまま原子適用できる。
- `migrate.test.ts` の扱いは「そのテストがどの時点の状態を検証しているか」で分ける。
  - **全 migration 適用後の最終状態**を検証しているもの（`creates the appeals table` / `gives appeals a nullable response column (v2)` / `accepts appeals.verdict = %s` / `rejects an invalid appeals.verdict` / 冪等性テストのテーブル一覧）→ v7 後の状態に更新する（`appeals` が存在しないこと・テーブル一覧から除外）。
  - **古い DB を模した固定スキーマ**（テスト冒頭で手書きされている旧スキーマの `CREATE TABLE ... appeals`）→ そのまま残す。v7 適用前の DB を再現するための入力であり、変えると「旧 DB からの引き上げ」を検証できなくなる。
  - 追加するもの: `decisions.kind` の存在・既定値・CHECK 制約、v7 適用後に `appeals` が消えること、二重実行が例外にならないこと。

### 実装計画（チケット分解の見通し・案）

`/create-ticket` で最終決定する前提の案。順序に依存があるため直列に進める。

1. **サーバー: 進言の削除とマイグレーション v7** — 進言関連ファイルの削除、`decisions-routes.ts` の縮小、`claude-code-backend.ts` の `submit_verdict` 除去、v7 追加、`migrate.test.ts` 更新。
2. **サーバー: `GET /api/decisions` の応答形** — `listDecisions` に `LEFT JOIN tasks` を足し `task_title` / `kind` を返す。`decisions-routes.test.ts` を新契約へ更新。
3. **web: 型と API クライアントの縮小** — `decision.ts` / `decisions-api.ts` / `use-decisions.ts` から進言を除き、`DecisionRecord` へ統合。
4. **web: 決定ログのタスク軸再構成** — グルーピング純粋関数の追加、`DecisionLog.tsx` の書き換え（セクション表示・種別ラベル・ステータスバッジ削除）、`DecisionLog.test.tsx` の更新。

## 受入基準

### 進言の削除

- [ ] 決定ログ画面のどの決定にも、進言の操作（「進言する」ボタン・進言フォーム）が表示されない
- [ ] 決定ログ画面に進言履歴（`aria-label="進言履歴"` のリスト）が表示されない
- [ ] `POST /api/decisions/:id/appeals` が 404 を返す
- [ ] 全マイグレーション適用後のテーブル一覧に `appeals` が含まれない
- [ ] `TOOL_ZOD_SHAPES` に `submit_verdict` が含まれない
- [ ] `submit_evening_summary` を強制する 1 往復の呼び出し（日報の値抽出）が従来どおり動作する
- [ ] `decisions.status` の CHECK 制約が `active` / `revised` / `withdrawn` の 3 値を受理する（変更されていない）
- [ ] 決定ログ画面にステータスバッジ（「有効」等）が表示されない

### マイグレーション v7

- [ ] 全マイグレーション適用後の `PRAGMA user_version` が 7 になる
- [ ] `decisions` テーブルに `kind` 列が存在する
- [ ] v7 適用前に存在した `decisions` の行の `kind` が `'decision'` になる
- [ ] `kind` に `'decision'` / `'mentoring'` 以外の値を INSERT すると CHECK 制約で拒否される
- [ ] `runMigrations` を 2 回続けて実行しても例外にならない（冪等）
- [ ] 途中の version が失敗した場合に `user_version` が直前の version のまま残る（既存のロールバック検証が引き続き pass する）
- [ ] `record_decision` ツール経由で作成された決定の `kind` が `'decision'` になる

### `GET /api/decisions` の応答形

- [ ] 応答の各要素が `appeals` フィールドを持たない
- [ ] 応答の各要素が `kind` を持つ
- [ ] `task_id` を持つ決定の応答要素が、その `tasks.title` を `task_title` として持つ
- [ ] `task_id` が NULL の決定の応答要素が `task_title: null` を持つ
- [ ] 応答が `created_at` 降順（同値は `id` 降順）で並ぶ（既存契約の維持）

### タスク軸の表示

- [ ] 同じ `task_id` を持つ決定が 1 つのセクションにまとまって表示される
- [ ] 各セクションの見出しにタスク名（`tasks.title`）が表示される（生の `task_id` ではない）
- [ ] `task_id` が NULL の決定が「タスクに紐づかない決定」セクションに表示される
- [ ] 「タスクに紐づかない決定」セクションが常に最後に表示される
- [ ] セクション内の記録が新しい順（`created_at` 降順・同値は `id` 降順）に並ぶ
- [ ] タスクのセクション同士が、そのセクションの最新の記録の `created_at` が新しい順に並ぶ
- [ ] `kind` が `'mentoring'` の記録が、同じ `task_id` のセクション内に他の記録と時系列で混在して表示される
- [ ] 各記録に種別ラベル（`decision` → 「決定」／`mentoring` → 「メンタリング」）が表示される
- [ ] 記録が 0 件のとき「決定はまだありません」が表示される（既存挙動の維持）

### 品質ゲート

- [ ] `npm run lint` / `npm run typecheck` / `npm test` がすべて pass する
