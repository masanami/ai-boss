# 実行の仕組みを Tauri 2 アプリ内へ作り替える（Node サーバー常駐の廃止・開発者用版の除外）

> Issue #579。2026-09-26 に論点 Q1〜Q5 を確定した（親の回答とオーナーの回答。オーナーの回答は「オーナーの決定」節に原文のまま引用する）。

## 概要

製品版の土台を Tauri 2 にするため、Node サーバーの常駐をやめ、TypeScript のコア（検知・ボスの人格・ツール・レポート）をアプリ内で動かす形へ実行の仕組みを作り替える（[ADR 0011](../adr/0011-productization-architecture.md) 決定 5〜7）。開発者用の版（`claude-code` バックエンド・`server/.env`）は現行の Node サーバー版として残し、製品版（Tauri アプリ）には含めない（[ADR 0003](../adr/0003-llm-backend-isolation.md) 改訂）。

## 背景・目的

- iOS / Android では Node サーバーを常駐させられず、Tauri のサイドカーもデスクトップ専用（tauri#9774）。サイドカー同梱は ADR 0011 で不採用。
- 作り直すのは実行の仕組みだけで、検知ロジック・人格・画面は流用する。#576 の検証（ブランチ `spike/ios-tauri` の `spikes/tauri/`）で、検知エンジンのテスト 216/216 件が WKWebView 上で変更なしに合格し、既存の React 画面が表示できた。
- オーナーは現行版（`npm run start`・`server/data/ai-boss.db`）を毎日使っている。**移行中も日常利用を止めない**。

## ユーザーストーリー

- 製品版の利用者として、Node.js を用意せずにアプリを起動し、朝会・作業・夕会の毎日の流れを使いたい。
- オーナーとして、移行中も現行の Node サーバー版を毎日使い続け、開発者用の `claude-code` バックエンドを使い続けたい。

## オーナーの決定（2026-09-26・原文）

- **Q3-b（移行とデータ）**: 「現在のプロトタイプ（Node 版）から Tauri アプリへの移行について、**利用者はオーナーだけなのでデータを移す必要はない**。Tauri アプリは新しい DB で始める。データ移行の手段（#588 等）を本仕様の範囲に入れない。切り替えの時期は仕様で決めない（S3 以降にオーナーが判断する、と書く）。」
- **Q4-b（Tauri アプリと `claude-code`）**: 「**製品版では `claude-code` を使わない**。開発者向けで使えるとありがたいが Must ではなく、**複雑になるなら API だけでよい**。」→ 開発者用の版は現行の Node サーバー版とし（既存のまま `claude-code` が使える＝追加の複雑さは無い）、**Tauri アプリでは `claude-code` を動かさない**。サイドカー等で Tauri アプリから `claude-code` を使う仕組みは作らない。
- **Q4-c（製品版のコアの LLM バックエンド）**: 「推奨どおり。**製品版のコアに S1 では LLM バックエンドを 1 つも入れない**（`api` も入れない。キーを WebView に載せない＝ADR 0002 改訂の決定 3）。製品版の LLM 送信は #581・#582 に任せ、**#579 の完了条件『朝会・夕会が Tauri で動く』の確認は #581 が済んでから行う**、と仕様に明記する（完了条件の変更はオーナー承認済み）。開発者用 Tauri ビルドでキーを WebView で扱う暫定経路は作らない。」

## 実コードの実測（2026-09-26・`main` b81e69b）

仕様の決定はこの実測に拠る。食い違ったらコードが正。

