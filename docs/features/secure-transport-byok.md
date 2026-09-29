# 秘密情報を扱う Rust 通信層と BYOK キーの保管（キーチェーン）

> Issue #581。2026-09-26 に論点 Q1〜Q5 を確定した（親の回答とオーナーの回答。オーナーの回答は「決定」節に要約して記録する）。
> 2026-09-27: S1（#600・PR #616）のマージ後、S2 を実装対象にするため改訂した（「実コードの実測」の取り直し・クリティカル設計決定 5・S2 の IF・受入基準（S2））。S2 の範囲に、#582 の決定 Q5（親）による「バックエンドの名前の分岐を能力の宣言へ置き換える」を加えた。
> 2026-09-29: S2（#630・PR #631）・#579 S2（#645・PR #646）・#580 S2（#651・PR #652）のマージ後、S3 を実装対象にするため改訂した（「決定（2026-09-29・S3）」・「S3 向けの取り直し」・クリティカル設計決定 7〜9・迂回経路の列挙・IF / API（S3）・受入基準（S3）・手動の確認手順（S3）・仮定 A16〜A24）。S3 の範囲に、#582 のクリティカル設計決定 5「選択の解決関数の注入」の**骨格**を加えた（オーナーの決定 Q6）。S1・S2 の受入基準は変えていない。

## 概要

製品版（Tauri 2 アプリ）で、BYOK の API キーを端末の OS のセキュアストレージ（macOS / iOS はキーチェーン）に保管し、キーを付与したプロバイダへの HTTP 送信（ストリーミングを含む）を **Rust の薄い通信層**から行う。キーは WebView に返さない。プロンプトの組み立て・tool use の処理は TypeScript のコアに残す（[ADR 0011](../adr/0011-productization-architecture.md) 決定 6・10・15・16、[ADR 0002](../adr/0002-api-key-and-llm-call-path.md) 改訂の決定 1〜4・7）。

## 背景・目的

- 製品版のコアには LLM バックエンドが 1 つも登録されていない（#579 のオーナー決定 Q4-c）。**製品版で LLM を使う流れ（朝会・夕会・チャット・通知文面）は本機能が済むまで動かない**。#579 の完了条件「朝会・夕会が Tauri で動く」の確認も本機能の後になる。
- 現行の `api` バックエンドは `@anthropic-ai/sdk` を TS の中で動かし、キーを環境変数から読む。WebView で使うとキーが WebView に載る（ADR 0002 改訂の決定 3 に反する）。
- #576 の spike はキーチェーンの読み書きを Rust（`security-framework`）で行ったが、**読み出したキーを WebView へ返し**、WebView から `@tauri-apps/plugin-http` で送った（`anthropic-dangerous-direct-browser-access` ヘッダが必要だった）。製品ではこの形を採らない（spike の README「詰まった点と回避策」の 3 も Rust 側からの送信を推奨）。

## ユーザーストーリー

- 製品版の利用者として、自分の Claude（Anthropic）の API キーを一度登録すれば、以後はキーを意識せずにボスとの対話・朝会・夕会を使いたい。キーが画面のコードや保存データから読み出されない安心がほしい。
- 製品版の利用者として、登録したキーを削除（差し替え）したい。

## 決定（2026-09-26）

### オーナーの決定（対話）


- **Q1（キーの保管）**: 推奨どおり。`security-framework` で自前実装し、macOS もデータ保護キーチェーンを使う。端末ロック中も読める（初回ロック解除後・この端末のみ）。iCloud キーチェーンで同期せず、バックアップにも含めない。
  - **Q1-a（端末をまたいだキー）**: **端末をまたいで同期しない**。利用者は端末ごとにキーを登録し直す。
  - **Q1-b（登録時の WebView の通過）**: **登録の瞬間にキーが一度だけ WebView を通ることを許容する**（利用者は React の設定画面でキーを入力する）。保管した後は WebView から読み出せない。
- **Q4-a（Rust のテストと品質ゲート）**: **`npm run test:rust` を別に設けて必須ゲートに加える**。`npm test` は Rust のツールチェーンが無くても動くままにする。

### 親の決定

Q2（TS ⇔ Rust の境界・クリティカル設計決定 2）・Q3（送る先と資格情報の範囲・同 3）・Q5（S1 の切り方＝Tauri に依存しない Rust ライブラリを S1 とし、TS 側を S2、器への配線・キーの登録と削除の画面・製品版のエントリへの登録・動作確認を S3 とする。「スライス」節）は推奨どおり。Q4-b（実キーチェーンの結合テスト）は手動実行とし、手順を本仕様に書く。未署名の開発ビルドでデータ保護キーチェーンが使えない可能性は未検証のリスクとして S1 で実測し、使えない場合の開発ビルドの扱いは実測した時点で決める。

### 親の決定（2026-09-27・S2 の改訂）

- **S2 の範囲に「バックエンドの名前の分岐を能力の宣言へ置き換える」を加える**（#582 の機能仕様 `docs/features/llm-provider-abstraction.md` の決定 Q5）。対象は `reports/extract-evening-summary.ts` の `backend === "api"` による `toolChoice` の強制・`dashboard/boss-comment.ts` の `backend === "claude-code"` による短文の指示と全角 80 字の検証・`llm/claude-client.ts` の `client.backend === "claude-code"` によるツールのループの分岐。#582 S1 の着手条件は「本機能の S2 がマージされ、`LlmBackendImplementation` が 3 つの能力（ループを自分で回すか・強制に対応するか・応答長を制限できるか）を宣言する形になっていること」。能力の項目の名前・型は本機能の S2 が決める（#582 の仮定 A2。クリティカル設計決定 5）
- **開発者用の版の振る舞いは変えない**: `api`・`claude-code` のバックエンド、自由入力のモデル設定、`LLM_BACKEND` の決め方、開発者用の版の外部送信の範囲（Anthropic のみ）（ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5）。置き換えの後も、既存の呼び出し元のテストが同じ結果になる（**期待値〔アサーション〕は変えず、変えてよいのは準備〔模擬のバックエンドの登録〕だけ**と確定）
- **S2 のモジュールをバンドル検査の対象にする方法は案 (A)**: `core-entry.ts` が BYOK（Anthropic）の登録関数を呼ばずに re-export し、S3 で Tauri の器がポートを渡して呼ぶ（クリティカル設計決定 6）
- 仮定 A9〜A15・クリティカル設計決定 5・6 は本仕様の記述どおり承認

### 決定（2026-09-29・S3）

S3 の着手時に、確定済みの設計が実コードで成り立たない点が 2 つ見つかり、オーナーが決めた（Q6・Q7。「S3 向けの取り直し」の実測に拠る）。

- **Q6（製品版で朝会・夕会を BYOK〔Anthropic〕へ送る手段・オーナーの決定）**: 朝会・夕会・ダッシュボードのひとこと・通知文面・催促の予約の文面は、それぞれが `resolveLlmBackend(env)` でバックエンドを決めており、製品版（`env` が空）では `claude-code`（未登録）になる。**#582 のクリティカル設計決定 5「選択の解決関数の注入」の骨格だけを S3 に前倒しする**（クリティカル設計決定 7）。
  - `createCoreApp` の `llmBackend` の引数を解決関数に置き換え、呼び出し元の `resolveLlmBackend(env)` の直接の呼び出しをやめる（実装の形はクリティカル設計決定 7: `llmBackend` の引数は削除し、解決関数は LLM バックエンドと同じモジュールのレジストリで注入する）
  - 開発者用の版の解決関数は従来と同じ結果を返す（既存のテストの期待値は変えない。変えてよいのは準備だけ）
  - 製品版の解決関数は当面「`byok-anthropic` と設定の `model`」を返す固定の関数にする
  - **保存した選択・プロバイダとモデルの選択の画面・「未選択」の失敗・OpenAI の配線は #582 S2 に残す**。S3 でチャット・朝会・夕会の動作確認まで閉じる。#582 の仕様の S2 の範囲の記述を、前倒しした分だけ書き換える
- **Q7（未署名のビルドでキーを登録できないこと・オーナーの決定）**: S1 の実測（未署名のバイナリでは登録が `-34018`〔`errSecMissingEntitlement`〕）と、`npm run build:tauri` の `.app` が ad-hoc 署名（`TeamIdentifier=not set`）であることから、未署名の `.app` ではキーを登録できない（クリティカル設計決定 9）。
  - **製品版のキーの属性（データ保護キーチェーン・初回ロック解除後・この端末のみ・同期しない）は変えない**
  - 手動の確認手順は「Apple Development の証明書で署名し、`keychain-access-groups` の entitlement を付けたビルド」を前提に書く。S3 で entitlements の生成と、署名 ID・チーム ID を環境変数で渡すビルドの手順を足す。**証明書・チーム ID の値はリポジトリにコミットしない**
  - 未署名のビルドで `-34018` になることは既知の制約として仕様と手順に書く。署名した `.app` でのキーの登録の実測はオーナーが手動確認で行う
- **親の決定（S3）**:
  - 登録時のキーの有効性の事前確認（テスト送信）は S3 でも行わない（「やらないこと」。YAGNI・送信の範囲を増やさない）
  - 無効なキー・未登録のキーでの失敗は、S2 のエラーの分類（再試行不可）のまま既存の LLM の失敗の経路に乗せ、新しい表示は作らない（仮定 A19）
  - 製品版のモデルは、#582 S2 の選択の画面ができるまで、設定の `model`（既定 `claude-sonnet-5`＝モデルの一覧の Anthropic の既定）とする（仮定 A20）
  - キーのコマンドは `anthropic` だけを受け付け、`openai` は拒否する（OpenAI のキーの保管は #582 S2）

## 実コードの実測（2026-09-26・`main` 3b65393／#594 ブランチ 18cac97／`spike/ios-tauri`）

仕様の決定はこの実測に拠る。食い違ったらコードが正。以下、TS のパスは `server/src/` を省いて `llm/...` と書く。

| 対象 | 実測 |
|---|---|
| ファサードの呼び出し口 | `llm/claude-client.ts` の `streamBossMessage`（チャット・通知文面）と `createBossMessage`／`requestVerdict`（ダッシュボードのコメント・セッション要約・会議の開始文・夕会の要約抽出）の 2 系統。呼び出し元は 6 モジュール（`chat-messages-route.ts`・`notification-body.ts`・`boss-comment.ts`・`session-summary.ts`・`meeting-opening.ts`・`extract-evening-summary.ts`） |
| リクエストの形 | `ClaudeMessageRequest` は Anthropic Messages API の型（`Anthropic.MessageParam`・`Anthropic.Tool`・`ThinkingConfigParam`・`OutputConfig`）を **型だけ** import して使う。チャットは `thinking: { type: "adaptive" }`・`outputConfig: { effort: "low" }`、他は `thinking: { type: "disabled" }` |
| tool use のループ | `api` では TS のファサード（`streamBossMessage`）が最大 `MAX_TOOL_ROUNDS = 5` ラウンド回す。**thinking を使うターンは、アシスタントの元のブロック（`thinking` と署名）を `rawContent` として保持して次ラウンドにそのまま送り返す必要がある**（Issue #117。落とすと次ラウンドが拒否される） |
| 中止とタイムアウト | ファサードの `runWithTimeoutAndRetry` が `AbortSignal` を 1 ラウンドごとにバックエンドへ渡す（既定 120 秒・2 回まで再試行・副作用〔テキスト配信・ツール実行〕の後は再試行しない）。生成停止（#254）も同じ `signal` を使う |
| エラーの分類 | `api` の `classifyApiError` は SDK の `APIError` の `status`（408・429・5xx は再試行、他の 4xx は再試行しない）と `retry-after` ヘッダで判定する。**SDK の型に依存するため、SDK を使わない経路ではステータスと `retry-after` を別の形で受け取る必要がある** |
| バックエンドの注入（#594。2026-09-27 訂正: PR #598 で `main` にマージ済み） | `llm/llm-backend-registry.ts` の `registerLlmBackend(name, { createClient, streamRound, createRound, classifyError? })` に、エントリが実装を登録する。製品版のコアのエントリ（`core-entry.ts`）は何も登録しない。**バックエンド名 `LlmBackend` と `BossLlmClient` は `"api" \| "claude-code"` の閉じた型**で、新しいバックエンドを足すにはこの 2 つを広げる必要がある |
| #594 のバンドル検査 | 製品版のコアのバンドルに `@anthropic-ai/sdk` が含まれないことを受入基準で固定している（SDK は資格情報読み込みで `import('node:fs')` を持つ）。**したがって本機能の TS 側でも SDK を使えない**（SDK に独自の `fetch` を渡す形も採れない） |
| spike のキーチェーン | `security_framework::passwords::{set,get,delete}_generic_password`（service `dev.aiboss.spike.tauri`・account `anthropic-api-key`）を Tauri コマンド 3 つで公開。**`keychain_get` はキーの値を WebView へ返す**。アクセス制御（アクセシビリティ・同期可否）は指定していない |
| `security-framework` 3.7 の既定 | `PasswordOptions` は `use_protected_keychain()`（データ保護キーチェーン。「macOS 以外では常に真」）・`set_access_synchronized`・`set_access_control_options`・`set_access_group` を持つ。**macOS で `use_protected_keychain()` を呼ばない既定は、従来のファイル型キーチェーン（ログインキーチェーン）になる**（docs.rs で確認。挙動の実測はしていない） |
| 検証の実行環境 | CI は無い（`.github/workflows` なし）。品質ゲートは `npm run lint`・`typecheck`・`test`・`test:tz` だけで、Rust のテストはまだどこからも実行されない。ローカルは `rustc 1.98.1`・`cargo 1.98.1`（2026-09-27 訂正: S1 で `npm run test:rust` が必須ゲートに加わった。CI は引き続き無い） |
| Tauri の器 | `main` に `src-tauri` はまだ無い（#579 S2 で作る。2026-09-27 の `main` ad351f5 でも無い） |

### S2 向けの取り直し（2026-09-27・`main` ad351f5）

S2 の設計はこの実測に拠る。上の表と食い違う点はこちらが新しい。

