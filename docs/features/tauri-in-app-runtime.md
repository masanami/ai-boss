# 実行の仕組みを Tauri 2 アプリ内へ作り替える（Node サーバー常駐の廃止・開発者用版の除外）

> Issue #579。2026-09-26 に論点 Q1〜Q5 を確定した（親の回答とオーナーの回答。オーナーの回答は「オーナーの決定」節に原文のまま引用する）。
> 2026-09-28: S1（#594・PR #598）と #580 S1（#597・PR #615）のマージ後、S2 を実装対象にするため改訂した（「S2 の器の設計」・受入基準（S2）・手動の確認手順（S2）・やらないことと仮定の追加）。確定済みの設計（クリティカル設計決定 1〜4・スライス表・オーナーの決定）は変えていない。
> 2026-09-29: S2（#645・PR #646）と #580 S2（#651・PR #652）のマージ後、S3 を実装対象にするため改訂した（「S3 の設計」・受入基準（S3）・手動の確認手順（S3）・やらないことと仮定の追加）。確定済みの設計（クリティカル設計決定 1〜4・S2 の器の設計・スライス表・オーナーの決定）と S1・S2 の受入基準は変えていない。
> 2026-09-29（実装時）: 上流の実測との食い違い 3 点をオーナーの決定で直した（AC-S4-11 から `open` を外す・AC-S4-19 を「外へ出ない」に書き換え・シンボリックリンクの 2 段以上の連鎖を対象外に）。
> 2026-09-29: S2（#645・PR #646）と #580 S2（#651・PR #652）のマージ後、S4 を実装対象にするため改訂した（「S4 の設計」・受入基準（S4）・手動の確認手順（S4）・やらないことと仮定の追加）。確定済みの設計（クリティカル設計決定 1〜4・S2 の器の設計・スライス表・オーナーの決定）と S1・S2 の受入基準は変えていない。
> 2026-09-29（S3 の PR #658 を `main` へ追随させたとき）: S3 と S4 が並行して節・受入基準・仮定を足していたため、両方をそのまま残し、スライス表の「実装対象」を S3・S4 とした（受入基準は両方とも変えていない）。

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
- [ ] 製品版の証跡ファイルはアプリのデータディレクトリに保存され、オーナーの開発者用の版の証跡ファイル（`server/data/evidence/`）を開かず・書かない（S4 で検証。自動の検査は受入基準（S4）のスコープの外への到達の拒否〔AC-S4-11〜AC-S4-15〕とビルドの入力の検査〔AC-S4-32〕、オーナーのディレクトリそのものは手動の確認手順（S4）で確かめる）
- [ ] 製品版の朝会・夕会（LLM を使う流れ）が Tauri アプリで動く（**確認は #581 が済んでから行う**。オーナーの決定 Q4-c）
- [ ] 製品版のチャットで、WKWebView 上で応答が SSE で逐次表示され、生成停止で中止できる（**確認は #580 の S2 と #581 が済んでから行う**。クリティカル設計決定 1「未検証点の扱い」）

## 技術的な制約・方針

- 使用技術: Tauri 2（macOS）。TS コアは既存の `server/src` を流用する（書き直さない）
- 前提（別 Issue・並行）: DB 層は #580、秘密情報を扱う Rust 通信層と BYOK は #581、プロバイダ抽象化は #582、予約通知方式は #585。**本機能はこれらを実装しない**
- 依存関係: **S2 以降は #580 の S1（#597。非同期の DB ポート・直列化層・better-sqlite3 実装）のマージを待つ**（better-sqlite3 は WebView で動かないため）。**#580 の S2（plugin-sql の fork・製品版の実装・ADR 0005 の改訂）は本機能の S2 の器の上で行う**。順序は #594（本機能 S1）→ #597（#580 S1）→ 本機能 S2 → #580 S2（親の決定・2026-09-26）で、S2 どうしが互いに相手を先に要する形を解消した。#580 の機能仕様は `docs/features/async-db-layer.md`（PR #596〔ブランチ `docs/issue-580-async-db-layer`〕。本修正の時点で未マージ）の「スライス」節と決定 7。**LLM を使う流れの Tauri アプリでの確認は #581 の完了を待つ**
- 既存コードとの関係: 検知エンジン（`server/src/detection/`）は無改変で流用する（ADR 0004 決定 1〜3）

## クリティカル設計決定

### 1. TS コアをどこで動かすか（Q1・確定）

- **採用案**: **WebView のメインスレッドで、既存の Hono アプリ（`createApp`）を動かし、製品版のエントリで web の `fetch('/api/...')` をアプリ内の `app.fetch(Request)` へ振り向ける**（web の各 API モジュールとそのテストは変えない）。証跡ファイルの `<a href>` だけは `fetch` を経由しないため、アプリ内では Blob URL で開く形にする。
- **理由**: ルートは既に `app.request` で HTTP 無しに 531 箇所テストされており、Request → Response の境界がそのまま使える。SSE（`hono/streaming`）と生成停止（`signal`）も Web 標準の `Request`/`Response`/`ReadableStream` の上で成り立つ。web 側は `/api` の相対 URL だけを使っており、差し替え点が 1 つで済む。
- **未検証点の扱い**: WKWebView 上での SSE の逐次受信と生成停止（中止）は未実測。**実機での確認は S2 から後ろへ回し、#580 の S2 と #581 が済んだ後に行う**（生成のルート〔`sessions/chat-messages-route.ts`〕は LLM のクライアントを作る前に DB からセッションを読み、製品版の DB 実装は #580 の S2、製品版の LLM バックエンドの登録は #581 で入るため、それより前には製品版のエントリでこの経路を通せない）。それまでの間、この点は**未検証のリスクとして残る**。成り立たなかった場合の手当て（応答の受け渡し方の変更）は、確認した時点で決める。
- **代替案**:
  - Web Worker で動かす — DB（plugin-sql）・通知・Rust 通信層（#581）はいずれも Tauri の `invoke` を経由し、Worker からの `invoke` は公式には提供されていない（未実測）。メインスレッドへの中継層が要り、#580・#581 の境界が二重になる。
  - Hono のルートを捨て、画面からサービス関数を直接呼ぶ — web の API モジュール 10 本とテスト 24 本の書き換えになり、ルートのテスト 531 箇所の資産が使えなくなる。
- **影響範囲**: web のエントリ（製品版のみ）、`tasks-api.ts` の `evidenceContentUrl` と `TaskCard.tsx` の `<a href>`、server の Node 依存モジュール（実測表の 8 モジュール）。

### 2. デスクトップのスケジューラと通知の置き場所（Q2・確定）

- **採用案**: 毎分の検知（`scheduler-tick.ts` の `createTicker`）はアプリ内（WebView）で回し、node-cron を置き換える。**ウィンドウを閉じてもアプリは終了せずメニューバーに残り**、検知と催促を続ける（現行版で「ブラウザのタブを閉じてもサーバーが動いていれば催促が届く」振る舞いの維持）。通知の送信は `notifier.ts` の `execFile` 依存を通知ポートに置き換え、製品版は `@tauri-apps/plugin-notification`（デスクトップ）を使う。デスクトップは毎分方式のまま（送信時の LLM 文面生成を維持）とし、**予約通知方式への一本化は #585 で決める**。
- **タイマーの間引き**: WKWebView がウィンドウ非表示時にタイマーを間引くかは未実測。**S3 で確かめ、間引く場合は Rust 側のタイマーから WebView へ毎分の刻みを送る案へ切り替える**。
  - （2026-09-29・S3 の注記）S3 の着手時に、親の決定（間引きの有無に左右されない形を既定にする）により、確かめる前から Rust 側の刻みを既定にした（「S3 の設計」・仮定 S3-A1）。通知は Rust の `tauri-plugin-notification`（プラグイン本体）を使い、JS のパッケージは入れずに `invoke` で直接呼ぶ（仮定 S3-A6）。`notifier.ts` は開発者用の版の通知ポートの実装として残る。
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
- コアは Node のグローバル（`Buffer`・`process`・`require`・`__dirname`）も使わない。import と違ってバンドル時に解決されず、呼ばれた時点で初めて `ReferenceError` になるため、バンドルの検査では見つからない。実測では証跡のアップロードの経路が `Buffer.from`（`tasks/task-evidences-routes.ts`）を使い、保存のデータ型も `Buffer`（`tasks/evidence-storage.ts`）である。証跡の保存ポートが受け渡すバイト列は Web 標準の型（`Uint8Array`）にする（`Buffer` は `Uint8Array` の派生型なので、開発者用の版の実装はそのまま受け取れる）。
- ディレクトリは当面 `server/` のまま動かさない（仮定 A1）。

### 移行の順序と並行運用（Q3・確定）

- 順序: **S1 コアの Node 依存切り離し → S2 Tauri の器（#580 の S1〔#597〕待ち。#580 の S2 はこの器の上で行う）→ S3 スケジューラ・通知・常駐 → S4 証跡ファイルの保存**。
- **どのスライスも `main` へのマージ時点で現行の Node 版を壊さない**（開発者用の版は常に現行どおり動く）。
- **Tauri アプリはオーナーの DB（`server/data/ai-boss.db`）を開かず、アプリ専用のデータディレクトリに別の DB を持つ**。2 つの版を同じ DB で同時に動かさない（両方のスケジューラが催促を二重に出し、ADR 0005 の単一ライターの前提も崩れるため）。
- **データは移さない**。Tauri アプリは新しい DB で始める（オーナーの決定 Q3-b）。
- **日常利用を Tauri アプリへ切り替える時期は本仕様で決めない**。S3 以降にオーナーが判断する。

### S2 の器の設計（2026-09-28・S2 の着手時に確定済みの設計から導いた形）

