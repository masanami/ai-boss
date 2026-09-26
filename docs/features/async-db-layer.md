# DB 層を非同期 API へ移す（better-sqlite3 → plugin-sql・ADR 0005 改訂）

> **草案（2026-09-26）**: クリティカル設計決定の各節は、親（flywheel エージェント）とオーナーの回答待ちの論点（Q1〜Q5）を含む。「推奨」と書いた案は未確定である。

## 概要

リポジトリ層が受け取る DB を**非同期の DB ポート**に統一し、開発者用の版（Node・better-sqlite3）と製品版（Tauri 2・`@tauri-apps/plugin-sql`）の両方で同じ TS コードが動くようにする。接続プール越しでは同一接続が保証されないため、単一ライターの前提（ADR 0005 決定 5）を「**接続 1 本＋TS 側の直列化層**」で保ち直す。

## 背景・目的

- ADR 0011 決定 17（製品化）: DB は better-sqlite3（同期 API）から plugin-sql（非同期 API）へ移す。better-sqlite3 はネイティブ Node モジュールで WebView では動かないため、#579 S2（Tauri の器）はこの DB 層を前提にする（#579 の機能仕様「#580（DB 層）との境界」）。
- ADR 0011 決定 18（#590・PR #591）: 端末間の同期は一時中継＋暗号化で、衝突解決は端末側で行う。衝突解決の方式と同期向けのスキーマは #580 で扱う（どこまで先回りするかは Q4）。
- 開発者用の版（オーナーが日常利用している Node 版）は移行中も移行後も better-sqlite3 のまま動き続ける。

## ユーザーストーリー

- 開発者として、製品版（Tauri）と開発者用の版（Node）で同じリポジトリ層・ルートのコードを使い、DB の実装だけを差し替えたい。
- オーナーとして、DB 層の作り替えの途中でも、開発者用の版を日常利用し続けたい。

## 実コードの実測（2026-09-26・`main` b81e69b）

| 観点 | 実測 |
|---|---|
| 接続 | `server/src/db/connection.ts` の `openDatabase` だけが better-sqlite3 を値として import する。`PRAGMA foreign_keys = ON` を接続ごとに設定。開発者用の版は `server/src/index.ts` で 1 本だけ開き、`createApp(db, …)` と `startScheduler({ db, … })` に渡す |
| 型としての依存 | 非テストの 48 モジュールが `import type Database from "better-sqlite3"`。`Database.Database` の注釈は非テストに 117 箇所（関数の引数と deps の型） |
| ドライバ固有の API | `prepare` 61 箇所・`lastInsertRowid` 7 箇所・`.changes` 2 箇所・`db.pragma` は `connection.ts` と `migrate.ts` のみ。名前付きパラメータ（`@name`）は使っていない |
| トランザクション | **`db.transaction(` の呼び出しは 9 箇所**（#576 の「10 箇所」は `checkins-routes.ts:143` のコメント行を数えている）。一覧は下の表。**入れ子は 1 組**（`checkins-routes` の外側の中で `updateTask` が内側を張る。better-sqlite3 は SAVEPOINT として合成する）。**どれもトランザクション内で DB 以外の await をしていない** |
| 同期実行に頼った原子性 | `checkins-routes.ts:158-163` は「ハンドラが await を挟まず同期で走る」ことを根拠に、トランザクションの外の読み出し（`findTaskById`・`isNewerThanLatestTransition`）とトランザクション内の書き込みを一体として扱っている。非同期化すると、この読み出しと書き込みの間に別の要求が割り込める |
| スケジューラ | `scheduler-tick.ts` は読み出しと通知の書き込みの間で LLM を await しており、すでに非同期。前回の刻みが走っている間は次の刻みを飛ばす（`createTicker`） |
| 主キー・外部キー | 業務テーブル 10 個（`tasks`・`sessions`・`messages`・`decisions`・`appeals`・`notifications`・`activity_events`・`daily_reports`・`task_evidences`・`meeting_time_overrides`）はすべて `INTEGER PRIMARY KEY AUTOINCREMENT`。外部キーはこの連番を参照する。`settings` は `key TEXT PRIMARY KEY` |
| 更新日時・削除 | `updated_at` を持つのは `tasks`・`daily_reports`・`meeting_time_overrides` の 3 表だけ。物理削除は `task_evidences`・`meeting_time_overrides`・`messages`（発言の書き直し時の切り捨て）の 3 表。墓標（削除の記録）は無い。タスクは削除せず `dropped` へ遷移する |
| マイグレーション | `migrate.ts` が `PRAGMA user_version` を版の目印にし、版ごとに `db.transaction` で囲む（ADR 0005 決定 4）。v4 は `PRAGMA foreign_keys` をトランザクションの外で切り替える。最新は v10 |
| テスト | DB を使うテストは 56 ファイル。`openDatabase(":memory:")`＋`runMigrations` で実 DB を組む（94 箇所）。テストから `db.prepare`/`exec`/`pragma` を直に呼ぶのは 24 ファイル・69 箇所 |
| better-sqlite3 と async | `db.transaction(async () => …)` は `Transaction function cannot return a promise` で拒否される。1 本の接続で `BEGIN` 後に await を挟むと、その間に別の流れが書いた行もトランザクションに入り、`ROLLBACK` で一緒に消える（いずれもローカルで実測） |
| plugin-sql（2.4.1） | Rust 側は `sqlx::Pool::connect(url)` で接続し、**sqlx の既定のプール（最大 10 接続）**になる。`execute`/`select` は呼び出しごとにプールから接続を取る。プールの大きさは TS からも `tauri.conf.json`（`preload` のみ）からも変えられない。`foreign_keys` は sqlx が接続ごとに ON にする（既定）。プラグインのマイグレーション機能は sqlx の `_sqlx_migrations` 表を使い、`user_version` を使わない |
| #576 スパイク | `BEGIN`→`INSERT`→`ROLLBACK` の単発プローブはロールバックが効いたが、同一接続の保証ではない（ブランチ `spike/ios-tauri` の `spikes/tauri/README.md` 項目 2） |

