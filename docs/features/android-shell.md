# 製品版の Android の器（Tauri の Android ターゲット・#669 から分離）

> Issue #674。2026-10-04 に作成した。範囲と前提は、ADR 0011 の決定 5・12・14・19・20 と、オーナーの決定 P3（#669・2026-10-02・★。Android を #669 の範囲外とし、この Issue へ送った）に拠る。#669 S1（#676・PR #677。2026-10-04 時点で未マージ）が入れるデスクトップ専用部品の `cfg(desktop)`／`cfg(mobile)` の切り分け・`run_mobile`・`check:ios` を前提にする。**オーナーへの問い（A1・A2）と親への問い（Q1〜Q4）は未決**で、「未決」節に選択肢と推奨を書いた。決まったら同じ節を「決定」に書き換える。

## 概要

製品版（Tauri 2）の器 `native/tauri-app/` を、macOS・iOS に加えて **Android でもビルドして動かせる**ようにする。#669 S1 の `cfg(mobile)` の切り分けは Android にも効くが、Android にはそれだけでは足りない。実測で、次の 4 つが Android に固有の欠けとして見つかった（「実コードの実測」）。

- **秘密情報の保管**: 通信層（`secure-transport`）の保管の実装は Apple のキーチェーンだけで、Android 向けにはコンパイルされない（`cfg(target_vendor = "apple")`）。器の `SecureState::production()` はそれを無条件に使うため、器が Android 向けにコンパイルできない
- **TLS**: 通信層の `reqwest` の `default-tls` は、Apple 以外では OpenSSL（`openssl-sys`）に依存する。Android 向けには OpenSSL を別に用意しない限りビルドできない
- **アプリのオリジン**: Android の Tauri はアプリを `http://tauri.localhost/` で開く（macOS・iOS は `tauri://localhost`）。器のナビゲーションの許可（`is_allowed_navigation`）は `tauri://localhost` だけを許すため、Android ではアプリの画面への移動を拒否しうる
- **Gradle のプロジェクト**（`gen/android`）が無い

この仕様では、器を Android でビルド・起動し、画面・DB・秘密情報の保管が動くところまで（S1・S2）と、通知の許可の体験（S3）を扱う。**催促の予約通知の Android の実装は #585 S4 が受け持つ**（境界は「クリティカル設計決定」の 5）。

## 背景・目的

- ADR 0011 は、製品版の土台を Tauri 2 とし（決定 5）、初回リリースを macOS と iOS / Android とした（決定 19）。モバイルはデスクトップと同等の全機能とする（決定 20）。
- オーナーは 2026-10-02、Android を #669 の範囲外とし、別の Issue にすると決めた（#669 の決定 P3・★）。#669 は Android のビルドを確かめない。
- #585 S4（`docs/features/scheduled-nudges.md` のスライス表）は「Android の実装（正確な時刻の予約の権限・端末の省電力）」で、製品のアプリで確かめるにはこの Issue の器が要る。
- ADR 0002 の改訂（2026-09-26）は、製品版の BYOK のキーを端末の OS のセキュアストレージに保管し（Android は Keystore）、平文でファイルに書かないとした。`secure-transport-byok.md` は Android（Keystore）を「後続・別スライスで同じポートの実装を足す」として範囲外にした。中継のライセンストークン（`Provider::RelayLicense`）も同じ保管を使うため、**Android で保管が動かないと、BYOK も中継も使えず、LLM がまったく使えない**。
- 実機での確認は、オーナー判断で製品化の後のフェーズ（ADR 0011「未決」）。

## ユーザーストーリー

- 利用者として、Android の端末でも ai-boss を開き、Mac・iPhone と同じ画面でボスに報告・相談したい。
- 利用者として、Android でもボスの催促を通知で受け取りたい（予約通知の実装は #585 S4。許可の体験はこの仕様の S3）。
- 利用者として、通知や正確な時刻の予約の許可を求められる理由を知りたい。拒否した後でも戻せる道を知りたい。

## 実コードの実測（2026-10-04・`main` 316a464／PR #677 の head bfb766c）

### 器（`native/tauri-app/`）

| 対象 | 実測 |
|---|---|
| デスクトップ専用部品 | `main` では切り分けられていない。PR #677 が `cfg(desktop)`／`cfg(mobile)` で切り分ける（トレイ・`unminimize`・多重起動の防止・毎分の刻み）。`run` に `#[cfg_attr(mobile, tauri::mobile_entry_point)]` を付け、`run_mobile` を足す。`tauri-plugin-single-instance` を `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` へ移す。**どれも `mobile`（iOS と Android）に効く書き方である** |
| `gen/` | `main` は `schemas` だけ。PR #677 で、ルートの `.gitignore` は `native/tauri-app/gen/` の無視を `gen/schemas/` に絞る（`gen/apple` をコミットするため）。**そのため `tauri android init` が作る `gen/android` も、#677 の後は無視されず追跡の対象になる** |
| `is_allowed_navigation`（`lib.rs:216`） | `url.scheme() == "tauri" && url.host_str() == Some("localhost")` だけを許す。`WebviewWindowBuilder::on_navigation` に渡している（`lib.rs:262`） |
| 証跡の新しいウィンドウ（`ALLOWED_BLOB_URL_PREFIX`・`lib.rs:223`） | `tauri://localhost/` で始まる `blob:` だけを許す |
| `SecureState::production()`（`secure_commands.rs:120`） | `Arc::new(secure_transport::KeychainKeyStore::new())` を無条件に使う |
| `tauri.conf.json` | `identifier` は `dev.aiboss.app`。Android 向けの設定（`bundle.android`）は無い。CSP の `connect-src` は `'self'`・`ipc:`・`http://ipc.localhost` |
| capability | `default.json`（`platforms` 指定なし）と `mobile-nudges.json`（`platforms: ["iOS", "android"]`。`notification:allow-cancel`・`allow-get-pending`）。許可の要求・状態の問い合わせ（`notification:allow-request-permission`・`allow-permission-state`）は、どの capability も許していない |

### Android のアプリのオリジン（Tauri 2.12.0 のソース）

- `tauri-2.12.0/src/manager/mod.rs` のテスト（780〜802 行）は、`custom_protocol` のビルドでのアプリの URL を「`cfg!(windows) || cfg!(target_os = "android")` なら `http://tauri.localhost/`（`use_https_scheme` が真なら `https://tauri.localhost/`）、それ以外は `tauri://localhost`」と固定している。
- `tauri-utils` の `use_https_scheme` の説明: Windows と Android でカスタムプロトコルに `http://<scheme>.localhost` の代わりに `https://<scheme>.localhost` を使うか。既定は偽。**リリースの間で値を変えると、IndexedDB・cookie・localStorage の置き場所が変わり、古いデータを読めなくなる**。
- → Android では、今の `is_allowed_navigation` はアプリのオリジン（`http://tauri.localhost`）を拒否する。`on_navigation` が最初の読み込みにも呼ばれるなら、画面が出ない（**推論**。wry の Android の実装での呼ばれ方は確かめていない。S1 の手動の確認手順 2 で画面が出ることを確かめる）。証跡の `blob:` も、Android では `blob:http://tauri.localhost/…` になり、今の接頭辞に一致しない（推論）。
- CSP の `connect-src` の `ipc:`・`http://ipc.localhost` で Android の IPC が通るかは確かめていない（推論。手動の確認手順で DB の読み書きが動くことを確かめる）。

### 秘密情報を扱う通信層（`native/secure-transport/`・#581）

