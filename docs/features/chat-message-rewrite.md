# 送信済みの発言を編集してやりなおせるようにする

## 概要

チャットで送信済みの**自分の発言**を編集し、その発言以降のやりとりを切り捨てて書き直した内容で送り直せるようにする（Claude Code 型の巻き戻し）。**版・分岐（親子関係）は持たない**。切り捨ては**アクティブなセッション内で完結**し、終了済みセッション（完了した朝会・夕会）の発言は編集対象にしない。実行前に「何件が消えるのか」を必ず提示し、ユーザーの確定操作を経てから実行する。

## 背景・目的

誤った内容を送ってしまったとき、現状は**編集も削除も巻き戻しも経路が無い**。`POST /api/sessions/:id/messages` と `GET /api/sessions/:id/messages` しか無く、`ChatView.tsx` はメッセージを読み取り専用で描画している。そのうえ LLM へ渡す文脈は `toClaudeMessages(listMessagesBySessionId(db, id))`（`server/src/sessions/chat-messages-route.ts`）＝**そのセッションの全メッセージ**なので、言い直しても**元の誤った発言はボスに見え続ける**。

Issue #254（応答生成の停止）で「停止は中断だけを担い、発言も部分応答も残す」と決めたため、**やりなおしは別の操作として要る**（[docs/features/chat-generation-stop.md](chat-generation-stop.md) の「スコープ外」に本 Issue が名指しされている）。ChatGPT も Claude Code も中断とやりなおしを別機能として分けている。

## ユーザーストーリー

セルフマネジメント支援アプリの利用者として、ボスへ誤った内容を送ってしまったとき、その発言を編集して送り直し、**元の誤った発言がボスの文脈から消えた状態で**やりとりを再開したい。そのとき、どこまでの会話が消えるのかを実行前に知りたい。

## 機能要件

- [ ] アクティブなセッション内の**自分の発言（`role: "user"`）すべて**を対象に、編集して送り直せる（直前の 1 件には限定しない）
- [ ] 送り直すと、対象の発言と**それ以降の同一セッションのメッセージ**（自分の発言・ボスの応答の両方）が削除される
- [ ] 送り直したあと、**元の発言はボスの文脈（LLM へ渡すメッセージ列）に含まれない**
- [ ] 実行前に「この操作で N 件（あなたの発言 x 件・ボスの応答 y 件）が削除されます」が提示される
- [ ] 削除は確定操作を経てはじめて実行される
- [ ] 実行前の提示に「**すでに実行された操作は取り消されません**」が明示される
- [ ] 終了済みセッション（`ended_at` が非 NULL）の発言は編集できない
- [ ] ボスの発言（`role: "boss"`）は編集できない
- [ ] 切り捨て範囲にボスのツール実行が含まれていても、その副作用（作成・更新されたタスク、記録された決定）は取り消されない
- [ ] 切り捨てられた発言に対応する `activity_events` の行は削除されない
- [ ] 送り直しは新しい発言として扱われ、`chat_message` 活動イベントがもう 1 件記録される
- [ ] ボスの応答生成中は編集操作を開始できない（先に停止する）
- [ ] リロード後の画面が、送り直し直後の画面と一致する（切り捨てが永続化されている）

## 非機能要件

- **可逆性**: 切り捨ては**取り消せない**（案 A の当然の帰結）。これを補うのは実行前の提示と確定操作だけであり、undo・ゴミ箱・論理削除は持たない。したがって**確定操作を経ずに削除が走る経路を作ってはならない**。
- **セキュリティ**: [ADR 0001](../adr/0001-local-only-data-boundary.md) のローカル完結制約を変えない。削除は SQLite に閉じ、外部送信は従来どおり Claude への推論リクエストだけである。切り捨てはむしろ送信量を減らす方向にしか働かない。
- **ログ**: [ADR 0002](../adr/0002-api-key-and-llm-call-path.md) 決定 4 のとおり、失敗時のログに残すのはエラークラス名までとする（既存のチャットルートの規律をそのまま維持する）。
- **原子性**: 「切り捨て」と「書き直した発言の挿入」は同一トランザクションで行う（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 5）。履歴だけが消えて置き換えが入らない中間状態を残さない。

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono / better-sqlite3 / React）。**新しい機構を発明せず、既存の送信経路（SSE ストリーム）に切り捨ての指示を 1 つ足す**変更として実装する。
- **DB スキーマ変更は無い**（後述「クリティカル設計決定 / 決定 1」）。
- 変更対象:
  - `server/src/sessions/messages-repository.ts`（切り捨て・対象メッセージ検索）
  - `server/src/sessions/sessions-validation.ts`（`replaceFromMessageId` の検証）
  - `server/src/sessions/chat-messages-route.ts`（ガードと切り捨ての実行）
  - `web/src/chat.ts`（`ChatEntry` への識別子の付与）
  - `web/src/merge-timeline.ts`（同上）
  - `web/src/use-chat.ts`（`rewrite` / `activeSessionId`、および `messageEntry` への識別子の付与）
  - `web/src/chat-api.ts`（`sendChatMessage` に `replaceFromMessageId` を渡せるようにする）
  - `web/src/ChatView.tsx` / `ChatView.css`（編集 UI・確認 UI）
  - `web/src/select-rewrite-range.ts`（新規・純粋関数）