| 対象 | 実測 |
|---|---|
| エントリ | `server/src/index.ts` が `dotenv/config`・`@hono/node-server` の `serve`・`startScheduler`（node-cron `* * * * *`）・`process.on("SIGINT")` を束ねる。`createApp(db, env, options)`（`app.ts`）はルートを `/api` 配下に組むだけで、HTTP サーバーから独立している |
| ルートのテスト | server のテストは `app.request(...)` を 531 箇所で使い、**HTTP サーバー無しで Hono のルートを直接呼んでいる**。Request → Response の経路はすでに実行環境から独立している |
| ブラウザ向けバンドル | `createApp` を esbuild（`--platform=browser`）で束ねると、解決できない Node 組み込みの出どころは `@anthropic-ai/claude-agent-sdk`（33 件）・`@anthropic-ai/sdk`（7 件。すべて資格情報読み込みの動的 `import('node:fs')`）・`@hono/node-server`（serve-static）と、server 本体の 8 モジュール（`app.ts`〔node:path・serve-static〕・`config.ts`〔node:path〕・`dashboard/task-fingerprint.ts`〔node:crypto の同期 `createHash`〕・`lib/exec-file.ts`・`llm/backends/claude-code-backend.ts`・`tasks/evidence-storage.ts`〔node:fs/path/crypto〕・`tasks/evidence-validation.ts`〔node:path〕・`tasks/task-evidences-routes.ts`〔node:fs/path〕）。**この 3 パッケージと `node:*` を外部指定すると残りは束ねられた**（1.1MB）。Hono 本体と `hono/streaming`（SSE）は問題なく束ねられる |
| LLM の切り替え | `llm/claude-client.ts` が `claude-code-backend.ts` と `api-backend.ts` を**静的に import** し、`createClaudeClient(env, backend)` で分岐する。既定は `config.ts` の `DEFAULT_LLM_BACKEND = "claude-code"`。したがって現状は、`api` だけを使う場合でも Agent SDK がバンドルに入る |
| DB | better-sqlite3（ネイティブ Node モジュール）。非テストの 48 モジュールが `import type Database from "better-sqlite3"`。値として import するのは `db/connection.ts` だけ。**WebView では動かない**ため、アプリ内で動かすには #580 の DB 層が前提になる |
| スケジューラ・通知 | `scheduler/scheduler.ts`（node-cron・未テストの薄い層）→ `scheduler-tick.ts`（テスト済み）→ `notifications/notifier.ts`（`terminal-notifier` → `osascript` を `child_process.execFile` で実行）。通知クリックの URL は未配線（`notificationUrl` 未設定） |
| `process.env` | `index.ts`・`app.ts`・`dashboard-routes.ts`・`reports-routes.ts` の既定引数、`claude-code-backend.ts` が参照。型は `NodeJS.ProcessEnv` が 17 モジュールに現れる |
| web の API 呼び出し | 10 モジュールが相対 URL `/api/...` をグローバル `fetch` で呼ぶ（`localhost` 直書きは無い。開発時は Vite の proxy が `localhost:8787` へ転送）。チャットの SSE は `fetch` の `response.body` を読む方式で `EventSource` を使わない。生成停止（#254）は `fetch` の `signal` の中止で行い、server 側は `c.req.raw.signal` で受ける。**例外は証跡ファイルの `<a href>`（`TaskCard.tsx` の `<a href>`。URL は `tasks-api.ts` の `evidenceContentUrl` が作る）1 箇所で、`fetch` を経由しない** |
| web のテスト | 24 ファイルがグローバル `fetch` をスタブしている |
| #576 の注意点 | WebView 上の検知エンジンの実行では DST スイート 2 件が Asia/Tokyo のため skip。plugin-sql は接続プール越しで同一接続の保証が無い（#580 の論点） |

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] 製品版は Tauri 2 のデスクトップアプリ（macOS）として起動し、Node サーバーを起動しない（S2 で検証）
- [ ] 製品版の画面は既存の React（`web/`）の画面コンポーネントを変更せずに使う。例外は証跡ファイルを開くリンク（`TaskCard.tsx` の `<a href>` と、その URL を作る `tasks-api.ts` の `evidenceContentUrl`）で、Blob URL で開く形へ変える（クリティカル設計決定 1）（S2 で検証）
- [ ] 製品版の API の呼び出しはアプリ内で処理され、`localhost` の配信に依存しない（S2 で検証）
- [ ] 製品版のビルドに `claude-code` バックエンド（`@anthropic-ai/claude-agent-sdk`・`claude-code-backend.ts`）が含まれない（S1 で検証）
- [ ] 各スライスのマージ時点で、開発者用の版（現行の Node サーバー版・`npm run start`）の既存テストが合格し、現行どおり起動する（各スライスの受入基準で検証）
- [ ] デスクトップの製品版で、ウィンドウを閉じた後もアプリがメニューバーに残り、毎分のサボり検知と催促通知を続ける（S3 で検証）
- [ ] 製品版の朝会・夕会（LLM を使う流れ）が Tauri アプリで動く（**確認は #581 が済んでから行う**。オーナーの決定 Q4-c）