### トランザクション 9 箇所

| # | 箇所 | 中身 | ロールバックの既存テスト |
|---|---|---|---|
| T1 | `server/src/settings/settings-routes.ts:170` | 複数キーの設定の書き込み | 入力検証で拒否したときの「何も保存しない」だけ（DB の書き込み失敗は無し。`settings-routes.test.ts`） |
| T2 | `server/src/tasks/tasks-repository.ts:377` `updateTask` | タスクの UPDATE＋`task_update` イベント | 無し |
| T3 | `server/src/activity/checkins-routes.ts:149` | チェックインのイベント＋状態遷移（T2 を入れ子で呼ぶ） | あり（`checkins-routes.test.ts`） |
| T4 | `server/src/meeting-schedule/meeting-schedule-routes.ts:185` | 会議時刻の上書きの削除・upsert | 無し |
| T5 | `server/src/sessions/sessions-repository.ts:133` `createSession` | 夕会 1 日 1 件の検査＋INSERT | 無し（並行の要求のテストも無い） |
| T6 | `server/src/sessions/chat-messages-route.ts:290` | 発言の書き直し: 切り捨て＋挿入（AC-21） | あり |
| T7 | `server/src/dashboard/boss-comment-cache.ts:64` | ボスのコメントのキャッシュ 3 キー | 無し |
| T8 | `server/src/db/migrate.ts:107` `migrateToV4` | v4 の表の再構築（`foreign_keys` を外で切替） | あり（`migrate.test.ts`） |
| T9 | `server/src/db/migrate.ts:440` | 各版の移行 SQL＋`user_version` | あり（`migrate.test.ts`） |

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] リポジトリ層・ルート・スケジューラ・マイグレーションは、非同期の DB ポートだけを通して DB を使う（S1）
- [ ] 開発者用の版は、非同期の DB ポートの better-sqlite3 実装で、現行どおり起動・動作する（S1）
- [ ] トランザクションはポートの `transaction` で張り、例外でロールバックし、実行中に別の流れの DB 操作を混ぜない（S1）
- [ ] 製品版は、非同期の DB ポートの plugin-sql 実装で、同じリポジトリ層を動かす（S2）
- [ ] ADR 0005 を改訂する（S2・Q3）

## 技術的な制約・方針

