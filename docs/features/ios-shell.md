# 製品版の iOS の器（Tauri の iOS ターゲット・macOS 専用部品の切り分け・通知の許可の体験）

> Issue #669。2026-10-02 に作成した。範囲と前提は、オーナーの決定 9（#585・2026-10-01・★）と ADR 0011 の決定 5・12・14・20 に拠る。2026-10-02 に、通知の許可の体験（O1〜O3）と Android の扱い（P3）をオーナーが決め（★）、S1 の範囲（P1）と品質ゲート（P2）・キーチェーンの失敗の扱い（P4）を親が決めた（「決定（2026-10-02）」節）。

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
- [ ] iOS のアプリは、初回起動の直後に、ボスの口調の自前の説明を出してから、OS の許可のダイアログを出す。説明では「あとで」を選べる（S2。決定 O1・O2）
- [ ] 通知が拒否されているとき、ダッシュボードに常設の案内を出し、設定アプリのこのアプリの通知の設定へ誘導する。拒否の間も予約の登録は続ける（S2。決定 O3）
- [ ] 製品版の iOS のアプリで、予約通知を通しで確かめる（起動 → 予約 → 活動 → 取り消し → 予約時刻を過ぎた予約の確定、アプリの終了中に届くこと）（S2。#585 決定 9 の「通しの確認」）

## 非機能要件

- macOS の製品版の振る舞いと、品質ゲート（`lint`・`typecheck`・`test`・`test:rust`・`test:tauri`）を退行させない。S1 から、iOS 向けのコンパイルの検査（`check:ios`）を必須ゲートに足す（決定 P2）。
- iOS のアプリが WebView に許す権限は、今の macOS の器と同じ最小の集合から始める。iOS だけに要る権限は、`platforms` を iOS（・Android）に限った capability で足す（#585 S3 と同じ型）。
- ローカル完結（開発者用の版）と、製品版の方針（ADR 0011・改訂後の ADR 0001〜0003）を守る。器は、Anthropic と中継への推論の要求のほかに外部へ送らない。この仕様は新しい外部への送信を作らない。

## 技術的な制約・方針

- Tauri 2.12・Tauri CLI 2.12.0。iOS のビルドには Xcode・`xcodegen`・cocoapods が要る（開発機の前提。手動の確認手順の「準備」）。
- **必須ゲートの `check:ios` は、開発機に `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` を要する**（決定 P2）。入っていないと `check:ios` はターゲットが無いエラーで落ちる。これは品質の失敗ではなく、開発機の準備の不足である。
- 署名・プロビジョニング・実機・App Store は範囲外（#587。ADR 0011「未決」で、実機の確認はオーナーの判断で製品化の後のフェーズ）。シミュレータ向けのビルドは開発チームの指定なしで通る（#576）。
- `docs/` は非権威。正はコードとテストである。

## クリティカル設計決定

### 1. デスクトップ専用部品の切り分け（作成者の判断・2026-10-02。親の回答で変更の指示なし）

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

### 2. Xcode のプロジェクト（`gen/apple`）をコミットする（作成者の判断・2026-10-02。親の回答で変更の指示なし）

- `tauri ios init` で `native/tauri-app/gen/apple` を作り、**リポジトリにコミットする**。`gen/schemas` は今までどおり無視する。
- ルートの `.gitignore` は、`native/tauri-app/gen/` を `native/tauri-app/gen/schemas/` に絞る。`gen/apple/.gitignore`（`tauri ios init` が作る。`xcuserdata/`・`build/`・`Externals/`）はそのまま置く。
- **理由**: `gen/apple` は次の 3 つを持つ。毎回生成し直すと、手で加えた設定が消える。
  - `Info.plist`（向き・iPad の対応・後で足す設定）
  - エンタイトルメント
  - アイコンの組
  #576 の検証コードも、`gen/apple` をコミットしている。
- **代替案**: 毎回 `tauri ios init` で作る（コミットしない）。生成物の差分を見なくて済むが、`Info.plist` の変更を残せず、開発機ごとに cocoapods の副作用を毎回受ける。
- `eslint.config.js` は `native/tauri-app/gen/**` を既に無視しているため、変えない。iOS のビルドの出力（`gen/apple/build/` に Web の資産の写しが入る）が lint を壊さないことは、手動の確認手順で確かめる。

### 3. iOS 向けのコンパイルの検査を npm のスクリプトにし、必須ゲートに足す（P2・【決定】2026-10-02・親）