- **用語**: 決定 1・4 の `createApp` は、S1（#594）で実行環境に依存しないコアの `createCoreApp`（`server/src/core-app.ts`）と、開発者用の版の Node の周辺の `createApp`（`server/src/app.ts`）に分かれた。以下の「製品版のエントリが渡す先」はコアの `createCoreApp` を指す（決定の中身は変わらない）。製品版のコアのエントリは S1 で `server/src/core-entry.ts` になった（仮定 A3）。
- **器の構成**: Tauri 2 のアプリ本体は Rust のクレート（`native/` 配下・仮定 A4）で、WebView には製品版の web のエントリ（web の既存の `App` を描画する別エントリ。開発者用の `index.html`／`main.tsx` とは別のビルド出力・仮定 A5）を載せる。`devUrl` は使わず、開発時もビルド済みの出力を読む（`localhost` の配信に依存しない）。
- **`/api` の振り向け（決定 1）**: 製品版の web のエントリは、描画より前にグローバルの `fetch` を包み、**アプリと同じオリジンで、パスが `/api` または `/api/` で始まる要求**だけを `createCoreApp` の `app.fetch(Request)` へ渡す。それ以外は元の `fetch` へそのまま渡す（外部への通信は下の CSP が止める）。要求の方法・ヘッダ・本文・`signal` は `Request` のまま渡し、応答は `Response` のまま返す（SSE は `ReadableStream` の逐次の読み出し、生成停止は `signal` の中止で成り立つ）。
- **DB 未接続の間の振る舞い（決定 4 から導出）**: 決定 4 は「製品版のエントリは #580 の製品版実装を `createCoreApp` に渡すだけ」「#580 の S2 が済むまで DB を実行する経路を動かさない」としている。両方を満たす形として、S2 の製品版のエントリは **すべての操作を「DB 未接続」のエラーで拒否し SQL を実行しない DB ポート**を `createCoreApp` に渡す。この結果 `/api/health` は `db: false` を返し、DB を使うルートは失敗の応答（既存のエラー処理のまま）になる。#580 S2 でこのポートを製品版の DB 実装に差し替える。
- **LLM**: 製品版のエントリは LLM バックエンドを 1 つも登録しない（オーナーの決定 Q4-c。S1 と同じ）。`env` は空（`process.env` を読まない）。
- **証跡ファイルの `<a href>`（決定 1）**: 製品版のエントリだけが「Blob URL で開く」方式を画面へ注入する（React のコンテキストで注入し、`TaskCard.tsx` の証跡ファイルのリンクと `use-task-evidences.ts` がそれを読む。取得の失敗は既存の証跡の操作のエラー表示〔`actionError`〕に出す。影響範囲は決定 1 の 2 ファイルに `use-task-evidences.ts` を加えたもの）。注入された場合、証跡ファイルのリンクを押すと本文を `fetch` で取得し、その `blob:` URL を新しいウィンドウで開き、一定時間後に失効させる。**注入しない開発者用の版は、現行どおり `<a href="/api/.../content">` のまま**（`npm run start` の挙動を変えない）。
- **権限と到達経路の境界（安全側）**:
  - capability は 1 つも置かない（S2 の WebView は Tauri のコマンド・プラグインを呼ばない。`/api` はアプリ内の JS で完結する）。`withGlobalTauri` も有効にしない。権限は、使うスライス（S3 の通知・トレイ、#581 S3 の通信層、#580 S2 の DB）がそのとき最小の単位で足す。
  - CSP を設定する（`null` にしない）。スクリプトは自オリジンだけ（`unsafe-inline`・`unsafe-eval` なし）、通信先は自オリジンと Tauri の IPC だけ、`object-src`・`frame-src`・`base-uri`・`form-action` は `'none'`。画像は自オリジン・`data:`・`blob:`。
  - `asset:` プロトコルは有効にしない（設定・クレートの機能ともに）。WebView から端末の任意のファイルへ到達する経路を作らない。
  - メインのウィンドウのナビゲーションはアプリのオリジン（`tauri://localhost`）の中だけを許し、それ以外（`http(s):`・`file:`・`blob:`・`data:` 等）は拒否する。
  - 新しいウィンドウの要求は、アプリのオリジンの `blob:` URL（証跡ファイル）だけを許し、それ以外は拒否する。ダウンロードの要求はすべて拒否する。
  - 上の 3 つの判定は Tauri 2（2.12）の `WebviewWindowBuilder` の `on_navigation`・`on_new_window`（`NewWindowResponse::Allow`／`Deny`）・`on_download` で行う（2026-09-28 に crate のソースで API を確かめた。判定を登録しない場合、macOS の WebView は新しいウィンドウの要求を開かない〔wry 0.55〕）。判定は URL を受け取る純粋な関数にして `cargo test` で固定する。`blob:` の新しいウィンドウが実機で本文を表示できるかは、証跡を扱えるようになる #580 S2・S4 の後に手動で確かめる（未検証のリスクとして残す）。
  - 子プロセス・サイドカーの仕組み（`tauri-plugin-shell`・`bundle.externalBin`）を入れない（オーナーの決定 Q4-b。Node・`claude-code` を器から起動する経路を作らない）。
- **製品版に開発者用の経路が混入しないことの検査（決定 3 の延長）**: S1 はコアのエントリ（`server/src/core-entry.ts`）のバンドルを検査した。S2 では、器に実際に載る**製品版の web のビルド**（Vite）の入力モジュール（Vite の `build()` が返す Rollup の出力の各チャンクの `moduleIds` の和集合。S1 のメタファイルに当たる）を検査し、`claude-code`・`@anthropic-ai/sdk`・Node の周辺（`@hono/node-server`・`better-sqlite3`・`server/src/app.ts`・`server/src/index.ts`・開発者用の LLM バックエンドの登録）が含まれないことを固定する。逆に開発者用の web のビルドにはコア（`server/src`）が入らないことも固定する。
- **ADR 0002 の改訂**: 決定 4 のとおり、製品版で永続状態と DB への副作用を受け持つ層を「WebView 内の TS コア（Hono アプリ）」と ADR 0002 に記録する。

### S3 の設計（2026-09-29・S3 の着手時に確定済みの設計から導いた形）

#### 実測（2026-09-29・`main` c4af1ba・`tauri` 2.12.0・`tauri-plugin-notification` 2.5.0〔crates.io の配布物。`~2.5` で解決される版〕・`wry` 0.57.0）

| 観点 | 実測 |
|---|---|
| 通知の送信（デスクトップ） | コマンド `plugin:notification\|notify` は `NotificationData`（`title`・`body` 等）を `options` で受け、デスクトップの実装（`src/desktop.rs`）は OS への表示（`notify_rust::Notification::show`）を `tauri::async_runtime::spawn` の中で呼んで**結果を捨て**（`let _ = notification.show()`）、コマンド自体は `Ok(())` を返す。したがってデスクトップで `invoke` が失敗を返すのは、IPC・権限（ACL）・引数の失敗だけで、**OS が表示に失敗したことは呼び出し側から分からない**。#585 の「`invoke` なら失敗が返る」は iOS（`mobile.rs`）での実測で、デスクトップには当てはまらない |
| 通知の許可（デスクトップ） | デスクトップで登録されるコマンドは `notify`・`request_permission`・`is_permission_granted` の 3 つ。許可の状態は常に `Granted`（`is_permission_granted` は真）で、利用者に問い合わせない（2.5.0 のドキュメントコメント「Desktop applications do not need to ask for this permission」）。macOS では開発時（`tauri::is_dev()`）は Terminal の名前で、ビルドした `.app` は `identifier`（`dev.aiboss.app`）の名前で通知が出る |
| JS の通知 API | プラグインは初期化スクリプトで `window.Notification` を差し替え、JS の `sendNotification` は結果を返さない（#585 の実測のまま） |
| 非表示の WebView | WKWebView は非表示の間の処理を `WKPreferences.inactiveSchedulingPolicy` で決め、Tauri 2.12 は `WebviewWindowBuilder::background_throttling`（`WindowConfig.background_throttling`）でこれを設定できる（macOS 14 以上。wry が `inactiveSchedulingPolicy` へ `None`/`Suspend`/`Throttle` を書く）。Tauri のドキュメントコメントは、既定では「最小化・非表示になって約 5 分後にタイマーを間引き、ビュー全体を止めうる（すべての処理が止まる）」としている。**停止されると、WebView のタイマーだけでなく Rust から送った刻みの処理も止まる** |
| ウィンドウを閉じる | `WindowEvent::CloseRequested { api }` の `api.prevent_close()` で閉じる処理を取り消せる。`MockRuntime` は `Window::close()` で `CloseRequested` を発し、取り消されなければウィンドウを取り除く（最後の 1 枚なら終了の要求へ進む）。`MockRuntime` の `hide`・`show` は何もせず `is_visible` は常に真、終了の要求（`request_exit`）は未実装（`unimplemented!`） |
| メニューバー（トレイ） | `tauri` の機能 `tray-icon` で `TrayIconBuilder` が使える。トレイとメニューは Rust 側だけで組み、WebView の権限（capability）を要さない |
| Rust → WebView のイベント | WebView 側の `listen`（`@tauri-apps/api/event`）は `plugin:event\|listen` を呼び、権限 `core:event:allow-listen` を要する |

#### 毎分の刻みの供給元（クリティカル設計決定 2「タイマーの間引き」）

- **Rust 側のタイマーから WebView へ毎分の刻みを送る案（決定 2 の切り替え先）を最初から採る**。器の Rust 側のスレッドが次の分の境界（秒 0）まで待ってはメインのウィンドウへ刻みのイベントを送り、製品版の web のエントリはそのイベントを受けるたびに `createTicker` の `tick` を呼ぶ（node-cron の `* * * * *` の置き換え。刻みの粒度は現行と同じ）。
- **刻みの送り手の形**: 待ち（次の刻みまで待つ関数）と送り先（刻みのイベントを送る関数）を引数に取るループとし、テストは待ちを即時に返す関数に差し替えて回数を数える。器は `setup` で送り手を起動し、起動したことを器の状態（`manage` した値）で観測できるようにする。
- **あわせて、メインのウィンドウの `background_throttling` を `Disabled` にする**（上の実測: 既定の方針では非表示の WebView が止まりうり、止まると Rust から送った刻みも処理されない）。
- **理由**: 親の決定「間引きの有無に左右されない形を既定にする」「ウィンドウを閉じた状態で止まらないことを自動テストで固定できる方を選ぶ」。WebView のタイマー（`setInterval`）のままでは、非表示で間引かれないことを自動テストで固定できない（jsdom・`MockRuntime` に WKWebView の方針は無い）。Rust 側の刻みは、ウィンドウを閉じる要求の後も送られ続けることを `MockRuntime` の上で固定でき、非表示の WebView が刻みを処理するかどうかは `background_throttling` の設定値を検査で固定したうえで、実機の確認を手動の確認手順に置く。
- **残るリスク（手動の確認）**: `background_throttling` の効果・macOS の App Nap（アプリ全体が非表示のときのタイマーの合体）で刻みが遅れないかは、実機でしか確かめられない。手動の確認手順（S3）の 5〜6 で確かめ、遅れる・止まる場合は別 Issue にする。

#### 通知ポート（決定 2「`execFile` 依存を通知ポートに置き換え」）

