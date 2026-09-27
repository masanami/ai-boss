# LLM プロバイダの抽象化（Anthropic / OpenAI・BYOK で許可するモデル）

> Issue #582。**草案（2026-09-27）**。論点 Q1〜Q6 は未確定で、親（flywheel エージェント）の回答とオーナーの決定（★ の論点）を受けて確定する。未確定の箇所は「（未確定・Qn）」と書く。

## 概要

製品版の BYOK で、Anthropic と OpenAI のどちらのキーでもボスとの対話・朝会・夕会・ツール呼び出しが動くようにする。プロバイダの形式の差（tool use・ストリーミング・thinking／reasoning・エラー）は TypeScript のコアで吸収し、Rust の通信層（#581）には OpenAI の宛先と鍵の項目を 1 行ずつ足すだけにする。あわせて、BYOK で選べるモデルの範囲と、[ADR 0003](../adr/0003-llm-backend-isolation.md) の旧決定 5〜9 を製品版でどう読むかを決める（[ADR 0011](../adr/0011-productization-architecture.md) 決定 8〜10）。

## 背景・目的

- 製品版は API を前提にする。既定はプラン込み（中継サーバー・#583）、選択で BYOK（Anthropic または OpenAI をアプリから直接呼ぶ）（ADR 0011 決定 8〜10）。
- 現行のコアは **Anthropic Messages API の形を共通の言語として使っている**。呼び出し元 6 モジュールは `Anthropic.MessageParam`・`Anthropic.Tool`・`ThinkingConfigParam`・`OutputConfig` の形でリクエストを組み立て、ツールのループは Anthropic の `tool_result` を積む（下の「実コードの実測」）。OpenAI を足すには、この形から OpenAI の形へ変換する層が要る。
- #581 の仕様（クリティカル設計決定 2）で、Rust は送受信と秘密情報の付与だけを担い、プロバイダの形式の解釈は TS に置くと決めた。本機能の変換はすべて TS 側に入る。
- ADR レビューで残した論点（medium）: `claude-code` を開発者用に限った後、ADR 0003 の旧決定 5〜9 のどれが製品版にも効くか。ADR 0003 改訂の帰結は「5〜9 を新しい経路にもそのまま適用する」と書くが、5〜8 は Agent SDK を前提にした手段で、API を直接呼ぶ経路には字義どおりには当てはまらない。

## ユーザーストーリー

- 製品版の利用者として、自分が持っている OpenAI の API キーを登録すれば、Anthropic のキーが無くてもボスとの対話・朝会・夕会を使いたい。
- 製品版の利用者として、BYOK で使うモデルを、ボスとして動作が確かめられた候補の中から選びたい。
- 製品版の利用者として、自分の選んだプロバイダ・モデル・課金経路が、失敗時に黙って別のものへ切り替わらないでほしい。

## 実コードの実測（2026-09-27・`main` 31b76fb）

仕様の決定はこの実測に拠る。食い違ったらコードが正。TS のパスは `server/src/` を省く。

