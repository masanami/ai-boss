# 製品版の iOS の器（Tauri の iOS ターゲット・macOS 専用部品の切り分け・通知の許可の体験）

> Issue #669。2026-10-02 に作成した。範囲と前提は、オーナーの決定 9（#585・2026-10-01・★）と ADR 0011 の決定 5・12・14・20 に拠る。**通知の許可の体験（時期・文面・拒否時の案内）はオーナーの決定事項で、未決**（「未決（オーナー）」節）。それ以外の設計判断は、この仕様の作成時点では親（flywheel エージェント）の確認待ちのものを含む（「未決（親）」節）。

## 概要

製品版（Tauri 2）の器 `native/tauri-app/` を、macOS に加えて **iOS でもビルドして動かせる**ようにする。今の器は iOS 向けにコンパイルできない。原因は、デスクトップ専用の部品（メニューバーのトレイ・多重起動の防止・ウィンドウの最小化の解除）を、プラットフォームで切り分けずに使っていることにある。この仕様では、次の 3 つを行う。

- デスクトップ専用の部品を `cfg` で切り分ける
- iOS の入口（`mobile_entry_point`）と Xcode のプロジェクト（`gen/apple`）を足す
- 通知の許可を求める体験を作る

あわせて、#585 S3（#671）で配線した予約通知を、製品版のアプリで通しで確かめる（決定 9 の「通しの確認」）。

## 背景・目的

- ADR 0011 は、製品版の土台を Tauri 2 とし（決定 5）、初回リリースを macOS と iOS / Android とした。モバイルはデスクトップと同等の全機能とする（決定 20）。
- #579（実行の仕組みの作り替え）は「iOS / Android のビルド」を範囲外とした（`tauri-in-app-runtime.md`「やらないこと」）。#585 S3 も iOS の器を範囲外とし、この Issue へ送った（決定 9・★オーナー）。
- iOS で必要な部品のうち、次の 3 つは iOS 向けにコンパイルが通る（実測）。#576 の検証コードは、シミュレータで画面・plugin-sql・ストリーミング・予約通知が動くことを確かめている。
  - DB（plugin-sql の fork。#580）
  - 秘密情報を扱う通信層（secure-transport。#581）
  - 通知（fork。#671）
- **欠けているのは器そのもの**で、具体的には次の 3 つである。
  - iOS のターゲット
  - `mobile_entry_point`
  - デスクトップ専用部品の切り分け
- 通知の許可は、iOS では**アプリが許可を求めない限り通知が表示されない**（Apple の文書: 予約の前に必ず `requestAuthorization` を呼ぶ）。今の器はどこでも許可を求めていない。そのため、器ができても、許可の体験が無いと催促は届かない。

## ユーザーストーリー

- 利用者として、iPhone でも ai-boss を開き、Mac と同じ画面でボスに報告・相談したい。
- 利用者として、iPhone でアプリを閉じていても、ボスの催促を通知で受け取りたい。
- 利用者として、通知の許可を求められる理由を、許可する前に知りたい。拒否した後でも、催促を受けたくなったら戻せる道を知りたい。

## 実コードの実測（2026-10-02・`main` c867dd4／#673 の head ec9d9f4）

### 器（`native/tauri-app/`・`main`）

| 対象 | 実測 |
|---|---|
| `gen/` | `schemas` だけ。`gen/apple`（Xcode のプロジェクト）は無い。**ルートの `.gitignore` が `native/tauri-app/gen/` を丸ごと無視している**ため、`tauri ios init` で作っても今のままではコミットされない |
| `lib.rs` の入口 | `pub fn run()` に `mobile_entry_point` は無い。`main.rs` は `app_lib::run()` を呼ぶだけ |
| `cfg(target_os = "macos")` の範囲 | 次の 3 つだけが macOS に限られている。<br>・多重起動の知らせ（`single_instance_socket_path`・`notify_running_instance`・`NOTIFY_*`）<br>・`run` の中のソケットの経路<br>・`desktop_shell::handle_run_event` の `RunEvent::Reopen`<br>次のものは**切り分けられていない**。<br>・トレイ（`desktop_shell::create_tray`。`tauri::menu`・`tauri::tray`）<br>・多重起動の防止（`with_single_instance`・`instance_lock_plugin`）<br>・`show_main_window` の `unminimize`<br>・毎分の刻み（`configure_with` の `setup` の `spawn_minute_ticker`） |
| `Cargo.toml` | `tauri` に `tray-icon` 機能を付けている。`tauri-plugin-single-instance = "~2.5"` は共通の `[dependencies]` にある。プラットフォームごとの依存の表は無い |
| `tauri.conf.json` | `identifier` は `dev.aiboss.app`、`app.windows` は空（メインのウィンドウは `setup` で `WebviewWindowBuilder::from_config` から作る）。`bundle.targets` は `app`、`bundle.icon` は macOS 用の 4 つ。`beforeBuildCommand` は `npm run build:app --workspace web`。iOS 向けの設定（`bundle.iOS`）は無い |
| `capabilities/default.json` | `platforms` を指定していない（全プラットフォームに効く）。`windows: ["main"]`。通知は `notification:allow-notify` だけを許す |
| `build.rs` | `tauri_build::try_build`。tauri-build は `cfg(desktop)`・`cfg(mobile)` の別名を出す（#576 の検証コードの `cfg_attr(mobile, …)` がこれで動いた） |
| ナビゲーションの判定 | `is_allowed_navigation` は、`tauri://localhost` だけを許す。iOS の WKWebView も、アプリのオリジンは `tauri://localhost` である（推論。macOS と同じ WKWebView の独自スキームの経路。手動の確認手順で確かめる） |
| 証跡の表示 | web は `window.open(blob:…, "_blank")` で新しいウィンドウを開く（`web/src/app-entry/main.tsx`）。器の `on_new_window` は `Allow` を返す。iOS の Tauri は 1 つの WebView で動くため、新しいウィンドウが開くかは未確認 |

