# セッション不在 404 の応答の形（3 エンドポイント横断）

## 概要

パスの `:id` が指すセッションが存在しないときに 3 つのエンドポイントが返す 404 を、日本語の `error` と安定した `code` を持つ同じ形に揃える。あわせて、これらの 404 を検証しているテストがステータスと「`error` が文字列であること」しか見ていない緩さを締め、変異で担保されていることまで確認する。

**サーバの応答契約とそのテストだけを変える。** web は 1 行も変えない（`chat-api.ts` が既に `code` を透過するため、契約を足すだけで受け取れる）。

本件は [`chat-route-error-response-shape.md`](chat-route-error-response-shape.md)（#477）の決定 1 で**代替案 C として範囲外に切り出された**課題である（Issue #494）。

## 背景・目的

### 課題の性格（「ユーザーに英語が出る不具合」ではない）

セッションを削除する経路が本番コードに無いため、この 404 は現在の UI からは到達しない（下記 (F)）。したがって本件が解くのは**利用者に見えている不具合ではなく、防御的エラー契約の不揃いと、それを守るテストの緩さ（潜在欠陥）**である。

このため**受入基準に「画面に日本語が出る」を書かない**（通常操作では到達せず検証できない）。基準はサーバの応答契約（ボディの形）と、テストが変異で落ちること（テストの締まり）で書く。

### 現状の確証（`4106645` 時点の実コード）

**(A) セッション不在の 404 は 3 箇所で、いずれも英語・`code` なし。他に同種の箇所は無い。**

| ファイル:行 | エンドポイント | 応答 |
|---|---|---|
| `server/src/sessions/chat-messages-route.ts:161` | `POST /api/sessions/:id/messages` | `` { error: `session ${rawId} not found` } `` / 404 |
| `server/src/sessions/sessions-routes.ts:270` | `POST /api/sessions/:id/end` | `` { error: `session ${rawId} not found` } `` / 404 |
| `server/src/sessions/sessions-routes.ts:328` | `GET /api/sessions/:id/messages` | `` { error: `session ${c.req.param("id")} not found` } `` / 404 |

`server/src` の本番コードで `not found` を含む応答を全件確認し、セッション不在はこの 3 箇所だけである。HTTP でセッション id を受け取る経路はほかに `POST /api/reports/generate` の**ボディ**の `eveningSessionId` があるが、不在時は 404 ではなく 409 `evening_session_required` を返す（`generate-daily-report.ts:75-89`（`:81` で id を引き、不在なら対象夕会なし扱い）→ `reports-routes.ts:141-142`。ADR 0008 決定 2 の意図した契約）。

**(B) 数値でない id も同じ 404 分岐に入る。** 3 箇所とも `Number(rawId)` をそのままリポジトリへ渡し（`chat-messages-route.ts:156-159`・`sessions-routes.ts:244-253` / `:268`・`:324-326`）、`Number("abc")` は `NaN` になって該当行が無く、同じ 404 に落ちる。専用の分岐は無い。`sessions-routes.test.ts:535-541` が `GET /:id/messages` についてだけこれをステータスで確認している（実行して pass を確認済み）。

**(C) 評価順で 404 より前に別の応答が返る経路は無い。**

- `POST /:id/end`: 404 判定（`:268-271`）より前にメンタリングゲート（`:258-266`・409 `mentoring_required`）があるが、`isBlockedByMentoringGate` は `before === undefined` のとき `false` を返す（`:153-155`）。不在のセッションに 409 が先に返ることは無い
- `POST /:id/messages`: セッション 404（`:159-162`）はボディのバリデーション 400（`:164-168`）と `mentoringTaskId` の 404（`:180-182`）より前にある

**(D) 該当テストは 404 の形を区別できていない。** `chat-messages-route.test.ts:129-142`・`sessions-routes.test.ts:525-533`・`:576-585` はいずれも `expect(res.status).toBe(404)` と `expect(typeof body.error).toBe("string")` まで、`:535-541`（数値でない id）はステータスのみを照合する。**応答を任意の文字列の `error` に変えても、`code` を落としても緑のまま**である。

**(E) web は 404 のステータスや英語の文言で分岐していない。**