| 対象 | 実測 |
|---|---|
| バックエンドの名前の分岐（置き換えの対象） | (1) `llm/claude-client.ts:573` の `streamBossMessage` は `client.backend === "claude-code"` なら 1 回だけ `dispatchStream` して返し、それ以外はファサードが最大 `MAX_TOOL_ROUNDS = 5` ラウンドのツールのループを回す（同 547〜565 行のコメントが「`ownsToolLoop` のような能力へ移すのは #581／#582 の次の変更」と申し送っている）。(2) `reports/extract-evening-summary.ts:136・161` は `resolveLlmBackend(env)` の結果が `"api"` のときだけ `toolChoice: { type: "tool", name: "submit_evening_summary" }` を渡す。(3) `dashboard/boss-comment.ts:66〜71・134` は `"claude-code"` のときだけ `CLAUDE_CODE_SHORT_TEXT_INSTRUCTION`（全角 80 字以内の指示）をユーザーの指示に足し、応答が全角換算 80 字を超えたらテンプレートへ退避する。**名前で分岐しているのはこの 3 か所だけ**（`notifications/notification-body.ts`・`sessions/meeting-opening.ts`・`sessions/session-summary.ts` は `maxTokens` を渡すだけで名前で分岐しない）。`llm/dev-llm-backends.ts` の `client.backend !== "api"` 等は、実装が自分のクライアントの種類を確かめる型の絞り込みであり、置き換えの対象ではない |
| 呼び出し元のテストの作り | `reports/extract-evening-summary.test.ts`・`dashboard/boss-comment.test.ts` は `../llm/claude-client.js` の `createClaudeClient`（と `requestVerdict`／`createBossMessage`）を `vi.mock` で差し替え、**バックエンドの選択を環境変数 `LLM_BACKEND` だけで与える**（レジストリには何も登録しない。`boss-comment.test.ts` の模擬のクライアントは `{}`）。`boss-comment.claude-code.test.ts`・`notification-body.claude-code.test.ts` は Agent SDK を模擬にして `registerDevLlmBackends()` を呼ぶ。**能力をレジストリから引く形にすると、前者 2 つのテストは準備（模擬のバックエンドの登録）を足す必要がある** |
| `LlmBackend` の 2 つの役割 | `config.ts` の `LlmBackend` は `ALLOWED_LLM_BACKENDS = ["api", "claude-code"]` から作る型で、(a) 開発者用の版の `LLM_BACKEND` の検証（許容値以外は `resolveLlmBackend` が例外）と、(b) レジストリの鍵（`Map<LlmBackend, …>`）の両方に使われている。**型を広げるだけだと `LLM_BACKEND=byok-anthropic` が開発者用の版で通ってしまう** |
| `api` の要求の組み立て | `backends/api-backend.ts` の `streamApiMessage` は `model`・`max_tokens`・`system`・`messages`・`tools`・`thinking`・（あれば）`output_config` を送り、**`tool_choice` を送らない**。`createApiMessage` はこれに `tool_choice` を足す。応答は `normalizeMessage` が `text`・`tool_use` だけを `content` に残し、SDK が返した `content` 全体を `rawContent` にする。どちらも無い応答は停止理由・ブロックの種類・モデル・トークン数だけを `console.warn` に出す |
| `api` のエラーの分類 | `classifyApiError` は SDK の `APIError` の `status`（`undefined`・408・429・5xx は再試行可、他は不可）と、`retry-after`（整数の秒数、または `Www, DD Mon YYYY HH:MM:SS GMT` の形の HTTP 日付。それ以外・過去の日付は無視）で判定する。**`APIError` でない例外は再試行可**。この判定は `@anthropic-ai/sdk` を値で import する `api-backend.ts` の中にあり、コアから import できない |
| 中止の伝わり方 | `dispatchStream` は `runWithTimeoutAndRetry` の `AbortSignal` を `streamRound` に渡す（生成停止の `signal` はこれに合流する）。`dispatchCreate` は生成停止の `signal` を持たず、タイムアウトだけで中止する。中止された後は `runWithTimeoutAndRetry` が `LlmTimeoutError` を投げる（バックエンドが投げた例外の種類は問わない） |
| 製品版のコアのバンドル検査 | `core-entry.bundle.test.ts` は `core-entry.ts` から到達できるモジュールだけを束ねて検査する（外部の指定子・`@anthropic-ai/sdk`・Agent SDK の混入の禁止、`server/src` の入力での `process`・`Buffer`・`require`・`setImmediate` 等の Node のグローバルの値参照と `node:` の値 import の禁止、`registeredCoreLlmBackendNames()` が空）。**S2 のモジュールが `core-entry.ts` から到達できなければ、この検査の対象にならない**（クリティカル設計決定 6。親の決定で `core-entry.ts` から登録関数を re-export する） |
| Rust の通信層（S1・PR #616） | `SecureTransport::send(SendRequest)` → `ResponseStream`（`head()` が `ResponseHead { status, retry_after, request_id, content_type }`、`next_chunk()` が本文の断片を順に返す）、`cancel(request_id)`。**失敗の種類は仕様の 5 つより多い 8 つ**: `UnknownDestination`・`KeyNotRegistered`・`KeyStore(StoreError)`・`InvalidHeader`・`DuplicateRequestId`・`Connection`・`Cancelled`・`RedirectRefused { status }`。**呼び出し元が `content-type` を付けなければ Rust が `application/json` を付ける**。捨てる要求ヘッダは `x-api-key`・`authorization`・`anthropic-version`・`host`・`content-length`・`transfer-encoding`・`connection` |

### S3 向けの取り直し（2026-09-29・`main` c4af1ba）

S3 の設計はこの実測に拠る。上の表と食い違う点はこちらが新しい。

| 対象 | 実測 |
|---|---|
| バックエンドの決め方 | `resolveLlmBackend(env)` を直接呼ぶのは `sessions/meeting-opening.ts:128`・`reports/extract-evening-summary.ts:137`・`dashboard/boss-comment.ts:99`・`notifications/notification-body.ts:282`・`nudge-plan/replan-nudges.ts:597` の 5 か所。チャット（`sessions/chat-messages-route.ts:293`）とセッションの要約（`sessions/session-summary.ts:76`）は `createCoreApp` の `llmBackend`（型は `"api" \| "claude-code"`。省略時は `resolveLlmBackend(env)`。`core-app.ts:88・132`）を受け取る。開発者用の版は `index.ts:77-79` が `createApp(db, process.env, { llmBackend: config.llmBackend })`（`config.llmBackend` は `resolveLlmBackend(process.env)` と同じ値）。**製品版のエントリは `createCoreApp(db, {})`（`web/src/app-entry/create-product-core-app.ts:27`）で、上の 7 か所はすべて `claude-code`（未登録）へ向く** |
| モデルの決め方 | 7 か所とも設定の `model`（`boss/boss-settings.ts` の `resolveBossSettingsFrom`。未設定なら `DEFAULT_MODEL = "claude-sonnet-5"`）。チャットと催促の予約は 1 つの設定のスナップショット（`readSettingsSnapshot`）から人格とモデルを読む |
| 製品版の宛先の表 | `DestinationTable::production()` は `anthropic-messages` と `openai-responses`（#582 S1 で追加）の 2 行 |
| 製品版の `.app` の署名 | `npm run build:tauri` の `.app` は `Signature=adhoc`・`flags=adhoc,linker-signed`・`TeamIdentifier=not set`（`codesign -dv` で確認）。開発機の署名 ID は 0 件（`security find-identity -v -p codesigning`）。S1 の実測では、同じ条件のテストバイナリからのデータ保護キーチェーンへの登録が `-34018` |
| Tauri 2.12 の IPC | アプリのコマンドは `tauri_build` の `AppManifest::commands` に列挙すると `allow-<コマンド名>` の権限が作られ、capability に書いたものだけが呼べる。`Channel` の本文の取り出し（`plugin:__TAURI_CHANNEL__\|fetch`。定数は `tauri` 2.12.0 の `ipc/channel.rs`）は ACL の検査から外れる（判定は同 `webview/mod.rs`）。`Channel` の本文は送った Webview からだけ取り出せる。Rust のテストでは `Channel::new(<関数>)` で受け手を差し替えられる |
| 製品版の web の IPC | `@tauri-apps/api ~2.12`（`invoke`・`Channel`）は web の依存にある。`withGlobalTauri` は無効 |
| 製品版の画面の注入 | 製品版だけの振る舞いは React のコンテキストで注入し、開発者用の版は注入しない（証跡の Blob URL の前例。`web/src/evidence-content-opener-context.ts`） |

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] 利用者は Anthropic の API キーを登録できる
- [ ] 登録したキーは OS のセキュアストレージ（macOS はキーチェーン）に保管される
- [ ] 利用者は登録済みのキーを削除できる
- [ ] 画面はキーの登録の有無だけを知ることができる
- [ ] キーの値を読み出す手段は WebView に無い
- [ ] TS のコアの LLM のストリーミング呼び出しが、Rust の通信層を通って Anthropic の Messages API へ送られる
- [ ] TS のコアの LLM の非ストリーミング呼び出しが、Rust の通信層を通って Anthropic の Messages API へ送られる
- [ ] TS のコアの tool use のループの呼び出しが、Rust の通信層を通って Anthropic の Messages API へ送られる
- [ ] 生成停止時は、Rust の通信層への送信を中止する
- [ ] Rust の通信層は、あらかじめ決めた送信先（Anthropic の Messages API）にだけ送る
- [ ] Rust の通信層は、送信時にキーを付与する
- [ ] キーは WebView に出ない
- [ ] キーはログに出ない
- [ ] キーは DB に出ない
- [ ] LLM のバックエンドは、ツールのループを自分で回すか・ツール呼び出しの強制に対応するか・要求ごとに応答長を制限できるかを能力として宣言し、呼び出し元とファサードはバックエンドの名前ではなく宣言された能力で振る舞いを変える（S2。#582 の決定 Q5）
- [ ] 製品版のエントリに BYOK（Anthropic）のバックエンドが登録される（S3。#579 S2 の後）
- [ ] 製品版の Tauri アプリで、朝会の開始時にボスの発言が LLM で生成されて表示される（確認は S3。#580 S2 の後）
- [ ] 製品版の Tauri アプリで、夕会の終了時に日報の要約が LLM で生成される（確認は S3。#580 S2 の後）
- [ ] 製品版の Tauri アプリで、チャットの応答が逐次表示される（確認は S3。#580 S2 の後）
- [ ] 製品版の Tauri アプリで、チャットの生成停止で送信が中止される（確認は S3）
- [ ] LLM を使う呼び出し元は、エントリが注入した選択の解決関数でバックエンドとモデルを決める（S3。#582 のクリティカル設計決定 5 の骨格・オーナーの決定 Q6）

## 非機能要件

- セキュリティ: WebView 側のコードが侵害されても、保管済みのキーの値は読み出せない（ADR 0002 改訂の代替案の却下理由）。侵害された WebView ができるのは「決められた送信先へ、キー付きで送らせる」ことまでであり、任意の宛先へキーを送らせることはできない。送信先がリダイレクトを返しても、誘導先へキーは送られない
- ログ: キーをログに出さない。失敗時に残すのはエラーの種類（クラス名・HTTP ステータス）まで（ADR 0002 決定 4・改訂の決定 7）
- 外部送信: 送信先は ADR 0001 改訂で許可した範囲（選択したプロバイダ）に限る。BYOK の推論を中継サーバーへ流さない・黙って経路を切り替えない（ADR 0001 改訂の帰結・ADR 0003 決定 9）

## 技術的な制約・方針

- 使用技術: S1 は Tauri に依存しない Rust ライブラリ（HTTP クライアント・`security-framework`）。S3 で Tauri 2 のコマンドと `tauri::ipc::Channel` で公開する。TS 側は既存の `server/src/llm/` のファサードと #594 のレジストリに接続する
- 前提（別 Issue・並行）: Tauri の器は #579 S2、製品版の DB は #580 S2、プロバイダの抽象化（OpenAI・許可モデル）は #582、中継サーバーは #583、アカウント・ライセンスは #584。**本機能はこれらを実装しない**
- 依存関係（着手の順序）: S1（Rust ライブラリ）は TS に触れないため #594 を待たずに着手できる。S2（TS 側）は #594（#579 S1。レジストリ）のマージ後（2026-09-27 時点で S1〔PR #616〕・#594〔PR #598〕とも `main` にマージ済み）。**#582 S1（OpenAI の変換器）は本機能の S2 のマージ後に着手する**（転送のポート・Anthropic の変換器・能力の宣言の上に作る）。**Tauri コマンドへの配線と製品版での動作確認（S3）は #579 S2 の器ができてから**。製品版の朝会・夕会・チャットの実動作確認は #580 S2（製品版の DB）の後（生成のルートが LLM を呼ぶ前に DB を読むため。#579 仕様のクリティカル設計決定 1「未検証点の扱い」と同じ理由）
- 既存コードとの関係: 開発者用の版（`api`・`claude-code`・`server/.env`）は変えない（ADR 0002 改訂の決定 5）

## クリティカル設計決定

### 1. キーの保管の実装（Q1・オーナー決定）

- **採用案**: **`security-framework` を使った自前の実装**を通信層の中に置く（spike の約 30 行の延長。この規模はキーの保管の部分だけで、S1 全体は「実装計画」を参照）。キーチェーンの項目の属性は次のとおり:
  - **データ保護キーチェーンを使う**（macOS でも `use_protected_keychain()`。iOS と同じ仕組みに揃える）
  - **アクセシビリティは「初回ロック解除後・この端末のみ」**（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）。端末ロック中でも読める（デスクトップの毎分の催促が、画面ロック中に通知文面を LLM で作るため）。「この端末のみ」により別の端末へ移らない
  - **同期しない**（`kSecAttrSynchronizable` を偽）。iCloud キーチェーンで他の端末へ同期しない（オーナーの決定 Q1-a。利用者は端末ごとに登録し直す）
  - キーの項目は「プロバイダごとに 1 件」（本機能は Anthropic の 1 件だけ）
- **登録の経路（オーナーの決定 Q1-b）**: 利用者は React の設定画面でキーを入力し、画面は登録のコマンドへ値を渡す。**登録の瞬間だけキーが WebView を通ることを許容する**。登録の後、画面が知ることができるのは登録の有無だけで、値を返すコマンドは作らない。
- **未検証のリスク（S1 で実測する）**: macOS のデータ保護キーチェーンは、アプリの署名（entitlement）が無いと使えない可能性がある。S1 の手動の結合テストで、開発時のビルド（未署名のテストバイナリ）から登録できるかを実測し、結果を記録する。**使えなかった場合の開発ビルドの扱いは、実測した時点で決める**（本仕様では決めない。製品版の属性は変えない）。
- **理由**: 高レベルのライブラリではアクセシビリティ・同期可否を指定できない。spike の実装（`security-framework`）で保存・読み出しは確認済み（#576）。
- **代替案**:
  - `keyring` クレート（4.x。macOS・Windows・iOS・Android の資格情報ストアを 1 つの API で扱う）またはそれを包むコミュニティの Tauri プラグイン — Windows・Android まで同じ API で済む。ただし高レベルの API ではアクセシビリティ・同期可否を指定できず（細かく制御するなら `keyring-core` を直接使う、とドキュメント自身が案内している）、macOS でどちらのキーチェーンに入るかを自分で決められない
  - `tauri-plugin-stronghold` — OS のセキュアストレージではなく、パスワードで暗号化したファイル。ADR 0002 改訂の決定 1（OS が提供するセキュアストレージ）に合わない
- **影響範囲**: Rust の通信層（新規）。Windows（DPAPI）・Android（Keystore）は後続リリース・別スライスで同じポート（保管の抽象）の実装を足す

### 2. TS ⇔ Rust の境界（Q2・確定）

- **採用案**: **Rust は「宛先を名前で指定する、秘密情報を付与する HTTP 転送」だけを担い、プロバイダの形式（SSE のイベント・tool use・thinking）は TS が解釈する**。
  - Rust のコマンド（名前は仮）: `secure_send({ requestId, destination: "anthropic-messages", headers, body }, channel)` → 応答のステータスと許可したヘッダ（`retry-after`・`request-id`・`content-type`）を返し、本文のバイト列を `Channel` で逐次送る。`secure_cancel(requestId)` で送信中の要求を中止する。`byok_key_set(provider, key)`・`byok_key_delete(provider)`・`byok_key_status(provider) -> bool`。**キーの値を返すコマンドは作らない**
  - TS 側: SDK を使わない Anthropic Messages のクライアント（リクエスト本文の組み立てと SSE の解釈。`text`・`tool_use`〔`input_json_delta`〕・`thinking`〔`signature_delta`〕を組み立て、`rawContent` を保持）を、**転送のポート**（Tauri の `invoke` を直接触らない関数型の境界）の上に作り、#594 のレジストリへ BYOK（Anthropic）のバックエンドとして登録する。`classifyError` はステータスと `retry-after` から判定する（`isRetryableApiError` と同じ規則を SDK なしで）
  - 生成停止: ファサードの `AbortSignal` が中止されたら TS が `secure_cancel` を呼び、Rust は HTTP 要求を切る