### iOS 向けのコンパイルの実測（ホスト: Xcode 26.6・rustc 1.98.1・Tauri CLI 2.12.0）

`rustup` のターゲット `aarch64-apple-ios`・`aarch64-apple-ios-sim` が入っている。この状態で、`cargo check --manifest-path native/tauri-app/Cargo.toml --target aarch64-apple-ios-sim --lib` を `main` に対して走らせた（`CARGO_TARGET_DIR` はリポジトリの外。依存を含む初回で約 50 秒）。

- **依存はすべて通る**: 次のものは、エラー無しにコンパイルできた。
  - `tauri` 2.12.0（`tray-icon` 機能つきのまま。モバイルではトレイのモジュールが外れるだけ）
  - `tauri-plugin-sql`（fork）
  - `secure-transport`（単体の `cargo check --target aarch64-apple-ios-sim` も合格）
  - `tauri-plugin-fs`
  - `tauri-plugin-notification`
  - `tauri-plugin-single-instance`
- **器のクレートだけが 6 件のエラーで落ちる**:
  - `desktop_shell.rs` の `use tauri::menu`・`use tauri::tray`（E0432 が 2 件）と、`tauri::menu::IsMenuItem`（E0433 が 2 件）
  - `lib.rs:348` の `tauri_plugin_single_instance::init`（E0425。モバイルでは `init` が無い）
  - `desktop_shell.rs:113` の `window.unminimize()`（E0599）
- 実機のターゲット（`--target aarch64-apple-ios`）でも、同じ 6 件だけで落ちる（依存はすべて通る）。
- #673 の head（ec9d9f4。通知プラグインを fork への path 依存にしたもの）でも、同じ 6 件だけで落ちる。fork の Rust 部分は iOS 向けに通る（Swift のビルドは `cargo check` では走らない）。
- **CI は無い**（`.github/workflows` が無い）。品質ゲートは、開発機での `npm run` の実行で判定している。

→ **`cargo check` による iOS 向けのコンパイルの検査は、開発機でテストとして走らせられる**（数秒〜1 分）。走らせられないものは次の 2 つで、手動の確認手順に置く。

- Xcode でのビルド（`tauri ios build`。Swift のプラグインのリンクと `gen/apple`）
- シミュレータでの起動

### #671（PR #673・未マージ）が入れるもの（この仕様の前提）

- 通知プラグインの fork（`native/tauri-plugin-notification/`。iOS の Swift だけを直した差分 1・2）。器は path 依存で使う。
- iOS／Android だけの capability `capabilities/mobile-nudges.json`（`platforms: ["iOS", "android"]`。`notification:allow-cancel`・`notification:allow-get-pending`）。
- 製品版のエントリの iOS の配線。次の 3 つから成る。
  - プラットフォームの判定: ビルド時の `TAURI_ENV_PLATFORM` が `ios` のとき（`web/vite.app.config.ts` の `envPrefix`）
  - iOS のときの動き: 毎分の検知の代わりに、催促の予約の計画し直しを組む
  - **iOS の判定が真になる製品のビルドは、#669 まで無い**（#673 の本文）。`tauri ios build` がこの値を `ios` にするため、この仕様の S1 のビルドで初めて iOS の分岐が製品のアプリで動く
- **許可の要求は誰もしていない**。fork の iOS の `requestPermissions` は、`requestAuthorization(options: [.badge, .alert, .sound])` を呼ぶ。`checkPermissions` は `authorized`・`ephemeral`・`provisional` を `granted`、`notDetermined` を `prompt` として返す。Rust からは `Notification::request_permission`・`permission_state`（`src/mobile.rs`）で呼べる。ただし、どの capability も `notification:allow-request-permission`・`allow-permission-state`・`allow-is-permission-granted` を許していない。
- #673 の本文が残した上流の既存のリスク: `NotificationHandler.toActiveNotification` は `notificationsMap[request.identifier]!` を強制アンラップする。アプリの再起動前に登録した予約が前面で表示されると（`willPresent`）、控えが空のため落ちうる。#669 の通しの確認で確かめる、とされた。
- #585 S3 の手動の確認手順（1〜7。シミュレータ）は、#673 の時点で**未実施**。手順 7（通知を拒否した状態での予約の `invoke` の結果）も未実施で、拒否時の挙動の実測は無い。

### #576 の検証コード（ブランチ `spike/ios-tauri`・b9668b7。読むだけ）