- 保管のポートは `KeyStore`（`key_store.rs:118`）で、`set`・`delete`・`contains`・`load` の 4 つ。`load` は封印（`Seal`）でクレートの外から呼べず、**実装もクレートの中に置く**（封印により外から実装できない）。
- 実装は `KeychainKeyStore`（`keychain.rs`）と、テスト用の `MemoryKeyStore` だけ。`keychain` のモジュールと公開は `#[cfg(target_vendor = "apple")]`（`lib.rs:10・19`）。`Cargo.toml` の `core-foundation`・`security-framework-sys` も `cfg(target_vendor = "apple")` の依存である。
- `StoreError` は `Keychain { status }`・`InvalidEncoding`・`InvalidKeyFormat` の 3 つで、「この端末では保管できない」に当たる値は無い。
- 保管するものは `Provider::Anthropic`・`OpenAi`・`RelayLicense`（中継のライセンストークン）。
- HTTP は `reqwest` 0.12（`default-features = false, features = ["default-tls"]`）。`Cargo.lock` で `native-tls` 0.2.18 が `openssl`・`openssl-sys` 0.9.117 に依存する（`vendored` の機能は付けていない）。Apple では `native-tls` は Security.framework を使い、OpenSSL を使わない。

### Android 向けのコンパイルの実測（ホスト: macOS・rustc 1.98.1・Tauri CLI 2.12.0）

| 対象 | 実測 |
|---|---|
| `rustup` のターゲット | `aarch64-apple-darwin`・`aarch64-apple-ios`・`aarch64-apple-ios-sim`・`x86_64-apple-ios`。**Android のターゲット（`aarch64-linux-android` 等）は入っていない** |
| `cargo check --manifest-path native/tauri-app/Cargo.toml --target aarch64-linux-android --lib` | `error[E0463]: can't find crate for 'core'`（`the 'aarch64-linux-android' target may not be installed`）。依存の最初のクレートで止まり、器・通信層のエラーまで進まない |
| Android SDK | `~/Library/Android/sdk` に古い SDK がある（`build-tools` 29.0.2・31.0.0、`platforms` android-30・31、`emulator` 30.8.4、`cmdline-tools` 5.0）。`PATH` にも `ANDROID_HOME` にも無い。**NDK・システムイメージ・AVD は無い**。通知プラグインの Gradle は `compileSdk = 36`・`minSdk = 24` を求め、android-36 のプラットフォームが無い |
| JDK | Zulu 15.0.3（arm64）・AdoptOpenJDK 11（x86_64）。Android Gradle Plugin 8 系が求める JDK 17 以上は無い（推論。Tauri 2 の Android のテンプレートの AGP の版は確かめていない） |
| Android Studio | `/Applications` に無い |
| CI | 無い（`.github/workflows` が無い）。品質ゲートは開発機での `npm run` の実行で判定している |

→ **このホストでは、Android 向けのビルドも `cargo check` も今は走らない**。走らせるには、少なくとも次が要る（導入はしていない）。

- `rustup target add aarch64-linux-android`（Apple Silicon のエミュレータは arm64 のイメージを使うため、まず 1 つ。x86_64 のエミュレータを使うなら `x86_64-linux-android` も）
- Android NDK（`libsqlite3-sys`〔plugin-sql の fork〕・TLS の C／アセンブリのコードを `build.rs` が NDK の clang でコンパイルする。**`cargo check` でも `build.rs` は走るため NDK が要る**）と、その場所を示す環境変数（`NDK_HOME` と、`cargo check` を直に呼ぶなら `CC_aarch64_linux_android` 等）
- Android SDK の android-36 のプラットフォーム・build-tools・platform-tools（`adb`）・emulator・arm64 のシステムイメージと AVD
- JDK 17 以上（`JAVA_HOME`）

Rust の依存と器のコードが Android 向けに通るかは、上の準備が無いため**実測できていない**。コードの読みから、少なくとも次の 2 つで落ちる見込みである（推論）: (1) `secure_commands.rs:121` の `secure_transport::KeychainKeyStore`（Android では存在しない）、(2) `openssl-sys` のビルド（Android 向けの OpenSSL が無い）。

### 通知プラグインの fork の Android 側（`native/tauri-plugin-notification/android/`・上流 2.5.0 のまま）

`FORK.md` のとおり、fork の差分は iOS の Swift だけで、Android の Kotlin は上流のままである。読んで分かったこと:

| 対象 | 実測（コード） |
|---|---|
| `AndroidManifest.xml` | `POST_NOTIFICATIONS`・`RECEIVE_BOOT_COMPLETED`・`WAKE_LOCK` を宣言する。**`SCHEDULE_EXACT_ALARM`・`USE_EXACT_ALARM` は宣言していない** |
| 許可（`NotificationPlugin.kt`） | `permissions = [Permission(strings = [POST_NOTIFICATIONS], alias = "permissionState")]`。`requestPermissions` は Android 13 未満では状態を返すだけ、13 以上では未許可なら `requestPermissionForAlias` で OS のダイアログを求める。`checkPermissions` は 13 未満では `areNotificationsEnabled()` の結果を返す |
| 予約（`show` → `TauriNotificationManager.schedule`） | 予約時刻のある通知は `AlarmManager` に登録する（`triggerScheduledNotification`）。1 回きりの予約は `setExactIfPossible` を使い、**Android 12 以上で `canScheduleExactAlarms()` が偽なら正確でない `set(RTC, …)`（`allowWhileIdle` が真なら `setAndAllowWhileIdle(RTC_WAKEUP, …)`）に落ちる**。真なら `setExact(RTC, …)`（`allowWhileIdle` が真なら `setExactAndAllowWhileIdle(RTC_WAKEUP, …)`） |
| `allowWhileIdle` | 製品版の通知の予約ポート（`web/src/app-entry/product-nudge-scheduler-port.ts:53`）は `allowWhileIdle: false` を渡す。そのため Android では、正確な時刻の権限があっても `setExact(RTC, …)`（端末を起こさない種類）になる |
| 過去の時刻 | 予約時刻が今より前なら、ログに `Scheduled time must be *after* current time` を出して `return` し、`show` は ID で**解決する**（失敗を返さない）。iOS の fork の差分 2（`add` の失敗を拒否で返す）に当たる手当ては無い |
| 予約一覧（`getPending`） | プラグインの保存領域（`NotificationStorage`。SharedPreferences）を返す。**保存領域へ書くのは `batch` だけで、`show` は書かない**（`appendNotifications` を呼ぶのは `NotificationPlugin.kt:148` の `batch` だけ）。ai-boss は `notify`（Rust の `show`）だけを使うため、**Android の `get_pending` は ai-boss の予約を返さない** |
| 端末の再起動 | `LocalNotificationRestoreReceiver` は `BOOT_COMPLETED` で保存領域の予約を登録し直す。`show` の予約は保存領域に無いため、**再起動で失われる** |
| 取り消し（`cancel`） | 予約 ID ごとに `AlarmManager.cancel` と保存領域からの削除を行い、解決する |

### Android の文書で確かめたこと（2026-10-04・developer.android.com）

- 「Notification runtime permission」:
  - Android 13 以上の端末に新しく入れたアプリは、**通知が既定で無効**。アプリは許可を求め、利用者が許可するまで通知を送れない。
  - 利用者が「許可しない」を選ぶと、アプリは通知を送れない（例外の役割を除く）。
  - 12L 以下を対象にしたアプリは、通知のチャンネルを作った後の最初の Activity の開始で OS がダイアログを出す（13 以上を対象にしたアプリは、アプリが求めたときだけ）。
  - 文書には、許可が無いときに通知を出そうとした呼び出しがどうなるか（例外か、黙って捨てられるか）は書かれていない。