## 技術的な制約・方針

- 使用技術: Tauri 2（macOS）。TS コアは既存の `server/src` を流用する（書き直さない）
- 前提（別 Issue・並行）: DB 層は #580、秘密情報を扱う Rust 通信層と BYOK は #581、プロバイダ抽象化は #582、予約通知方式は #585。**本機能はこれらを実装しない**
- 依存関係: **S2 以降は #580 の S1（#597。非同期の DB ポート・直列化層・better-sqlite3 実装）のマージを待つ**（better-sqlite3 は WebView で動かないため）。**#580 の S2（plugin-sql の fork・製品版の実装・ADR 0005 の改訂）は本機能の S2 の器の上で行う**。順序は #594（本機能 S1）→ #597（#580 S1）→ 本機能 S2 → #580 S2（親の決定・2026-09-26）で、S2 どうしが互いに相手を先に要する形を解消した。#580 の機能仕様は `docs/features/async-db-layer.md`（PR #596〔ブランチ `docs/issue-580-async-db-layer`〕。本修正の時点で未マージ）の「スライス」節と決定 7。**LLM を使う流れの Tauri アプリでの確認は #581 の完了を待つ**
- 既存コードとの関係: 検知エンジン（`server/src/detection/`）は無改変で流用する（ADR 0004 決定 1〜3）

## クリティカル設計決定

### 1. TS コアをどこで動かすか（Q1・確定）

- **採用案**: **WebView のメインスレッドで、既存の Hono アプリ（`createApp`）を動かし、製品版のエントリで web の `fetch('/api/...')` をアプリ内の `app.fetch(Request)` へ振り向ける**（web の各 API モジュールとそのテストは変えない）。証跡ファイルの `<a href>` だけは `fetch` を経由しないため、アプリ内では Blob URL で開く形にする。
- **理由**: ルートは既に `app.request` で HTTP 無しに 531 箇所テストされており、Request → Response の境界がそのまま使える。SSE（`hono/streaming`）と生成停止（`signal`）も Web 標準の `Request`/`Response`/`ReadableStream` の上で成り立つ。web 側は `/api` の相対 URL だけを使っており、差し替え点が 1 つで済む。
- **未検証点の扱い**: WKWebView 上での SSE の逐次受信と生成停止（中止）は未実測。**S2 の受入基準で実機確認する**。
- **代替案**:
  - Web Worker で動かす — DB（plugin-sql）・通知・Rust 通信層（#581）はいずれも Tauri の `invoke` を経由し、Worker からの `invoke` は公式には提供されていない（未実測）。メインスレッドへの中継層が要り、#580・#581 の境界が二重になる。
  - Hono のルートを捨て、画面からサービス関数を直接呼ぶ — web の API モジュール 10 本とテスト 24 本の書き換えになり、ルートのテスト 531 箇所の資産が使えなくなる。
- **影響範囲**: web のエントリ（製品版のみ）、`tasks-api.ts` の `evidenceContentUrl` と `TaskCard.tsx` の `<a href>`、server の Node 依存モジュール（実測表の 8 モジュール）。

### 2. デスクトップのスケジューラと通知の置き場所（Q2・確定）

- **採用案**: 毎分の検知（`scheduler-tick.ts` の `createTicker`）はアプリ内（WebView）で回し、node-cron を置き換える。**ウィンドウを閉じてもアプリは終了せずメニューバーに残り**、検知と催促を続ける（現行版で「ブラウザのタブを閉じてもサーバーが動いていれば催促が届く」振る舞いの維持）。通知の送信は `notifier.ts` の `execFile` 依存を通知ポートに置き換え、製品版は `@tauri-apps/plugin-notification`（デスクトップ）を使う。デスクトップは毎分方式のまま（送信時の LLM 文面生成を維持）とし、**予約通知方式への一本化は #585 で決める**。
- **タイマーの間引き**: WKWebView がウィンドウ非表示時にタイマーを間引くかは未実測。**S3 で確かめ、間引く場合は Rust 側のタイマーから WebView へ毎分の刻みを送る案へ切り替える**。
- **理由**: ADR 0011 決定 12 の予約通知方式は「iOS では」の決定であり、ADR 0004 帰結の毎分方式はデスクトップでは否定されていない。メニューバー常駐は ADR 0011 決定 6 が OS 連携の部品として想定済み。
- **代替案**: (a) ウィンドウを閉じたら終了し、開いている間だけ検知する — 現行の体験から後退する。(b) デスクトップも最初から予約通知方式にする — #585 の完了待ちになる。
- **影響範囲**: `scheduler/scheduler.ts`・`notifications/notifier.ts`（**クリティカル箇所: 通知の実行系。変更時は人間レビュー必須**）、Tauri の Rust 側（トレイ・ウィンドウの閉じる挙動）。