| 対象 | 実測 |
|---|---|
| ファサードの型 | `llm/claude-client.ts` の `ClaudeMessageRequest` は `messages: Anthropic.MessageParam[]`・`tools?: Anthropic.Tool[]`・`toolChoice?: Anthropic.ToolChoice`・`thinking?`・`outputConfig?`。SDK は **型だけ** import（`import type`）。`BossLlmMessage` は `content`（`text`・`tool_use` のみ）と任意の `rawContent?: unknown[]` |
| tool use のループ | `streamBossMessage` が最大 `MAX_TOOL_ROUNDS = 5` 回す。`tool_use` があれば `rawContent ?? content` を assistant として積み、`buildToolResultMessage` で Anthropic の `tool_result`（`is_error` つき）を user として積む。**ループを回すかは `client.backend === "claude-code"` の名前で分岐**している（claude-client.ts:573。コード中のコメント自身が「#581/#582 のどちらかが `ownsToolLoop` 等へ移す」と後送りを明記） |
| 呼び出し元のバックエンド名の分岐 | `reports/extract-evening-summary.ts:161` は **`backend === "api"` のときだけ `toolChoice` でツール呼び出しを強制**する。`dashboard/boss-comment.ts:67・134` は `backend === "claude-code"` のときだけ短文の指示と全角 80 字の検証を足す。**新しいバックエンド名を足すと、夕会の要約抽出でツール呼び出しが強制されなくなる**（`"api"` と一致しないため） |
| リクエストの使い方 | チャットだけ `thinking: { type: "adaptive" }`・`outputConfig: { effort: "low" }`・`maxTokens` 既定 16000・`tools: BOSS_TOOLS`（7 ツール）。ダッシュボードのひとこと・通知文面は `maxTokens: 150`、セッション要約は 300、会議の開始文も小さい値で、いずれも `thinking: { type: "disabled" }`。夕会の要約抽出は `submit_evening_summary` の強制呼び出し。**`cache_control`・画像・文書のブロックは使っていない**（履歴は文字列の本文だけ） |
| ツールの定義 | `boss/boss-tools.ts` の `BOSS_TOOLS: Anthropic.Tool[]`（`task-tools.ts` 等の `input_schema` が単一ソース）。任意項目を `required` に入れておらず、`committed_start_at` は `type: ["string", "null"]` |
| テンプレートへの退避 | ダッシュボードのひとこと・通知文面・会議の開始文は、失敗・空応答で固定の文面へ退避する。チャットは 500、夕会の要約抽出は失敗の結果を返す（ADR 0003 決定 9 の既存の形） |
| エラーの分類 | `backends/api-backend.ts` の `classifyApiError` は SDK の `APIError` の `status`（408・429・5xx は再試行）と `retry-after` で判定。ファサードの `runWithTimeoutAndRetry` は `classifyError` があるときだけ使う |
| バックエンドの登録 | `llm/llm-backend-registry.ts` の `registerLlmBackend(name, { createClient, streamRound, createRound, classifyError? })`。`LlmBackend`（`config.ts`）と `BossLlmClient` は `"api" \| "claude-code"` の閉じた型。バックエンドは環境変数 `LLM_BACKEND` から選ばれる（`resolveLlmBackend(env)`） |
| モデルの設定 | `settings` の `model` キー（`settings-validation.ts` は空でない文字列なら何でも通す）。画面は自由入力の `<input>`（`web/src/SettingsView.tsx:341`）。既定は `DEFAULT_MODEL = "claude-sonnet-5"` |
| 製品版のコアのバンドル | `core-entry.bundle.test.ts` が「外部の指定子なし」と `@anthropic-ai/sdk`・Agent SDK の混入禁止を固定。**OpenAI の npm SDK もコアに入れられない**（外部の指定子になる） |
| Rust の通信層（#581 S1・#616 でマージ済み） | `destination.rs` の宛先の表は `anthropic-messages` の 1 行、`Credential` は `AnthropicApiKey` だけ。`key_store.rs` の `Provider` は `Anthropic` だけ（account `"anthropic"`）。`transport.rs` は `x-api-key`・`authorization`・`anthropic-version` を呼び出し元から受けても捨て、応答ヘッダは `retry-after`・`request-id`・`content-type` だけを通す |
| #581 の後続スライス | S2（TS 側の SDK を使わない Anthropic クライアント・転送のポート・BYOK（Anthropic）の登録）は**未起票**。S3（Tauri のコマンド・製品版のエントリへの登録・キーの画面）は #579 S2 の器の後。#579 S2 も未着手 |

### OpenAI の公式ドキュメントで確かめたこと（2026-09-27 に developers.openai.com を参照。実 API は呼んでいない）

