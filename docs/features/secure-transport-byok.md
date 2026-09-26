# 秘密情報を扱う Rust 通信層と BYOK キーの保管（キーチェーン）

> Issue #581。**草案（2026-09-26）**。論点 Q1〜Q5 は未確定で、各節の「推奨」は親・オーナーの回答を受けて確定させる（★はオーナー判断の論点）。確定までは下流（`/create-ticket`）へ渡さない。

## 概要

製品版（Tauri 2 アプリ）で、BYOK の API キーを端末の OS のセキュアストレージ（macOS / iOS はキーチェーン）に保管し、キーを付与したプロバイダへの HTTP 送信（ストリーミングを含む）を **Rust の薄い通信層**から行う。キーは WebView に返さない。プロンプトの組み立て・tool use の処理は TypeScript のコアに残す（[ADR 0011](../adr/0011-productization-architecture.md) 決定 6・10・15・16、[ADR 0002](../adr/0002-api-key-and-llm-call-path.md) 改訂の決定 1〜4・7）。

## 背景・目的

- 製品版のコアには LLM バックエンドが 1 つも登録されていない（#579 のオーナー決定 Q4-c）。**製品版で LLM を使う流れ（朝会・夕会・チャット・通知文面）は本機能が済むまで動かない**。#579 の完了条件「朝会・夕会が Tauri で動く」の確認も本機能の後になる。
- 現行の `api` バックエンドは `@anthropic-ai/sdk` を TS の中で動かし、キーを環境変数から読む。WebView で使うとキーが WebView に載る（ADR 0002 改訂の決定 3 に反する）。
- #576 の spike はキーチェーンの読み書きを Rust（`security-framework`）で行ったが、**読み出したキーを WebView へ返し**、WebView から `@tauri-apps/plugin-http` で送った（`anthropic-dangerous-direct-browser-access` ヘッダが必要だった）。製品ではこの形を採らない（spike の README「詰まった点と回避策」の 3 も Rust 側からの送信を推奨）。

## ユーザーストーリー

- 製品版の利用者として、自分の Claude（Anthropic）の API キーを一度登録すれば、以後はキーを意識せずにボスとの対話・朝会・夕会を使いたい。キーが画面のコードや保存データから読み出されない安心がほしい。
- 製品版の利用者として、登録したキーを削除（差し替え）したい。

## 実コードの実測（2026-09-26・`main` 3b65393／#594 ブランチ 18cac97／`spike/ios-tauri`）

仕様の決定はこの実測に拠る。食い違ったらコードが正。