- 毎分の検知（`createTicker`）は、通知の送信を**通知ポート**（`NotificationPayload`〔`title`・`body`・`url?`〕を受け、`SendNotificationResult`〔`delivered`・`channel`〕を返す非同期の関数）として受け取る。`TickDeps` の `execFile` を通知ポートの引数に置き換える（`notificationUrl` は残し、`url` として通知ポートへ渡す）。
- 通知ポートの型と `NotificationPayload`・`SendNotificationResult`・`NotificationChannel`（`"tauri-notification"` を足す）は、Node 組み込みに依存しない新しいモジュール（`server/src/notifications/notification-port.ts`）に置く。`notifier.ts` はそこから型を読み（既存の import 先を保つため re-export する）、`scheduler-tick.ts` は `notifier.ts` を import しない。これにより `scheduler-tick.ts` は Node 組み込みに依存せず、コアのエントリ（`createTicker` を re-export する）から製品版へ載る。
- **開発者用の版**: `scheduler.ts` が `notifier.ts` の `sendNotification`（`terminal-notifier` → `osascript`・`execFile`）を通知ポートとして渡す。振る舞いは変えない（node-cron も残す）。
- **製品版**: 通知ポートは `invoke("plugin:notification|notify", { options: { title, body } })` を呼ぶ（JS の `sendNotification` は使わない〔#585 の実測〕）。解決したら `delivered: true`・`channel: "tauri-notification"`、拒否したら例外にせず `delivered: false`・`channel: "none"` を返し、失敗をログに出す。**失敗は呼び出し側（`scheduler-tick.ts`）へ戻り値で返り、既存の #321 の書き戻しで送信履歴に `delivered = 0` として残る**（握りつぶさない）。上の実測のとおり、OS が表示に失敗したことはデスクトップのプラグインが捨てるため分からない（`delivered: true` は「プラグインが受け付けた」の意味になる。「やらないこと（S3）」）。
- 製品版の通知ポートは `url` を使わない（通知のクリックは現行も未配線）。

#### 通知の許可

- デスクトップのプラグインは許可を問い合わせない（上の実測）ため、製品版は初回の権限要求を行わない。利用者が macOS の設定で通知を切っているときは、上の実測のとおりアプリからは分からない（手動の確認手順（S3）の 8）。

#### ウィンドウを閉じる挙動・メニューバー・終了の経路（決定 2「ウィンドウを閉じてもアプリは終了せずメニューバーに残る」）

- **メインのウィンドウを閉じる要求**（閉じるボタン・⌘W）は取り消し、ウィンドウを**隠す**（破棄しない）。WebView とその中のコア・毎分の検知は動き続ける。証跡の新しいウィンドウ（`blob:`）を閉じる要求は取り消さない。
- **メニューバーのアイコン**（トレイ）を置き、メニューの項目は「ウィンドウを開く」「終了」の 2 つだけにする。「ウィンドウを開く」はメインのウィンドウを表示して前面に出す。「終了」はアプリを終了する。
- Dock のアイコンを押したとき（macOS の再表示の要求 `RunEvent::Reopen`）に見えているウィンドウが無ければ、メインのウィンドウを表示する（隠したウィンドウを Dock から戻せないと、閉じた後に画面へ戻る経路がメニューバーだけになるため）。
- **終了の経路**は、メニューバーの「終了」と、アプリのメニューの「終了」（⌘Q。Tauri の既定のメニュー）の 2 つ。どちらも止めない。
- 判定（閉じる要求を取り消すか・メニューの項目から何をするか・再表示の要求で何をするか）は、ウィンドウのラベル・項目の ID・見えているウィンドウの有無を受け取る純粋な関数にして `cargo test` で固定し、Tauri の API を呼ぶ部分は薄く保つ（S2 の `is_allowed_navigation` と同じ形）。

#### 起動の順序（製品版の web のエントリ）

- 製品版の毎分の検知を始める関数は `web/src/app-entry/` に置き、DB のポート・購読の関数（`listen`）・`invoke`・ログを引数で受ける（テストで差し替えるため）。毎分の検知は、DB の準備に成功した後に、そのポートと製品版の通知ポートで組み立て、刻みのイベントの購読を始める。**「DB 未接続」で起動したときは始めない**（DB を読めない刻みはすべて失敗するため）。購読の開始に失敗しても画面の描画は止めず、失敗を記録する（#580 S2 の DB の準備の失敗と同じ扱い）。
- `env` は空、LLM バックエンドは製品版のエントリが登録したものを使う（S3 の時点では 0 件のため、`generateNotificationBody` は既存のフォールバックの定型文を返す。#581 S3 が BYOK を登録すれば、送信時の LLM 文面生成がそのまま働く＝決定 2「送信時の LLM 文面生成を維持」）。
- 催促の予約の計画し直し（#585 S2 の `createNudgeReplanner`・`createCoreApp` の `onStateChangingRequest`）はデスクトップでは配線しない（#585 決定 5: デスクトップは毎分方式）。

#### 権限（capability）

- S3 で足す権限は、通知の送信（`notification:allow-notify`）と刻みのイベントの購読（`core:event:allow-listen`）の 2 つだけ。`notification:default`・許可の問い合わせ・予約・取り消し・`core:event:allow-emit` 等は足さない。トレイ・ウィンドウの操作は Rust 側だけで行うため、ウィンドウ・トレイの権限は足さない。
- （実装時の実測）プラグインの初期化スクリプト（`init-iife.js`）は、ページの読み込みのたびに `window.Notification.permission` を決めるため `plugin:notification|is_permission_granted` を呼び、失敗を捕まえない。S3 はこのコマンドを許可しない（AC-S3-16）ため、読み込みのたびに WebView のコンソールに未処理の拒否が 1 件出て、`window.Notification.permission` は `default` のままになる。製品版は `window.Notification` を使わず `invoke` で直接送るため、通知の送信には影響しない（仮定 S3-A9）。

### S4 の設計（2026-09-29・S4 の着手時に確定済みの設計から導いた形）

#### 実測（2026-09-29・`main` c4af1ba・`tauri-plugin-fs` 2.6.0〔crates.io の配布物〕・`tauri` 2.12.0）

| 観点 | 実測 |
|---|---|
| 証跡の保存ポート | `EvidenceStore`（`server/src/tasks/evidence-store.ts`）の `write`・`read`・`remove` は**同期**で、`Uint8Array` を受け渡す。plugin-fs は IPC 越しで**非同期**のため、そのままでは実装できない |
| 製品版のエントリ | `createProductCoreApp`（`web/src/app-entry/create-product-core-app.ts`）は `evidenceStore` を渡さない。製品版では証跡ファイルのアップロード・本文の取得・ファイル証跡の削除は 500（`evidence store is not configured`）になる |
| 開発者用の版の保存先 | `resolveEvidenceDir(config.dbPath)`（`config.ts`）＝**DB と同じディレクトリの `evidence/`**（既定 `server/data/evidence/`）。保存名は `<UUID>.<小文字の拡張子>`（`evidence-store.ts` の `generateStoredFilename`。拡張子はホワイトリスト〔`EVIDENCE_EXTENSION_MIME_TYPES`〕に当たったものだけ） |
| 製品版の DB の場所 | plugin-sql が `app_config_dir()`（macOS では `~/Library/Application Support/dev.aiboss.app/`）の下に `ai-boss.db` を作る（#580 S2） |
| plugin-fs のパス | 各コマンドは `path`（文字列。`file:` 等の URL も受け付ける）と `baseDir` を受け、`baseDir` があれば Tauri の `path().resolve(path, baseDir)` で連結する。`path` が絶対パスなら連結の結果はその絶対パスになる。**`..` の要素を含むパスは、スコープの判定より前に拒否される**（`SafeFilePath`） |
| plugin-fs のスコープ | 許可の判定は、パスがシンボリックリンクならリンク先（1 段）を読み、**存在するパスは `canonicalize` した後**で、許可のパターン（glob）と照合する。照合は `require_literal_separator`（`*` は `/` をまたがない）・`require_literal_leading_dot`（`*` は先頭の `.` に当たらない）で行い、**大文字小文字は区別しない**（2026-09-29 の実装時の実測で訂正。Tauri 2.12.0 `src/scope/fs.rs:235-241` は `glob::MatchOptions` を `..Default::default()` で組み、glob 0.3.4 の `MatchOptions` は `#[derive(Default)]`〔`src/lib.rs:1062-1063`〕のため `case_sensitive` が `false` になる。当初の「区別する」は誤り）。許可のパターン自体も、`canonicalize` した親の形を併せて登録する（`/var` → `/private/var` のような違いを吸収する） |
| 権限 | コマンドごとに `fs:allow-<コマンド>` があり（**`fs:allow-write-file` は `write_file` に加えて `open`・`write` も許可する**。`tauri-plugin-fs-2.6.0/permissions/autogenerated/commands/write_file.toml:9-14` の `commands.allow = ["write_file", "open", "write"]`。付けたスコープは `open` にも同じく効く。`write` はファイルのハンドル〔`open` が返す ID〕への書き込みでパスを取らない）、capability で `{ "identifier": "fs:allow-read-file", "allow": [{ "path": "$APPCONFIG/evidence/*" }] }` の形で**コマンドごとのスコープ**を付けられる。`fs:default` はアプリのディレクトリの読み取り等をまとめて許す |
| JS の API | `@tauri-apps/plugin-fs` の `writeFile` は本文をそのまま（raw）送り、`path`・`options` を**ヘッダ**で送る。`@tauri-apps/api/mocks` の `mockIPC` はヘッダ（`invoke` の第 3 引数）を捨てる |
| 存在しないパスとシンボリックリンク | 書き込み先がまだ無いパスは `canonicalize` されない。したがって**保存先のディレクトリそのもの**（`evidence`）がアプリの外を指すシンボリックリンクだと、まだ無いファイルへの書き込みは許可のパターンに当たり、リンク先（アプリの外）に書かれる |

#### 保存先（オーナーの決定 Q3-b・「移行の順序と並行運用」・#580 S2 の DB の置き場所から導出）

- 製品版の証跡ファイルの保存先は **`app_config_dir()` の直下の `evidence/`**（macOS では `~/Library/Application Support/dev.aiboss.app/evidence/`）。開発者用の版の「DB と同じディレクトリの `evidence/`」と同じ決め方を、製品版の DB の場所（#580 S2 の `app_config_dir`）に当てはめたもの。オーナーの開発者用の版の証跡ファイル（`server/data/evidence/`）は開かず・書かない（データは移さない。Q3-b）。
- 保存先のディレクトリは **Rust 側が起動時（`setup`）に作る**（準備は `app_config_dir` を受け取る関数に切り出し、`setup` はそれを呼んで失敗を伝える。テストはこの関数の単体と、`HOME` を一時ディレクトリにした MockRuntime の器の組み立ての両方で確かめる）（WebView に `mkdir` を許可しない）。起動時に `evidence` が既にあって**実ディレクトリでない**（シンボリックリンク〔リンク先がディレクトリでも〕・通常のファイル）ときは、`setup` を失敗させて起動しない（上の実測の「存在しないパスとシンボリックリンク」の経路を塞ぐ。#580 S2 の仮定 A7 の「preload が DB を開けないときは起動しない」と同じ扱い）。

#### 権限（「S2 の器の設計」の「使うスライスが最小の単位で足す」）

- `tauri-plugin-fs` を器に登録し、capability（`capabilities/default.json`・`main` のウィンドウだけ）に、**`fs:allow-read-file`・`fs:allow-write-file`・`fs:allow-remove`・`fs:allow-exists` の 4 つだけ**を、それぞれ**スコープ `$APPCONFIG/evidence/*` の 1 件だけ**を付けて足す。`fs:default`・スコープを持たない `fs:allow-*`・全コマンド共通の `fs:scope`・それ以外のすべての fs のコマンド（例: `mkdir`・`read_dir`・`rename`・`copy_file`・`open`・`stat`）は許可しない。
- `$APPCONFIG/evidence/*` はワイルドカードを保存先の直下の 1 要素だけに限る（`**` を使わない。上の実測のとおり `*` は `/` をまたがず、先頭の `.` に当たらない）。
- path API（`core:path`）の権限は足さない。JS からは `baseDir: BaseDirectory.AppConfig` と相対パス `evidence/<保存名>` で呼ぶ（絶対パスを JS で組み立てない）。

