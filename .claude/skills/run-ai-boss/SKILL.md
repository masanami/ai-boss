---
name: run-ai-boss
description: Build, run, and drive the ai-boss app. Use when asked to start ai-boss, launch the server, take a screenshot of its UI, click through the app in a real browser, verify a change works in the running app, or run its build/lint/typecheck/tests.
---

ai-boss は Hono サーバー（`server/`）が Vite ビルド済み SPA（`web/`）を同一オリジンで配信する
ローカル完結アプリ。エージェントは **`.claude/skills/run-ai-boss/driver.mjs`** で駆動する
（ヘッドレス Chrome を CDP で直接操作するドライバ。npm 依存ゼロ）。

すべてのパスはリポジトリルート（`ai-boss/`）からの相対。

## Prerequisites

macOS + Node 22 以上（`WebSocket` グローバルを使うため。リポジトリ自体の要件は Node 20 以上だが、
**ドライバだけは Node 22 以上が要る**）。`/Applications/Google Chrome.app` があれば追加導入は不要。

```bash
node -v          # v24.18.0 で検証
ls -d "/Applications/Google Chrome.app"
```

Chrome が別の場所にある場合のみ `AI_BOSS_DRIVER_CHROME` で明示する（未指定時は Chrome →
Chromium → Chrome Canary → Playwright のブラウザキャッシュの順に自動探索する）。

## Setup

```bash
npm install
```

`server/.env` は**作らなくてよい**。ドライバは LLM を呼ばない設定を自分で渡す（§Gotchas）。

## Build

`driver.mjs` は `server/dist/index.js` を起動するので、**先にビルドが要る**（未ビルドなら
ドライバが明示的に落ちて教えてくれる）。

```bash
npm run build     # server: tsc / web: tsc --noEmit && vite build（実測 約4秒）
```

## Run (agent path)

```bash
npm run build
node .claude/skills/run-ai-boss/driver.mjs smoke
```

`smoke` は隔離サーバーを起動 → ヘッドレス Chrome で**実際の UI 操作**を一通り行い →
スクリーンショットを撮り → 後片付けまでやる。実際に通る経路:

1. `/` を開き `ai-boss` ヘッダ・`接続 OK`（health + SSE）・空状態を確認
2. ナビの `タスク` をクリックしてタスクボードへ
3. タスク作成フォームにタイトルを入れて `追加` をクリック
4. `未着手` カラムにカードが出ることを確認（＝サーバー往復と再描画が成立）
5. サイドパネルが `0 / 1 件完了（0%）` になることを確認

成果物は **`.driver-out/`**（`.gitignore` 済み）:
`01-dashboard.png` / `02-taskboard.png` / `03-task-created.png` / `04-side-panel.png`、
サーバーログ `server.log`、隔離 DB `driver.db`。
失敗時は終了コード 1 と `server.log` のパスを出す。ブラウザの console error は
成否にかかわらず最後にまとめて出る。

### 自分のシナリオを流す

`drive` は **DB をリセットしない**（`smoke` だけが毎回作り直す）。前回作ったタスクが残って
いる前提で書くこと＝空状態の文言（`今日のタスクはまだありません` 等）を待つ条件にしない。
まっさらから始めたいなら `rm .driver-out/driver.db` してから流す。

```bash
node .claude/skills/run-ai-boss/driver.mjs drive - <<'EOF'
nav /
wait-for h1
click text=設定
wait-for main[aria-label="設定"]
screenshot settings
text 800
console
EOF
```

`drive <file>` でファイルからも流せる。コマンド一覧:

| command | what it does |
|---|---|
| `nav <path\|url>` | `/` なら `http://127.0.0.1:8788/` に解決して遷移 |
| `wait-for <sel>` / `wait-for text=<文字列>` | CSS セレクタ、または `document.body.innerText` の包含を最大30秒待つ |
| `click <sel>` / `click text=<文字列>` | `text=` は**完全一致を優先**し、無ければ部分一致（§Gotchas） |
| `fill <sel> <値>` | React の controlled input に正しく入力（§Gotchas）。**セレクタに空白を含むならシングルクォートで囲む**: `fill 'form[aria-label="タスク作成"] input' 値` |
| `assert-text <文字列>` | 画面に無ければ失敗して終了 |
| `eval <js>` | ページ内で評価して結果を表示（Promise は await される） |
| `text [N]` | `document.body.innerText` を先頭 N 文字（既定2000）表示。**画面の文言を調べる最短手段** |
| `screenshot [名前]` | `.driver-out/<名前>.png` に保存 |
| `api <METHOD> <path> [json]` | サーバーへ直接リクエスト（UI を介さず状態を作るとき） |
| `console` | 収集したブラウザ console / 例外を表示 |
| `sleep <ms>` | 待つ（原則 `wait-for` を使い、これは最後の手段） |

### サーバーだけ起動して自分で触る

```bash
node .claude/skills/run-ai-boss/driver.mjs serve   # http://127.0.0.1:8788 隔離DB・Ctrl-C で停止
```

### 環境変数（ドライバ）

| var | default | 用途 |
|---|---|---|
| `AI_BOSS_DRIVER_PORT` | `8788` | オーナーの本番 8787 を避けた専用ポート |
| `AI_BOSS_DRIVER_DB` | `.driver-out/driver.db` | 隔離 DB（`smoke` は毎回削除して作り直す） |
| `AI_BOSS_DRIVER_OUT` | `.driver-out` | スクリーンショット・ログの出力先 |
| `AI_BOSS_DRIVER_CHROME` | 自動探索 | Chrome バイナリの明示指定 |

## Run (human path)