- **理由**: ADR 0011 決定 6（通信層は送受信と秘密情報の付与だけを担い、プロンプトの組み立て・tool use の処理は TS）にそのまま沿う。形式の解釈を TS に置くと、#582（OpenAI との差の吸収）も TS だけで済み、Rust にプロバイダの知識が二重に入らない。`Channel` は Tauri 2 が順序つきのストリーミング用に用意している仕組み
- **代替案**:
  - (B) Rust が SSE を解釈して、テキストの差分と最終メッセージを TS へ渡す — Rust にプロバイダの形式の知識が入り、#582 で OpenAI の形式を Rust と TS の両方に書くことになる。thinking の署名の保持も Rust 側の責務になる
  - (C) `@anthropic-ai/sdk` に Rust 経由の `fetch` を渡す — #594 の受入基準（製品版のコアに SDK を入れない）に反する
- **影響範囲**: `llm/claude-client.ts`（`BossLlmClient` の閉じた型と `createClaudeClient` の `backend` の型を広げる）・`config.ts`（2026-09-27 訂正: `LlmBackend` をそのまま広げると `LLM_BACKEND` の許容値まで広がるため、レジストリの鍵の型と環境変数の検証の型を分ける。クリティカル設計決定 5・仮定 A11）・#594 のレジストリ・製品版のエントリ（**クリティカル箇所: Claude API 連携・API キーの取り扱い。変更時は人間レビュー必須**）

### 3. 送る先と付与する資格情報の範囲（Q3・確定）

- **採用案**: **本機能は BYOK の Anthropic 直送だけ**（宛先 1 つ・`POST https://api.anthropic.com/v1/messages`・`x-api-key` と `anthropic-version` を Rust が付与）。宛先は Rust 側の固定の表で持ち、TS は宛先の名前しか指定できない。TS から渡された `x-api-key`・`authorization`・`anthropic-version` のヘッダは Rust が捨てる。
  - **リダイレクトに追従しない**（PR #599 のレビュー対応・親の決定）。送信先が 3xx を返しても Rust は誘導先へ要求を送らず、「リダイレクト拒否」の失敗（HTTP のステータスだけを持ち、誘導先の URL は持たない）として TS 側へ返す。理由: HTTP クライアントの既定（例: `reqwest` は既定で追従し、別ホストへの誘導で除去するのは `authorization`・`cookie` といった標準のヘッダだけ）では、独自ヘッダの `x-api-key` が付いたまま固定の送信先の外へ出うる（レビューの指摘。本仕様では実測していない）。固定の送信先は 1 つで、追従が要る場面は無い
  - OpenAI の宛先と鍵の項目は #582、中継サーバーの宛先とライセンストークンの付与は #583・#584 が、この表と保管のポートに 1 行ずつ足す
- **理由**: 中継サーバーの認証方式（ライセンストークンの形・取得と更新）は #584 で未決。先に作ると推測で作ることになる（YAGNI）。宛先の表と保管のポートを「名前 → URL・付与する資格情報」の形にしておけば後から足せる
- **代替案**: ライセンストークンの保管と中継サーバー向けの付与まで本機能で作る — #583・#584 の設計が固まる前に通信層の契約を決めることになる

### 4. 「秘密情報が出ない」の担保の方法（Q4・確定）

- **採用案**: テストで固定する部分と、検査手順で示す部分を分ける。
  - **Rust のテスト（`cargo test`）で固定**: 保管はポート（トレイト）にし、テストはメモリ上の実装で行う。送信は手元の模擬 HTTP サーバーに向け、(a) 付与されたヘッダ、(b) TS から渡された認証ヘッダが捨てられること、(c) 宛先の表に無い名前を拒否すること、(d) 本文が分割されたまま順に届くこと、(e) 中止で接続が切れること、(f) 応答・エラーの値と `Debug`／`Display` の文字列にキーが含まれないこと、を確かめる。キーは表示時に伏せる型（例: `secrecy` クレートの `SecretString`）で持つ
  - **TS のテスト（vitest）で固定**: 転送のポートを模擬に差し替え、SSE の解釈（text・tool_use・thinking と署名・`rawContent`）・中止・エラーの分類を確かめる。TS 側の型にキーを持つ場所が無いこと
  - **実キーチェーンの結合テスト（手動実行・親の決定 Q4-b）**: macOS で実際のキーチェーンへ登録・登録の有無の確認・削除を行うテストは、`#[ignore]` を付けて既定の実行から外し、次の手順で手動実行する（キーチェーンのアクセス許可ダイアログ・署名の要否に左右されるため）。
    1. 開発機（macOS）で `cargo test --manifest-path <Rust ライブラリの Cargo.toml> -- --ignored` を実行する（正確なコマンドは S1 の実装で npm スクリプトまたは README に固定する）
    2. テストはテスト専用の service 名を使い、オーナーの本物のキーの項目には触れない。終了時に自分で作った項目を削除する
    3. テストは、登録した項目の属性（データ保護キーチェーン・アクセシビリティ・同期しない）を属性だけの問い合わせで確かめる（値は読み出さない）
    4. 結果（成功、または失敗時の OSStatus の番号）を S1 の PR 本文に記録する
  - **検査手順で示す（S3）**: Tauri アプリの開発者ツールから、登録済みのキーの値を返すコマンドが存在しないこと・アプリの DB にキーが無いことを確かめる手順を残す
  - **品質ゲートへの組み込み（オーナーの決定 Q4-a）**: `npm run test:rust`（Rust ライブラリの `cargo test`）を新設し、**必須ゲートに加える**。`npm test` は `cargo` を呼ばず、Rust のツールチェーンが無くても従来どおり動く。repo の `CLAUDE.md` の品質方針（必須ゲート）と「よく使うコマンド」の更新は S1 の範囲とする
- **代替案**: (a) 実キーチェーンの結合テストを既定の実行に含める — 開発機の状態（ログイン・署名）でテストが揺れる。CI も無い。(b) `cargo test` を `npm test` に含める — Rust のツールチェーンが無い環境で `npm test` が動かなくなる

### 5. バックエンドの能力の宣言（S2・範囲は親の決定〔#582 の決定 Q5〕、形は本仕様で決める）

- **採用案**: `LlmBackendImplementation` に**必須の**能力の宣言（3 つの真偽値）を持たせ、名前で分岐していた 3 か所を宣言の参照へ置き換える。
  - 「ツールのループを自分で回す」（仮に `runsOwnToolLoop`）: 真なら `streamBossMessage` はファサードのループを回さず 1 回だけ送る（現行の `claude-code` の扱い）。偽ならファサードが最大 `MAX_TOOL_ROUNDS` ラウンド回す
  - 「ツール呼び出しの強制に対応する」（仮に `supportsToolChoice`）: 真のときだけ夕会の要約抽出が `toolChoice` で `submit_evening_summary` を強制する。偽なら渡さない（プロンプトの指示で代替する現行の `claude-code` の扱い）
  - 「要求ごとに応答長を制限できる」（仮に `limitsResponseLength`）: 偽のときだけダッシュボードのひとことが短文の指示を足し、全角換算 80 字を超えた応答をテンプレートへ退避する
  - 各バックエンドの宣言: `api` ＝ 回さない・対応する・制限できる／`claude-code` ＝ 回す・対応しない・制限できない／BYOK（Anthropic）＝ 回さない・対応する・制限できる（#582 の BYOK〔OpenAI〕も同じ宣言になる）
  - 呼び出し元は、クライアントを作るのと同じバックエンドの名前でレジストリから宣言を引く（ファサードが引く関数を公開する。未登録なら `createClaudeClient` と同じ `LlmBackendNotRegisteredError`）。**名前から能力を推し量る既定値は置かない**（宣言が無いバックエンドを黙って `api` 扱い・`claude-code` 扱いにしない）
  - **開発者用の版の `LLM_BACKEND` の許容値は `api`・`claude-code` のまま**。レジストリの鍵の型だけを広げ、環境変数の検証に使う型とは分ける（「実コードの実測」の `LlmBackend` の 2 つの役割）
- **理由**: #582 で BYOK（OpenAI）が加わっても呼び出し元を変えずに済み、新しいバックエンドの名前を足したときに夕会の要約抽出の強制が黙って外れる事故（#582 の実測）を防ぐ。3 つの能力は、名前で分岐していた 3 か所の意味をそのまま名前に置き換えたもので、これ以上細かい宣言（例: 強制の種類ごとの対応）を使う呼び出し元は無い（YAGNI）。任意の項目にしないのは、宣言し忘れた実装が既定値へ黙って倒れるのを型で防ぐため
- **代替案**:
  - 能力を `BossLlmClient` の値に載せる — `createClaudeClient` を模擬にしている既存のテスト（模擬のクライアントは `{}` や `{ backend: "api", client: {} }`）では、どちらにしても準備を足す必要があり、差が無い。クライアントの判別共用体の各バリアントに同じ項目が重複する
  - 名前 → 能力の表をコアに置く — コアがバックエンドの名前を知ることになり、置き換えの目的（名前で分岐しない）に反する
- **既存のテストへの影響**: 名前の分岐を宣言へ置き換えると、`LLM_BACKEND` だけでバックエンドを選んでいた呼び出し元のテスト（`extract-evening-summary.test.ts`・`boss-comment.test.ts`）は、`api`・`claude-code` と同じ能力を宣言する模擬のバックエンドの登録を準備に足す必要がある。**期待値（アサーション）は変えない**（親の決定「既存の呼び出し元のテストが同じ結果になる」をこの意味に読む）
- **影響範囲**: `llm/llm-backend-registry.ts`・`llm/claude-client.ts`・`llm/dev-llm-backends.ts`・`reports/extract-evening-summary.ts`・`dashboard/boss-comment.ts`・`config.ts`（**クリティカル箇所: Claude API 連携。変更時は人間レビュー必須**）

### 6. SDK を使わない Anthropic のクライアントと転送のポート（S2・クリティカル設計決定 2 の TS 側の具体化）

- **採用案**:
  - **転送のポート**は「宛先の名前・秘密でないヘッダ・本文と `AbortSignal` を受け取り、応答の頭（ステータスと許可したヘッダ）と本文のバイト列の断片の非同期の列を返す」関数型の境界とする。`requestId` の発行と `secure_cancel` の呼び出しは S3 の Tauri 実装のポートの中に閉じる（TS のクライアントは `AbortSignal` を中止するだけ）。失敗は Rust の 8 つの種類に対応する種類を持つ 1 つのエラーの型で表す
  - **BYOK（Anthropic）のバックエンド**（仮に `byok-anthropic`）は、ポートを引数に取る登録関数でレジストリへ登録する。`createClient(env)` は `env` を読まない（`ANTHROPIC_API_KEY` を含め、キーを受け取る場所を TS 側に作らない）
  - 要求本文は、`api` の `streamApiMessage`／`createApiMessage` が SDK に渡す項目と同じ名前・同じ値の JSON（`model`・`max_tokens`・`system`・`messages`・`tools`・`tool_choice`・`thinking`・`output_config`）に `stream` を足したもの。ヘッダは付けない（`x-api-key`・`anthropic-version`・`content-type` は Rust が付ける）
  - 応答の解釈: ストリーミングは SSE（`message_start`・`content_block_start`・`content_block_delta`〔`text_delta`・`input_json_delta`・`thinking_delta`・`signature_delta`〕・`content_block_stop`・`message_delta`・`message_stop`・`ping`・`error`）を組み立て、非ストリーミングは JSON を読む。どちらも `normalizeMessage` と同じく `text`・`tool_use` を `content` に、組み立てたブロック全体（`thinking` と署名・`redacted_thinking` を含む）を `rawContent` にする。バイト列の復号は多バイト文字の途中で断片が切れても壊れない形で行う（`TextDecoder` の逐次復号。`Buffer` はバンドル検査で使えない）
  - エラーの分類は `classifyApiError` と同じ規則を SDK なしで持つ（HTTP のステータスと `retry-after`）。ポートの失敗は、接続失敗だけを再試行可、他（宛先不明・キー未登録・キーの保管の失敗・不正なヘッダ・要求 ID の重複・リダイレクト拒否）を再試行不可とする。応答の途中の SSE の `error` イベントと、`message_stop` の前に本文が終わった場合は再試行可とする（SDK の経路で `status` を持たない失敗が再試行可になる現行の規則に揃える）。**ただし打ち切られた `tool_use`（`stop_reason: "max_tokens"` かつ tool_use のブロックが1つ以上ある応答。2026-09-28 追記・Issue #643）は、`status` を持たない失敗の既定から外れ、無条件に再試行不可とする**（「打ち切られた `tool_use`」節参照）
- **S2 のモジュールをバンドル検査の対象にする方法（2026-09-27 親の決定）**: 製品版のエントリへの登録は S3 の範囲で、そのままでは S2 の時点で `core-entry.ts` から BYOK（Anthropic）のモジュールへ到達せず、`core-entry.bundle.test.ts` が S2 のコードを検査しない（「実コードの実測」）。このため `core-entry.ts` が登録関数を**呼ばずに re-export** する（案 (A)。選択肢は「IF / API（S2）」の後に記す）
- **理由**: ポートが `AbortSignal` を受け取る形にすると、ファサードの中止（`runWithTimeoutAndRetry` の `signal`・生成停止）がそのままポートへ届き、`requestId` の管理が TS のクライアントと模擬のポートのテストに漏れない。要求本文を `api` と同じ項目にすると、開発者用の版で確かめた要求の形（Issue #117 の thinking の既定など）を製品版でもそのまま使える
- **影響範囲**: 新規のポートの型・BYOK（Anthropic）のバックエンド、`retry-after` の解釈を SDK なしで共有する場合は `backends/api-backend.ts`（振る舞いは変えない）（**クリティカル箇所: Claude API 連携・API キーの取り扱い。変更時は人間レビュー必須**）

### 7. 選択の解決関数の骨格（S3・オーナーの決定 Q6。#582 のクリティカル設計決定 5 の前倒し）

- **採用案**: LLM を使う呼び出し元は、**バックエンドとモデルの組（選択）を、環境（`env`）と設定のスナップショットから返す「選択の解決関数」**で決める。解決関数はエントリが注入する。
  - 形: `(env, settings) → { backend, model }` の純粋関数。`backend` はレジストリの鍵の型（`api`・`claude-code`・`byok-anthropic`・`byok-openai`）
  - **開発者用の版の解決関数**: `backend` は従来どおり `resolveLlmBackend(env)`（`LLM_BACKEND`。未設定なら `claude-code`、許容外なら例外）、`model` は従来どおり設定の `model`（未設定なら `DEFAULT_MODEL`）。**何も注入しないときはこの関数が使われる**（開発者用の版・既存のテストは注入しない）
  - **製品版の解決関数**: `backend` は常に `byok-anthropic`、`model` は設定の `model`（未設定なら `DEFAULT_MODEL`）。`env` を読まない
  - 注入の仕組みは、LLM バックエンドと同じくモジュールのレジストリに置く（#582 の仮定 A10 が許す 2 つのうちの「LLM バックエンドと同じレジストリ」）。製品版の web のエントリが BYOK（Anthropic）の登録と同時に製品版の解決関数を登録する
  - 呼び出し元 7 か所（チャット・セッションの要約・朝会の開始の発言・夕会の要約抽出・ダッシュボードのひとこと・通知文面・催促の予約の文面）は、**人格・モデルを読むのと同じ 1 つの設定のスナップショットで解決関数を呼び**、その `backend` でクライアントを作り、その `model` を要求に使う。`resolveLlmBackend(env)` を直接呼ばない
  - `createCoreApp`・`createApp` の `llmBackend` の引数は削除する（チャットとセッションの要約も解決関数を使う）。開発者用の版のエントリ（`index.ts`）が渡していた値は `resolveLlmBackend(process.env)` と同じで、解決関数の既定と一致する
