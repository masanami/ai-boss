# LLM プロバイダの抽象化（Anthropic / OpenAI・BYOK で許可するモデル）

> Issue #582。2026-09-27 に論点 Q1〜Q6 を確定した（★ はオーナーの決定、それ以外は親の決定。「決定」節）。
> 2026-09-29: #581 S3（`docs/features/secure-transport-byok.md` のオーナーの決定 Q6）で、クリティカル設計決定 5 の**骨格**（解決関数の注入口・開発者用の解決関数・固定の製品版の解決関数・呼び出し元の置き換え）を前倒しした。S2 の範囲を、前倒しした分だけ書き換えた（クリティカル設計決定 5 の「#581 S3 で入ったもの」・スライス表）。

## 概要

製品版の BYOK で、Anthropic と OpenAI のどちらのキーでもボスとの対話・朝会・夕会・ツール呼び出しが動くようにする。プロバイダの形式の差（tool use・ストリーミング・thinking／reasoning・エラー）は TypeScript のコアで吸収し、Rust の通信層（#581）には OpenAI の宛先と鍵の項目を 1 行ずつ足すだけにする。あわせて、BYOK で選べるモデルの範囲と、[ADR 0003](../adr/0003-llm-backend-isolation.md) の旧決定 5〜9 を製品版でどう読むかを決める（[ADR 0011](../adr/0011-productization-architecture.md) 決定 8〜10）。

## 背景・目的

- 製品版は API を前提にする。既定はプラン込み（中継サーバー・#583）、選択で BYOK（Anthropic または OpenAI をアプリから直接呼ぶ）（ADR 0011 決定 8〜10）。
- 現行のコアは **Anthropic Messages API の形を共通の形として使っている**。呼び出し元 6 モジュールは `Anthropic.MessageParam`・`Anthropic.Tool`・`ThinkingConfigParam`・`OutputConfig` の形でリクエストを組み立て、ツールのループは Anthropic の `tool_result` を積む（下の「実コードの実測」）。OpenAI を足すには、この形から OpenAI の形へ変換する層が要る。
- #581 の仕様（クリティカル設計決定 2）で、Rust は送受信と秘密情報の付与だけを担い、プロバイダの形式の解釈は TS に置くと決めた。本機能の変換はすべて TS 側に入る。
- ADR レビューで残した論点（medium）: `claude-code` を開発者用に限った後、ADR 0003 の旧決定 5〜9 のどれが製品版にも効くか。ADR 0003 改訂の帰結は「5〜9 を新しい経路にもそのまま適用する」と書くが、5〜8 は Agent SDK を前提にした手段で、API を直接呼ぶ経路には字義どおりには当てはまらない。

## ユーザーストーリー

- 製品版の利用者として、自分が持っている OpenAI の API キーを登録すれば、Anthropic のキーが無くてもボスとの対話・朝会・夕会を使いたい。
- 製品版の利用者として、BYOK で使うモデルを、ボスとして動作が確かめられた候補の中から選びたい。
- 製品版の利用者として、自分の選んだプロバイダ・モデル・課金経路が、失敗時に黙って別のものへ切り替わらないでほしい。

## 決定（2026-09-27）

| 論点 | 決定 | 決めた人 |
|---|---|---|
| Q1 差の吸収の形 | Anthropic Messages の形をコアの共通の形のまま保ち、プロバイダの形式ごとの変換器を転送のポートの上に置く（クリティカル設計決定 1） | 親 |
| Q1 OpenAI の API | Responses API（クリティカル設計決定 2） | 親 |
| Q1 `store` | **指定しない（プロバイダの既定に任せる）**。ADR 0001 の「業務データを外に置かない」は原則であり、BYOK で利用者自身の OpenAI アカウントに応答が保存されることは許容する。`store: false` を義務にしない | ★オーナー |
| Q1 ADR 0003 決定 4 | 維持する（毎回 DB から全文を組み立てて送る・`previous_response_id` 等のプロバイダ側の会話状態に依存しない）。reasoning の引き継ぎは 1 ターンのツールのループの中だけで行う（クリティカル設計決定 2） | 親 |
| Q2-1 粒度 | アプリ同梱の固定の一覧から選ぶ。一覧外は画面で選べず、送信の直前でも止める | ★オーナー |
| Q2-2 一覧 | Anthropic: `claude-sonnet-5`（既定）・`claude-haiku-4-5`／OpenAI: `gpt-6-sol`（既定）・`gpt-6-luna`。`gpt-6-astra` は推論を切れず（`reasoning.effort: "none"` で 400）、出力の上限 150 の短文で毎回テンプレートの文面になる恐れがあるため外す。モデル ID は実装前に公式で読み直す（仮定 A6） | ★オーナー |
| Q2-3 一覧から外れたモデル | **利用者が選び直すまで LLM を止める**（既定モデルへ移さない）。S1 の送信前の関門がそのまま担う | ★オーナー（「実装がシンプルなら」の条件つき。親が単純さを確認） |
| Q3 ADR 0003 旧決定 5〜9 | 読み替えを ADR 0003 の末尾に追補し、S1 の PR に含める。本体は書き換えない。旧決定 7 の読み替えは Q1 の `store` の決定に合わせ「プロバイダ側の会話状態を使わず毎回全文を送る」だけにする（クリティカル設計決定 4） | 親 |
| Q4 受入基準の書き方 | 形式の正しさは模擬のポートと手書きの応答で自動テストに固定する。ボスの人格とツールの安定性は S2 の実機確認で人間が判定する。実キーでの手動確認は S1 に入れない | 親 |
| Q5 S1 の切り方 | 器が無くても固定できる部分を S1 にする（「スライス」節）。**バックエンドの名前の分岐（`extract-evening-summary.ts`・`boss-comment.ts`・`claude-client.ts`）を能力の宣言へ置き換えるのは #581 S2 で行い、本機能の S1 は #581 S2 のマージ後に着手する** | 親 |
| Q5 開発者用の版での OpenAI | 入れない。開発者用の版の ADR 0001 決定 2（外部送信は Anthropic のみ）は変えない | ★オーナー |
| Q6 範囲の境目 | 本機能はプロバイダとモデルの選択の保存と検証まで。課金経路（プラン込み ⇔ BYOK）の切り替えは #583・#584 | 親 |
| 選択の反映経路（PR #625 の Codex の指摘・P1） | 保存したプロバイダとモデルの選択を、**要求ごとに、モデルと同じ設定のスナップショットから**解決して送信先のバックエンドを決める（起動時に固定しない）。呼び出し元 6 モジュールのバックエンドの決め方を変える。S2 に入れる（クリティカル設計決定 5） | 親 |

## 実コードの実測（2026-09-27・`main` 31b76fb）

仕様の決定はこの実測に拠る。食い違ったらコードが正。TS のパスは `server/src/` を省く。