- 新しいスクリプト `check:ios` を足す。器のライブラリを、`aarch64-apple-ios-sim` と `aarch64-apple-ios` の 2 つのターゲットで `cargo check` する。`quality-check-runner` が単一コマンドで呼べるよう、`npm run check:ios` 1 本にする。
- 前段の `precheck:ios` で、製品版の web（`web/dist-app/`）をビルドする。`generate_context!` が `frontendDist` を要するためで、`pretest:tauri` と同じ形にする。
- **これでデスクトップの変更が iOS を壊したことに、開発機で気づける**。Xcode でのビルド（Swift のリンク）とシミュレータでの起動は、自動の検査に入れない（シミュレータの操作が要り、数分かかる）。これらは手動の確認手順に置く。
- **`check:ios` を必須ゲートに足す**（決定 P2）。リポジトリの `CLAUDE.md` の「品質方針」の必須ゲートの記述と「よく使うコマンド」は、**S1 の実装 PR で**書き換える（この仕様の PR では変えない）。書き換えには、`rustup target add aarch64-apple-ios aarch64-apple-ios-sim` が要ることを含める。

### 4. 通知の許可の体験（O1〜O3 ★・【決定】2026-10-02・オーナー。S2）

- **時期（O1 = A）**: 初回起動の直後に求める。DB の準備の後、最初の画面の上で出す。
- **文面（O2 = B）**: 必ず自前の説明（ボスの口調）を先に出す。OS のダイアログは、利用者が説明の「許可する」を押してから出す。説明では「あとで」を選べるようにし、1 度しか出せない OS のダイアログを無駄にしない。文面そのものは、S2 の実装 PR でオーナーが確認する。
- **拒否されたとき（O3 = B ＋ 誘導あり ＋ X）**:
  - ダッシュボードに常設の案内を出す（起動と前面への復帰のたびに許可の状態を確かめ、許可されたら消す）
  - 案内から、設定アプリのこのアプリの通知の設定（`openNotificationSettingsURLString`）へ誘導する
  - 拒否の間も、予約の登録を続ける（#585 S3 の作りのまま）。表示されていない催促も、予約時刻を過ぎれば送信履歴に確定され、エスカレーションの段階が進む。これは macOS の現行（OS が表示に失敗しても「送信を試みた」と記録する）と同じ性質として受け入れる
- **S2 の設計で決めること**（決定を変えない範囲の具体）:
  - 許可の要求・状態の問い合わせの経路。`platforms` を iOS（・Android）に限った capability で `notification:allow-request-permission`・`notification:allow-permission-state` を許す形を第一候補とする（#673 の `mobile-nudges.json` の型）
  - 設定アプリへの誘導のネイティブの経路。**増える公開面を最小にし、受入基準で塞ぐ**（オーナーの指示）。例: 引数を取らず、開く先を `openNotificationSettingsURLString` に固定した器のコマンド 1 つにし、任意の URL を開ける経路（URL を開くプラグインの汎用の権限）は作らない
  - #585 S3 の手動の確認手順 7（拒否した状態での予約の `invoke` の結果）の実測と、それに応じた確かめ方（`add` が拒否で返るなら、確定されないことと、許可に戻した後の計画し直しで登録されること）
- **S2 に残す未決（★オーナー）**: 「あとで」を選んだ後に、いつ再び説明を出すか（例: 次の起動・次の前面への復帰・次の朝会）。S2 の仕様を作るときにオーナーへ問う。

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
| 通知の許可を求めないため、iOS では催促が表示されない | S2（決定 O1・O2: 初回起動の直後に説明 → OS のダイアログ） |
| 利用者が説明で「あとで」を選ぶ | S2（再び説明を出す時期は S2 の未決。OS のダイアログは消費しない） |
| 利用者が許可を拒否する | S2（決定 O3: ダッシュボードの常設の案内と設定アプリへの誘導。予約の登録は続ける） |
| 設定アプリへの誘導の経路が、任意の URL を開く道になる | S2（決定 O3: 開く先を固定した最小の経路にし、受入基準で塞ぐ） |
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
| S2 | 通知の許可の体験（決定 O1〜O3: 初回起動の直後にボスの口調の説明 → OS のダイアログ・「あとで」・拒否時はダッシュボードに常設の案内と設定アプリへの誘導・拒否中も予約を続ける。許可の要求の経路と誘導の経路は S2 の設計で最小に決める）と、製品版の iOS のアプリでの予約通知の通しの確認。通しの確認の流れは、起動 → 予約 → 活動 → 取り消し → 予約時刻を過ぎた予約の確定、アプリの終了中に届くこと。#585 S3 の手動の確認手順 1〜7 の未実施分を含む。**通知の実行系のため、PR は人間レビュー必須** | 未見積もり | S1 がマージされてから（O1〜O3 は 2026-10-02 に決定済み。「あとで」の後の再表示の時期は S2 の仕様でオーナーへ問う） |

実装対象: S1

## やらないこと

