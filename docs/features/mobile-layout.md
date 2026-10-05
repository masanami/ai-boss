# スマホ向けの画面レイアウト（製品版の iOS・Android・既存の React の流用）

> Issue #586。2026-10-05 に作成した。範囲と前提は、ADR 0011 の決定 6（OS ごとのネイティブ UI は採らず、画面は既存の React を使う）・決定 20（モバイルはデスクトップと同等の全機能。#590 のオーナー決定・2026-09-26）と、ADR 0011 の「帰結（改訂）」（#586 は補助の画面に絞らず全画面をスマホに対応させる）に拠る。iOS の器 S1（#676・PR #677）と Android の器 S1（#679・PR #680）は `main` にマージ済みで、その上に作る。2026-10-05 に、画面構成・ナビゲーション・操作の体験の根幹（O1〜O3）をオーナーが決め（★）、技術の論点（P1〜P5）を親が決めた。いずれも作成時の推奨どおり（「決定（2026-10-05）」節。選択肢と判断材料は「決定時の選択肢と判断材料」節に残した）。

## 概要

製品版（Tauri 2）の iOS・Android のアプリで、**今の React の画面を狭い幅（スマホの縦持ち）でも全機能のまま使えるようにする**。今の画面は、左のナビゲーション（200px）・中央の画面・幅を変えられる横のパネル（280〜420px）の 3 列の格子で、狭い幅への対応が 1 つも無い（`@media` は 0 件）。実測で、次の欠けが見つかった（「実コードの実測」）。

- **骨組み**: 3 列の格子は、最小で 966px（ナビ 200 ＋ 中央 480 ＋ 分割バー 6 ＋ パネル 280）を前提にしている。幅 375px では中央の画面が幅を持てない
- **ナビゲーション**: 7 つの画面のボタンが縦に並ぶ左の列で、狭い幅の置き場が無い
- **横のパネル**（チェックイン・今日のまとめ・着手時のメンタリングの促し）: どの画面でも見える前提の部品（`AppLayout.tsx` 122〜130 行の注記）で、狭い幅では置き場が無い
- **タッチで使えない操作**: 分割バーのドラッグ・矢印キー、タスクカードのドラッグ、ボスの返答のタスク ID のホバー、チャットの Shift+Enter（改行）
- **WebView の差異**: セーフエリア（iOS のノッチ・Android の edge-to-edge）、ソフトウェアキーボードで表示領域が縮むこと、iOS で 16px 未満の入力欄にフォーカスすると自動で拡大されること

この仕様は、狭い幅の判定と骨組みの作り替え（ナビゲーション・横のパネルの置き場）・セーフエリア・キーボード・主要画面（ダッシュボード・チャット・タスク）を S1 とし、残りの画面・ダイアログ・タッチの代替の残りを S2 に送る。**デスクトップのレイアウトは変えない**（幅の境界の両側で判定する）。

## 背景・目的

- ADR 0011 は、製品版の土台を Tauri 2 とし（決定 5）、OS ごとのネイティブ UI は採らず画面は既存の React を使うとした（決定 6）。モバイルはデスクトップと同等の全機能とする（決定 20・#590 のオーナー決定）。そのため、補助の画面に絞らず、**全画面**をスマホで使えるようにする（ADR 0011「帰結（改訂）」）。
- #575 の比較（2026-09-23）は、この作業を「スマホ向けの画面レイアウト 2〜3 週」「OS ごとの WebView 差異の吸収 1〜2 週」と見積もった。WebView は macOS・iOS が WebKit、Android が Chromium 系である。
- iOS の器 S1（PR #677）・Android の器 S1（PR #680）で、製品版の画面がシミュレータ・エミュレータに出るところまでは来た。どちらの仕様も、画面のレイアウトを「やらないこと」として #586 へ送っている（`android-shell.md`「やらないこと」）。
- 通知の許可の体験（#669 S2・#674 S3）と予約通知（#585）は別の Issue の範囲。この仕様は、それらが画面に足す部品（例: ダッシュボードの案内）が狭い幅でも置ける骨組みを作るところまでを受け持つ。

## ユーザーストーリー

- 利用者として、スマホでも、朝会・夕会の報告とボスへの相談（チャット）を、Mac と同じ機能で行いたい。
- 利用者として、スマホでも、タスクの登録・着手・完了・休憩（チェックイン）を片手で行いたい。どの画面を見ていても、今の作業の状態とチェックインに 1 回のタップで届きたい。
- 利用者として、キーボードを出しても入力欄が隠れず、入力欄を触っても画面が勝手に拡大されないでほしい。
- 利用者として、ノッチ・ステータスバー・ホームインジケータにボタンが重ならないでほしい。
- Mac の利用者として、スマホへの対応でデスクトップの画面が変わらないでほしい。

## 実コードの実測（2026-10-05・`main` e75c91a）

### 画面の骨組み（`web/src/AppLayout.tsx`・`AppLayout.css`・`index.css`）

- 製品版（`web/app.html` → `web/src/app-entry/main.tsx`）も開発者用の版（`web/index.html` → `web/src/main.tsx`）も、同じ `App` → `AppLayout` を描く（`app-entry/main.tsx` の注記「画面コンポーネント自体は一切変更しない」）。エントリで画面を分ける分岐は無い。
- 骨組みは `.app-layout`（縦の flex・`height: 100vh`。`AppLayout.css` 4 行）＝ ヘッダ（`ai-boss` と接続状態）＋ `.app-body`。`.app-body` は 4 トラックの格子 `var(--nav-width) minmax(0, 1fr) var(--splitter-width) var(--side-panel-width)`（`AppLayout.css` 23〜32 行）。
- 幅の定数（`side-panel-width.ts` 9〜14 行）: ナビ 200・中央の最小 480・分割バー 6・パネルは 280〜420（既定 280）。**3 列が成り立つ最小の幅は 200 ＋ 480 ＋ 6 ＋ 280 ＝ 966px**。966px 未満では、パネルは下限 280 を保ち、中央が 480 未満に縮む（`calculateEffectiveMaxWidth` の注記「the minimum wins」）。
- ナビゲーション（`AppLayout.tsx` 47〜55・235〜253 行）: `<nav aria-label="メインナビゲーション">` の中に 7 つのボタン（ダッシュボード・チャット・タスク・決定ログ・日報・作業ログ・設定）。**今の画面を示す属性（`aria-current`）は無い**。画面の切り替えは `activeView` の条件の描画で、画面ごとに `<main aria-label="…">` を 1 つ描く。
- 状態の持ち上げ: `tasksState`・`chatState` は `AppLayout` が持つ（タブを移っても会話が続くため。82 行付近の注記・#93）。**狭い幅への切り替えで `AppLayout` を描き直しても、この 2 つは失われない**（同じコンポーネントのまま骨組みだけを替えれば）。
- 横のパネル（`AppLayout.tsx` 324〜337 行）: `<aside id="app-side-panel" aria-label="サイドパネル">` に 3 つの部品。
  - `TaskStartMentoringPrompt`（#566）: **どの画面でも見える**ことが前提（122〜130 行の注記「どのビューでも見えるサイドパネル上部に描く」）。`role="status"` の領域は促しが無い間も**空のまま置いておく**（`TaskStartMentoringPrompt.tsx` 15〜19 行。中身ごと挿入されたライブリージョンは読み上げられないことがあるため）
  - `CheckinPanel`: 着手・完了・一時停止・休憩の開始と終了・活動の記録。サボり検知の活動シグナルの入口
  - `TodaySummary`: 今日の進み具合
- 分割バー（308〜323 行・#362）: `role="separator"`・`aria-valuenow`/`min`/`max`・`tabIndex={0}`。ポインタのドラッグ（`setPointerCapture`）と、キーボード（`←` で広く・`→` で狭く 16px・`Home`・`End`）。幅は `localStorage` の `ai-boss:side-panel-width` に保存し、ウィンドウの `resize` では保存しない（`use-side-panel-width.ts` の注記）。
- 幅の取得: `useSidePanelWidth` は `window.innerWidth` と `resize` の購読で窓の幅を持つ（`use-side-panel-width.ts`）。**幅の判定に使える仕組みは既にある**。`matchMedia` を使うコードは 0 件。

### 各画面の CSS（`web/src/*.css`・計 1,480 行）