| 対象 | 実測 |
|---|---|
| ファサードの型 | `llm/claude-client.ts` の `ClaudeMessageRequest` は `messages: Anthropic.MessageParam[]`・`tools?: Anthropic.Tool[]`・`toolChoice?: Anthropic.ToolChoice`・`thinking?`・`outputConfig?`。SDK は **型だけ** import（`import type`）。`BossLlmMessage` は `content`（`text`・`tool_use` のみ）と任意の `rawContent?: unknown[]` |
| tool use のループ | `streamBossMessage` が最大 `MAX_TOOL_ROUNDS = 5` 回す。`tool_use` があれば `rawContent ?? content` を assistant として積み、`buildToolResultMessage` で Anthropic の `tool_result`（`is_error` つき）を user として積む。積んだ履歴はそのターンの中だけで使い、DB には保存しない（DB に残るのはボスの発言の本文）。**ループを回すかは `client.backend === "claude-code"` の名前で分岐**している（claude-client.ts:573） |
| 呼び出し元のバックエンド名の分岐 | `reports/extract-evening-summary.ts:161` は **`backend === "api"` のときだけ `toolChoice` でツール呼び出しを強制**する。`dashboard/boss-comment.ts:67・134` は `backend === "claude-code"` のときだけ短文の指示と全角 80 字の検証を足す。新しいバックエンド名を足すと、夕会の要約抽出でツール呼び出しが強制されなくなる。**この置き換えは #581 S2 の範囲とする**（決定 Q5） |
| リクエストの使い方 | チャットだけ `thinking: { type: "adaptive" }`・`outputConfig: { effort: "low" }`・`maxTokens` 既定 16000・`tools: BOSS_TOOLS`。ダッシュボードのひとこと・通知文面は `maxTokens: 150`、セッション要約は 300、会議の開始文も小さい値で、いずれも `thinking: { type: "disabled" }`。夕会の要約抽出は `submit_evening_summary` の強制呼び出し。`cache_control`・画像・文書のブロックは使っていない（履歴は文字列の本文だけ） |
| ツールの定義 | `boss/boss-tools.ts` の `BOSS_TOOLS: Anthropic.Tool[]`（各ツールのモジュールの `input_schema` が単一ソース）。任意項目を `required` に入れておらず、`committed_start_at` は `type: ["string", "null"]` |
| テンプレートへの退避 | ダッシュボードのひとこと・通知文面・会議の開始文は、失敗・空応答で固定の文面へ退避する。チャットは 500、夕会の要約抽出は失敗の結果を返す（ADR 0003 決定 9 の既存の形） |
| エラーの分類 | `llm/backends/api-backend.ts` の `classifyApiError` は SDK の `APIError` の `status`（408・429・5xx は再試行）と `retry-after` で判定する。ファサードの `runWithTimeoutAndRetry` は `classifyError` があるときだけ使う |
| バックエンドの登録 | `llm/llm-backend-registry.ts` の `registerLlmBackend(name, implementation)`。`LlmBackend`（`config.ts`）と `BossLlmClient` は `"api" \| "claude-code"` の閉じた型。`createClient(env)` は**モデルを受け取らない**（モデルは要求ごとに `ResolvedLlmRequest.model` で `streamRound`／`createRound` に渡る）。`streamRound`／`createRound` が投げた例外は `runWithTimeoutAndRetry` を通り（`classifyError` が再試行不可と判定すれば即座に）、呼び出し元の既存の失敗の経路（チャットは 500、ダッシュボードのひとこと・通知文面・会議の開始文はテンプレート）に乗る |
| バックエンドの決め方（選択の反映経路） | チャット・セッション要約は `createCoreApp` の構築時に 1 回だけ決めたバックエンド（`core-app.ts:117` の `options.llmBackend ?? resolveLlmBackend(env)`）を引数で受け取る。会議の開始文（`sessions/meeting-opening.ts:128`）・ダッシュボードのひとこと（`dashboard/boss-comment.ts:94`）・夕会の要約抽出（日報。`reports/extract-evening-summary.ts:136`）・通知文面（`notifications/notification-body.ts:202`）は、呼ぶたびに `resolveLlmBackend(env)`（環境変数 `LLM_BACKEND`）を読む。**どちらも設定（DB）を読まない**。一方、**モデルは 6 経路とも要求ごとに設定から読む**（`resolveBossSettings(db)`。チャットは #618 の 1 ターン分のスナップショット〔`chat-messages-route.ts:373`〕から `resolveBossSettingsFrom`）。チャットはクライアントを作ってから（`:292`）スナップショットを読む |
| モデルの設定 | `settings` の `model` キー（`settings-validation.ts` は空でない文字列なら何でも通す）。画面は自由入力の `<input>`（`web/src/SettingsView.tsx:342`）。既定は `DEFAULT_MODEL = "claude-sonnet-5"`。開発者用の版はこのまま変えない |
| 製品版のコアのバンドル | `core-entry.bundle.test.ts` が外部の指定子と `@anthropic-ai/sdk`・Agent SDK の混入を禁じる。**OpenAI の npm SDK もコアに入れられない** |
| Rust の通信層（#581 S1・#616 でマージ済み） | `destination.rs` の宛先の表は `anthropic-messages` の 1 行、`Credential` は `AnthropicApiKey` だけ。`key_store.rs` の `Provider` は `Anthropic` だけ（account `"anthropic"`）。`transport.rs` は `x-api-key`・`authorization`・`anthropic-version` を呼び出し元から受けても捨て、応答ヘッダは `retry-after`・`request-id`・`content-type` だけを通す |
| #581 の後続スライス | S2（転送のポート・SDK を使わない Anthropic のクライアント・BYOK（Anthropic）の登録）は 2026-09-27 時点で**未起票**。S3 は #579 S2 の器の後 |

### OpenAI の公式ドキュメントで確かめたこと（2026-09-27 に developers.openai.com を参照。実 API は呼んでいない）