- Android のターゲット（理由: 決定 P3〔★オーナー〕で #669 の範囲外とし、#674 へ送った。決定 1 の `cfg(mobile)`・依存の表は Android にも効くが、Android のビルドの確認はしない）
- 実機での確認・署名・プロビジョニング・App Store への申請・開発チームの指定（理由: ADR 0011「未決」でオーナーが製品化の後のフェーズとした。署名と申請は #587）
- スマホ向けの画面レイアウト（理由: #586。S1 では今の画面がシミュレータに出ることだけを確かめる）
- iOS でのトレイ・多重起動の防止・Dock の再表示・閉じる要求で隠す動きの代わりの部品（理由: iOS には当たる仕組みが無い。アプリの前面・背面と単一のプロセスは OS が管理する）
- iOS での毎分の刻み（理由: iOS は予約通知方式〔#585 決定 8〕。刻みの受け手がいない）
- 証跡の新しいウィンドウを iOS で開けるようにすること（理由: S1 では記録だけを行う。直すなら、表示の方式を変える判断になるため、記録を見て別の Issue にする）
- iOS での LLM の実際の送信の確認（BYOK・中継）（理由: 決定 P1〔親〕。外部への送信で、キーか中継の資格情報が要る。通信層は、iOS 向けにコンパイルが通ること〔`check:ios`〕と、キーの保管〔手動の確認手順 5〕までを S1 で確かめる）
- 仮の許可（`.provisional`）（理由: 決定 O1〔★オーナー〕で初回起動の直後に正式の許可を求めると決めた。仮の許可は催促が音・バナー無しで通知センターに静かに届くだけで、催促の役を果たしにくい）
- 通知プラグインの上流への PR（理由: #585 決定 6。組織外への送信で、オーナーの承認を得て別に行う）

## 受入基準（S1）

検査は、ホスト（macOS）の `cargo test`・`node --test`・`npm run`・`git` で行う。シミュレータでしか見られないもの（ビルド・起動・画面・DB・キーチェーン）は「手動の確認手順（S1）」に置く（機能要件の S1 の 4 項目は、手順 1〜5 が受け持つ）。

**比較の基準点**: 「変更されない」の項目は、**#671（PR #673）をマージした後の `main`** を基準点とし、`git diff --name-only <基準点>...HEAD -- <パス>` の出力が空であることで判定する。

iOS 向けのビルド（コンパイルの検査）:

- [ ] `npm run check:ios` が合格する（器のライブラリの `cargo check`。ターゲットは `aarch64-apple-ios-sim` と `aarch64-apple-ios` の 2 つ。開発機に `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` を済ませてから走らせる）
- [ ] リポジトリの `CLAUDE.md` の「品質方針」の必須ゲートに、`check:ios` が載っている（決定 P2）
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

（`test:tauri` は上の「macOS の製品版の振る舞い」に、`check:ios` は上の「iOS 向けのビルド」に含めた。日付の境界に触らないため、`test:tz` は対象にしない。）

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
| 5 | 設定の画面で BYOK のキー（ダミーの値でよい）を保存し、アプリを終えて再び起動する | キーの状態が「登録済み」と表示される（`ByokKeySection.tsx`）。削除すると「未登録」になる（キーの値は画面に出ない）。保存が失敗したら（例: OSStatus -34018。macOS の未署名のビルドで起きる失敗）、エラーの文言と原因を PR に記録し、原因で分ける（決定 P4）。**署名・entitlement（データ保護キーチェーンの要件）に起因するなら、キーチェーンの確認を #587（署名）へ送り、S1 は出荷してよい**。**器のコード（`secure-transport`・`secure_commands`）に起因するなら、S1 の中で直す**。#576 は、iOS シミュレータで generic password の保存と読み出しを確かめている。ただし、データ保護キーチェーンの属性（`kSecUseDataProtectionKeychain`）つきの #581 の実装では、まだ確かめていない |
| 6 | 外部のリンク（例: `https://example.com`）へのナビゲーションを試みる（Web インスペクタで `location.href` を代入する） | 移動しない（`is_allowed_navigation`。iOS でもアプリのオリジンが `tauri://localhost` であることの確認） |
| 7 | 証跡ファイルを 1 つ添えて保存し、表示を試みる | 保存できることを確かめる。表示（新しいウィンドウ）は、開くか開かないかを記録する（期待値は定めない。「やらないこと」） |
| 8 | 手順 1 の後に `npm run lint` を実行し、`git status --short` を見る | lint が合格し、`gen/apple/build/` の下の出力が未追跡のファイルとして出ない |
| 9 | macOS で `npm run build:tauri` の `.app` を起動する | 既存の手動の確認（#579 S3・#659）の結果が変わらない。具体的には次の 4 つ。<br>・メニューバーのアイコンがあり、「開く」「終了」が動く<br>・ウィンドウを閉じても終わらない<br>・Dock のアイコンで再表示できる<br>・2 つ目の起動で既存のウィンドウが前面に出る |