### 3. 開発者用の版を製品版から外す方式（Q4・確定）

- **採用案**: **エントリを分ける**。LLM バックエンドはエントリから注入する形にし（`claude-client.ts` から各バックエンドへの静的 import を外す）、`claude-code` を登録するのは開発者用のエントリ（`server/src/index.ts`）だけにする。**混入しないことは、製品版のコアのバンドルの入力（メタファイル）をテストで検査して固定する**。
- **版の対応（オーナーの決定 Q4-b）**: 開発者用の版 = 現行の Node サーバー版（既存のまま `claude-code` と `api` が使える）。製品版 = Tauri アプリ。**Tauri アプリでは `claude-code` を動かさず、Tauri アプリから `claude-code` を使う仕組み（サイドカー・子プロセスの起動を含む）は作らない**。
- **製品版のコアの LLM バックエンド（オーナーの決定 Q4-c）**: **S1 の製品版のコアには LLM バックエンドを 1 つも登録しない**（`api` バックエンドも入れない）。現行の `api` バックエンドは `@anthropic-ai/sdk` を WebView 内で動かし `ANTHROPIC_API_KEY` を環境変数から読むため、製品版で使うとキーが WebView に載り ADR 0002 改訂の決定 3 に反する。製品版の LLM の送信と、製品版のエントリへのバックエンドの登録は #581（Rust 通信層）・#582（プロバイダ抽象化）が受け持つ。**開発者用の Tauri ビルドでキーを WebView で扱う暫定経路は作らない**。
- **理由**: ADR 0003 改訂は「`claude-code` 固有のコードが製品版の実行経路に混入しない構造」を求めており、実行時の設定で無効にするだけでは満たせない。ビルド時フラグ＋tree-shaking は、静的 import が 1 本残るだけで黙って混入する（現状がまさにその形）。
- **代替案**: (a) ビルド時の定数（`define`）＋動的 import で除去する — 除去がバンドラの挙動頼みになり、検査は結局要る。(b) 設定で無効化する — 構造の分離にならない。(c) `claude-code` 部分を別パッケージ（workspace）に切り出す — 境界は最も明確だが、S1 の差分が大きくなる。
- **影響範囲**: `llm/claude-client.ts`・`config.ts`（`DEFAULT_LLM_BACKEND`・`LLM_BACKEND` の解決）・`index.ts`・`app.ts`（**クリティカル箇所: Claude API 連携。変更時は人間レビュー必須**）。

### 4. #580（DB 層）との境界

- 本機能は DB 層を作り替えない。**本機能が前提にする DB の形は、#580 が用意する非同期の DB ポート（リポジトリ層が受け取る接続の型）と、その 2 つの実装（開発者用の版: better-sqlite3／製品版: plugin-sql）**とする。製品版のエントリは #580 の製品版実装を受け取って `createApp` に渡すだけで、SQL・トランザクション・マイグレーションには触れない。
- #580 の S2 が済むまでは、Tauri アプリで DB を実行する経路を動かさない（S1 は DB を実行しない）。
- ADR 0002 改訂が「アプリ内のどの層が永続状態と DB への副作用を受け持つかは、実行の仕組みを作り替える移行 Issue で決め、そのときに本 ADR を改訂する」としている。本機能では「**WebView 内の TS コア（Hono アプリ）が受け持つ**」とし、ADR 0002 の改訂は S2（Tauri の器）で行う（層は本仕様で確定済みのため、DB の実行〔#580 S2〕を待たない）。

## 機能全体の設計

### アーキテクチャ決定