- Responses API が新規の推奨。Chat Completions も引き続き提供される。
- **Responses は既定で応答を OpenAI 側に保存する**（Chat Completions も新しいアカウントでは既定で保存）。保存させないには `store: false` を指定する。
- `store: false` のとき、reasoning の項目は `encrypted_content` を持ち、**tool 呼び出しをまたいで reasoning を保つには、直前の利用者の発言以降の reasoning・function_call・function_call_output の項目をすべて送り返す**必要がある（Anthropic の thinking の署名の送り返しに当たる）。
- `reasoning.effort` は `none`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max`。**対応はモデルごとに違い**、例えば `gpt-6-astra` は `none` を受け付けず 400 を返す。
- `max_output_tokens` は reasoning のトークンも含む。使い切ると `status: "incomplete"`（`incomplete_details.reason: "max_output_tokens"`）になり、**見える出力が 1 字も出ないまま終わることがある**。
- 関数ツールは `{ type: "function", name, description, parameters, strict }`。`strict` を省くと strict を試み、合わなければ非 strict に落ちる。strict はすべての項目を `required` に入れ `additionalProperties: false` にする必要がある（現行のツール定義は満たさない）。
- `tool_choice` は `"auto"`・`"required"`・`"none"`・`{ type: "function", name }`（特定の関数の強制）。
- 関数の結果は `{ type: "function_call_output", call_id, output }` で、**`is_error` に当たる項目は無い**。
- ストリーミングは型つきのイベント（`response.output_text.delta`・`response.function_call_arguments.delta`／`.done` など）。
- テキストのモデル（2026-09-27 時点の一覧）: `gpt-6-astra`（最上位）・`gpt-6-sol`・`gpt-6-luna`（最も安価）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] ボスとの対話（チャット・ツール呼び出しを含む）が、BYOK の Anthropic と BYOK の OpenAI のどちらでも動く
- [ ] 朝会・夕会の LLM を使う流れ（会議の開始文・夕会の要約抽出・セッション要約）が、両方のプロバイダで動く
- [ ] ダッシュボードのひとことと通知文面が、両方のプロバイダで生成され、失敗時は従来どおりテンプレートへ退避する
- [ ] BYOK で使えるモデルは、アプリが持つモデルの一覧（以下「モデルの一覧」）にあるものだけである（範囲は（未確定・Q2））
- [ ] モデルの一覧に無いモデルでは、プロバイダへ要求を送らない
- [ ] 製品版の LLM の要求には、アプリが定義したツール以外のツール（プロバイダ側で実行されるツール・MCP の接続）を含めない
- [ ] 製品版の LLM の要求は、プロバイダ側に会話を保存させない（OpenAI は `store: false`）
- [ ] 製品版の LLM の要求は、プロバイダ側の会話状態を参照しない（毎回、履歴を全部送る）
- [ ] LLM の失敗時に、別のプロバイダ・別の課金経路（BYOK ⇔ プラン込み）へ自動で切り替えない
- [ ] OpenAI の BYOK のキーを保管でき、OpenAI の宛先へ送るときだけ付与される（Rust の通信層）
- [ ] ADR 0003 の旧決定 5〜9 のうち製品版に適用するものと、その読み替えが ADR 0003 に追補される（（未確定・Q3））

## 非機能要件

- セキュリティ: OpenAI のキーも Anthropic のキーと同じく WebView に出さない・ログに出さない・DB に出さない（#581 の非機能要件をそのまま引き継ぐ）。OpenAI の宛先も Rust の固定の表で持ち、TS は名前でしか指定できない
- 外部送信: 送信先は ADR 0001 改訂で許可した範囲（利用者が選んだプロバイダ）に限る。プロバイダ側への会話の保存を要求しない（`store: false`）
- ログ: 失敗時に残すのはエラーの種類・HTTP ステータス・応答の区分（停止理由・ブロックの種類・トークン数）まで。本文・プロンプト・ツールの入力は出さない（`api-backend.ts` の `normalizeMessage` の既存の規律と同じ）
- 振る舞いの同等性: 同じ呼び出し元のコードで両プロバイダが動く（呼び出し元はプロバイダ名で分岐しない）。**ボスの人格の再現性（お世辞禁止・決定の断言・エスカレーション時の口調）はモデル依存で、自動テストでは担保しない**（要人間判定。確かめ方は Q4）

## 技術的な制約・方針

- 使用技術: TS（`server/src/llm/`。SDK を使わない。製品版のコアのバンドル検査を通る）、Rust（`native/secure-transport/` に 1 行ずつ追加）
- 前提（別 Issue・並行）: Rust の通信層と TS 側の転送のポート・BYOK（Anthropic）は #581（S2・S3）、Tauri の器は #579 S2、中継サーバーは #583、アカウント・課金は #584。**本機能はこれらを実装しない**
- 依存関係（着手の順序）: （未確定・Q5）。推奨は #581 S2（転送のポートと SDK を使わない Anthropic クライアント）のマージ後に本機能の S1
- 既存コードとの関係: 開発者用の版の `api`・`claude-code` バックエンドと、その自由入力のモデル設定は変えない（ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5）。開発者用の版で OpenAI を使えるようにするかは（未確定・Q5 の ★）

## クリティカル設計決定（草案。すべて未確定）

### 1. プロバイダの差を吸収する層（Q1）

- **推奨案**: **Anthropic Messages の形をコアの共通の言語のまま保ち、プロバイダごとの「形式の変換器」を転送のポートの上に置く。**
  - 呼び出し元 6 モジュールと `ClaudeMessageRequest`・`BossLlmMessage`・ツール定義（`BOSS_TOOLS`）は変えない
  - 形式の変換器はプロバイダの形式ごとに 1 つ（Anthropic Messages は #581 S2 が作る、OpenAI Responses は本機能）。役割は (a) `ResolvedLlmRequest` → 要求本文、(b) 応答（SSE のバイト列・非ストリーミングの JSON）→ `BossLlmMessage`（`onTextDelta` の発火を含む）、(c) エラーの分類（ステータス・`retry-after`・エラー本文 → `RetryDecision`）
  - 変換器は「どの宛先の名前へ送るか」と組み合わせてバックエンドになる（BYOK の OpenAI ＝ OpenAI Responses の変換器 × `openai-responses` の宛先）。中継サーバー（#583）が同じ形式を話すなら、宛先を足すだけで同じ変換器を使える（#583 の設計は縛らない）
  - **`rawContent` は「送り返し専用の、そのバックエンドにしか読めない値」と契約を改める**。ファサードは中身を解釈せず、同じバックエンドの次のラウンドへそのまま渡す。OpenAI の変換器は、送り返された自分の `rawContent`（reasoning・function_call の項目）を認識して `input` にそのまま並べ、後続の Anthropic 形式の `tool_result` を `function_call_output` に変換する
  - **呼び出し元とファサードのバックエンド名の分岐を、バックエンドが宣言する能力に置き換える**: 「ツールのループを自分で回すか」（今の `claude-code` の分岐）・「ツール呼び出しの強制に対応するか」（今の `extract-evening-summary.ts` の `"api"` の分岐）・「応答長を要求ごとに制限できるか」（今の `boss-comment.ts` の `"claude-code"` の分岐）の 3 つ。既存の `api`・`claude-code` の振る舞いは変えない
- **理由**: 現行コードが既に Anthropic の形で組み立てられており、変える量が最も小さい。ボスが使う機能（文字列の履歴・関数ツール・強制呼び出し・thinking）は OpenAI Responses に対応物がある。能力の宣言にしないと、新しいバックエンドを足すたびに呼び出し元の名前の分岐を直す必要があり、直し漏れは「夕会の要約抽出でツールが強制されない」のように黙って品質が落ちる形で出る
- **代替案**:
  - (B) プロバイダ中立の独自の型を新設し、呼び出し元 6 モジュールとツール定義を書き換える — コアから Anthropic の型が消えるが、クリティカル箇所（Claude API 連携）の差分が大きく、#581 S2 の設計（Anthropic の形の上にクライアントを作る）ともずれる。得るものは型の名前の中立性だけ
  - (C) Rust 側で形式を変換する — #581 のクリティカル設計決定 2 で却下済み
- **影響範囲**: `llm/claude-client.ts`・`llm/llm-backend-registry.ts`・`config.ts`（`LlmBackend` を広げる）・`reports/extract-evening-summary.ts`・`dashboard/boss-comment.ts`・新規の OpenAI の変換器（**クリティカル箇所: LLM 連携。変更時は人間レビュー必須**）

### 2. OpenAI の API の種類（Q1 の一部）

- **推奨案**: **Responses API**（`POST https://api.openai.com/v1/responses`）。要求には常に `store: false` を付け、`previous_response_id`・会話の API は使わない。reasoning の項目は `encrypted_content` ごと送り返す
- **理由**: OpenAI が新規に推奨している。`store: false` のまま reasoning を tool 呼び出しをまたいで保てる（チャットの tool use のループで、Anthropic の thinking の署名の送り返しと同じ働きをする）
- **代替案**: Chat Completions — 形は単純だが、reasoning を次のラウンドへ送り返す手段が無く、推論モデルでは tool 呼び出しの後に推論が途切れる。これも新しいアカウントでは既定で保存するため `store: false` は同じく要る