- `@media` は **0 件**。`max-width` は `ChatView.css`（`.chat-message` 70%）・`Dashboard.css`（640px）・`SettingsView.css`（480px）の 3 つだけ。
- 狭い幅で崩れる見込みの箇所（推論。幅 375px で、`.app-main` の左右の余白 1.5rem ずつを引いた中身の幅は 327px）:
  - `.chat-session-bar`（`ChatView.css` 12〜16 行）: `display: flex` で**折り返さない**。朝会の開始・夕会の開始・相談・終了のボタンと会の札が 1 行に並ぶ
  - `.task-board-columns`（`TaskBoard.css`）: 列は `flex: 1 0 18rem`（288px）で、列の格子の中だけを横にスクロールする設計（#515 決定 1）。327px では 1 列だけが見え、残りは横のスクロール
  - `.task-form`（同）: `flex-wrap: wrap` で折り返す
  - `.daily-report-layout`（`DailyReportView.css` 13 行）: `grid-template-columns: 220px 1fr`。本文の列が約 80px しか残らない（S2）
  - `.session-transcript-backdrop`（`SessionTranscriptDialog.css`）: `position: fixed; inset: 0; padding: 2rem`。面は `width: min(720px, 100%)`（S2）
- 入力欄の文字の大きさ: 入力欄・選択欄・テキストエリアは **すべて 16px 未満**（ルートの 16px に対し、チャットの入力 0.95rem＝15.2px・タスクのフォーム 0.9rem・チャットの編集 0.9rem・設定 0.85〜0.9rem・チェックインの選択欄 0.8rem）。
- 押す対象の大きさ: チェックインのボタンは `min-height: 32px`（`CheckinPanel.css` 44〜53 行。「ポインタ操作前提の本アプリには過大」として 44px を採らず、WCAG 2.2 SC 2.5.8 の 24px を上回る 32px にした経緯の注記がある）。ナビのボタンは `padding: 0.5rem 0.75rem`・`font-size: 0.9rem`（高さ約 30px。推論）。
- ホバーに依存する見た目: `.app-nav button:hover`・`.app-splitter:hover`・`.chat-message:hover .chat-edit-button`・`.chat-stop-button:hover`。いずれも**見た目の強調だけ**で、操作はホバー無しでもできる（「発言を編集」は常に DOM にあるボタン。`ChatView.tsx` 238〜241 行の注記）。

### viewport の指定とエントリ

