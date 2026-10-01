# LLM 中継の実行基盤の比較（O4 の判断材料）

> Issue #583 の S3（ホスティング）の未決 **O4「実行基盤・事業者キーの管理体制」** を、オーナーが決めるための比較資料。2026-10-01 にオーナーが「O4 は比較の資料を先に作る」と決めたことを受けて作った。
>
> **これは決定ではない**。O4・O2（上限値・価格帯）・O5（#595 と基盤を共用するか）を決めるのはオーナーである。下の「推奨」は判断の材料として 1 案を挙げたもので、採否はオーナーが決める。O4 が決まったら、その結果を [機能仕様](./llm-relay-server.md) の決定の表と S3 に反映する（本資料からは仕様を変えない）。
>
> 実行基盤の仕様・料金は、2026-10-01 に公式ドキュメント・料金ページを参照して確かめた（末尾「一次情報」）。確かめられなかった項目は「未確認」と書いた。実行基盤のアカウント作成・デプロイ・実 API の呼び出しはしていない。実コードの参照は `main` 4145436 の `relay/src/` である。

## 1. 中継が実行基盤に求める要件（実コードの根拠つき）

中継のコア（`relay/`）は S1・S2 でマージ済みで、実行基盤に載せるには **入口（エントリ）と、ポートの本番の実装** を S3 で書く。`relay/src/index.ts` は `createRelayApp` とポートの型を公開するだけで、実行基盤の入口はまだ無い。

| # | 要件 | 根拠（実コード） | 実行基盤への含意 |
|---|---|---|---|
| R1 | Web 標準の API（`fetch`・`Request`・`Response`・`ReadableStream`）と Hono だけで動く | `relay-app.ts:38-39` のコメント、`relay-bundle.test.ts`（`platform: "browser"` で束ね、Node の組み込み・グローバルの参照を禁じる） | Web 標準の API を持つ実行系ならコアは変えずに載る。Node 上でも `@hono/node-server` で動く |
| R2 | 応答をバッファせず逐次流す。アプリが読まない分は内部の待ち行列に溜め、`maxBufferedResponseBytes`（既定 1 MiB）を超えたら上流を止める | `relay-app.ts:349-417`（`ReadableStream` の `highWaterMark` をバイト数で数える）、`config.ts` の `maxBufferedResponseBytes` の説明（1 要求の定常の保持量は上限の約 3 倍） | 実行基盤（前段のプロキシを含む）が応答をバッファ・圧縮しないこと。1 要求あたり最大 3 MiB 程度のメモリを見込む |
| R3 | アプリの中止（接続の切断）を上流への要求に伝える | `relay-app.ts:240-242`（`request.signal` の `abort` を上流の `AbortController` へつなぐ）、`ports.ts` の `UpstreamFetch(request, signal)` | **実行基盤が、クライアントの切断を受信した要求の `request.signal` に伝える**こと。伝わらないと、アプリが止めても上流は最後まで生成し課金される（仕様の決定 Q1 の「アプリの中止をプロバイダへの要求に伝える」が満たせない） |
| R4 | 応答を返した後も、上流を最後まで読み、終わったら精算する。アプリが切断したときも `cancel()` から精算する | `relay-app.ts:366-406`（`start` の中で上流を読み続ける非同期の処理）、`relay-app.ts:408-413`（`cancel()` が精算の Promise を返す） | 応答を返した後・クライアントの切断後も、精算が終わるまで処理が打ち切られないこと |
| R5 | 応答を終える（ストリームを閉じる）のは精算の書き込みが終わってから | `relay-app.ts:244-247`・`:394-405`、仕様のクリティカル設計決定 2 | 「応答の終了後に未完了の Promise を待たない」実行系でも、正常終了の経路は精算が先に終わる（下の AWS の項） |
| R6 | 利用量のポート: アカウントごとの**原子的な予約**（日・月の確定額＋未精算の予約額＋今回の額 ≤ 上限、かつ未精算の件数 < 同時要求数の上限）と、**1 回だけの精算**（冪等） | `usage-store.ts:72-97`（ポートの契約）、`:104-153`（メモリ実装は `await` を挟まない同期の処理で原子性を担保） | 永続化する保存先で、**アカウント単位の read-modify-write を 1 つの操作で**行えること（トランザクション・単一スレッドのオブジェクト等） |
| R7 | 期限切れの予約の回収（予約額で確定）と `settle` の失敗時の再試行（**S3 の完了条件**） | `usage-store.ts:89-91`（回収は `settle(id, { type: "reserved" })` と同じ遷移）、`relay-app.ts:253-256`（`settle` の失敗はログだけ残して予約を孤立させる） | 定期実行の仕組みと、期限切れの予約を取り出す問い合わせ。現在のポートには「期限切れの予約の一覧」の操作が無く、S3 で足す |
| R8 | 上流の失敗の区分（送る前／送った後）を実行系の `fetch` の例外から作る | `ports.ts` の `UpstreamFailure`・`createFetchUpstream` のコメント（区分は S3 で作る。それまでは区分の無い例外＝送った後＝予約額で確定） | 実行系の `fetch` が接続の確立の失敗を見分けられる例外を投げるか。見分けられなければ安全側（予約額で確定）のまま運用できる |
| R9 | 上流のリダイレクトに従わない（`redirect: "manual"`） | `ports.ts` の `createFetchUpstream` | 実行系の `fetch` が `redirect: "manual"` を受け付けること |
| R10 | 要求本文を `maxRequestBytes` まで読む | `relay-app.ts:113-137`（`readBodyWithLimit`） | 実行基盤の要求本文の上限が `maxRequestBytes`（O2）以上であること |
| R11 | 事業者のキーは文字列で注入する（応答・ログ・記録に出さない） | `relay-app.ts:53-62`（`RelayDeps.operatorKey`）・`:70-79`（ヘッダに使えるか検証） | 実行基盤の秘密情報の仕組みから起動時に読む |
| R12 | 中継のログはログのポートにだけ出す（`console` を使わない）。渡す項目は固定 | `ports.ts` の `RelayLogRecord`、`relay-privacy.test.ts` | **実行基盤が自動で取る要求ログ**に本文と `authorization`（ライセンストークン）が入らないこと（仕様の決定 Q5・クリティカル設計決定 6・非機能要件「アプリの利用者のトークンもログに出さない」） |
| R13 | 期間キーは UTC の暦日・暦月 | `usage-metering.ts:69`（`periodKeys`）、仕様の仮定 A5 | 実行基盤の時刻帯に依存しない（どの基盤でも同じ） |