### 3. BYOK で許可するモデルの範囲（Q2 ★）

- 推奨案の骨格（範囲そのものはオーナー決定）: **アプリに同梱する固定のモデルの一覧**をコアに持ち、利用者はプロバイダごとに一覧の中から選ぶ。一覧の各行は「プロバイダ・モデル ID・表示名・reasoning／thinking の指定の仕方・要求ごとの応答長の余裕」を持つ。**一覧に無いモデルは、画面で選べないだけでなく、BYOK のバックエンドが送信前に拒否する**（送信の手前の関門。画面の実装に頼らない）。一覧の更新はアプリの更新（#587）で行う
- 詳細・選択肢は完了報告の Q2

### 4. ADR 0003 旧決定 5〜9 の製品版への読み替え（Q3）

| 旧決定 | 元の手段（Agent SDK 前提） | 製品版での読み替え（推奨） | 担保 |
|---|---|---|---|
| 5 ビルトインツールの無効化 | ビルトインツール集合を空・許可判定コールバック | 要求に含めるツールは、アプリが定義した関数ツールだけ（プロバイダ側で実行されるツール〔Web 検索・コード実行・ファイル検索等〕・MCP の接続を含めない） | TS のテスト（要求本文のツールがすべて関数ツールで、名前が呼び出し元の渡したものと一致） |
| 6 キーを子プロセスへ渡さない | 子プロセスの環境から除外 | キーは Rust の通信層だけが持ち、TS は持たない | #581 で担保済み（ADR 0002 改訂の決定 3）。本機能は OpenAI の鍵にも同じ関門を通す |
| 7 セッション履歴の永続化の無効化 | Agent SDK の永続化を切る | プロバイダ側に会話を保存させない（OpenAI は `store: false`）・プロバイダ側の会話状態を使わない（毎回全文送信。ADR 0003 決定 4 と同じ） | TS のテスト（要求本文の `store` が `false`・`previous_response_id` が無い） |
| 8 テレメトリ・非必須通信の無効化 | 環境変数で切る | 製品版の LLM 送信はすべて Rust の宛先の表を通り、SDK を同梱しない（SDK 由来の通信が無い） | #581 の宛先の表のテスト・`core-entry.bundle.test.ts` |
| 9 自動フォールバックしない | `api` へ切り替えない | 失敗時に、別のプロバイダ・別の課金経路（BYOK ⇔ プラン込み）・一覧の別のモデルへ自動で切り替えない。チャットは失敗、ひとこと・通知文面・会議の開始文はテンプレートへ退避（既存の形） | TS のテスト（失敗時に他の宛先・他のモデルで送らない） |