- `web/src/chat-api.ts:20-43` の `ChatApiError` / `toChatApiError` がボディの `code` を透過する。`endSession`・`fetchSessionMessages`・`sendChatMessage` はいずれも `!response.ok` でそれを throw する
- `web/src/use-chat.ts` が `code` で分岐するのは `mentoring_required`（`:832`）だけで、それ以外の失敗は `err.message`（＝サーバの `error`）をそのままバナーに出す（`:535` 送信・`:700` 書き直し・`:770` 会の開始・`:837` 会の終了）。初回読み込みの失敗は固定文言（`:387-390` → `ChatView.tsx:451-452`「会話履歴の読み込みに失敗しました」）、送信後の再読み込みの失敗は握りつぶす（`:640-649`）
- web のテストにある英語文言（`chat-api.test.ts:204` / `:273` / `:383`・`use-chat.test.ts:2939` / `:2952`）はいずれも `fetch` のモックのフィクスチャであり、サーバの契約には依存していない。なお `use-chat.test.ts:2939-2940` は #276 の時点で「`mentoring_required` 以外の `code`」の例として既に `code: "session_not_found"` を置いている（契約ではなく、テストが選んだ名前）

**(F) セッションは削除できないため、UI からは到達しない。** `server/src` の本番コードにある `DELETE FROM` は `task-evidences-repository.ts` と `messages-repository.ts` の 2 本のみで、`sessions-routes.ts` に削除エンドポイントは無い。到達しうるのは DB の手動書き換え・DB リセット後のタブ放置・API の直叩きに限られる。

**(G) #477 の S1（Issue #495・PR #499・未マージ）との関係。** #477 の受入基準は「`chat-messages-route.ts:161` のセッション 404 の `error` 文言は変更前と同じ」「同応答は変更前と同じく `code` を持たない」を含む（`chat-route-error-response-shape.md:155-156`）。これは **#477 S1 の時点での非回帰条件であって恒久的な契約ではなく**、本件はそれを**意図的に上書きする**。なお PR #499（`7ff2f32`）の変更は `:181` の応答とその task 404 テストの照合だけで、セッション不在 404 のテスト（`chat-messages-route.test.ts:129`）には触れておらず、「161 行は `code` なし」をテストで固定していない（意思決定者が差分で確認済み）。したがって本件で書き換える #499 由来のテストは無い。

### 目的

- 同じ「セッションが存在しない」という事実を、どのエンドポイントを叩いても**同じ `code` と同じ日本語の `error`** で返す（資源単位の対称）
- (D) の緩さを締め、**変異で落ちること**まで確認して、テストが各エンドポイントの 404 の形を守っている状態にする

## ユーザーストーリー

**web の実装者**として、セッション不在の 404 を、どのエンドポイントから返ってきても同じ安定した `code` で識別できる状態にして、将来「セッションが消えた」を他の失敗と別扱いしたくなったときに、**サーバの応答契約を変えずに web 側だけで分岐を足せる**ようにしたい。

## 機能要件

- [ ] `POST /api/sessions/:id/messages` の数値の id によるセッション不在 404 が `code`（`session_not_found`）を持つ
- [ ] `POST /api/sessions/:id/end` の数値の id によるセッション不在 404 が `code`（`session_not_found`）を持つ
- [ ] `GET /api/sessions/:id/messages` の数値の id によるセッション不在 404 が `code`（`session_not_found`）を持つ
- [ ] `POST /api/sessions/:id/messages` の数値の id によるセッション不在 404 の `error` が「セッションが見つかりません」である
- [ ] `POST /api/sessions/:id/end` の数値の id によるセッション不在 404 の `error` が「セッションが見つかりません」である
- [ ] `GET /api/sessions/:id/messages` の数値の id によるセッション不在 404 の `error` が「セッションが見つかりません」である
- [ ] `POST /api/sessions/:id/messages` の数値でない id によるセッション不在 404 の `code` が、数値の id と同じ `session_not_found` である
- [ ] `POST /api/sessions/:id/end` の数値でない id によるセッション不在 404 の `code` が、数値の id と同じ `session_not_found` である
- [ ] `GET /api/sessions/:id/messages` の数値でない id によるセッション不在 404 の `code` が、数値の id と同じ `session_not_found` である
- [ ] `POST /api/sessions/:id/messages` の数値でない id によるセッション不在 404 の `error` が、数値の id と同じ「セッションが見つかりません」である
- [ ] `POST /api/sessions/:id/end` の数値でない id によるセッション不在 404 の `error` が、数値の id と同じ「セッションが見つかりません」である
- [ ] `GET /api/sessions/:id/messages` の数値でない id によるセッション不在 404 の `error` が、数値の id と同じ「セッションが見つかりません」である
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 を検証するテストが、`code` だけを取り除く変異（決定 5 の変異 (a)）で落ちる
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 を検証するテストが、`error` だけを変更前の英語文言に戻す変異（決定 5 の変異 (b)）で落ちる
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 を検証するテストが、`code` だけを取り除く変異（決定 5 の変異 (a)）で落ちる
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 を検証するテストが、`error` だけを変更前の英語文言に戻す変異（決定 5 の変異 (b)）で落ちる
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 を検証するテストが、`code` だけを取り除く変異（決定 5 の変異 (a)）で落ちる
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 を検証するテストが、`error` だけを変更前の英語文言に戻す変異（決定 5 の変異 (b)）で落ちる