- 「Request runtime permissions」: **利用者が同じ権限で「許可しない」を 2 回以上選ぶと、以後アプリが求めても OS のダイアログは出ない**（恒久的な拒否として扱う）。`shouldShowRequestPermissionRationale()` が真なら、説明の UI を出すよう勧めている。ダイアログを閉じただけ（選ばずに）が拒否の回数に数えられるかは書かれていない。
  - iOS は「初回だけダイアログを出す」（`ios-shell.md`「Apple の文書で確かめたこと」）。**Android は 1 回目の拒否の後にもう 1 回だけ求められる**点が違う。
- 「Schedule alarms」:
  - `SCHEDULE_EXACT_ALARM` は利用者が与える（設定の「アラームとリマインダー」の画面。`ACTION_REQUEST_SCHEDULE_EXACT_ALARM` の Intent で開く）。`USE_EXACT_ALARM` は自動で与えられ取り消せないが、**用途が限られ、Google Play のポリシーの対象**である。
  - **Android 13 以上を対象にしたアプリの新しいインストールには、`SCHEDULE_EXACT_ALARM` は前もって与えられない**（Android 14）。
  - Android 12 以上を対象にしたアプリは、正確なアラームを使うなら「アラームとリマインダー」の権限のどちらかを宣言する。宣言しないと `SecurityException` になる（`setExact` の呼び出し）。fork は `canScheduleExactAlarms()` が偽なら正確でない予約に落とすため、この例外は起きない（コードの読み）。
  - 正確でない `set()` は、Android 12 以上では**予約時刻から 1 時間以内**に呼ばれる（省電力の制限が無いとき）。Doze の間は、アラームは Doze を抜けるまで遅れる。`setExactAndAllowWhileIdle()` は省電力の間もほぼ正確に呼ばれる。`RTC` は端末を起こさず、`RTC_WAKEUP` は起こす。
  - `SCHEDULE_EXACT_ALARM` が取り消されると、**アプリは止められ、以後の正確なアラームはすべて取り消される**。与えられたときは `ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED` が届くので、予約し直すよう勧めている。
  - **既定では、端末の電源を切るとアラームはすべて取り消される**（`BOOT_COMPLETED` で登録し直す）。
- 「Android Keystore system」: Keystore は**暗号の鍵**を入れる仕組みで、鍵の素材はアプリのプロセスに入らず、取り出せない。**任意の秘密（API キーの文字列）をそのまま入れる API は無い**。API キーを守るには、Keystore の鍵で暗号化した値をアプリの領域に置く形になる（推論。文書は鍵の生成・取り込みだけを説明している）。

### 許可が未決定・拒否のときの予約（#669 の決定 O4 の Android 版）

#677 の手動の確認（2026-10-04・オーナーの決定 O4）で、iOS では許可が未決定の間、`UNUserNotificationCenter.add` がエラー無しで終わるのに OS が予約を保持しないと分かった。Android で同じことが起きるかを、一次情報で確かめた範囲は次のとおり。

- **予約（アラーム）は残る見込み**: fork の Android の `show` は、通知の許可を問い合わせずに `AlarmManager` へ登録する（コード）。`AlarmManager` の登録が `POST_NOTIFICATIONS` に依存するという記述は「Schedule alarms」に無い（**推論**: 登録は許可と独立で、アラームは残る）。
- **表示はされない**: 予約時刻にアラームが `TimedNotificationPublisher` を呼び、`NotificationManagerCompat.notify` で表示しようとするが、許可が無いと通知を送れない（文書）。呼び出しが例外になるか黙って捨てられるかは文書に無い（**推論**: 受け手は `BroadcastReceiver` で、結果は JS に返らないため、どちらでも ai-boss からは見えない）。
- **控えと突き合わせる手段が無い**: Android の `get_pending` は `show` の予約を返さない（コード）。iOS のように「控えの行の数と OS の予約一覧の件数」で確かめることが、**許可の有無にかかわらず**できない。#585 S3 の切り詰めの検出（`countPending`）は Android では毎回食い違いをログに出す（推論。控えの行が 1 以上なら、`get_pending` の 0 と食い違う）。
- **#585 決定 2 の穴**: Android でも、許可が無い間の予約は「OS に登録されたが届かない」。iOS（OS が予約を保持しない）とは形が違うが、控えにあって届かない行が、予約時刻を過ぎると送信履歴に確定される点は同じである。さらに Android では、過去の時刻の予約も `show` が成功を返す（コード）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- [ ] 製品版の器を、Android のエミュレータ向けにビルドできる（S1）
- [ ] Android のアプリを起動すると、製品版の画面（ダッシュボード）が出る（S1）
- [ ] Android のアプリで、DB（plugin-sql の fork）が開き、データがアプリの再起動の後も残る（S1）
- [ ] Android のアプリは、アプリのオリジン（`http://tauri.localhost`）の外へのナビゲーションを拒否する（S1）
- [ ] Android のアプリで、BYOK のキーと中継のライセンストークンを Android Keystore で守って保存・削除でき、保存の有無を表示できる（**スライスは未決 A2**。推論の推奨は S2）
- [ ] macOS の製品版と iOS の器の振る舞い（ビルド・検査・ナビゲーションの許可・保管）は変わらない（S1・S2）
- [ ] Android のアプリは、通知の許可（`POST_NOTIFICATIONS`）を、決めた体験で求める。拒否されたときに案内する（S3。**体験は未決 A1**）
- [ ] 製品版の Android のアプリで、予約通知を通しで確かめる（S3。#585 S4 の後）

## 非機能要件

- macOS の製品版の振る舞いと品質ゲート（`lint`・`typecheck`・`test`・`test:rust`・`test:tauri`・`check:ios`）を退行させない。
- Android のアプリが WebView に許す権限は、今の器（macOS・iOS）と同じ最小の集合から始める。Android だけに要る権限は、`platforms` を Android に限った capability で足す（#585 S3 の `mobile-nudges.json` と同じ型）。
- ローカル完結（開発者用の版）と、製品版の方針（ADR 0011・改訂後の ADR 0001〜0003）を守る。器は、Anthropic と中継への推論の要求のほかに外部へ送らない。この仕様は新しい外部への送信を作らない。BYOK のキーは平文でファイルに書かない（ADR 0002 の改訂の決定 2）。

## 技術的な制約・方針

- Tauri 2.12・Tauri CLI 2.12.0。Android のビルドには、Android SDK（android-36）・NDK・JDK 17 以上が要る。エミュレータでの確認には、arm64 のシステムイメージと AVD が要る（「実コードの実測」）。**開発機への導入はオーナーが行う**（この仕様の作成では導入していない）。
- Android の Rust のターゲットは `aarch64-linux-android`（Apple Silicon のエミュレータと、今の Android の実機の大半）を基本にする。
- 実機・配布用の署名（アップロード鍵・Play App Signing）・Google Play への申請は範囲外（#587。ADR 0011「未決」で、実機の確認は製品化の後のフェーズ）。エミュレータ向けのデバッグのビルドは、Gradle が作るデバッグ用の鍵で署名される（推論）。
- `docs/` は非権威。正はコードとテストである。

## クリティカル設計決定

### 1. #669 の切り分けを Android にそのまま使い、Android に固有の分岐は `target_os = "android"` に付ける（作成者の提案・2026-10-04）