#### 製品版の証跡の保存の実装

- 製品版の `EvidenceStore` の実装（plugin-fs 実装）は、製品版の web のエントリの側（`web/src/app-entry/`）に置く（`@tauri-apps/plugin-fs` に依存するのは製品版だけ。#580 S2 の plugin-sql 実装のドライバと同じ置き方）。`@tauri-apps/plugin-fs`（JS）は上流のまま使う。
- **証跡の保存ポートの口は変えず、戻り値に `Promise` を許す**（`write`・`read`・`remove` の引数・`Uint8Array` の受け渡しは S1 のまま。開発者用の版の Node fs 実装は同期のまま変えない）。コアはポートを呼ぶすべての箇所で戻り値を `await` する（`saveFileEvidenceIfAllowed` の `write` と拒否時の `remove`・`removeEvidenceFile`〔`Promise<void>` にする〕とその呼び出し元〔`deleteEvidence`・`task-evidences-routes.ts` の `DELETE`〕・本文の取得の `read`）。
- 保存名の検査（多層防御。境界の本体は上の capability のスコープ）: plugin-fs 実装は、保存名が **`<小文字の UUID>` ＋ ホワイトリストの拡張子（小文字）** の形（コアの `generateStoredFilename` が作る形）でないとき、plugin-fs を呼ばない。`write` は拒否し、`read` は「無い」（`undefined`。本文の取得は既存の 404）を返し、`remove` は何もしない（行の削除はコアで確定済みで、検査に通らない名前の実体はこの実装が書いたものではない）。検査の関数は、保存名を作る側と同じ定義を共有するため**コアの `evidence-validation.ts` に置き**（ホワイトリスト `EVIDENCE_EXTENSION_MIME_TYPES` を参照する）、製品版のコアの公開面（`core-entry.ts`）から re-export して使う（web 側に複製しない）。
- 検査を通った保存名で IPC が失敗したとき（I/O の失敗・スコープの拒否）は、失敗をそのまま伝える（開発者用の版の Node fs 実装〔`writeFileSync`・`unlinkSync` の例外〕と同じ振る舞い。握りつぶさない）。
- `read`・`remove` は、`exists` で有無を確かめてから読む・消す（開発者用の版の Node fs 実装〔`existsSync`〕と同じ振る舞い。無いファイルの `read` は `undefined`、`remove` は何もしない）。
- 製品版のエントリは、plugin-fs 実装を `createCoreApp` の `evidenceStore` に渡す（DB の準備に失敗して「DB 未接続」で起動する場合も同じ）。

#### パスが保存先の外へ出る経路と扱い

保存名は DB の `stored_filename` から来る。WebView の JS は SQL の `execute` を許可されているため、行の値は任意の文字列になりうる。したがって**境界は Rust 側のスコープ**に置き、TS の検査は多層防御とする。