- Responses API が新規の推奨。Chat Completions も引き続き提供される。
- Responses は既定で応答を OpenAI 側に保存する（`store` の既定）。本機能は `store` を指定しない（決定 Q1）。
- 「ステートレスの形」（reasoning の項目が暗号化した中身〔`encrypted_content`〕を持つ）になるのは、`store: false` のとき、または組織がデータを保持しない設定（ZDR）のとき。`include: ["reasoning.encrypted_content"]` は互換のために受け付けるが不要とされる。
- tool 呼び出しをまたいで reasoning を保つには、**直前の利用者の発言から関数の結果までの項目を、手を加えずに次の要求へ渡す**（function calling のガイド）。
- `reasoning.effort` は `none`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max`。対応はモデルごとに違い、`gpt-6-astra` は `none` で 400 を返す。
- `max_output_tokens` は reasoning のトークンも含む。使い切ると `status: "incomplete"`（`incomplete_details.reason: "max_output_tokens"`）になり、見える出力が 1 字も出ないまま終わることがある。
- 関数ツールは `{ type: "function", name, description, parameters, strict }`。`strict` を省くと strict を試み、合わなければ非 strict に落ちる。strict はすべての項目を `required` に入れ `additionalProperties: false` にする必要がある（現行のツール定義は満たさない）。
- `tool_choice` は `"auto"`・`"required"`・`"none"`・`{ type: "function", name }`（特定の関数の強制）。
- 関数の結果は `{ type: "function_call_output", call_id, output }` で、`is_error` に当たる項目は無い。
- ストリーミングは型つきのイベント（`response.output_text.delta`・`response.function_call_arguments.delta`・`response.function_call_arguments.done`・`response.completed` ほか）。
- テキストのモデル: `gpt-6-astra`（最上位）・`gpt-6-sol`・`gpt-6-luna`（最も安価）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

> 以下の「両方のプロバイダで」は、BYOK の Anthropic と BYOK の OpenAI の両方を指す。自動テストは模擬の転送のポートで固定し、実キーでの実機確認は S2 で行う。

- [ ] 両方のプロバイダで、チャットの要求がプロバイダへ送られる
- [ ] 両方のプロバイダで、チャットの応答の本文が逐次返る
- [ ] 両方のプロバイダで、チャットのツール呼び出しのループが完了する
- [ ] 両方のプロバイダで、会議の開始文が生成される
- [ ] 両方のプロバイダで、セッション要約の本文が生成される
- [ ] 両方のプロバイダで、夕会の要約抽出が `submit_evening_summary` の呼び出し結果を得る
- [ ] 両方のプロバイダで、ダッシュボードのひとことが生成される
- [ ] 両方のプロバイダで、通知文面が生成される
- [ ] 両方のプロバイダで、ダッシュボードのひとことの生成が失敗すると、従来どおりテンプレートへ退避する
- [ ] 両方のプロバイダで、通知文面の生成が失敗すると、従来どおりテンプレートへ退避する
- [ ] 両方のプロバイダで、会議の開始文の生成が失敗すると、従来どおりテンプレートへ退避する
- [ ] BYOK で使えるモデルは、アプリが持つモデルの一覧（以下「モデルの一覧」。クリティカル設計決定 3）にあるものだけである
- [ ] モデルの一覧に無いモデルでは、プロバイダへ要求を送らない
- [ ] 利用者が選んでいたモデルがモデルの一覧から外れたら、利用者が一覧から選び直すまで LLM を使わない（既定モデルへ移さない）
- [ ] 利用者は、プロバイダごとにモデルの一覧の中からモデルを選び、その選択が保存される（S2）
- [ ] 保存したプロバイダとモデルの選択は、アプリを再起動しなくても、次の LLM の要求からすべての経路（チャット・セッション要約・会議の開始文・ダッシュボードのひとこと・夕会の要約抽出・通知文面）の送信先に反映される（S2・クリティカル設計決定 5）
- [ ] 製品版の LLM の要求には、アプリが定義したツール以外のツール（プロバイダ側で実行されるツール・MCP の接続）を含めない
- [ ] 製品版の LLM の要求は、プロバイダ側の会話状態を参照しない（毎回、DB から組み立てた履歴を全部送る）
- [ ] LLM の失敗時に、別のプロバイダへ自動で切り替えない（S1 で検証: 転送のポートの宛先の名前が変わらない）
- [ ] LLM の失敗時に、一覧の別のモデルへ自動で切り替えない（S1 で検証: 要求本文の `model` が変わらない）
- [ ] LLM の失敗時に、別の課金経路（BYOK ⇔ プラン込み）へ自動で切り替えない（プラン込みの経路は #583 で作るため、検証は #583・#584 の受入基準で行う。本機能の S1 には経路が 1 つしか無い）
- [ ] OpenAI の BYOK のキーを保管できる（Rust の通信層）
- [ ] OpenAI のキーは OpenAI の宛先へ送るときだけ付与され、他の宛先（Anthropic の宛先を含む）には付与されない（Rust の通信層）
- [ ] ADR 0003 の旧決定 5〜9 のうち製品版に適用するものと、その読み替えが ADR 0003 に追補される

## 非機能要件

- セキュリティ: OpenAI のキーも Anthropic のキーと同じく WebView に出さない・ログに出さない・DB に出さない（#581 の非機能要件をそのまま引き継ぐ）。OpenAI の宛先も Rust の固定の表で持ち、TS は名前でしか指定できない
- 外部送信: 送信先は ADR 0001 改訂で許可した範囲（利用者が選んだプロバイダ）に限る。プロバイダ側での応答の保存はプロバイダの既定に任せる（決定 Q1。BYOK では利用者自身のアカウントでの保存になる）
- ログ: 失敗時に残すのはエラーの種類・HTTP ステータス・応答の区分（停止理由・ブロックの種類・トークン数）まで。本文・プロンプト・ツールの入力は出さない（`api-backend.ts` の `normalizeMessage` の既存の規律と同じ）
- 振る舞いの同等性: 同じ呼び出し元のコードで両プロバイダが動く（呼び出し元はプロバイダ名で分岐しない）。ボスの人格の再現性（お世辞禁止・決定の断言・エスカレーション時の口調）とツール呼び出しの安定性はモデル依存で、自動テストでは担保しない（S2 の実機確認で人間が判定する。決定 Q4）

## 技術的な制約・方針

- 使用技術: TS（`server/src/llm/`。SDK を使わない。製品版のコアのバンドル検査を通る）、Rust（`native/secure-transport/` に 1 行ずつ追加）
- 前提（別 Issue・並行）: Rust の通信層と TS 側の転送のポート・SDK を使わない Anthropic のクライアント・BYOK（Anthropic）・バックエンドの能力の宣言は #581（S2・S3）、Tauri の器は #579 S2、製品版の DB は #580 S2、中継サーバーは #583、アカウント・課金は #584。**本機能はこれらを実装しない**
- 依存関係（着手の順序）: **本機能の S1 は #581 S2 のマージ後に着手する**（転送のポート・Anthropic の変換器・能力の宣言の上に作る）。**2026-09-27 時点の #581 の仕様（`docs/features/secure-transport-byok.md`）の S2 の記述には、能力の宣言への置き換えがまだ書かれていない**（決定 Q5 はこの仕様の確定と同日の親の決定）。このため #581 S2 を起票するときに、その範囲へ「バックエンド名の分岐（`reports/extract-evening-summary.ts`・`dashboard/boss-comment.ts`・`llm/claude-client.ts`）を能力の宣言へ置き換える」を加える必要がある（扱いは親が決める）。本機能の S1 の着手条件は「#581 S2 がマージされ、`LlmBackendImplementation` が 3 つの能力を宣言する形になっていること」とする。S2 は S1・#581 S3・#579 S2 のマージ後（実機での動作確認は #580 S2 の後）
- 既存コードとの関係: 開発者用の版の `api`・`claude-code` バックエンド、その自由入力のモデル設定、開発者用の版の外部送信の範囲（Anthropic のみ）は変えない。**開発者用の版のバックエンドの決め方（環境変数 `LLM_BACKEND`）の振る舞いも変えない**（S2 で決め方を解決関数へ置き換えても、開発者用の版の解決関数は従来と同じ結果を返す）（ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5・決定 Q5）

## クリティカル設計決定

### 1. プロバイダの差を吸収する層（Q1・親の決定）

- **採用案**: **Anthropic Messages の形をコアの共通の形のまま保ち、プロバイダの形式ごとの「形式の変換器」を転送のポートの上に置く。**
  - `ClaudeMessageRequest`・`BossLlmMessage`・ツール定義（`BOSS_TOOLS`）と、呼び出し元 6 モジュールが組み立てる要求の形は変えない。**ただし呼び出し元 6 モジュールの「どのバックエンドへ送るか」の決め方は S2 で変える**（クリティカル設計決定 5）
  - 形式の変換器はプロバイダの形式ごとに 1 つ（Anthropic Messages は #581 S2、OpenAI Responses は本機能）。役割は (a) `ResolvedLlmRequest` → 要求本文、(b) 応答（SSE のバイト列・非ストリーミングの JSON）→ `BossLlmMessage`（`onTextDelta` の発火を含む）、(c) エラーの分類（ステータス・`retry-after`・エラー本文 → `RetryDecision`）
  - 変換器は宛先の名前と組み合わせてバックエンドになる（BYOK の OpenAI ＝ OpenAI Responses の変換器 × `openai-responses` の宛先）。中継サーバー（#583）が同じ形式を話すなら宛先を足すだけで同じ変換器を使える（#583 の設計は縛らない）
  - **`rawContent` は「そのバックエンドにだけ送り返す、ファサードが中身を解釈しない値」とする**。ファサードは同じバックエンドの次のラウンドへそのまま渡す。OpenAI の変換器は、送り返された自分の `rawContent`（前のラウンドの出力の項目）を認識して `input` にそのまま並べ、後続の Anthropic 形式の `tool_result` を `function_call_output` に変換する
  - 呼び出し元とファサードのバックエンド名の分岐は、#581 S2 が能力の宣言（「ツールのループを自分で回すか」「ツール呼び出しの強制に対応するか」「要求ごとに応答長を制限できるか」）に置き換える（決定 Q5）。本機能の BYOK（OpenAI）は「ループを自分で回さない・強制に対応する・応答長を制限できる」と宣言する
- **理由**: 現行コードが既に Anthropic の形で組み立てられており、変える量が最も小さい。ボスが使う機能（文字列の履歴・関数ツール・強制呼び出し・thinking）は OpenAI Responses に対応物がある
- **代替案**:
  - (B) プロバイダ中立の独自の型を新設し、呼び出し元 6 モジュールとツール定義を書き換える — クリティカル箇所（LLM 連携）の差分が大きく、#581 S2 の設計（Anthropic の形の上にクライアントを作る）ともずれる。得るものは型の名前の中立性だけ
  - (C) Rust 側で形式を変換する — #581 のクリティカル設計決定 2 で却下済み
- **影響範囲**: `llm/claude-client.ts`（`rawContent` の契約の記述）・`config.ts`（`LlmBackend` を広げる）・新規の OpenAI の変換器とバックエンド・モデルの一覧（**クリティカル箇所: LLM 連携。変更時は人間レビュー必須**）

### 2. OpenAI の API と reasoning の引き継ぎ（Q1・親の決定／`store` は★オーナーの決定）

- **採用案**: **Responses API**（`POST https://api.openai.com/v1/responses`）。
  - **`store` は要求本文に含めない**（プロバイダの既定に任せる・決定 Q1）
  - **`previous_response_id` と会話の API（Conversations）は使わない**。各ラウンドの `input` は、DB から組み立てた履歴（呼び出し元が渡す `messages`）と、そのターンのツールのループで積んだ項目から毎回全部作る（ADR 0003 決定 4 の維持）
  - **reasoning の引き継ぎは 1 ターンのツールのループの中だけ**で行う: 前のラウンドの出力の項目（reasoning・function_call・message）を `rawContent` として受け取り、次のラウンドの `input` に**手を加えずに**並べ、その後ろに関数の結果（`function_call_output`）を並べる（公式ドキュメントの「直前の利用者の発言から関数の結果までの項目を手を加えずに渡す」）。項目の中身が暗号化した reasoning（`store: false` や ZDR のとき）か保存済みの項目の参照（既定のとき）かはプロバイダとアカウントの設定で決まり、変換器はどちらでも同じ扱い（そのまま渡す）にする。`include: ["reasoning.encrypted_content"]` は付けない
  - ターンをまたいだ reasoning は引き継がない（DB に残るのは本文だけで、次のターンは本文の履歴から組み立てる。Anthropic の thinking と同じ扱い）