- **#669 S1 の `cfg(desktop)`／`cfg(mobile)` はそのまま使う**。トレイ・多重起動の防止・毎分の刻み・`unminimize` は、Android でも組まない（Android も、アプリの前面・背面とプロセスは OS が管理する）。`run_mobile` は Android の入口でもある（`mobile_entry_point` は Android では JNI の入口を生成する）。
- **Android に固有の分岐**（アプリのオリジン・保管の実装・TLS）は `cfg(target_os = "android")` に付ける。`mobile` に付けない（iOS の振る舞いを変えないため）。
- **純粋関数は切り分けない**: ナビゲーションの判定は、オリジン（`tauri://localhost` か `http://tauri.localhost` か）を引数に取る純粋関数にし、どちらのオリジンの判定もホスト（macOS）の単体テストで確かめる。`cfg` は、どのオリジンを渡すかを選ぶ薄い部分だけに付ける。

### 2. Android のアプリのオリジンを、Android でだけ許す（作成者の提案・2026-10-04。**親への問い Q4**）

- Android では、ナビゲーションの許可を `http://tauri.localhost`（スキーム `http`・ホスト `tauri.localhost`・ポート無し）に限る。`https://tauri.localhost`・`http://tauri.localhost.evil.example`・`http://tauri.localhost:8080`・`http://localhost`・`tauri://localhost` は拒否する。
- 証跡の新しいウィンドウの接頭辞も、Android では `http://tauri.localhost/` にする（`blob:http://tauri.localhost/<uuid>` だけを許す）。
- macOS・iOS は `tauri://localhost` のまま変えない。
- `use_https_scheme` は既定（偽）のまま変えない。理由: リリースの後に変えると WebView のデータの置き場所が変わる（`tauri-utils` の説明）ため、最初から決めておく必要があり、`http` のままで ai-boss の WebView は外部へ `http` で接続しない（CSP の `connect-src` は `'self'` と IPC だけ）ので、`https` にする利点が無い。
- **代替案**: (a) `use_https_scheme` を真にして `https://tauri.localhost` を許す（利点が無く、後で戻すとデータが読めなくなる）／(b) Android でもオリジンを問わず許す（ナビゲーションの境界を失う）。

### 3. Android 向けのコンパイルの検査 `check:android`（作成者の提案・2026-10-04。必須ゲートに足すかは**親への問い Q2**）

- 新しいスクリプト `check:android` を足す。器のライブラリを `aarch64-linux-android` で `cargo check` する。前段の `precheck:android` で製品版の web（`web/dist-app/`）をビルドする（`precheck:ios` と同じ形）。
- `cargo check` でも `build.rs` が NDK の clang で C のコードをコンパイルするため、NDK の場所から `CC_aarch64_linux_android`・`AR_aarch64_linux_android`・`CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` を組んで `cargo` を呼ぶ Node のスクリプト（`scripts/check-android.mjs`）にする。`quality-check-runner` が単一のコマンドで呼べるよう、`npm run check:android` 1 本にする。NDK が見つからないときは、その旨（`NDK_HOME` を設定する）を出して 0 以外で終わる。
- Gradle でのビルド（`tauri android build`。Kotlin のプラグインのコンパイルと APK の作成）とエミュレータでの起動は、自動の検査に入れない（数分かかり、エミュレータの操作が要る）。手動の確認手順に置く。

### 4. Gradle のプロジェクト（`gen/android`）をコミットする（作成者の提案・2026-10-04。#669 決定 2 と同じ型）

- `tauri android init` で `native/tauri-app/gen/android` を作り、コミットする（毎回作り直すと、`AndroidManifest.xml`・`build.gradle.kts` に手で加えた設定が消える）。
- #677 の後のルートの `.gitignore` は `gen/schemas/` だけを無視するため、`gen/android` は追跡の対象になる。**開発機に固有のファイル（`local.properties`。SDK の場所を書く）・ビルドの出力（`build/`・`.gradle/`）・署名の鍵（`*.jks`・`*.keystore`）は無視する**。`tauri android init` が作る `gen/android/.gitignore` で足りなければ、ルートの `.gitignore` に足す。
- `eslint.config.js` は `native/tauri-app/gen/**` を既に無視している。

### 5. #585 S4 との境界（作成者の提案・2026-10-04。**親への問い Q1**）

| 受け持つもの | この Issue（#674） | #585 S4 |
|---|---|---|
| 器のビルド・起動・オリジン・DB・TLS・`gen/android`・`check:android` | ○（S1） | |
| 秘密情報の保管（Android Keystore） | ○（S1 か S2。未決 A2） | |
| 製品版のエントリのプラットフォームの判定を `android` へ広げる（`selectProductNudgeReplanning`） | | ○ |
| 通知プラグインの fork の Android の差分（`show` の予約を `get_pending` と再起動の復元に載せる・過去の時刻を拒否で返す） | | ○ |
| 正確な時刻の予約の権限（`SCHEDULE_EXACT_ALARM` の宣言・`canScheduleExactAlarms` の扱い）と、省電力（`allowWhileIdle`・`RTC_WAKEUP`） | | ○（スライス表の定義どおり） |
| 通知の許可（`POST_NOTIFICATIONS`）の体験と、正確な時刻の予約の権限を利用者に求める画面 | ○（S3。体験は未決 A1） | |
| 製品版の Android のアプリでの予約通知の通しの確認 | ○（S3。#585 S4 の後） | |

- **理由**: #585 S4 の定義（「Android の実装〔正確な時刻の予約の権限・端末の省電力〕」）は予約の仕組みの話で、許可を求める画面（体験）は #669 と同じく器の側で決める（#585 決定 9 の S3-Q2 と同じ切り方）。プラットフォームの判定を広げるのは、Android の予約の仕組みが正しく動く（fork の差分が入る）のと同時でないと、予約が `get_pending` にも再起動の復元にも載らない状態で催促を出すことになるため、S4 に置く。
- **S1・S2 の Android の催促**: プラットフォームの判定は `ios` のときだけ予約方式を組む（`start-product-nudge-replanning.ts:25`）ため、S1・S2 の Android のアプリはデスクトップの経路（毎分の検知の購読）に入る。毎分の刻みは `cfg(desktop)` だけで送る（#677）ため、**Android では検知が一度も走らず、催促は出ない**。S1・S2 はこれを受け入れ、#585 S4 で解く（「やらないこと」）。

### 6. Android の TLS（作成者の提案・2026-10-04。**親への問い Q3**。API キーの取り扱い＝クリティカル箇所）

- Android でだけ、`reqwest` の TLS を `rustls`（ルート証明書は `webpki-roots`）にする。Apple（macOS・iOS）は今の `default-tls`（Security.framework）のまま変えない。
- `secure-transport/Cargo.toml` の `reqwest` の機能を、ターゲットごとの依存の表で分ける（`[target.'cfg(target_os = "android")'.dependencies]` で `rustls-tls` を足す）。Cargo の resolver 2（edition 2021 の既定）は、ビルドしないターゲットの依存の表の機能を有効にしないため、macOS・iOS のビルドに `rustls` は入らない（推論。S1 の受入基準で `cargo tree` により確かめる）。
- **代替案**: (a) `native-tls` の `vendored`（Android 向けに OpenSSL をソースからビルドする。NDK に加えて perl 等が要り、ビルドが重い）／(b) `rustls` ＋ `rustls-platform-verifier`（端末の証明書ストアを使えるが、Android では Kotlin の部品の組み込みが要る）。

### 7. 秘密情報の保管（**オーナーへの問い A2**。「未決」節）