| 経路 | 例 | 扱い |
|---|---|---|
| `..` | `evidence/../ai-boss.db`・`evidence/../../../x` | 塞ぐ。plugin-fs が拒否（`SafeFilePath`）。TS の検査も拒否（受入基準で固定） |
| 絶対パス | `/etc/hosts`・`<HOME>/outside.txt`（`baseDir` あり・なし） | 塞ぐ。連結の結果が絶対パスになり、スコープに当たらず拒否。TS の検査も拒否（受入基準で固定） |
| `file:` の URL | `file:///etc/hosts` | 塞ぐ。スコープに当たらず拒否（受入基準で固定） |
| 保存先の外を指すシンボリックリンク（ファイル・1 段） | `evidence/<名前>.png` → アプリの外のファイル（実在・リンク切れ） | 塞ぐ。スコープの判定はリンク先で行われ、外なら拒否（受入基準で固定） |
| 保存先の中のシンボリックリンクの 2 段以上の連鎖 | `evidence/A.png` → `evidence/B.png` → アプリの外のまだ無いファイル | **対象外**（2026-09-29・オーナーの決定）。上流の判定はリンクを 1 段しか辿らない（Tauri 2.12.0 `src/scope/fs.rs` の `try_resolve_symlink_and_canonicalize`）ため、`write_file` はアプリの外にファイルを作る。リンクを作れるのは利用者の権限で動くローカルのプロセスだけで WebView からは作れないため、TOCTOU と同じ理由で防ぐ対象にしない（「やらないこと」節）。外に出る事実は観測のテスト〔`observed_*`〕で固定する |
| 保存先のディレクトリ自体がシンボリックリンク | `evidence` → アプリの外のディレクトリ | 塞ぐ。起動時の `setup` が失敗し起動しない（受入基準で固定） |
| 区切り文字の混入・サブディレクトリ | `evidence/sub/x.png`・`evidence/a\b.png`（`\` は macOS ではファイル名の文字） | `/`: 塞ぐ（`*` が `/` をまたがない。受入基準で固定）。`\`: 保存先の直下の 1 ファイル名になるだけで外へは出ない。TS の検査は両方を拒否（受入基準で固定） |
| 保存先の兄弟・親 | `ai-boss.db`（`$APPCONFIG` 直下）・`evidence` そのもの | 塞ぐ。スコープに当たらず拒否（受入基準で固定。DB ファイルを fs のコマンドから読み書き・削除できない） |
| 大文字小文字 | `Evidence/<名前>.png`・`<名前>.PNG` | 照合は大文字小文字を区別しない（上の実測）ため、保存先の名前の綴りを変えたパスはスコープに当たるが、APFS の大文字小文字の同一視で行き先は保存先の中になり、外へは出ない（受入基準で固定。2026-09-29・オーナーの決定で fork はしない）。DB の名前の綴りを変えたパス（`AI-BOSS.DB`）はスコープに当たらず拒否される。TS の検査は大文字を含む保存名を拒否（受入基準で固定） |
| `open`（`fs:allow-write-file` に含まれる） | `evidence/<名前>.png` の `open` | 許可される（上流の権限の束ね方。上の実測）。スコープは `write_file` と同じで、DB・`..`・絶対パス・`file:` の URL には届かない（観測のテストで固定）。capability は変えない（2026-09-29・オーナーの決定） |
| 先頭の `.` | `evidence/.hidden` | 外へは出ない（スコープにも当たらない）。受入基準にしない |
| 判定と操作の間の差し替え（TOCTOU）・`app_config_dir` より上の祖先のシンボリックリンク | 判定の直後にファイルをリンクへ差し替える | やらないこと（理由は「やらないこと」節） |

#### 契約テストを器の上で通す仕組み（#580 S2 の延長）

- **両版で同じ契約スイート**: 証跡の保存ポートの契約（書いたバイト列が同じに読める・無いものの `read` は `undefined`・`remove` の後は `read` が `undefined`・無いものの `remove` は失敗しない）の本体を `server/src/tasks/test-support/` に置き、開発者用の版は Node fs 実装で `npm test` の中で、製品版は plugin-fs 実装で `npm run test:tauri-db` の中で回す。
- **IPC の中継の拡張**: 器の IPC の中継（`examples/sql-ipc-bridge.rs`）に、raw の本文（`writeFile`）とヘッダの受け渡し・raw の応答（`readFile`）を足す。`mockIPC` はヘッダを捨てるため、製品版の plugin-fs 実装のテストは `__TAURI_INTERNALS__.invoke` を直接差し替えて中継へ流す（置き換わるのは WebView と Rust の間の転送だけで、JS のプラグイン・製品版の実装・Rust のプラグイン・ACL は製品版と同じものが動く）。
- **Rust の結合テスト**（`npm run test:tauri`）: 器の ACL の上で、保存先のディレクトリの作成・許可されたコマンドの実行・許可しないコマンドの拒否・上の表の各経路の拒否を、TS を介さずに確かめる。

### 実装計画（S1 のチケット分解の見通し）

1. LLM バックエンドの注入化と、`claude-code`・`api` の開発者用エントリへの分離
2. コアからの Node 組み込みの除去（`app.ts` の静的配信を Node の周辺へ・`config.ts` のパス操作・`task-fingerprint.ts` のハッシュ・証跡ファイル保存のポート化・`process.env` の既定引数の除去）
3. 製品版のコアのエントリとバンドル検査のテスト

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 実行環境に依存しないコアの切り出しと、製品版からの `claude-code` 除外。製品版のコアのエントリ（`createApp` を束ねる）が Node 組み込み・Agent SDK・`@hono/node-server`・`@anthropic-ai/sdk` を含まずにブラウザ向けに束ねられることをテストで固定し、開発者用の版は現行どおり動く | 15-25 | これだけで価値が出る（ADR 0003 改訂の「製品版に含めない」の構造的な担保。以降のスライスの前提） |
| S2 | Tauri 2（macOS）の器。製品版のエントリで `/api` をアプリ内の `app.fetch` へ振り向ける。証跡の `<a href>` の Blob URL 化。S2 で確かめるのは DB と LLM を使わずに確かめられるものだけとし、DB を使う画面の動作確認は #580 S2 の後、WKWebView 上の SSE と生成停止の実機確認は #580 S2 と #581 の後に行う（クリティカル設計決定 1「未検証点の扱い」）。ADR 0002 の改訂（永続状態と DB 副作用を受け持つ層＝WebView 内の TS コア。層は本仕様で確定済みのため DB の実行を待たずに S2 で行う） | 10-20 | S1 と #580 の S1（#597）がマージされてから（#580 の S2 は本機能の S2 の器の上で行う） |
| S3 | デスクトップのスケジューラ・通知・メニューバー常駐（node-cron と `execFile` の置き換え）。WKWebView のタイマー間引きの確認 | 8-15 | S2 がマージされてから |
| S4 | 証跡ファイルの保存をアプリのデータディレクトリへ（plugin-fs） | 5-10（S4 の着手時に、証跡の保存ポートの非同期化・契約スイート・IPC の中継の拡張・Rust の結合テストを含めて 15-25 と見直した） | S2 がマージされてから（製品版の DB〔#580 S2〕も前提。2026-09-29 時点でいずれもマージ済み） |

実装対象: S3・S4（S4 は PR #656 でマージ済み。S3 は PR #658）

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
- ログイン時の自動起動（理由: 現行版にも無い。必要なら別 Issue。S3 でも範囲外〔2026-09-29・親の決定。ログイン項目の登録は利用者の端末の設定を変えるため〕）
- （S2 で追加）製品版で外部の URL（リンクの証跡など）を既定のブラウザや新しいウィンドウで開くこと（理由: 外部 URL を開くには opener 等の権限と、開いてよい URL の範囲の決定が要る。S2 は安全側に倒し、アプリの外へのナビゲーションと新しいウィンドウを `blob:` 以外すべて拒否する。必要になったら別 Issue で範囲を決める）
- （S2 で追加・S4 で確定）製品版で証跡ファイルをダウンロード（端末へ保存）すること（理由: S2 では保存先の扱いを S4 と併せて決めるとしていたが、**S4 でも作らない**〔2026-09-29・親の決定〕。S4 は保存先の置き換えだけを行い、WebView のダウンロード要求はすべて拒否したままにする。画像・PDF 以外の証跡は製品版では開けない。必要になったら別 Issue で扱う）
- （S3 で追加）メニューバーのメニューの「ウィンドウを開く」「終了」以外の項目（今日の状況の表示・一時停止等）（理由: 決定 2 の常駐に要る最小限に留める。必要なら別 Issue）
- （S3 で追加）通知のクリックで画面を開く・遷移すること（理由: 現行版も未配線〔`notificationUrl` 未設定〕）
- （S3 で追加）OS が通知の表示に失敗したこと・利用者が通知を切っていることの検知と、そのためのプラグインの fork・自前の通知のコマンド（理由: デスクトップのプラグインが表示の結果を捨てる〔S3 の設計の実測〕。決定 2 は通知プラグイン（`tauri-plugin-notification`）を使うとしており、fork は差分に見合わない。製品版の `delivered` は「プラグインが受け付けた」の意味になる）
- （S3 で追加）デスクトップでの通知の許可の問い合わせ・許可を促す画面（理由: デスクトップのプラグインは許可を問い合わせない〔常に許可〕）
- （S3 で追加）App Nap の抑止（`NSProcessInfo` の activity）等、手動の確認で刻みの遅れが見つかる前の追加の手当て（理由: 実機でしか確かめられない。遅れ・停止が見つかったら別 Issue）
- （S3 で追加）デスクトップへの催促の予約の計画し直しの配線・予約通知方式（理由: #585 決定 5。デスクトップは毎分方式）
- （S3 で追加）Dock のアイコンを隠す（メニューバーだけのアプリにする）こと（理由: 決定 2 は「メニューバーに残る」ことだけを求めている。Dock からもウィンドウを戻せる現行の形を保つ）
- （S4 で追加）Node 版の証跡ファイル（`server/data/evidence/`）を製品版の保存先へ移すこと（理由: オーナーの決定 Q3-b。Tauri アプリは新しい DB で始め、証跡ファイルも移さない）
- （S4 で追加）判定と操作の間にファイルをシンボリックリンクへ差し替える競合（TOCTOU）と、`app_config_dir` より上の祖先のディレクトリのシンボリックリンクの手当て（理由: どちらも WebView からは作れず〔シンボリックリンクを作る fs のコマンドを許可しない〕、利用者と同じ権限でファイルシステムを書き換えられるローカルのプロセスを要する。そのプロセスはアプリを介さずにオーナーのファイルを直接読めるため、アプリの境界で防ぐ対象にしない）
- （S4 で追加）保存先の中のシンボリックリンクの 2 段以上の連鎖の手当て（理由: 2026-09-29・オーナーの決定。上流の plugin-fs のスコープの判定はリンクを 1 段しか辿らず、2 段以上の連鎖ではアプリの外に書けるが、リンクを作れるのは利用者の権限で動くローカルのプロセスだけで WebView からは作れない〔シンボリックリンクを作る fs のコマンドを許可しない〕。TOCTOU と同じ理由で、アプリの境界で防ぐ対象にしない。外に出る事実は Rust の観測のテストで固定する）
- （S4 で追加）証跡ファイルの暗号化・孤児ファイル（行の無い実体）の掃除（理由: 開発者用の版にも無い。孤児ファイルの掃除は `evidence-store.ts` の既存の方針〔YAGNI〕のまま）
- （S2 で追加）製品版の DB の実装・DB を使う画面の動作確認（理由: #580 S2。S2 の器は DB に接続せず、DB を使うルートは失敗の応答になる）

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

## 受入基準（S2）

> 2026-09-29（#580 S2）: 下の「DB 未接続」の項（`/api/health` の `db:false`・DB を使うルートが 2xx を返さない・DB ポートの 5 つの口の拒否）は、製品版の DB の準備に失敗したときのフォールバックの振る舞いとして残り、通常の起動では製品版の DB（plugin-sql）に接続する。「capability が許可する権限は 0 件」は、#580 S2 で DB に要る最小の単位（`sql:allow-execute`・`sql:allow-select`）に置き換えた（`docs/features/async-db-layer.md` の受入基準（S2）AC-S2-5）。
> 2026-09-29（#579 S4）: さらに、#581 S3 の通信層のコマンド 5 つ（`docs/features/secure-transport-byok.md` の S3-C3）に加えて、証跡ファイルに要る fs の 4 つの権限（スコープは保存先の直下だけ）を足した。capability の fs の権限は受入基準（S4）の AC-S4-4〜AC-S4-7 を正とする。
>
> 2026-09-29（#579 S3）: さらに、通知の送信（`notification:allow-notify`）と刻みのイベントの購読（`core:event:allow-listen`）を足した。capability の権限は受入基準（S3）の AC-S3-14 を正とする。手動の確認手順（S2）の 6（ウィンドウを閉じるとアプリが終了する）は S3 で置き換わる（手動の確認手順（S3）の 3・9）。
>
> S2 は DB と LLM を使わずに確かめられるものだけを受入基準にする（スライス表）。ウィンドウが開き画面が表示されることなど、人間が実機で見るしかないものは「手動の確認手順（S2）」に分ける。

### アプリ内の `/api`（製品版の web のエントリ）

- [ ] 製品版の web のエントリが包んだ `fetch` で同一オリジンの `/api/health` を呼ぶと、元の `fetch` を呼ばずにアプリ内のコアのルートが応答する
- [ ] 製品版の web のエントリが包んだ `fetch` で、パスが `/api`・`/api/` で始まらない同一オリジンの URL（例: `/apix`・`/index.html`）は、元の `fetch` へ渡される
- [ ] 製品版の web のエントリが包んだ `fetch` で、別オリジンの URL（例: `https://example.com/api/x`）は、元の `fetch` へ渡される
- [ ] 包んだ `fetch` で `/api` 配下へ送った要求の方法・ヘッダ・本文は、アプリ内のルートにそのまま届く（`POST` の JSON 本文で確かめる）
- [ ] 包んだ `fetch` に渡した `signal` を中止すると、アプリ内のルートが受け取った要求の `signal` も中止される
- [ ] 包んだ `fetch` の応答本文は逐次に読める（ルートが本文の最初の断片を送り、最後の断片をまだ送っていない時点で、呼び出し元が最初の断片を読める）
- [ ] 製品版の web のエントリが組み立てたアプリで `/api/health` を呼ぶと、ステータス 200・本文 `{"status":"ok","db":false}` を返す（DB 未接続）
- [ ] 製品版の web のエントリが組み立てたアプリで DB を使うルート（`GET /api/tasks`）を呼ぶと、2xx を返さない
- [ ] 製品版の web のエントリが `createCoreApp` に渡す DB ポートの `run` は、呼ぶと拒否する（SQL を実行しない）
- [ ] 製品版の web のエントリが `createCoreApp` に渡す DB ポートの `get` は、呼ぶと拒否する（SQL を実行しない）
- [ ] 製品版の web のエントリが `createCoreApp` に渡す DB ポートの `all` は、呼ぶと拒否する（SQL を実行しない）
- [ ] 製品版の web のエントリが `createCoreApp` に渡す DB ポートの `exec` は、呼ぶと拒否する（SQL を実行しない）
- [ ] 製品版の web のエントリが `createCoreApp` に渡す DB ポートの `transaction` は、呼ぶと渡した関数を実行せずに拒否する
- [ ] 製品版の web のエントリを読み込んだ後も、登録済みの LLM バックエンドは 0 件である
  - 2026-09-29（#581 S3）: この項は #581 S3 で置き換えた。製品版の web のエントリは、LLM の準備で BYOK（Anthropic）を登録する（登録済みは `byok-anthropic` だけ。`docs/features/secure-transport-byok.md` の受入基準（S3）S3-E1）。コアのエントリ（`core-entry.ts`）を読み込んだだけでは何も登録しないことは変わらない

### 製品版に開発者用の経路が混入しないこと（ビルドの検査）

- [ ] 製品版の web のビルド（Vite）の入力モジュールに `@anthropic-ai/claude-agent-sdk` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/llm/backends/claude-code-backend.ts` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `@anthropic-ai/sdk` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `@hono/node-server` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `better-sqlite3` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/db/connection.ts` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/app.ts` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/index.ts` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/llm/dev-llm-backends.ts` が含まれない
- [ ] 製品版の web のビルドの入力モジュールに `server/src/core-app.ts` が含まれる（コアがアプリ内に載る）
- [ ] 開発者用の web のビルド（`web/index.html` のエントリ）の入力モジュールに `server/src/` のモジュールが含まれない

### 証跡ファイルのリンク（Blob URL）

- [ ] Blob URL の方式を注入した画面で証跡ファイルのリンクを押すと、`/api/tasks/:id/evidences/:evidenceId/content` を `fetch` で取得し、その本文の `blob:` URL を新しいウィンドウで開く
- [ ] Blob URL の方式で開いた `blob:` URL は、開いてから 60 秒後に失効させる（`URL.revokeObjectURL`）
- [ ] Blob URL の方式で本文の取得が 2xx 以外で終わったとき、新しいウィンドウを開かず、証跡の欄にエラーを表示する
- [ ] Blob URL の方式を注入しない画面（開発者用の版）では、証跡ファイルのリンクは現行どおり `href` が `/api/tasks/:id/evidences/:evidenceId/content` の `<a>` である

### Tauri の器の権限と到達経路（Rust のテスト・設定の検査）

- [ ] アプリの capability（`capabilities/`）が許可する権限は 0 件である
- [ ] `tauri.conf.json` の `app.withGlobalTauri` は有効でない
- [ ] `tauri.conf.json` の CSP の `default-src` は `'self'` だけである（CSP が未設定・`null` なら不合格）
- [ ] CSP の `script-src` は `'unsafe-inline'`・`'unsafe-eval'` を含まない
- [ ] CSP の `connect-src` は外部のオリジン（`http:`・`https:`・`ws:`・`wss:` のスキームやホストの指定）を含まない
- [ ] CSP の `object-src` は `'none'` である
- [ ] CSP の `frame-src` は `'none'` である
- [ ] CSP の `base-uri` は `'none'` である
- [ ] CSP の `form-action` は `'none'` である
- [ ] CSP の `img-src` は `'self'`・`data:`・`blob:` 以外を含まない
- [ ] `tauri.conf.json` の `app.security.dangerousDisableAssetCspModification` は有効でない
- [ ] `tauri.conf.json` の `app.security.assetProtocol.enable` は有効でない
- [ ] アプリのクレートの `tauri` の機能に `protocol-asset` を含まない
- [ ] メインのウィンドウのナビゲーションの判定は、`tauri://localhost` のオリジンの URL だけを許し、それ以外（`https://example.com/`・`http://localhost:8787/`・`file:///etc/hosts`・`blob:tauri://localhost/<uuid>`・`data:text/html,x`）を拒否する
- [ ] 新しいウィンドウの要求の判定は、`blob:tauri://localhost/<uuid>` だけを許し、それ以外（`https://example.com/`・`http://localhost:8787/`・`file:///etc/hosts`・`blob:https://example.com/<uuid>`・`data:text/html,x`・`about:blank`）を拒否する
- [ ] アプリのクレートの依存に `tauri-plugin-shell` を含まない
- [ ] `tauri.conf.json` に `bundle.externalBin`（サイドカー）が無い
- [ ] `tauri.conf.json` に `build.devUrl` が無い（開発時も `localhost` の配信を読まない）
- [ ] `tauri.conf.json` の `build.frontendDist` は製品版の web のビルドの出力を指す