- 記録の場所: ADR 0003 の末尾に「追補（製品版での旧決定 5〜9 の読み替え）」を加える（本体の大改訂はしない）（未確定・Q3）

## 機能全体の設計（草案）

### IF / API（S1 で固定する境界・名前は仮）

- **形式の変換器**（プロバイダの形式ごと）: `buildRequestBody(request: ResolvedLlmRequest, model: CatalogEntry, { stream }) → string`／`parseStream(chunks, onTextDelta) → Promise<BossLlmMessage>`／`parseResponse(body) → BossLlmMessage`／`classifyError({ status, retryAfter, body }) → RetryDecision`
- **バックエンドの能力**（`LlmBackendImplementation` に足す）: `ownsToolLoop: boolean`・`supportsForcedToolChoice: boolean`・`supportsPerRequestMaxTokens: boolean`（既存: `api` = false／true／true、`claude-code` = true／false／false）
- **Anthropic の形 → OpenAI Responses の対応**:

| Anthropic（コアの形） | OpenAI Responses |
|---|---|
| `system` | `instructions` |
| user の文字列 | `input` の `{ role: "user", content }` |
| assistant の文字列 | `input` の `{ role: "assistant", content }` |
| assistant の `rawContent`（前ラウンドの OpenAI の出力項目） | `input` にそのまま並べる（reasoning の `encrypted_content`・function_call を含む） |
| user の `tool_result`（`tool_use_id`・`content`・`is_error`） | `{ type: "function_call_output", call_id, output }`。`is_error` は `output` の文字列に表す（仮定 A4） |
| `tools`（`name`・`description`・`input_schema`） | `{ type: "function", name, description, parameters: input_schema, strict: false }` |
| `toolChoice` `{ type: "tool", name }`／`auto`／`any`／`none` | `{ type: "function", name }`／`"auto"`／`"required"`／`"none"` |
| `maxTokens` | `max_output_tokens`（reasoning を含む。モデルの一覧の行で余裕を足すかは Q4） |
| `thinking`・`outputConfig.effort` | `reasoning.effort`（値の対応はモデルの一覧の行が持つ。`disabled` を `none` にできないモデルがある） |
| — | `store: false`（常に） |