- **理由**: オーナーの決定 Q6。7 か所の呼び出し元の差し替え口を 1 つにし、#582 S2 は製品版の解決関数を「保存した選択から決める関数」へ差し替えるだけで済む。レジストリにするのは、催促の予約・通知文面の経路が `createCoreApp` の外（器のスケジューラ・計画し直し）から呼ばれ、引数で通すと経路ごとに注入口が要るため。
- **代替案**: `createCoreApp` の引数と各経路の deps で通す — 通知文面（スケジューラ）と催促の予約（計画し直し）のそれぞれに注入口が要り、既存のテスト 150 箇所ほどの呼び出しの準備を変えることになる
- **既定が開発者用の解決関数であることの安全性**: 製品版のエントリが登録し忘れても、`env` が空なので `claude-code`（製品版では未登録）になり `LlmBackendNotRegisteredError` で送信しない（黙って別の送信先へ送らない）。製品版のエントリが登録することは受入基準で固定する
- **影響範囲**: `llm/`（解決関数とそのレジストリ）・`core-app.ts`・`app.ts`・`index.ts`・呼び出し元 7 モジュールとそのルート（`sessions/sessions-routes.ts`）・`core-entry.ts`（製品版の解決関数の re-export）・製品版の web のエントリ（**クリティカル箇所: Claude API 連携。変更時は人間レビュー必須**）

### 8. Tauri のコマンドと `Channel`・capability（S3・クリティカル設計決定 2・4 の器への配線）

- **採用案**:
  - 器のクレート（`native/tauri-app/`）が S1 のライブラリを path 依存で使い、**コマンドを 5 つだけ**公開する: `secure_send`・`secure_cancel`・`byok_key_set`・`byok_key_delete`・`byok_key_status`。**キーの値を返すコマンドは作らない**。コマンドの状態は製品版の宛先の表（`DestinationTable::production()`）とキーチェーンの保管（`KeychainKeyStore::new()`）で組み、WebView から表や保管先を変える手段は作らない。テストは模擬の送信先の表とメモリの保管を注入する
  - `secure_send` は応答の頭を受け取った時点で `{ status, headers }` を返し、本文の断片はその後に `Channel` で順に送る。本文の終わりと本文の途中の失敗も同じ `Channel` で送る。応答の頭より前の失敗はコマンドの失敗で返す
  - `Channel` へ送れなくなったら（WebView が閉じた等）、本文の中継をやめて応答を捨てる（接続を切る）
  - 失敗は種類（とリダイレクト拒否のステータス・キーの保管の失敗の OSStatus）だけを持つ値で返す。キー・要求本文・応答本文を含めない
  - `byok_key_set`・`byok_key_delete`・`byok_key_status` はプロバイダ `anthropic` だけを受け付ける（`openai` を含む他の値は「不明なプロバイダ」で拒否）。`byok_key_set` は空の値と HTTP のヘッダ値として使えない値（改行・制御文字など）を「不正なキー」で拒否し、保管しない
  - `tauri_build` の `AppManifest::commands` に 5 つを列挙し（`build.rs` と `src/` は別のコンパイル単位のため、一覧は依存を持たない `.rs` ファイルに置き、`build.rs` から `include!` で読む。コマンドの登録〔`generate_handler!`〕は識別子の並びのため、一覧の各名前が IPC で呼べることをテストで確かめる〔S3-C4〕）、capability（`capabilities/default.json`・`main` のウィンドウ）に 5 つの `allow-*` を足す。**既存の `sql:allow-execute`・`sql:allow-select` 以外の権限は足さない**（`core:default` 等を含めない）。capability に `remote`（外部のオリジンからの IPC）を置かない
  - TS 側: 製品版の web のエントリに、転送のポートの Tauri 実装（`invoke`・`Channel`・`requestId` の発行・`secure_cancel`）と、キーの登録・削除・登録の有無の Tauri 実装を置く。`requestId` は要求ごとに `crypto.randomUUID()` で発行する
  - **中止と完了の競合**: ポートの `signal` が中止されたら `secure_cancel` を呼ぶ。Rust が要求を登録する前に中止が届いた（`secure_cancel` が偽を返した）場合に送信が続かないよう、`secure_send` が応答の頭を返した時点で `signal` が中止済みなら、もう一度 `secure_cancel` を呼んで「中止」で失敗する。本文を読み切る前に呼び出し元が読むのをやめた場合も `secure_cancel` を呼ぶ
  - キーの登録・削除の画面: 既存の設定画面（`SettingsView`）の中に、製品版のエントリがコンテキストでキーの操作を注入したときだけ表示する欄を足す（開発者用の版は注入しないため表示されない）。画面が知るのは登録の有無だけ。入力欄は `type="password"`、登録に成功したら入力欄を空にする。キーは `/api`（アプリ内の Hono アプリ・DB）を通らない
- **理由**: クリティカル設計決定 2・3・4 の器への配線をそのまま形にしたもの。コマンドを 5 つに絞り capability を個別の `allow-*` にすることで、侵害された WebView が呼べるのは「決められた宛先へキー付きで送る・中止する・キーを差し替える／消す・有無を知る」までになる。
- **代替案**: (a) 本文の断片をコマンドの戻り値でポーリングする — 断片ごとに往復が要り、`Channel`（Tauri が順序つきのストリーミング用に用意したもの）より遅い。(b) 応答の頭も `Channel` で送る — 頭より前の失敗と本文の失敗の区別が `Channel` の中の順序に頼ることになる
- **影響範囲**: `native/tauri-app/`（`Cargo.toml`・`build.rs`・`src/`・`capabilities/default.json`）・製品版の web のエントリ・設定画面（**クリティカル箇所: API キーの取り扱い。変更時は人間レビュー必須**）

### 9. 署名とキーチェーン（S3・オーナーの決定 Q7。クリティカル設計決定 1「未検証のリスク」の結論）

- **採用案**: 製品版のキーの属性は変えない。キーを実際に登録する手動の確認は、**Apple Development の証明書で署名し、`keychain-access-groups`（`<チーム ID>.dev.aiboss.app`）の entitlement を付けた `.app`** で行う。
  - 署名つきのビルドの npm スクリプトを足す。署名 ID とチーム ID は環境変数で受け取り、entitlements のファイルはビルドのたびに Git の管理外（`target/` の下）へ生成する。**証明書・チーム ID・プロビジョニングプロファイルの値とファイルをリポジトリにコミットしない**。環境変数が無い・チーム ID の形（英大文字と数字の 10 文字）でないときは、ビルドを始めずに失敗する
  - プロビジョニングプロファイルが要る場合に備え、プロファイルのパスを任意の環境変数で受け取り `.app` に埋め込めるようにする（要否は未実測。仮定 A23）
  - 未署名（`npm run build:tauri`）の `.app` では、キーの登録が「キーの保管の失敗（OSStatus `-34018`）」になる。これは既知の制約として手順と画面の表示（OSStatus を出す）で分かるようにする
- **理由**: オーナーの決定 Q7。開発ビルドのためにキーの属性を弱める分岐（ファイル型のキーチェーン）をコードに入れると、製品に混入しないことを別に担保する必要が生じる
- **影響範囲**: `package.json`（スクリプト）・`scripts/`・手動の確認手順

## 機能全体の設計

### アーキテクチャ決定

- Rust の通信層は、**Tauri に依存しないライブラリ（保管のポート・宛先の表・転送）**と、**それを Tauri のコマンドとして公開する薄い層**に分ける。ライブラリは #579 S2 の器が無くても `cargo test` で検証できる。置き場所は仮に `native/secure-transport/`（#579 S2 の `src-tauri` から path 依存で使う）
- 宛先の表は、送信の部品を組み立てるときに渡す。製品版の表は Rust のコードに固定した定数（`anthropic-messages` → `https://api.anthropic.com/v1/messages` の 1 行）で、テストは模擬サーバーの URL を持つ表を渡す。Tauri のコマンドの層（S3）は製品版の表だけを使い、WebView から表を変える手段は作らない
- TS 側の BYOK（Anthropic）のバックエンドは、Tauri の `invoke` を直接呼ばず「転送のポート」を受け取る。製品版のエントリが Tauri 実装のポートを注入する。これで vitest から模擬のポートで検証でき、#594 のバンドル検査（Node 依存・SDK が入らない）もそのまま通る

### IF / API（S1 で固定する境界・名前は仮）

- **S1 のライブラリは Tauri に依存しない**。本文の断片の受け渡しは Tauri 非依存の型（例: 断片を受け取るコールバックやトレイト、非同期のストリーム）で表し、`tauri::ipc::Channel` への橋渡しは S3 のコマンドの層が行う。クリティカル設計決定 2 の `channel` は S3 での公開の形を指す
- 宛先の名前: `"anthropic-messages"` のみ（S1）
- `requestId`: 呼び出し元（TS 側）が要求ごとに一意な値を生成して渡す（ライブラリは発行しない）。中止はこの値で要求を指す
- 送信の要求: `{ requestId, destination, headers?: Record<string, string>, body: string /* JSON */ }` → 応答の頭: `{ status: number, headers: { "retry-after"?: string, "request-id"?: string, "content-type"?: string } }`、本文: バイト列の断片の列（終端・エラーを含む）
- `headers`（任意）: 呼び出し元が付けたい秘密でないヘッダ（例: `anthropic-beta`）。**Rust は `x-api-key`・`authorization`・`anthropic-version` がここに含まれていても捨て**、宛先の表と保管のポートの値だけを付ける
- 応答の頭の `request-id` は Anthropic が返す応答ヘッダであり、呼び出し元が生成する `requestId` とは別物である
- 失敗の種類: 宛先不明／キー未登録／接続失敗／中止／リダイレクト拒否（3xx。ステータスだけを持つ）（3xx 以外の HTTP のステータスは応答の頭で返す）。**エラーの値にキー・要求本文・応答本文を含めない**
- キーの操作: 登録（プロバイダ・値）／削除（プロバイダ）／登録の有無（プロバイダ → 真偽値）
- 失敗の種類（2026-09-27 追記・S1 の実装の実測）: 上の 5 つに、キーの保管の失敗・不正なヘッダ・要求 ID の重複を加えた 8 つ

### IF / API（S2 で固定する TS 側の境界・名前は仮）

- **能力の宣言**（クリティカル設計決定 5）: `LlmBackendImplementation` に必須の `capabilities: { runsOwnToolLoop: boolean; supportsToolChoice: boolean; limitsResponseLength: boolean }`。ファサードは、バックエンドの名前から宣言を引く関数（仮に `getLlmBackendCapabilities(backend)`。未登録なら `LlmBackendNotRegisteredError`）を公開する
- **転送のポート**（クリティカル設計決定 6）:
  - 送信: `send({ destination: "anthropic-messages", headers?: Record<string, string>, body: string }, signal: AbortSignal)` → `{ status: number, headers: { "retry-after"?: string, "request-id"?: string, "content-type"?: string }, body: AsyncIterable<Uint8Array> }`
  - 失敗: 送信の段階・本文を読む段階のどちらでも、種類（宛先不明・キー未登録・キーの保管の失敗・不正なヘッダ・要求 ID の重複・接続失敗・中止・リダイレクト拒否）を持つ 1 つのエラーの型で投げる。リダイレクト拒否はステータスを持つ。**エラーの値にキー・要求本文・応答本文を含めない**
  - `signal` が中止されたら、ポートは送信中の要求を中止する（S3 の Tauri 実装では `secure_cancel`）
- **BYOK（Anthropic）のバックエンドの登録**: 登録関数（仮に `registerByokAnthropicBackend(transport)`）がポートを受け取り、`byok-anthropic` の名前でレジストリへ登録する。宣言する能力は「ループを自分で回さない・強制に対応する・応答長を制限できる」
- **要求本文**: `model`・`max_tokens`・`messages` と、呼び出し元が指定したときだけ `system`・`tools`・`tool_choice`・`output_config`。`thinking` は常に含める（ファサードの既定の `{ type: "disabled" }` を含む）。ストリーミングは `stream: true`、非ストリーミングは `stream: false`
- **HTTP のエラー**: 応答のステータスが 2xx でなければ、本文を `text`・`tool_use` として解釈せず、ステータスと `retry-after` を持つ例外で失敗する（`onTextDelta` は呼ばない）
- **ログ**: 応答に `text`・`tool_use` が 1 つも無いときは `normalizeMessage` と同じくメタ情報（停止理由・ブロックの種類・モデル・トークン数）だけを `console.warn` に出す。本文・thinking・ツールの入力は出さない
- **打ち切られた `tool_use`**（2026-09-28 追記・Issue #643）: `stop_reason: "max_tokens"` の応答に `tool_use` のブロックが1つ以上あれば、`input`（ストリーミングは `partial_json` の連結）を解釈せず、再試行不可の失敗として扱う（#637 の OpenAI 側と同じ方針。打ち切りは同じ要求の再送で直らない）。ストリーミングは `message_stop` 確認後、`partialJson` の解釈より前に判定する

### S2 のモジュールをバンドル検査の対象にする方法（2026-09-27 親の決定: (A)）

- **採用: (A)**。`core-entry.ts` は BYOK（Anthropic）の登録関数を**呼ばずに re-export** し、S3 で Tauri の器がポートを渡して呼ぶ。`registeredCoreLlmBackendNames()` は空のまま（オーナーの決定 Q4-c）
- **#582 S1 への申し送り**: OpenAI の変換器（BYOK〔OpenAI〕の登録関数）も同じ入口（`core-entry.ts` から呼ばずに re-export）に置けば、既存の `core-entry.bundle.test.ts` がそのまま検査する

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| (A)（採用） | `core-entry.ts` が BYOK（Anthropic）の登録関数を**呼ばずに** re-export する。S3 で Tauri の器がこの関数に Tauri 実装のポートを渡して呼ぶ | 既存の `core-entry.bundle.test.ts` がそのまま S2 のモジュールを検査する（テストの変更が要らない）。`registeredCoreLlmBackendNames()` は空のまま（オーナーの決定 Q4-c「コアのエントリは何も登録しない」を保つ）。アーキテクチャ決定「製品版のエントリが Tauri 実装のポートを注入する」の注入口がそのまま決まる | S3 の「製品版のエントリへの登録」の一部（公開の形）を S2 で先に決めることになる |
| (B) | `core-entry.bundle.test.ts` に、BYOK（Anthropic）のモジュールを入口にした 2 本目のバンドル検査を足す（`core-entry.ts` は変えない） | コアのエントリの公開面を S3 まで変えない | #594 の検査の仕組み（esbuild の設定・静的検査）を 2 つの入口で持つ変更が要る。#582 の OpenAI の変換器でも同じ追加が要る |
| (C) | S2 ではバンドル検査の対象にしない（S3 の登録で到達するようになってから検査される） | S2 の変更が最小 | S2 の時点で「Node 依存・SDK が入らない」が機械的に確かめられない（親の指示「#594 のバンドル検査を通すこと」を満たせない）。#582 S1 の受入基準（`core-entry.bundle.test.ts` が OpenAI の変換器を検査する）も空振りになる |

> 受入基準（S2）の該当項目は (A) を前提に書いた。親の回答が (B)・(C) なら、その項目を書き換える。

### 実装計画（S1 のチケット分解の見通し）