### 開発者用の版と品質ゲート

- [ ] ADR 0002 に、製品版で永続状態と DB への副作用を受け持つ層は WebView 内の TS コア（Hono アプリ）である、という改訂が記録されている
- [ ] `npm run lint`・`npm run typecheck`・`npm test`・`npm run test:tz`・`npm run test:rust`・`npm run test:tauri`（アプリのクレートの `cargo test`）が合格する
- [ ] `npm run build:tauri` で macOS の `.app` が生成される
- [ ] 生成された `.app` に `node` という名前のファイルが含まれない
- [ ] 生成された `.app` に `node_modules` という名前のディレクトリが含まれない

## 手動の確認手順（S2）

人間が実機（macOS）で確かめる。`npm run build:tauri` の後に行う。

1. 生成された `.app`（`native/tauri-app/target/release/bundle/macos/`）を起動する。Node サーバー（`npm run start`）は起動しない状態で行う。
2. ウィンドウが開き、既存の画面（ダッシュボード等）の枠組みが表示されることを確かめる。DB が未接続のため、データを読む部分はエラーの表示になるのが正しい（#580 S2 まで）。
3. 画面の接続状態の表示が「未接続」ではなく「接続 OK」になることを確かめる（`/api/health` がアプリ内で 200 を返すため。接続状態の表示は HTTP のステータスだけを見ており `db` を区別しない。DB 未接続の区別の表示は S2 では作らない）。
4. `lsof -iTCP -sTCP:LISTEN -P | grep -i ai-boss` で、アプリが TCP のポートを待ち受けていないことを確かめる。
5. オーナーの DB（`server/data/ai-boss.db`）の更新時刻がアプリの起動・操作で変わらないことを確かめる。
6. ウィンドウを閉じるとアプリが終了することを確かめる（メニューバーへの常駐は S3）。

## 受入基準（S3）

> S3 は自動テストで固定できるものを受入基準にし、非表示の WebView が実機で刻みを処理し続けること・OS の通知が実際に表示されること・メニューバーのアイコンの見え方など、人間が実機で見るしかないものは「手動の確認手順（S3）」に分ける。**テストでは OS の通知を実際に送らない**（Rust の結合テストで `plugin:notification|notify` を許可された形で呼ばない。呼ぶと開発機で通知が出るため）。時刻はローカル日付で組む（ADR 0007）。

### ウィンドウを閉じる挙動・メニューバー（Rust のテスト）

- [ ] AC-S3-1: 閉じる要求の判定は、メインのウィンドウ（ラベル `main`）では「閉じずに隠す」を返し、それ以外のウィンドウ（例: 証跡の新しいウィンドウのラベル）では「閉じる」を返す
- [ ] AC-S3-2: 器（`MockRuntime`）でメインのウィンドウに閉じる要求（`close`）を送った後も、メインのウィンドウは破棄されずに残る
- [ ] AC-S3-3: メニューバーのメニューの項目は「ウィンドウを開く」「終了」の 2 つだけで、この順に並ぶ
- [ ] AC-S3-4: メニューの「ウィンドウを開く」の項目の ID から操作を引くと、メインのウィンドウを表示する操作（操作を表す列挙の値）が返る
- [ ] AC-S3-5: メニューの「終了」の項目の ID から操作を引くと、アプリを終了する操作が返る
- [ ] AC-S3-6: メニューの項目に無い ID から操作を引くと、操作は返らない
- [ ] AC-S3-7: 再表示の要求（Dock のアイコン）の判定は、見えているウィンドウが無いときはメインのウィンドウを表示する操作を返し、あるときは何もしない
- [ ] AC-S3-8: メインのウィンドウの設定の `background_throttling` は `Disabled` である
- [ ] AC-S3-9: メインのウィンドウの設定の URL は製品版の web のエントリ（`app.html`）である（S2 の器のまま）

### 毎分の刻み（Rust のテスト）

- [ ] AC-S3-10: 次の刻みまでの待ち時間は、今から次の分の境界（秒 0）までである。例: 分の境界ちょうど → 60 秒、境界の 1 ミリ秒後 → 59.999 秒、30 秒 → 30 秒、59.999 秒 → 1 ミリ秒
- [ ] AC-S3-11: 刻みの送り手は、待ちが終わるたびに、刻みのイベント（`minute-tick`）をメインのウィンドウへ 1 回送る（即時に返す待ちに差し替えて、待ちを 3 回終えると 3 回送る）
- [ ] AC-S3-12: 器（`MockRuntime`）でメインのウィンドウに閉じる要求を送った後も、刻みの送り手はメインのウィンドウへ刻みのイベントを送り続ける
- [ ] AC-S3-13: 器を組み立てると（`setup` の後）、刻みの送り手が起動したことを示す器の状態が取得できる

### 権限（Rust のテスト・設定の検査）

- [ ] AC-S3-14: S3 の時点で、アプリの capability が許可する権限は、`sql:allow-execute`・`sql:allow-select`・`notification:allow-notify`・`core:event:allow-listen` の 4 つだけである
- [ ] AC-S3-15: メインのウィンドウから `plugin:notification|request_permission` を呼ぶと、権限の不足で拒否される
- [ ] AC-S3-16: メインのウィンドウから `plugin:notification|is_permission_granted` を呼ぶと、権限の不足で拒否される
- [ ] AC-S3-17: メインのウィンドウからイベントを送るコマンド（`plugin:event|emit`）を呼ぶと、権限の不足で拒否される

### 通知ポート（TypeScript のテスト）

- [ ] AC-S3-18: 毎分の検知（`createTicker`）で発火が 1 件あるとき、渡した通知ポートがその発火のタイトルと本文で 1 回呼ばれる
- [ ] AC-S3-19: 毎分の検知で発火が 0 件のとき、通知ポートは呼ばれない
- [ ] AC-S3-20: 毎分の検知で通知ポートが `delivered: false` を返したとき、その送信履歴の行の `delivered` は 0、`channel` は通知ポートが返した値になる
- [ ] AC-S3-21: 開発者用の版の `startScheduler` が毎分の検知に渡す通知ポートは、`notifier.ts` の `sendNotification` に `nodeSystemExecFile` を渡して送る
- [ ] AC-S3-22: 製品版の通知ポートは、`invoke` を `plugin:notification|notify` と `{ options: { title, body } }` で 1 回呼ぶ
- [ ] AC-S3-23: 製品版の通知ポートは、`invoke` が解決したとき `{ delivered: true, channel: "tauri-notification" }` を返す
- [ ] AC-S3-24: 製品版の通知ポートは、`invoke` が拒否したとき例外にせず `{ delivered: false, channel: "none" }` を返す
- [ ] AC-S3-25: 製品版の通知ポートは、`invoke` が拒否したとき、その失敗をログに出す

### 製品版の毎分の検知の起動（TypeScript のテスト）

- [ ] AC-S3-26: 製品版の毎分の検知を始めると、刻みのイベント（`minute-tick`）の購読を 1 回始める
- [ ] AC-S3-27: 製品版の毎分の検知は、刻みのイベントを 1 回受けるたびに検知（`tick`）を 1 回走らせる
- [ ] AC-S3-28: 製品版の毎分の検知で発火が 1 件あるとき、その送信履歴の行は開始時に渡した DB のポートに書かれる（送信の形は AC-S3-22 で確かめる）
- [ ] AC-S3-29: 製品版の毎分の検知は、`env` を空のオブジェクトにして組み立てられる（`createTicker` に渡る `env` にキーが無い）
- [ ] AC-S3-30: 製品版の web のエントリの起動で、DB の準備に成功したときは、そのポートで毎分の検知を始める
- [ ] AC-S3-31: 製品版の web のエントリの起動で、DB の準備に失敗して「DB 未接続」で起動したときは、毎分の検知を始めない
- [ ] AC-S3-32: 製品版の web のエントリの起動で、毎分の検知の開始が失敗しても、画面を描画する
- [ ] AC-S3-33: 製品版の web のエントリの起動で、毎分の検知の開始が失敗したとき、その失敗をログに出す

### ビルドの検査

- [ ] AC-S3-34: 製品版の web のビルドの入力モジュールに `node-cron` が含まれない
- [ ] AC-S3-35: 製品版の web のビルドの入力モジュールに `server/src/scheduler/scheduler.ts` が含まれない
- [ ] AC-S3-36: 製品版の web のビルドの入力モジュールに `server/src/notifications/notifier.ts` が含まれない
- [ ] AC-S3-37: 製品版の web のビルドの入力モジュールに `server/src/scheduler/scheduler-tick.ts` が含まれる
- [ ] AC-S3-38: 製品版の web のビルドの入力モジュールに `@tauri-apps/plugin-notification`（JS の通知 API）が含まれない
- [ ] AC-S3-39: コアのエントリ（`core-entry.ts`）から `createTicker` を import できる
- [ ] AC-S3-40: `createTicker` を re-export した状態で、コアのバンドル検査（`core-entry.bundle.test.ts`）に合格する

### 開発者用の版と品質ゲート

- [ ] AC-S3-41: `scheduler.test.ts` の既存のテスト（node-cron の `* * * * *`・`tick` の呼び出し・`stop`）が変更なしで合格する（`startScheduler` の引数〔`db`・`env`・`notificationUrl`〕は変えず、内部で通知ポートを組む）
- [ ] AC-S3-42: `notifier.test.ts` の既存のテストが変更なしで合格する
- [ ] AC-S3-43: `scheduler-tick.test.ts` の既存のテストが期待値を変えずに合格する（変えるのは `createTicker` に渡す依存の組み立てだけ。`execFile` のモックは `notifier.ts` の `sendNotification` で包んだ通知ポートとして渡す）
- [ ] AC-S3-44: `npm run lint`・`npm run typecheck`・`npm test`・`npm run test:tz`・`npm run test:rust`・`npm run test:tauri`・`npm run test:tauri-db` が合格する
- [ ] AC-S3-45: `npm run build:tauri` で macOS の `.app` が生成される（macOS の開発機で実行する）
- [ ] AC-S3-46: `npm run build:tauri` の後、`npm run verify:tauri-bundle` が合格する