- **既存コードとの関係（実コードで確認済み）**:
  - `messages` の実スキーマは `id / session_id / role / content / interrupted / created_at` の **6 列**（`server/src/db/migrate.ts` の初期定義 ＋ user_version 5 の `ALTER TABLE messages ADD COLUMN interrupted`）。Issue #255 本文が引用する「5 列」は #254 マージ前の記述であり、現状と一致しない。
  - `listMessagesBySessionId` は `ORDER BY created_at ASC, id ASC`。**切り捨ての「以降」はこの複合順序で定義する**。
  - `toClaudeMessages(listMessagesBySessionId(db, id))` はユーザー発言を INSERT した**あとに**呼ばれる（`chat-messages-route.ts`）。切り捨てを INSERT の前に同一リクエスト内で行えば、LLM へ渡る文脈から元の発言が消えることが構造的に保証される。
  - **サーバは終了済みセッションへの POST を現状ガードしていない**（`web/src/use-chat.ts` の `findTodaysSession` の doc コメントが明記）。本機能では**やりなおし経路にだけ**ガードを足す（通常送信の既存挙動は変えない）。
  - `activity_events` の種別実名は `ACTIVITY_EVENT_TYPES`（`server/src/activity/activity-event.ts`）の `task_start / break_start / break_end / checkin / chat_message / task_update / task_pause`。**`chat_message` は実在する**ので新しいキー名は作らない。
  - **停止機構（#254）は実装済み**: `useChat` の `stop`、`ChatView` の停止ボタンと ESC、サーバ側の `c.req.raw.signal` 起点の中断。本機能はこれに依存する。
  - **タイムラインは複数セッションのマージ結果**（#272）。`buildTimeline`（`web/src/merge-timeline.ts`）は当日の全セッションのメッセージを `created_at` 昇順に混ぜ、会の境界を挟む。**画面上の「ここから下」は同一セッションの連続範囲とは限らない**（後述「実装時に必ず対処する波及点」）。
  - `ChatEntry` の `kind: "message"` は現状 `key / role / content / interrupted?` しか持たず、**メッセージ id もセッション id も持たない**。編集にはこの 2 つが要る。
- スコープ外:
  - 分岐・版管理（`<` `>` での行き来）
  - 終了済みセッションの発言の編集
  - ボス発言の編集・削除、任意のメッセージの単独削除
  - ツール実行の副作用の巻き戻し
  - `activity_events` の削除・訂正
  - 生成中の編集（先に停止する運用にする）
  - #254（応答停止）・#256（エビデンス強制）・#270（LLM コンテキストの当日横断）への変更

## 画面・API設計

### API

**エンドポイントの追加は無い。** 既存の `POST /api/sessions/:id/messages` に**任意フィールド `replaceFromMessageId` を足す**。

```jsonc
// POST /api/sessions/3/messages
{
  "content": "書き直した内容",
  "replaceFromMessageId": 42   // 任意。指定するとやりなおし（未指定なら従来どおりの送信）
}
```

`replaceFromMessageId` を指定したときの応答は従来と同じ SSE ストリーム（`text` / `tool` / `done` / `error`）である。切り捨ては**ストリーム開始前**に完了している。