```bash
npm run start   # prestart で build → http://localhost:8787 を開く。Ctrl-C で停止
npm run dev     # Vite ホットリロード + server 並行（web は Vite 側のポート）
```

**この人間用の経路はオーナーの本番 DB（`server/data/ai-boss.db`）と本番ポート 8787 を使い、
既定の LLM バックエンドで本物の Claude Code を起動する**。エージェントの動作確認では使わないこと。

## Test

```bash
npm run lint        # exit 0
npm run typecheck   # exit 0
npm test            # server 94 files / 2029 tests, web 52 files / 798 tests, 全 pass（実測 約7秒）
npm run test:tz     # 日付境界に触る変更ではこれも通す（TZ=America/New_York）
```

1ファイルだけ流す（実装内部を直す PR ではこれが主戦場）:

```bash
npm test --workspace server -- src/config.test.ts
```

## Gotchas

- **既定の LLM バックエンドは本物の Claude Code を起動する。** `LLM_BACKEND` 未設定だと
  `claude-code` になり、`GET /api/dashboard` が**子プロセスで Claude Code を起動して
  オーナーのサブスク枠を消費**する。しかも失敗時は 120 秒の予算＋2回リトライなので、
  最悪 2 分間ダッシュボードが返ってこない。ドライバは `LLM_BACKEND=api` ＋
  `ANTHROPIC_API_KEY=""` を渡して `MissingApiKeyError` で**即座にフォールバック**させている
  （`server.log` に `falling back to template` が出るのは**正常**）。自分でサーバーを起動する
  ときも必ずこの 2 つを渡すこと。
- **ボスの文面を待ってはいけない。** LLM 無効時のダッシュボードは固定文言
  `今日も決めたことを淡々とこなせ。` にフォールバックする（画面には出るが LLM 経路の証明には
  ならない）。空状態の待ち合わせには `今日のタスクはまだありません` や `まだ活動はありません` を使う。
- **`server/data/ai-boss.db` はオーナーの実データ。** `DB_PATH` を渡さずに起動すると
  スモークのゴミがそこに入る。ドライバは必ず `.driver-out/driver.db` を使い、`smoke` は
  毎回それを削除してから始める（残っていると `0 / 1 件完了` が `0 / 2` になって落ちる）。
- **`data-testid` はこのアプリに 1 つも無い。** 狙うのは `aria-label` とラベル文言:
  `main[aria-label="タスクボード"]` / `form[aria-label="タスク作成"]` /
  `section[aria-label="未着手"|"進行中"|"一時停止"|"完了"|"中止"]` /
  `aside[aria-label="サイドパネル"]`。
- **`click text=タスク` は完全一致優先でないと誤爆する。** 部分一致だけだとサイドパネルの
  ラベル `着手するタスク` を掴む。ドライバは完全一致→部分一致の順で探す（同じ理由で
  独自スクリプトを書くときも完全一致を先に試すこと）。
- **`fill` のセレクタに空白があるならシングルクォートで囲む。** 囲まないと最初の空白で
  切れて `<form>` 自体に値を入れようとし、`TypeError: Illegal invocation` で落ちる。
- **React の controlled input は `el.value = x` では入らない。** ドライバの `fill` は
  ネイティブ setter を呼んでから `input`/`change` を bubbles で投げている。`eval` で自前に
  値を入れると onChange が発火せず、`追加` を押しても空のまま送信される。
- **`0 / 0 件完了（0%）` は初回ロード時に画面へ 2 回出る**（ダッシュボード本体とサイドパネル）。
  数を検証したいときは `eval` で `section[aria-label=...]` に絞る。全角括弧 `（）` に注意。
- **SPA なのでルーティングは URL に出ない。** 画面切り替えは React state で、URL は常に `/`。
  「設定画面を開く」は `nav /settings` ではなく `click text=設定`。
- **macOS には `timeout` が無い。** README 的な `timeout 30 bash -c 'until ...'` はそのままでは
  `command not found` になる。待ち合わせは `wait-for`（ドライバ内蔵）か
  `i=0; until curl -sf ... || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done` を使う。
- **毎分 cron が回っている。** サーバー起動と同時にサボり検知スケジューラが動き、条件が
  揃えば macOS 通知を出す。空 DB では発火しないので通常は問題にならないが、DB に
  データを積むシナリオを長時間走らせると**実際に通知が飛ぶ**。
- **README の「開発状況: 実装はこれから」は古い。** 実際には全画面が動く（`git log` 参照）。

## Troubleshooting

- **`wait-for タイムアウト: text=...`**: その文言が画面に無い。`text 1500` で実際の
  `innerText` を出して確かめる（AIボス ではなく `ai-boss` が h1、など表記ゆれが多い）。
- **`eval 例外: TypeError: Illegal invocation`**: `fill` のセレクタが空白で切れて `<form>` を
  掴んでいる。セレクタをシングルクォートで囲む。
- **`server/dist/index.js が無い`**: `npm run build` を先に実行する。
- **`この Node に global WebSocket が無い`**: Node 20 で実行している。Node 22 以上に切り替える。
- **`Chrome/Chromium が見つからない`**: `AI_BOSS_DRIVER_CHROME` にバイナリの絶対パスを渡す。
- **`server が http://127.0.0.1:8788 で応答しない`**: 前回のプロセスが残ってポートを掴んでいる。
  `lsof -ti:8788 -sTCP:LISTEN | xargs kill` で解放する。
- **`npm run lint` が `'process' is not defined` で落ちる**: `eslint .` がこのドライバを拾って
  いる。`eslint.config.js` に `.claude/skills/**/*.mjs` を node グローバルで lint する
  ブロックがある（それを消すと再発する）。