- 決まるまで、仕様は推奨（B: 保管の実装を S2 に分け、S1 の Android は保管の操作を明示的な失敗で返す）で書いておく。A を選んだ場合は、S2 の範囲を S1 へ移す。
- どちらでも、保管の実装は `secure-transport` のクレートの中に置く（`KeyStore` の封印により、外に置けない）。Android Keystore の鍵（AES-GCM・取り出し不可）で値を暗号化し、暗号文をアプリの専用の領域に置く形を第一候補とする（ADR 0002 の改訂の決定 2「平文でファイルに書かない」を満たす）。Keystore の Java の API を Rust から JNI で呼ぶか、器の Kotlin のプラグインを通すかは S2 の設計で決める（後者は `secure-transport` が Tauri 非依存であることと、封印との整合を取る必要がある）。

### 8. 通知の許可の体験（**オーナーへの問い A1**。S3）

- 決まるまで、S3 の範囲は「許可の体験を作る」までとし、体験の中身は書かない。判断材料は「未決」節。

## 機能全体の設計

### 失敗の経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| Android 向けのビルドが、Apple だけの保管（`KeychainKeyStore`）の使用で落ちる | 決定 7 で Android の保管（S1 は明示的に失敗する保管・S2 で Keystore）を `cfg(target_os = "android")` で選ぶ。`npm run check:android` の合格を受入基準にする（S1） |
| Android 向けのビルドが、OpenSSL（`openssl-sys`）で落ちる | 決定 6 で Android だけ `rustls` にする。`check:android` の合格（S1）と、macOS・iOS の依存の木に `rustls` が入らないことを受入基準にする（S1） |
| デスクトップ専用部品の取り込み漏れ（Android でトレイ・多重起動の防止・刻みを組もうとする） | #677 の `cfg(desktop)`／`cfg(mobile)` で塞がっている。`check:android` の合格で確かめる（S1） |
| Android 固有の分岐が iOS・macOS に漏れる（`mobile` に付けてしまう） | 決定 1。`check:ios`・`test:tauri`・`build:tauri` の合格と、iOS・macOS の判定の単体テストを変えないことを受入基準にする（S1） |
| Android でアプリのオリジン（`http://tauri.localhost`）への移動が拒否され、画面が出ない | 決定 2。判定の単体テスト（ホスト）と、手動の確認手順 2（画面が出る） |
| Android のオリジンの許可が広すぎる（`https`・別のホスト・ポートつき・接頭辞の似た URL を許す） | 決定 2。単体テストで拒否を確かめる（S1） |
| Android の判定が macOS・iOS で使われる（`tauri://localhost` 以外を macOS で許してしまう） | 既存の判定の単体テストを変えずに合格させ、macOS のオリジンで `http://tauri.localhost` を拒否する単体テストを足す（S1） |
| `gen/android` に開発機に固有のファイル（`local.properties`）・署名の鍵・ビルドの出力が入る | 決定 4。`git check-ignore` の検査を受入基準にする（S1） |
| `gen/android` の applicationId が `tauri.conf.json` の `identifier` と食い違う（データの置き場所が別のアプリ扱いになる） | 設定の検査で一致を確かめる（S1） |
| Android で DB の準備が失敗する（保存先・preload） | web の起動は、DB の失敗を記録して「DB 未接続」で描画を続ける（既存。#580 S2）。開けることはエミュレータで確かめる（手動の確認手順 3・4。S1） |
| Android の WebView で IPC・CSP が通らない（画面は出るが DB・コマンドが失敗する） | 自動では確かめられない。エミュレータで DB の読み書きを確かめる（手動の確認手順 3・4。S1） |
| Android で通知プラグインの初期化が失敗する | 器の組み立ての失敗は起動の `panic` になる。エミュレータで起動して画面が出ることを確かめる（手動の確認手順 2。S1） |
| Android で秘密情報の保管が動かない（Keystore の鍵の生成・暗号化の失敗） | S1（推奨 B）は、保管の操作を明示的な失敗で返し、画面に失敗を出す（黙って成功しない）。S2 で Keystore の実装と、エミュレータでの保存・再起動後の「登録済み」・削除を確かめる |
| Android の保管が、キーを平文でファイルに書く | S2。暗号文だけを書くことを、ホストで確かめられる単位（暗号化の前後の値の比較）と、エミュレータでのアプリの領域の中身の確認で塞ぐ（S2 の仕様で受入基準にする） |
| Android で検知が一度も走らない（刻みはデスクトップだけ、予約方式は `ios` だけ） | S1・S2 は受け入れる（決定 5・「やらないこと」）。#585 S4 で解く |
| 通知の許可が未決定・拒否のまま予約される（アラームは残るが表示されない。`get_pending` で確かめられない） | #585 S4（予約の仕組み）と S3（許可の体験）。「許可が未決定・拒否のときの予約」節 |
| 正確な時刻の予約の権限が無い（新しいインストールの既定）。予約が最大 1 時間遅れる | #585 S4（権限の宣言と扱い）と S3（利用者に求める画面。体験は未決 A1） |
| 端末の省電力（Doze）で予約が遅れる（`allowWhileIdle: false`・`RTC`） | #585 S4（スライス表の「端末の省電力」） |
| 端末の再起動で予約が失われる（`show` の予約は復元されない） | #585 S4（fork の Android の差分）。起動・前面への復帰で計画し直すため、アプリを開けば戻る |
| 開発機に NDK・SDK が無く、`check:android` が落ちる | 品質の失敗ではなく準備の不足。スクリプトが不足を示して終わる（決定 3）。必須ゲートにするかは親への問い Q2 |

### 実装計画（S1 のチケット分解の見通し）

S1 は 1 チケットで足りる見込み（触るファイルは 8〜12。`gen/android` の生成物を除く）。

1. ナビゲーションの判定と証跡の接頭辞のオリジンの引数化（`lib.rs`）と単体テスト（決定 2）
2. Android の保管（S1 は明示的に失敗する実装）と `SecureState::production()` の選択（`secure-transport`・`secure_commands.rs`。決定 7）
3. Android の TLS（`secure-transport/Cargo.toml`。決定 6）
4. `tauri android init` による `gen/android` の生成と `.gitignore`（決定 4）
5. `check:android`・`precheck:android`・`scripts/check-android.mjs`・`build:tauri:android-emu`（決定 3）
6. 設定の検査（`tests/config_checks.rs`）と `.gitignore` の検査（`scripts/*.test.mjs`）

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | Android の器のビルド。<br>・アプリのオリジンの許可（決定 2）<br>・Android の TLS（決定 6）<br>・Android の保管の選択（推奨 B では、明示的に失敗する保管。決定 7）<br>・`gen/android` のコミット（決定 4）<br>・`check:android`（決定 3）<br>エミュレータで起動して画面が出ること、DB が動きデータが再起動の後も残ること、外部へのナビゲーションが拒否されることを、手動の確認手順で確かめる。macOS の製品版と iOS の器の振る舞いは変えない。**催促は出ない**（決定 5）。**通知の許可は求めない**（S3） | 8-12（`gen/android` の生成物を除く） | **#677（#669 S1）がマージされてから**（`cfg(desktop)`／`cfg(mobile)`・`run_mobile`・`.gitignore` の `gen/schemas/` への絞り込みの上に作る）。**開発機に Android の SDK・NDK・JDK 17 以上・エミュレータが入ってから**（オーナーが導入する）。未決 A2・Q1〜Q4 が決まってから |
| S2 | Android Keystore による秘密情報の保管（BYOK のキー・中継のライセンストークン）。**API キーの取り扱いのため、PR は人間レビュー必須**（未決 A2 で A を選んだら S1 に入れる） | 未見積もり | S1 がマージされてから |
| S3 | 通知の許可（`POST_NOTIFICATIONS`）の体験と、正確な時刻の予約の権限を求める画面（体験は未決 A1）と、製品版の Android のアプリでの予約通知の通しの確認。**通知の実行系のため、PR は人間レビュー必須** | 未見積もり | S2 と #585 S4 がマージされてから。体験を iOS に揃えるなら #669 S2 の後 |