- `spikes/tauri/app/src-tauri/` の作り:
  - `lib.rs` は `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()` の 1 本
  - `gen/apple` はコミットしている（`project.yml`・`*.xcodeproj`・`Info.plist`・`*.entitlements`・`Assets.xcassets`・`LaunchScreen.storyboard`・`Podfile`）
  - `gen/apple/.gitignore` は `xcuserdata/`・`build/`・`Externals/` を無視する
  - `tauri.conf.json` に開発チームの指定（`bundle.iOS.developmentTeam`）は無い。それでもシミュレータ向けのビルド（`tauri ios build --target aarch64-sim --ci`）は通った
- 詰まった点（README）:
  - `tauri ios build` の 2 回目が `Directory not empty` で落ちる。前回の `gen/apple/build/arm64-sim` を退避すると通る
  - `tauri ios init` が Homebrew で cocoapods を入れ直した（開発機の環境が変わる副作用）
  - 通知の許可のダイアログは、シミュレータでもタップが要る（`simctl privacy` に通知が無い）
- capability は検証用に広く許していた（`csp: null`・`notification:default` ほか）。製品にはそのまま持ち込まない。

### Apple の文書で確かめたこと（2026-10-02・developer.apple.com）

- 「Asking permission to use notifications」・`requestAuthorization(options:completionHandler:)`:
  - 許可の要求は、**初回だけ OS のダイアログを出し、利用者の答えを記録する。2 回目以降の要求はダイアログを出さない**。
  - 「なぜ許可が要るのかが分かる文脈で求める」ことを勧めている。例として「リマインダーを送るタスク管理アプリなら、最初のタスクを予定した後に求める。初回起動で自動的に求めるより体験が良い」と挙げている。
  - ローカル通知を予約する前に、必ずこのメソッドを呼ぶよう求めている。
  - 利用者は、システムの設定でいつでも許可を変えられる。
- 仮の許可（`.provisional`）:
  - ダイアログを出さずに自動で許可される。ただし通知は音・バナー・ロック画面に出ず、通知センターの履歴にだけ静かに届く。
  - fork の `requestPermissions` は、オプションを `[.badge, .alert, .sound]` に固定している。そのため、仮の許可を使うには fork の差分が要る。
- `UIApplication.openNotificationSettingsURLString`: 設定アプリの、このアプリの通知の設定へ直接開く URL。使うには `UIApplication.open` を呼ぶネイティブのコードが要る。器は今、外部へのナビゲーションを拒否し（`is_allowed_navigation`）、URL を開くプラグインも入れていない。
- 通知の許可のダイアログに、アプリが説明文を足す Info.plist のキーは無い（カメラの `NSCameraUsageDescription` のようなもの）。**推論**（上の文書には、そうしたキーが一切出てこない。一次情報で否定の確認はしていない）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] 製品版の器を、iOS シミュレータ向けにビルドできる（S1）
- [ ] iOS のアプリを起動すると、製品版の画面（ダッシュボード）が出る（S1）
- [ ] iOS のアプリで、DB（plugin-sql の fork）が開き、データがアプリの再起動の後も残る（S1）
- [ ] iOS のアプリで、BYOK のキーをキーチェーンへ保存・削除でき、保存の有無を表示できる（S1）
- [ ] macOS の製品版の振る舞い（メニューバー常駐・閉じても終わらない・Dock からの再表示・多重起動の防止・毎分の刻み）は変わらない（S1）
- [ ] iOS のアプリは、オーナーが決めた時期と文面で通知の許可を求める（S2。未決 O1・O2）
- [ ] 通知が拒否されているとき、オーナーが決めた形で案内する（S2。未決 O3）
- [ ] 製品版の iOS のアプリで、予約通知を通しで確かめる（起動 → 予約 → 活動 → 取り消し → 予約時刻を過ぎた予約の確定、アプリの終了中に届くこと）（S2。#585 決定 9 の「通しの確認」）

## 非機能要件

- macOS の製品版の振る舞いと、品質ゲート（`lint`・`typecheck`・`test`・`test:rust`・`test:tauri`）を退行させない。
- iOS のアプリが WebView に許す権限は、今の macOS の器と同じ最小の集合から始める。iOS だけに要る権限は、`platforms` を iOS（・Android）に限った capability で足す（#585 S3 と同じ型）。
- ローカル完結（開発者用の版）と、製品版の方針（ADR 0011・改訂後の ADR 0001〜0003）を守る。器は、Anthropic と中継への推論の要求のほかに外部へ送らない。この仕様は新しい外部への送信を作らない。

## 技術的な制約・方針

- Tauri 2.12・Tauri CLI 2.12.0。iOS のビルドには Xcode・`xcodegen`・cocoapods・`rustup` の iOS ターゲットが要る（開発機の前提。手動の確認手順の「準備」）。
- 署名・プロビジョニング・実機・App Store は範囲外（#587。ADR 0011「未決」で、実機の確認はオーナーの判断で製品化の後のフェーズ）。シミュレータ向けのビルドは開発チームの指定なしで通る（#576）。
- `docs/` は非権威。正はコードとテストである。

## クリティカル設計決定

### 1. デスクトップ専用部品の切り分け（親の確認待ち・推奨）