- **理由**: Responses は OpenAI が新規に推奨している。1 ターンの中の項目の送り返しは、現行の Anthropic の thinking と署名の送り返し（`rawContent`・Issue #117）と同じ位置づけで、アプリ側に「アプリのセッション ⇔ プロバイダのセッション」の対応を持たないため ADR 0003 決定 4 と両立する
- **既知の制約（仮定 A7）**: `store` が既定のとき、送り返す reasoning の項目は OpenAI 側に保存された直前のラウンドの項目を指す可能性がある。これは 1 ターンの中（直前のラウンド）への参照に限られ、ターンをまたいで保存に頼らない。実際にどちらの形で返るかは実 API を呼んでいないため未確認で、S2 の実機確認で確かめる
- **代替案**:
  - Chat Completions — 形は単純だが、reasoning を次のラウンドへ送り返す手段が無く、推論モデルでは tool 呼び出しの後に推論が途切れる
  - `previous_response_id` で前の応答を参照する — 送る量は減るが、プロバイダ側の会話状態に依存し ADR 0003 決定 4 に反する
  - 送り返すときに reasoning の項目を落とす — プロバイダ側の保存に一切触れないが、ツールの後の推論が途切れる。公式の案内（手を加えずに渡す）にも反する

### 3. BYOK で許可するモデルの範囲（Q2・★オーナーの決定）

- **採用案**: **アプリに同梱する固定のモデルの一覧**をコアの定数として持つ。
  - 一覧（2026-09-27 オーナー決定）: Anthropic は `claude-sonnet-5`（既定）・`claude-haiku-4-5`、OpenAI は `gpt-6-sol`（既定）・`gpt-6-luna`
  - 一覧の各行は「プロバイダ・モデル ID・表示名・既定か・thinking／reasoning の指定の対応（チャットの `adaptive`＋`effort: low` と、それ以外の `disabled` を、そのモデルのどの値で送るか）」を持つ。OpenAI の行の reasoning の値は、そのモデルが受け付ける値を実装時に公式で確かめて決める（仮定 A6）
  - **一覧に無いモデルは、画面で選べない（S2）だけでなく、BYOK のバックエンドが送信前に拒否する（S1）**。`createClient(env)` はモデルを受け取らないため、関門は**各 BYOK のバックエンドの `streamRound`／`createRound` の入口（転送のポートを呼ぶ前）**に置き、モデルの一覧のモジュールが公開する 1 つの検査関数を両バックエンドが呼ぶ（プロバイダを引数に取り、他方のプロバイダのモデルも拒否する）。拒否の例外はそのバックエンドの `classifyError` で再試行不可と判定し、呼び出し元の既存の失敗の経路に乗る（チャットは失敗、ダッシュボードのひとこと・通知文面・会議の開始文はテンプレート）
  - **利用者が選んでいたモデルがアプリの更新で一覧から外れたときは、利用者が選び直すまで LLM を止める**（決定 Q2-3）。送信前の関門がそのまま担い、既定モデルへの移行はしない。「選び直してください」の案内は S2 の画面で出す
  - 一覧の更新はアプリの更新（#587）で行う