| 対象 | 実測 |
|---|---|
| ファサードの呼び出し口 | `llm/claude-client.ts` の `streamBossMessage`（チャット・通知文面）と `createBossMessage`／`requestVerdict`（ダッシュボードのコメント・セッション要約・会議の開始文・夕会の要約抽出）の 2 系統。呼び出し元は 6 モジュール（`chat-messages-route.ts`・`notification-body.ts`・`boss-comment.ts`・`session-summary.ts`・`meeting-opening.ts`・`extract-evening-summary.ts`） |
| リクエストの形 | `ClaudeMessageRequest` は Anthropic Messages API の型（`Anthropic.MessageParam`・`Anthropic.Tool`・`ThinkingConfigParam`・`OutputConfig`）を **型だけ** import して使う。チャットは `thinking: { type: "adaptive" }`・`outputConfig: { effort: "low" }`、他は `thinking: { type: "disabled" }` |
| tool use のループ | `api` では TS のファサード（`streamBossMessage`）が最大 `MAX_TOOL_ROUNDS = 5` ラウンド回す。**thinking を使うターンは、アシスタントの元のブロック（`thinking` と署名）を `rawContent` として保持して次ラウンドにそのまま送り返す必要がある**（Issue #117。落とすと次ラウンドが拒否される） |
| 中止とタイムアウト | ファサードの `runWithTimeoutAndRetry` が `AbortSignal` を 1 ラウンドごとにバックエンドへ渡す（既定 120 秒・2 回まで再試行・副作用〔テキスト配信・ツール実行〕の後は再試行しない）。生成停止（#254）も同じ `signal` を使う |
| エラーの分類 | `api` の `classifyApiError` は SDK の `APIError` の `status`（408・429・5xx は再試行、他の 4xx は再試行しない）と `retry-after` ヘッダで判定する。**SDK の型に依存するため、SDK を使わない経路ではステータスと `retry-after` を別の形で受け取る必要がある** |
| バックエンドの注入（#594・並行実装中） | `llm/llm-backend-registry.ts` の `registerLlmBackend(name, { createClient, streamRound, createRound, classifyError? })` に、エントリが実装を登録する。製品版のコアのエントリ（`core-entry.ts`）は何も登録しない。**バックエンド名 `LlmBackend` と `BossLlmClient` は `"api" \| "claude-code"` の閉じた型**で、新しいバックエンドを足すにはこの 2 つを広げる必要がある |
| #594 のバンドル検査 | 製品版のコアのバンドルに `@anthropic-ai/sdk` が含まれないことを受入基準で固定している（SDK は資格情報読み込みで `import('node:fs')` を持つ）。**したがって本機能の TS 側でも SDK を使えない**（SDK に独自の `fetch` を渡す形も採れない） |
| spike のキーチェーン | `security_framework::passwords::{set,get,delete}_generic_password`（service `dev.aiboss.spike.tauri`・account `anthropic-api-key`）を Tauri コマンド 3 つで公開。**`keychain_get` はキーの値を WebView へ返す**。アクセス制御（アクセシビリティ・同期可否）は指定していない |
| `security-framework` 3.7 の既定 | `PasswordOptions` は `use_protected_keychain()`（データ保護キーチェーン。「macOS 以外では常に真」）・`set_access_synchronized`・`set_access_control_options`・`set_access_group` を持つ。**macOS で `use_protected_keychain()` を呼ばない既定は、従来のファイル型キーチェーン（ログインキーチェーン）になる**（docs.rs で確認。挙動の実測はしていない） |
| 検証の実行環境 | CI は無い（`.github/workflows` なし）。品質ゲートは `npm run lint`・`typecheck`・`test`・`test:tz` だけで、Rust のテストはまだどこからも実行されない。ローカルは `rustc 1.98.1`・`cargo 1.98.1` |
| Tauri の器 | `main` に `src-tauri` はまだ無い（#579 S2 で作る） |

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] 利用者は Anthropic の API キーを登録でき、キーは OS のセキュアストレージ（macOS はキーチェーン）に保管される
- [ ] 利用者は登録済みのキーを削除できる
- [ ] 画面はキーの登録の有無だけを知ることができ、キーの値を読み出す手段は WebView に無い
- [ ] TS のコアの LLM 呼び出し（ストリーミング・非ストリーミング・tool use のループ・生成停止）が、Rust の通信層を通って Anthropic の Messages API へ送られる
- [ ] Rust の通信層は、あらかじめ決めた送信先（Anthropic の Messages API）にだけ送り、送信時にキーを付与する
- [ ] キーは WebView・ログ・DB のいずれにも出ない
- [ ] 製品版のエントリに BYOK（Anthropic）のバックエンドが登録され、製品版の朝会・夕会・チャットが動く

## 非機能要件

- セキュリティ: WebView 側のコードが侵害されても、保管済みのキーの値は読み出せない（ADR 0002 改訂の代替案の却下理由）。侵害された WebView ができるのは「決められた送信先へ、キー付きで送らせる」ことまでであり、任意の宛先へキーを送らせることはできない
- ログ: キーをログに出さない。失敗時に残すのはエラーの種類（クラス名・HTTP ステータス）まで（ADR 0002 決定 4・改訂の決定 7）
- 外部送信: 送信先は ADR 0001 改訂で許可した範囲（選択したプロバイダ）に限る。BYOK の推論を中継サーバーへ流さない・黙って経路を切り替えない（ADR 0001 改訂の帰結・ADR 0003 決定 9）

## 技術的な制約・方針

- 使用技術: Rust（Tauri 2 のコマンド・`tauri::ipc::Channel`・HTTP クライアント）。TS 側は既存の `server/src/llm/` のファサードと #594 のレジストリに接続する
- 前提（別 Issue・並行）: Tauri の器は #579 S2、製品版の DB は #580 S2、プロバイダの抽象化（OpenAI・許可モデル）は #582、中継サーバーは #583、アカウント・ライセンスは #584。**本機能はこれらを実装しない**
- 依存関係（着手の順序）: S1（Rust ライブラリ）は TS に触れないため #594 を待たずに着手できる。S2（TS 側）は #594（#579 S1。レジストリ）のマージ後。**Tauri コマンドへの配線と製品版での動作確認（S3）は #579 S2 の器ができてから**。製品版の朝会・夕会・チャットの実動作確認は #580 S2（製品版の DB）の後（生成のルートが LLM を呼ぶ前に DB を読むため。#579 仕様のクリティカル設計決定 1「未検証点の扱い」と同じ理由）
- 既存コードとの関係: 開発者用の版（`api`・`claude-code`・`server/.env`）は変えない（ADR 0002 改訂の決定 5）

## クリティカル設計決定（草案・未確定）