## 技術的な制約・方針

- **変更対象**: `server/src/sessions/chat-messages-route.ts`（161 行）・`server/src/sessions/sessions-routes.ts`（270 行・328 行）と、`server/src/sessions/chat-messages-route.test.ts`・`server/src/sessions/sessions-routes.test.ts`。下記の共通モジュールを切り出す場合に限り、`server/src/sessions/` 配下の新規ファイル 1 件を加えてよい。**それ以外のファイルは触らない**
- **3 箇所で同じ応答を組み立てる方法**は次のいずれかとし、どちらを選ぶかは実装者の裁量とする（受入基準は応答の形とテストの締まりだけを問う）
  - 共通化する場合は `server/src/sessions/` 配下の新しい小さなモジュールに置き、`sessions-routes.ts` と `chat-messages-route.ts` の両方から import する。**2 ファイルのどちらかに定義してもう一方から import してはならない**（`sessions-routes.ts:21` が既に `chat-messages-route.ts` を import しているため、逆向きの import は循環する）
  - 共通化しない場合は 3 箇所に同じリテラルを書き、揃っていることはテストで担保する
- **実装は #495（PR #499）のマージ後に行う**。PR #499 も `chat-messages-route.ts` と `chat-messages-route.test.ts` を触るため並走させない。本仕様の行番号は `4106645` 時点のもので、#499 のマージで `chat-messages-route.ts` の 181 行以降（同テストの該当箇所を含む）がずれるため、**実装時は行番号ではなく文字列（`` `session ${rawId} not found` `` / `` `session ${c.req.param("id")} not found` ``、テスト名 `"returns 404 for a non-existent session id"` 等）で該当箇所を特定する**
- 本件は #477 仕様の受入基準「同ルートのセッション不在 404（`chat-messages-route.ts:161`）の応答は、変更前と同じく `code` を持たない」「同 404 の `error` 文言は変更前と同じ」（`chat-route-error-response-shape.md:155-156`）を**意図的に上書きする**（背景 (G)）。両仕様の食い違いは本仕様が後勝ちである
- **web は 1 行も変更しない**（確証 (E)。`chat-api.ts` / `use-chat.ts` / `ChatView.tsx` とそのテストのフィクスチャいずれも対象外）
- **DB スキーマ変更・マイグレーションは無い**
- 外部送信は Claude API への推論リクエストのみ（ADR 0001）。本件は送信内容を変えない
- 本件は日付境界に触らないため `npm run test:tz` は必須ゲートではない。品質ゲートは `npm run lint` / `npm run typecheck` / `npm test` を**それぞれ単一コマンドで**実行して判定する

## 画面・API設計

### API

次の 3 エンドポイントで、パスの `:id` が指すセッションが存在しない場合（数値でない id を含む）の応答を同じ形に変える。ステータスコード `404` は変えない。

- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/end`
- `GET /api/sessions/:id/messages`

```jsonc
// 変更前（3 箇所とも。id はパスの値をそのまま埋め込む）
{ "error": "session 9999 not found" }