- **理由**: ボスの人格・ツール呼び出しの品質はモデル依存で、動作を確かめた候補に絞る（#575 の論点）。止める形（ii）は S1 の関門だけで済み、既定モデルへの移行と通知が要る形（i）より単純
- **代替案**: 一覧＋動作保証外の自由入力（品質のばらつき・問い合わせの負担）、プロバイダごとに 1 モデル固定（選択の余地が無い）、一覧をクラウドから配信（外部送信が増え ADR 0001 の改訂を要する）。一覧から外れたとき既定モデルへ移して通知する（料金が変わる切り替えになる）
- **影響範囲**: 新規のモデルの一覧のモジュール・BYOK（OpenAI）のバックエンド（新規）・**BYOK（Anthropic）のバックエンド（#581 S2 が作るモジュール。本機能の S1 は、その `streamRound`／`createRound` の入口に検査関数の呼び出しを、`classifyError` に拒否の例外の判定を足すことだけを変更してよい）**・S2 の設定画面

### 4. ADR 0003 旧決定 5〜9 の製品版への読み替え（Q3・親の決定）

| 旧決定 | 元の手段（Agent SDK 前提） | 製品版での読み替え | 担保 |
|---|---|---|---|
| 5 ビルトインツールの無効化 | ビルトインツール集合を空・許可判定コールバック | 要求に含めるツールは、アプリが定義した関数ツールだけ（プロバイダ側で実行されるツール・MCP の接続を含めない） | TS のテスト（要求本文のツールがすべて関数ツールで、名前が呼び出し元の渡したものと一致） |
| 6 キーを子プロセスへ渡さない | 子プロセスの環境から除外 | キーは Rust の通信層だけが持ち、TS は持たない | #581 で担保済み（ADR 0002 改訂の決定 3）。本機能は OpenAI の鍵にも同じ関門を通す |
| 7 セッション履歴の永続化の無効化 | Agent SDK の永続化を切る | プロバイダ側の会話状態を使わず、毎回 DB から組み立てた全文を送る（ADR 0003 決定 4 と同じ）。プロバイダ側での応答の保存はプロバイダの既定に任せる（決定 Q1） | TS のテスト（要求本文に `previous_response_id` が無い） |
| 8 テレメトリ・非必須通信の無効化 | 環境変数で切る | 製品版の LLM 送信はすべて Rust の宛先の表を通り、SDK を同梱しない（SDK 由来の通信が無い） | #581 の宛先の表のテスト・`core-entry.bundle.test.ts` |
| 9 自動フォールバックしない | `api` へ切り替えない | 失敗時に、別のプロバイダ・別の課金経路（BYOK ⇔ プラン込み）・一覧の別のモデルへ自動で切り替えない。チャットは失敗、ひとこと・通知文面・会議の開始文はテンプレートへ退避（既存の形） | TS のテスト（失敗時に他の宛先・他のモデルで送らない） |

- 記録の場所: ADR 0003 の末尾に「追補（製品版での旧決定 5〜9 の読み替え）」を加える（本体は書き換えない）。S1 の PR に含める

### 5. 保存した選択を送信先へ反映する経路（PR #625 の Codex の指摘・親の決定・S2）

- **採用案**: **LLM の選択（バックエンドとモデルの組）を、要求ごとに設定のスナップショットから解決する「選択の解決関数」を、合成ルート（エントリ）から注入する。**
  - 解決関数は設定のスナップショット（`SettingsSnapshot`）を受け取り、`{ backend, model }` を返す純粋関数とする。起動時にバックエンドを固定しない
  - **開発者用の版の解決関数**は、バックエンドを従来どおり環境変数 `LLM_BACKEND`（`resolveLlmBackend(env)`）から、モデルを従来どおり設定の `model` から決める（振る舞いを変えない）
  - **製品版の解決関数**は、保存したプロバイダとモデル（キーは仮定 A10）から、BYOK のバックエンド（`byok-anthropic`／`byok-openai`）とモデルを決める。**プロバイダが未選択・保存値が不正なときは、別のバックエンドや既定のプロバイダを補わず、「未選択」の失敗にする**（送信しない。ADR 0003 決定 9 の読み替え）。モデルがモデルの一覧から外れていた場合は、解決関数ではなくクリティカル設計決定 3 の送信前の関門が止める
  - **呼び出し元 6 モジュールは、モデルを読むのと同じスナップショットで解決関数を呼び、その結果のバックエンドでクライアントを作る**（プロバイダとモデルが別々の時点の値で組み合わさらないため。#618 の「1 ターン分の材料を 1 つのスナップショットで読む」と同じ規律）。チャットは、クライアントを作る位置を 1 ターン分のスナップショットを読んだ後へ移す
  - `createCoreApp` の `llmBackend` の引数と、4 モジュールの `resolveLlmBackend(env)` の直接の呼び出しは、解決関数に置き換える。コアは `LLM_BACKEND` の環境変数を直接読まない
- **理由**: モデルはすでに 6 経路とも要求ごとに設定から読んでいる（「実コードの実測」）。バックエンドだけが起動時・環境変数で決まっているため、保存した選択が送信先に届かない。解決を要求ごとに同じスナップショットから行えば、再起動なしで選択が反映され、プロバイダとモデルの組み合わせが崩れない。会話状態は持たない（毎回 DB から組み立てる）ため ADR 0003 決定 4 と両立し、#581 の設計（バックエンドはレジストリに登録し、名前で引く）もそのまま使える
- **代替案**:
  - 起動時に保存した選択を読んでバックエンドを固定し、保存時にアプリを作り直す — 作り直しの間の要求の扱いと、スケジューラ（通知文面）への伝搬が要る。再起動や作り直しを忘れると、画面の表示と実際の送信先がずれる
  - 呼び出し元ごとに設定を読み直してバックエンドを決める（解決関数を注入しない） — 6 か所に同じ規則が重複し、開発者用の版と製品版の差を各モジュールが知ることになる