- **応答の対応**: `response.output_text.delta` → `onTextDelta`、完了時の `output` のうち `message` の `output_text` → `text` のブロック、`function_call`（`call_id`・`name`・`arguments` の JSON）→ `tool_use` のブロック（`id` = `call_id`、`input` = `arguments` を JSON として解釈した値）、`output` 全体 → `rawContent`。`status: "incomplete"` や `text`・`tool_use` が 1 つも無い応答は、`normalizeMessage` と同じくメタ情報だけをログに出す
- **Rust の通信層**（#581 のクリティカル設計決定 3 の「1 行ずつ足す」）: 宛先 `openai-responses` → `https://api.openai.com/v1/responses`、資格情報 `OpenAiBearer`（`authorization: Bearer <キー>` を付与。呼び出し元の `authorization` は既に捨てている）、保管の `Provider::OpenAi`（account `"openai"`）。応答ヘッダの許可に `x-request-id` を足すか（仮定 A5）

### 実装計画（S1 のチケット分解の見通し・S1 の切り方が Q5 の推奨どおりの場合）

1. バックエンドの能力の宣言と、ファサード・呼び出し元のバックエンド名の分岐の置き換え（既存の振る舞いは不変。#581 S2 で済んでいれば不要）
2. モデルの一覧（コアの定数）と、一覧に無いモデルを送信前に拒否する関門
3. OpenAI Responses の形式の変換器（要求本文の組み立て・SSE の解釈・`rawContent` の送り返し・エラーの分類）と BYOK（OpenAI）のバックエンドの実装（転送のポートは模擬で固定）
4. Rust の通信層に OpenAI の宛先・資格情報・保管の項目を 1 行ずつ追加（`cargo test`）
5. ADR 0003 の追補（旧決定 5〜9 の読み替え）