- **方針**: tauri-build が出す `cfg(desktop)`・`cfg(mobile)` で切り分ける。製品のデスクトップは macOS だけだが、Windows を後続で足す（ADR 0011 決定 19）。そのため、デスクトップの部品は `target_os = "macos"` ではなく `desktop` に付ける。今の `cfg(target_os = "macos")` のもの（多重起動のソケット・`Reopen`）は、macOS 固有の実装なので変えない。
- **デスクトップだけに置くもの**（`#[cfg(desktop)]`）:
  - トレイ（`create_tray` と、`tauri::menu`・`tauri::tray` を使う箇所）
  - `show_main_window` の `unminimize`
  - 多重起動の防止（`with_single_instance`・`instance_lock_plugin`）
  - 毎分の刻み（`spawn_minute_ticker`）
  - `run` の `RunEvent::Ready` でのトレイの作成
- 毎分の刻みをデスクトップに限る理由: iOS は毎分方式を使わない（#585 決定 8・S3 の配線は iOS では `startScheduler` を呼ばない）。iOS で刻みを送っても、受け手がいない。
- **`Cargo.toml`**:
  - `tauri-plugin-single-instance` を、デスクトップのターゲットの依存の表（`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`）へ移す（モバイルでは `init` が無く、使えない）。
  - `tauri` の `tray-icon` 機能は、共通の依存に付けたままにする。モバイルでは何もしないことを、実測（`tray-icon` つきの `tauri` が iOS 向けに通った）で確かめた。依存の表を割ると `tauri` の版の指定が 2 か所になるため、割らない。
- **純粋関数とその単体テストは切り分けない**: `close_decision`・`menu_action`・`reopen_action`・`duration_until_next_minute` などは、プラットフォームに依存しない。`cfg` を付けるのは、Tauri のデスクトップ専用 API を呼ぶ薄い部分だけにする。
  - `desktop_shell.rs` のテストと `tests/desktop_shell.rs` は、ホスト（macOS）で今までどおり走る。
- **iOS の入口**: `run` に `#[cfg_attr(mobile, tauri::mobile_entry_point)]` を付ける。モバイルの `run` は、次のとおりにする。
  - 多重起動の防止を組まない: iOS はアプリのプロセスを 1 つしか起動しない（OS の仕組み）
  - 錠の失敗の分岐を持たない
  - `app.run` のコールバックでは、`handle_run_event`（閉じる要求の処理。iOS ではウィンドウの閉じる要求は来ない）だけを呼ぶ
- **iOS で代わりを置かないもの**: トレイ・多重起動の防止・Dock からの再表示・閉じる要求で隠す動き。iOS には、これらに当たる仕組みが無い。アプリの前面・背面は OS が管理する（「やらないこと」）。

### 2. Xcode のプロジェクト（`gen/apple`）をコミットする（親の確認待ち・推奨）

- `tauri ios init` で `native/tauri-app/gen/apple` を作り、**リポジトリにコミットする**。`gen/schemas` は今までどおり無視する。
- ルートの `.gitignore` は、`native/tauri-app/gen/` を `native/tauri-app/gen/schemas/` に絞る。`gen/apple/.gitignore`（`tauri ios init` が作る。`xcuserdata/`・`build/`・`Externals/`）はそのまま置く。
- **理由**: `gen/apple` は次の 3 つを持つ。毎回生成し直すと、手で加えた設定が消える。
  - `Info.plist`（向き・iPad の対応・後で足す設定）
  - エンタイトルメント
  - アイコンの組
  #576 の検証コードも、`gen/apple` をコミットしている。
- **代替案**: 毎回 `tauri ios init` で作る（コミットしない）。生成物の差分を見なくて済むが、`Info.plist` の変更を残せず、開発機ごとに cocoapods の副作用を毎回受ける。
- `eslint.config.js` は `native/tauri-app/gen/**` を既に無視しているため、変えない。iOS のビルドの出力（`gen/apple/build/` に Web の資産の写しが入る）が lint を壊さないことは、手動の確認手順で確かめる。

### 3. iOS 向けのコンパイルの検査を npm のスクリプトにする（品質ゲートへの追加は親の確認待ち）

- 新しいスクリプト `check:ios` を足す。器のライブラリを、`aarch64-apple-ios-sim` と `aarch64-apple-ios` の 2 つのターゲットで `cargo check` する。`quality-check-runner` が単一コマンドで呼べるよう、`npm run check:ios` 1 本にする。
- 前段の `precheck:ios` で、製品版の web（`web/dist-app/`）をビルドする。`generate_context!` が `frontendDist` を要するためで、`pretest:tauri` と同じ形にする。
- **これでデスクトップの変更が iOS を壊したことに、開発機で気づける**。Xcode でのビルド（Swift のリンク）とシミュレータでの起動は、自動の検査に入れない（シミュレータの操作が要り、数分かかる）。これらは手動の確認手順に置く。
- 必須ゲート（CLAUDE.md の品質方針）に `check:ios` を足すかは、親の確認待ち（「未決（親）」P2）。

### 4. 通知の許可の体験（★オーナー・未決 O1〜O3。S2）

「未決（オーナー）」節を見よ。体験の決定を受けた後、S2 の設計で次の 2 つを決める。

- **許可の要求の経路**: 次のどちらかにする。
  - capability `mobile-nudges.json` の系統で `notification:allow-request-permission`・`notification:allow-permission-state` を iOS・Android に限って許す
  - 器の Rust のコマンドにする
  前者で足りる見込み（#673 の型）。
- **設定アプリへの誘導**: 誘導するなら `openNotificationSettingsURLString` を開くネイティブの経路（器のコマンドか、URL を開くプラグイン）が要る。

## 機能全体の設計