- **影響範囲**: `core-app.ts`（`llmBackend` の引数を解決関数に置き換える）・`sessions/chat-messages-route.ts`・`sessions/session-summary.ts`・`sessions/sessions-routes.ts`・`sessions/meeting-opening.ts`・`dashboard/boss-comment.ts`・`reports/extract-evening-summary.ts`・`notifications/notification-body.ts`（とそれらを呼ぶスケジューラ・ルート）・開発者用の版のエントリ（`app.ts`・`index.ts`）・製品版のエントリ・設定の検証（`settings/settings-validation.ts`）（**クリティカル箇所: LLM 連携。変更時は人間レビュー必須**）
- **#581 S3 で入ったもの（2026-09-29・#581 のオーナーの決定 Q6）**: 次は #581 S3 で実装済みとし、#582 S2 では作り直さない。
  - 選択の解決関数の注入口: 解決関数は `(env, settings) → { backend, model }` の純粋関数で、LLM バックエンドと同じくモジュールのレジストリに登録する（仮定 A10 の「LLM バックエンドと同じレジストリ」を採った）。何も登録しないときは開発者用の解決関数（`resolveLlmBackend(env)` と設定の `model`）が使われる
  - 呼び出し元の置き換え: 上の 6 モジュールに、#585 で加わった催促の予約の文面（`nudge-plan/replan-nudges.ts`）を加えた 7 か所が、人格・モデルを読むのと同じ 1 つの設定のスナップショットで解決関数を呼ぶ。`createCoreApp`・`createApp` の `llmBackend` の引数は削除した。完了条件の見通しの 11・12（開発者用の版の維持）は #581 S3 の受入基準（S3-S1〜S3-S4・S3-S23）が固定する
  - 製品版の解決関数: 当面の固定の関数（常に `byok-anthropic` と設定の `model`）を製品版の web のエントリが登録する
  - **#582 S2 に残るもの**: 製品版の解決関数を「保存したプロバイダとモデルから決める関数」へ差し替えること（未選択・保存値が不正なときの「未選択」の失敗を含む）、選択の保存と画面、製品版のエントリへの BYOK（OpenAI）の登録、OpenAI のキーの登録・削除（#581 S3 のキーのコマンドは `openai` を拒否するため、受け付けるよう広げる）。完了条件の見通しの 1〜10 は S2 の範囲のまま（呼び出し元の差し替え口は #581 S3 のものを使う）
- **S2 の完了条件の見通し**（S2 を実装対象にするときに「受入基準」へ移す。経路ごとに分ける。いずれも模擬のバックエンドを 2 つ登録し、保存した選択を差し替えてテストで固定できる）:
  1. 保存した選択を変えると、次のチャットの要求は新しい選択のバックエンドへ送られる
  2. 保存した選択を変えると、次のセッション要約の要求は新しい選択のバックエンドへ送られる
  3. 保存した選択を変えると、次の会議の開始文の要求は新しい選択のバックエンドへ送られる
  4. 保存した選択を変えると、次のダッシュボードのひとことの要求は新しい選択のバックエンドへ送られる
  5. 保存した選択を変えると、次の夕会の要約抽出（日報）の要求は新しい選択のバックエンドへ送られる
  6. 保存した選択を変えると、次の通知文面の要求は新しい選択のバックエンドへ送られる
  7. 上の 1〜6 のそれぞれで、要求のモデルは新しい選択のモデルである
  8. チャットの 1 ターンの間に選択の保存が割り込んでも、そのターンの要求のバックエンドとモデルは同じスナップショットの組である（#618 の割り込みのテストと同じ形）
  9. 製品版の解決関数は、プロバイダが未選択のとき、どのバックエンドへも送らずに失敗する
  10. 保存した選択のバックエンドが登録されていないとき、別の登録済みのバックエンドへ送らずに失敗する
  11. 開発者用の版で `LLM_BACKEND` 未設定のとき、6 経路とも `claude-code` へ送る（現行の維持）
  12. 開発者用の版で `LLM_BACKEND=api` のとき、6 経路とも `api` へ送る（現行の維持）

## 機能全体の設計

### IF / API（S1 で固定する境界・名前は仮）

- **形式の変換器**（プロバイダの形式ごと。Anthropic 側の形は #581 S2 が定め、OpenAI 側はそれに合わせる）: 要求本文の組み立て（`ResolvedLlmRequest`・モデルの一覧の行・ストリーミングか → 本文）／ストリームの解釈（断片・`onTextDelta` → `BossLlmMessage`）／非ストリーミングの応答の解釈／エラーの分類（ステータス・`retry-after`・エラー本文 → `RetryDecision`）
- **Anthropic の形 → OpenAI Responses の対応**:

| Anthropic（コアの形） | OpenAI Responses |
|---|---|
| `system` | `instructions` |
| user の文字列 | `input` の `role: "user"` のメッセージ |
| assistant の文字列（DB の履歴） | `input` の `role: "assistant"` のメッセージ |
| assistant の `rawContent`（そのターンの前のラウンドの OpenAI の出力の項目） | `input` に手を加えずに並べる |
| user の `tool_result`（`tool_use_id`・`content`・`is_error`） | `type: "function_call_output"`（`call_id` = `tool_use_id`、`output` = `content`）。`is_error` は `output` の文字列に表す（仮定 A4） |
| `tools`（`name`・`description`・`input_schema`） | `type: "function"`（`name`・`description`・`parameters` = `input_schema`・`strict: false`） |
| `toolChoice` の `tool`（名前つき）／`auto`／`any`／`none` | `type: "function"`（同じ名前）／`"auto"`／`"required"`／`"none"` |
| `maxTokens` | `max_output_tokens` |
| `thinking`・`outputConfig.effort` | `reasoning.effort`（値はモデルの一覧の行の対応） |
| — | `store`・`previous_response_id` は含めない |

- **応答の対応**: `response.output_text.delta` → `onTextDelta`。完了時の出力のうち、`message` の `output_text` → `text` のブロック、`function_call`（`call_id`・`name`・`arguments` の JSON）→ `tool_use` のブロック（`id` = `call_id`、`input` = `arguments` を JSON として解釈した値）。出力の項目の配列全体 → `rawContent`。`status: "incomplete"` や `text`・`tool_use` が 1 つも無い応答は、`normalizeMessage` と同じくメタ情報だけをログに出す。ただし未完了の `function_call`（項目の `status` が completed でないもの、または incomplete な応答の中のもの）は引数を解釈せず、再試行不可の失敗として扱う（#637。打ち切りは同じ要求の再送で直らない）
- **エラーの分類**: 408・429・5xx は再試行可、他の 4xx は再試行不可（`isRetryableApiError` と同じ規則）。ただしエラー本文の `error.code` が `insufficient_quota` の 429 は再試行不可（残高・クォータ切れは再試行で直らない）。`retry-after` があれば待ち時間にする
- **Rust の通信層**（#581 のクリティカル設計決定 3 の「1 行ずつ足す」）: 宛先 `openai-responses` → `https://api.openai.com/v1/responses`、資格情報 `OpenAiBearer`（`authorization: Bearer <キー>` を付与。呼び出し元の `authorization` は既に捨てている）、保管の `Provider::OpenAi`（account `"openai"`）

### 実装計画（S1 のチケット分解の見通し）

1. モデルの一覧（コアの定数）と、一覧に無いモデルを送信前に拒否する関門（BYOK の Anthropic・OpenAI の両方）
2. OpenAI Responses の形式の変換器（要求本文の組み立て・SSE の解釈・非ストリーミングの解釈・`rawContent` の送り返し・エラーの分類）と BYOK（OpenAI）のバックエンドの実装（転送のポートは模擬で固定）
3. Rust の通信層に OpenAI の宛先・資格情報・保管の項目を 1 行ずつ追加（`cargo test`）
4. ADR 0003 の追補（旧決定 5〜9 の読み替え）

## スライス（出荷の単位）