失敗応答（[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 2 に倣い、UI は**文言ではなく `code` で分岐**する）:

| 状況 | ステータス | ボディ |
|---|---|---|
| セッションが存在しない | 404 | `{ "error": "session 3 not found" }`（既存のまま） |
| `content` が不正 | 400 | `{ "error": "..." }`（既存のまま） |
| `replaceFromMessageId` が正の整数でない | 400 | `{ "error": "replaceFromMessageId must be a positive integer" }` |
| セッションが終了済み | 409 | `{ "error": "終了したセッションの発言は編集できません", "code": "session_already_ended" }` |
| 対象メッセージがそのセッションに存在しない | 404 | `{ "error": "message 42 not found in session 3", "code": "message_not_found" }` |
| 対象メッセージが `role: "boss"` | 400 | `{ "error": "ボスの発言は編集できません", "code": "message_not_editable" }` |

`GET /api/sessions/:id/messages` は**変更しない**（既に `id` / `session_id` を返しており、編集 UI に必要な情報は揃っている）。

### 画面

- **編集操作を出す条件**（すべて満たすときだけ）:
  - `kind: "message"` かつ `role: "user"`
  - サーバ永続化済み（`messageId` を持つ。楽観追記された送信直後のエントリには出さない）
  - `sessionId === activeSessionId`（＝アクティブセッションの発言。終了済みの会のメッセージには出さない）
  - `sending` でも `switching` でもない（既存の会の開始／終了ボタンと同じ抑止条件に揃える）
- **編集を開始する**と、その発言が**インライン編集フォーム**（テキストエリア＋確定／キャンセル）に変わり、同時に:
  - 削除対象のエントリがタイムライン上で**視覚的に区別**される（専用クラス）
  - 「**この操作でこの発言を含む N 件（あなたの発言 x 件・ボスの応答 y 件）が削除されます**」が表示される
  - 「**すでに実行された操作は取り消されません**」が表示される
- **確定操作**（「送り直す」）を押すまで削除は起きない。**キャンセル**で元の表示に戻り、何も削除されない。
- 編集中は下部の通常入力欄を無効化する（送信経路が 2 つ同時に開かない）。
- 生成中（`sending`）は編集操作を出さない。既存の停止ボタン／ESC で止めてから編集する。

## クリティカル設計決定

Issue #255 が挙げた 6 論点の決定。**いずれも 2026-09-06 に親（flywheel エージェント）が確定済み**であり、本仕様はそれを所与として記録する。

### 決定 1: 分岐は持たず、切り捨てる（案 A・Claude Code 型）

- **採用案**: 編集した発言と**それ以降**のメッセージを物理削除し、書き直した内容で再送する。版・分岐（親子関係）を表す列もテーブルも持たない。
- **理由**: 本アプリの会話は朝会・夕会という**区切られた報告の場**（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 2）であり、分岐した会話を持ち回る価値が薄い。分岐を持つと日報生成・夕会評価が「どの分岐を正とするか」を決める派生問題を抱える（[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 1 が夕会の発言を日報の前提条件にしている構図が、分岐ごとに解釈を要する）。スキーマ変更も最小になる。
- **スキーマ変更は無い**: 案 A に必要なのは `DELETE` だけで、`messages` に列を足す必要が無い。[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 4 の「新しいスキーマ変更は新しい version として追加する」を発動する場面ではない（`user_version` は 6 のまま）。
- **代替案**: 案 B（分岐・ChatGPT 型）— 却下。`messages` に親子関係／版の構造が要り、上記の派生問題を伴う。まず切り捨てで足りるかを見る。
- **帰結（重要）**: 切り捨ては**取り消せない**。安全側の担保は「実行前の提示＋確定操作」（決定 6）だけである。論理削除（`deleted` フラグ）は採らない — 分岐を持たないと決めた以上、残しても読む経路が無く、`listMessagesBySessionId` を含む全読み出しに除外条件を撒くことになる（YAGNI）。

### 決定 2: 遡れる範囲は「アクティブセッション内の自分の発言すべて」

- **採用案**: `role: "user"` かつアクティブセッションに属するメッセージは**どれでも**編集できる。「直前の 1 件だけ」には絞らない。
- **理由**: 案 A の切り捨ては「対象発言以降の削除」1 本で表現できるため、**対象を広げても実装コストがほぼ変わらず、制約だけが緩む**。「直前の 1 件」に絞ると、その制約を守るための追加判定が要るうえ、誤りが 2 つ前にあった場合に手立てが無い。
- **「以降」の定義**: `listMessagesBySessionId` の並び（`created_at ASC, id ASC`）における「対象を含みそれ以降」。すなわち削除条件は
  ```sql
  session_id = ? AND (created_at > ? OR (created_at = ? AND id >= ?))
  ```
  **`id >= ?` だけにしない**: `created_at` はミリ秒精度の ISO 文字列で、同一ミリ秒の 2 行がありうる（そのために既存の並びが `id` をタイブレーカに使っている）。画面の並びと削除範囲が同じ規則で決まらないと、「見えている通りに消える」が成り立たない。
- **代替案**: 直前 1 件のみ — 却下（上記）。

### 決定 3: セッションはまたがない（終了済みセッションは対象外）

- **採用案**: 削除は対象メッセージと**同一セッション**に閉じる。`ended_at` が非 NULL のセッションの発言は編集できない（409 `session_already_ended`）。
- **理由**: 終了済みの朝会・夕会の発言を書き換えることは、**日報生成・夕会評価の入力を事後に書き換える**ことになる。[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 1 は「対象暦日の夕会が終了済みで、かつユーザー発言が 1 件以上ある」ことを日報の前提条件にしており、終了後の書き換えを許すとこの前提の成立時点と内容が事後に動く。同 決定 4 は「やり直したい場合は**既存の夕会で会話を続けて**日報を再生成する」としており、やりなおしを開いている会の中に閉じるのはこの方針と同じ向きである。
- **アクティブな夕会の途中での編集は許される**: 日報生成は `ended_at` の初回遷移で走る（`sessions-routes.ts` の `POST /:id/end`）ため、終了前の切り捨ては「終了時点の会話」に自然に織り込まれる。セッション要約（`generateSessionSummary`）も終了時に読むため同様である。
- **ガードは二重に置く**: サーバは `session.ended_at !== null` を見て 409 を返す（クライアントの状態を信用しない）。クライアントは `sessionId === activeSessionId` のエントリにしか編集操作を出さない（アクティブセッションは構造上 `ended_at === null`）。
- **代替案**: 終了済みセッションも編集可 — 却下（上記）。セッションをまたいで切り捨てる — 却下。ADR 0005 決定 2 の「メッセージはセッションに属する」構造を壊し、削除範囲が「画面に何が載っているか」に依存してしまう。

### 決定 4: ツール実行の副作用は残す（#254 と同じ判断）

- **採用案**: 切り捨て範囲にボスのツール実行（`create_task` / `update_task` / `record_decision` 等）が含まれていても、その副作用は取り消さない。当該の `activity_events` の行も削除しない。実行前の確認 UI に「**すでに実行された操作は取り消されません**」を明示する。
- **理由**: #254 が「停止してもツール実行の副作用は巻き戻さない」と決めており、同じ会話上の操作で判断を分けると挙動が予測できなくなる。加えて、副作用の巻き戻しは一般に不可能である（ユーザーがその後に手で編集したタスクを、どの状態へ戻すのが正しいか決められない）。
- **代替案**: 副作用も巻き戻す — 却下（上記）。副作用が残ることを黙っておく — 却下。決定 1 で取り消しが効かない以上、実行前に伝えることが唯一の防御になる。

### 決定 5: 再送で `chat_message` 活動イベントが 1 件増えるのを許容する

- **採用案**: やりなおしの再送でも通常の送信と同じく `recordActivityEvent(db, { type: "chat_message" })` を記録する。切り捨てられた発言に対応する既存の `chat_message` 行も**削除しない**。
- **理由**: `activity_events` は[ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 1 の「ユーザーが動いたか」の単一シグナルであり、**実際にユーザーは操作している**。過去のイベントを消すことは「その時刻に動いていなかった」という事実に反する記録を作ることになり、サボり検知の入力を歪める。履歴の正直さを優先する。
- **帰結**: 「やりなおしを多用すると当日の `chat_message` 件数が実際の発言数より多くなる」ことは仕様として受け入れる。検知エンジンは `chat_message` を「無音でない」ことのシグナルとして使うため、多い方向への誤差は検知を厳しくしない。
- **代替案**: 再送ではイベントを記録しない — 却下。編集ではなく「新しい発言」として扱う方が実態に近く、記録しないと連続してやりなおした間の活動が無音として扱われる。

### 決定 6: 実行前に「消える範囲」を必ず提示する

- **採用案**: 編集操作を開始した時点で、削除される件数（**対象発言を含む** N 件・内訳としてあなたの発言 x 件／ボスの応答 y 件）と、削除対象エントリのハイライト、そして「すでに実行された操作は取り消されません」を提示する。ユーザーの確定操作を経てはじめて実行する。
- **理由**: 決定 1 により取り消しが効かないため、**提示と確定操作が唯一の安全機構**である。ホバーで即編集・即送信の形は採らない。
- **提示の作り方**: 件数はクライアント側の**純粋関数**（`selectRewriteRange`）でタイムラインから算出する。プレビュー専用の API は作らない（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 6 の「算出できるものは保存しない」と同じ向き。クライアントはアクティブセッションのメッセージを全件保持している — `loadTimeline` が `fetchSessionMessages` でセッション単位に全件取得しているため）。
- **代替案**: 実行後に「N 件削除しました」と知らせる — 却下。取り消せないので事後通知は意味を成さない。

### 導出決定 6-a: 「ここから下」ではなく「削除される集合」を示す

- **状況（実コード調査で判明）**: タイムラインは #272 で**複数セッションのマージ結果**になっており（`buildTimeline`）、随時チャット（adhoc）の発言の**あいだに**終了済みの朝会・夕会のブロックが挟まりうる（`endSession` 後は送信先が adhoc セッションへ戻るため、同じ adhoc セッションの発言が会の前後に分かれて並ぶ）。したがって画面上の「対象発言より下のすべて」と「実際に削除される同一セッションのメッセージ」は**一致しない**。
- **決定**: 確認 UI は「ここから下がすべて消える」とは言わず、**実際に削除される個々のエントリをハイライトし、その件数を出す**。他セッション（終了済みの会）のメッセージは、対象発言より画面上は下にあっても**削除されないし、ハイライトもされない**。
- **理由**: 決定 3 で削除をセッション内に閉じると決めた以上、「下がすべて消える」は事実に反する。決定 6 の目的（実行前に消える範囲を正しく知らせる）を、マージ済みタイムラインという実際の画面構造の上で満たすための帰結である。

### 導出決定 6-b: 切り捨て範囲のツール通知は画面から消す（副作用は残す）

- **決定**: 削除範囲に含まれるクライアント側のツール通知エントリ（`kind: "tool"`）は、送り直しと同時にタイムラインから取り除く。**副作用そのもの（タスク・決定・`activity_events`）は決定 4 のとおり残す。**
- **理由**: ツール通知は永続化されておらず、SSE の `tool` イベントから**その場で積まれる表示専用のエントリ**である（`buildTimeline` は生成しない）。リロードすれば消えるものを画面に残すと、送り直し直後の画面とリロード後の画面が食い違う（機能要件の最後の項目に反する）。#254 の「停止してもツール通知は残る」とは前提が違う — あちらは通知に対応する会話が画面に残っているが、こちらは対応する会話ごと消える。
- **ユーザーへの説明はあくまで確認 UI の「すでに実行された操作は取り消されません」が担う**。通知が消えることをもって副作用が消えたと読ませないため、この文言を省略してはならない。

### 導出決定 6-c: 生成中は編集を開始できない（#254 との境界）

- **決定**: `sending`（ボスの応答生成中）は編集操作を出さない。ユーザーは既存の停止ボタン／ESC（#254）で止めてから編集する。
- **理由**: #254 の停止機構は実装済みで、この前提を置ける。生成中に切り捨てを走らせると、**進行中のリクエストが後からボスの応答を INSERT する**（`chat-messages-route.ts` は `done` 経路でも `catch` 経路でも `insertMessage` する）。切り捨て済みのセッションへ古い応答が着地し、書き直した発言の**あとに**並ぶ。`useChat` の `sendingRef` ガードも「送信中は次の送信を受け付けない」形で既に存在するため、編集も同じ抑止に揃えるのが一貫している。
- **代替案**: 編集の確定時に自動で停止する — 却下。停止の完了を待ってから切り捨てる調停が要り、機構が増える（KISS）。既存 UI で「止めてから編集する」は 1 アクション増えるだけである。

## 機能全体の設計

### アーキテクチャ決定

やりなおしは「新しい送信経路」ではなく、**既存の送信経路の先頭に切り捨てを 1 段足す**変更として実装する。

```text
[ブラウザ] 発言の「編集」→ 消える範囲の提示（selectRewriteRange・純粋関数）
   → ユーザーの確定操作
   → POST /api/sessions/:id/messages { content, replaceFromMessageId }
   → [サーバ] ガード（終了済み 409 / 不存在 404 / ボス発言 400）
   → db.transaction(
        deleteMessagesFrom(session, replaceFromMessageId)   ← 新設
        insertMessage(role: "user", content)                ← 既存
      )
   → recordActivityEvent({ type: "chat_message" })          ← 既存（決定 5）
   → toClaudeMessages(listMessagesBySessionId(db, id))      ← 既存・切り捨て後の列を読む
   → streamBossMessage(...)                                 ← 既存・変更なし
```

**元の発言がボスの文脈から消えることは、この順序が構造的に保証する**。`chat-messages-route.ts` は毎回 DB から文脈を読み直しており、キャッシュを持たない。切り捨てを INSERT の前段へ置くだけで、LLM へ渡るメッセージ列に対象発言が現れる経路が無くなる。

**切り捨てと挿入は単一トランザクション**（[ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 5）。片方だけが成立する中間状態（履歴が消えたのに書き直しが入らない）を作らない。ストリーミングは同期的な DB 操作が終わってから始まる。

**専用の DELETE エンドポイントは作らない**。「やりなおし」は 1 つのユーザー操作であり、切り捨てと再送を 2 回のリクエストに分けると、あいだで失敗したときに**置き換えの無い削除**だけが残る。加えて、置き換えを伴わない履歴削除は製品として要求されていない（YAGNI）ため、そういう破壊的プリミティブを公開面に置かない。

### IF / API

チケット間で共有が要る境界は次の 5 点。

```ts
// server/src/sessions/messages-repository.ts
/** `fromMessageId` を含み、それ以降（listMessagesBySessionId の並び）の
 *  同一セッションのメッセージを削除し、削除件数を返す。 */
export function deleteMessagesFrom(
  db: Database.Database,
  sessionId: number,
  fromMessageId: number,
): number;

/** セッションに属するメッセージを 1 件返す。他セッションの id を渡した場合は
 *  undefined（横断参照を弾く責務をここに置く）。 */
export function findMessageInSession(
  db: Database.Database,
  sessionId: number,
  messageId: number,
): Message | undefined;

// server/src/sessions/sessions-validation.ts
export interface ChatMessageInput {
  content: string;
  /** 未指定なら通常送信。指定するとやりなおし（この id 以降を切り捨てる）。 */
  replaceFromMessageId?: number;
}

// web/src/chat.ts — ChatEntry の kind: "message" に追加
//   messageId?: number;   サーバ永続化済みのメッセージのみ（楽観追記には無い）
//   sessionId?: number;   同上

// web/src/select-rewrite-range.ts（新規・純粋関数）
export interface RewriteRange {
  /** 削除されるエントリの key（ハイライト対象） */
  keys: string[];
  /** 削除されるメッセージ件数（対象発言を含む） */
  total: number;
  userCount: number;
  bossCount: number;
}
export function selectRewriteRange(
  entries: ChatEntry[],
  activeSessionId: number,
  messageId: number,
): RewriteRange;

// web/src/use-chat.ts — UseChatResult に追加
//   activeSessionId: number | null;
//   rewrite: (messageId: number, content: string) => Promise<void>;

// web/src/chat-api.ts — sendChatMessage の新シグネチャ
//   POST ボディが { content } 固定から、replaceFromMessageId を任意で
//   含められる形へ変わる。
export function sendChatMessage(
  sessionId: number,
  content: string,
  handlers: /* 既存の SSE ハンドラ型 */ unknown,
  signal: AbortSignal,
  replaceFromMessageId?: number,
): /* 既存の戻り値型 */ unknown;
```

`selectRewriteRange` の規則: `entries` は既に `buildTimeline` の並び（`created_at`, phase, `id` 昇順）である。対象エントリの位置以降にある `kind: "message"` かつ `sessionId === activeSessionId` のエントリを削除対象とする。**同一セッションのメッセージに限れば、この位置順はサーバの `(created_at, id)` 複合順序と一致する**（`buildTimeline` の `SortableEntry` が同じ規則で並べているため）。範囲内の `kind: "tool"` エントリも表示上は取り除く（導出決定 6-b）が、件数には含めない（決定 6 の内訳は「あなたの発言・ボスの応答」であるため）。`kind: "boundary"` は決して対象にしない。

### データモデル

**変更なし。** `messages` テーブルは現状のまま（`id / session_id / role / content / interrupted / created_at`、`user_version` 6）。マイグレーションを追加しない。

`ChatEntry` の `kind: "message"` にのみ、識別子 2 つ（`messageId` / `sessionId`）を任意フィールドとして足す。`kind: "tool"` / `kind: "boundary"` は変更しない。

### 実装計画（チケット分解の見通し）

依存順に 5 つを想定する。最終分解は `/create-ticket` で行う。

1. **サーバ: 切り捨てのリポジトリ関数**（`messages-repository.ts`）— `deleteMessagesFrom` / `findMessageInSession`。実 DB（`:memory:`）に対する単体テストで複合順序の規則を固定する。他が依存する土台。
2. **サーバ: `replaceFromMessageId` の受け口とガード**（`sessions-validation.ts` / `chat-messages-route.ts`）— 1 に依存。3 つの拒否経路と、切り捨て＋挿入のトランザクション、そして「切り捨て後の文脈が LLM へ渡る」ことの統合テスト。
3. **Web: エントリへの識別子付与と範囲算出**（`chat.ts` / `merge-timeline.ts` / `select-rewrite-range.ts`）— 1・2 と独立に着手できる。`merge-timeline.test.ts` の期待値更新を伴う（後述）。
4. **Web: `useChat` のやりなおし経路**（`use-chat.ts` / `chat-api.ts`）— 2・3 に依存。`activeSessionId` の公開と `rewrite`、および `sendChatMessage` への `replaceFromMessageId` 受け渡し。
5. **Web: 編集 UI と確認 UI**（`ChatView.tsx` / `ChatView.css`）— 3・4 に依存。

## 実装時に必ず対処する波及点

- **マージ済みタイムラインでの「以降」**（導出決定 6-a）: 画面上の連続範囲と削除範囲は一致しない。`selectRewriteRange` は必ず `sessionId` で絞ること。「対象エントリより後ろを全部」で実装すると、終了済みの会のメッセージをハイライトし、実際には消えないものを「消えます」と表示する。
- **`created_at` の同値**（決定 2）: 削除条件を `id >= ?` だけで書かない。同一ミリ秒の行が並び順のタイブレーカに依存しているため、画面と削除範囲がずれうる。
- **切り捨ての位置**: `insertMessage` より**前**、`toClaudeMessages(listMessagesBySessionId(...))` より前で行う。後ろに置くと書き直した発言自身を消す、あるいは元の発言が LLM へ渡る。
- **終了済みセッションのガードはやりなおし経路にだけ足す**: 通常送信（`replaceFromMessageId` 未指定）に 409 を足すと、既存の `chat-messages-route.test.ts` の契約と `use-chat.ts` の想定（サーバ側ガードは無い）を黙って変えることになる。
- **朝会の冒頭あいさつ**（#271）: セッションの先頭は `role: "boss"` のことがある。ユーザーの最初の発言を切り捨ててもこの行は残り、`toClaudeMessages` の先頭 `assistant` 除去がそのまま効く。**この除去ロジックを触らないこと**（`LLM_BACKEND=api` でのみ露見する経路であり、既存の回帰テストが唯一の防御である）。
- **`buildTimeline` を通らない追記経路にも識別子を付ける（見落とすと確認 UI が過少表示になる）**: `web/src/use-chat.ts` の `messageEntry` ヘルパーは、SSE の `done` で届いたボスの応答を `buildTimeline` を経由せず直接タイムラインへ積む。ここに `messageId` / `sessionId` を付け忘れると、**リロードせずに複数ターン会話した状態**でそれより前の自分の発言を編集したとき、サーバでは削除されるボス応答が `selectRewriteRange` の対象から漏れ、**確認 UI の件数とハイライトが実際の削除範囲より少なくなる**。決定 6 が「実行前の提示だけが唯一の安全機構」と置いている以上、これは安全機構そのものの破れである。`messageEntry`（および `rewrite` 成功時に積むエントリ）にも `messageId: message.id` / `sessionId: message.session_id` を必ず設定すること。**`selectRewriteRange` 単体のユニットテストでは検出できない**（テストが手組みする `entries` は識別子が揃っているため）ので、`useChat` レベルの検証（AC-38c）で固定する。
- **切り捨て後にセッションのユーザー発言が 0 件になりうる**: 夕会でユーザーの最初の発言を編集対象にすると、切り捨て直後の一瞬だけ発言 0 件になる。同一トランザクションで書き直しが入るため確定状態では 0 件にならないが、[ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 1 の前提条件（ユーザー発言 1 件以上）に触れる箇所なので、テストで「やりなおし後も日報生成の前提条件を満たす」ことを確認すること。

## 既存テストの契約への影響

- **意図的に壊す**: `web/src/merge-timeline.test.ts` は `buildTimeline` の出力を `toEqual` で深い等価比較している。`kind: "message"` を含む `toEqual` 比較はすべて `messageId` / `sessionId` の追加で失敗し、`kind: "boundary"` のみの比較は影響を受けない。着手時に `grep -n 'toEqual' web/src/merge-timeline.test.ts` で該当箇所を洗い出し、**期待値に `kind: "message"` を含むものすべてに新フィールドを足して更新する**（行番号を網羅の根拠にしない）。振る舞いの契約（並び順・境界の導出）は変わらないため、**テスト名は変えない**。
- **意図的に壊す**: `web/src/use-chat.test.ts` の `result.current.entries` を `toEqual` で比較しているテストのうち、`kind: "message"` を含む期待値を持つものすべてが同じ理由で更新を要る（空配列比較など `kind: "message"` を含まないものは対象外）。着手時に `grep -n 'entries).toEqual' web/src/use-chat.test.ts` で対象箇所を再確認すること。こちらもテスト名は変えない。
- **壊さない**: `server/src/sessions/chat-messages-route.test.ts` / `chat-messages-route.client-abort.test.ts` / `chat-messages-route.issue-117.test.ts` — `replaceFromMessageId` は任意フィールドで、未指定時の挙動を変えないため。**未指定時の既存挙動が変わっていないことを確かめるテストを 1 本残す**こと。
- **壊さない**: `web/src/ChatView.test.tsx` — 追加要素のみで既存の描画契約は変えない。ただし編集ボタンが `listitem` の中に増えるため、ボタンの総数や DOM 構造に依存しているテストがあれば更新する（`getAllByRole("listitem")` の件数に依存している 1004 行目付近は `listitem` の数を変えないので影響しない）。

## 受入基準

### サーバ: 切り捨てのリポジトリ関数

- [ ] AC-1: `deleteMessagesFrom(db, sessionId, id)` は、対象メッセージ**自身を含めて**削除する
- [ ] AC-2: `deleteMessagesFrom` は対象より後（`listMessagesBySessionId` の並びで後）の同一セッションのメッセージを、`role` を問わず削除する
- [ ] AC-3: `deleteMessagesFrom` は対象より前の同一セッションのメッセージを削除しない
- [ ] AC-4: `deleteMessagesFrom` は**他セッションのメッセージを一切削除しない**（対象より新しい `created_at` を持つ他セッションの行が残ることをアサートする）
- [ ] AC-5: 同一の `created_at` を持つ 2 行のうち古い方（`id` が小さい方）を対象にすると、両方が削除される。新しい方を対象にすると、古い方は残る
- [ ] AC-6: `deleteMessagesFrom` は削除件数を返す
- [ ] AC-7: `findMessageInSession(db, sessionId, id)` は、その id が別セッションのメッセージである場合 `undefined` を返す

### サーバ: やりなおし経路のガード

- [ ] AC-8: `replaceFromMessageId` を指定せずに `POST /api/sessions/:id/messages` を呼んだときの永続化の挙動（メッセージの保存内容）が、本機能の実装前と変わらない
- [ ] AC-8b: `replaceFromMessageId` を指定せずに呼んだときの活動イベント（`chat_message` の記録内容）が、本機能の実装前と変わらない
- [ ] AC-8c: `replaceFromMessageId` を指定せずに呼んだときの SSE ストリームの形（`text` / `tool` / `done` / `error` の順序・内容）が、本機能の実装前と変わらない
- [ ] AC-8d: `replaceFromMessageId` を指定せずに呼んだときのエラー応答（既存の 400 / 404 のステータス・ボディ）が、本機能の実装前と変わらない
- [ ] AC-9: `replaceFromMessageId` が正の整数でない（文字列・0・負数・小数）とき 400 を返し、メッセージを削除も挿入もしない
- [ ] AC-10: 対象セッションの `ended_at` が非 NULL のとき 409 と `code: "session_already_ended"` を返し、メッセージを削除も挿入もしない
- [ ] AC-11: `replaceFromMessageId` が別セッションのメッセージ id のとき 404 と `code: "message_not_found"` を返し、メッセージを削除も挿入もしない
- [ ] AC-12: `replaceFromMessageId` が存在しないメッセージ id のとき 404 と `code: "message_not_found"` を返す
- [ ] AC-13: `replaceFromMessageId` が `role: "boss"` のメッセージのとき 400 と `code: "message_not_editable"` を返し、メッセージを削除も挿入もしない
- [ ] AC-14: AC-9〜AC-13 の**各拒否経路それぞれ**について、LLM 呼び出しが行われない（5 経路を代表 1 件で済ませず、経路ごとに検証する）

### サーバ: やりなおしの実行

- [ ] AC-15: 正常なやりなおしの後、`GET /api/sessions/:id/messages` は「対象発言より前のメッセージ ＋ 書き直した内容の `role: "user"` メッセージ ＋ ボスの新しい応答」だけを返す
- [ ] AC-16: 正常なやりなおしで LLM へ渡されたメッセージ列（`streamBossMessage` の `messages` 引数）に、切り捨てた発言の `content` が**含まれない**
- [ ] AC-17: 正常なやりなおしで LLM へ渡されたメッセージ列の末尾が、書き直した内容の `user` メッセージである
- [ ] AC-18: 正常なやりなおしで `chat_message` の活動イベントが 1 件**増える**（切り捨て前に記録済みの `chat_message` 行は減らない）
- [ ] AC-19: 切り捨て範囲にツール実行を含むやりとりがあっても、そのツールが作成・更新したタスクは削除・巻き戻されない
- [ ] AC-20: 切り捨て範囲に含まれるメッセージに対応する `activity_events` の行が削除されない
- [ ] AC-21: 書き直した発言の挿入が失敗した場合、切り捨ても行われない（削除だけが確定した状態にならない）
- [ ] AC-22: やりなおしの応答は従来と同じ SSE ストリーム（`text` / `done`）で返る
- [ ] AC-23: セッション先頭にボスの冒頭あいさつ（#271）がある状態で最初のユーザー発言をやりなおしても、あいさつ行は削除されず、LLM へ渡るメッセージ列の先頭は `user` になる
- [ ] AC-24: 夕会セッションで唯一のユーザー発言をやりなおした直後、そのセッションのユーザー発言件数は 1 件以上のままである（ADR 0008 決定 1 の前提条件のうち**発言件数の要件**。この時点ではセッションは未終了なので、前提条件の連言全体はまだ成立しない）
- [ ] AC-24b: 上記のやりなおしを経た夕会セッションを終了すると、日報生成の前提条件（ADR 0008 決定 1）が成立し、日報が生成される

### Web: 範囲算出（純粋関数）

- [ ] AC-25: `selectRewriteRange` は対象メッセージ自身を削除対象に含める
- [ ] AC-26: `selectRewriteRange` は対象より後の**同一セッション**のメッセージエントリを削除対象に含める
- [ ] AC-27: `selectRewriteRange` は対象より後にあっても**別セッション**のメッセージエントリを削除対象に含めない
- [ ] AC-28: `selectRewriteRange` は `kind: "boundary"` のエントリを削除対象に含めない
- [ ] AC-29: `selectRewriteRange` は `userCount` / `bossCount` を `role` 別に数え、`total` はその合計になる
- [ ] AC-30: 終了済みの会のメッセージが対象発言と後続発言のあいだに挟まっているタイムラインでも、AC-27 と AC-29 が成り立つ（#272 のマージ済みタイムラインの回帰）

### Web: `useChat` のやりなおし経路

- [ ] AC-31: `useChat` は送信先セッションの id を `activeSessionId` として公開する
- [ ] AC-32: `rewrite(messageId, content)` は `POST /api/sessions/:id/messages` を `{ content, replaceFromMessageId: messageId }` のボディで呼ぶ
- [ ] AC-33: `rewrite` の後、タイムラインから削除範囲のエントリが消え、書き直した内容の自分の発言とボスの応答が末尾に並ぶ
- [ ] AC-34: `rewrite` の後、削除範囲に含まれていた `kind: "tool"` のエントリもタイムラインから消える
- [ ] AC-35: `rewrite` の後、削除範囲外のエントリ（対象より前・別セッション）はタイムラインに残る
- [ ] AC-36: `rewrite` が失敗した場合、エラーが表示され、タイムラインからエントリが消えない
- [ ] AC-37: `sending` または `switching` の最中に `rewrite` を呼んでも何も起きない（既存の送信ガードと同じ抑止）
- [ ] AC-38: `buildTimeline` が生成するメッセージエントリは `messageId` と `sessionId` を持つ
- [ ] AC-38b: `useChat` が送信時に楽観追記する自分の発言のエントリは、`messageId` を持たない（サーバ id がまだ無いため）
- [ ] AC-38c: SSE の `done` で届いたボスの応答を `useChat` が追記したエントリは、`messageId` と `sessionId` を持つ（リロードを挟まずに複数ターン会話したあと、それより前の自分の発言を編集したときの削除件数が、実際にサーバが削除する件数と一致することまで確認する）

### Web: 画面

- [ ] AC-39: アクティブセッションの自分の発言には編集操作が表示される
- [ ] AC-40: ボスの発言には編集操作が表示されない
- [ ] AC-41: 終了済みの会のメッセージ（`sessionId !== activeSessionId`）には編集操作が表示されない
- [ ] AC-42: 楽観追記された（`messageId` を持たない）自分の発言には編集操作が表示されない
- [ ] AC-43: 生成中（`sending`）は編集操作が表示されない
- [ ] AC-44: 編集操作を開始しただけでは削除も送信も起きない（`fetch` が呼ばれない）
- [ ] AC-45: 編集操作を開始すると、削除される件数と内訳（あなたの発言 x 件・ボスの応答 y 件）が表示される
- [ ] AC-46: 編集操作を開始すると、**すでに実行された操作は取り消されない旨の警告**が表示される（決定 4 が要求するのは「明示すること」＝意味であり、文言そのものではない。既定の文言は「すでに実行された操作は取り消されません」とし、テストはこの既定文言に対して書く。文言を変えるならテストも同時に変える）
- [ ] AC-47: 編集操作を開始すると、削除対象のエントリが専用のクラス名で区別して表示される
- [ ] AC-48: 削除対象のハイライトのクラス名は `.chat-tool-notice` / `.chat-boundary` / `.chat-message-interrupted` のいずれとも異なる
- [ ] AC-49: 確定操作を押すとやりなおしが実行される
- [ ] AC-50: キャンセルすると元の表示に戻り、`fetch` が呼ばれず、タイムラインが変わらない
- [ ] AC-51: 編集中は下部の通常メッセージ入力欄が無効化される
- [ ] AC-52: 編集フォームの内容が空白のみのときは確定操作が無効になる

### 全体

- [ ] AC-53: `npm run lint` / `npm run typecheck` / `npm test` がすべて pass する
- [ ] AC-54: リロード後のタイムラインが、やりなおし直後のタイムラインと一致する（切り捨てが永続化されている）

## 明示的な仮定

1. **本仕様の 6 つのクリティカル設計決定は 2026-09-06 に親（flywheel エージェント）が確定したもの**であり、本ドキュメントはそれを記録した。導出決定 6-a / 6-b / 6-c は、実コード調査で判明した構造（#272 のマージ済みタイムライン・ツール通知が非永続であること・#254 の停止機構が実装済みであること）の上で 6 つの決定を成立させるために本仕様が導いたものである。
2. **API 形状（既存 POST への任意フィールド追加）は本仕様の判断**である。専用エンドポイント（`DELETE .../messages/:messageId`）を採らない理由は「機能全体の設計」に記した。受入基準を変えずに実装側で覆せる余地は残っている（AC-15〜AC-24 はエンドポイント形状に依存しない書き方になっている）。
3. **エラーコード名**（`session_already_ended` / `message_not_found` / `message_not_editable`）は既存の命名慣習（`evening_session_required` / `evening_session_already_exists` / `report_not_found` / `invalid_date`）に合わせて本仕様が命名した。受入基準に固定されるため、変更するなら受入基準も同時に変える。
4. **編集操作の見せ方**（ホバーで浮かせるか常設か）は CSS の裁量に委ねる。ただし**キーボードで到達でき、テストから安定して取得できる**こと（`aria-label` 等）を要件とする。ChatGPT のホバー表示に寄せてもよいが、ホバー専用にはしない。
5. **削除件数 N は対象発言自身を含む**。「この発言を含む N 件が削除されます」という言い回しで曖昧さを消す。
6. **`interrupted` なボス応答も通常の応答と同じく切り捨て範囲に入る**（特別扱いしない）。
7. **文言**（確認文・エラーメッセージ）は本仕様のものを既定値とする。**受入基準が要求するのは意味であって文字列一致ではない**（AC-46 の書き方に揃える）。実装で文言を調整してもよいが、そのときは同じ変更でテストの期待値も変える（テストは既定文言に対して書く）。UI の分岐は `code` で行い、文言に依存させない（ADR 0008 決定 2）。
8. **`user_version` は 6 のまま**であり、本機能はマイグレーションを追加しない。将来 `user_version` が進んでいたら、その番号を基準に読み替える。

## 関連

- Issue #255（本仕様の起点）
- Issue #254 / [docs/features/chat-generation-stop.md](chat-generation-stop.md) — 停止。本機能はその停止機構が実装済みであることを前提にする（導出決定 6-c）
- Issue #272 — タイムラインの統合表示。導出決定 6-a の前提
- Issue #271 — 会の冒頭あいさつ。「実装時に必ず対処する波及点」の対象
- [ADR 0005](../adr/0005-sqlite-schema-policy.md) 決定 2・4・5・6
- [ADR 0008](../adr/0008-evening-dialogue-prerequisite.md) 決定 1・2・4
- [ADR 0004](../adr/0004-deterministic-detection-engine.md) 決定 1（`activity_events` の位置づけ・決定 5 の根拠）