- 変更対象: `server/src/db/`（ポート・直列化層・Node 実装・マイグレーション）と、DB を使う全モジュール（非テスト 48 モジュール＋その呼び出し元）・DB を使うテスト 56 ファイル
- 開発者用の版のスキーマは S1 で変えない（オーナーの DB `server/data/ai-boss.db` をそのまま開ける）
- Tauri アプリはオーナーの DB を開かず別の DB で新規に始める（#579 のオーナーの決定 Q3-b）。**2 つの版を同じ DB で同時に動かさない**
- 各スライスの `main` へのマージ時点で、開発者用の版の既存テストが合格し現行どおり起動する（#579 と同じ規律）
- 依存: #579 S2 は本機能の製品版実装（S2）を受け取って `createApp` に渡す。本機能は実行の仕組み（#579・#594）に触れない

## クリティカル設計決定

### 1. トランザクションの同一接続をどう保証するか（Q1・未確定）

- **推奨案（A）**: **接続を 1 本に固定し、TS 側の直列化層でトランザクションを張る**。
  - ドライバ（better-sqlite3 実装・plugin-sql 実装）の責務は「**1 本の接続の上で文を実行する**」ことだけにする。製品版は plugin-sql の Rust 側を fork し、プールの最大接続数を 1 にする（差分は `wrapper.rs` の `Pool::connect` を `PoolOptions::new().max_connections(1)` に替える程度。JS 側の API `@tauri-apps/plugin-sql` はそのまま使う）。
  - 直列化層（TS・ドライバ非依存・両版で共有）が、非同期のロックで**DB 操作を 1 つずつ通す**。`transaction(fn)` はロックを取って `BEGIN IMMEDIATE`→`fn(tx)`→`COMMIT`（例外なら `ROLLBACK`）を行い、終わるまで他の流れの DB 操作を待たせる。`fn` の中では渡された `tx` だけを使う。入れ子の `tx.transaction(fn)` は `SAVEPOINT` で合成する（better-sqlite3 の現行の入れ子の意味を保つ）。
  - **理由**: 9 箇所のトランザクションの中身（夕会 1 日 1 件の検査、変更の有無による `task_update` の記録。いずれも読み→判定→書き）を TS のまま両版で共有できる。1 本の接続でも await の間に別の流れの文が混ざることを実測で確かめたため、プールの大きさだけでなく直列化層が要る。直列化層はドライバに依存しないので、Node の vitest でトランザクションの意味を検証できる。`migrateToV4` の `PRAGMA foreign_keys` の切り替えも接続が 1 本なので成り立つ（プールのままだと別の接続にしか効かない）。
- **代替案**:
  - (B) トランザクションを Rust 側で実行する（9 箇所の本体を Rust コマンドへ移す。#576 README の提案）— 読み→判定→書きのロジックが Rust と TS（開発者用の版）に二重化する。#579 の決定「永続状態と DB 副作用は WebView 内の TS コアが受け持つ」とずれる。
  - (C) 自前の Rust コマンド（rusqlite か sqlx で接続 1 本を保持し、execute/select だけを出す）で plugin-sql を置き換える — fork の上流追従は要らないが、ADR 0011 決定 17 の「`@tauri-apps/plugin-sql` へ移す」の字面から外れる。fork（A）が拒まれた場合の次善。
  - (D) 1 回の `execute` に `BEGIN; …; COMMIT;` を詰める — 条件分岐を含む T3・T5 が書けない。
  - (E) plugin-sql をそのまま使い、TS のロックだけで直列化する — 10 接続のプールでは `BEGIN` と後続の文が別の接続に乗りうる。スパイクで効いたのは偶然である。
- **影響範囲**: `server/src/db/`、トランザクションを張る 9 箇所、製品版の plugin-sql の fork（S2）。

### 2. 同期実行に頼っていた原子性の扱い（Q1 に付随・未確定）

- **推奨案**: 非同期化で割り込めるようになる「トランザクションの外で読み、中で書く」箇所は、**読み出しもトランザクションの中へ入れる**。実測で確認したのは `checkins-routes.ts`（T3）で、ほかの箇所は S1 の実装で洗い出す（ハンドラ内で読み出しの結果を根拠に書き込む箇所）。
- **理由**: 現行の正しさは「await を挟まない」ことに依存しており、非同期化すると黙って壊れる。
- **代替案**: 何もしない — 単一利用者のため割り込みはまれだが、製品版では IPC を挟むため 1 操作ごとに割り込みの機会が生じる。

### 3. Node 版と Tauri 版の両立の形（Q2・未確定）