## 手動の確認手順（S3）

人間（オーナー）が実機（macOS 14 以上）で確かめる。`npm run build:tauri` の後に行う。最初に `stat -f %Sm server/data/ai-boss.db` でオーナーの DB の更新時刻を控える。Node サーバー（`npm run start`）は起動しない状態で行う。S3 の時点では製品版の LLM バックエンドが 0 件のため、通知の本文は定型文になる（#581 S3 のマージ後は LLM の文面になる）。製品版の DB は `~/Library/Application Support/dev.aiboss.app/ai-boss.db`。

1. 生成された `.app`（`native/tauri-app/target/release/bundle/macos/`）を起動し、メニューバーに ai-boss のアイコンが出て、押すと「ウィンドウを開く」「終了」の 2 項目のメニューが出ることを確かめる。
2. 今日の朝会の時刻を今から 3 分後（以下 T）に変える（朝会は実施しない。朝会の通知は勤務時間の判定の対象外）。催促の間隔の設定は既定（L1→L2 15 分・L2→L3 10 分・L3 の繰り返し 10 分）のままにする。
3. ウィンドウの閉じるボタンでウィンドウを閉じ、メニューバーのアイコンと Dock のアイコンが残ることを確かめる。
4. 朝会の時刻に朝会のリマインドの通知（アプリ名 ai-boss）が表示されることを確かめる。
5. **（タイマーの間引き・停止の確認）** ウィンドウを閉じたまま T+36 分まで待ち（非表示の WebView が止まりうる約 5 分を大きく越える）、朝会のリマインドが T+15 分（L2）・T+25 分（L3）・T+35 分（L3 の繰り返し）に届くことを確かめる（各 ±1 分）。
6. 手順 5 の後、`sqlite3 ~/Library/Application\ Support/dev.aiboss.app/ai-boss.db "select sent_at, rule_key, escalation_level, delivered, channel from notifications where rule_key like 'morning_meeting%' order by id"` で、段階 1・2・3・3 の 4 行の `sent_at`（UTC）がローカル時刻で T・T+15・T+25・T+35 分（各 ±1 分）に並び（ウィンドウを開き直した時刻にまとめて書かれていない）、`channel` が `tauri-notification`・`delivered` が 1 であることを確かめる。まとめて書かれている・届かない場合は、その見え方を記録して別 Issue にする。
7. メニューバーの「ウィンドウを開く」でウィンドウが表示されることを確かめる。もう一度閉じ、Dock のアイコンを押してウィンドウが表示されることを確かめる。
8. システム設定の「通知」に ai-boss があり、通知が許可されていることを確かめる（デスクトップのプラグインは許可を問い合わせないため、表示されない場合はここを確かめる。切っている場合、アプリは送信の失敗として記録しない〔「やらないこと（S3）」〕）。
9. メニューバーの「終了」でアプリが終了し（メニューバー・Dock のアイコンが消える）、`pgrep -fl ai-boss` にアプリのプロセスが残らないことを確かめる。もう一度起動し、⌘Q でも終了することを確かめる。
10. `stat -f %Sm server/data/ai-boss.db` の更新時刻が、最初に控えた値から変わっていないことを確かめる。
11. **（スリープからの復帰の確認・#659）** アプリを起動してウィンドウを閉じ、今日の朝会の時刻を今から 2 分後（以下 T）に変えてから、すぐに Mac をスリープする（アップルメニューの「スリープ」）。T+3 分を過ぎてから復帰し、朝会のリマインドの通知が復帰から約 10 秒以内に表示される（約 1 分遅れない）ことを確かめる（刻みの眠りは 5 秒ごとに壁時計を確かめ直す。`desktop_shell::sleep_until_wall_clock`）。遅れる場合は、復帰した時刻と通知の時刻を記録して別 Issue にする。
12. もう一度起動した状態で、ターミナルから `open -n` で同じ `.app` を開き（2 つ目の起動）、新しいプロセスが残らず（`pgrep -fl ai-boss` が 1 つだけ）、既にあるウィンドウが前面に出ることを確かめる（多重起動の防止・#659）。

## 受入基準（S4）

> S4 は、製品版の証跡ファイルの保存先をアプリのデータディレクトリへ置き、plugin-fs の権限を保存先だけに限ることを受入基準にする。実機でアプリを起動して確かめるものは「手動の確認手順（S4）」に分ける。「両版」は、開発者用の版（Node fs 実装・`npm test`）と製品版（plugin-fs 実装・器の IPC の中継・`npm run test:tauri-db`）の両方で、同じ契約スイートの本体が合格することを指す。

### 保存先（Rust のテスト。`HOME` を一時ディレクトリにして確かめる）

- [ ] AC-S4-1: 器を起動すると、アプリのデータディレクトリ（`app_config_dir`）の直下に `evidence` ディレクトリが作られる
- [ ] AC-S4-2: 起動時に `app_config_dir` の直下の `evidence` がシンボリックリンク（リンク先がアプリの外のディレクトリ・アプリの中のディレクトリのいずれでも）のとき、器の組み立て（`setup`）は失敗する
- [ ] AC-S4-3: 起動時に `app_config_dir` の直下の `evidence` が通常のファイルのとき、器の組み立て（`setup`）は失敗する

### 権限（設定の検査）

- [ ] AC-S4-4: アプリの capability が許可する fs の権限は `fs:allow-read-file`・`fs:allow-write-file`・`fs:allow-remove`・`fs:allow-exists` の 4 つだけである（`fs:default`・`fs:scope`・それ以外の `fs:` の権限を含まない）
- [ ] AC-S4-5: アプリの capability が許可する sql の権限は、#580 S2 の `sql:allow-execute`・`sql:allow-select` のままである
- [ ] AC-S4-6: capability の fs の 4 つの権限は、いずれも許可のスコープを `$APPCONFIG/evidence/*` の 1 件だけ持つ
- [ ] AC-S4-7: capability の fs の 4 つの権限は、いずれも拒否のスコープを持たない
- [ ] AC-S4-8: アプリのクレートの `tauri-plugin-fs` は 2.6 系に解決される（`Cargo.lock`）
- [ ] AC-S4-9: web の `@tauri-apps/plugin-fs` の版の major・minor は、アプリのクレートの `tauri-plugin-fs` の major・minor と一致する

### 権限と到達経路（Rust の結合テスト。器の ACL の上で `main` のウィンドウから IPC を送る）

- [ ] AC-S4-10: `baseDir` を AppConfig にした `evidence/<UUID>.png` への `plugin:fs|write_file`・`plugin:fs|exists`・`plugin:fs|read_file`・`plugin:fs|remove` は実行され、書いたバイト列が `app_config_dir/evidence/` のファイルに残り、読めて、消える
- [ ] AC-S4-11: 許可していない fs のコマンド（`plugin:fs|mkdir`・`plugin:fs|read_dir`・`plugin:fs|rename`・`plugin:fs|copy_file`・`plugin:fs|stat`）は、保存先の中のパスでも拒否される（`plugin:fs|open` は上流の `fs:allow-write-file` が同じスコープで許可するため対象外。「S4 の設計」の実測・2026-09-29 のオーナーの決定）
- [ ] AC-S4-12: `..` を含むパス（`evidence/../ai-boss.db`・`evidence/../../outside.txt`）の `read_file`・`write_file` は拒否され、保存先の外のファイルは読めず、内容も変わらない
- [ ] AC-S4-13: 絶対パス（アプリのデータディレクトリの外の実在するファイル。`baseDir` あり・なし）の `read_file`・`write_file`・`remove` は拒否され、そのファイルの内容は変わらず、消えない
- [ ] AC-S4-14: `file:` の URL（アプリのデータディレクトリの外の実在するファイル）の `read_file` は拒否される
- [ ] AC-S4-15: 保存先の中に置いた、アプリの外のファイルを指すシンボリックリンク（リンク先が実在する場合・リンク切れの場合）の `read_file`・`write_file` は拒否され、リンク先は読めず、書かれない
- [ ] AC-S4-16: 保存先の兄弟（`app_config_dir` 直下の `ai-boss.db`）への `read_file`・`write_file`・`remove` は拒否され、DB ファイルは内容が変わらず、消えない
- [ ] AC-S4-17: 保存先のサブディレクトリのパス（`evidence/sub/x.png`）の `write_file` は拒否される
- [ ] AC-S4-18: 保存先のディレクトリそのもの（`evidence`）の `remove` は拒否され、ディレクトリは残る
- [ ] AC-S4-19: 保存先の名前の大文字小文字を変えたパス（`Evidence/<UUID>.png`・`EVIDENCE/<UUID>.png`）の `write_file` は、証跡のディレクトリ（`app_config_dir/evidence/`）の外にファイルを作らない（2026-09-29・オーナーの決定で「拒否される」から書き換え。照合は大文字小文字を区別しない〔「S4 の設計」の実測〕）

### 製品版の証跡の保存の実装（web のテスト）

- [ ] AC-S4-20: 製品版の plugin-fs 実装は、保存名が「小文字の UUID ＋ ホワイトリストの拡張子（小文字）」の形でないとき（`../x.png`・`/etc/hosts`・`a/b.png`・`a\b.png`・`<UUID>.PNG`・`<大文字の UUID>.png`・`<UUID>.exe`・`<UUID>`・空文字）、`write`・`read`・`remove` のいずれでも plugin-fs（IPC）を呼ばない
- [ ] AC-S4-21: 製品版の plugin-fs 実装の `write` は、形の検査に通らない保存名を拒否する（例外で失敗する）
- [ ] AC-S4-22: 製品版の plugin-fs 実装の `read` は、形の検査に通らない保存名に `undefined` を返す
- [ ] AC-S4-23: 製品版の plugin-fs 実装の `remove` は、形の検査に通らない保存名で失敗しない（例外を投げない）
- [ ] AC-S4-24: 製品版の plugin-fs 実装は、plugin-fs を `baseDir: BaseDirectory.AppConfig` と相対パス `evidence/<保存名>` で呼ぶ（IPC の要求の引数で確かめる）
- [ ] AC-S4-25: 器の IPC の中継の上で製品版の plugin-fs 実装が `write` すると、中継の `HOME` の `Library/Application Support/dev.aiboss.app/evidence/<保存名>` に、書いたバイト列のファイルができる

### 両版で同じ契約（契約スイート）

- [ ] AC-S4-26: 両版で、`write` したバイト列（0 バイト・1 MB を含む）は `read` で同じバイト列に戻る
- [ ] AC-S4-27: 両版で、書いていない保存名の `read` は `undefined` を返す
- [ ] AC-S4-28: 両版で、`remove` した保存名の `read` は `undefined` を返す
- [ ] AC-S4-29: 両版で、書いていない保存名の `remove` は失敗しない

### 製品版のエントリ（器の IPC の中継の上）