### 1. キーの保管の実装（Q1 ★）

- **推奨（未確定）**: **`security-framework` を使った自前の実装**を通信層の中に置く（spike の約 30 行の延長）。属性は次のとおり:
  - **データ保護キーチェーンを使う**（macOS でも `use_protected_keychain()`。iOS と同じ仕組みに揃える）
  - **アクセシビリティは「初回ロック解除後・この端末のみ」**（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 相当）。端末ロック中でも読める（デスクトップの毎分の催促が、画面ロック中に通知文面を LLM で作るため）。**iCloud キーチェーンで同期せず、バックアップにも含めない**（別の端末では登録し直す）
  - キーの項目は「プロバイダごとに 1 件」（S1 は Anthropic の 1 件だけ）
- **判断材料**: 「代替案」の表と、「論点への質問」Q1 を参照
- **代替案**:
  - `keyring` クレート（4.x。macOS・Windows・iOS・Android の資格情報ストアを 1 つの API で扱う）またはそれを包むコミュニティの Tauri プラグイン — Windows・Android まで同じ API で済む。ただし高レベルの API ではアクセシビリティ・同期可否を指定できず（細かく制御するなら `keyring-core` を直接使う、とドキュメント自身が案内している）、macOS でどちらのキーチェーンに入るかを自分で決められない
  - `tauri-plugin-stronghold` — OS のセキュアストレージではなく、パスワードで暗号化したファイル。ADR 0002 改訂の決定 1（OS が提供するセキュアストレージ）に合わない
- **影響範囲**: Rust の通信層（新規）。Windows（DPAPI）・Android（Keystore）は後続リリース・別スライスで同じポート（保管の抽象）の実装を足す

### 2. TS ⇔ Rust の境界（Q2）

- **推奨（未確定）**: **Rust は「宛先を名前で指定する、秘密情報を付与する HTTP 転送」だけを担い、プロバイダの形式（SSE のイベント・tool use・thinking）は TS が解釈する**。
  - Rust のコマンド（名前は仮）: `secure_send({ destination: "anthropic-messages", body }, channel)` → 応答のステータスと許可したヘッダ（`retry-after`・`request-id`・`content-type`）を返し、本文のバイト列を `Channel` で逐次送る。`secure_cancel(requestId)` で送信中の要求を中止する。`byok_key_set(provider, key)`・`byok_key_delete(provider)`・`byok_key_status(provider) -> bool`。**キーの値を返すコマンドは作らない**
  - TS 側: SDK を使わない Anthropic Messages のクライアント（リクエスト本文の組み立てと SSE の解釈。`text`・`tool_use`〔`input_json_delta`〕・`thinking`〔`signature_delta`〕を組み立て、`rawContent` を保持）を、**転送のポート**（Tauri の `invoke` を直接触らない関数型の境界）の上に作り、#594 のレジストリへ BYOK（Anthropic）のバックエンドとして登録する。`classifyError` はステータスと `retry-after` から判定する（`isRetryableApiError` と同じ規則を SDK なしで）
  - 生成停止: ファサードの `AbortSignal` が中止されたら TS が `secure_cancel` を呼び、Rust は HTTP 要求を切る
- **理由**: ADR 0011 決定 6（通信層は送受信と秘密情報の付与だけを担い、プロンプトの組み立て・tool use の処理は TS）にそのまま沿う。形式の解釈を TS に置くと、#582（OpenAI との差の吸収）も TS だけで済み、Rust にプロバイダの知識が二重に入らない。`Channel` は Tauri 2 が順序つきのストリーミング用に用意している仕組み
- **代替案**:
  - (B) Rust が SSE を解釈して、テキストの差分と最終メッセージを TS へ渡す — Rust にプロバイダの形式の知識が入り、#582 で OpenAI の形式を Rust と TS の両方に書くことになる。thinking の署名の保持も Rust 側の責務になる
  - (C) `@anthropic-ai/sdk` に Rust 経由の `fetch` を渡す — #594 の受入基準（製品版のコアに SDK を入れない）に反する
- **影響範囲**: `llm/claude-client.ts`・`config.ts`（`LlmBackend`・`BossLlmClient` の閉じた型を広げる）・#594 のレジストリ・製品版のエントリ（**クリティカル箇所: Claude API 連携・API キーの取り扱い。変更時は人間レビュー必須**）

### 3. 送る先と付与する資格情報の範囲（Q3）