**仕様との差分（実コードを正とした）**: 仕様は R3 を前提にしているが、実行基盤によっては既定で満たされない（下の評価の Cloudflare・Cloud Run は設定で満たせる、AWS Lambda の Function URL は満たせない）。また R4 の「切断後の精算」は、Cloudflare Workers では `ctx.waitUntil()` へ渡さないと打ち切られうる（コアは `waitUntil` を受け取る口を持たない）。打ち切られても予約は期限で予約額に確定する（R7）ため枠は破られないが、精算が遅れ、その間は同時要求数の枠を占める。

## 2. 候補ごとの評価

前提: 本番の上流は `https://api.anthropic.com/v1/messages`（仕様の仮定 A8）。Anthropic の SSE には `ping` イベントが任意の数だけ含まれうる（[Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)）。ただし送られる間隔は**未確認**で、無通信のタイムアウトを `ping` で避けられるとは言い切れない。

### 2.1 Cloudflare Workers ＋ Durable Objects

- **逐次の中継**: 応答の本文を `ReadableStream` で流せる。HTTP で起動した Worker の経過時間に硬い上限は無く、「クライアントが接続している限り処理を続けられる」。ストリーミングの本文を受信中は `ctx.waitUntil()` なしで起動が続く（[Limits](https://developers.cloudflare.com/workers/platform/limits/)・[Context](https://developers.cloudflare.com/workers/runtime-apis/context/)）。CPU 時間は Paid で既定 30 秒・最大 5 分（上流を待つ時間は CPU 時間に入らない）。メモリは isolate あたり 128 MB。
- **中止の伝播（R3）**: 互換フラグ **`enable_request_signal`** を付けると `request.signal` で切断を検知できる。**どの互換日付でも既定では無効**（[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)・[changelog 2025-05-22](https://developers.cloudflare.com/changelog/2025-05-22-handle-request-cancellation/)）。サブ要求の `fetch` は `signal` で中止できる（[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)）。コアは自前の `AbortController` を `request.signal` につないでいる（R3）ため、フラグ 1 つで満たせる見込み（実機での確認は S3）。
- **切断後の精算（R4）**: 切断すると要求に紐づく処理は取り消されうる。`ctx.waitUntil()` に渡した処理は応答の送信後・切断後 **30 秒まで**延長される（[Context](https://developers.cloudflare.com/workers/runtime-apis/context/)）。コアの `cancel()` の精算を `waitUntil` に載せる口が要る（コアの小さな変更。§1 の「仕様との差分」）。
- **原子的な予約と同時要求数（R6）**: **アカウントごとに 1 つの Durable Object** を置き、その中の SQLite で予約・精算する。Durable Object は単一スレッドで、`await` を挟まない一連の書き込みは原子的に確定し、`transactionSync()` が使える（[What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)・[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)）。S1 のメモリ実装と同じ「同期の処理で判定と追加を行う」形がそのまま移せる。D1 は `batch` が 1 つのトランザクションだが対話型のトランザクションが無く、「読んでから判定して書く」には向かない（[D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)）。
- **永続化と回収（R7）**: Durable Object の SQLite（30 日の時点復旧つき）。期限切れの予約の回収は、オブジェクトごとの **Alarm**（少なくとも 1 回の実行・失敗時は再試行）で、そのアカウントの最も早い期限に合わせて起こせる（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)）。Cron Triggers も使える。
- **事業者キー**: `wrangler secret` で設定し、設定後は Wrangler・ダッシュボードから値を読み戻せない。`wrangler versions secret put` → `versions deploy` で段階的に差し替えられる（[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)）。権限は **アカウント単位のロール**（Workers Platform Admin・Read-only 等）で、Worker 単位には絞れない（[Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)）。デプロイできる人は値を出力するコードを載せられる（どの基盤でも同じ）。
- **ログ（R12）**: **新しく作った Worker は観測（Workers Logs）が既定で有効**で、`console.log` と、Request・Response と関連のメタデータを含む「invocation logs」を集める。`observability.logs.invocation_logs = false` で invocation logs を止められ、`observability.enabled = false` で観測ごと止められる（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。invocation logs にヘッダが入るか・伏せ字があるかは**未確認**。Tail のイベントは URL・メソッド・ヘッダを含むが、名前に `auth`・`key`・`token` 等を含むヘッダは既定で `REDACTED` になり、本文を含む記述は無い（[Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)）。→ S3 では invocation logs を止め、Tail・Logpush を使わない設定を手順に書く。
- **`relay/` の変更量**: 最小。Hono は Workers に公式対応（[Hono: Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)）。足すもの: 入口（`export default`）、Durable Object の利用量のポート、`waitUntil` の口、互換フラグ、`UpstreamFailure` の区分（実行系の例外の調査が要る）。
- **データの置き場所**: Durable Object の管轄（jurisdiction）は `eu`・`us`・`fedramp` だけで**日本は無い**。位置の希望（location hint）は `apac-ne` 等の地域単位（[Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)）。保存するのはアカウント ID と利用量の数値だけ（`usage-store.ts` の型）である。
- **運用**: サーバーの管理は無い。`wrangler deploy` で全世界に出る。障害は Cloudflare の障害に連動する。

### 2.2 Fly.io（コンテナ・Machines）＋ Managed Postgres

- **逐次の中継**: Fly Proxy は**圧縮のために応答をバッファする**。アプリが `Content-Encoding: none` を付ければ素通しになる（[Content encoding](https://docs.fly.io/reference/content-encoding/)）。コアは上流の `content-type`・`retry-after`・`request-id` しか通さない（`relay-app.ts:48`）ため、入口でこのヘッダを足す必要がある。アイドルのタイムアウトは `http_options.idle_timeout` で設定できるが、**既定値・上限・最大の要求時間は公式で未確認**（コミュニティの情報では既定 60 秒）（[Configuration](https://docs.fly.io/reference/configuration/)）。
- **中止の伝播（R3）**: プロキシがクライアントの切断をアプリへ伝えるかは**未確認**。
- **切断後の精算（R4）**: 常駐のプロセスなので、応答の後も処理は続く。ただし `auto_stop_machines` を使うとプロキシは流入の通信だけを見てマシンを止める（コンテナの中は見ない）ため、**自動停止は切るか `min_machines_running ≥ 1`** にする（[Autostop](https://docs.fly.io/launch/autostop-autostart/)・[Long-running tasks](https://docs.fly.io/blueprints/long-running-tasks/)）。
- **原子的な予約（R6）・永続化（R7）**: Managed Postgres（最小の Basic は $38/月・全プランに HA・バックアップ・接続プール。東京 `nrt` 対応）で、アカウントの行を `SELECT … FOR UPDATE` で固定してから判定・挿入する形が素直（[Managed Postgres](https://docs.fly.io/mpg/)・[Pricing](https://fly.io/pricing/)）。旧来の Fly Postgres は保守終了（[Unmanaged Postgres](https://docs.fly.io/unmanaged-postgres/)）。LiteFS（SQLite）は 1.0 前で、自動停止と併用しないよう明記がある（[LiteFS](https://docs.fly.io/litefs/)）。回収はアプリ内の定期処理（台数 1 前提）か Cron Manager（[Task scheduling](https://docs.fly.io/blueprints/task-scheduling/)）。
- **事業者キー**: `fly secrets set` で暗号化した保管庫に入り、起動時に環境変数として渡る。平文の値は読み戻せない。値を変えると全マシンが更新・再起動される（[Secrets](https://docs.fly.io/apps/secrets/)）。組織のロールは Member と Admin の 2 つだけで、**Member もデプロイ・シークレットの管理ができる**。アプリ単位の権限は**未確認**（[Org roles](https://docs.fly.io/security/org-roles-permissions/)）。
- **ログ（R12）**: アプリの標準出力がログになる（コアは出さない）。**Fly Proxy のアクセスログの項目（ヘッダ・本文を残すか）は未確認**（[Logging](https://docs.fly.io/monitoring/logging-overview/)）。
- **`relay/` の変更量**: 中。`@hono/node-server` の入口、`Content-Encoding: none` の付与、Postgres の利用量のポート、回収の定期処理、`UpstreamFailure` の区分（Node の `fetch`〔undici〕の例外から作る）。
- **運用**: マシンとデータベースの台数・容量・更新を自分で決める。SLA は Enterprise サポート（$2,500/月〜）にだけ記載（[Pricing](https://fly.io/pricing/)）。

### 2.3 AWS Lambda（応答ストリーミング）＋ DynamoDB

- **逐次の中継**: Function URL（`InvokeMode: RESPONSE_STREAM`）・`InvokeWithResponseStream`・API Gateway のプロキシ統合でストリーミングできる。管理ランタイムで対応するのは **Node.js だけ**。最初の 6 MB は帯域の上限なし、以降は 2 MBps。実行時間の上限は 15 分（[Response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)・[Quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)）。Hono は `streamHandle` で対応（[Hono: AWS Lambda](https://hono.dev/docs/getting-started/aws-lambda)）。API Gateway の REST API は 2025-11 からストリーミングに対応（[What's New](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis)）。
- **中止の伝播（R3）**: **満たせない**（Function URL の場合）。公式に「呼び出し元の接続が切れても、ストリーミングの応答は中断も停止もされず、関数の実行時間の全体に課金される」とある（[Response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)）。アプリが中止しても上流は最後まで生成し、事業者に課金される（利用者の枠も実額で減る）。API Gateway 経由で切断が伝わるかは**未確認**。
- **応答の後の処理（R4・R5）**: Node.js 24 以降は、ハンドラが返った・ストリームが終わった後に未解決の Promise を待たない（[Writing streaming functions](https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html)）。コアは精算を終えてからストリームを閉じる（R5）ため正常終了の経路は問題ない。切断は伝わらない（上）ので、上流を最後まで読み実額で精算する。
- **原子的な予約（R6）**: DynamoDB の条件付き書き込み・`TransactWriteItems`（最大 100 操作・`ClientRequestToken` で 10 分間冪等）。**条件式の中で足し算ができない**ため、アカウント×期間の集計の項目に「確定額＋予約額」を持ち、`上限 − 今回の額` を呼び出し側で計算して条件に渡す設計になる（[Transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)・[Condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html)）。同時要求数の件数も同じ項目で数える。競合時は `TransactionCanceledException` で再試行は自前。
- **回収（R7）**: TTL は「期限から通常数日以内」に削除するだけで精算にならない（[TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html)）。EventBridge Scheduler で回収の関数を定期実行する（月 1,400 万回まで無料。[Pricing](https://aws.amazon.com/eventbridge/pricing/)）。
- **事業者キー**: Secrets Manager（1 件 $0.40/月。すべての API 呼び出しが CloudTrail に記録される）（[Pricing](https://aws.amazon.com/secrets-manager/pricing/)・[CloudTrail](https://docs.aws.amazon.com/secretsmanager/latest/userguide/monitoring-cloudtrail.html)）。IAM で読める主体を関数の実行ロールだけに絞れる（IAM のポリシーの詳細ページは未取得＝**未確認**）。4 候補で最も細かく権限と監査を持てる。
- **ログ（R12）**: CloudWatch Logs に入るのは標準出力と START・END・REPORT の行。Function URL のアクセスログの機能は無く、メトリクスと CloudTrail（データイベントは既定で記録しない）だけ（[CloudWatch Logs](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html)・[Function URL monitoring](https://docs.aws.amazon.com/lambda/latest/dg/urls-monitoring.html)）。本文・ヘッダが自動で残る経路は見当たらない。
- **`relay/` の変更量**: 中〜大。`streamHandle` の入口、DynamoDB の利用量のポート（集計の項目の設計が S1 のメモリ実装と形が違う）、回収の関数、中止が伝わらないことの扱い（仕様の決定 Q1 の改訂か、API Gateway 経由での確認）。
- **地域**: ストリーミングは「すべてのリージョンではない」とあり、**東京で使えるかは未確認**（[Response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) の注記）。DynamoDB・CloudWatch Logs は東京の料金表がある。
- **代替**: App Runner は要求の合計のタイムアウトが 120 秒で長いストリームに向かず、新規の受け付けも停止している（[App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/develop.html)）。ECS Fargate は調べていない。

### 2.4 Google Cloud Run ＋ Firestore（追加の候補）

コンテナを要求に応じて動かし、1 つのインスタンスで多数の同時要求を受けられる（待ち時間の課金がインスタンス単位でまとまる）ため、Fly.io と Lambda の中間として加えた。

- **逐次の中継**: 設定なしで HTTP の応答をストリーミングできる。要求のタイムアウトは既定 300 秒・最大 3,600 秒（[HTTPS request](https://docs.cloud.google.com/run/docs/triggering/https-request)・[Request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)）。SSE について前段がバッファしないかの明記は**未確認**。
- **中止の伝播（R3）**: **HTTP/1.1 ではクライアントの切断がコンテナへ伝わらない**。伝えるには end-to-end の HTTP/2（`--use-http2`・コンテナが h2c を受ける）にする（[Troubleshooting](https://docs.cloud.google.com/run/docs/troubleshooting)・[HTTP/2](https://docs.cloud.google.com/run/docs/configuring/http2)）。h2c で `@hono/node-server` の `request.signal` に切断が届くかは**未確認**（実測が要る）。
- **応答の後の処理（R4）**: 既定の「要求ベースの課金」では CPU は要求の処理中だけ割り当てられる（[Billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)）。コアは精算を終えてからストリームを閉じる（R5）ため正常終了の経路は問題ない。切断後の精算が CPU の割り当ての外で動くかは**未確認**（インスタンスベースの課金なら常に割り当てられる）。
- **原子的な予約（R6）・回収（R7）**: Firestore のトランザクション（楽観的な並行制御で、競合時は関数ごと再実行。読み取りは書き込みの前）（[Transactions](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions)）。TTL の削除は期限から通常 24 時間以内で、精算にはならない（[TTL](https://docs.cloud.google.com/firestore/native/docs/ttl)）。回収は Cloud Scheduler（[Locations](https://docs.cloud.google.com/scheduler/docs/locations)）。Cloud SQL（Postgres）も選べるが料金は未調査。
- **事業者キー**: Secret Manager。ボリュームで渡すと実行時に最新の値を読む（ローテーションに追随）。読む権限は `roles/secretmanager.secretAccessor` で絞れる。値の読み取りの監査（Data Access ログ）は**既定で無効**で、有効化が要る（[Secrets in Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/secrets)・[Audit logging](https://docs.cloud.google.com/secret-manager/docs/audit-logging)）。
- **ログ（R12）**: 要求ログは自動で作られ、止められない（Cloud Logging の除外フィルタで外す）。項目は URL（クエリを含む）・ステータス・サイズ・利用者のエージェント・IP・待ち時間等で、**ヘッダ・本文の項目は無い**（[Cloud Run logging](https://docs.cloud.google.com/run/docs/logging)・[LogEntry](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry)）。トークンを URL に載せない（コアは `authorization` ヘッダで受ける）限り、トークンは要求ログに入らない。
- **`relay/` の変更量**: 中。`@hono/node-server`（h2c）の入口、Firestore の利用量のポート、回収のジョブ、`UpstreamFailure` の区分。
- **地域**: Cloud Run・Firestore・Scheduler・Secret Manager はいずれも東京（`asia-northeast1`）にある。

## 3. 比較表

記号: ◎ 設定なしで満たす／○ 設定や小さな追加で満たす／△ 設計の工夫か実測が要る／× 満たせない。

| 観点 | Cloudflare Workers ＋ DO | Fly.io ＋ MPG | AWS Lambda ＋ DynamoDB | Cloud Run ＋ Firestore |
|---|---|---|---|---|
| 逐次の中継（R2） | ◎ | ○（`Content-Encoding: none` が要る。アイドルの既定は未確認） | ◎（Node.js のみ） | ◎（SSE の明記は未確認） |
| 中止の伝播（R3） | ○（`enable_request_signal`） | △（未確認） | ×（Function URL は中断されない） | △（HTTP/2 が要る・実測が要る） |
| 実行時間の上限 | 接続中は無し | 未確認 | 15 分 | 60 分 |
| 切断後の精算（R4） | ○（`waitUntil` の口・30 秒） | ◎（常駐） | ◎（上流を最後まで読む） | △（未確認） |
| 原子的な予約（R6） | ◎（アカウントごとの DO・同期の処理） | ◎（Postgres の行ロック） | △（条件式で足し算ができない。集計の項目の設計） | ○（楽観的トランザクション・再実行） |
| 回収（R7） | ◎（DO の Alarm） | ○（アプリ内の定期処理） | ○（EventBridge Scheduler） | ○（Cloud Scheduler） |
| キーの読める人の範囲 | アカウント単位のロール | 組織の Member 以上 | IAM で関数のロールに限定・CloudTrail | IAM で限定・監査は要有効化 |
| 自動の要求ログ（R12） | 既定で有効（invocation logs を止める設定が要る） | プロキシのログは未確認 | 自動のアクセスログ無し | 要求ログに本文・ヘッダの項目無し |
| `relay/` の変更量 | 小 | 中 | 中〜大 | 中 |
| 固定費（月） | $5（Workers Paid） | 約 $58〜（2 台＋MPG） | ほぼ $0 | ほぼ $0（最小インスタンス 0） |
| 運用の手間 | 小（サーバー無し） | 大（台数・DB を管理） | 中（部品が多い） | 中 |
| 日本にデータを置く | ×（管轄に日本が無い。地域の希望は `apac-ne`） | ○（`nrt`） | ○（東京） | ○（東京） |

## 4. 費用の見積もり（前提つき）

**前提**（仕様「推論原価の見積もり」と揃える）: 1 利用者あたり 1 日 21 回の呼び出し（チャット 11・要約 2・開始文 2・ひとこと 2・夕会の要約抽出 1・通知文面 3）→ **月 630 回**。1 回の経過時間の平均を 10 秒、CPU 時間を 5 ms、1 回あたりの利用量の保存先の書き込みを予約 1・精算 2（予約の削除と記録）と仮定した（いずれも実測していない）。為替・税・データ転送は除く。Cloud Run・Firestore・Secret Manager の単価は検索結果の要約から取った値で、料金ページの本文では確かめられていない（**要確認**）。

| 利用者数（月の呼び出し） | Cloudflare | Fly.io | AWS（arm64・512 MB） | Cloud Run（1 vCPU・512 MiB） |
|---|---|---|---|---|
| 100（6.3 万） | 約 $5（すべて Paid の込みの枠内） | 約 $58（512 MB×2 台 $20 ＋ MPG Basic $38） | 約 $0（無料枠内） | 約 $0〜10 |
| 1,000（63 万） | 約 $5 | 約 $58 | 約 $40（実行時間 315 万 GB 秒） | 約 $50（ほぼ常時 1 インスタンス）＋ Firestore |
| 10,000（630 万） | 約 $7〜100（DO の duration の扱いで幅） | 約 $60〜100（メモリを増やす） | 約 $450（実行時間 3,150 万 GB 秒）＋ DynamoDB 約 $30 | 約 $65 ＋ Firestore 約 $35 |

- **Cloudflare**: Workers の課金はリクエストと CPU 時間だけで、上流を待つ時間は課金されない（[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)）。DO は 1 回の中継あたり 2 回（予約・精算）呼ぶ。DO は**動いている間・休止できずにメモリに残る間の経過時間に 128 MB 分で課金**され、保留中の I/O は 1 件につき最大 15 分オブジェクトを留める（[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。DO の中で上流を呼ばない（予約・精算の短い呼び出しだけにする）設計で下限の $7、DO が 1 回あたり 10 秒留まると仮定した上限で約 $100 になる。
- **AWS**: 実行時間の課金が経過時間で、上流を待つ時間も課金される（$0.0000133334/GB 秒・arm64・東京）。切断しても最後まで動く（上の R3）。
- **推論原価との比較**: 推論原価は既定の Haiku 4.5 で 1 利用者あたり約 $2.9/月（典型的な日）。1,000 人で約 $2,900/月に対し、実行基盤はどの候補でも数 % 以下である。**実行基盤の費用は O2（価格帯）をほとんど動かさない**。費用より、中止の伝播（上流の無駄な生成＝推論原価に効く）と運用の手間のほうが差が大きい。

## 5. 実行基盤によらない事業者キーの対策

- Anthropic の Console で**中継専用のワークスペース**を作り、キーをそのワークスペースに限定し、ワークスペースに**月の支出の上限と警告**を設定できる（[Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)）。中継の枠（O2）が破られた場合・キーが漏れた場合の最終の上限になる。どの候補でも併用を勧める。
- ローテーションは「新しいキーを作る → 実行基盤の秘密情報を差し替える → 古いキーを無効にする」の手順を S3 で書く（実行基盤ごとの差は、差し替えに再デプロイ・再起動が伴うかだけ）。

## 6. 障害時に止まる範囲（どの候補でも同じ）

中継が落ちたときに止まるのは**プラン込みの利用者の LLM の呼び出しだけ**である。チャットは失敗し、ダッシュボードのひとこと・通知文面・会議の開始文はテンプレートへ退避する（仕様の決定 Q3）。**催促（検知と通知）は端末で動くため止まらない**（ADR 0011 決定 12）。BYOK の利用者は中継を通らない（ADR 0011 決定 10）ため影響を受けない。したがって、単一の地域・単一の実行基盤で始めても、障害の影響は「プラン込みのチャットが使えない時間」に限られる。

## 7. O5（#595 の同期の中継と基盤を共用するか）

同期の中継は「端末で暗号化した変更分を、相手の端末が受け取るまで預かり、受け取られたら削除する・期限つき・ログに残さない」（ADR 0011 決定 18・ADR 0001「改訂（2026-09-26・端末間同期の中継）」の決定 3）。必要な部品は「宛先ごとの郵便受け（保存・取り出し・削除）」「期限切れの削除」「本文を残さないログ」で、LLM 中継の「アカウントごとの状態」「期限切れの回収」「本文を残さないログ」と重なる。

| 候補 | 共用のしやすさ |
|---|---|
| Cloudflare | 宛先（端末の組・共有の範囲）ごとに DO を置き、期限を Alarm で消す形が LLM 中継と同じ型で書ける。暗号文の置き場所の上限は DO あたり 10 GB・行あたり 2 MB（[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)）。端末への即時の配達に WebSocket を使う場合の課金・休止の挙動は**未確認** |
| Fly.io | 同じ Postgres に表を足せる。暗号文の量が増えると DB の容量の管理が要る |
| AWS | DynamoDB（項目 400 KB の上限は未確認）か S3 のオブジェクト＋ライフサイクル。部品は増える |
| Cloud Run | Firestore か Cloud Storage。同じプロジェクトにまとめられる |

#627 は予約通知の維持に決まったため、プッシュ通知の基盤は観点に含めない。#595 の仕様はまだ無く、暗号文の大きさ・期限の長さ・配達の方式（取りに行くか、押し出すか）が決まっていないため、**共用の可否は #595 の仕様策定で確定させるのが妥当**である（O4 を先に決めても、上の 4 候補はいずれも同期の中継を載せられないわけではない）。

## 8. 推奨（1 案・決定ではない）

**Cloudflare Workers ＋ アカウントごとの Durable Object（SQLite）＋ DO の Alarm による回収**を推す。

- **理由**
  1. `relay/` のコアをほぼ変えずに載る（Web 標準の API と Hono だけで書いた S1 の方針〔非機能要件「実行基盤の非依存」〕が最も素直に生きる）。
  2. 原子的な予約が「アカウントごとの単一スレッドのオブジェクトで、`await` を挟まずに判定と追加を行う」形になり、S1 のメモリ実装の原子性の根拠（`usage-store.ts:104-108`）と同じ型で書ける。期限切れの回収も同じオブジェクトの Alarm で閉じる。
  3. 上流を待つ時間が課金されず、固定費が $5/月で、規模が増えても費用がほぼ増えない。
  4. サーバー・DB の台数を管理しない（運用の手間が最も小さい）。
  5. O5 で同期の中継を載せる場合も同じ型（宛先ごとのオブジェクト＋期限の Alarm）で書ける。
- **代償・条件**
  - 互換フラグ `enable_request_signal` を付けないと中止が伝わらない（S3 の手順と自動テスト、実機での確認に入れる）。
  - 切断後の精算を `ctx.waitUntil()` に載せる口をコアに足す（小さな変更。載せなくても期限で予約額に確定するため枠は破られない）。
  - **Workers Logs が既定で有効**で、invocation logs を止める設定と、その設定が効いていることの検査手順（仕様の決定 Q5 の本番ログの検査）が要る。invocation logs にヘッダが入るかは未確認のため、S3 で実機で確かめる。
  - 利用量のデータを**日本に限定して置けない**（地域の希望 `apac-ne` まで）。保存するのはアカウント ID と利用量の数値だけだが、プライバシーポリシー（#589）の記載に影響しうる。
  - 権限がアカウント単位で、キーを扱える人を Worker 単位に絞れない（AWS より粗い）。Anthropic のワークスペースの支出の上限（§5）で最終の上限を持つ前提にする。
  - DO の duration の課金の実態（短い呼び出しのあとどれだけメモリに残るか）は実機で測るまで幅がある（§4）。
- **次点**: 日本にデータを置くこと、または権限と監査の細かさが必須なら **Cloud Run（HTTP/2）＋ Firestore**。中止の伝播と切断後の精算は実測で確かめる必要がある。AWS Lambda は、Function URL では中止が伝わらない（仕様の決定 Q1 を満たせない）ため推さない。Fly.io は固定費と運用の手間に見合う利点が、この規模では見当たらない。

## 9. オーナーへの問い（O4 を決めるために必要なもの）

1. **規模と費用の上限**: 初回リリースと 1 年後の想定の利用者数（プラン込み）と、実行基盤に払える月額の上限。§4 のとおり、どの候補でも推論原価に比べて小さいため、上限が月 $100 程度あれば費用で候補は絞られない。（O2 の価格帯と同じ前提の数字を使う）
2. **データを日本に置く必要があるか**: 中継が保存するのはアカウント ID と利用量の数値だけ。日本に限る必要があれば Cloudflare は外れる。（#589 のプライバシーポリシー、#584 のアカウント・課金のデータの置き場所と絡む）
3. **運用の手間の許容**: サーバー・DB の台数や更新を自分で管理してよいか（Fly.io）、管理しない形（Cloudflare・Cloud Run・Lambda）に限るか。
4. **既存のアカウント**: Cloudflare・AWS・Google Cloud・Fly.io のうち、すでに事業者として持っている（請求先が決まっている）アカウントはあるか。
5. **事業者キーを扱える人の範囲**: 当面オーナー 1 人か、将来ほかの人がデプロイするか。複数人なら、権限を細かく分けられる AWS・Google Cloud が有利になる。あわせて、Anthropic 側に中継専用のワークスペースと支出の上限を置くか（§5。推奨）。
6. **#584（アカウント・ライセンス・課金）を同じ基盤に置くか**: 中継の認証のポート（S4）は #584 のトークンを検証する。同じ基盤に置けば検証が内部の呼び出しで済む。#584 の保存先（DO・D1／Postgres／DynamoDB／Firestore）の選択を O4 が事実上決めることになる。
7. **O5**: #595 との共用を O4 と同時に決めるか、#595 の仕様策定まで待つか（§7。待つことを勧める）。
8. **中止の伝播をどこまで求めるか**: 仕様の決定 Q1 は「アプリの中止をプロバイダへの要求に伝える」としている。AWS Lambda を採るならこれを緩める（中止しても上流は最後まで生成し、事業者に課金される）改訂が要る。

## 10. 未確認事項（S3 の実機の確認か、オーナーの判断の前に確かめるもの）

- Cloudflare: invocation logs にヘッダ（`authorization`）が入るか・伏せ字があるか／`enable_request_signal` で切断したときの `abort` の細かい挙動と、その後の `waitUntil` の 30 秒が保証されるか／Workers が作った応答に無通信のタイムアウト（100 秒・125 秒の話がある）が効くか／DO の duration の課金の実態／WebSocket の休止の課金（O5）／Workers の `fetch` の例外から「送る前の失敗」を見分けられるか（R8）。
- Fly.io: プロキシのアイドルのタイムアウトの既定値と上限・最大の要求時間／切断がアプリへ伝わるか／プロキシのアクセスログの項目／Managed Postgres のバックアップの頻度と保持期間／アプリ単位の権限。
- AWS: 東京で Lambda の応答ストリーミングと Function URL が使えるか／API Gateway の REST API 経由で切断が伝わるか／Secrets Manager の IAM・リソースポリシーの詳細（ページ未取得）／Lambda のログに当たる CloudWatch Logs の取り込み単価。
- Google Cloud: Cloud Run の SSE の前段のバッファの有無／h2c で `@hono/node-server` に切断が届くか／要求ベースの課金で切断後の精算が動くか／料金ページの本文（Cloud Run・Firestore〔東京〕・Scheduler・Secret Manager・Logging の単価。本資料の値は検索結果の要約から取った）／Cloud SQL の最小構成の料金。
- 共通: Anthropic の SSE の `ping` の間隔（無通信のタイムアウトとの関係）／1 回の呼び出しの経過時間と CPU 時間の実測（§4 の前提）。

## 11. 一次情報（いずれも 2026-10-01 に確認）

WebFetch による取得はページの要約を経由しているため、料金・上限の値を決定に使う前に原文を目で確かめてほしい。

- Cloudflare
  - Workers の制限 https://developers.cloudflare.com/workers/platform/limits/
  - Workers の料金 https://developers.cloudflare.com/workers/platform/pricing/
  - Context（`waitUntil`） https://developers.cloudflare.com/workers/runtime-apis/context/
  - Streams https://developers.cloudflare.com/workers/runtime-apis/streams/
  - Request https://developers.cloudflare.com/workers/runtime-apis/request/
  - 互換フラグ https://developers.cloudflare.com/workers/configuration/compatibility-flags/
  - 要求の中止の changelog https://developers.cloudflare.com/changelog/2025-05-22-handle-request-cancellation/
  - Durable Objects の概要 https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
  - Durable Objects の用語（入力・出力のゲート） https://developers.cloudflare.com/durable-objects/reference/glossary/
  - SQLite storage API https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
  - Alarms https://developers.cloudflare.com/durable-objects/api/alarms/
  - Durable Objects の料金 https://developers.cloudflare.com/durable-objects/platform/pricing/
  - Durable Objects の制限 https://developers.cloudflare.com/durable-objects/platform/limits/
  - Durable Objects のデータの置き場所 https://developers.cloudflare.com/durable-objects/reference/data-location/
  - D1 の API https://developers.cloudflare.com/d1/worker-api/d1-database/
  - D1 のデータの置き場所 https://developers.cloudflare.com/d1/configuration/data-location/
  - Secrets https://developers.cloudflare.com/workers/configuration/secrets/
  - Secrets Store https://developers.cloudflare.com/secrets-store/
  - ロール https://developers.cloudflare.com/fundamentals/manage-members/roles/
  - Workers Logs https://developers.cloudflare.com/workers/observability/logs/workers-logs/
  - Tail handler https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/
  - Hono: Cloudflare Workers https://hono.dev/docs/getting-started/cloudflare-workers
- Fly.io
  - Content encoding https://docs.fly.io/reference/content-encoding/
  - Configuration https://docs.fly.io/reference/configuration/
  - Autostop https://docs.fly.io/launch/autostop-autostart/
  - Long-running tasks https://docs.fly.io/blueprints/long-running-tasks/
  - 料金 https://docs.fly.io/about/pricing/ ・ https://fly.io/pricing/
  - リージョン https://docs.fly.io/reference/regions/
  - Managed Postgres https://docs.fly.io/mpg/ ・ https://docs.fly.io/mpg/client-configuration/
  - Unmanaged Postgres https://docs.fly.io/unmanaged-postgres/
  - LiteFS https://docs.fly.io/litefs/
  - Secrets https://docs.fly.io/apps/secrets/
  - 組織のロール https://docs.fly.io/security/org-roles-permissions/
  - Logging https://docs.fly.io/monitoring/logging-overview/
  - Metrics https://docs.fly.io/monitoring/metrics/
  - Health checks https://docs.fly.io/reference/health-checks/
  - Task scheduling https://docs.fly.io/blueprints/task-scheduling/
- AWS
  - Lambda の応答ストリーミング https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
  - ストリーミングの関数の書き方 https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html
  - Function URL での呼び出し https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html
  - Lambda のクォータ https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
  - Lambda の料金 https://aws.amazon.com/lambda/pricing/ （東京の単価は Price List API https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/ap-northeast-1/index.json ）
  - API Gateway のストリーミング https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis ・ https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
  - DynamoDB のトランザクション https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
  - DynamoDB の条件式 https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html ・ https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html
  - DynamoDB の TTL https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html
  - DynamoDB の料金（東京） https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/ap-northeast-1/index.json
  - EventBridge の料金 https://aws.amazon.com/eventbridge/pricing/
  - Secrets Manager の料金 https://aws.amazon.com/secrets-manager/pricing/ ・ CloudTrail https://docs.aws.amazon.com/secretsmanager/latest/userguide/monitoring-cloudtrail.html
  - Lambda の CloudWatch Logs https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html
  - Function URL の監視 https://docs.aws.amazon.com/lambda/latest/dg/urls-monitoring.html
  - App Runner https://docs.aws.amazon.com/apprunner/latest/dg/develop.html
  - Hono: AWS Lambda https://hono.dev/docs/getting-started/aws-lambda
- Google Cloud
  - Cloud Run の HTTPS 要求 https://docs.cloud.google.com/run/docs/triggering/https-request
  - 要求のタイムアウト https://docs.cloud.google.com/run/docs/configuring/request-timeout
  - トラブルシューティング（切断の伝播） https://docs.cloud.google.com/run/docs/troubleshooting
  - HTTP/2 https://docs.cloud.google.com/run/docs/configuring/http2
  - 課金の設定 https://docs.cloud.google.com/run/docs/configuring/billing-settings
  - 同時実行 https://docs.cloud.google.com/run/docs/about-concurrency
  - 料金 https://cloud.google.com/run/pricing （本文は取得できず）
  - 無料枠 https://docs.cloud.google.com/free/docs/free-cloud-features
  - Firestore のトランザクション https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions
  - Firestore の TTL https://docs.cloud.google.com/firestore/native/docs/ttl
  - Cloud Scheduler のロケーション https://docs.cloud.google.com/scheduler/docs/locations
  - Secret Manager（Cloud Run） https://docs.cloud.google.com/run/docs/configuring/services/secrets
  - Secret Manager の監査ログ https://docs.cloud.google.com/secret-manager/docs/audit-logging
  - Cloud Run のログ https://docs.cloud.google.com/run/docs/logging
  - LogEntry https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
  - Hono: Google Cloud Run https://hono.dev/docs/getting-started/google-cloud-run
- Anthropic
  - Streaming messages https://platform.claude.com/docs/en/build-with-claude/streaming
  - Workspaces https://platform.claude.com/docs/en/manage-claude/workspaces