1. Rust ライブラリ: 保管のポートとキーチェーン実装・メモリ実装
2. Rust ライブラリ: 宛先の表と、資格情報を付与するストリーミング転送（中止つき）
3. Rust ライブラリ: 実キーチェーンの結合テスト（`#[ignore]`・手動実行の手順・属性のアサーション）
4. `npm run test:rust` の新設と、`CLAUDE.md` の品質方針（必須ゲート）・よく使うコマンドの更新

### 実装計画（S2 のチケット分解の見通し）

1. 能力の宣言: `LlmBackendImplementation` の必須の能力・`api`／`claude-code` の宣言・ファサードの参照関数、レジストリの鍵の型と `LLM_BACKEND` の検証の型の分離、名前の分岐 3 か所の置き換え（既存の呼び出し元のテストの準備に模擬のバックエンドの登録を足す）
2. 転送のポートの型と、SDK を使わない Anthropic Messages のクライアント（要求本文の組み立て・SSE と JSON の解釈・`rawContent`・エラーの分類・中止）と BYOK（Anthropic）のバックエンドの登録関数（模擬のポートで固定）、`core-entry.ts` からの登録関数の re-export（呼ばない）によるバンドル検査への到達

> 1 と 2 は `llm/claude-client.ts`・`llm/llm-backend-registry.ts` で重なる（2 の登録は 1 の能力の宣言を要る）。1 を先に入れて 2 を直列にするのが無難。

### 境界を迂回する経路と扱い（S3）

課金と秘密情報を扱うため、悪意ある利用者（侵害された WebView を含む）・誤った呼び出しが境界を迂回する経路を列挙し、受入基準（S3）で塞ぐか、塞がない理由を書く。確定しないものは拒否に倒す。

| # | 経路 | 扱い |
|---|---|---|
| B1 | 宛先の名前の偽装（URL や表に無い名前を `destination` に渡す） | 塞ぐ。コマンドは製品版の表だけを使い、表に無い名前は送らずに「宛先不明」（受入基準 S3-R4） |
| B2 | 表にある別の宛先（`openai-responses`）へ送らせる | 塞ぐ。OpenAI のキーは S3 のコマンドで登録できないため「キー未登録」で送らない（S3-R5・S3-K4） |
| B3 | TS から認証ヘッダ（`x-api-key`・`authorization`・`anthropic-version`）を渡してキーを差し替える・宛先へ別のキーを送る | 塞ぐ。S1 の除去をコマンド経由でも確かめる（S3-R6） |
| B4 | `requestId` の衝突（送信中の要求と同じ値で送る） | 塞ぐ。後の要求は「要求 ID の重複」で失敗し、先の要求は影響を受けない（S3-R10・S3-R11） |
| B5 | 他の要求の中止（他の `requestId` で `secure_cancel` を呼ぶ） | 塞がない。WebView は 1 つの信頼の単位で、中止できるのは同じ WebView が送った要求だけ（`Channel` の本文も送った Webview からしか取り出せない）。中止は生成を止めるだけでキーは出ない。TS は `requestId` を `crypto.randomUUID()` で発行し、偶発の衝突を避ける |
| B6 | 中止と完了の競合（Rust が要求を登録する前に中止が届く・完了の後に中止が届く） | 塞ぐ。応答の頭が返った時点で中止済みならもう一度 `secure_cancel` を呼んで「中止」で失敗する（S3-T6）。完了の後の中止は偽を返すだけで失敗しない（S3-R13） |
| B7 | リダイレクトで誘導先へキーを送らせる | 塞ぐ（S1）。コマンドは「リダイレクト拒否」とステータスを返す（S3-R8） |
| B8 | エラー・`Debug`・`Channel` の失敗の値からキーが漏れる | 塞ぐ。5 つのコマンドの戻り値・失敗の値と `Channel` の送信内容にキーが現れないことをテストで固定する（S3-R14・S3-R16）。**キーが出うる出力の経路（コマンドの戻り値・失敗の値・`Channel`・`console` への出力・画面の表示・例外の文言）は列挙で固定すると漏れが残るため、実装時に全数を監査し PR に記載する**（S3-A1） |
| B9 | キーの値を返すコマンドを呼ぶ・未許可のコマンドを呼ぶ | 塞ぐ。器が公開するコマンドは 5 つだけで、値を返すものは無い（S3-C1）。値を返す名前のコマンドを呼んでも失敗する（S3-C2） |
| B10 | capability の過剰な許可（`core:default`・他のプラグインの権限・`remote` の付与） | 塞ぐ。capability の権限の集合を固定する（S3-C3・S3-C5） |
| B11 | 証跡の `blob:` の新しいウィンドウなど、`main` 以外のウィンドウからコマンドを呼ぶ | 塞ぐ。capability の対象は `main` のウィンドウだけ（S3-C5） |
| B12 | 登録の瞬間に WebView を通ったキーが残る（DB・`/api`・ログ・入力欄） | 塞ぐ。キーの登録は `/api`（DB）を通らず、成功後に入力欄を空にし、キーを `console` に出さない（S3-U4・S3-U5・S3-U6）。JS の文字列のメモリからの消去はできない（オーナーの決定 Q1-b で許容） |
| B13 | 空の値・改行を含む値を登録させ、送信のたびに失敗させる | 塞ぐ。「不正なキー」で拒否し保管しない（S3-K5・S3-K8） |
| B14 | 製品版で開発者用の経路（`LLM_BACKEND`・`api`・`claude-code`）へ切り替わる | 塞ぐ。製品版の解決関数は `env` を読まず常に `byok-anthropic` を返す（S3-S5）。製品版のエントリが解決関数を登録し忘れても `claude-code`（未登録）で送信しない（クリティカル設計決定 7） |
| B15 | 登録時のテスト送信を悪用した送信 | 該当しない。テスト送信を作らない（「やらないこと」） |

### IF / API（S3 で固定する Tauri のコマンドの境界・名前は仮定 A2 のとおり実装で決めてよいが、TS と Rust の両方のテストで同じ名前を固定する）

- `secure_send({ requestId: string, destination: string, headers: Record<string, string>, body: string, onEvent: Channel<StreamEvent> })` → `{ status: number, headers: { "retry-after"?: string, "request-id"?: string, "content-type"?: string } }`
  - `StreamEvent`: `{ event: "chunk", data: number[] }`（本文の断片のバイト列）／`{ event: "end" }`／`{ event: "error", error: CommandError }`。`end`・`error` は 1 回だけ、最後に送る
- `secure_cancel({ requestId })` → `boolean`（送信中の要求があれば真）
- `byok_key_set({ provider: "anthropic", key: string })` → `null`
- `byok_key_delete({ provider: "anthropic" })` → `null`（未登録でも成功）
- `byok_key_status({ provider: "anthropic" })` → `boolean`
- `CommandError`: `{ kind, status?, osStatus? }`。`kind` は S1 の 8 種類（`unknown-destination`・`key-not-registered`・`key-store-failure`・`invalid-header`・`duplicate-request-id`・`connection`・`cancelled`・`redirect-refused`。S2 の `SecureTransportErrorKind` と同じ綴り）と、キーのコマンドの `unknown-provider`・`invalid-key`。`status` はリダイレクト拒否のとき、`osStatus` はキーチェーンの失敗のときだけ持つ
- 選択の解決関数（クリティカル設計決定 7）: `LlmSelectionResolver = (env: AppEnv, settings: SettingsSnapshot) => { backend: LlmBackendName; model: string }`。登録する関数と、呼び出し元が使う「解決する関数」をファサードの側に置く。製品版の解決関数は `core-entry.ts` から re-export する（バンドル検査の対象）

### 実装計画（S3 のチケット分解の見通し）

1. 選択の解決関数の骨格（レジストリ・開発者用と製品版の解決関数・呼び出し元 7 か所の置き換え・`llmBackend` の引数の削除）
2. 器のコマンド 5 つと `Channel`・capability（Rust。模擬の送信先とメモリの保管で固定）
3. 製品版の web のエントリ: 転送のポートとキーの操作の Tauri 実装・BYOK（Anthropic）と製品版の解決関数の登録・キーの欄
4. 署名つきのビルドのスクリプト・手動の確認手順と検査手順

> 1 と 2 は独立。3 は 1・2 の後。1 チケットで直列に進める想定（要件チケットは 1 件）。

## スライス（出荷の単位）

> Q5（親の決定）。#579 S2 の器が無い時点で出荷できる最小の単位として、Tauri に依存しない Rust ライブラリを S1 にした。

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | Tauri に依存しない Rust の通信層ライブラリ。保管のポート（macOS キーチェーン実装とテスト用のメモリ実装）・宛先の表（Anthropic Messages のみ）・キーを付与するストリーミング転送と中止。`cargo test` で、付与するヘッダ・認証ヘッダの除去・宛先外の拒否・逐次の中継・中止・キーの非露出を固定する。`npm run test:rust` を必須ゲートに加える（`CLAUDE.md` の更新を含む）。実キーチェーンの結合テスト（手動）で、未署名の開発ビルドでのデータ保護キーチェーンの可否を実測する | 10-14 | #594 のマージを待たずに着手できる（TS に触れない）。これだけで、#576 で未検証だった「Rust からのストリーミング転送」と「キーを返さない保管」の成立が確かめられる |
| S2 | TS 側: SDK を使わない Anthropic Messages のクライアント（SSE の解釈・thinking の署名の保持・tool use のループへの接続・エラーの分類）を転送のポートの上に作り、#594 のレジストリへ BYOK（Anthropic）として登録できる形にする（`LlmBackend`・`BossLlmClient` の拡張）。**呼び出し元とファサードのバックエンドの名前の分岐（`reports/extract-evening-summary.ts`・`dashboard/boss-comment.ts`・`llm/claude-client.ts`）を、`LlmBackendImplementation` が宣言する能力（ツールのループを自分で回すか・ツール呼び出しの強制に対応するか・要求ごとに応答長を制限できるか）へ置き換える**（#582 の決定 Q5・クリティカル設計決定 5。開発者用の版の振る舞いは変えない）。vitest で模擬のポートを使って固定する | 14-20 | S1 と #594 がマージされてから（2026-09-27 時点で両方マージ済み）。#582 S1 はこのスライスのマージ後に着手する |
| S3 | #579 S2 の器への配線: Tauri のコマンドと `Channel`・capability、製品版のエントリへの登録、キーの登録・削除の画面、検査手順。製品版でのチャット（SSE・生成停止）・朝会・夕会の動作確認。**2026-09-29 追加（オーナーの決定 Q6・Q7）: #582 のクリティカル設計決定 5 の選択の解決関数の骨格（呼び出し元 7 か所の置き換え）と、署名つきのビルド（entitlements の生成・署名 ID とチーム ID を環境変数で渡す）** | 20-30 | S2 と #579 S2 がマージされてから（動作確認は #580 S2 の後） |

実装対象: S3

## やらないこと

- OpenAI への送信と OpenAI のキーの保管、BYOK で許可するモデルの範囲（理由: #582 の範囲）
- 中継サーバーへの送信とライセンストークンの保管・付与（理由: #583・#584 の範囲。認証方式が未決）
- プラン込みと BYOK の切り替えの画面・選択の保存（理由: #582〜#584 で扱う。本機能の製品版の LLM は BYOK の Anthropic だけ）
- Windows（DPAPI）・Android（Keystore）のキーの保管（理由: Windows は ADR 0011 決定 19 で後続リリース。Android は iOS / Android のビルドの後続）
- iOS のビルドと実機での確認（キーチェーンの永続性・バックアップの扱いの実機確認を含む）（理由: ADR 0011「未決」節で製品化の後のフェーズ）
- Tauri の器・DB 層（理由: #579 S2・#580）
- 開発者用の版の `api`・`claude-code` バックエンドと `server/.env` の変更（理由: ADR 0002 改訂の決定 5）
- 登録時のキーの有効性の事前確認（テスト送信）（理由: 2026-09-29 親の決定で S3 でも行わない。YAGNI・送信の範囲を増やさない。無効なキーは最初の LLM の要求の失敗として既存の失敗の経路で見える〔仮定 A19〕）
- 端末をまたいだキーの同期・iCloud キーチェーンへの保管（理由: オーナーの決定 Q1-a。端末ごとに登録し直す）
- キーを WebView を通さずに入力するネイティブの入力画面（理由: オーナーの決定 Q1-b。登録時の 1 回の通過を許容する。ADR 0011 決定 6 はネイティブ UI を採らない）
- 開発者用の版（Node サーバー）で BYOK（Anthropic）のバックエンドを登録すること・`LLM_BACKEND` の許容値を増やすこと（理由: ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5。開発者用の版には Rust の通信層が無い）
- 保存した選択（プロバイダとモデル）から送信先を決める製品版の解決関数・選択の画面と保存・「未選択」の失敗（理由: #582 S2 の範囲。#582 のクリティカル設計決定 5。**解決関数を注入する骨格と、固定の製品版の解決関数は S3 で入れる**〔オーナーの決定 Q6〕）
- 転送のポートの Tauri 実装（`invoke`・`Channel`・`secure_cancel` と `requestId` の発行）（理由: S3 の範囲。2026-09-29 に S3 で実装）
- 自動テストでの実キー・実 API の使用（理由: 課金と秘密情報。実キー・実 API での動作確認はオーナーが「手動の確認手順（S3）」で行う）
- （S3 で追加）OpenAI のキーの登録・削除の画面と、製品版のエントリへの BYOK（OpenAI）の登録（理由: #582 S2 の範囲。S3 のキーのコマンドは `openai` を拒否する）
- （S3 で追加）開発ビルドのためにキーの属性を弱める分岐（ファイル型のキーチェーンへの保管など）（理由: オーナーの決定 Q7。製品版の属性は変えない）
- （S3 で追加）配布用の署名・公証・プロビジョニングプロファイルの管理（理由: #587 の範囲。S3 は手動の確認のための署名つきビルドの手順だけを足す）
- （S3 で追加）他の `requestId` の中止を防ぐこと（理由: 迂回経路 B5。WebView は 1 つの信頼の単位で、中止はキーを漏らさない）
- （S3 で追加）無効なキー・未登録のキーを区別した画面の案内（理由: 親の決定。必要なら別 Issue）
- （S3 で追加）スケジューラ・通知・常駐への配線（通知文面・催促の予約の文面の LLM を製品版で実際に呼ぶ経路）（理由: #579 S3・#585 の範囲。S3 はこれらの呼び出し元の解決関数の置き換えまで）

## 受入基準（S1）