### 失敗の経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| iOS 向けのビルドが、デスクトップ専用 API の使用で落ちる（今の 6 件） | 決定 1 で切り分け、`npm run check:ios` の合格を受入基準にする（S1） |
| 切り分けで、macOS の部品（トレイ・多重起動の防止・刻み・Dock の再表示）を取り込み損ねる | 既存のテスト（`tests/desktop_shell.rs`・`lib.rs` の単体テスト・設定の検査）を変更なしで合格させる。`Cargo.toml` の設定の検査を足す（S1）。`.app` のビルドと既存の手動の確認（#579 S3・#659）を行う |
| `mobile_entry_point` が無く、Xcode のリンクで入口が見つからない | `cargo check` では見つからない。入口の属性を設定の検査（ソースの検査）で固定し、Xcode でのビルドを手動の確認手順で行う（S1） |
| `gen/apple` が `.gitignore` で無視され、コミットされない | `.gitignore` を絞り、追跡の有無をテストで確かめる（S1） |
| `gen/apple` の bundle identifier が `tauri.conf.json` と食い違う（キーチェーン・データの置き場所が別のアプリ扱いになる） | 設定の検査で一致を確かめる（S1） |
| iOS で DB の準備が失敗する（保存先・preload） | web の起動は、DB の失敗を記録して「DB 未接続」で描画を続ける（既存。#580 S2）。iOS で実際に開けることは、シミュレータで確かめる（手動の確認手順・S1） |
| iOS で通知プラグインの初期化が失敗する | 器の組み立て（`configure_with`）の失敗は起動の `panic` になる。シミュレータで起動できることを確かめる（手動の確認手順・S1） |
| iOS のビルドの出力（`gen/apple/build/`）が lint や `git status` を汚す | `.gitignore` のルートの `build/` と `gen/apple/.gitignore` が無視し、eslint は `native/tauri-app/gen/**` を無視する（既存）。手動の確認手順で確かめる（S1） |
| CSP・IPC が iOS の WebView で通らない（画面は出るが DB・コマンドが失敗する） | 自動では確かめられない。シミュレータで、DB の読み書きとキーの保存を確かめる（手動の確認手順・S1） |
| 証跡の新しいウィンドウ（`window.open`）が iOS で開かない | S1 では結果を記録する（期待値は定めない）。直すかどうかは、記録を見て別の Issue にする（「やらないこと」） |
| 通知の許可を求めないため、iOS では催促が表示されない | S2（オーナーの決定 O1〜O3 の後） |
| 利用者が許可を拒否する | S2（O3） |
| アプリの終了中の予約が届かない／再起動の後の前面表示で落ちる（`notificationsMap!`） | S2 の通しの確認（手動）。落ちたら fork の差分を足す |

### 実装計画（S1 のチケット分解の見通し）

S1 は 1 チケットで足りる見込み（触るファイルは 6〜10。`gen/apple` の生成物を除く）。

1. `Cargo.toml` の依存の表の分割と、`lib.rs`・`desktop_shell.rs` の `cfg`（決定 1）
2. `tauri ios init` による `gen/apple` の生成と `.gitignore`（決定 2）
3. `check:ios`・`precheck:ios`・`build:tauri:ios-sim` の npm のスクリプト（決定 3）
4. 設定の検査（`tests/config_checks.rs`）と、`.gitignore` の検査（`scripts/*.test.mjs`）の追加

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | iOS の器のビルド。<br>・デスクトップ専用部品の `cfg` による切り分け（決定 1）<br>・`mobile_entry_point`<br>・`gen/apple` のコミット（決定 2）<br>・`check:ios`（決定 3）<br>シミュレータで起動して画面が出ること、DB・キーチェーンが動くことを、手動の確認手順で確かめる。macOS の振る舞いは変えない。**通知の許可は求めない**（S2） | 6-10（`gen/apple` の生成物を除く） | **#671（PR #673）がマージされてから**。S1 は #673 の通知プラグインの fork（path 依存）と `mobile-nudges.json` の上で iOS をビルドする。iOS のビルドは `TAURI_ENV_PLATFORM=ios` で #673 の iOS の配線を初めて動かすため、#673 より前に出すと配線の無い器を確かめることになる |
| S2 | 通知の許可の体験（O1〜O3 の決定に従う。許可の要求の経路・設定アプリへの誘導の有無）と、製品版の iOS のアプリでの予約通知の通しの確認。通しの確認の流れは、起動 → 予約 → 活動 → 取り消し → 予約時刻を過ぎた予約の確定、アプリの終了中に届くこと。#585 S3 の手動の確認手順 1〜7 の未実施分を含む。**通知の実行系のため、PR は人間レビュー必須** | 未見積もり（O1〜O3 で変わる） | S1 がマージされ、オーナーが O1〜O3 を決めてから |

実装対象: S1

## やらないこと