- `server/src` を「実行環境に依存しないコア」と「Node の周辺（開発者用の版のエントリ・アダプタ）」に分ける。**コアは Node 組み込み（`node:*`）・`process`・`@hono/node-server`・Agent SDK・`@anthropic-ai/sdk` を値として import しない**。Node の周辺は `index.ts` と、DB 接続・静的配信・通知の実行・証跡ファイルの保存・LLM バックエンド（`claude-code`・`api`）のアダプタに限る。
- 実行環境ごとの差（証跡ファイルの保存・通知の送信・LLM バックエンド・設定値）は、コアがポートとして受け取り、エントリが実装を注入する（通知は `NotifierDeps.execFile` で既に DI されている形を踏襲する）。
- コアは Node のグローバル（`Buffer` など）も使わない。import と違ってバンドル時に解決されず、呼ばれた時点で初めて `ReferenceError` になるため、バンドルの検査では見つからない。実測では証跡のアップロードの経路が `Buffer.from`（`tasks/task-evidences-routes.ts`）を使い、保存のデータ型も `Buffer`（`tasks/evidence-storage.ts`）である。証跡の保存ポートが受け渡すバイト列は Web 標準の型（`Uint8Array`）にする（`Buffer` は `Uint8Array` の派生型なので、開発者用の版の実装はそのまま受け取れる）。
- ディレクトリは当面 `server/` のまま動かさない（仮定 A1）。

### 移行の順序と並行運用（Q3・確定）

- 順序: **S1 コアの Node 依存切り離し → S2 Tauri の器（#580 の S1〔#597〕待ち。#580 の S2 はこの器の上で行う）→ S3 スケジューラ・通知・常駐 → S4 証跡ファイルの保存**。
- **どのスライスも `main` へのマージ時点で現行の Node 版を壊さない**（開発者用の版は常に現行どおり動く）。
- **Tauri アプリはオーナーの DB（`server/data/ai-boss.db`）を開かず、アプリ専用のデータディレクトリに別の DB を持つ**。2 つの版を同じ DB で同時に動かさない（両方のスケジューラが催促を二重に出し、ADR 0005 の単一ライターの前提も崩れるため）。
- **データは移さない**。Tauri アプリは新しい DB で始める（オーナーの決定 Q3-b）。
- **日常利用を Tauri アプリへ切り替える時期は本仕様で決めない**。S3 以降にオーナーが判断する。

### 実装計画（S1 のチケット分解の見通し）

1. LLM バックエンドの注入化と、`claude-code`・`api` の開発者用エントリへの分離
2. コアからの Node 組み込みの除去（`app.ts` の静的配信を Node の周辺へ・`config.ts` のパス操作・`task-fingerprint.ts` のハッシュ・証跡ファイル保存のポート化・`process.env` の既定引数の除去）
3. 製品版のコアのエントリとバンドル検査のテスト

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 実行環境に依存しないコアの切り出しと、製品版からの `claude-code` 除外。製品版のコアのエントリ（`createApp` を束ねる）が Node 組み込み・Agent SDK・`@hono/node-server`・`@anthropic-ai/sdk` を含まずにブラウザ向けに束ねられることをテストで固定し、開発者用の版は現行どおり動く | 15-25 | これだけで価値が出る（ADR 0003 改訂の「製品版に含めない」の構造的な担保。以降のスライスの前提） |
| S2 | Tauri 2（macOS）の器。製品版のエントリで `/api` をアプリ内の `app.fetch` へ振り向ける。証跡の `<a href>` の Blob URL 化。WKWebView 上の SSE と生成停止の実機確認。DB を使う画面の動作確認は #580 S2 の後。ADR 0002 の改訂（永続状態と DB 副作用を受け持つ層＝WebView 内の TS コア。層は本仕様で確定済みのため DB の実行を待たずに S2 で行う） | 10-20 | S1 と #580 の S1（#597）がマージされてから（#580 の S2 は本機能の S2 の器の上で行う） |
| S3 | デスクトップのスケジューラ・通知・メニューバー常駐（node-cron と `execFile` の置き換え）。WKWebView のタイマー間引きの確認 | 8-15 | S2 がマージされてから |
| S4 | 証跡ファイルの保存をアプリのデータディレクトリへ（plugin-fs） | 5-10 | S2 がマージされてから |