- `web/app.html`（製品版）・`web/index.html`（開発者用）とも `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。**`viewport-fit` の指定は無い**。`maximum-scale`・`user-scalable` の指定も無い（拡大縮小は許されている）。
- `index.html` は PWA の `manifest.webmanifest` を持つ。`app.html` は持たない。

### タッチで使えない操作（全数）

`web/src` の `*.tsx`（テストを除く）の `onKeyDown`・`onDrag*`・`onPointer*`・`onContextMenu`・`onDoubleClick`・`onMouse*`・`title=`・`:hover` を全数で洗った結果（右クリック・ダブルクリック・マウス専用のイベントは 0 件）。

| # | 操作 | 場所 | タッチ・ソフトウェアキーボードで | スマホでの代替（この仕様の扱い） |
|---|---|---|---|---|
| T1 | 分割バーのドラッグ | `AppLayout.tsx` 162〜195 行 | 指でも動く（`touch-action: none`・ポインタのイベント）が、狭い幅では横に並べる余地が無い | 狭い幅では分割バーを描かない（決定 2）。保存済みの幅は触らない |
| T2 | 分割バーの矢印キー・`Home`・`End` | `AppLayout.tsx` 197〜218 行 | ソフトウェアキーボードに矢印キーが無い | T1 と同じ（描かない） |
| T3 | タスクカードのドラッグ（列の間の移動。HTML5 の Drag and Drop） | `TaskCard.tsx` 393〜395 行・`TaskBoard.tsx` 139〜196 行 | iPhone・Android の WebView では、HTML5 のドラッグがタッチで始まらない見込み（推論。この作成では確かめていない） | **既にある代替を使う**: カードの「ステータス」の選択欄（`TaskCard.tsx` 421〜428 行）で同じ変更ができる。ドラッグのタッチ対応は「やらないこと」 |
| T4 | ボスの返答のタスク ID のホバー（`<span title>` のネイティブのツールチップ） | `TaskReferenceText.tsx` 28 行（`boss-reply-task-id-hover.md`） | タッチでは `title` のツールチップが出ない | S2 で代替を決める（タップで出す等）。S1 では ID の文字列はそのまま読める（表示の文字は `title` の有無で変わらない） |
| T5 | チャットの Shift+Enter（改行） | `ChatView.tsx` 508〜522 行 | ソフトウェアキーボードに Shift+Enter が無い。Enter は常に送信なので、**スマホでは改行を入れられない** | **決定 O3**: 狭い幅では Enter を改行にし、送信は送信のボタンだけにする（決定 8） |
| T6 | チャットの生成の停止の Escape | `ChatView.tsx` 460〜479 行 | ソフトウェアキーボードに Escape が無い | **既にある代替を使う**: 停止のボタン（`ChatView.tsx` 694 行付近） |
| T7 | 会話面のダイアログの Escape（閉じる）・Tab の循環 | `SessionTranscriptDialog.tsx` 117〜130 行 | Escape が無い | **既にある代替を使う**: 閉じるのボタン（183 行付近） |
| T8 | 証跡の URL 欄の Enter（「URL を追加」と同じ動き） | `TaskCard.tsx` 229〜236 行 | ソフトウェアキーボードの改行キーでも `key === "Enter"` で動く見込み（推論） | 変えない。「URL を追加」のボタンもある |
| T9 | ホバーの強調（ナビ・分割バー・発言の編集のボタン・停止のボタン） | 各 CSS | 出ない | 見た目だけで操作に影響しない。変えない |

### 器の設定（iOS・Android）

- iOS（`native/tauri-app/gen/apple/project.yml`・`Info.plist`）: 対象は iOS 15.0 以上（`deploymentTarget`）。端末は iPhone と iPad（`TARGETED_DEVICE_FAMILY = "1,2"`）。**iPhone で横向き（左右）を許している**（`UISupportedInterfaceOrientations`）。
- wry 0.57.0（Tauri 2.12.0 が使う）は、iOS の WKWebView の `scrollView` のバウンスを切る（`wry-0.57.0/src/wkwebview/mod.rs` 525〜530 行 `setBounces(false)`）。`contentInsetAdjustmentBehavior`・`ignoresViewportScaleLimits` は設定しない（既定のまま。grep で 0 件）。
- Android（`gen/android`）: `MainActivity.kt` は **`enableEdgeToEdge()`** を呼ぶ。`targetSdk = 36`・`minSdk = 24`。`AndroidManifest.xml` に `windowSoftInputMode` の指定は無く、`configChanges` に `orientation|keyboardHidden|keyboard|screenSize` を持つ（回転・キーボードで Activity を作り直さない）。画面の向きの指定は無い（回転する）。
- Tauri の設定（`tauri.conf.json`）の `app.windows` は空で、ウィンドウはコード（`lib.rs` の `WebviewWindowBuilder::from_config`）で作る。**`tauri.conf.json` に、セーフエリア・キーボード・拡大縮小を変える項目は無い**（Tauri 2.12.0 の設定にこれらを扱う項目は見当たらない。推論）。そのため、この仕様の手当ては web の側（HTML・CSS・TS）で行う。

### WebView の差異（一次情報で確かめたこと・推論）

確かめた日: 2026-10-05。

| 論点 | iOS（WKWebView・WebKit） | Android（WebView・Chromium 系） | 出典・確度 |
|---|---|---|---|
| セーフエリアの値（`env(safe-area-inset-*)`） | `viewport-fit=cover` を指定したときに、画面の端まで描き、`env()` が端末の値を返す。指定しない（`auto`）と、内容はセーフエリアの内側に収まる | WebView は、システムのバー・切り欠き・キーボードが **WebView に重なるときだけ** 0 でない値を受け取る。**M136** で全画面の WebView に `displayCutout()`・`systemBars()` を `safe-area-inset-*` で渡し、**M144** で全画面かどうかによらず渡す。Android の WebView は `viewport-fit` によらず値を入れる（iOS と違う） | Android: developer.android.com「Understand window insets in WebView」（一次情報）。iOS: `viewport-fit` の意味は CSS Round Display・WebKit の既知の振る舞い（この作成では WebKit の文書を取り直していない。**推論**） |
| Android の edge-to-edge | — | `targetSdk` 35 以上では edge-to-edge が強制される。器は `enableEdgeToEdge()` を呼ぶため、**WebView はステータスバー・ナビゲーションバーの下まで描かれる**。M144 より前の WebView で全画面と扱われない場合、`env()` が 0 になり、内容がバーの下に隠れうる | 同上（一次情報）。エミュレータの WebView の版は**未確認**（手動の確認手順で `navigator.userAgent` の版を記録する） |
| ソフトウェアキーボード | 表示領域（visual viewport）だけが縮み、レイアウトの領域（layout viewport）・`100vh` は変わらない。`interactive-widget`（キーボードで縮める対象の指定）は **WebKit に未実装**（WebKit Bugzilla 259770 は 2026-10-05 時点で `NEW`）。VirtualKeyboard API も未実装（同 230225 は `NEW`） | **M139** から、キーボード（`ime()`）は visual viewport を縮める（下端だけ）。レイアウトの領域は変わらない | Android: 同上（一次情報）。WebKit: bugs.webkit.org の REST で状態を確かめた（一次情報）。iOS の「visual viewport だけが縮む」は Bugzilla の要望の前提からの**推論** |
| 入力欄のフォーカスでの自動拡大 | フォーカスした入力欄の計算された文字の大きさが **16px になる倍率まで拡大する**（WebKit の変更 r230171 の記述「scaled to have an effective font size of 16」）。`WKWebViewConfiguration.ignoresViewportScaleLimits` の既定は `false`（＝ WKWebView はページの `user-scalable`・`maximum-scale` に従う） | 自動拡大は無い見込み（Chrome for Android の既知の振る舞い。**推論**。wry の Android の WebView の設定〔`RustWebView.kt`〕は拡大に触れない） | trac.webkit.org r230171・Apple Developer Documentation（いずれも一次情報。r230171 はこの計算を「拡大しすぎるモード」向けに改めた変更で、iOS の既定の計算が 16px を目標にすることはその記述から読める） |
| `100vh`・`dvh` | `dvh` は Safari 15.4（iOS 15.4）から。**対象の iOS 15.0〜15.3 では使えない**。アプリの WebView にはブラウザのツールバーが無いため、`100vh` は WebView の高さとほぼ一致する見込み（推論） | `dvh` は Chrome 108 から（推論。web.dev の記事による）。WebView は Play ストアで更新される | webkit.org の Safari 15.4 の告知（検索の結果で確認。本文は取り直していない） |
| 拡大縮小（ピンチ） | `maximum-scale=1` を指定すると、WKWebView はピンチの拡大も止める（`ignoresViewportScaleLimits` が `false` のため） | `maximum-scale=1` で拡大を止める | Apple の文書（一次情報）。Android は推論 |

### テストの環境

- `npm test`（web）は vitest の **jsdom**（`web/vite.config.ts` 52〜55 行）。**jsdom はレイアウトを計算しない**（`scrollWidth`・`getBoundingClientRect` は 0。CSS の `@media` も評価しない。`matchMedia` は実装されていない）。vitest は既定で CSS のファイルを処理しない。
- jsdom の `window.innerWidth` の既定は 1024（`AppLayout.test.tsx` 2403〜2429 行が前提にしている）。**既存のテストは、幅の判定を足しても 1024＝デスクトップの側で走る**。
- E2E のブラウザ（Playwright 等）はリポジトリに無い。
- したがって、**幅の判定・描く骨組み・属性・イベントの配線は jsdom で自動に判定でき、はみ出し・大きさ・セーフエリア・キーボードの見え方は実ブラウザ・シミュレータ・エミュレータでの手動の確認になる**（決定 9・P4）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- 窓の幅が境界（768px。P1）未満のとき、狭い幅の骨組み（以下「コンパクト」）で描き、境界以上のときは今のデスクトップの骨組みで描く。窓の幅が境界をまたいだら、開いている画面・会話・入力中の内容を保ったまま切り替える。
- コンパクトでは、7 つの画面すべてへ、ナビゲーションから到達できる（全機能。ADR 0011 決定 20）。
- コンパクトでは、横のパネルの 3 つの部品（着手時のメンタリングの促し・チェックイン・今日のまとめ）を、どの画面からも使える（O2）。
- コンパクトでは、画面の部品がセーフエリア（ノッチ・ステータスバー・ホームインジケータ・Android のシステムバー）に重ならない。
- ソフトウェアキーボードが出ている間、フォーカスしている入力欄が見える。
- 入力欄にフォーカスしても、iOS で画面が自動で拡大されない。ピンチでの拡大は止めない（アクセシビリティ）。
- タッチで使えない操作（T1〜T9）は、代替を用意するか、「やらないこと」に理由を書く。
- デスクトップ（境界以上）の見た目・操作・DOM は変えない。

## 非機能要件

- アクセシビリティを後退させない: ナビゲーションのランドマーク（`メインナビゲーション`）・画面ごとの `<main aria-label>`・`role="status"` のライブリージョン（着手時の促し・チャット・決定ログ・コピーの通知）・#694 で入れたタスクカードの ID と決定ログの絞り込みの伝え方を、コンパクトでも保つ。
- 押す対象: コンパクトで新しく作るナビゲーションと、横のパネルを開く・閉じる部品は、高さ・幅とも 44px 以上（Apple の Human Interface Guidelines の 44pt。Android の Material は 48dp。この作成では一次情報を取り直していない既知の値）。既存の画面の中のボタンの大きさは S2 で揃える。
- 開発者用の版（`npm run dev`・`npm run start`）でも、ブラウザの幅を狭めれば同じコンパクトになる（P2）。
- 依存を増やさない（CSS のフレームワーク・UI の部品集を入れない）。

## 技術的な制約・方針

- 画面は既存の React を流用する（ADR 0011 決定 6）。ネイティブの UI・ネイティブのナビゲーションは作らない。
- 器（`native/tauri-app/`）の Rust のコード・`tauri.conf.json` は、この仕様では変えない。器の側で変えるのは、iPhone の画面の向きを縦に固定するための `gen/apple` の `project.yml`・`Info.plist` の `UISupportedInterfaceOrientations` だけ（P3。iPad の `UISupportedInterfaceOrientations~ipad` と Android の `AndroidManifest.xml` は変えない）。
- iOS 15.0〜15.3 で使えない CSS（`dvh`・範囲の構文の `@media (width < 768px)`〔Safari 16.4 から。推論〕）に依存しない。
- 製品版と開発者用の版で画面のコードを分けない（`app-entry/main.tsx` の注記と同じ方針）。

## クリティカル設計決定

### 1. 幅の判定は JS の純粋関数 1 つに置き、CSS はその結果のクラスに従う（P1・【決定】2026-10-05・親）

- 判定: `isCompactLayout(windowWidth: number): boolean` ＝ `windowWidth < 768`。境界 768 はコンパクトに**含めない**（768 はデスクトップ）。
- 窓の幅は、`useSidePanelWidth` と同じく `window.innerWidth` と `resize` の購読で取る（仕組みを 2 つにしない）。`matchMedia` は使わない（jsdom に無く、判定の境界をテストで殺せない。純粋関数なら 767・768 で `<`↔`<=` の変異を殺せる）。
- CSS は `@media` で骨組みを切り替えず、`.app-layout--compact` のクラスの下にだけ規則を足す（判定の正本を JS の 1 か所にし、CSS と JS の境界の値の食い違いを起こさない。デスクトップの規則に触れない）。
- 境界を 768 にする理由: 今のデスクトップの骨組みが成り立つ最小は 966px で、768〜965px はすでに中央が縮んで使われうる幅である。768 未満は、iPhone の縦持ち（320〜440px）・iPad mini の縦持ち（744px）を含む。966 を境界にすると、今 768〜965px で使っているデスクトップの窓の見た目が変わる（「デスクトップを変えない」に反する）。
- 既知の注意（推論）: iOS ではピンチで拡大している間、`window.innerWidth` が拡大後の見える幅になりうる。拡大すると狭い側へ切り替わる恐れがあるため、手動の確認手順で確かめる。問題になれば `document.documentElement.clientWidth`（レイアウトの領域の幅）へ替える（軽微・可逆）。

### 2. コンパクトは `AppLayout` の中で骨組みだけを替え、デスクトップの DOM と CSS は変えない（作成者の判断）

- `AppLayout` は同じコンポーネントのまま、`isCompactLayout` の値で骨組み（ナビゲーション・横のパネルの置き場）を描き分ける。`tasksState`・`chatState`・`activeView`・決定ログの絞り込みは今の場所に持ち続ける（切り替えで失わない）。
- コンパクトでは分割バー（`role="separator"`）を描かない。`useSidePanelWidth` は呼び続ける（フックの呼び出しの順序を変えない）が、保存済みの幅は書き換えない（今も `resize` では書かない）。デスクトップへ戻れば、保存済みの幅で描く。
- デスクトップの DOM（境界以上）は、今と同じ要素・属性・順序で描く。既存の `AppLayout.test.tsx` 等のテストは、本体を変えずに合格させる（jsdom の幅 1024＝デスクトップ）。
- 画面ごとのコンポーネント（`Dashboard`・`ChatView`・`TaskBoard` 等）の中の狭い幅の手当ては、CSS の `.app-layout--compact .chat-session-bar { … }` のような子孫の規則で行い、コンポーネントに幅の値を渡さない（例外は決定 8 のチャットの Enter。挙動が変わるため prop で渡す）。

### 3. ナビゲーションの形（O1 ★・【決定】2026-10-05・オーナー）

**A: 下部のタブ**。画面の下端に「ダッシュボード」「チャット」「タスク」「その他」の 4 つのタブを置き、「その他」で残りの 4 画面（決定ログ・日報・作業ログ・設定）の一覧を開く。今の画面のタブに `aria-current="page"`、残りの 4 画面のどれかを開いているときは「その他」に `aria-current="page"` を付ける。「その他」は `aria-expanded` を持つ。

### 4. 横のパネルの置き場（O2 ★・【決定】2026-10-05・オーナー）

**C: 常設の帯 ＋ 下から出るシート**。

```
┌──────────────────────────┐
│ ai-boss          ● 接続中 │ ← ヘッダ（上のセーフエリアの内側）
├──────────────────────────┤
│                          │
│   今の画面（main）        │
│                          │
├──────────────────────────┤
│ ▶ 着手中: 資料の下書き  [チェックイン] │ ← 常設の帯（着手時の促しもここに出る）
├──────────────────────────┤
│ ダッシュ │ チャット │ タスク │ その他 │ ← 下部のタブ（下のセーフエリアの内側）
└──────────────────────────┘
「チェックイン」を押す → 下からシート（チェックイン・今日のまとめ）が出る
```

- 常設の帯に、着手中のタスクの名前（無ければ「着手中のタスクはありません」）と、シートを開くボタン「チェックイン」を置く。**着手時のメンタリングの促し（`TaskStartMentoringPrompt`）は帯の上に常に置く**（`role="status"` の領域を空のまま置き続ける今の作りを保つ。シートの中に入れると、閉じている間にライブリージョンが消える）。
- シートは `role="dialog"`・`aria-modal="true"`・`aria-label="チェックイン"`。中に `CheckinPanel` と `TodaySummary` を描く。閉じるボタン・背景のタップで閉じ、閉じたらフォーカスを「チェックイン」のボタンへ戻す。開いている間、フォーカスをシートの中に留める（`SessionTranscriptDialog` の作りを流用する）。

### 5. セーフエリアは `viewport-fit=cover` と `env(safe-area-inset-*)` で web の側で吸収する（作成者の判断）

- `web/app.html` と `web/index.html` の viewport を `width=device-width, initial-scale=1.0, viewport-fit=cover` にする。`maximum-scale`・`user-scalable=no` は**足さない**（ピンチの拡大を止めない）。
- コンパクトの骨組みでだけ、ヘッダの上・左右と、下部のタブの下・左右に `env(safe-area-inset-*)` の余白を足す（デスクトップでは値が 0 で、規則もコンパクトの下だけに置く）。
- Android は器の `enableEdgeToEdge()` のまま、WebView が渡す `env()` に頼る（ネイティブの側で余白を付けない。付けると Android の文書が言う二重の余白になる）。エミュレータの WebView が M144 より前で `env()` が 0 を返す場合は、手動の確認手順で記録し、器の `MainActivity` で余白を付ける（同文書の「Zeroing approach」）かを、そこで親に問う（S1 の中で解く）。

### 6. キーボードは visual viewport の高さで骨組みの高さを決める（作成者の判断）

- iOS（WebKit）にも Android（M139 以降）にも、キーボードでレイアウトの領域を縮める手段が無い（`interactive-widget` は WebKit に未実装）。そのため、コンパクトでは `window.visualViewport` の `resize` を購読し、`.app-layout` の高さを visual viewport の高さ（CSS 変数 `--app-viewport-height`）にする。`visualViewport` が無ければ変数を置かず、今の `100vh` のまま。
- キーボードが出ている（`window.innerHeight − visualViewport.height > 150`。仮定 M6）間は、下部のタブと常設の帯を描かない（入力欄に縦の余地を渡す）。
- `dvh` は使わない（iOS 15.0〜15.3 で使えず、キーボードも反映しない）。

### 7. iOS の自動拡大は、コンパクトで入力欄の文字を 16px にして避ける（P5・【決定】2026-10-05・親）

- コンパクトでは、`input`・`textarea`・`select` の `font-size` を `16px` にする（`.app-layout--compact` の下の規則）。
- `maximum-scale=1` で止める案は採らない: WKWebView はページの指定に従うため（`ignoresViewportScaleLimits` の既定 `false`）、ピンチの拡大まで止まり、拡大に頼る利用者が読めなくなる。

### 8. チャットの Enter（O3 ★・【決定】2026-10-05・オーナー）

**A**: コンパクトでは Enter を改行にし（送信しない）、送信は送信のボタンだけにする。デスクトップは今のまま（Enter で送信・Shift+Enter で改行）。`ChatView` に `enterSends: boolean` を prop で渡す（決定 2 の例外）。

### 9. 確認の分担（P4・【決定】2026-10-05・親）

- **自動（vitest・jsdom）**: 幅の判定の純粋関数（境界の両側）、骨組みの描き分け（描く要素・属性・ランドマーク・`aria-current`・`aria-expanded`）、境界をまたぐ切り替えで状態が残ること、シートの開閉とフォーカス、visual viewport の購読と CSS 変数、チャットの Enter、viewport の指定（HTML のファイルの検査）。
- **手動**（実ブラウザ・iOS シミュレータ・Android エミュレータ）: はみ出し（`scrollWidth`）・大きさ（`getBoundingClientRect`）・セーフエリア・キーボード・自動拡大・デスクトップの見た目。合否は、Web インスペクタのコンソールで評価する**式の値**（観測できる肯定の事実）で決め、画面の写しを PR に貼る。
- Playwright 等の E2E のブラウザは入れない（P4。依存とブラウザの導入が増え、必須ゲートの時間も延びる。jsdom で判定できない部分は 3 つの環境の手動の確認に置く）。

## 機能全体の設計

### 失敗の経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| デスクトップのレイアウトが変わる（ナビ・分割バー・パネル・格子の幅・既存の DOM） | 決定 1・2。境界の上側（768・1024）で今と同じ要素を描くことを jsdom で判定し、既存のテストを本体を変えずに合格させる（受入基準）。見た目は 768・1280 での `grid-template-columns` の値を `main` と比べる（手動の確認手順 1） |
| 境界の値の比較が 1 つずれる（`<`↔`<=`）・境界の幅で表示が揺れる | 決定 1。純粋関数を 767・768 で判定する。jsdom で幅 767→768→767 の `resize` で 2 回切り替わることを判定する（受入基準） |
| CSS の `@media` と JS の境界が食い違う | 決定 1。骨組みの切り替えに `@media` を使わない。`web/src` の CSS に `@media` が 0 件のままであることを受入基準にする |
| 境界をまたいだときに、開いている画面・チャットの下書き・決定ログの絞り込みが失われる | 決定 2（状態は `AppLayout` に持ったまま）。jsdom で、切り替えの後も同じ画面・同じ下書きであることを判定する（受入基準） |
| 狭い幅で保存済みのパネルの幅が書き換わり、デスクトップへ戻ると幅が変わる | 決定 2。jsdom で、コンパクトを経てデスクトップへ戻った後の `localStorage` の値と描く幅が前と同じことを判定する（受入基準） |
| コンパクトで到達できない画面がある（全機能の約束に反する） | 決定 3。jsdom で 7 画面すべてにナビゲーションから移れることを判定する（受入基準） |
| チェックイン（サボり検知の活動の入口）がコンパクトで遠い・見えない | 決定 4。常設の帯から 1 回のタップでシートを開けることを jsdom で判定する（受入基準） |
| 着手時の促しのライブリージョンが、閉じている間に消えて読み上げられない | 決定 4。コンパクトでもシートの開閉によらず `role="status"`（着手時のメンタリングの促し）が 1 つ DOM にあることを判定する（受入基準） |
| `CheckinPanel` が 2 か所に描かれ、状態や取得が二重になる | 決定 2・4。どちらの骨組みでも、`CheckinPanel` の見出しが DOM に高々 1 つであることを判定する（受入基準） |
| ソフトウェアキーボードで入力欄が隠れる | 決定 6。CSS 変数の更新とタブ・帯を隠すことを jsdom で判定する（受入基準）。見え方は手動の確認手順 3・4（入力欄の下端が visual viewport の内側） |
| セーフエリアにヘッダ・タブ・ボタンが重なる | 決定 5。viewport の指定をファイルの検査で判定する（受入基準）。値は手動の確認手順 3・4 で、`env()` の値とヘッダ・タブの位置を式で確かめる |
| Android の WebView が古く、`env()` が 0（edge-to-edge でバーの下に隠れる） | 決定 5。手動の確認手順 4 で WebView の版と値を記録する。0 なら S1 の中で親に問う |
| iOS で入力欄のフォーカスで画面が拡大される | 決定 7。手動の確認手順 3（コンパクトの入力欄の `fontSize` が 16px・フォーカスの後の `visualViewport.scale` が 1） |
| ピンチの拡大を止めてしまう（アクセシビリティの後退） | 決定 5・7。viewport に `maximum-scale`・`user-scalable` が無いことをファイルの検査で判定する（受入基準） |
| タッチで届かない操作（T1〜T9） | 「タッチで使えない操作」の表。T1・T2 は描かない（受入基準）、T3・T6・T7 は既存の代替、T5 は決定 8（受入基準）、T4 は S2 |
| 主要画面が幅 375px・320px で横にはみ出す（例: `.chat-session-bar` が折り返さない） | コンパクトの子孫の規則で折り返す。手動の確認手順 1〜4 で `scrollWidth <= clientWidth` を式で確かめる |
| WebKit と Chromium 系で表示が違う | 手動の確認を 3 つの環境（Chrome・Safari のレスポンシブデザインモード／iOS シミュレータ／Android エミュレータ）で同じ式で行う |
| 押す対象が小さく、指で押し違える | 非機能要件の 44px。手動の確認手順 1 で、タブ・「チェックイン」・シートの閉じるボタンの大きさを式で確かめる |
| #694 等で入れたスクリーンリーダー向けの作りが、骨組みの差し替えで落ちる | 既存のテスト（`TaskCard.test.tsx`・`DecisionLog.test.tsx`）を本体を変えずに合格させる。コンパクトでも `<nav aria-label="メインナビゲーション">` と画面ごとの `<main aria-label>` が 1 つずつあることを判定する（受入基準） |
| 横向き（iPhone の横持ちは幅 568〜956px・高さ約 320〜440px）で、デスクトップの骨組みが低い高さに詰め込まれる | P3。iPhone は縦に固定する（S1）。`project.yml`・`Info.plist` の検査（受入基準）と、シミュレータの回転（手動の確認手順 10） |
| iPad（`TARGETED_DEVICE_FAMILY` に含まれる）の横持ち（1024px 以上）でデスクトップの骨組み・縦持ち（744〜834px）で幅によってどちらにもなる | P3。iPad は回転を許し幅だけで判定する。iPad の専用の調整は S3。S1 では iPad の向きの設定を変えないこと（受入基準）だけを固定する |

### 実装計画（S1 のチケット分解の見通し）

S1 は 1〜2 チケットの見込み（触るファイルは 10〜14）。分けるなら次の 2 つ（直列）。

1. 幅の判定（純粋関数・フック）・コンパクトの骨組み（ナビゲーション・常設の帯・シート）・分割バーを描かないこと・viewport の指定・セーフエリア・visual viewport・入力欄の 16px（`AppLayout.tsx`・`AppLayout.css`・新しい `layout-mode.ts`〔仮〕・`use-visual-viewport.ts`〔仮〕・`app.html`・`index.html` とテスト）
2. 主要画面の狭い幅の手当て・iPhone の縦への固定（`project.yml`・`Info.plist`・設定の検査）（`ChatView`〔Enter・`.chat-session-bar`〕・`Dashboard.css`・`TaskBoard.css`）とテスト

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | 幅の判定（決定 1）・iPhone の縦への固定（P3）・コンパクトの骨組み（ナビゲーション〔O1〕・横のパネルの置き場〔O2〕）・分割バーを描かない（T1・T2）・セーフエリア（決定 5）・キーボード（決定 6）・入力欄の自動拡大の回避（決定 7）・主要画面（ダッシュボード・チャット・タスク）の狭い幅の手当て・チャットの Enter（O3）。残りの 4 画面はナビゲーションから到達できるところまで（中のレイアウトは S2）。デスクトップは変えない | 12-16 | **この仕様の PR がマージされてから**（O1〜O3・P1〜P5 は 2026-10-05 に決定済み）。#677・#680 はマージ済み |
| S2 | 残りの画面（決定ログ・日報〔`220px 1fr` の格子〕・作業ログ・設定）と会話面のダイアログ（`SessionTranscriptDialog`）の狭い幅の手当て、タスク ID のホバーの代替（T4）、既存の画面の中のボタンの大きさ（44px）を揃えること | 未見積もり | S1 がマージされてから |
| S3 | iPad 向けの調整（縦持ちの 744〜834px・横持ちの 1024px 以上でのレイアウトの磨き込み。P3） | 未見積もり | S1 がマージされてから |

実装対象: S1

## やらないこと

- OS ごとのネイティブの UI・ネイティブのナビゲーション（理由: ADR 0011 決定 6）
- タスクカードのドラッグのタッチ対応（T3）（理由: 同じ変更をカードの「ステータス」の選択欄でできる。タッチのドラッグを足すと、縦のスクロールとの取り合いの判定が要り、費用に見合わない）
- コンパクトでの分割バー（T1・T2）（理由: 横に並べる余地が無い。パネルの中身は決定 4 の置き場で使う）
- ピンチの拡大を止めること（`maximum-scale=1`・`user-scalable=no`）（理由: 拡大に頼る利用者が読めなくなる。決定 7）
- 通知の許可の体験・予約通知の画面（理由: #669 S2・#674 S3・#585。この仕様は骨組みまで）
- 実機での確認（理由: ADR 0011「未決」でオーナーが製品化の後のフェーズとした。この仕様の手動の確認はシミュレータ・エミュレータ・ブラウザ）
- Windows（WebView2）での確認（理由: ADR 0011 決定 19。Windows は後続のリリース）
- デスクトップの 768〜965px の窓で中央が 480px 未満に縮む今の振る舞いを直すこと（理由: 「デスクトップを変えない」。今もある振る舞いで、#362 の仕様が決めた優先順位）
- E2E のブラウザ（Playwright 等）の導入（理由: 決定 9・P4）
- 開発者用の版の PWA（`index.html` の `manifest.webmanifest`）をスマホ向けに整えること（理由: 開発者用の版はオーナーの Mac で使う前提。スマホで使うのは製品版）

## 受入基準（S1）

検査は、`npm test`（web の vitest・jsdom と、`test:scripts` の `node --test`）と `git` で行う。実ブラウザ・シミュレータ・エミュレータでしか見られないもの（はみ出し・大きさ・セーフエリア・キーボード・自動拡大・デスクトップの見た目）は「手動の確認手順（S1）」に置く。jsdom の窓の幅は `window.innerWidth` を定義して `resize` を送って変える。

**比較の基準点**: 「変えない」の項目は、**この仕様の PR をマージした後の `main`** を基準点とする。

オーナーの決定 O1〜O3 に拠る項目には（O1）・（O2）・（O3）を付けた。

幅の判定（純粋関数）:

- [ ] `isCompactLayout(767)` は `true` を返す
- [ ] `isCompactLayout(768)` は `false` を返す
- [ ] `isCompactLayout(320)` は `true`、`isCompactLayout(1024)` は `false` を返す

デスクトップを変えない（jsdom）:

- [ ] 幅 768 で、`.app-layout` に `app-layout--compact` のクラスが無い
- [ ] 幅 768 で、`role="separator"`（名前「サイドパネルの幅」）が 1 つ、`complementary`（名前「サイドパネル」）が 1 つあり、`メインナビゲーション` の中のボタンが 7 つ（ダッシュボード・チャット・タスク・決定ログ・日報・作業ログ・設定の順）ある
- [ ] 基準点の `web/src` にある既存のテストファイルについて、`git diff <基準点>...HEAD -- <ファイル>` に削除の行（`-` で始まる行。ファイルの見出しの行を除く）が無く、`npm test` が合格する（既存のテストの本体を変えずに合格する）
- [ ] `web/src` の CSS のファイルに `@media` が 0 件である（`grep -r "@media" web/src --include=*.css` の出力が空）

コンパクトの骨組み（jsdom）:

- [ ] 幅 767 で、`.app-layout` に `app-layout--compact` のクラスがある
- [ ] 幅 767 で、`role="separator"` が 0 件である
- [ ] 幅 767 で、`navigation`（名前「メインナビゲーション」）が 1 つ、画面の `main` が 1 つある
- [ ] 幅 1024 → 767 → 768 と `resize` を送ると、`app-layout--compact` のクラスが無 → 有 → 無と変わる
- [ ] 幅 1024 でチャットの画面を開き、入力欄に「下書き」と入れた後、幅 767 へ変えると、チャットの画面のまま（`main` の名前が「ボスとの対話」）で、入力欄の値が「下書き」である
- [ ] `localStorage` の `ai-boss:side-panel-width` が `360` のとき、幅 1280 → 767 → 1280 と変えた後も、値は `360` のままで、分割バーの `aria-valuenow` は `360` である

ナビゲーション（jsdom・幅 767）:

- [ ] （O1）`メインナビゲーション` の中に、ボタン「ダッシュボード」「チャット」「タスク」「その他」がこの順にある
- [ ] （O1）起動の直後、「ダッシュボード」に `aria-current="page"` があり、ほかの 3 つに無い
- [ ] （O1）「チャット」を押すと、`main` の名前が「ボスとの対話」になり、「チャット」に `aria-current="page"` が移る
- [ ] （O1）「その他」は `aria-expanded="false"` を持ち、押すと `"true"` になって、ボタン「決定ログ」「日報」「作業ログ」「設定」が出る
- [ ] （O1）「その他」から「設定」を押すと、`main` の名前が「設定」になり、「その他」に `aria-current="page"` があり、`aria-expanded` が `"false"` に戻る
- [ ] （O1）7 つの画面（`main` の名前: ダッシュボード・ボスとの対話・タスクボード・決定ログ・日報・作業ログ・設定）のそれぞれへ、ナビゲーションのボタンの押下だけで移れる
- [ ] （O1）タスクカードの「記録を見る」で決定ログへ移ったとき、「その他」に `aria-current="page"` があり、決定ログは絞り込まれている（`DecisionLog` の絞り込みの表示がある）

横のパネルの置き場（jsdom・幅 767）:

- [ ] （O2）シートを開く前、`role="status"`（名前「着手時のメンタリングの促し」）が 1 つある
- [ ] （O2）シートを開く前、`CheckinPanel` の見出しが 0 件で、ボタン「チェックイン」が 1 つある
- [ ] （O2）タスクを 1 つ進行中にすると、常設の帯にそのタスクの名前が出る。進行中のタスクが無いとき、「着手中のタスクはありません」が出る
- [ ] （O2）「チェックイン」を押すと、`role="dialog"`（名前「チェックイン」・`aria-modal="true"`）が 1 つ出て、その中に `CheckinPanel` と `TodaySummary` の見出しが 1 つずつある
- [ ] （O2）シートの閉じるボタンを押すと、`role="dialog"` が 0 件になり、フォーカスが「チェックイン」のボタンにある
- [ ] （O2）シートを開いている間に Tab を最後の要素から押すと、フォーカスはシートの中の最初の要素へ移る
- [ ] （O2）シートを開いている間も、`role="status"`（着手時のメンタリングの促し）は 1 つだけある
- [ ] 幅 768 で、`CheckinPanel` の見出しはサイドパネルの中に 1 つだけある

キーボード（jsdom・幅 767・`window.visualViewport` を差し替える）:

- [ ] `visualViewport.height` が 500 で `resize` を送ると、`.app-layout` の `style` の `--app-viewport-height` が `500px` になる
- [ ] `window.visualViewport` が `undefined` のとき、`.app-layout` の `style` に `--app-viewport-height` が無い
- [ ] `innerHeight` が 800 で `visualViewport.height` が 650（差 150）のとき、下部のタブ（`メインナビゲーション`）と常設の帯がある
- [ ] `innerHeight` が 800 で `visualViewport.height` が 649（差 151）のとき、下部のタブと常設の帯が無い
- [ ] 幅 1024 では、`visualViewport.height` を変えても `--app-viewport-height` は置かれない

チャットの Enter（jsdom）:

- [ ] （O3）幅 767 で、チャットの入力欄に「あ」を入れて Enter（Shift なし・変換中でない）を押すと、送信されず（`send` が呼ばれない）、既定の動作が止められない（`defaultPrevented` が `false`）
- [ ] （O3）幅 767 で、送信のボタンを押すと送信される
- [ ] 幅 1024 で、Enter で送信され、Shift+Enter で送信されない（今の振る舞い。既存のテストのまま）

画面の向き（P3。設定のファイルの検査）:

- [ ] `native/tauri-app/gen/apple/project.yml` の `UISupportedInterfaceOrientations` は `UIInterfaceOrientationPortrait` の 1 つだけである
- [ ] `native/tauri-app/gen/apple/ai-boss-tauri-app_iOS/Info.plist` の `UISupportedInterfaceOrientations` の配列は `UIInterfaceOrientationPortrait` の 1 つだけである
- [ ] `project.yml`・`Info.plist` の `UISupportedInterfaceOrientations~ipad` は基準点と同じ 4 つ（`Portrait`・`PortraitUpsideDown`・`LandscapeLeft`・`LandscapeRight`）のままである
- [ ] `native/tauri-app/gen/android/app/src/main/AndroidManifest.xml` に `android:screenOrientation` が無い（Android は回転を許す）

viewport の指定（HTML のファイルの検査）:

- [ ] `web/app.html` と `web/index.html` の `<meta name="viewport">` の `content` は、`width=device-width`・`initial-scale=1.0`・`viewport-fit=cover` を含む
- [ ] 同じ `content` は、`maximum-scale` と `user-scalable` を含まない

品質ゲート:

- [ ] `npm run lint`・`npm run typecheck`・`npm test` が合格する（Rust のコードを変えないため、`test:rust`・`test:tauri`・`check:ios`・`check:android`・`lint:rust`・`fmt:rust` は手動の確認手順のビルドで代える。ただし `/quality-check` の必須ゲートは全数を回す）

（日付の境界に触らないため、`test:tz` は対象にしない。）

## 手動の確認手順（S1）

**合否は、コンソールで評価する式の値で決める**（「崩れない」を根拠にしない）。各手順の式は次の名前で参照する。

- **H（はみ出し）**: `[document.documentElement.scrollWidth <= document.documentElement.clientWidth, document.querySelector(".app-main").scrollWidth <= document.querySelector(".app-main").clientWidth]` が `[true, true]`（タスクの画面の `.task-board-columns` の中の横のスクロールは #515 の設計どおりで対象外）
- **S（セーフエリア）**: `(() => { const p = document.createElement("div"); p.style.cssText = "position:fixed;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)"; document.body.append(p); const s = getComputedStyle(p); const r = [s.paddingTop, s.paddingBottom]; p.remove(); return r; })()` で上下の値を得て、`document.querySelector(".app-header").getBoundingClientRect()` の中の文字の上端（`h1` の `getBoundingClientRect().top`）が上の値以上、下部のタブの各ボタンの `getBoundingClientRect().bottom` が `innerHeight − 下の値` 以下
- **K（キーボード）**: 入力欄にフォーカスしてキーボードを出した後、`(() => { const e = document.activeElement.getBoundingClientRect(); const v = visualViewport; return [e.top >= 0, e.bottom <= v.height + 1, v.scale]; })()` が `[true, true, 1]`
- **Z（自動拡大）**: コンパクトで `[...document.querySelectorAll("input, textarea, select")].every((e) => parseFloat(getComputedStyle(e).fontSize) >= 16)` が `true`。入力欄にフォーカスした後の `visualViewport.scale` が `1`
- **T（押す対象）**: 下部のタブの各ボタン・「チェックイン」・シートの閉じるボタンの `getBoundingClientRect()` の `width` と `height` がどれも 44 以上

**準備**: iOS シミュレータは `ios-shell.md`「手動の確認手順（S1）」の準備、Android エミュレータは `android-shell.md`「手動の確認手順（S1）」の準備に従う。

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | **ブラウザ（Chromium）**: `npm run dev` を開き、Chrome の DevTools のデバイスのツールバーで幅を 375×812・320×568 にする。ダッシュボード・チャット（朝会を始めた状態）・タスクの各画面と、シートを開いた状態で式 **H**・**T** を評価する | どの組み合わせでも H が `[true, true]`、T が `true`。画面の写しを PR に貼る |
| 2 | **ブラウザ（境界とデスクトップ）**: 同じ DevTools で幅を 767・768・1280 にし、`document.querySelector(".app-layout").classList.contains("app-layout--compact")` と `getComputedStyle(document.querySelector(".app-body")).gridTemplateColumns` を評価する。基準点の `main` でも 768・1280 で同じ式を評価する | 767 で `true`、768・1280 で `false`。768・1280 の `gridTemplateColumns` が基準点の `main` と同じ文字列。1280 の画面の写しを基準点と並べて PR に貼る |
| 3 | **ブラウザ（WebKit）**: macOS の Safari の「レスポンシブデザインモード」で `npm run dev` を 375×812 にし、手順 1 の式 **H** を評価する | 手順 1 と同じ値（WebKit と Chromium で揃う） |
| 4 | **iOS シミュレータ**（ノッチ・Dynamic Island のある端末。例: iPhone 17）: Web インスペクタを使うため `native/tauri-app` で `npx @tauri-apps/cli ios build --debug --target aarch64-sim --ci` を実行し、`xcrun simctl install booted <.app>` → `xcrun simctl launch booted dev.aiboss.app` で起動する。Safari の開発メニュー → シミュレータでコンソールを開き、ダッシュボード・チャット・タスクの各画面で式 **H**・**S** を評価する | H が `[true, true]`。S の上の値が `0px` でなく、ヘッダの文字の上端がその値以上、タブの下端が `innerHeight − 下の値` 以下。画面の写し（`xcrun simctl io booted screenshot`）を PR に貼る |
| 5 | 手順 4 のアプリで、チャットの入力欄・タスクのフォームの名前の欄をタップしてソフトウェアキーボードを出す（出なければシミュレータの I/O → Keyboard → Toggle Software Keyboard）。式 **K**・**Z** を評価する | K が `[true, true, 1]`、Z が `true` と `1`。キーボードが出ている間、下部のタブと常設の帯が見えない（画面の写し） |
| 6 | 手順 4 のアプリで、2 本の指でピンチして拡大し、`window.innerWidth` と `.app-layout` の `app-layout--compact` を評価する | 拡大できる（`visualViewport.scale` が 1 より大きい）。`app-layout--compact` が `true` のまま（決定 1 の既知の注意の確認。`false` になったら記録し、幅の取り方を改める） |
| 7 | **Android エミュレータ**: `npm run build:tauri:android-emu` の APK を `adb install -r` で入れ、`adb shell monkey -p dev.aiboss.app 1` で起動する。Chrome の `chrome://inspect/#devices` でコンソールを開き、`navigator.userAgent` を記録した後、手順 4 と同じ画面で式 **H**・**S** を評価する | H が `[true, true]`。S の上の値が `0px` でなく、ヘッダの文字の上端がその値以上、タブの下端が `innerHeight − 下の値` 以下（edge-to-edge のステータスバー・ナビゲーションバーに重ならない）。`navigator.userAgent` の `Chrome/<版>` を PR に記録する。**S の値が `0px` でバーに重なったら、S1 の中で親に問う**（決定 5） |
| 8 | 手順 7 のアプリで、手順 5 と同じくキーボードを出して式 **K** を評価する | K の 1 つ目・2 つ目が `true`。キーボードが出ている間、下部のタブと常設の帯が見えない |
| 9 | macOS で `npm run build:tauri` の `.app` を起動する（窓の幅は既定のまま） | デスクトップの骨組み（左のナビ・分割バー・サイドパネル）で描かれる。分割バーのドラッグと矢印キーで幅が変わる（#362 の振る舞いのまま） |
| 10 | 手順 4 のアプリ（iPhone のシミュレータ）で、Device → Rotate Left（⌘←）で端末を回し、コンソールで `[innerWidth < innerHeight, screen.orientation ? screen.orientation.type : null]` を評価する | 1 つ目が `true`（画面は縦のまま）。2 つ目の値を記録する。回した後の画面の写しを PR に貼る（P3） |