## スライス（出荷の単位）

> 草案。Q5 の推奨案。確定は親の回答による。

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 器が無くても固定できる部分: バックエンドの能力の宣言（名前の分岐の置き換え）・モデルの一覧と送信前の関門・OpenAI Responses の形式の変換器と BYOK（OpenAI）のバックエンド（転送のポートは模擬）・Rust に OpenAI の宛先と鍵の項目・ADR 0003 の追補 | 12-18 | #581 S2 がマージされてから（転送のポートと Anthropic の変換器の上に作る）。これだけで、OpenAI で tool use のループ・強制呼び出し・reasoning の送り返しが成り立つことを模擬で固定できる |
| S2 | 製品版の器への配線: 製品版のエントリへの BYOK（OpenAI）の登録、プロバイダ・モデルの選択の画面と保存、OpenAI のキーの登録・削除の画面、両プロバイダでのチャット・朝会・夕会の実機確認（要人間判定） | 8-14 | S1・#581 S3・#579 S2 がマージされてから（動作確認は #580 S2 の後） |

実装対象: S1

## やらないこと

- 中継サーバー・プラン込みの経路・既定の低価格モデルの選定（理由: #583 の範囲）
- アカウント・ライセンス・料金（理由: #584 の範囲）
- プラン込みと BYOK の切り替えの画面と、その選択の保存（理由: 課金経路の選択は #583・#584 と一体。本機能はプロバイダ・モデルの選択まで（未確定・Q6））
- Tauri の器・Tauri のコマンドの公開・製品版の DB（理由: #579 S2・#581 S3・#580 S2）
- Anthropic・OpenAI 以外のプロバイダ（理由: ADR 0011 決定 10 の範囲外）
- モデルの一覧をクラウドから配信して更新すること（理由: 外部送信が増え ADR 0001 の改訂を要する。一覧の更新はアプリの更新で行う）
- 開発者用の版の `api`・`claude-code` バックエンドと自由入力のモデル設定の変更（理由: ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5）
- ADR 0003 本体の書き換え（理由: 追補に留める）
- 画像・文書の入力・プロンプトキャッシュ等、現行のボスが使っていない機能のプロバイダ間の対応（理由: YAGNI）

## 受入基準（S1・草案）

> Q1〜Q5 の回答で変わる。変わらない骨格だけを置く。テストはすべて模擬の転送のポートと固定の応答（公式ドキュメントの形に合わせた手書きの SSE）で行い、実 API は呼ばない。