// 変更後（3 箇所とも同一。id は埋め込まない）
{ "error": "セッションが見つかりません", "code": "session_not_found" }
```

3 エンドポイントの他の応答（成功応答・400・409・`message_not_found`・`mentoring_task_not_found` 等）は**変えない**。

## クリティカル設計決定

> 本節は意思決定者が確定済みの決定であり、実装者が独自判断で逸脱しない。

### 1. 範囲は 3 箇所を一度に扱う

- **採用案**: `chat-messages-route.ts:161`・`sessions-routes.ts:270`・`:328` の 3 箇所を 1 つのスライスで同時に揃える
- **理由**: #477 決定 1 のとおり、一部だけを直すと「同じセッション不在エラーが、叩いたエンドポイントによって日本語だったり英語だったりする」という資源単位の非対称が生まれる。確証 (A) のとおり同種の箇所はこの 3 箇所で尽きている
- **代替案**: エンドポイントごとに分けて出荷する — 却下（途中の状態が上記の非対称そのものになる）
- **影響範囲**: 上記 3 行とそのテスト

### 2. `code` の値は資源スコープの `session_not_found` を 3 箇所で共有する

- **採用案**: 3 箇所とも `code: "session_not_found"` とする
- **理由**:
  - 3 箇所はいずれも**パスの `:id` そのもの**が指す資源が無いことを表しており、「どの入力が不正か」の曖昧さが生じない。web は呼んだ API 関数（`endSession` / `fetchSessionMessages` / `sendChatMessage`）でどのエンドポイントの失敗かを既に知っているため、`code` にエンドポイントの区別を持たせても情報は増えない
  - パスの資源 id の不在に `code` を付けている既存の先例は `reports-routes.ts:105` の `report_not_found`（`GET /api/reports/:date`）で、資源スコープの命名である
- **#477 決定 2 との整合**: #477 決定 2 は `task_not_found`（資源スコープ）を 2 つの理由で却下した。本件にはどちらも当てはまらない
  - 「共用すると、どのフィールドが不正かを web が区別できなくなる」— `mentoringTaskId` は**ボディのフィールド**であり、同じ task 不在が別の意味（パスの task とボディの対象タスク）を持ちうるための理由である。本件はパスの `:id` だけが対象で、区別すべき別のフィールドが無い
  - 「既存 `code` の粒度とも合わない」— #477 が見たのは同ルートの**そのルートの操作に固有の拒否**（`session_already_ended` / `message_not_editable` 等）の粒度である。セッション不在はルートに固有の事実ではなく 3 エンドポイントで同一の事実であり、操作スコープで名付けると 1 つの事実を 3 つの名前に割ることになる
- **一般原則にはしない**: 上の整理を「ボディのフィールドが指す資源の不在は操作・文脈スコープ、パスの資源の不在は資源スコープ」という一般原則には昇格させない（ADR にもしない）。ボディのフィールド（`replaceFromMessageId`）が指すメッセージの不在に資源型の名前を付けた `message_not_found`（`chat-messages-route.ts:210`）という反例が既にあるためである。本決定の理由は本仕様の 3 箇所に対する説明に留める
- **代替案**:
  - (B) エンドポイントごとの `code`（例 `chat_session_not_found` / `end_session_not_found` / `session_messages_not_found`）— 却下（web が得る情報は増えないのに、「セッションが消えた」を扱うときに 3 つの `code` を列挙させる。既存の `code` にエンドポイント名で名付けたものは無い）
- **影響範囲**: 3 行とそれを照合するテスト

### 3. `error` の文言は「セッションが見つかりません」を 3 箇所で同一にし、id を埋め込まない

- **採用案**: 3 箇所とも `"セッションが見つかりません"` とする
- **理由**:
  - #477 決定 3 と同じく、同ルートの既存の日本語文言（「終了したセッションの発言は編集できません」「ボスの発言は編集できません」「対象のタスクが見つかりません」）の回復示唆を含まない簡潔形に揃える
  - id を落としてもデバッグ性は損なわない。セッション id はリクエストの**パス**にあり、リクエスト行を見れば分かる（#477 決定 1 代替案 D が `message_not_found` の日本語化を却下した理由は、どのメッセージ id がどのセッションに無いかを文面から落とすことだった。本件は落ちる情報がパスに残る）
  - 数値でない id（決定 4）でもパスの生の値を応答へ反射しなくて済む
- **代替案**:
  - 「セッション 9999 が見つかりません」（id を埋め込む）— 却下（上記。数値でない id ではパスの生の値をそのまま返すことになる）
  - 「対象のセッションが見つかりません」— 却下（「対象の」は `mentoringTaskId` がセッション内の他のタスクと区別される場合の修飾であり、パスの資源には区別すべき別の対象が無い）
- **影響範囲**: 3 行とそれを照合するテスト

### 4. 数値でない id も同じ 404・同じ `code`・同じ `error` にする

- **採用案**: 数値でない id（例 `abc`）によるセッション不在も、数値の id と同じ応答にする。ステータスは 404 のまま変えない
- **理由**: 確証 (B) のとおり現状すでに同じ分岐に入っており、「その id のセッションは存在しない」という事実も同じである。web は数値の id しか送らない（`chat-api.ts` の各関数の引数は `number`）ため、形式不正を別の応答として区別する需要が無い
- **代替案**: 形式不正を 400 と別の `code`（例 `invalid_session_id`）で返す — 却下（ステータスの変更は本件のスコープを超え、需要も無い。YAGNI）
- **影響範囲**: 3 行（分岐は増えない）と、数値でない id を照合するテスト

### 5. テストは `code`・`error` まで照合し、変異で担保を証明する

- **採用案**: 3 エンドポイントそれぞれのセッション不在 404 のテストを `code` と `error` の文言まで締め、数値でない id の例を 3 エンドポイントに揃えたうえで、**エンドポイントごとに次の 2 つの変異を 1 つずつ（計 6 回）打ち、当該エンドポイントのテストが落ち、他の 2 エンドポイントのセッション不在 404 のテストは落ちないこと**を確認する
  - 変異 (a): そのエンドポイントの応答から `code` だけを取り除く（`error` は変更後の文言のまま）
  - 変異 (b): そのエンドポイントの `error` だけを変更前の英語文言に戻す（`code` は付けたまま）
  - 変異は**そのエンドポイントの応答を組み立てる箇所**に打つ。共通モジュールに寄せた場合も、共通モジュール本体ではなく当該エンドポイントの呼び出し箇所を、変異させた応答のリテラルに一時的に差し替える（共通モジュール本体を変異させると 3 エンドポイントすべてが崩れ、限局の確認にならない）
- **理由**: 確証 (D) のとおり現行の照合は応答の形を問わず通る。`code` と `error` は独立に変えられる主張なので、片方だけを崩す変異で**それぞれの照合が実際に効いている**ことを示す。加えて、他の 2 エンドポイントのテストが落ちないことで、**各テストが自分のエンドポイントの 404 を守っている**（1 本のテストが別エンドポイントの応答で代わりに通っていない）ことを示す（#477 決定 5 と受入基準「セッション不在 404 を検証する既存テストは落ちない」・`MEMORY` の教訓「AC 担保は変異で証明する」と同じ規律）
- **代替案**: 変更前の形（英語・`code` なし）へ丸ごと戻す変異 1 つで確認する — 却下（`code` か `error` の片方しか照合していないテストでも落ちるため、もう片方の照合が恒真のまま残っても検出できない）
- **変異の手順**: 変異は本番コードへ一時的に加える。**適用後に `git diff` で変異が意図した 1 箇所に限られていることを確認し、確認が済んだら `git checkout -- <変異したファイル>` で確実に復元する**（復元漏れのまま次の変異・変更へ進まない）。変異はコミットしない
- **変異結果の記録先**: 変異はコミットされないため、**変異の内容（エンドポイント × (a)/(b)）・落ちたテスト・落ちなかったテスト（他の 2 エンドポイントのセッション不在 404 のテストを含む）を PR 本文に記載する**（#477 と同じ形）。これが変異の受入基準の充足を後からレビュアーが確認する唯一の証跡になる
- **影響範囲**: `chat-messages-route.test.ts`・`sessions-routes.test.ts` の当該テスト。変異は上記手順で復元する

### 6. web は変更しない（`code` による分岐を今は入れない）

- **採用案**: サーバに `code` を足すだけで、web には `code` による UI 分岐も回復動作も入れない
- **理由**: 確証 (E) のとおり `ChatApiError` が既に `code` を透過しており、分岐が必要になった時点で web 側だけで足せる。確証 (F) のとおり到達しない現状で回復動作を書くのは YAGNI（#477 決定 4 と同じ判断）
- **代替案**: `session_not_found` で分岐してセッション一覧を取り直す — 却下（上記）
- **影響範囲**: なし（web 無改修）

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 3 エンドポイントのセッション不在 404 を `{ error: "セッションが見つかりません", code: "session_not_found" }` へ揃え、各テストを `code`・文言まで照合する形に締め（数値でない id の例を含む）、エンドポイントごとの変異（2 種 × 3 ＝ 6 回）で当該テストだけが落ちることを確認する | 4-5 | これだけで資源単位の応答契約が揃い、テストが各 404 の形を守る状態になる。#495（PR #499）のマージ後に実装する |

実装対象: S1

> 本仕様のスライスは S1 のみで閉じる（後続スライスは無い）。決定 1 のとおり 3 箇所を分割して出荷しない。

## やらないこと

- **`chat-messages-route.ts:181` の task 404（`mentoringTaskId`）の変更**（理由: #477 S1＝Issue #495・PR #499 が扱う）
- **`chat-messages-route.ts:209-210` の `message_not_found` の日本語化**（理由: #477 決定 1 代替案 D。どのメッセージ id がどのセッションに無いかを文面から落とし、やりなおし経路のデバッグ性を損なう）
- **400 バリデーションエラー（`sessions-validation.ts` の英語文言）の日本語化・`code` 付与**（理由: web がボディを組み立てるため UI から到達せず、開発者向けの契約違反エラーである）
- **他資源の 404 の変更**（`tasks-routes.ts:84` / `task-evidences-routes.ts:34` `:38` / `checkins-routes.ts:75`）（理由: 本件はセッション資源の不在に限る）
- **`POST /api/reports/generate` の `eveningSessionId` 不在時の応答（409 `evening_session_required`）の変更**（理由: ボディのフィールドが指すセッションの不在であり、ADR 0008 決定 2 の意図した契約。確証 (A)）
- **id の形式の厳格化**（`Number()` がそのまま数値に読む `0x1` / `1e0` 等の非正規表記が既存のセッションに解決される挙動の変更を含む）（理由: 本件は不在時の応答の形に限る。web は数値の id しか送らない）
- **web の変更**（`chat-api.ts` / `use-chat.ts` / `ChatView.tsx` とそのテストのフィクスチャ）（理由: 決定 6）
- **`docs/features/chat-message-rewrite.md:92` の API 表（セッション不在 404 を英語で記載）の追随**（理由: 機能仕様は非権威の経緯の記録であり、同表は「既存のまま」と当時の状態を記録している）
- **セッション削除機能の追加**（理由: 確証 (F) は現状の記録であって、削除機能を足す要求ではない）

## 受入基準

- [ ] `POST /api/sessions/:id/messages` に存在しないセッション id（数値 `9999`・数値でない `not-a-number`）を指定したリクエストは、HTTP ステータス 404 で拒否される（非回帰）
- [ ] その 404 応答のボディの `code` が `"session_not_found"` である（数値・数値でない id の両方）
- [ ] その 404 応答のボディの `error` が `"セッションが見つかりません"` である（数値・数値でない id の両方）
- [ ] `POST /api/sessions/:id/end` に存在しないセッション id（数値 `9999`・数値でない `not-a-number`）を指定したリクエストは、HTTP ステータス 404 で拒否される（非回帰）
- [ ] その 404 応答のボディの `code` が `"session_not_found"` である（数値・数値でない id の両方）
- [ ] その 404 応答のボディの `error` が `"セッションが見つかりません"` である（数値・数値でない id の両方）
- [ ] `GET /api/sessions/:id/messages` に存在しないセッション id（数値 `9999`・数値でない `not-a-number`）を指定したリクエストは、HTTP ステータス 404 で拒否される（非回帰）
- [ ] その 404 応答のボディの `code` が `"session_not_found"` である（数値・数値でない id の両方）
- [ ] その 404 応答のボディの `error` が `"セッションが見つかりません"` である（数値・数値でない id の両方）
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、同エンドポイントのセッション不在 404 のテストが落ちる
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、`POST /api/sessions/:id/end` と `GET /api/sessions/:id/messages` のセッション不在 404 のテストは落ちない
- [ ] `POST /api/sessions/:id/messages` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、`POST /api/sessions/:id/end` と `GET /api/sessions/:id/messages` のセッション不在 404 のテストは落ちない
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、`POST /api/sessions/:id/messages` と `GET /api/sessions/:id/messages` のセッション不在 404 のテストは落ちない
- [ ] `POST /api/sessions/:id/end` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、`POST /api/sessions/:id/messages` と `GET /api/sessions/:id/messages` のセッション不在 404 のテストは落ちない
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 から `code` だけを取り除く変異を加えたとき、`POST /api/sessions/:id/messages` と `POST /api/sessions/:id/end` のセッション不在 404 のテストは落ちない
- [ ] `GET /api/sessions/:id/messages` のセッション不在 404 の `error` だけを変更前の英語文言に戻す変異を加えたとき、`POST /api/sessions/:id/messages` と `POST /api/sessions/:id/end` のセッション不在 404 のテストは落ちない
- [ ] 上記 6 つの変異確認の結果（変異の内容・落ちたテスト・落ちなかったテスト）が PR 本文に記載されている
- [ ] `npm run lint` が pass する
- [ ] `npm run typecheck` が pass する
- [ ] `npm test` が pass する