## 決定時の選択肢と判断材料

作成時（2026-10-05）にオーナー・親へ上げた問いと、その時の選択肢・推奨・判断材料。いずれも推奨どおりに決まった（「決定（2026-10-05）」節）。

### オーナーへの問い（画面構成・ナビゲーション・操作の体験の根幹）

#### O1. スマホでのナビゲーションの形と、S1 に入れる主要画面

| 案 | 内容 | 片手での操作 | 既存の体験との一貫性 | 費用 |
|---|---|---|---|---|
| **A 下部のタブ（推奨）** | 下端に「ダッシュボード・チャット・タスク・その他」。その他で決定ログ・日報・作業ログ・設定 | 親指が届く。主要 3 画面へ 1 タップ | 7 つの並びの上位 3 つ（`NAV_ITEMS` の順）をそのまま前に出す | 中 |
| B 左上のメニュー（ドロワー） | ヘッダの左にメニューのボタン。押すと 7 つが縦に並ぶ（デスクトップの左のナビをそのまま引き出す形） | 左上は親指が届きにくい。どの画面へも 2 タップ | デスクトップの 7 つの並びと同じ | 小 |
| C 上部の横スクロールのタブ | ヘッダの下に 7 つを横に並べ、はみ出しは横のスクロール | 上部は届きにくい。隠れたタブに気づきにくい | 7 つが同じ重みのまま | 小 |