- **推奨（未確定）**: **本機能は BYOK の Anthropic 直送だけ**（宛先 1 つ・`POST https://api.anthropic.com/v1/messages`・`x-api-key` と `anthropic-version` を Rust が付与）。宛先は Rust 側の固定の表で持ち、TS は宛先の名前しか指定できない。TS から渡された `x-api-key`・`authorization`・`anthropic-version` のヘッダは Rust が捨てる。
  - OpenAI の宛先と鍵の項目は #582、中継サーバーの宛先とライセンストークンの付与は #583・#584 が、この表と保管のポートに 1 行ずつ足す
- **理由**: 中継サーバーの認証方式（ライセンストークンの形・取得と更新）は #584 で未決。先に作ると推測で作ることになる（YAGNI）。宛先の表と保管のポートを「名前 → URL・付与する資格情報」の形にしておけば後から足せる
- **代替案**: ライセンストークンの保管と中継サーバー向けの付与まで本機能で作る — #583・#584 の設計が固まる前に通信層の契約を決めることになる

### 4. 「秘密情報が出ない」の担保の方法（Q4）

- **推奨（未確定）**: テストで固定する部分と、検査手順で示す部分を分ける。
  - **Rust のテスト（`cargo test`）で固定**: 保管はポート（トレイト）にし、テストはメモリ上の実装で行う。送信は手元の模擬 HTTP サーバーに向け、(a) 付与されたヘッダ、(b) TS から渡された認証ヘッダが捨てられること、(c) 宛先の表に無い名前を拒否すること、(d) 本文が分割されたまま順に届くこと、(e) 中止で接続が切れること、(f) 応答・エラーの値と `Debug`／`Display` の文字列にキーが含まれないこと、を確かめる。キーは表示時に伏せる型（例: `secrecy` クレートの `SecretString`）で持つ
  - **TS のテスト（vitest）で固定**: 転送のポートを模擬に差し替え、SSE の解釈（text・tool_use・thinking と署名・`rawContent`）・中止・エラーの分類を確かめる。TS 側の型にキーを持つ場所が無いこと
  - **実キーチェーンの結合テスト**: macOS で実際のキーチェーンへ書く・読む・消すテストは、テスト専用の service 名で行い、**既定の `npm test` からは外して手動実行**にする（キーチェーンのアクセス許可ダイアログ・署名の要否に左右されるため）
  - **検査手順で示す（S3）**: Tauri アプリの開発者ツールから、登録済みのキーの値を返すコマンドが存在しないこと・アプリの DB にキーが無いことを確かめる手順を残す
  - **品質ゲートへの組み込み**: `cargo test` を npm のスクリプト（例: `npm run test:rust`）から呼べるようにする。既定の `npm test` に含めるかは Q4 で決める
- **代替案**: 実キーチェーンの結合テストを既定の `npm test` に含める — 開発機の状態（ログイン・署名）でテストが揺れる。CI も無い

## 機能全体の設計（草案）

### アーキテクチャ決定

- Rust の通信層は、**Tauri に依存しないライブラリ（保管のポート・宛先の表・転送）**と、**それを Tauri のコマンドとして公開する薄い層**に分ける。ライブラリは #579 S2 の器が無くても `cargo test` で検証できる。置き場所は仮に `native/secure-transport/`（#579 S2 の `src-tauri` から path 依存で使う）
- TS 側の BYOK（Anthropic）のバックエンドは、Tauri の `invoke` を直接呼ばず「転送のポート」を受け取る。製品版のエントリが Tauri 実装のポートを注入する。これで vitest から模擬のポートで検証でき、#594 のバンドル検査（Node 依存・SDK が入らない）もそのまま通る

### IF / API（S1 で固定する境界・名前は仮）

- 宛先の名前: `"anthropic-messages"` のみ（S1）
- 送信の要求: `{ requestId, destination, body: string /* JSON */ }` → 応答の頭: `{ status: number, headers: { "retry-after"?: string, "request-id"?: string, "content-type"?: string } }`、本文: バイト列の断片の列（終端・エラーを含む）
- 失敗の種類: 宛先不明／キー未登録／接続失敗／中止（HTTP のステータスは応答の頭で返す）。**エラーの値にキー・要求本文・応答本文を含めない**
- キーの操作: 登録（プロバイダ・値）／削除（プロバイダ）／登録の有無（プロバイダ → 真偽値）

### 実装計画（S1 のチケット分解の見通し）

1. Rust ライブラリ: 保管のポートとキーチェーン実装・メモリ実装
2. Rust ライブラリ: 宛先の表と、資格情報を付与するストリーミング転送（中止つき）
3. `cargo test` を npm のスクリプトから実行できるようにする

