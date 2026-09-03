# チャットの応答生成を停止できるようにする

## 概要

ボスの応答生成中に、ユーザーが生成を停止できるようにする。停止は**中断だけ**を担い、既に起きた状態（ユーザーの発言・部分応答・活動イベント・ツール実行の副作用）は一切取り消さない。

## 背景・目的

チャットで誤って送信してしまっても、現状は止める手段が無くボスの応答が生成しきるまで待つしかない（Issue #254）。停止の経路がフロント・サーバのどちらにも存在せず、ブラウザ側で接続を切ってもサーバの LLM 呼び出しは走り続け、完了すればボスメッセージが永続化される。

挙動は **ChatGPT の停止ボタン／Claude Code の中断（Ctrl+C）に合わせる**（2026-08-29 オーナー判断）。すなわち生成はその場で打ち切るが、ユーザーの発言・そこまで届いた部分応答・`chat_message` 活動イベントは残し、ツール実行の副作用は巻き戻さない。送信済み発言の編集・やりなおしは別機能（Issue #255）でありスコープ外。

## ユーザーストーリー

セルフマネジメント支援アプリの利用者として、誤送信や意図と違う方向へ進み始めた応答を停止ボタン（または ESC）で止めて、生成しきるのを待たずに次の発言へ移りたい。

## 機能要件

- [ ] ボスの応答生成中に、送信ボタンの位置に現れる停止ボタンで生成を停止できる
- [ ] ボスの応答生成中に、ESC キーでも生成を停止できる
- [ ] 停止するとサーバ側の LLM 呼び出しが実際に打ち切られる（呼びっぱなしにしない）
- [ ] 停止してもユーザーの発言は履歴に残る
- [ ] 停止時点までに届いていたボスの部分応答が履歴に残る
- [ ] 中断された部分応答は、通常の応答と区別できる形で表示される
- [ ] 部分応答が 1 文字も無いまま停止した場合は、ボスメッセージ行を作らない
- [ ] 中断は DB に永続化される
- [ ] リロード後、永続化された中断状態がボス応答に反映されて表示される
- [ ] 停止後、次の送信が正常にできる
- [ ] 停止しても `chat_message` 活動イベントは残る
- [ ] 停止してもツール実行の副作用は巻き戻さない
- [ ] 停止によって、ツール実行の副作用に関する追加の通知は表示されない

## 非機能要件

- セキュリティ: 中断経路の追加によって [ADR 0002](../adr/0002-api-key-and-llm-call-path.md) 決定 4 の「失敗時のログに残すのはエラークラス名まで」を緩めない。中断時にも LLM のエラーメッセージ本文をログへ出さない。
- 信頼性: 既存のタイムアウト・リトライ方針（`runWithTimeoutAndRetry` の「タイムアウト予算は呼び出し全体で共有」「副作用発生後はリトライしない」）を変更しない。

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono の `streamSSE` / better-sqlite3 / React）。中断機構を新規に発明せず、**既に配線済みの `AbortSignal` 経路を再利用**する。
- 変更対象:
  - `server/src/db/migrate.ts`（user_version 5 の追加）
  - `server/src/sessions/message.ts` / `messages-repository.ts`
  - `server/src/llm/claude-client.ts`（外部 signal の受け口）
  - `server/src/sessions/chat-messages-route.ts`（切断検知と中断永続化）
  - `web/src/chat.ts` / `chat-api.ts` / `use-chat.ts` / `ChatView.tsx` / `ChatView.css`
- 既存コードとの関係:
  - `server/src/llm/backends/api-backend.ts` は `client.messages.stream(params, { signal })` で SDK 呼び出しへ signal を渡し済み。
  - `server/src/llm/backends/claude-code-backend.ts` は受け取った signal から `AbortController` を張り直して Agent SDK の `query()` へ渡し済み。
  - **不足しているのは「外から与えた signal が `runWithTimeoutAndRetry` へ届く経路」だけ**。
- スコープ外: 送信済み発言の編集・やりなおし（#255）、`server/src/boss/persona-prompt.ts`（#257）、LLM コンテキストの当日横断（#270）、生成中のテキストエリア入力解禁。

## 画面・API設計

### API

エンドポイントの追加は無い。`POST /api/sessions/:id/messages` の SSE ストリームを**クライアントが切断すること自体**が停止の合図になる。

`GET /api/sessions/:id/messages` の各要素に `interrupted` が加わる:

```jsonc
{
  "id": 12,
  "session_id": 3,
  "role": "boss",
  "content": "まずは見積もりを",
  "interrupted": 1,        // 0 = 完結した応答 / 1 = 途中で終わった応答
  "created_at": "2026-09-04T10:00:00.000Z"
}
```