- 推奨の理由: 朝会・夕会の報告（チャット）・タスクの着手（タスク）・今日の状態（ダッシュボード）を 1 日に何度も行き来する。ダッシュボードは「アプリの顔」（`AppLayout.tsx` 69〜70 行・#60 の仮定）で既定の画面。決定ログ・日報・作業ログ・設定は振り返り・設定で頻度が低い
- **主要画面（S1 でレイアウトまで手当てする画面）**の推奨: ダッシュボード・チャット・タスク。ほかの 4 画面は S1 ではナビゲーションから到達できるまでとし、中のレイアウトは S2

#### O2. 横のパネル（チェックイン・今日のまとめ・着手時の促し）の置き場

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A 別の画面（タブを 1 つ足す） | 「今日」のタブにパネルの中身を出す（O1 の A ならタブが 5 つ） | 作りが単純 | 他の画面を見ている間、着手中のタスク・休憩の状態が見えない。着手時の促しが「今日」の画面でしか見えない（どの画面でも見える前提〔#566〕が崩れる） |
| B ダッシュボードの上部に入れる | ダッシュボードの先頭にチェックインと今日のまとめ | タブが増えない | A と同じく他の画面では見えない。ダッシュボードが縦に長くなる |
| **C 常設の帯 ＋ 下から出るシート（推奨）** | どの画面でも、タブの上に「着手中のタスク＋チェックインのボタン」の帯を出し、押すとシートでチェックイン・今日のまとめを開く。着手時の促しは帯に出す（「クリティカル設計決定」4 の図） | デスクトップの「どの画面でも見える」を保つ。チェックインへ 1 タップ | 帯の分だけ画面の縦が減る。シートのフォーカスの扱いが要る（`SessionTranscriptDialog` の作りを流用） |
| D 各画面の下に畳んで置く | 各画面の末尾にパネルを畳んで置く | 作りが単純 | スクロールしないと届かない |