実装対象: S1

## やらないこと

- 催促の予約通知の Android の実装（プラットフォームの判定を `android` へ広げる・fork の Android の差分・正確な時刻の予約の権限・省電力）（理由: #585 S4 の範囲。決定 5。S1・S2 の Android では検知が走らず催促は出ないことを受け入れる）
- 実機での確認・実機と配布用の署名・Google Play への申請（理由: ADR 0011「未決」でオーナーが製品化の後のフェーズとした。署名と申請は #587）
- スマホ向けの画面レイアウト（理由: #586。S1 では今の画面がエミュレータに出ることだけを確かめる）
- Android でのトレイ・多重起動の防止・閉じる要求で隠す動き・毎分の刻みの代わりの部品（理由: #669 決定 1 と同じ。Android もアプリの前面・背面とプロセスは OS が管理する）
- x86_64 の Android（エミュレータ・端末）向けのビルドの検査（理由: Apple Silicon の開発機のエミュレータは arm64 を使う。x86_64 の端末の扱いは配布の判断〔#587〕で決める。仮定 A3）
- Android での LLM の実際の送信の確認（BYOK・中継）（理由: #669 の決定 P1 と同じ。外部への送信で、資格情報が要る。S1 は通信層が Android 向けにコンパイルできること〔`check:android`〕まで）
- 証跡の新しいウィンドウを Android で開けるようにすること（理由: #669 と同じく、S1 では結果を記録するだけにする。直すなら表示の方式を変える判断になる）
- 通知プラグインの上流への PR（理由: #585 決定 6。組織外への送信で、オーナーの承認を得て別に行う）

## 受入基準（S1）

> 推奨の回答（A2 = B・Q1〜Q4 は推奨どおり）を前提に書いた。回答が違えば書き直す。

検査は、ホスト（macOS）の `cargo test`・`cargo tree`・`node --test`・`npm run`・`git` で行う。エミュレータでしか見られないもの（ビルド・起動・画面・DB・ナビゲーション）は「手動の確認手順（S1）」に置く（機能要件の S1 の Android の項目は、手順 1〜6 が受け持つ）。

**比較の基準点**: 「変更されない」の項目は、**#677 をマージした後の `main`** を基準点とし、`git diff --name-only <基準点>...HEAD -- <パス>` の出力が空であることで判定する。

Android 向けのビルド（コンパイルの検査）:

- [ ] `npm run check:android` が合格する（器のライブラリの `cargo check`。ターゲットは `aarch64-linux-android`。開発機に NDK と `rustup target add aarch64-linux-android` を済ませてから走らせる）
- [ ] NDK の場所が分からないとき、`npm run check:android` は 0 以外で終わり、`NDK_HOME` を含む案内を標準エラーに出す（`scripts/check-android.mjs` の単体テストで、NDK の場所の解決を純粋関数として確かめる）

アプリのオリジン（`lib.rs` の単体テスト・ホスト）:

- [ ] Android のオリジンの判定は、`http://tauri.localhost/` と `http://tauri.localhost/index.html` を許す
- [ ] Android のオリジンの判定は、`https://tauri.localhost/` を拒否する
- [ ] Android のオリジンの判定は、`http://tauri.localhost.evil.example/` を拒否する
- [ ] Android のオリジンの判定は、`http://tauri.localhost:8080/` を拒否する
- [ ] Android のオリジンの判定は、`http://localhost/` と `tauri://localhost` を拒否する
- [ ] macOS・iOS のオリジンの判定は、`http://tauri.localhost/` を拒否する
- [ ] Android のオリジンの新しいウィンドウの判定は、`blob:http://tauri.localhost/<uuid>` を許し、`blob:tauri://localhost/<uuid>`・`blob:http://tauri.localhost.evil.example/<uuid>` を拒否する
- [ ] Android で器が判定に渡すオリジンは `http://tauri.localhost` である（`cfg(target_os = "android")` の分岐。`check:android` でコンパイルし、選ぶ関数の単体テストで値を確かめる）

秘密情報の保管（S1 は明示的に失敗する保管。推奨 B）:

- [ ] Android の保管の `set`・`delete`・`contains` は、いずれも「この端末では保管できない」ことを示す失敗を返す（`secure-transport` の単体テスト。ホストでその実装を組んで確かめる）
- [ ] Android の保管の失敗は、器のコマンドのエラーとして WebView へ返る（`secure_commands.rs` の単体テストで、その失敗が対応するエラーの種類に写ることを確かめる）

TLS（`cargo tree`）:

- [ ] `cargo tree --manifest-path native/secure-transport/Cargo.toml --target aarch64-linux-android -i openssl-sys` が、`openssl-sys` が依存の木に無いことを示して終わる
- [ ] `cargo tree --manifest-path native/tauri-app/Cargo.toml --target aarch64-apple-darwin -i rustls` が、`rustls` が依存の木に無いことを示して終わる（macOS の TLS を変えない）
- [ ] `cargo tree --manifest-path native/tauri-app/Cargo.toml --target aarch64-apple-ios -i rustls` が、`rustls` が依存の木に無いことを示して終わる（iOS の TLS を変えない）

`gen/android`（設定の検査・`.gitignore` の検査）:

- [ ] `git ls-files native/tauri-app/gen/android/app/build.gradle.kts` が 1 行を返す（生成したプロジェクトがコミットされている）
- [ ] `native/tauri-app/gen/android/app/build.gradle.kts` の `applicationId` は、`tauri.conf.json` の `identifier`（`dev.aiboss.app`）と一致する
- [ ] `native/tauri-app/gen/android/local.properties` は、`git check-ignore` で無視される
- [ ] `native/tauri-app/gen/android/app/build/` の下のパスは、`git check-ignore` で無視される
- [ ] `native/tauri-app/gen/android/.gradle/` の下のパスは、`git check-ignore` で無視される
- [ ] `native/tauri-app/gen/android/` の下の `*.jks`・`*.keystore` のパスは、`git check-ignore` で無視される
- [ ] `git ls-files native/tauri-app/gen/android` の出力に、`local.properties`・`*.jks`・`*.keystore` が無い

macOS の製品版と iOS の器の振る舞いが変わらないこと:

- [ ] `npm run test:tauri` が合格する
- [ ] `npm run check:ios` が合格する
- [ ] `npm run build:tauri` が成功する
- [ ] `npm run build:tauri` の後に、`npm run verify:tauri-bundle` が合格する
- [ ] 基準点の `cargo test --manifest-path native/tauri-app/Cargo.toml -- --list` に出るテストの名前は、すべて変更後の同じ一覧にも出る（既存のテストを削除も改名もしない）
- [ ] 基準点の `cargo test --manifest-path native/secure-transport/Cargo.toml -- --list` に出るテストの名前は、すべて変更後の同じ一覧にも出る
- [ ] `native/tauri-app/tests/desktop_shell.rs` は変更されない（基準点との差分が空）
- [ ] `native/tauri-app/gen/apple/` は変更されない（基準点との差分が空）
- [ ] `native/tauri-app/capabilities/` は変更されない（基準点との差分が空）
- [ ] `native/secure-transport/src/keychain.rs` は変更されない（基準点との差分が空）
- [ ] `native/tauri-plugin-notification/` は変更されない（基準点との差分が空。fork の Android の差分は #585 S4）