- **推奨案**: リポジトリ層を**非同期の DB ポートに統一**し、開発者用の版は better-sqlite3 を包む実装を使う（同期の結果を Promise で返す）。製品版は plugin-sql（fork）を包む実装を使う。ポートの境界は「文を実行する」「行を読む」「トランザクションを張る」の 3 種に絞り、better-sqlite3 固有の API（`prepare` の再利用・`pragma` の戻り値の形・`lastInsertRowid` の bigint）はポートに出さない。
- **移行中に Node 版を壊さない順番**: S1 は統合ブランチ（`feat/issue-{親Issue番号}`）で進め、`main` への昇格は S1 全体を 1 本で行う。非同期化は呼び出し元へ波及する（非同期の関数を呼ぶ関数も非同期になる）ため、統合ブランチ上でも子 PR ごとに開発者用の版の既存テストが合格する順（ポートと直列化層 → マイグレーション → 葉のリポジトリから呼び出し元へ）で分ける。
- **代替案**: 版ごとにリポジトリ層を持つ（同期版と非同期版）— 163 個相当の関数が二重化し、DRY に反する。

### 4. マイグレーションの置き場所（ADR 0005 決定 4 を維持）

- **採用案（決定 4 の維持として扱う）**: 両版とも `migrate.ts`（`user_version`・版ごとのトランザクション）をポート経由で走らせる。plugin-sql のマイグレーション機能（`_sqlx_migrations`）は使わない。
- **理由**: 版の目印を 2 種類にしない。v4 のように `foreign_keys` をトランザクションの外で切り替える手順は、plugin-sql のマイグレーション機能では表せない。

### 5. 同期に向けたスキーマの先回り（Q4 ★・未確定）

- **推奨案（i）**: 本機能では**同期向けのスキーマ変更をしない**。ポートの設計で、将来 ID を端末で生成する（連番に頼らない）形を妨げないことだけを守る（ポートは挿入した行の ID を返せるが、呼び出し元が ID を渡して挿入することも妨げない）。
- **代替案**: (ii) スキーマの準備だけ行う（全表に端末をまたいで衝突しない ID・`updated_at`・墓標を足す）／(iii) 衝突解決まで行う。判断材料は完了報告の Q4 を参照。

## 機能全体の設計

### アーキテクチャ決定

- `server/src/db/` に、非同期の DB ポート（型）・直列化層・better-sqlite3 実装を置く。製品版の plugin-sql 実装は S2 で足す（置き場所は #579 の「実行環境に依存しないコア」と「Node の周辺」の分け方に従う。better-sqlite3 実装は Node の周辺）。
- `createApp`・`startScheduler`・各ルートの工場関数は、ポートを受け取る。

### IF / API（ポートの契約・S1 で固定する）

- `run(sql, params)`: 書き込み文を実行し、変更件数と挿入した行の ID（数値）を返す。
- `get(sql, params)` / `all(sql, params)`: 行を読む（無ければ `undefined` / 空配列）。
- `exec(sql)`: パラメータの無い複数文を実行する（マイグレーション用）。
- `transaction(fn)`: 上記「クリティカル設計決定 1」の意味で `fn(tx)` を実行し、その戻り値を返す。`tx` はポートと同じ操作を持つ（入れ子の `transaction` を含む）。
- パラメータは位置指定（`?`）に統一する（現行コードは名前付きを使っていない）。

### 実装計画（S1 のチケット分解の見通し）

1. ポート・直列化層・better-sqlite3 実装と、その契約テスト（ロールバック・割り込み・入れ子）
2. マイグレーション（T8・T9）の非同期化
3. リポジトリ層とルートの非同期化（領域ごと。T2 と T3 は入れ子のため同じチケット）
4. 同期実行に頼っていた箇所の洗い出しと、読み出しのトランザクション内への移動

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 非同期の DB ポート・直列化層・better-sqlite3 実装を入れ、開発者用の版のリポジトリ層・ルート・スケジューラ・マイグレーション・DB テストをすべてポート経由にする。トランザクション 9 箇所の原子性をポート経由でテストに固定する | 100-130 | これだけで価値が出る（TS コアが DB のドライバに依存しなくなり、#579 S1 の「コアの Node 依存の切り離し」の DB 分が片付く。トランザクションの意味が両版共通のテストで固定される） |
| S2 | 製品版の plugin-sql 実装（Rust 側の fork で接続 1 本）と、S1 の契約テストを Tauri 上で通す仕組み。ADR 0005 の改訂 | 10-20 | S1 がマージされてから（Tauri の器との順序は Q5） |