- [ ] 保管のポートのメモリ実装にキーを登録すると、登録の有無を問い合わせた結果が真になる
- [ ] 保管のポートのメモリ実装で、登録したキーを削除すると、登録の有無を問い合わせた結果が偽になる
- [ ] 保管のポートで、キーが未登録のとき削除しても失敗しない
- [ ] 保管したキーの値を読み出す関数は、Rust ライブラリの外から呼べない（ライブラリの外から呼ぶコードがコンパイルできないことを `compile_fail` の doctest で固定する）
- [ ] 製品版の宛先の表は `anthropic-messages` の 1 行だけである
- [ ] 製品版の宛先の表の `anthropic-messages` の送信先は `https://api.anthropic.com/v1/messages` である
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求のメソッドは `POST` である
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求のパスは `/v1/messages` である
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求の `x-api-key` は、保管のポートに登録したキーである
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求の `anthropic-version` は `2023-06-01`（現行の `@anthropic-ai/sdk` が送る値）である
- [ ] 呼び出し元が要求の `headers` に `x-api-key` のヘッダを含めても、模擬サーバーが受けた要求にはその呼び出し元の値が現れない
- [ ] 呼び出し元が要求の `headers` に `authorization` のヘッダを含めても、模擬サーバーが受けた要求にはその呼び出し元の値が現れない
- [ ] 呼び出し元が要求の `headers` に `anthropic-version` のヘッダを含めても、模擬サーバーが受けた要求にはその呼び出し元の値が現れない
- [ ] 呼び出し元が渡した要求本文は、模擬サーバーが受けた要求本文とバイト列として一致する
- [ ] 宛先の表に無い名前を指定すると、模擬サーバーへ要求を送らずに「宛先不明」の失敗で終わる
- [ ] キーが未登録のとき送ると、模擬サーバーへ要求を送らずに「キー未登録」の失敗で終わる
- [ ] 模擬サーバーが最初の断片を送った後、テストの合図があるまで最後の断片の送出を保留すると、呼び出し元は合図の前に最初の断片を受け取る（壁時計の待ち時間に頼らない）
- [ ] 呼び出し元が受け取った断片を順に連結したものは、模擬サーバーが返した本文とバイト列として一致する
- [ ] 応答の頭のステータスは、模擬サーバーが返した HTTP ステータスである（200 と、429・500 の各場合）
- [ ] 模擬サーバーが 3xx（301・302・307・308 の各場合）で別オリジンの第 2 の模擬サーバーへ誘導しても、第 2 の模擬サーバーは要求を 1 件も受けない（キーが誘導先へ送られない）
- [ ] 模擬サーバーが 3xx（301・302・307・308 の各場合）で誘導すると、呼び出し元は「リダイレクト拒否」の失敗で終わる
- [ ] 「リダイレクト拒否」の失敗の値は、模擬サーバーが返したステータス（301・302・307・308 の各場合）を持つ
- [ ] 模擬サーバーが 3xx で同じオリジンの別のパスへ誘導しても、模擬サーバーが受ける要求は最初の 1 件だけである（同じオリジンでも追従しない）
- [ ] 模擬サーバーが `retry-after` を返すと、応答の頭にその値が入る
- [ ] 模擬サーバーが許可していないヘッダ（例: `set-cookie`）を返しても、応答の頭には入らない
- [ ] 送信中（最初の断片を受け取った後、最後の断片より前）に中止すると、模擬サーバー側で接続が切れたことが観測される
- [ ] 送信中に中止すると、呼び出し元は「中止」の失敗で終わる
- [ ] 失敗の値（宛先不明・キー未登録・接続失敗・中止・リダイレクト拒否の各種類）の `Debug` と `Display` の文字列に、登録したキーの文字列が含まれない
- [ ] 接続失敗の失敗の値の `Debug` と `Display` の文字列に、要求本文の文字列が含まれない
- [ ] 応答の頭の `Debug` の文字列に、登録したキーの文字列が含まれない（応答の頭が `Display` を実装する場合は `Display` の文字列も同じ）
- [ ] `npm run test:rust` が Rust ライブラリのテスト（`#[ignore]` を除く）を実行し、合格する
- [ ] ルートの `package.json` の `test` スクリプトは `cargo` を呼ばない（Rust のツールチェーンが無くても `npm test` が動く）
- [ ] `CLAUDE.md` の品質方針の必須ゲートに `npm run test:rust` が含まれる
- [ ] 実キーチェーンの結合テスト（手動・`#[ignore]`）に、登録した後に登録の有無を問い合わせると真になることを確かめるアサーションがある
- [ ] 実キーチェーンの結合テスト（手動・`#[ignore]`）に、削除した後に登録の有無を問い合わせると偽になることを確かめるアサーションがある
- [ ] 実キーチェーンの結合テスト（手動・`#[ignore]`）に、登録した項目がデータ保護キーチェーンに入っていることを確かめるアサーションがある
- [ ] 実キーチェーンの結合テスト（手動・`#[ignore]`）に、登録した項目のアクセシビリティが `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` であることを確かめるアサーションがある
- [ ] 実キーチェーンの結合テスト（手動・`#[ignore]`）に、登録した項目の `kSecAttrSynchronizable` が偽であることを確かめるアサーションがある
- [ ] 実キーチェーンの結合テストを開発機で手動実行した結果（全件合格、または失敗したテスト名と OSStatus の番号）が S1 の PR 本文に記録されている

> 実キーチェーンの結合テストの**実行結果は S1 の合否の条件にしない**（親の決定）。未署名の開発ビルドでデータ保護キーチェーンが使えずに失敗した場合も、上の各基準（テストとアサーションが用意されていること・結果が記録されていること）を満たせば S1 は完了とし、開発ビルドの扱いは記録された結果を見て親・オーナーが決める（クリティカル設計決定 1「未検証のリスク」）。製品版のキーチェーンの属性は、結果にかかわらず変えない。
- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:tz` が合格する

## 受入基準（S2）

> テストはすべて vitest で、模擬の転送のポートと、Anthropic Messages API の形に合わせた手書きの応答（SSE のバイト列・JSON）で行い、実 API は呼ばない。「能力を宣言した模擬のバックエンド」は、テストの中でレジストリへ登録する、名前も能力も任意に選べる実装を指す。

**能力の宣言（バックエンドの名前の分岐の置き換え）**

- [ ] `registerDevLlmBackends()` が登録する `api` の実装は「ループを自分で回さない・強制に対応する・応答長を制限できる」と宣言する
- [ ] `registerDevLlmBackends()` が登録する `claude-code` の実装は「ループを自分で回す・強制に対応しない・応答長を制限できない」と宣言する
- [ ] BYOK（Anthropic）の登録関数が登録する実装は「ループを自分で回さない・強制に対応する・応答長を制限できる」と宣言する
> 次の 8 項目は、**名前と逆の能力を宣言した模擬のバックエンド**を名前 `api`・`claude-code` の下に登録して確かめる（呼び出し元はバックエンドを `LLM_BACKEND` で選ぶため、名前はこの 2 つに限られる）。名前で分岐する実装はこれらの項目で落ちる。

- [ ] 名前 `api` の下に「ループを自分で回す」と宣言した模擬のバックエンドを登録し、`streamBossMessage` に `executeTool` を渡して呼ぶと、1 回目の応答に `tool_use` があっても、`streamRound` は 1 回だけ呼ばれ、ファサードは `executeTool` を呼ばない
- [ ] 名前 `claude-code` の下に「ループを自分で回さない」と宣言した模擬のバックエンドを登録し、`streamBossMessage` に `executeTool` を渡して呼ぶと、1 回目の応答に `tool_use` があれば、ファサードは `executeTool` を呼び、`streamRound` を 2 回目も呼ぶ
- [ ] `LLM_BACKEND=claude-code` で、名前 `claude-code` の下に「強制に対応する」と宣言した模擬のバックエンドを登録して夕会の要約抽出を呼ぶと、要求の `toolChoice` は `{ type: "tool", name: "submit_evening_summary" }` である
- [ ] `LLM_BACKEND=api` で、名前 `api` の下に「強制に対応しない」と宣言した模擬のバックエンドを登録して夕会の要約抽出を呼ぶと、要求に `toolChoice` が無い
- [ ] `LLM_BACKEND=api` で、名前 `api` の下に「応答長を制限できない」と宣言した模擬のバックエンドを登録してダッシュボードのひとことを生成すると、要求のユーザーの指示に `CLAUDE_CODE_SHORT_TEXT_INSTRUCTION` が含まれる
- [ ] 同じ条件で全角換算 81 字の応答が返ると、ダッシュボードのひとことはテンプレートの文面になる
- [ ] `LLM_BACKEND=claude-code` で、名前 `claude-code` の下に「応答長を制限できる」と宣言した模擬のバックエンドを登録してダッシュボードのひとことを生成すると、要求のユーザーの指示に `CLAUDE_CODE_SHORT_TEXT_INSTRUCTION` が含まれない
- [ ] 同じ条件で全角換算 81 字の応答が返ると、ダッシュボードのひとことはその応答の文面になる（テンプレートへ退避しない）
- [ ] 能力の宣言を引く関数に未登録のバックエンドの名前を渡すと、`LlmBackendNotRegisteredError` で失敗する
- [ ] 既存の `reports/extract-evening-summary.test.ts`・`dashboard/boss-comment.test.ts`・`dashboard/boss-comment.claude-code.test.ts`・`notifications/notification-body.claude-code.test.ts`・`llm/claude-client.test.ts`・`config.test.ts` は、既存のテストケースの期待値（アサーション）を変えずに合格する（変えてよいのはテストの準備〔模擬のバックエンドの登録・模擬の実装への能力の宣言の追加〕だけ）
- [ ] `resolveLlmBackend` に `LLM_BACKEND=byok-anthropic` を渡すと、他の許容外の値と同じく例外で失敗する
- [ ] `registerDevLlmBackends()` の後、`registeredLlmBackendNames()` は `api` と `claude-code` の 2 つだけである（開発者用の版は BYOK〔Anthropic〕を登録しない）

**BYOK（Anthropic）の登録と要求**

- [ ] BYOK（Anthropic）の登録関数に模擬のポートを渡した後、`createClaudeClient(env, "byok-anthropic")` は `env` に `ANTHROPIC_API_KEY` が無くても失敗しない
- [ ] BYOK（Anthropic）で送ると、ポートに渡る宛先の名前は `anthropic-messages` である（ストリーミング・非ストリーミングの両方）
- [ ] BYOK（Anthropic）でポートに渡る要求の `headers` に、`x-api-key`・`authorization`・`anthropic-version` のいずれも無い（大文字小文字を区別しない）
- [ ] `env` の `ANTHROPIC_API_KEY` に値を入れてクライアントを作っても、ポートに渡る要求の `headers` の値と本文に、その値の文字列が現れない
- [ ] ストリーミングの要求本文の `stream` は `true`、非ストリーミングの要求本文の `stream` は `false` である
- [ ] 要求本文の `model` は、呼び出し元が指定したモデル ID である
- [ ] 要求本文の `max_tokens` は、呼び出し元の `maxTokens` と一致する
- [ ] 要求本文の `system` は、呼び出し元の `system` と一致する
- [ ] 呼び出し元が `system` を指定しないと、要求本文に `system` の項目が無い
- [ ] 要求本文の `messages` は、呼び出し元の `messages` と同じ順・同じ値である
- [ ] 要求本文の `tools` は、呼び出し元が渡した `tools` と一致する
- [ ] 呼び出し元が `tools` を渡さないと、要求本文に `tools` の項目が無い
- [ ] 呼び出し元が `thinking` を指定しないと、要求本文の `thinking` は `{ "type": "disabled" }` である
- [ ] 呼び出し元が `thinking: { type: "adaptive" }` と `outputConfig: { effort: "low" }` を渡すと、要求本文の `thinking` は `{ "type": "adaptive" }`、`output_config` は `{ "effort": "low" }` である
- [ ] 呼び出し元が `outputConfig` を渡さないと、要求本文に `output_config` の項目が無い
- [ ] 夕会の要約抽出を BYOK（Anthropic）で呼ぶと、要求本文の `tool_choice` は `{ "type": "tool", "name": "submit_evening_summary" }` である

**ストリーミングの応答の解釈**

- [ ] 模擬の応答が `text_delta` を 2 回返すと、`onTextDelta` は同じ順で 2 回、それぞれの差分の文字列で呼ばれる
- [ ] 模擬の応答の断片の区切りが SSE のイベントの途中にあっても、`onTextDelta` が受け取る文字列の連結は、応答の `text_delta` の連結と一致する
- [ ] 模擬の応答の断片の区切りが UTF-8 の多バイト文字（例: 「上司」）のバイト列の途中にあっても、`onTextDelta` が受け取る文字列の連結は、応答の `text_delta` の連結と一致する（置換文字 U+FFFD が現れない）
- [ ] 模擬の応答に `tool_use` のブロックがあり、`input_json_delta` を 2 回以上に分けて返すと、`BossLlmMessage.content` に同じ `id`・`name` と、`partial_json` を連結して JSON として解釈した値を `input` に持つ `tool_use` のブロックが入る
- [ ] 模擬の応答の `tool_use` のブロックに `input_json_delta` が 1 回も無いと、そのブロックの `input` は `{}` である
- [ ] 模擬の応答の `text` のブロックは、`BossLlmMessage.content` に同じ文字列の `text` のブロックとして入る
- [ ] 模擬の応答に `thinking` のブロック（`thinking_delta` と `signature_delta`）があると、`BossLlmMessage.content` にはそのブロックが入らず、`rawContent` には `thinking_delta` の連結を `thinking` に、`signature_delta` の値を `signature` に持つ `thinking` のブロックが入る
- [ ] 模擬の応答に `redacted_thinking` のブロックがあると、`rawContent` に同じ `data` を持つ `redacted_thinking` のブロックが入る
- [ ] `rawContent` のブロックは、応答のブロックの `index` の順に並ぶ
- [ ] 模擬の応答に `ping` のイベントが挟まっても、`BossLlmMessage` は `ping` が無い場合と同じである
- [ ] 模擬の応答に `text`・`tool_use` のブロックが 1 つも無い（`thinking` だけの）とき、`console.warn` に渡る値に、その `thinking` の文字列が含まれない

**非ストリーミングの応答の解釈**

- [ ] 模擬の非ストリーミングの応答（JSON。複数の断片に分けて返す）の `content` の `text` は `text` のブロックに、`tool_use` は同じ `id`・`name`・`input` の `tool_use` のブロックになる
- [ ] 模擬の非ストリーミングの応答の `content` 全体（`thinking` を含む）は、同じ順・同じ値で `rawContent` に入る

**ツールのループ（ファサード経由の送り返し）**

- [ ] BYOK（Anthropic）で `streamBossMessage` に `executeTool` を渡して呼び、1 回目の応答が `thinking`（署名つき）と `tool_use` を返すと、2 回目の要求本文の `messages` には、1 回目の `rawContent` と同じ値・同じ順のブロックを `content` に持つ `assistant` のメッセージが含まれる（`thinking` の `signature` は 1 回目の応答の値と一致する）
- [ ] 同じ場面で、2 回目の要求本文の `messages` の最後は、1 回目の `tool_use` の `id` を `tool_use_id` に持つ `tool_result` を含む `user` のメッセージである

**エラーの分類**

- [ ] 応答のステータスが 429・408・500・503・529 のとき、BYOK（Anthropic）の分類は再試行可である
- [ ] 応答のステータスが 400・401・403・404 のとき、BYOK（Anthropic）の分類は再試行不可である
- [ ] 応答のステータスが 429 で応答の頭の `retry-after` が `"3"` のとき、分類の待ち時間は 3000 ミリ秒である
- [ ] 基準の時刻を `2026-09-27T00:00:00Z` に固定し、応答の頭の `retry-after` が `"Sun, 27 Sep 2026 00:00:05 GMT"` のとき、分類の待ち時間は 5000 ミリ秒である
- [ ] 同じ基準の時刻で、応答の頭の `retry-after` が過去の HTTP 日付（`"Sat, 26 Sep 2026 23:59:55 GMT"`）のとき、分類の待ち時間は無い
- [ ] 応答の頭の `retry-after` が数でも HTTP 日付でもない値（例: `"soon"`）のとき、分類の待ち時間は無い
- [ ] 応答のステータスが 2xx でないとき、そのラウンドは失敗し、応答の本文に `text_delta` の形のイベントがあっても `onTextDelta` は呼ばれない
- [ ] ポートが「接続失敗」で失敗すると、分類は再試行可である
- [ ] ポートが「宛先不明」「キー未登録」「キーの保管の失敗」「不正なヘッダ」「要求 ID の重複」「リダイレクト拒否」のそれぞれで失敗すると、分類は再試行不可である
- [ ] 模擬の応答の途中に SSE の `error` イベント（例: `overloaded_error`）があると、そのラウンドは失敗し、分類は再試行可である
- [ ] 模擬の応答の本文が `message_stop` の前に終わると、そのラウンドは失敗し、分類は再試行可である
- [ ] BYOK（Anthropic）が投げる失敗の値の `message` に、要求本文の文字列と応答本文の文字列が含まれない（HTTP のエラーの応答本文を含む）

**中止**

- [ ] `streamBossMessage` の `signal` を、1 つ目の断片を受け取った後に中止すると、ポートに渡った `signal` が中止され、`streamBossMessage` は失敗する
- [ ] 送信の前に中止済みの `signal` を渡すと、ポートは呼ばれないか、呼ばれた時点で渡った `signal` が中止済みである

**バンドル検査と品質ゲート**

> 次の 2 項目は親の決定（2026-09-27・案 (A)）による: `core-entry.ts` は BYOK（Anthropic）の登録関数を呼ばずに re-export する。

- [ ] `core-entry.ts` から BYOK（Anthropic）の登録関数へ到達でき、`core-entry.bundle.test.ts` が合格する（BYOK〔Anthropic〕のモジュールが外部の指定子・SDK・Node のグローバルを持ち込まない）
- [ ] `core-entry.ts` を読み込んだだけでは、`registeredCoreLlmBackendNames()` は空である（コアのエントリは BYOK〔Anthropic〕を登録しない）
- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:tz` が合格する
- [ ] `npm run test:rust` が合格する