> 決定 Q5。#579 S2 の器と #581 S3 が無い時点で出荷できる最小の単位として、形式の変換とモデルの一覧を S1 にした。

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | モデルの一覧と送信前の関門・OpenAI Responses の形式の変換器と BYOK（OpenAI）のバックエンド（転送のポートは模擬）・Rust に OpenAI の宛先と鍵の項目・ADR 0003 の追補 | 10-16 | #581 S2 がマージされてから（転送のポート・Anthropic の変換器・能力の宣言の上に作る）。これだけで、OpenAI で tool use のループ・強制呼び出し・reasoning の送り返しが成り立つことを模擬で固定できる |
| S2 | 製品版の器への配線: 保存した選択を要求ごとに送信先へ反映する経路（製品版の解決関数を保存した選択から決める関数へ差し替える。**解決関数の注入口と呼び出し元 7 か所の置き換えは #581 S3 で済み**・クリティカル設計決定 5）、製品版のエントリへの BYOK（OpenAI）の登録、プロバイダ・モデルの選択の画面と保存（一覧から外れたモデルの選び直しの案内を含む）、OpenAI のキーの登録・削除の画面、両プロバイダでのチャット・朝会・夕会の実機確認（ボスの人格・ツールの安定性・reasoning の送り返しの実際の形を人間が判定） | 18-28 | S1・#581 S3・#579 S2 がマージされてから（動作確認は #580 S2 の後） |

実装対象: S1

## やらないこと

- 中継サーバー・プラン込みの経路・既定の低価格モデルの選定（理由: #583 の範囲）
- アカウント・ライセンス・料金（理由: #584 の範囲）
- プラン込みと BYOK の切り替えの画面と、その選択の保存（理由: 課金経路の選択は #583・#584 の範囲。決定 Q6）
- バックエンドの名前の分岐を能力の宣言へ置き換えること・SDK を使わない Anthropic のクライアント・転送のポート（理由: #581 S2 の範囲。決定 Q5）
- Tauri の器・Tauri のコマンドの公開・製品版の DB（理由: #579 S2・#581 S3・#580 S2）
- 開発者用の版で OpenAI を使えるようにすること（理由: オーナーの決定 Q5。開発者用の版の ADR 0001 決定 2 を変えない）
- `store` の指定（理由: オーナーの決定 Q1。プロバイダの既定に任せる）
- 実キーでの手動確認（理由: 決定 Q4。実機での確認は S2）
- Anthropic・OpenAI 以外のプロバイダ（理由: ADR 0011 決定 10 の範囲外）
- モデルの一覧をクラウドから配信して更新すること（理由: 外部送信が増え ADR 0001 の改訂を要する。一覧の更新はアプリの更新で行う）
- 開発者用の版の `api`・`claude-code` バックエンドと自由入力のモデル設定の変更（理由: ADR 0003 改訂の決定 2・ADR 0002 改訂の決定 5）
- ADR 0003 本体の書き換え（理由: 追補に留める。決定 Q3）
- 画像・文書の入力・プロンプトキャッシュ（理由: 現行のボスが使っていない。YAGNI）

## 受入基準（S1）

> テストはすべて模擬の転送のポートと、公式ドキュメントの形に合わせた手書きの応答で行い、実 API は呼ばない（決定 Q4）。

**モデルの一覧と送信前の関門**

- [ ] モデルの一覧の Anthropic の行は `claude-sonnet-5` と `claude-haiku-4-5` の 2 行だけである
- [ ] モデルの一覧の Anthropic の既定は `claude-sonnet-5` である
- [ ] モデルの一覧の OpenAI の行は `gpt-6-sol` と `gpt-6-luna` の 2 行だけである
- [ ] モデルの一覧の OpenAI の既定は `gpt-6-sol` である
- [ ] モデルの一覧に無いモデル（例: `gpt-6-astra`）の要求を BYOK（OpenAI）のバックエンドで送ろうとすると失敗し、転送のポートは一度も呼ばれない（ストリーミング・非ストリーミングの両方）
- [ ] モデルの一覧に無いモデル（例: `claude-opus-5-5`）の要求を BYOK（Anthropic）のバックエンドで送ろうとすると失敗し、転送のポートは一度も呼ばれない（ストリーミング・非ストリーミングの両方）
- [ ] 他方のプロバイダの一覧にあるモデル（例: BYOK（OpenAI）に `claude-sonnet-5`）の要求を送ろうとすると失敗し、転送のポートは一度も呼ばれない
- [ ] モデルの一覧に無いモデルによる拒否は、そのバックエンドの分類で再試行不可である

**OpenAI の要求本文**

- [ ] BYOK（OpenAI）で送ると、転送のポートに渡る宛先の名前は `openai-responses` である
- [ ] BYOK（OpenAI）の要求本文の `model` は、呼び出し元が指定したモデル ID である
- [ ] BYOK（OpenAI）の要求本文に `store` の項目が無い（ストリーミング・非ストリーミングの両方）
- [ ] BYOK（OpenAI）の要求本文に `previous_response_id` の項目が無い（ツールのループの 2 ラウンド目を含む）
- [ ] BYOK（OpenAI）の要求本文の `tools` の各要素は `type: "function"` かつ `strict: false` である
- [ ] BYOK（OpenAI）の要求本文の `tools` の名前の集合は、呼び出し元が渡したツールの名前の集合と一致する
- [ ] BYOK（OpenAI）の要求本文の `tools` の各要素の `parameters` は、呼び出し元が渡したツールの `input_schema` と一致する
- [ ] BYOK（OpenAI）の要求本文の `instructions` は、呼び出し元が渡した `system` と一致する
- [ ] 呼び出し元が渡した user・assistant の文字列の履歴は、要求本文の `input` に同じ順・同じ役割・同じ本文で並ぶ
- [ ] 呼び出し元が `toolChoice` で `submit_evening_summary` を強制すると、要求本文の `tool_choice` は `type: "function"` で名前が `submit_evening_summary` である
- [ ] 要求本文の `max_output_tokens` は、呼び出し元の `maxTokens` と一致する
- [ ] 呼び出し元が `thinking: { type: "disabled" }` を渡すと、要求本文の `reasoning.effort` は、モデルの一覧のそのモデルの行が「推論なし」に対応づけた値である
- [ ] 呼び出し元が `thinking: { type: "adaptive" }` と `effort: "low"` を渡すと、要求本文の `reasoning.effort` は、モデルの一覧のそのモデルの行が「チャット」に対応づけた値である

**OpenAI の応答の解釈**

- [ ] 模擬の応答が `response.output_text.delta` を 2 回返すと、`onTextDelta` は同じ順で 2 回、それぞれの差分の文字列で呼ばれる
- [ ] 模擬の応答の断片の区切りが SSE のイベントの途中にあっても、`onTextDelta` が受け取る文字列の連結は、応答の差分の連結と一致する
- [ ] 模擬の応答の完了時の出力に `function_call` の項目があると、`BossLlmMessage.content` に同じ `call_id` を `id` に持ち、同じ `name` と、`arguments` を JSON として解釈した値を `input` に持つ `tool_use` のブロックが入る
- [ ] 模擬の応答の完了時の出力に `message` の `output_text` があると、`BossLlmMessage.content` にその文字列の `text` のブロックが入る
- [ ] 模擬の非ストリーミングの応答（JSON）でも、`function_call` の項目は `tool_use` のブロックに、`output_text` は `text` のブロックになる