### 画面

- 生成中、送信ボタン（`ChatView.tsx` の `type="submit"` ボタン）は**停止ボタンへ差し替わる**。
- 生成中の ESC キーで停止する。IME 変換中（`isComposing`）の ESC は無視する。
- 生成中もテキストエリアは `disabled` のまま（本 Issue では変更しない）。
- **ESC のキーハンドラをテキストエリアへ付けてはならない**: 生成中のテキストエリアは `disabled` であり、`disabled` な要素はフォーカスを受けずキーイベントも発火しないため、既存の Enter 送信と同じ場所（`onKeyDown` on textarea）に ESC を足すと**動かない**。ESC は生成中だけ購読するドキュメントレベル（または `.chat-view` 相当のコンテナ）のリスナーとして実装し、購読の解除まで面倒を見ること。
- 中断されたボス応答は、通常の応答と区別できる専用の見た目を持つ。既存の `.chat-tool-notice`（中央に浮かぶ小さな札）・`.chat-boundary`（左右いっぱいの罫線）とは**衝突しない第 3 の語彙**として作る。

## クリティカル設計決定

### DBスキーマ変更 — 中断の記録方法

- **採用案**: `messages` テーブルに `interrupted INTEGER NOT NULL DEFAULT 0` を **user_version 5** の新規マイグレーションとして追加する。
- **理由**: リロード後も中断が分かる必要があり（機能要件）、それを満たせるのは永続化だけである。[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4 のとおり既存 version は書き換えず新 version として追加する。同 決定 6「算出できるものは保存しない」には抵触しない — 中断はデータから決定的に再現できない事実である。SQLite に真偽型が無いため既存慣習に合わせて `INTEGER` を使う。
- **列の意味の定義（重要）**: `interrupted` は「**この応答は途中で終わっており完結していない**」ことを表す。**ユーザー起因の停止に限らない** — LLM 失敗・タイムアウトで部分テキストが永続化される既存のエラー経路でも `1` を立てる。画面に出したい情報は「この応答は途中で終わっている」であって原因ではないため。**この定義はマイグレーションのコメントと、少なくとも 1 本のテスト名に明記して固定する**（後から読む人が「ユーザー起因のみ」と誤読すると、エラー経路の扱いが黙って変えられるため）。
- **代替案**:
  - 永続化せず画面表示だけで示す — 却下。リロードすると通常の応答と区別できなくなり、機能要件を満たせない。
  - `content` に印を埋める — 却下。表示都合をデータへ混ぜることになり、[ADR 0006](../adr/0006-renderer-owns-structure.md) の向きに反する。
- **影響範囲**: `server/src/db/migrate.ts`、`server/src/sessions/message.ts` の `Message`、`web/src/chat.ts` の `ChatMessage`。`listMessagesBySessionId` は `SELECT *` なので列を足せば読み出しは自然に通る。

### 外部連携（LLM 呼び出し）— 停止の伝え方と中断の判定

- **採用案**: 専用の停止エンドポイントは作らず、**クライアントが `fetch` の `AbortSignal` で接続を切ること**を停止の合図とする。サーバは `c.req.raw.signal` を起点に中断を検知し、その signal を LLM ファサードへ渡す。`runWithTimeoutAndRetry` は外部 signal を引数で受け取り、内部のタイムアウト用 `AbortController` と連結する。**エラー型は増やさない** — 中断由来かどうかはルート側が `c.req.raw.signal.aborted` を見て判定する。
- **理由**: 停止と同時の状態取り消しが無くなったため、進行中ストリームの識別子を設計・保持する専用エンドポイントは過剰（YAGNI）。`c.req.raw.signal` は既に `AbortSignal` 型なのでファサードへそのまま渡せる。エラー型を増やさないことで、`runWithTimeoutAndRetry` の既存の retry / timeout セマンティクスとそれを固定している既存テスト群に触れずに済む。
- **切断検知が Node 上で成立することの根拠**: `hono@4.12.27` の `streamSSE` は `c.req.raw.signal → stream.abort()` の配線を古い Bun でしか張らないが、Node では別経路が通っている。`@hono/node-server` の `writeFromReadableStreamDefaultReader` が `writable.on("close")` で `reader.cancel()` を呼び、それが `StreamingApi` の `responseReadable.cancel` → `abort()` に至る。加えて `makeCloseHandler` が `c.req.raw.signal` 自体も abort する。実サーバを立てた実測で `c.req.raw.signal` の abort・`stream.onAbort()` の発火・`stream.aborted === true` の 3 つすべてを確認済み。
- **退行リスクと対策（重要）**: この配線は Hono / `@hono/node-server` のバージョン更新で**黙って壊れうる**。`StreamingApi.write` は書き込みエラーを握り潰すため、壊れても例外は出ず「止めたのに走り続ける」状態へ静かに戻るだけである。**「クライアント切断 → LLM 呼び出しが abort → 部分応答が `interrupted=1` で永続化される」をサーバ側の統合テストで固定する**（省略しない）。
- **代替案**: 専用の停止エンドポイント（`POST .../messages/stop`）— 却下。進行中ストリームの識別子を持つ設計が要り、要件に対して過剰。
- **影響範囲**: `server/src/llm/claude-client.ts` の `runWithTimeoutAndRetry` / `dispatchStream` / `streamBossMessage`、`server/src/sessions/chat-messages-route.ts`。両バックエンドの実装（`api-backend.ts` / `claude-code-backend.ts`）は既に signal を尊重しており**変更しない**。

## 機能全体の設計

### アーキテクチャ決定

停止は「新しい中断機構」ではなく、**既存の `AbortSignal` チェーンに外部からの入口を 1 つ足す**変更として実装する。

```
[ブラウザ] 停止ボタン / ESC
   → AbortController.abort()
   → fetch(signal) が切断
   → [Node] @hono/node-server が接続断を検知
   → c.req.raw.signal が abort
   → streamBossMessage(..., { signal })          ← 新設の入口
   → dispatchStream(..., signal)                 ← 素通し
   → runWithTimeoutAndRetry(attempt, hasSideEffect, { signal })  ← 外部 signal を内部 controller に連結
   → api:         client.messages.stream(params, { signal })      （既存・変更なし）
     claude-code: query({ options: { abortController } })         （既存・変更なし）
```

**中断と完了のレースは「完了が勝つ」**（論点 5 の決定）。`streamBossMessage` が正常 resolve した時点で応答は完成しているため、その後に abort が観測されても `interrupted` は立てない。全文が届いているのに「中断されました」と表示するのは事実に反するため。

**クライアント側の中断表示は、ローカルに保持している `streamingText` をそのまま中断済みエントリとしてタイムラインへ積む**（停止時はサーバから `done` イベントが届かないため）。サーバが永続化した行はリロード時に再構築される。

**リトライは既存設計のまま抑止される**: `trackSideEffects` はテキストが 1 文字でも流れた時点で `hasSideEffect()` を `true` にするため、中断後にリトライが走ることはない。追加の抑止は要らない。

### IF / API

チケット間で共有が要る境界は次の 3 点。

```ts
// server/src/sessions/message.ts
export interface Message {
  id: number;
  session_id: number;
  role: MessageRole;
  content: string;
  /** 0 = 完結した応答 / 1 = 途中で終わった応答（ユーザー起因の停止に限らない） */
  interrupted: number;
  created_at: string;
}

// server/src/llm/claude-client.ts
export interface StreamBossMessageOptions {
  /** 呼び出し元が中断を要求するための signal。未指定なら従来どおり
   *  タイムアウトのみが中断の契機になる。 */
  signal?: AbortSignal;
}
export async function streamBossMessage(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  callbacks?: StreamBossMessageCallbacks,
  options?: StreamBossMessageOptions,
): Promise<BossLlmMessage>;

// web/src/chat-api.ts
export async function sendChatMessage(
  sessionId: number,
  content: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void>;
```

`useChat` の戻り値に `stop: () => void` を追加する。

### データモデル

`ChatEntry` の `kind: "message"` に、中断済みかどうかを表すフィールドを持たせる（既存の `kind: "tool"` / `kind: "boundary"` は変更しない）。

### 実装計画（チケット分解の見通し）

依存順に 4 チケットを想定する。最終分解は `/create-ticket` で行う。

1. **DB スキーマと型の追加**（server + web の型）— user_version 5 のマイグレーション、`Message` / `ChatMessage` への `interrupted` 追加。他の 3 つが依存する土台。
2. **LLM ファサードへの外部 signal 配線**（server）— `runWithTimeoutAndRetry` / `dispatchStream` / `streamBossMessage`。1 とは独立に着手できる。
3. **チャットルートの切断検知と中断永続化**（server）— 1 と 2 に依存。統合テストで切断 → abort → `interrupted=1` 永続化を固定する。
4. **Web の停止経路と停止 UI**（web）— 1 に依存。`chat-api` / `use-chat` / `ChatView` / CSS。

## 受入基準

### DB スキーマ

- [ ] AC-1: `messages` テーブルに `interrupted` 列が user_version 5 のマイグレーションで追加され、既定値は `0` である
- [ ] AC-2: `interrupted` の意味が「その応答が途中で終わっており完結していない」ことであり、ユーザー起因の停止に限らないことが、マイグレーションのコメントと 1 本以上のテスト名に明記されている
- [ ] AC-3: user_version 4 の既存 DB を 5 へ移行しても既存の `messages` 行は失われず、それらの `interrupted` は `0` になる
- [ ] AC-4: `GET /api/sessions/:id/messages` の応答要素に `interrupted` が含まれる

### サーバ: 中断の検知と永続化

- [ ] AC-5: チャットの SSE ストリームをクライアントが切断すると、LLM 呼び出しへ渡した `AbortSignal` が abort される
- [ ] AC-6: クライアント切断時、それまでに配信済みのテキストが `interrupted=1` のボスメッセージとして永続化される
- [ ] AC-7: クライアント切断時、配信済みのテキストが 1 文字も無ければボスメッセージ行を作らない
- [ ] AC-8: クライアント切断が起きても、その送信のユーザー発言行は履歴に残る
- [ ] AC-9: クライアント切断が起きても、その送信の `chat_message` 活動イベントは残る
- [ ] AC-10: `streamBossMessage` が正常 resolve した後にクライアント切断が観測された場合、ボスメッセージは `interrupted=0` で永続化される
- [ ] AC-11: 既存のエラー経路（LLM 呼び出しの失敗）で永続化される部分テキストは `interrupted=1` になる
- [ ] AC-12: クライアント切断が無いまま呼び出し全体のタイムアウトに達した場合、従来どおりタイムアウトとして扱われる
- [ ] AC-13: 中断時のログに LLM のエラーメッセージ本文が出力されない（ADR 0002 決定 4）

### サーバ: LLM ファサード

- [ ] AC-14: `runWithTimeoutAndRetry` は外部から渡された `AbortSignal` の abort によって実行中の attempt を打ち切る
- [ ] AC-15: 外部 `AbortSignal` を渡さない既存の呼び出しは、タイムアウト・リトライの挙動が変わらない
- [ ] AC-16: 外部 `AbortSignal` は `api` バックエンドの SDK 呼び出しへ渡る
- [ ] AC-17: 外部 `AbortSignal` は `claude-code` バックエンドの `query()` が受け取る `AbortController` へ伝播する
- [ ] AC-18: 中断されたあと、同じ呼び出し内でリトライが行われない

### Web: 停止の経路

- [ ] AC-19: `sendChatMessage` は `AbortSignal` を受け取り、`fetch` へ渡す
- [ ] AC-20: `useChat` は生成中に生成を打ち切る `stop` を公開する
- [ ] AC-21: `stop` を呼ぶと `sending` が `false` に戻る
- [ ] AC-22: `stop` の直後に `send` を呼ぶと、その送信がエラーを起こさずに開始され、ストリーミング応答を受信できる
- [ ] AC-23: `stop` によって停止した場合、画面のエラー表示は発生しない
- [ ] AC-24: `stop` によって停止した時点で `streamingText` が空でなければ、その内容が中断済みのボス応答としてタイムラインに残る
- [ ] AC-24b: `stop` によって停止した時点で `streamingText` が空であれば、タイムラインにボス応答は追加されない
- [ ] AC-25: `stop` によって停止した場合、`streamingText` は空に戻る
- [ ] AC-26: 生成中でないときに `stop` を呼んでも何も起きない

### Web: 画面

- [ ] AC-27: 生成中は送信ボタンが停止ボタンへ差し替わる
- [ ] AC-28: 停止ボタンを押すと生成が停止する
- [ ] AC-29: 生成中でないときは停止ボタンではなく送信ボタンが表示される
- [ ] AC-30: 生成中に ESC キーを押すと生成が停止する
- [ ] AC-31: IME 変換中（`isComposing`）の ESC キーでは生成が停止しない
- [ ] AC-32: 生成中でないときの ESC キーでは何も起きない
- [ ] AC-33: 中断されたボス応答は、通常のボス応答と区別できる専用のクラス名を持って表示される
- [ ] AC-34: 中断表示のクラス名は `.chat-tool-notice` および `.chat-boundary` のいずれとも異なる
- [ ] AC-35: リロード後も、サーバが `interrupted=1` で保存したボス応答が中断済みとして表示される
- [ ] AC-36: 生成中もテキストエリアは `disabled` のままである
- [ ] AC-37: 停止してもタイムライン上の既存のツール実行通知は残る
- [ ] AC-38: 停止によって、ツール実行の副作用に関する新たな通知はタイムラインへ追加されない