実装対象: S1

## やらないこと

- 端末間の同期の実装（中継・暗号化・ペアリング・衝突解決）（理由: ADR 0011 決定 18 の実装は別 Issue。本機能はスキーマの先回りの要否だけを扱う〔Q4〕）
- 開発者用の版のスキーマ変更とデータ移行（理由: S1 はポートの差し替えだけを行い、オーナーの DB をそのまま開けることを保つ）
- Node 版の DB から Tauri アプリへのデータ移行（理由: #579 のオーナーの決定 Q3-b。Tauri アプリは新しい DB で始める）
- 実行の仕組みの作り替え（Tauri の器・スケジューラ・通知）（理由: #579・#594 の範囲）
- Rust 通信層・BYOK・LLM プロバイダの抽象化・予約通知方式・バックアップと端末移行（理由: #581・#582・#585・#588 の範囲）
- 複数プロセス・複数端末から同じ DB ファイルへの同時書き込み（理由: 端末内は単一ライターを保つ。端末間は同期の層で扱う）

## 受入基準（S1）

- [ ] AC-1: 製品コード（`*.test.ts` とテスト専用の補助モジュールを除く）で `better-sqlite3` を import するのは better-sqlite3 実装のモジュールだけである（型としての import を含む）
- [ ] AC-2: `transaction` の中で例外が投げられると、その中で行った書き込みはすべて残らず、例外は呼び出し元へ伝わる
- [ ] AC-3: `transaction` の実行中（中で DB 以外の await をしている間を含む）に別の流れが発行した書き込みは、トランザクションに入らず、トランザクションが終わってから実行される（トランザクションをロールバックしても、その書き込みは残る）
- [ ] AC-4: 入れ子の `transaction` で内側が例外を投げたとき、内側の書き込みだけが戻り、外側がその例外を捕まえて続ければ外側の書き込みはコミットされる
- [ ] AC-5: 設定の一括更新（T1）で途中の書き込みが失敗すると、どのキーも更新されない
- [ ] AC-6: `updateTask`（T2）で `task_update` イベントの記録が失敗すると、タスクの更新も残らない
- [ ] AC-7: チェックイン（T3）で状態遷移の更新が失敗すると、チェックインのイベントも残らない
- [ ] AC-8: 同じ `todo` のタスクへの `task_start` のチェックインを 2 件並行に送ると、`in_progress` への遷移の `task_update` イベントは 1 件だけ記録される
- [ ] AC-9: 会議時刻の上書きの更新（T4）で途中の操作が失敗すると、どの上書きも変わらない
- [ ] AC-10: 同じローカル日の夕会の作成要求（T5）を 2 件並行に送ると、夕会は 1 件だけ作られ、もう 1 件は `evening_session_already_exists` になる
- [ ] AC-11: 発言の書き直し（T6）で挿入が失敗すると、切り捨ても残らない
- [ ] AC-12: ボスのコメントのキャッシュの保存（T7）で途中の書き込みが失敗すると、3 キーのいずれも更新されない
- [ ] AC-13: v4 のマイグレーション（T8）が失敗すると、DB は v3 のまま残り、`foreign_keys` は ON に戻る
- [ ] AC-14: 各版のマイグレーション（T9）が失敗すると、その版の変更は残らず `user_version` は直前の版のまま残る
- [ ] AC-15: S1 のマイグレーションの最新の版は 10 のままである（開発者用の版のスキーマを変えない）
- [ ] AC-16: DB を使う既存のテストは、ポートの better-sqlite3 実装（`:memory:`）の上で合格する

## 仮定（軽微・可逆）

- A1: テストから DB を直に触る 24 ファイル・69 箇所は、better-sqlite3 実装が持つテスト用の生の接続を使ってよい。製品コード（`*.test.ts` とテスト専用の補助モジュール以外）からは使わない
- A2: `BEGIN IMMEDIATE` を使う（接続 1 本では DEFERRED と差は無いが、将来の複数接続で書き込みロックの取り損ねを避ける）
- A3: 仕様のファイル名は `async-db-layer.md` とする