- Android のターゲット（理由: #669 の範囲は iOS。ADR 0011 は初回リリースに Android を含めるが、受け持つ Issue が無い。親へ上げる〔「未決（親）」P3〕。決定 1 の `cfg(mobile)`・依存の表は Android にも効くが、Android のビルドの確認はしない）
- 実機での確認・署名・プロビジョニング・App Store への申請・開発チームの指定（理由: ADR 0011「未決」でオーナーが製品化の後のフェーズとした。署名と申請は #587）
- スマホ向けの画面レイアウト（理由: #586。S1 では今の画面がシミュレータに出ることだけを確かめる）
- iOS でのトレイ・多重起動の防止・Dock の再表示・閉じる要求で隠す動きの代わりの部品（理由: iOS には当たる仕組みが無い。アプリの前面・背面と単一のプロセスは OS が管理する）
- iOS での毎分の刻み（理由: iOS は予約通知方式〔#585 決定 8〕。刻みの受け手がいない）
- 証跡の新しいウィンドウを iOS で開けるようにすること（理由: S1 では記録だけを行う。直すなら、表示の方式を変える判断になるため、記録を見て別の Issue にする）
- iOS での LLM の実際の送信の確認（BYOK・中継）（理由: 外部への送信で、キーか中継の資格情報が要る。通信層は iOS 向けにコンパイルが通ることまでを S1 で確かめる。実際の送信を S1 の手動の確認に入れるかは、親の確認待ち〔P1〕）
- 仮の許可（`.provisional`）（理由: 未決 O1 の選択肢の 1 つとして扱う。採るなら fork の差分が要る）
- 通知プラグインの上流への PR（理由: #585 決定 6。組織外への送信で、オーナーの承認を得て別に行う）

## 受入基準（S1）

検査は、ホスト（macOS）の `cargo test`・`node --test`・`npm run`・`git` で行う。シミュレータでしか見られないもの（ビルド・起動・画面・DB・キーチェーン）は「手動の確認手順（S1）」に置く（機能要件の S1 の 4 項目は、手順 1〜5 が受け持つ）。

**比較の基準点**: 「変更されない」の項目は、**#671（PR #673）をマージした後の `main`** を基準点とし、`git diff --name-only <基準点>...HEAD -- <パス>` の出力が空であることで判定する。

iOS 向けのビルド（コンパイルの検査）:

- [ ] `npm run check:ios` が合格する（器のライブラリの `cargo check`。ターゲットは `aarch64-apple-ios-sim` と `aarch64-apple-ios` の 2 つ）
- [ ] `lib.rs` の `pub fn run` に `#[cfg_attr(mobile, tauri::mobile_entry_point)]` が付いている（設定の検査がソースを読んで確かめる）

`gen/apple`（設定の検査・`.gitignore` の検査）:

- [ ] `git ls-files native/tauri-app/gen/apple/project.yml` が 1 行を返す（生成したプロジェクトがコミットされている）
- [ ] `git check-ignore -q native/tauri-app/gen/apple/project.yml` が 0 以外で終わる（無視の規則に当たらない）
- [ ] `native/tauri-app/gen/apple/project.yml` の bundle identifier（`PRODUCT_BUNDLE_IDENTIFIER`）は、`tauri.conf.json` の `identifier`（`dev.aiboss.app`）と一致する
- [ ] `native/tauri-app/gen/schemas/` の下のパスは、`git check-ignore` で無視される
- [ ] `native/tauri-app/gen/apple/build/` の下のパスは、`git check-ignore` で無視される

macOS の製品版の振る舞いが変わらないこと:

- [ ] `npm run test:tauri` が合格する
- [ ] `native/tauri-app/tests/desktop_shell.rs` は変更されない（基準点との差分が空）
- [ ] 基準点の `cargo test --manifest-path native/tauri-app/Cargo.toml -- --list` に出るテストの名前は、すべて変更後の同じ一覧にも出る（既存のテストを削除も改名もしない）
- [ ] `Cargo.toml` で、`tauri-plugin-single-instance` は、`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` の表にある（設定の検査）
- [ ] `Cargo.toml` で、`tauri-plugin-single-instance` の版の指定は `~2.5` である（設定の検査）
- [ ] `Cargo.toml` で、`tauri-plugin-single-instance` は、共通の `[dependencies]` に無い（設定の検査）
- [ ] `Cargo.toml` で、`tauri` の `features` に `tray-icon` がある（設定の検査）
- [ ] `native/tauri-app/capabilities/` は変更されない（基準点との差分が空。capability のファイルを `default.json` と `mobile-nudges.json` の 2 件に固定する #673 の設定の検査が、そのまま合格する）
- [ ] `npm run build:tauri` が成功する
- [ ] `npm run build:tauri` の後に、`npm run verify:tauri-bundle` が合格する

範囲:

- [ ] `server/src/` は変更されない（基準点との差分が空）
- [ ] `web/src/` は変更されない（基準点との差分が空）

品質ゲート:

- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:rust` が合格する

（`test:tauri` は上の「macOS の製品版の振る舞い」に含めた。日付の境界に触らないため、`test:tz` は対象にしない。）

## 手動の確認手順（S1）

**準備**（開発機）:

- Xcode 26 系・`xcodegen`・cocoapods が入っていること
- `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` を済ませていること
- iOS シミュレータ（例: iPhone 17・iOS 26.5）を起動しておくこと（`xcrun simctl boot <端末>`）

`tauri ios init` は cocoapods を入れ直すことがある（#576）。初回の生成は、それを承知の上で行う。

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | `npm run build:tauri:ios-sim` を実行する（`tauri ios build --target aarch64-sim --ci`） | ビルドが成功し、`gen/apple/build/arm64-sim/` に `.app` ができる。2 回目に `Directory not empty` で落ちたら前回の出力を退避して再実行し、その旨を PR に書く（#576 で既知の CLI の不具合） |
| 2 | `xcrun simctl install booted <.app>` の後、`xcrun simctl launch booted dev.aiboss.app` で起動する | 製品版のダッシュボードが表示される（`xcrun simctl io booted screenshot` で画面を残し、PR に貼る） |
| 3 | Safari の Web インスペクタ（開発メニュー → シミュレータ）で、コンソールを見る | 「製品版の DB を準備できませんでした」（`PRODUCT_DB_OPEN_FAILED_MESSAGE`）と、「製品版の催促の予約を始められませんでした」（`PRODUCT_NUDGE_REPLANNING_START_FAILED_MESSAGE`。#673）が出ていない |
| 4 | タスクを 1 件作り、`xcrun simctl terminate` でアプリを終えて、再び起動する | 作ったタスクが残っている |
| 5 | 設定の画面で BYOK のキー（ダミーの値でよい）を保存し、アプリを終えて再び起動する | キーの状態が「登録済み」と表示される（`ByokKeySection.tsx`）。削除すると「未登録」になる（キーの値は画面に出ない）。保存が失敗したら（例: OSStatus -34018。macOS の未署名のビルドで起きる失敗）、エラーの文言を PR に記録して親へ上げる。このとき S1 の出荷を止めるか、キーチェーンの確認を署名の Issue（#587）へ送るかは、親が決める。#576 は、iOS シミュレータで generic password の保存と読み出しを確かめている。ただし、データ保護キーチェーンの属性（`kSecUseDataProtectionKeychain`）つきの #581 の実装では、まだ確かめていない |
| 6 | 外部のリンク（例: `https://example.com`）へのナビゲーションを試みる（Web インスペクタで `location.href` を代入する） | 移動しない（`is_allowed_navigation`。iOS でもアプリのオリジンが `tauri://localhost` であることの確認） |
| 7 | 証跡ファイルを 1 つ添えて保存し、表示を試みる | 保存できることを確かめる。表示（新しいウィンドウ）は、開くか開かないかを記録する（期待値は定めない。「やらないこと」） |
| 8 | 手順 1 の後に `npm run lint` を実行し、`git status --short` を見る | lint が合格し、`gen/apple/build/` の下の出力が未追跡のファイルとして出ない |
| 9 | macOS で `npm run build:tauri` の `.app` を起動する | 既存の手動の確認（#579 S3・#659）の結果が変わらない。具体的には次の 4 つ。<br>・メニューバーのアイコンがあり、「開く」「終了」が動く<br>・ウィンドウを閉じても終わらない<br>・Dock のアイコンで再表示できる<br>・2 つ目の起動で既存のウィンドウが前面に出る |

S1 では通知の許可を求めないため、iOS で催促の通知は表示されない（S2）。#673 の iOS の配線が予約を登録していることは、手順 3 のログで、開始の失敗が無いことまでを確かめる。予約の到達は S2 の通しの確認で確かめる。

## 未決（オーナー）

S2 で決める（★オーナー。#585 決定 9）。各問いの判断材料は次の 3 つ。

- iOS の挙動（Apple の文書）: 許可のダイアログは 1 度しか出せない。2 回目以降の要求はダイアログを出さず、拒否の後は設定アプリでしか戻せない。
- アプリの体験: ボスが催促するアプリで、催促が届かないと主な価値が成り立たない。
- #585 S3 の手動の確認手順 7（拒否した状態での予約の結果）は未実施。

### O1. 通知の許可を求める時期

- **A 初回起動の直後**（DB の準備の後、最初の画面の上で求める）
  - 利点: 催促がアプリの価値の中心で、使い始めから届く。最初の催促（朝会・夕会の催促）は、タスクが無くても初回起動の計画し直しで予約されうる。
  - 欠点: Apple は「初回起動で自動的に求めるより、文脈の中で求めるほうが良い」と勧めている。
- **B 最初の催促が予約される直前**
  - 実質は A とほぼ同時になる。初回起動の計画し直しで、朝会・夕会の催促が予約されうるため。そのため、「目的が分かる文脈」になりにくい。
- **C 最初の朝会（または最初のタスクの登録）を終えた直後**
  - 利点: Apple の例（最初のタスクを予定した後）に最も近い。ボスとの最初のやり取りの後なので、「催促が来る理由」が分かる。
  - 欠点: それまでに予約した催促（朝会の催促など）は表示されない。
- **D 設定の画面で、利用者が有効にしたとき**（自分から有効にする）
  - 欠点: 有効にしない利用者には催促が届かない。ボスのアプリの性質と合わない。
- **E 仮の許可（`.provisional`）で始め、後で正式の許可を求める**
  - 欠点: 催促が音・バナー無しで通知センターに静かに届くだけで、催促の役を果たしにくい。fork の差分が要る。
- **推奨: A**（初回起動の直後。ただし O2 の自前の説明を必ず先に出し、OS のダイアログは利用者が説明の「許可する」を押してから出す）。
  - 理由: ai-boss は「催促されるために入れる」アプリで、許可の目的はアプリを入れた理由そのものである。最初の催促は初回起動の直後から予約されうる。自前の説明を挟めば、Apple の言う「文脈」を作れる。説明で「あとで」を選べるようにして、1 度しか出せない OS のダイアログを無駄にしない。
  - 次点は C。

### O2. 許可を求める前後の文面