- [ ] 模擬の転送のポートで BYOK（OpenAI）のバックエンドにチャットの要求を送ると、宛先の名前は `openai-responses` である
- [ ] BYOK（OpenAI）の要求本文の `store` は `false` である（ストリーミング・非ストリーミングの両方）
- [ ] BYOK（OpenAI）の要求本文に `previous_response_id` が無い
- [ ] BYOK（OpenAI）の要求本文の `tools` の各要素は `type: "function"` で、名前の集合は呼び出し元が渡したツールの名前の集合と一致する
- [ ] BYOK（OpenAI）の要求本文の `instructions` は、呼び出し元が渡した `system` と一致する
- [ ] 呼び出し元が `toolChoice: { type: "tool", name: "submit_evening_summary" }` を渡すと、要求本文の `tool_choice` は `{ type: "function", name: "submit_evening_summary" }` である
- [ ] 模擬の応答が `response.output_text.delta` を 2 回返すと、`onTextDelta` は同じ順で 2 回呼ばれる
- [ ] 模擬の応答が `function_call` の項目を返すと、`BossLlmMessage.content` に同じ `call_id`・`name`・解釈済みの `arguments` を持つ `tool_use` のブロックが入る
- [ ] ツールのループで 2 ラウンド目を送るとき、要求本文の `input` には 1 ラウンド目の出力の reasoning の項目が `encrypted_content` ごと含まれる
- [ ] ツールのループで 2 ラウンド目を送るとき、要求本文の `input` にはツールの結果が、1 ラウンド目の `call_id` を持つ `function_call_output` として含まれる
- [ ] モデルの一覧に無いモデルで BYOK（OpenAI）のバックエンドを呼ぶと、転送のポートは一度も呼ばれない
- [ ] モデルの一覧に無いモデルで BYOK（Anthropic）のバックエンドを呼ぶと、転送のポートは一度も呼ばれない
- [ ] BYOK（OpenAI）で応答のステータスが 429 のとき、分類は再試行可で、`retry-after` の値が待ち時間になる
- [ ] BYOK（OpenAI）で応答のステータスが 401 のとき、分類は再試行不可である
- [ ] BYOK（OpenAI）の送信が失敗しても、転送のポートへ別の宛先の名前の要求は送られない
- [ ] 夕会の要約抽出を BYOK（OpenAI）のバックエンドで呼ぶと、要求本文の `tool_choice` は `submit_evening_summary` の強制である（名前の分岐を能力の宣言へ置き換えた結果）
- [ ] 開発者用の版で `LLM_BACKEND=api` のとき、夕会の要約抽出の要求は従来どおり `toolChoice` を持つ
- [ ] 開発者用の版で `LLM_BACKEND=claude-code` のとき、ダッシュボードのひとことの指示には従来どおり短文の指示が付く
- [ ] Rust の製品版の宛先の表の `openai-responses` の送信先は `https://api.openai.com/v1/responses` である
- [ ] `openai-responses` へ送ると、模擬サーバーが受けた要求の `authorization` は `Bearer ` と保管のポートに登録した OpenAI のキーを連結した値である
- [ ] `openai-responses` へ送ると、模擬サーバーが受けた要求に `x-api-key` のヘッダが無い
- [ ] `anthropic-messages` へ送ると、模擬サーバーが受けた要求の `x-api-key` は Anthropic のキーであり、OpenAI のキーではない
- [ ] OpenAI のキーが未登録のとき `openai-responses` へ送ると、模擬サーバーへ要求を送らずに「キー未登録」の失敗で終わる
- [ ] ADR 0003 の末尾に、旧決定 5〜9 のそれぞれについて製品版での扱いを書いた追補がある
- [ ] `core-entry.bundle.test.ts` が合格する（OpenAI の変換器が外部の指定子・SDK を持ち込まない）
- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:tz` が合格する
- [ ] `npm run test:rust` が合格する

## 仮定（軽微・可逆）

- A1: 仕様ファイルの名前は `llm-provider-abstraction.md`
- A2: バックエンド名は仮に `byok-anthropic`・`byok-openai`、宛先の名前は `openai-responses`、資格情報は `OpenAiBearer`、キーチェーンの account は `openai`。実装で決めてよい
- A3: 非ストリーミングの呼び出し（`createRound`）は `stream: false` で送り、JSON の応答を解釈する
- A4: OpenAI には `is_error` が無いため、ツールの失敗は `function_call_output` の `output` の文字列でエラーと分かる形にする（書式は実装で決めてよい）
- A5: Rust の応答ヘッダの許可に OpenAI の `x-request-id` を足すかは実装で決めてよい（診断用で振る舞いに関わらない）
- A6: OpenAI の `store` の既定・reasoning の送り返し・`reasoning.effort` の対応はモデルごとに変わりうるため、実装時に公式ドキュメントを読み直し、食い違ったら仕様を直す