- 推奨の理由: チェックインはサボり検知の活動シグナルの入口で、着手時の促し（#566）は「どのビューでも見える」ことを前提に置いた（`AppLayout.tsx` 122〜130 行）。C はそれをスマホでも保てる唯一の案

#### O3. チャットの Enter（改行と送信）

| 案 | 内容 |
|---|---|
| **A コンパクトでは Enter を改行、送信はボタンだけ（推奨）** | スマホの多くのチャットの作法。朝会・夕会の報告は複数行になりやすい |
| B 今のまま（Enter で送信） | スマホでは改行を入れられない（Shift+Enter がソフトウェアキーボードに無い） |
| C 設定で選べるようにする | 設定の項目が 1 つ増える（YAGNI） |

- 判断材料: 今の Enter の送信は、日本語の変換の確定を送信と取り違えない配慮（`isComposing`・`keyCode === 229`）を持つ（`ChatView.tsx` 514〜518 行）。A でもこの配慮は残る（デスクトップの経路）

### 親への問い

#### P1. 幅の境界の値と判定の仕組み

- 推奨: **768px・`windowWidth < 768` をコンパクト**、判定は JS の純粋関数 1 つ（`window.innerWidth` と `resize`）、CSS は `.app-layout--compact` のクラスに従う（決定 1）
- 代替案: (b) 境界を 966px（今のデスクトップが成り立つ最小）にする → 今 768〜965px で使っているデスクトップの窓が変わる／(c) CSS の `@media` と `matchMedia` の両方で判定する → 境界の値が 2 か所になり、jsdom で境界を殺せない／(d) 640px 等のより狭い値 → iPad mini の縦持ち（744px）でデスクトップの骨組みになり、中央が 258px に縮む