## 受入基準（S3）

> 自動テストは vitest（TS）と `cargo test`（Rust）で行い、実キー・実 API・実キーチェーンは使わない。Rust のコマンドのテストは、器のクレートの中で、模擬の送信先（手元の模擬 HTTP サーバーの URL を持つ表）とメモリの保管（`MemoryKeyStore`）を注入した状態で行う。TS の Tauri 実装のテストは、模擬の `invoke` と模擬の `Channel` で行う。コマンドの名前・引数の名前は TS と Rust の両方のテストで同じ値を固定する（IF / API（S3））。「模擬の解決関数」は、テストの中で登録する、任意のバックエンドの名前とモデルを返す解決関数を指す。

**選択の解決関数（クリティカル設計決定 7）**

- [ ] S3-S1: 解決関数を登録していないとき、`LLM_BACKEND` の無い `env` で解決すると、バックエンドは `claude-code` である
- [ ] S3-S2: 解決関数を登録していないとき、`LLM_BACKEND=api` の `env` で解決すると、バックエンドは `api` である
- [ ] S3-S3: 解決関数を登録していないとき、`LLM_BACKEND=byok-anthropic` の `env` で解決すると、例外で失敗する
- [ ] S3-S4: 解決関数を登録していないとき、解決したモデルは設定の `model` の値である（設定に `model` が無ければ `claude-sonnet-5`）
- [ ] S3-S5: 製品版の解決関数は、`LLM_BACKEND=api` の `env` を渡しても、バックエンド `byok-anthropic` を返す
- [ ] S3-S6: 製品版の解決関数が返すモデルは設定の `model` の値である（設定に `model` が無ければ `claude-sonnet-5`）
- [ ] S3-S7: 模擬の解決関数を登録すると、チャットの応答の生成は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S8: 模擬の解決関数を登録すると、チャットの要求の `model` は、解決関数が返したモデルである
- [ ] S3-S9: 模擬の解決関数を登録すると、セッションの要約は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S10: 模擬の解決関数を登録すると、セッションの要約の要求の `model` は、解決関数が返したモデルである
- [ ] S3-S11: 模擬の解決関数を登録すると、朝会の開始の発言の生成は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S12: 模擬の解決関数を登録すると、朝会の開始の発言の要求の `model` は、解決関数が返したモデルである
- [ ] S3-S13: 模擬の解決関数を登録すると、夕会の要約抽出は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S14: 模擬の解決関数を登録すると、夕会の要約抽出の要求の `model` は、解決関数が返したモデルである
- [ ] S3-S15: 模擬の解決関数を登録すると、ダッシュボードのひとことの生成は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S16: 模擬の解決関数を登録すると、ダッシュボードのひとことの要求の `model` は、解決関数が返したモデルである
- [ ] S3-S17: 模擬の解決関数を登録すると、通知文面の生成は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S18: 模擬の解決関数を登録すると、通知文面の要求の `model` は、解決関数が返したモデルである
- [ ] S3-S19: 模擬の解決関数を登録すると、催促の予約の文面の生成は、解決関数が返した名前のバックエンドでクライアントを作る
- [ ] S3-S20: 模擬の解決関数を登録すると、催促の予約の文面の要求の `model` は、解決関数が返したモデルである
- [ ] S3-S21: 夕会の要約抽出が参照する能力の宣言は、解決関数が返した名前のバックエンドの宣言である（`LLM_BACKEND` の無い `env` で、名前 `api` を返す模擬の解決関数と「強制に対応しない」と宣言した `api` の模擬のバックエンドを登録すると、夕会の要約抽出の要求に `toolChoice` が無いことで確かめる）
- [ ] S3-S22: ダッシュボードのひとことが参照する能力の宣言は、解決関数が返した名前のバックエンドの宣言である（`LLM_BACKEND=api` の `env` で、名前 `claude-code` を返す模擬の解決関数と「応答長を制限できない」と宣言した `claude-code` の模擬のバックエンドを登録すると、ダッシュボードのひとことの要求のユーザーの指示に `CLAUDE_CODE_SHORT_TEXT_INSTRUCTION` が含まれることで確かめる）
- [ ] S3-S23: 既存のテスト（`server/src` と `web/src` の `*.test.ts`・`*.test.tsx`）は、既存のテストケースの期待値（アサーション）を変えずに合格する（変えてよいのはテストの準備〔`createApp` に渡していた `llmBackend` を `LLM_BACKEND` の環境変数へ移すこと・模擬の解決関数の登録と後始末〕だけ。Rust の `native/tauri-app/tests/config_checks.rs` の capability の権限の期待値は、S3-C3 が #580 の AC-S2-5 を置き換えるため変わる）

**Rust: 器のコマンドと capability**

- [ ] S3-C1: 器が `tauri_build` の `AppManifest` に渡すアプリのコマンドの一覧は `secure_send`・`secure_cancel`・`byok_key_set`・`byok_key_delete`・`byok_key_status` の 5 つだけである
- [ ] S3-C2: `main` のウィンドウから、キーの値を返す名前のコマンド（`byok_key_get`・`byok_key_load`・`keychain_get`）を IPC で呼ぶと失敗する
- [ ] S3-C3: capability（`capabilities/`）が許可する権限は、`sql:allow-execute`・`sql:allow-select`・`allow-secure-send`・`allow-secure-cancel`・`allow-byok-key-set`・`allow-byok-key-delete`・`allow-byok-key-status` の 7 つちょうどである
- [ ] S3-C4: `main` のウィンドウ（アプリのオリジン）から `secure_send` を引数の名前 `requestId`・`destination`・`headers`・`body`・`onEvent` で IPC で呼ぶと、ACL で拒否されずにコマンドの結果が返る
- [ ] S3-C5: capability の対象のウィンドウは `main` だけで、capability に `remote` が無い
- [ ] S3-C6: `main` のウィンドウから `secure_cancel` を引数の名前 `requestId` で IPC で呼ぶと、ACL で拒否されずにコマンドの結果が返る
- [ ] S3-C7: `main` のウィンドウから `byok_key_set` を引数の名前 `provider`・`key` で IPC で呼ぶと、ACL で拒否されずにコマンドの結果が返る
- [ ] S3-C8: `main` のウィンドウから `byok_key_delete` を引数の名前 `provider` で IPC で呼ぶと、ACL で拒否されずにコマンドの結果が返る
- [ ] S3-C9: `main` のウィンドウから `byok_key_status` を引数の名前 `provider` で IPC で呼ぶと、ACL で拒否されずにコマンドの結果が返る

**Rust: `secure_send`・`secure_cancel`**

- [ ] S3-R1: 模擬の送信先へ `secure_send` を呼ぶと、戻り値の `status` は模擬サーバーが返した HTTP ステータスである（200・429 の各場合）
- [ ] S3-R2: 模擬サーバーが `retry-after` を返すと、`secure_send` の戻り値の `headers` の `retry-after` にその値が入る
- [ ] S3-R3: `Channel` で受け取った `chunk` の `data` を順に連結したものは、模擬サーバーが返した本文とバイト列として一致する
- [ ] S3-R4: 表に無い宛先の名前（例: `https://example.com/v1/messages`）で `secure_send` を呼ぶと、模擬サーバーへ要求を送らずに、種類 `unknown-destination` の失敗で終わる
- [ ] S3-R5: `anthropic` のキーだけを登録した状態で宛先 `openai-responses` へ `secure_send` を呼ぶと、模擬サーバーへ要求を送らずに、種類 `key-not-registered` の失敗で終わる
- [ ] S3-R6: `secure_send` の `headers` に `x-api-key` を含めても、模擬サーバーが受けた `x-api-key` は保管したキーである
- [ ] S3-R7: キーが未登録のとき `secure_send` を呼ぶと、種類 `key-not-registered` の失敗で終わる
- [ ] S3-R8: 模擬サーバーが 302 で誘導すると、`secure_send` は種類 `redirect-refused`・`status` 302 の失敗で終わる
- [ ] S3-R9: `Channel` の最後の送信は `end` であり、`end` は 1 回だけ送られる（本文を最後まで受け取った場合）
- [ ] S3-R10: 送信中の要求と同じ `requestId` で `secure_send` を呼ぶと、種類 `duplicate-request-id` の失敗で終わる
- [ ] S3-R11: S3-R10 の後も、先の要求の `Channel` には本文の残りと `end` が届く
- [ ] S3-R12: 送信中（最初の断片を受け取った後、最後の断片より前）に `secure_cancel` をその `requestId` で呼ぶと、`secure_cancel` は真を返し、`Channel` の最後の送信は種類 `cancelled` の `error` である
- [ ] S3-R13: 本文を最後まで受け取った後に `secure_cancel` をその `requestId` で呼ぶと、偽を返す
- [ ] S3-R14: キー（例: `sk-ant-test-S3-SECRET`）を登録した後、`secure_send` の戻り値と失敗の値の JSON、および `Channel` へ送った値の JSON に、そのキーの文字列が含まれない（成功・宛先不明・キー未登録・リダイレクト拒否・要求 ID の重複・中止の各場合）
- [ ] S3-R16: キーを登録した後、`secure_cancel`・`byok_key_set`・`byok_key_delete`・`byok_key_status` の戻り値と失敗の値の JSON に、そのキーの文字列が含まれない（各コマンドの成功と、`byok_key_*` の「不明なプロバイダ」の各場合）
- [ ] S3-R15: `Channel` への送信が失敗すると、器は本文の中継をやめ、模擬サーバー側で接続が切れたことが観測される

**Rust: キーのコマンド**

- [ ] S3-K1: `byok_key_set` で `anthropic` のキーを登録すると、`byok_key_status` は真を返す
- [ ] S3-K2: 登録した後に `byok_key_delete` を呼ぶと、`byok_key_status` は偽を返す
- [ ] S3-K3: キーが未登録のとき `byok_key_delete` を呼んでも失敗しない
- [ ] S3-K4: `byok_key_set` に `provider: "openai"` を渡すと、種類 `unknown-provider` の失敗で終わり、何も保管しない
- [ ] S3-K5: `byok_key_set` に空の文字列を渡すと、種類 `invalid-key` の失敗で終わり、`byok_key_status` は偽のままである
- [ ] S3-K6: `byok_key_delete` に `provider: "openai"` を渡すと、種類 `unknown-provider` の失敗で終わる
- [ ] S3-K7: `byok_key_status` に `provider: "openai"` を渡すと、種類 `unknown-provider` の失敗で終わる
- [ ] S3-K8: `byok_key_set` に改行を含む値を渡すと、種類 `invalid-key` の失敗で終わり、`byok_key_status` は偽のままである
- [ ] S3-K9: キーチェーンの失敗（`StoreError::Keychain { status: -34018 }`）は、種類 `key-store-failure`・`osStatus` -34018 の失敗の値になる

**TS: 転送のポートの Tauri 実装（製品版の web のエントリ）**

- [ ] S3-T1: ポートで送ると、`invoke` は `secure_send` の名前で、要求の `destination`・`headers`・`body` と文字列の `requestId` と `Channel` を引数に呼ばれる
- [ ] S3-T2: ポートで 2 回送ると、2 回の `requestId` は異なる
- [ ] S3-T3: `secure_send` の戻り値の `status` と `headers` は、ポートの応答の `status` と `headers` になる
- [ ] S3-T4: `Channel` に届いた `chunk` は、ポートの応答の本文の断片として同じ順・同じバイト列の `Uint8Array` で読め、`end` で本文の列が終わる
- [ ] S3-T5: 本文を読んでいる途中で `signal` を中止すると、`invoke` は `secure_cancel` の名前で同じ `requestId` を引数に呼ばれ、本文の読み出しは種類 `cancelled` の `SecureTransportError` で失敗する
- [ ] S3-T6: `secure_send` の戻りを待っている間に `signal` を中止すると、`secure_send` が戻った後に `secure_cancel` が同じ `requestId` で呼ばれ、ポートは種類 `cancelled` の `SecureTransportError` で失敗する
- [ ] S3-T7: 中止済みの `signal` を渡すと、`invoke` を呼ばずに種類 `cancelled` の `SecureTransportError` で失敗する
- [ ] S3-T8: `secure_send` が種類 X の失敗で終わると、ポートは種類 X の `SecureTransportError` で失敗する（X は S1 の 8 種類の各場合）
- [ ] S3-T9: `secure_send` が種類 `redirect-refused`・`status` 307 で失敗すると、`SecureTransportError` の `status` は 307 である
- [ ] S3-T10: `Channel` に種類 `connection` の `error` が届くと、本文の読み出しは種類 `connection` の `SecureTransportError` で失敗する
- [ ] S3-T11: 呼び出し元が本文を最後まで読まずに読み出しをやめると、`secure_cancel` が同じ `requestId` で呼ばれる

**TS: 製品版のエントリへの登録**

- [ ] S3-E1: 製品版の LLM の準備（BYOK〔Anthropic〕と製品版の解決関数の登録）の後、登録済みの LLM バックエンドは `byok-anthropic` だけである
- [ ] S3-E2: 製品版の LLM の準備の後、`LLM_BACKEND` の無い `env` で解決すると、バックエンドは `byok-anthropic` である
- [ ] S3-E3: 製品版の LLM の準備の後、解決したバックエンドでクライアントを作って `streamBossMessage` を呼ぶと、`invoke` が `secure_send` の名前で、宛先 `anthropic-messages` を引数に呼ばれる
- [ ] S3-E4: 製品版の起動の順序で、LLM の準備は `/api` の振り向けより前に行われる
- [ ] S3-E5: 製品版の web のビルドの入力モジュールに、転送のポートの Tauri 実装とキーの操作の Tauri 実装が含まれる
- [ ] S3-E6: `core-entry.ts` から製品版の解決関数と解決関数の登録関数へ到達でき、`core-entry.bundle.test.ts` が合格する
- [ ] S3-E7: `core-entry.ts` を読み込んだだけでは解決関数は登録されず、`LLM_BACKEND` の無い `env` で解決するとバックエンドは `claude-code` である