- **A 自前の説明を出さず、OS のダイアログだけ**
  - 通知のダイアログには、アプリが説明文を足せない（推論）。そのため、目的を伝える手段が無い。
- **B 自前の説明（ボスの口調）→ OS のダイアログ**
  - 例の方向性: 「俺が催促しても届かなければ意味がない。通知を許可しろ」＋「許可する」「あとで」。
  - 許可の後: 「よし。サボったら通知で呼ぶ」。拒否の後は O3 へ。
- **C 自前の説明（中立の説明文）→ OS のダイアログ**
  - 例の方向性: 「ai-boss は、作業が止まったときや会議の時刻に通知で知らせます」＋「通知を許可する」「あとで」。
- **推奨: B**（アプリの世界観に揃え、許可の目的を「ボスが催促するため」として伝える）。文面そのものはオーナーが決める。
  - 「あとで」を選んだときに、いつ再び説明を出すかも決める必要がある（例: 次の起動・次の朝会）。

### O3. 拒否されたときの案内

- **案内の場所と頻度**:
  - A 案内しない
  - B ダッシュボードに常設の案内を出す。起動と前面への復帰のたびに許可の状態を確かめ、許可されたら消す
  - C B と同じだが、閉じられるようにし、1 日 1 回まで出す
  - D 設定の画面にだけ出す
- **設定アプリへの誘導**:
  - あり: `openNotificationSettingsURLString` で、このアプリの通知の設定を直接開く。ネイティブの経路（器のコマンドか、URL を開くプラグイン）が要り、WebView に開く公開面が 1 つ増える。
  - なし: 「設定 → 通知 → ai-boss」の手順を文で示すだけ。
- **拒否されたままでも、予約の登録を続けるか**:
  - X 続ける（#585 S3 の作りのまま）
    - 利点: 設定アプリで許可に戻した時点から、登録済みの予約が届く。macOS も、OS が表示に失敗しても「送信を試みた」と記録している（#579 S3 の実測）ため、扱いが揃う。
    - 欠点: 表示されていない催促も、予約時刻を過ぎれば送信履歴に確定される。そのため、利用者が見ないまま、エスカレーションの段階が進む。
  - Y 止める（拒否の間は登録しない）
    - 利点: 履歴が実際に届いたものに近づく。
    - 欠点: 計画し直しに許可の状態を渡す変更（#585 の設計の変更）が要る。
- **推奨: B ＋ 誘導あり ＋ X**。
  - 理由: 催促が届かない状態は、アプリの価値が止まった状態なので、隠さず常に見せる。戻す道を 1 タップにする。予約は続け、許可に戻した瞬間から届くようにする。
  - X の欠点（見ないまま段階が進む）は、macOS の現行と同じ性質として受け入れる。ただし、#585 S3 の手動の確認手順 7 で「拒否の間は `add` が拒否で返る」と分かった場合は、X でも予約が控えに残らない。その場合は、次の 2 点を S2 で確かめる。
    - 確定されない
    - 許可に戻した後の計画し直しで登録される

## 未決（親）

- **P1 S1 の範囲**: S1 の手動の確認に、iOS での LLM の実際の送信（BYOK か中継）を含めるか。推奨は含めない（「やらないこと」）。DB・キーチェーン・ナビゲーションの制限・証跡の保存は含めた。
- **P2 `check:ios` を必須ゲートにするか**: CLAUDE.md の品質方針の変更になる。推奨は必須ゲートに足す。
  - 理由: デスクトップの部品の変更が iOS を黙って壊すのを、開発機で止められる。
  - 費用: 初回は約 50 秒、以降は数秒。各開発機に `rustup target add` が要る。
- **P3 Android**: ADR 0011 は初回リリースに Android を含める。しかし、Android の器を受け持つ Issue が無い。#669 では扱わず、別の Issue を立てることを推奨する。

## 仮定（軽微・可逆）

- A1: 仕様のファイル名は `docs/features/ios-shell.md` とする。
- A2: デスクトップの部品の `cfg` は `desktop`（tauri-build の別名）を使う。今の `target_os = "macos"` の箇所は変えない（決定 1）。
- A3: `tauri` の `tray-icon` 機能は、共通の依存に付けたままにする（実測で、iOS 向けにも通る）。
- A4: iOS のシミュレータ向けのビルドのスクリプト名は `build:tauri:ios-sim` とする（`build:tauri`・`build:tauri:signed` に揃える）。中身は `cd native/tauri-app && npx @tauri-apps/cli ios build --target aarch64-sim --ci`。
- A5: `check:ios` は、器のライブラリだけを検査する（`--lib`）。テストと例は、ホスト（macOS）で走らせるものとして対象にしない。
- A6: iOS のアイコンは、`tauri ios init`（または `tauri icon`）が `icons/` から作るものを使う。macOS の `bundle.icon` の 4 つは変えない。
- A7: `.gitignore` の検査（`git ls-files`・`git check-ignore`）は、`scripts/*.test.mjs`（`npm test` の `test:scripts`）に置く。`gen/apple` を生成してコミットした後に成り立つ検査とする（S1 の PR の中で生成する）。
- A8: S1 の手動の確認で、iOS の `TAURI_ENV_PLATFORM` が `ios` になることを直接は見ない。#673 の配線の開始の失敗が無いこと（手順 3）で代える。予約の登録の確認は S2 で行う。