S1 では通知の許可を求めないため、iOS で催促の通知は表示されない（S2）。#673 の iOS の配線が予約を登録していることは、手順 3 のログで、開始の失敗が無いことまでを確かめる。予約の到達は S2 の通しの確認で確かめる。

## 決定（2026-10-02）

作成時点の未決（オーナーへの問い O1〜O3・親への問い P1〜P3・キーチェーンの失敗の扱い）への回答。判断材料（Apple の文書）は「実コードの実測」の「Apple の文書で確かめたこと」に残した。

| ID | 論点 | 決定 | 決めた人 | 反映先 |
|---|---|---|---|---|
| O1 | 通知の許可を求める時期 | **A 初回起動の直後**。必ず自前の説明を先に出し、「あとで」を選べるようにする（1 度しか出せない OS のダイアログを無駄にしない）。代替案: B 最初の催促が予約される直前／C 最初の朝会かタスクの登録の後／D 設定画面で有効にしたとき／E 仮の許可 | ★オーナー | 決定 4・S2・やらないこと |
| O2 | 許可を求める前後の文面 | **B ボスの口調の説明 → OS のダイアログ**。文面そのものは S2 の実装 PR でオーナーが確認する。「あとで」の後にいつ再び説明を出すかは、S2 の仕様で決める（S2 に残す未決。オーナーへの問い）。代替案: A OS のダイアログだけ／C 中立の説明 → OS のダイアログ | ★オーナー | 決定 4・S2 |
| O3 | 拒否されたときの案内 | **ダッシュボードに常設 ＋ 設定アプリへの誘導あり ＋ 拒否中も予約の登録を続ける（X）**。誘導で増える公開面（ネイティブの経路）は S2 の設計で最小にし、受入基準で塞ぐ。代替案: 案内しない／閉じられて 1 日 1 回まで／設定画面だけ・誘導なし（文で手順を示す）・拒否の間は登録を止める（Y） | ★オーナー | 決定 4・S2・失敗の経路 |
| P1 | S1 の手動の確認に、iOS での LLM の実際の送信（BYOK・中継）を含めるか | **含めない**（外部への送信で、資格情報が要るため） | 親 | やらないこと |
| P2 | `check:ios` を必須ゲートにするか | **足す**。`CLAUDE.md` の品質ゲートの記述は S1 の実装 PR で変える。`rustup target add` が要ることを仕様・受入基準・手順に書く | 親 | 決定 3・非機能要件・技術的な制約・受入基準（S1） |
| P3 | Android | **#669 の範囲外とし、別の Issue にする**（#674 を起票した） | ★オーナー | やらないこと |
| P4 | 手動の確認手順 5（キーチェーン）が失敗したときの扱い | 原因を記録する。**署名・entitlement（データ保護キーチェーンの要件）に起因するなら #587（署名）へ送り、S1 は出荷してよい**。器のコードに起因するなら S1 の中で直す | 親 | 手動の確認手順（S1）の 5 |

## 仮定（軽微・可逆）

- A1: 仕様のファイル名は `docs/features/ios-shell.md` とする。
- A2: デスクトップの部品の `cfg` は `desktop`（tauri-build の別名）を使う。今の `target_os = "macos"` の箇所は変えない（決定 1）。
- A3: `tauri` の `tray-icon` 機能は、共通の依存に付けたままにする（実測で、iOS 向けにも通る）。
- A4: iOS のシミュレータ向けのビルドのスクリプト名は `build:tauri:ios-sim` とする（`build:tauri`・`build:tauri:signed` に揃える）。中身は `cd native/tauri-app && npx @tauri-apps/cli ios build --target aarch64-sim --ci`。
- A5: `check:ios` は、器のライブラリだけを検査する（`--lib`）。テストと例は、ホスト（macOS）で走らせるものとして対象にしない。
- A6: iOS のアイコンは、`tauri ios init`（または `tauri icon`）が `icons/` から作るものを使う。macOS の `bundle.icon` の 4 つは変えない。
- A7: `.gitignore` の検査（`git ls-files`・`git check-ignore`）は、`scripts/*.test.mjs`（`npm test` の `test:scripts`）に置く。`gen/apple` を生成してコミットした後に成り立つ検査とする（S1 の PR の中で生成する）。
- A8: S1 の手動の確認で、iOS の `TAURI_ENV_PLATFORM` が `ios` になることを直接は見ない。#673 の配線の開始の失敗が無いこと（手順 3）で代える。予約の登録の確認は S2 で行う。