**ツールのループ（1 ターンの中の送り返し）**

- [ ] ツールのループで 2 ラウンド目を送るとき、要求本文の `input` には 1 ラウンド目の出力の項目（reasoning の項目を含む）が、1 ラウンド目の応答と同じ値で、同じ順で含まれる
- [ ] ツールのループで 2 ラウンド目を送るとき、要求本文の `input` にはツールの結果が、1 ラウンド目の `call_id` を持つ `function_call_output` として、1 ラウンド目の出力の項目の後ろに含まれる
- [ ] ツールの実行が失敗（`isError: true`）すると、`function_call_output` の `output` はエラーであることを示す文字列になり、成功時と区別できる

**エラーの分類と自動で切り替えないこと**

- [ ] BYOK（OpenAI）で応答のステータスが 429 のとき、分類は再試行可である
- [ ] BYOK（OpenAI）で応答のステータスが 429 で `retry-after` が秒数のとき、分類の待ち時間はその秒数をミリ秒にした値である
- [ ] BYOK（OpenAI）で応答のステータスが 429 でエラー本文の `error.code` が `insufficient_quota` のとき、分類は再試行不可である
- [ ] BYOK（OpenAI）で応答のステータスが 401・400 のとき、分類は再試行不可である
- [ ] BYOK（OpenAI）で応答のステータスが 500・503 のとき、分類は再試行可である
- [ ] BYOK（OpenAI）の送信が失敗しても、転送のポートへ `openai-responses` 以外の宛先の名前の要求は送られない
- [ ] BYOK（OpenAI）の送信が失敗しても、要求本文の `model` は変わらない
- [ ] 夕会の要約抽出を BYOK（OpenAI）のバックエンドで呼ぶと、要求本文の `tool_choice` は `submit_evening_summary` の強制である

**Rust の通信層**

- [ ] 製品版の宛先の表は `anthropic-messages` と `openai-responses` の 2 行だけである
- [ ] 製品版の宛先の表の `openai-responses` の送信先は `https://api.openai.com/v1/responses` である
- [ ] `openai-responses` へ送ると、模擬サーバーが受けた要求の `authorization` は `Bearer ` と、保管のポートに登録した OpenAI のキーを連結した値である
- [ ] `openai-responses` へ送ると、模擬サーバーが受けた要求に `x-api-key` のヘッダが無い
- [ ] `openai-responses` へ送ると、模擬サーバーが受けた要求に `anthropic-version` のヘッダが無い
- [ ] 呼び出し元が要求の `headers` に `authorization` を含めても、`openai-responses` の模擬サーバーが受けた要求の `authorization` は保管した OpenAI のキーから作った値である
- [ ] Anthropic と OpenAI の両方のキーを登録した状態で `anthropic-messages` へ送ると、模擬サーバーが受けた要求の `x-api-key` は Anthropic のキーである
- [ ] Anthropic と OpenAI の両方のキーを登録した状態で `anthropic-messages` へ送ると、模擬サーバーが受けた要求のどのヘッダにも OpenAI のキーの文字列が現れない
- [ ] OpenAI のキーが未登録のとき `openai-responses` へ送ると、模擬サーバーへ要求を送らずに「キー未登録」の失敗で終わる
- [ ] 保管のポートのメモリ実装で、OpenAI のキーを登録しても、Anthropic の登録の有無は変わらない
- [ ] 失敗の値の `Debug` の文字列に、登録した OpenAI のキーの文字列が含まれない
- [ ] 失敗の値の `Display` の文字列に、登録した OpenAI のキーの文字列が含まれない

**ADR と品質ゲート**

- [ ] ADR 0003 の末尾に、旧決定 5〜9 のそれぞれについて製品版での扱いを書いた追補がある
- [ ] ADR 0003 の本体（追補より前の節）は変わっていない
- [ ] `core-entry.bundle.test.ts` が合格する（OpenAI の変換器が外部の指定子・SDK を持ち込まない）
- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:tz` が合格する
- [ ] `npm run test:rust` が合格する

## 仮定（軽微・可逆）

- A1: 仕様ファイルの名前は `llm-provider-abstraction.md`
- A2: 能力の宣言の項目の名前・型（本仕様の「ループを自分で回すか」「強制に対応するか」「応答長を制限できるか」）と BYOK（Anthropic）のバックエンドのモジュール名は #581 S2 の実装が決め、本機能はそれに合わせる（本仕様に書いた名前は仮）。バックエンド名は仮に `byok-anthropic`・`byok-openai`（#581 S2 の命名に合わせてよい）、宛先の名前は `openai-responses`、資格情報は `OpenAiBearer`、キーチェーンの account は `openai`。実装で決めてよい
- A3: 非ストリーミングの呼び出し（`createRound`）は `stream: false` で送り、JSON の応答を解釈する
- A4: OpenAI には `is_error` が無いため、ツールの失敗は `function_call_output` の `output` の文字列でエラーと分かる形にする（書式は実装で決めてよい）
- A5: Rust の応答ヘッダの許可に OpenAI の `x-request-id` を足すかは実装で決めてよい（診断用で振る舞いに関わらない）
- A6: モデル ID（とくに `claude-haiku-4-5` がエイリアスのまま使えるか）・`reasoning.effort` の各モデルの対応・Responses の項目の形（SSE のイベントと完了時の JSON のフィールドの形を含む。模擬の応答はこの形に合わせて手書きする）は、実装前に公式ドキュメントを読み直し、食い違ったら仕様を直す
- A7: `store` を指定しないとき、reasoning の項目は保存済みの項目の参照になりうる（公式ドキュメントは「ステートレスの形」を `store: false` と ZDR に限る）。変換器は項目の形を解釈せずにそのまま渡すため、どちらの形でも同じコードで動く前提に立つ。実際の形は実 API を呼んでいないため未確認で、S2 の実機確認で確かめる。確かめた結果、ADR 0003 決定 4 に反する依存（ターンをまたぐ参照）が見つかった場合は、その時点で親・オーナーへ上げる。S1 の PR 本文には、A7 が S2 の実機確認まで未検証であることを申し送りとして書く
- A8: 新規のモジュールは仮に `server/src/llm/model-catalog.ts`（モデルの一覧と検査関数）・`server/src/llm/backends/byok-openai-backend.ts`（BYOK〔OpenAI〕のバックエンドと OpenAI Responses の形式の変換器）に置く。#581 S2 の配置に合わせて変えてよい
- A9: 検査関数は仮に `assertByokModelAllowed(provider, modelId)`（許可外なら専用の例外を投げる）とする。名前は実装で変えてよい
- A10: 製品版の選択は設定（`settings` の key-value）に、開発者用の版の `model` とは別のキー（仮に `byok_provider`・`byok_model`）で保存する。キーの名前・保存の形（プロバイダごとにモデルを覚えるか）は S2 の実装で決めてよい。選択の解決関数の名前と注入の仕組み（`createCoreApp` の引数か、LLM バックエンドと同じレジストリか）も S2 の実装で決めてよい