#### P2. 開発者用の版にも同じレイアウトを適用するか

- 推奨: **適用する**（エントリで分けない）。理由: 画面のコードは製品版と開発者用で同じ（`app-entry/main.tsx` の方針）。分けると分岐が増え、ブラウザの狭い幅での確認（手動の確認手順 1〜3）ができなくなる。デスクトップの窓を 768px 未満に狭めたときだけコンパクトになる
- 代替案: 製品版のモバイルのビルド（`TAURI_ENV_PLATFORM` が `ios`・`android`）だけでコンパクトにする

#### P3. 縦横の回転・タブレットの扱い

- 推奨: **iPhone は縦に固定し（`Info.plist` の `UISupportedInterfaceOrientations` を `Portrait` だけにする）、iPad と Android は回転を許して幅だけで判定する**。iPad の専用の調整（縦持ちの 744〜834px の幅でのレイアウトの磨き込み）は S3 へ送る
- 判断材料: iPhone の横持ちは幅 568〜956px・高さ約 320〜440px。幅だけで判定すると、大きい iPhone の横持ちでデスクトップの骨組みが高さ 440px 未満に詰め込まれる。Android は機種の幅がまちまちで、固定は `AndroidManifest.xml` の `screenOrientation` で行える（同じく固定するかも決める）
- 代替案: (b) すべて回転を許し幅だけで判定する（S1 で横持ちの確認を足す）／(c) 高さも判定に入れる（例: 高さ 500px 未満もコンパクト）