## スライス（出荷の単位）（草案・Q5 で確定）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | Tauri に依存しない Rust の通信層ライブラリ。保管のポート（macOS キーチェーン実装とテスト用のメモリ実装）・宛先の表（Anthropic Messages のみ）・キーを付与するストリーミング転送と中止。`cargo test` で、付与するヘッダ・認証ヘッダの除去・宛先外の拒否・逐次の中継・中止・キーの非露出を固定する | 8-12 | #594 のマージを待たずに着手できる（TS に触れない）。これだけで、#576 で未検証だった「Rust からのストリーミング転送」と「キーを返さない保管」の成立が確かめられる |
| S2 | TS 側: SDK を使わない Anthropic Messages のクライアント（SSE の解釈・thinking の署名の保持・tool use のループへの接続・エラーの分類）を転送のポートの上に作り、#594 のレジストリへ BYOK（Anthropic）として登録できる形にする（`LlmBackend`・`BossLlmClient` の拡張）。vitest で模擬のポートを使って固定する | 8-12 | S1 と #594 がマージされてから |
| S3 | #579 S2 の器への配線: Tauri のコマンドと `Channel`・capability、製品版のエントリへの登録、キーの登録・削除の画面、検査手順。製品版でのチャット（SSE・生成停止）・朝会・夕会の動作確認 | 8-15 | S2 と #579 S2 がマージされてから（動作確認は #580 S2 の後） |

実装対象: S1

## やらないこと

- OpenAI への送信と OpenAI のキーの保管、BYOK で許可するモデルの範囲（理由: #582 の範囲）
- 中継サーバーへの送信とライセンストークンの保管・付与（理由: #583・#584 の範囲。認証方式が未決）
- プラン込みと BYOK の切り替えの画面・選択の保存（理由: #582〜#584 で扱う。本機能の製品版の LLM は BYOK の Anthropic だけ）
- Windows（DPAPI）・Android（Keystore）のキーの保管（理由: Windows は ADR 0011 決定 19 で後続リリース。Android は iOS / Android のビルドの後続）
- iOS のビルドと実機での確認（キーチェーンの永続性・バックアップの扱いの実機確認を含む）（理由: ADR 0011「未決」節で製品化の後のフェーズ）
- Tauri の器・DB 層（理由: #579 S2・#580）
- 開発者用の版の `api`・`claude-code` バックエンドと `server/.env` の変更（理由: ADR 0002 改訂の決定 5）
- 登録時のキーの有効性の事前確認（テスト送信）（理由: 未決。必要なら S3 の論点）

## 受入基準（S1・草案）

- [ ] 保管のポートにキーを登録すると、登録の有無を問い合わせた結果が真になる（メモリ実装は既定のテストで、キーチェーン実装は手動実行の結合テストで確かめる）
- [ ] 登録したキーを削除すると、登録の有無を問い合わせた結果が偽になる（同上）
- [ ] キーが未登録のとき削除しても失敗しない
- [ ] 通信層の公開 API に、保管したキーの値を返す関数が無い
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求は `POST /v1/messages` で、`x-api-key` に登録したキー・`anthropic-version` に既定の版が付いている
- [ ] 要求に呼び出し元が `x-api-key`・`authorization` を含めても、模擬サーバーが受けた要求のそれらの値は通信層が付与したものだけである
- [ ] 宛先の表に無い名前を指定すると、送信せずに「宛先不明」で失敗する
- [ ] キーが未登録のとき送ると、送信せずに「キー未登録」で失敗する
- [ ] 模擬サーバーが本文を複数の断片に分けて時間差で返すと、呼び出し元は最初の断片を最後の断片より前に受け取る
- [ ] 模擬サーバーが返した断片を連結したものは、返した本文と一致する
- [ ] 応答の頭に、ステータスと `retry-after` の値が入る
- [ ] 送信中に中止すると、模擬サーバー側で接続が切れ、呼び出し元は「中止」で終わる
- [ ] 失敗の値の `Debug` と `Display` の文字列、応答の頭の文字列のいずれにも、登録したキーの文字列が含まれない
- [ ] `npm run lint`・`npm run typecheck`・`npm test`・`npm run test:tz` と、Rust のテストの実行（Q4 で決める npm スクリプト）が合格する

## 仮定（軽微・可逆）

- A1: Rust ライブラリの置き場所は仮に `native/secure-transport/`。#579 S2 で `src-tauri` の位置が決まったら移してよい
- A2: コマンド名・宛先の名前・エラーの種類の名前は仮で、実装で決めてよい
- A3: `anthropic-version` の既定値は、現行の `@anthropic-ai/sdk` が送る値に合わせる
- A4: 応答の本文は Rust ではバイト列のまま中継し、SSE の区切りも解釈しない（区切りの復元は S2 の TS 側）