- [ ] AC-S4-30: 製品版の web のエントリが組み立てたアプリで、ファイル証跡をアップロード（`POST /api/tasks/:id/evidences`）すると、その本文（`GET …/content`）は送ったバイト列と同じである
- [ ] AC-S4-31: 製品版の web のエントリが組み立てたアプリで、ファイル証跡を削除（`DELETE …/evidences/:evidenceId`）すると、その実体のファイルは保存先から消える
- [ ] AC-S4-32: 製品版の web のビルドの入力モジュールに `server/src/tasks/evidence-storage.ts`（開発者用の版の Node fs 実装）が含まれない（#579 S2 の検査を保つ）
- [ ] AC-S4-33: 製品版の web のビルドの入力モジュールに `@tauri-apps/plugin-fs` が含まれる

### 開発者用の版・品質ゲート

- [ ] AC-S4-34: 開発者用の版の証跡の保存・読み出し・削除の既存テスト（`evidence-storage.test.ts`・`task-evidences-routes.test.ts`・`core-app.test.ts`）が変更なしで合格する（保存先は現行どおり DB と同じディレクトリの `evidence/`）
- [ ] AC-S4-35: `npm run lint`・`npm run typecheck`・`npm test`・`npm run test:tz`・`npm run test:rust`・`npm run test:tauri`・`npm run test:tauri-db` が合格する
- [ ] AC-S4-36: `npm run build:tauri` で macOS の `.app` が生成され、`npm run verify:tauri-bundle` が合格する

## 手動の確認手順（S4）

人間が実機（macOS）で確かめる。`npm run build:tauri` の後に行う。Node サーバー（`npm run start`）は起動しない状態で行う。

1. オーナーの開発者用の版の証跡のディレクトリ（`server/data/evidence/`）のファイルの一覧と更新時刻（`ls -la server/data/evidence/`）、オーナーの DB（`server/data/ai-boss.db`）の更新時刻を控える。
2. 生成された `.app`（`native/tauri-app/target/release/bundle/macos/`）を起動し、タスクを 1 件作り、画像（PNG）と PDF の証跡ファイルを 1 件ずつアップロードする。
3. `ls -la ~/Library/Application\ Support/dev.aiboss.app/evidence/` に 2 つのファイル（`<UUID>.png`・`<UUID>.pdf`）があることを確かめる。
4. **（S2 の未検証のリスク）** 画像の証跡のリンクを押し、新しいウィンドウが開いて画像が表示されることを確かめる。PDF の証跡も同じく確かめる。表示されない（空白・エラー）ときは、その見え方を記録して別 Issue にする。**この手順の結果は S4 の合否に含めない**（「S2 の器の設計」が `blob:` の新しいウィンドウを「証跡を扱えるようになった後に手動で確かめる未検証のリスク」としており、S4 の範囲は保存先の置き換えだけのため。手当ては確かめた時点で決める〔クリティカル設計決定 1「未検証点の扱い」と同じ扱い〕）。
5. アプリを終了して起動し直し、手順 3 の 2 つのファイルが残っていることを確かめる。手順 4 で表示できた場合は、証跡のリンクを押して同じ画像が表示されることも確かめる。
6. 画像の証跡を削除し、手順 3 のディレクトリから `<UUID>.png` が消えたことを確かめる。
7. 手順 1 のディレクトリの一覧・更新時刻と DB の更新時刻が変わっていないことを確かめる。

## 仮定（軽微・可逆）

- A1: `server/` ディレクトリは S1 では動かさない（ワークスペースの再編は差分が大きく、S1 の目的に要らない）
- A2: `task-fingerprint.ts` のハッシュは、同期のまま動く非 Node の実装に置き換える（キャッシュ用の指紋であり暗号強度は要件でない。値が変わるとダッシュボードのボスのコメントのキャッシュが 1 回無効になるだけ）
- A3: 製品版のコアのエントリのファイル名・置き場所は実装で決める（S1 で `server/src/core-entry.ts` に決まった）
- A4（S2）: Tauri のアプリ本体のクレートは `native/tauri-app/` に置き、`native/secure-transport/` と同じく独立したクレート（Cargo のワークスペースにしない）とする。#581 S3 で通信層を配線するときは path 依存で足せる。ワークスペース化はそのとき必要なら行う
- A5（S2）: 製品版の web のエントリは `web/` の中に別の HTML・エントリ・Vite の設定として置き、出力は `web/dist-app/` とする（`web/` の画面コンポーネントを流用するため。新しい npm ワークスペースは作らない）
- A6（S2）: Blob URL の失効までの時間は 60 秒とする（新しいウィンドウが本文を読み終えるのに十分で、開きっぱなしの URL を残さない長さ。値は後で変えてよい）
- A7（S2）: CSP の `style-src` は `'self' 'unsafe-inline'` とする（スタイルはスクリプトを実行しないため。画面のライブラリが実行時に `<style>` を差し込んでも崩れないようにする）
- A8（S2）: アプリの識別子（bundle identifier）は `dev.aiboss.app`、製品名は `ai-boss` とする（署名・配布〔#587〕で見直してよい）
- S3-A1（S3）: 毎分の刻みは Rust 側のタイマーから送り、メインのウィンドウの `background_throttling` を `Disabled` にする（理由は「S3 の設計」の「毎分の刻みの供給元」。可逆で、実機の確認で WebView のタイマーで足りると分かれば戻してよい）。仮定の番号は、並行する S4（PR #656）の A9〜A14 と衝突しないよう `S3-` を付ける
- S3-A2（S3）: 刻みのイベントの名前は `minute-tick` とし、宛先はメインのウィンドウだけにする。刻みは次の分の境界まで毎回計算し直して待つ（遅れても次の刻みで境界へ戻り、ずれが積み上がらない）
- S3-A3（S3）: 製品版の送信の `channel` の値は `tauri-notification` とする（`notifications.channel` は CHECK 制約の無い文字列で、スキーマは変えない）
- S3-A4（S3）: メインのウィンドウは、S2 の `WebviewWindowBuilder::new` を、コードで組んだ `WindowConfig` からの `WebviewWindowBuilder::from_config` に置き換えて作る（`background_throttling` の設定値をテストで検査できる形にするため。`tauri.conf.json` の `app.windows` は空のまま）
- S3-A5（S3）: メニューバーのアイコンはアプリの既定のアイコン（`bundle.icon`）を使う（テンプレート画像〔単色〕は用意しない。見え方は後で変えてよい）
- S3-A6（S3）: `tauri-plugin-notification` は `~2.5` に固定し（2.5.0 の実測に拠るため）、JS のパッケージ `@tauri-apps/plugin-notification` は入れない（`@tauri-apps/api` の `invoke` で直接呼ぶ）
- S3-A7（S3）: Tauri の API を呼ぶ部分（トレイ・メニューの組み立て・ウィンドウの表示・`exit`）は薄く保ち、判定だけを純粋な関数としてテストする（`MockRuntime` は `hide`・`show` を観測できず、終了の要求は未実装のため）
- S3-A8（S3）: 刻みの送り手が起動したことを示す器の状態の型・名前は実装で決める。AC-S3-14 の権限の一覧は、並行する #581 S3（PR #653）・#579 S4（PR #656）が先にマージされたら、その権限を足した一覧に読み替える（S3 が足すのは `notification:allow-notify`・`core:event:allow-listen` の 2 つ）
- S3-A9（S3・実装時）: 通知プラグインの初期化スクリプトが呼ぶ `is_permission_granted` の拒否（コンソールの未処理の拒否 1 件）は受け入れ、権限を最小（AC-S3-14）のままにする。気になるなら `notification:allow-is-permission-granted` を足す（AC-S3-14・AC-S3-16 の変更になるため、オーナーまたは親の判断で行う）
- S3-A10（S3・実装時）: 製品の刻みは次の分の境界の 100 ミリ秒後に送る（眠りは単調時計、境界は壁時計のため、早く起きたときに前の分を読まないように）。待ち時間の計算（AC-S3-10）は境界までのまま
- S3-A11（#659・実装時）: 製品の眠りは 5 秒ごとに区切り、眠り始めの壁時計から待ち時間の後の時刻を過ぎていれば残りを眠らずに刻みを送る（Mac のスリープ中は単調時計が進まず、1 回で境界まで眠ると復帰の後の最初の刻みが最大で約 60 秒遅れるため）。眠りの合計は待ち時間を越えない（壁時計が戻っても 1 回で眠るのより遅れない）。区切りの判定は単体テストで固定し、実機のスリープからの復帰は手動の確認手順（S3）の 11 で確かめる
- S3-A12（#659・実装時）: 多重起動は `tauri-plugin-single-instance`（2 系）で防ぐ。2 つ目の起動は器のプラグインの初期化（DB の preload・刻みの送り手の起動より前）で既にあるプロセスへ知らせて終わり、既にあるプロセスはメインのウィンドウを表示して前面に出す。プラグインは WebView のコマンドを持たないため capability（AC-S3-14）は変わらない。プラグインは製品の `run` の組み立てだけに入れ、`MockRuntime` の結合テストが共有する `configure` には入れない（テストのプロセスが 2 つ目の起動と判定されて終了しないように）
- A9（S4）: plugin-fs は `tauri-plugin-fs` 2.6（2026-09-29 時点の 2 系の最新。3 系は alpha）と `@tauri-apps/plugin-fs` 2.6 を使う（fork しない。plugin-sql と違い、上流の振る舞いを変える必要が無い）
- A10（S4）: 証跡の保存ポート（`EvidenceStore`）の `write`・`read`・`remove` は、戻り値に `Promise` を許す形にする（引数と `Uint8Array` の受け渡しは S1 のまま。開発者用の版の Node fs 実装は同期のまま。コアは `await` する）。plugin-fs が非同期のための内部構造の変更で、S1 の受入基準（既存テストが変更なしで合格）を保つ
- A11（S4）: 製品版の保存先のディレクトリ名は `evidence` とする（開発者用の版と同じ名前。場所がアプリのデータディレクトリなので取り違えない）
- A12（S4）: 保存名の検査に通らないときの振る舞いは、`write` が拒否（例外）・`read` が `undefined`（本文の取得は 404）・`remove` が何もしない、とする（`remove` は行の削除の確定後に呼ばれるため、例外にすると削除の応答だけが 500 になり行は消えている、という食い違いを作る。検査に通らない名前の実体はこの実装が書いたものではない）。検査を通った名前での I/O の失敗は、開発者用の版と同じく失敗を伝える
- A13（S4）: 保存先のディレクトリが実ディレクトリでないときは、エラーの画面を作らず起動を止める（#580 S2 の A7 の Rust 側の失敗と同じ扱い。オーナー以外の利用者が自然に作る状態ではない）
- A14（S4）: IPC の中継（`examples/sql-ipc-bridge.rs`）は名前を変えずに raw の本文・ヘッダ・raw の応答の受け渡しを足す（#580 S2 のテストの起動の仕組みをそのまま使うため。名前の一般化は必要になったら行う）