実装対象: S1

## やらないこと

- DB 層の非同期化・plugin-sql への移行・トランザクションの保ち方（理由: #580 の範囲）
- Rust の通信層・BYOK のキー保管・Tauri アプリからの LLM の送信・製品版のエントリへの LLM バックエンドの登録（理由: #581・#582 の範囲。オーナーの決定 Q4-c）
- LLM プロバイダの抽象化（Anthropic / OpenAI）（理由: #582 の範囲）
- 開発者用の Tauri ビルドでキーを WebView で扱う暫定の LLM 経路（理由: オーナーの決定 Q4-c）
- Tauri アプリで `claude-code` バックエンドを動かすこと・そのための仕組み（サイドカー・子プロセスの起動を含む）を作ること（理由: オーナーの決定 Q4-b）
- Node 版から Tauri アプリへのデータ移行と、その手段（#588 のエクスポート／インポートの利用を含む）（理由: オーナーの決定 Q3-b。利用者はオーナーだけで、Tauri アプリは新しい DB で始める）
- 日常利用を Tauri アプリへ切り替える時期の決定（理由: オーナーの決定 Q3-b。S3 以降にオーナーが判断する）
- 予約通知方式と通知プラグインの iOS の不具合の手当て（理由: #585 の範囲）
- スマホ向けの画面レイアウト・iOS / Android のビルド（理由: #586 と後続）
- 署名・公証・配布・自動更新（理由: #587 の範囲）
- 端末間同期（理由: ADR 0011 決定 18〔#590・PR #591 で追加。本仕様の作成時点で未マージ〕の実装は別 Issue）
- Windows 対応（理由: ADR 0011 決定 19〔同上〕で後続リリース）
- ログイン時の自動起動（理由: 現行版にも無い。必要なら別 Issue）

## 受入基準（S1）

- [ ] 製品版のコアのエントリを esbuild で `platform=browser` として束ねると、解決できない import が 0 件になる（外部指定なし）
- [ ] 製品版のコアのバンドルの入力（メタファイル）に `@anthropic-ai/claude-agent-sdk` が含まれない
- [ ] 製品版のコアのバンドルの入力に `server/src/llm/backends/claude-code-backend.ts` が含まれない
- [ ] 製品版のコアのバンドルの入力に `@hono/node-server` が含まれない
- [ ] 製品版のコアのバンドルの入力に `@anthropic-ai/sdk` が含まれない（型だけの import は入力に現れないため対象外）
- [ ] 製品版のコアのバンドルを、`process` と `require` が定義されていないグローバルで評価しても例外にならない
- [ ] 製品版のコアのエントリが登録する LLM バックエンドは 0 件である
- [ ] 開発者用の版で `LLM_BACKEND` 未設定のとき、チャットは `claude-code` バックエンドで処理される（現行の既定の維持）
- [ ] 開発者用の版で `LLM_BACKEND=api` のとき、チャットは `api` バックエンドで処理される
- [ ] 開発者用の版（`npm run start`）で、`web/dist` の画面が `/api` と同一オリジンで配信される（静的配信を Node の周辺へ移した後も現行どおり）
- [ ] 開発者用の版（`npm run start`）で、未知の `/api/*` は 404 を返す（静的配信を Node の周辺へ移した後も現行どおり）
- [ ] グローバルの `Buffer` を未定義にした状態で、証跡ファイルのアップロードのルートを呼ぶと成功する（保存先は証跡の保存ポートのテスト用の実装）
- [ ] 証跡ファイルの保存・読み出し・削除の既存テストが、保存先をポート経由に変えた後も変更なしで合格する
- [ ] `npm run lint`・`npm run typecheck`・`npm test`・`npm run test:tz` が合格する

## 仮定（軽微・可逆）

- A1: `server/` ディレクトリは S1 では動かさない（ワークスペースの再編は差分が大きく、S1 の目的に要らない）
- A2: `task-fingerprint.ts` のハッシュは、同期のまま動く非 Node の実装に置き換える（キャッシュ用の指紋であり暗号強度は要件でない。値が変わるとダッシュボードのボスのコメントのキャッシュが 1 回無効になるだけ）
- A3: 製品版のコアのエントリのファイル名・置き場所は実装で決める