範囲:

- [ ] `server/src/` は変更されない（基準点との差分が空）
- [ ] `web/src/` は変更されない（基準点との差分が空。プラットフォームの判定を広げるのは #585 S4）

品質ゲート:

- [ ] `npm run lint` が合格する
- [ ] `npm run typecheck` が合格する
- [ ] `npm test` が合格する
- [ ] `npm run test:rust` が合格する

（`test:tauri`・`check:ios` は上の「macOS の製品版と iOS の器」に、`check:android` は上の「Android 向けのビルド」に含めた。日付の境界に触らないため、`test:tz` は対象にしない。）

## 手動の確認手順（S1）

**準備**（開発機。オーナーが導入する）:

- Android SDK（android-36 のプラットフォーム・build-tools・platform-tools・emulator・arm64 のシステムイメージ）と NDK。`ANDROID_HOME`・`NDK_HOME` を設定する
- JDK 17 以上（`JAVA_HOME`）
- `rustup target add aarch64-linux-android`
- AVD を 1 つ作り（例: Pixel 系・Android 16・arm64）、起動しておく（`emulator -avd <名前>`）

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | `npm run build:tauri:android-emu` を実行する（`tauri android build --debug --target aarch64 --apk`） | ビルドが成功し、`gen/android/app/build/outputs/apk/` の下に APK ができる |
| 2 | `adb install -r <APK>` の後、`adb shell monkey -p dev.aiboss.app 1` で起動する | 製品版のダッシュボードが表示される（`adb exec-out screencap -p > <ファイル>` で画面を残し、PR に貼る） |
| 3 | Chrome の `chrome://inspect/#devices` で WebView のコンソールを開き、`location.origin` を実行する。続けて `await window.__TAURI_INTERNALS__.invoke("plugin:sql\|select", { db: "sqlite:ai-boss.db", query: "SELECT COUNT(*) AS n FROM tasks", values: [] })` を実行する | `location.origin` が `http://tauri.localhost` である。`select` が `n` を持つ行を 1 つ返す（DB が開き、IPC が通る） |
| 4 | タスクを 1 件作り、`adb shell am force-stop dev.aiboss.app` でアプリを終えて、再び起動する | 作ったタスクが残っている |
| 5 | コンソールで `location.href = "https://example.com"` を実行する | 移動しない（`location.origin` が `http://tauri.localhost` のまま。画面がダッシュボードのまま） |
| 6 | 設定の画面で BYOK のキー（ダミーの値でよい）を保存する | 保存の失敗が画面に表示される（S1 は保管を S2 で作るため。推奨 B）。キーの状態は「未登録」のまま |
| 7 | 証跡ファイルを 1 つ添えて保存し、表示を試みる | 保存できることを確かめる。表示（新しいウィンドウ）は、開くか開かないかを記録する（期待値は定めない。「やらないこと」） |
| 8 | 手順 3 のコンソールで `await window.__TAURI_INTERNALS__.invoke("plugin:sql\|select", { db: "sqlite:ai-boss.db", query: "SELECT COUNT(*) AS n FROM nudge_reservations", values: [] })` を実行する | 結果を記録する（S1 の Android は予約方式に入らないため、`n` は 0 の見込み。決定 5。合否の条件にはしない） |
| 9 | 手順 1 の後に `npm run lint` を実行し、`git status --short` を見る | lint が合格し、`gen/android` のビルドの出力・`local.properties` が未追跡のファイルとして出ない |
| 10 | macOS で `npm run build:tauri` の `.app` を起動する | 既存の手動の確認（#579 S3・#659）の結果が変わらない（メニューバーのアイコンの「開く」「終了」・閉じても終わらない・Dock での再表示・2 つ目の起動で既存のウィンドウが前面に出る） |
| 11 | iOS シミュレータで `npm run build:tauri:ios-sim` の `.app` を起動する（`ios-shell.md` の手動の確認手順 1・2） | 製品版のダッシュボードが表示される（iOS の器を壊していない） |

## 未決（2026-10-04 時点）

### オーナーへの問い

#### A1. 通知の許可（`POST_NOTIFICATIONS`）の体験を、iOS（#669 の O1〜O3）に揃えるか（S3）

iOS の決定: 初回起動の直後に、ボスの口調の自前の説明 →「許可する」で OS のダイアログ（「あとで」を選べる）。拒否されたら、ダッシュボードに常設の案内と設定アプリへの誘導。拒否の間も予約を続ける（O3。2026-10-04 の O4 で見直しの論点が S2 に残っている）。

判断材料（Android に固有の差。「Android の文書で確かめたこと」）:

- **ダイアログを出せる回数**: iOS は初回だけ。Android は「許可しない」が 2 回で恒久的な拒否になる（1 回目の拒否の後に、もう 1 回だけ求められる）。2 回目の前に `shouldShowRequestPermissionRationale()` が真になり、説明を出すよう勧められている。
- **もう 1 つの許可がある**: 予約を時刻どおりに届けるには、正確な時刻の予約の権限（`SCHEDULE_EXACT_ALARM`）が別に要る。これは**実行時のダイアログではなく、設定の「アラームとリマインダー」の画面**で利用者が与える。Android 14 以上の新しいインストールでは与えられていない。無いと、予約は**最大 1 時間遅れる**（Android 12 以上の `set()`）。`USE_EXACT_ALARM`（自動で与えられる）は用途が限られ、Google Play のポリシーの対象で、ai-boss が当たるかは確かめていない（推論: 目覚まし時計・カレンダーの類に当たらない見込み）。
- **拒否の間の予約**: Android ではアラームは残り、表示だけされない（推論）。iOS の O4（OS が予約を保持しない）と違い、許可に戻せば次の予約時刻から届く見込みである（推論）。
- **12L 以下を対象にしたアプリ**は、OS が勝手に起動時にダイアログを出す。Tauri 2 の Android のテンプレートが対象にする版（`targetSdk`）は確かめていない（推論: 13 以上）。

選択肢:

- **A（推奨）**: iOS に揃える（初回起動の直後・ボスの口調の説明・「あとで」・拒否時は常設の案内と設定アプリへの誘導・拒否中も予約を続ける）。**加えて**、Android では通知の許可の直後に、同じ口調で正確な時刻の予約の権限を説明し、「アラームとリマインダー」の設定画面へ誘導する。権限が無い間は、ダッシュボードの常設の案内に「催促が最大 1 時間遅れる」ことを出す。2 回目の拒否で恒久的な拒否になる前に、説明を必ず挟む。
  - 理由: 体験を端末で揃えられ（ADR 0011 決定 20 の「同等の全機能」）、S2 の文面の確認も 1 回で済む。正確な時刻の権限が無いと、催促が「黙って遅れる」ため、案内が要る。
- B: iOS に揃えるが、正確な時刻の予約の権限は求めない（予約は最大 1 時間遅れることを受け入れる）。
- C: Android は別の体験にする（例: 最初の催促が予約される直前に求める・設定画面で有効にしたときだけ求める）。

#### A2. 秘密情報（BYOK のキー・中継のライセンストークン）の保管を、どのスライスで作るか

判断材料:

- ADR 0002 の改訂は、Android の保管先を Keystore とし、キーを平文でファイルに書かないとした。Keystore は**鍵だけ**を入れる仕組みで、API キーの文字列はそのまま入らない。Keystore の鍵（取り出し不可）で暗号化し、暗号文をアプリの領域に置く実装になる（推論）。Apple のキーチェーン（値をそのまま入れられる）より実装が大きい。
- 実装は `secure-transport` のクレートの中に置く必要がある（`KeyStore` の封印。実測）。Rust から Keystore の Java の API を JNI で呼ぶ実装か、器の Kotlin のプラグインを通す実装になる。後者は、クレートが Tauri 非依存であることと封印に手を入れる。
- 中継のライセンストークンも同じ保管を使う（`Provider::RelayLicense`）。**保管が無い間、Android では BYOK も中継も使えず、LLM がまったく使えない**。
- 器の `SecureState::production()` は Apple の保管を無条件に使うため、**何らかの Android の保管を選ばないと、器が Android 向けにコンパイルできない**（S1 の時点で手当てが要る）。
- iOS（#669 P4）では、キーチェーンを S1 の必須の機能にした。iOS のキーチェーンは追加のコード無しで動く見込みだった（同じ実装）のに対し、Android は新しい暗号のコードを書く。
- API キーの取り扱いはクリティカル箇所（PR は人間レビュー必須）。

選択肢:

- A: S1 に含める（S1 で Android が全機能に近づく。S1 の PR が大きくなり、器のビルドとクリティカル箇所のレビューが 1 本に混ざる）
- **B（推奨）**: S2 に分ける。S1 の Android は、保管の操作を「この端末では保管できない」という明示的な失敗で返す実装を選ぶ（画面に失敗が出る。黙って成功しない）。S2 で Keystore の実装を作る
  - 理由: S1 の器のビルド（オリジン・TLS・Gradle）と、新しい暗号のコード（クリティカル箇所）を別の PR で見られる。S1 の間に LLM が使えないことは、Android の製品のリリースが S2 の後であれば利用者に影響しない
- C: 別の手段（例: `keyring` クレートの Android の保管。`secure-transport-byok.md` は macOS でアクセシビリティ・同期可否を指定できないことを理由に退けたが、Android に限って使う余地はある。推論: Android の実装の中身〔Keystore で包むか〕は確かめていない）

### 親への問い

#### Q1. #585 S4 との境界（決定 5）

- 推奨: 決定 5 の表のとおり。プラットフォームの判定を `android` へ広げることと、fork の Android の差分（`show` の予約を `get_pending` と再起動の復元に載せる・過去の時刻を拒否で返す）・正確な時刻の予約の権限の宣言と扱い・省電力（`allowWhileIdle`・`RTC_WAKEUP`）は #585 S4 に置く。許可を求める画面（`POST_NOTIFICATIONS` と「アラームとリマインダー」への誘導）と通しの確認は、この Issue の S3 に置く。
- 判断材料: #585 S4 の定義（スライス表の 249 行「Android の実装〔正確な時刻の予約の権限・端末の省電力〕」）、#585 決定 9 の S3-Q2（許可の体験は器の Issue で決める）。判定だけを先に広げると、`get_pending` に載らず再起動で消える予約で催促を出すことになる（実測のコード）。
- 代替案: プラットフォームの判定を広げるのを S1 に入れる（S1 で催促が「出る」ようになるが、上の不具合を抱えたまま出る）。
- **#585 S4 の見積もり（3-8 ファイル）への影響**: fork の Android の差分（Kotlin）が加わる。S4 を仕様にするときに見積もり直しが要る（新しい論点）。

#### Q2. `check:android` を必須ゲートに足すか（決定 3）

- 事実: このホストには NDK・Android のターゲットが無く、`check:android` は今は走らない。足すと、オーナーが開発機に NDK（1 GB 程度。推論）と Android のターゲットを入れるまで、すべての品質ゲートの判定が落ちる。CI は無い。
- 推奨: **S1 の実装 PR で足す**（`check:ios` と同じ。決定 P2 の型）。S1 の実装そのものに SDK・NDK・エミュレータが要るため、S1 に着手する時点で開発機は準備済みになる。`CLAUDE.md` の必須ゲートの記述は S1 の実装 PR で変える。
- 代替案: 足さない（手動の確認の前の任意の検査にする）／S1 の後で足す。

#### Q3. Android の TLS（決定 6。API キーの取り扱い＝クリティカル箇所）

- 推奨: Android でだけ `rustls`（`webpki-roots`）。Apple は `default-tls` のまま。
- 判断材料: `native-tls` は Android では OpenSSL（`openssl-sys`。`vendored` 無し）に依存する（`Cargo.lock`）。`webpki-roots` は Mozilla のルート証明書の束をバイナリに入れるため、端末に利用者が足した証明書は信頼しない（ai-boss の送信先は Anthropic・OpenAI・中継の 3 つで、いずれも公開のルートで足りる見込み。推論）。
- 代替案: `native-tls` の `vendored`（OpenSSL をソースからビルド）／`rustls-platform-verifier`（端末の証明書ストア。Kotlin の部品が要る）。

#### Q4. Android のアプリのオリジンを Android でだけ許す（決定 2。ナビゲーションの境界）

- 推奨: 決定 2 のとおり（`http://tauri.localhost` だけを、Android でだけ許す。`use_https_scheme` は偽のまま）。
- 判断材料: Tauri 2.12.0 のソースのテストが、Android のアプリの URL を `http://tauri.localhost/` と固定している。`use_https_scheme` を後で変えると WebView のデータが読めなくなる（`tauri-utils` の説明）。
- 代替案: `use_https_scheme` を真にして `https://tauri.localhost` を許す。

### 前提として置いたこと（親が確認するなら回答を）

- 実機での確認は、ADR 0011「未決」のとおり製品化の後のフェーズとする（この仕様の手動の確認はエミュレータだけ）。

## 仮定（軽微・可逆）

- A1: 仕様のファイル名は `docs/features/android-shell.md` とする（`ios-shell.md` に揃える）。
- A2: スライスを 3 つ（S1 器・S2 保管・S3 許可の体験と通しの確認）に切る。S2 は未決 A2 で A を選べば S1 に入れる。
- A3: Android の Rust のターゲットは `aarch64-linux-android` の 1 つから始める（Apple Silicon の開発機のエミュレータは arm64）。`check:android` もこの 1 つを検査する。
- A4: エミュレータ向けのビルドのスクリプト名は `build:tauri:android-emu` とする（`build:tauri:ios-sim` に揃える）。中身は `cd native/tauri-app && npx @tauri-apps/cli android build --debug --target aarch64 --apk`。
- A5: `check:android` は、器のライブラリだけを検査する（`--lib`）。NDK の環境変数の組み立ては `scripts/check-android.mjs` に置く（`check:ios` の `&&` の連結と違い、環境変数を組むため）。
- A6: Android のオリジンの判定は、`is_allowed_navigation` の中身をオリジンを引数に取る関数へ移し、`is_allowed_navigation` の名前と既存の単体テストは残す（既存のテストの名前を変えない）。
- A7: `.gitignore` の検査は、`scripts/*.test.mjs`（`npm test` の `test:scripts`）に置く（`ios-shell.md` の A7 と同じ）。
- A8: 手動の確認手順で WebView のコンソールから `window.__TAURI_INTERNALS__.invoke` を呼べる見込みである（推論。`ios-shell.md` の A8 と同じ）。デバッグのビルドでは Chrome の `chrome://inspect` で WebView を調べられる（`tauri-utils` の `devtools` の説明: Android は `chrome://inspect/#devices`）。