#### P4. 確認の方法（E2E のブラウザを入れるか）

- 推奨: **入れない**。jsdom で判定できる部分を自動に、レイアウトの値は手動の確認手順の式で確かめる（決定 9）
- 代替案: Playwright（Chromium・WebKit）を入れ、幅 375・768 で式 H を自動で評価する → 依存とブラウザの導入（ホストへの道具の導入）が要り、必須ゲートに足すかの判断も伴う。WebKit は iOS の WKWebView と同じではない

#### P5. iOS の自動拡大の避け方

- 推奨: **コンパクトで入力欄の文字を 16px にする**（決定 7）
- 代替案: viewport に `maximum-scale=1` を足す → WKWebView はページの指定に従うため、ピンチの拡大も止まる（アクセシビリティの後退）

## 決定（2026-10-05）

作成時の問い（オーナー O1〜O3・親 P1〜P5）への回答。いずれも推奨どおり。選択肢と判断材料は「決定時の選択肢と判断材料」節に残した。

| ID | 論点 | 決定 | 決めた人 | 反映先 |
|---|---|---|---|---|
| O1 | スマホでのナビゲーションの形と、S1 に入れる主要画面 | **A 下部のタブ**（ダッシュボード／チャット／タスク／その他。その他から決定ログ・日報・作業ログ・設定）。S1 で中のレイアウトまで直す主要画面は **ダッシュボード・チャット・タスク**。代替案: B 左上のメニュー（ドロワー）／C 上部の横スクロールのタブ | ★オーナー | 決定 3・スライス S1・受入基準（S1）の「ナビゲーション」 |
| O2 | 横のパネル（チェックイン・今日のまとめ・着手時の促し）の置き場 | **C 常設の帯 ＋ 下から出るシート**。着手時の促しは帯に常に置く。代替案: A 別のタブ／B ダッシュボードの上部／D 各画面の下に畳んで置く | ★オーナー | 決定 4・受入基準（S1）の「横のパネルの置き場」 |
| O3 | チャットの Enter | **A 狭い幅では Enter を改行にし、送信はボタンだけ**。デスクトップは今のまま（Enter で送信・Shift+Enter で改行）。代替案: B 今のまま／C 設定で選ぶ | ★オーナー | 決定 8・T5・受入基準（S1）の「チャットの Enter」 |
| P1 | 幅の境界の値と判定の仕組み | **768px（`< 768` で狭い幅）**。判定は JS の純粋関数 1 つに置き、CSS はその結果のクラス（`.app-layout--compact`）に従う。`@media` で骨組みを切り替えない | 親 | 決定 1・受入基準（S1） |
| P2 | 開発者用の版にも同じレイアウトを適用するか | **適用する**（エントリで分けない） | 親 | 非機能要件・手動の確認手順 1〜3 |
| P3 | 縦横の回転・タブレット | **iPhone は縦に固定**（`project.yml`・`Info.plist` の `UISupportedInterfaceOrientations` を `UIInterfaceOrientationPortrait` だけにする）。**iPad と Android は回転を許し、幅だけで判定する**。iPad 向けの調整は **S3** | 親 | 技術的な制約・失敗の経路・スライス S1・S3・受入基準（S1）の「画面の向き」・手動の確認手順 10 |
| P4 | 確認の方法（E2E のブラウザ） | **Playwright 等は入れない**。jsdom で判定できる部分を自動に、レイアウトの値は手動の確認手順の式で確かめる | 親 | 決定 9・やらないこと |
| P5 | iOS の自動拡大の避け方 | **狭い幅で入力欄の文字を 16px にする**。`maximum-scale=1` は使わない | 親 | 決定 7・受入基準（S1）の「viewport の指定」・手動の確認手順 5 |

## 仮定（軽微・可逆）

- M1: 仕様のファイル名は `docs/features/mobile-layout.md` とする。
- M2: スライスを S1（骨組み・主要 3 画面）・S2（残りの画面・ダイアログ・ホバーの代替・ボタンの大きさ）・S3（横向き・タブレット。P3 による）に切る。
- M3: コンパクトの判定のクラス名は `app-layout--compact`、純粋関数は `isCompactLayout`、境界の定数は `COMPACT_LAYOUT_MAX_WIDTH_EXCLUSIVE = 768`（名前は実装で改めてよい）。
- M4: コンパクトで「その他」の一覧は、ナビゲーションの中に展開する（別のダイアログにしない）。
- M5: 常設の帯の文言は「着手中: <タスク名>」「着手中のタスクはありません」、シートを開くボタンは「チェックイン」（文言は実装の PR でオーナーが確認してよい）。
- M6: キーボードが出ていると見なす差の閾値は 150px（`innerHeight − visualViewport.height > 150`）。日本語のソフトウェアキーボードの高さ（約 250〜350px。推論）より小さく、Safari の下部のバーの出入り（アプリの WebView には無い）より大きい値として置いた。
- M7: タスクの画面の列は、コンパクトでも #515 の「列の格子の中だけを横にスクロールする」設計を保ち、列の最小幅を `min(18rem, 100%)` にして 1 列が画面の幅に収まるようにする（`scroll-snap` で 1 列ずつ止める）。
- M8: コンパクトのヘッダは `ai-boss` と接続状態のまま残す（接続状態〔`ConnectionStatus`〕は DB 未接続の案内を兼ねるため隠さない）。
- M10: 画面の向きの設定の検査は、`scripts/*.test.mjs`（`npm test` の `test:scripts`。`ios-shell-gitignore.test.mjs` と同じ置き場）に置き、`project.yml`・`Info.plist`・`AndroidManifest.xml` を文字列として読んで判定する。`Info.plist` と `project.yml` の両方を直すのは、`tauri ios build` が xcodegen で `Info.plist` を `project.yml` から作り直すかどうかを確かめていないため（推論。両方が一致していればどちらでも同じ結果になる）。
- M9: viewport の検査は、`web/src` の vitest（node の環境）で `app.html`・`index.html` を読んで行う（`vite-build-inputs.test.ts` と同じく、ファイルを読む検査を web のテストに置く）。