**TS: キーの登録・削除の欄（設定画面）**

- [ ] S3-U1: キーの操作を注入した設定画面は、`byok_key_status` の結果に応じて「登録済み」または「未登録」を表示する
- [ ] S3-U2: キーの操作を注入しない設定画面（開発者用の版）には、キーの欄が表示されない
- [ ] S3-U3: キーを入力して登録すると、`byok_key_set` が `provider: "anthropic"` と、入力の前後の空白を除いたキーで呼ばれる
- [ ] S3-U4: 登録に成功すると、入力欄は空になる
- [ ] S3-U5: キーの登録で、グローバルの `fetch` は呼ばれない（キーは `/api` を通らない）
- [ ] S3-U6: キーの登録が成功しても失敗しても、`console` の各メソッドに渡る値に、入力したキーの文字列が含まれない
- [ ] S3-U7: 削除すると、`byok_key_delete` が `provider: "anthropic"` で呼ばれ、「未登録」が表示される
- [ ] S3-U8: 登録が種類 `key-store-failure`・`osStatus` -34018 で失敗すると、欄に OSStatus の番号 -34018 を含むエラーが表示される
- [ ] S3-U9: キーの入力欄の `type` は `password` である
- [ ] S3-U10: 入力欄が空（空白だけを含む）のとき、登録のボタンは押せない

**署名つきのビルド（クリティカル設計決定 9）**

- [ ] S3-G1: 署名つきのビルドのスクリプトは、`APPLE_SIGNING_IDENTITY` が無いと、Tauri のビルドを始めずに 0 以外の終了コードで終わる
- [ ] S3-G2: 署名つきのビルドのスクリプトは、`APPLE_TEAM_ID` が無いと、Tauri のビルドを始めずに 0 以外の終了コードで終わる
- [ ] S3-G3: 署名つきのビルドのスクリプトは、`APPLE_TEAM_ID` が英大文字と数字の 10 文字でない（例: `abc`・`ABCDEFGHIJK`）と、Tauri のビルドを始めずに 0 以外の終了コードで終わる
- [ ] S3-G4: 生成する entitlements の `keychain-access-groups` は `<APPLE_TEAM_ID>.dev.aiboss.app` の 1 要素だけである
- [ ] S3-G5: 生成する entitlements のファイルは `native/tauri-app/target/` の下に置かれる（Git の管理外）
- [ ] S3-G6: 署名つきのビルドは、Tauri のビルドへ `bundle.macOS.entitlements` に生成したファイルを、`bundle.macOS.signingIdentity` に `APPLE_SIGNING_IDENTITY` を指定する
- [ ] S3-G7: `APPLE_PROVISIONING_PROFILE` を指定すると、Tauri のビルドへ `bundle.macOS.files` の `embedded.provisionprofile` としてそのパスを指定する

**監査・文書・品質ゲート**

- [ ] S3-A1: キーが出うる出力の経路（5 つのコマンドの戻り値・失敗の値・`Channel`・`console` への出力・画面の表示・例外の文言）を実装時に全数監査し、結果（経路ごとにキーが現れない根拠）を PR 本文に記載している（要人間判定）
- [ ] S3-D1: `docs/features/llm-provider-abstraction.md` のスライス表の S2 の行に、解決関数の注入口と呼び出し元の置き換えが #581 S3 で済んだ旨が書かれている
- [ ] S3-D2: `docs/features/tauri-in-app-runtime.md` の受入基準（S2）の「製品版の web のエントリを読み込んだ後も、登録済みの LLM バックエンドは 0 件」の項に、#581 S3 で置き換えた旨の注記がある
- [ ] S3-D3: `CLAUDE.md` の「よく使うコマンド」に署名つきのビルドのコマンドがある
- [ ] S3-D4: `docs/features/llm-provider-abstraction.md` のクリティカル設計決定 5 に、#582 S2 に残るもの（製品版の解決関数を保存した選択から決める関数へ差し替えること）が書かれている
- [ ] S3-Q1: `npm run lint` が合格する
- [ ] S3-Q2: `npm run typecheck` が合格する
- [ ] S3-Q3: `npm test` が合格する
- [ ] S3-Q4: `npm run test:tz` が合格する
- [ ] S3-Q5: `npm run test:rust` が合格する
- [ ] S3-Q6: `npm run test:tauri` が合格する
- [ ] S3-Q7: `npm run test:tauri-db` が合格する

## 手動の確認手順（S3）

オーナーが実機（macOS）で行う。**実キーを扱うのはこの手順だけ**で、自動テストは実キー・実 API を使わない。結果（各手順の合否と、失敗時の画面の表示・OSStatus の番号）を #581 か S3 の PR に記録する。

### 準備: 署名つきのビルド

1. Apple Development の証明書をログインキーチェーンに入れ、チーム ID（10 文字）を確かめる（`security find-identity -v -p codesigning` に証明書が出ること）
2. 次を実行する（値はシェルの環境変数で渡し、リポジトリのファイルに書かない）:
   ```bash
   APPLE_SIGNING_IDENTITY="Apple Development: <名前> (<ID>)" APPLE_TEAM_ID=<チーム ID> npm run build:tauri:signed
   ```
   プロビジョニングプロファイルが要る場合（手順 4 で `-34018` になった場合）は、App ID `dev.aiboss.app`（Keychain Sharing を含む）の macOS 用プロファイルを作り、`APPLE_PROVISIONING_PROFILE=<.provisionprofile のパス>` を足して再ビルドする
3. `codesign -dv --entitlements - native/tauri-app/target/release/bundle/macos/ai-boss.app` で、`TeamIdentifier` がチーム ID であること・entitlements に `keychain-access-groups`（`<チーム ID>.dev.aiboss.app`）があることを確かめる

### 動作確認

4. `.app` を起動し（Node サーバーは起動しない）、設定画面の「API キー（Anthropic）」の欄が「未登録」であることを確かめる。自分の Anthropic の API キーを入力して登録し、「登録済み」になること・入力欄が空になることを確かめる。失敗した場合は表示された種類と OSStatus を記録する（`-34018` なら署名・entitlement・プロファイルの不足）
5. アプリを終了して起動し直し、「登録済み」のままであることを確かめる
6. チャットで話しかけ、ボスの応答が逐次（少しずつ）表示されることを確かめる
7. 長めの応答を頼み、表示の途中で生成停止を押し、表示がそこで止まることを確かめる
8. タスクを 1 件以上登録してから朝会を始め、ボスの開始の発言が表示されることを確かめる（テンプレートの定型文〔LLM が使えないときの固定の文面〕ではなく、登録したタスクの名前か件数に触れた発言であること。判定はオーナーの目視）
9. 夕会を終え、日報の要約が生成されることを確かめる
10. 削除を押し、「未登録」になることを確かめる。チャットで話しかけ、応答が失敗の表示になる（送信されない）ことを確かめる
11. 無効な値（例: `sk-ant-invalid`）を登録してチャットで話しかけ、応答が失敗の表示になることを確かめる（有効性の事前確認はしない。最初の要求の失敗で分かる）。確認の後、削除する
12. （既知の制約の確認・任意）`npm run build:tauri`（未署名）の `.app` でキーを登録すると、OSStatus `-34018` を含む失敗が表示されることを確かめる

### 検査手順（クリティカル設計決定 4「検査手順で示す」）

開発者ツールが使えるデバッグビルド（`APPLE_SIGNING_IDENTITY=… APPLE_TEAM_ID=… npm run build:tauri:signed -- --debug`。生成先は `native/tauri-app/target/debug/bundle/macos/`）で、キーを登録した状態で行う。

13. ウィンドウで右クリック →「要素の詳細を表示」で開発者ツールを開き、コンソールで次を実行し、**すべて失敗する**（キーの値が返らない）ことを確かめる:
    ```js
    for (const cmd of ["byok_key_get", "byok_key_load", "keychain_get", "secure_key_get"]) {
      await window.__TAURI_INTERNALS__.invoke(cmd, { provider: "anthropic" }).then((v) => console.log(cmd, "RETURNED", v), (e) => console.log(cmd, "rejected", e));
    }
    ```
14. 同じコンソールで `await window.__TAURI_INTERNALS__.invoke("byok_key_status", { provider: "anthropic" })` が `true`（真偽値だけ）を返すことを確かめる
15. アプリを終了し、アプリの DB とその付随ファイルにキーが無いことを確かめる（`<キーの先頭 16 文字>` は自分のキーの先頭。コマンドの履歴に残さないよう、実行後にシェルの履歴から消すか、`HISTCONTROL=ignorespace` で先頭に空白を付けて実行する）:
    ```bash
    grep -c -F '<キーの先頭 16 文字>' ~/Library/Application\ Support/dev.aiboss.app/ai-boss.db* ; echo "exit=$?"
    ```
    各ファイルの件数が 0（`exit=1`）であること
16. 開発者ツールのコンソールに、キーの文字列が出ていないことを確かめる（手順 4 の登録以降のログ）

## 仮定（軽微・可逆）

- A1: Rust ライブラリの置き場所は仮に `native/secure-transport/`。#579 S2 で `src-tauri` の位置が決まったら移してよい
- A8: 属性だけの問い合わせに `security-framework` の高レベル API（`passwords`）で足りなければ、低レベル API（`item` モジュールの検索）を使ってよい
- A6: キーチェーンの項目の service 名・account 名は実装で決めてよい（account はプロバイダ名にする）
- A7: `requestId` を呼び出し元が生成する形は親の回答を受けた本仕様の確定時に決めた内部の形であり、Tauri のコマンドの層（S3）で変えてよい
- A5: HTTP クライアント・模擬サーバー・キーを伏せる型のクレートは実装で選んでよい（例: `reqwest`・`secrecy`）
- A2: コマンド名・宛先の名前・エラーの種類の名前は仮で、実装で決めてよい
- A3: `anthropic-version` は現行の `@anthropic-ai/sdk` が送る値 `2023-06-01` に合わせる（`node_modules/@anthropic-ai/sdk` で確認）
- A4: 応答の本文は Rust ではバイト列のまま中継し、SSE の区切りも解釈しない（区切りの復元は S2 の TS 側）
- A9（S2）: 能力の項目の名前（`runsOwnToolLoop`・`supportsToolChoice`・`limitsResponseLength`）・参照関数の名前（`getLlmBackendCapabilities`）・バックエンドの名前（`byok-anthropic`）・登録関数の名前（`registerByokAnthropicBackend`）・ポートとエラーの型の名前は仮で、実装で決めてよい（#582 の仮定 A2 はこの命名に合わせる）
- A10（S2）: 新規のモジュールは仮に `server/src/llm/secure-transport-port.ts`（ポートの型と失敗の型）・`server/src/llm/backends/byok-anthropic-backend.ts`（Anthropic Messages の形式の変換器・BYOK〔Anthropic〕のバックエンド・登録関数）に置く。SSE の区切りの復元を #582 の OpenAI の変換器と共有する部品に切り出すかは実装で決めてよい
- A11（S2）: レジストリの鍵の型と `LLM_BACKEND` の検証に使う型の分け方（`config.ts` の `LlmBackend` を環境変数の許容値のまま残し、レジストリ側に広い型を新設する、またはその逆）は実装で決めてよい。守るのは受入基準（`LLM_BACKEND=byok-anthropic` を拒否する）だけ
- A12（S2）: `BossLlmClient` の BYOK（Anthropic）のバリアントはポートを持つ（キーは持たない）。形は実装で決めてよい
- A13（S2）: `retry-after` の解釈を SDK に依存しない関数へ切り出し、`backends/api-backend.ts` の `getApiRetryAfterMs` から使ってよい（`api` の振る舞いは変えない。`api-backend.test.ts` が合格すること）
- A14（S2）: 要求本文の JSON の項目の順序は問わない。`system`・`tools`・`tool_choice` は呼び出し元が指定しなかったとき項目ごと省く（`null` を入れない）
- A15（S2）: `citations`・サーバー側のツール（`server_tool_use` 等）のブロックは現行のボスが使わないため、S2 のクライアントは `content` に入れない（`rawContent` へは `content_block_start` で受け取った値のまま残す）
- A16（S3）: 選択の解決関数のレジストリは `llm/` に置き、関数の名前（登録・解決・既定の開発者用・製品版）は実装で決めてよい。テストの後始末のためのリセット関数を置いてよい（`resetLlmBackendRegistryForTest` と同じ扱い）
- A17（S3）: `Channel` で送る本文の断片は JSON の数値の配列（`number[]`）で表す（`end`・`error` と同じ `Channel` で区別できる形にするため。断片の大きさは LLM の応答の SSE で数 KB 程度）。効率が問題になったら `InvokeResponseBody::Raw` へ変えてよい
- A18（S3）: 器のコマンドの状態（宛先の表・保管）を注入できる組み立て関数を置き、製品版は `DestinationTable::production()` と `KeychainKeyStore::new()`、テストは模擬の表とメモリの保管を使う。組み立て関数の名前と置き場所は実装で決めてよい
- A19（S3）: 無効なキー（Anthropic が 401 を返す）・未登録のキー（`key-not-registered`）での失敗は、S2 の分類（再試行不可）のまま既存の LLM の失敗の経路（チャットの失敗の表示・朝会の開始の発言などのテンプレートへの退避）に乗せる。区別した案内は作らない（親の決定）
- A20（S3）: 製品版のモデルは、#582 S2 の選択の画面ができるまで設定の `model`（既定 `claude-sonnet-5`）とする。設定画面の自由入力で一覧に無いモデルを入れた場合は、#582 S1 の送信前の関門が送信前に止める（親の決定）
- A21（S3）: 設定画面のキーの欄の見出し・文言（「API キー（Anthropic）」「登録済み」「未登録」「登録」「削除」）は実装で決めてよい。キーの欄は設定の保存のフォームとは別のフォームにし、設定の保存のボタンでキーを送らない
- A22（S3）: 転送のポートの Tauri 実装が、`secure_send` の失敗の値が想定外の形（`kind` が 10 種類のどれでもない等）だったときは、種類 `connection` の `SecureTransportError` として扱う（契約の食い違いは TS と Rust の両方のテストで名前を固定して防ぐ）
- A23（S3）: macOS で `keychain-access-groups` を使うのにプロビジョニングプロファイルが要るかは未実測。スクリプトはプロファイルを任意で受け取れるようにし、要否はオーナーの手動の確認（手順 2・4）で決まる
- A24（S3）: 署名つきのビルドのスクリプトは `scripts/` に置き、npm スクリプト名は `build:tauri:signed` とする。スクリプトに渡した追加の引数（例: `--debug`）は Tauri のビルドへそのまま渡す
- A25（S3）: キーのコマンドの文字列からプロバイダへの変換は `anthropic` だけを許す専用の変換にする（ライブラリの `Provider` は `OpenAi` も持つが、コマンドの層からは到達させない）
- A26（S3）: チャットは、クライアントの初期化の失敗を 1 ターン分の材料を読む前に 500 で返す既存の順序を保つため、バックエンドはクライアントを作る時点の設定のスナップショットで、モデルは 1 ターン分のスナップショットで解決関数を呼ぶ（S3 の 2 つの解決関数はバックエンドを設定から決めないため組が崩れない）。保存した選択からバックエンドを決める #582 S2 で、クライアントを作る位置を 1 ターン分のスナップショットの後へ移す（#582 のクリティカル設計決定 5）
- A27（S3）: 署名つきのビルドの組み立てのテストは Node の組み込みのテストランナー（`node --test`）で書き、`npm run test:scripts` として `npm test` に含める（`scripts/` はどの npm ワークスペースにも属さないため）
