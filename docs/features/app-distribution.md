# 署名・公証・ストア申請とアプリ本体の自動更新（製品版の配布）

> Issue #587。2026-10-05 に作成した。範囲と前提は、ADR 0011 の決定 5・9〜11・19、#590 のオーナーの決定（2026-09-26。Windows は後続リリース）、#581 のオーナーの決定 Q7（未署名の `.app` ではデータ保護キーチェーンへ登録できない）に拠る。**オーナーは 2026-10-05、友人・身内に試してもらう段階に入るため、#587 を先に進め、最小スライス S1 を「試用者に配れる macOS 版の署名・公証」にすると決めた**（FR-13 で承認済み。ストア申請・自動更新は後のスライス）。同日、作成時点の未決（オーナーへの問い O1〜O4・親への問い P1〜P6）が決まった（★ はオーナーの決定。「決定（2026-10-05）」節）。同日、PR #701 の独立レビュー（code-reviewer）の指摘 M1〜M6・L1〜L6 への親の決定で、決定 2・3・5・受入基準（S1）・手動の確認手順（S1）を改めた（公証の資格情報の fail-closed・追加の引数の拒否・配る DMG の中の `.app` の検査・プロファイルの検査・空虚なアサーションの置き換え）。

## 概要

製品版（Tauri 2）の macOS の `.app` を、**App Store の外で配れる形**（Developer ID Application の証明書で署名し、Apple の公証を通し、公証の票〔ticket〕を staple した配布物）にする。今の製品版のビルドは ad-hoc 署名（`npm run build:tauri`）か、開発用の Apple Development の証明書による署名（`npm run build:tauri:signed`。#581 S3）だけで、どちらも他人の Mac では Gatekeeper に拒否される。

この仕様では、次の 3 つを扱う。

- **S1**: macOS の配布物（Developer ID の署名・hardened runtime・公証・staple 済み）を作るスクリプトと、配布物が配ってよい状態かを判定する検査
- **S2**: アプリ本体の自動更新（`tauri-plugin-updater`・更新の署名・配信の置き場所）と、その通信を [ADR 0001](../adr/0001-local-only-data-boundary.md) の外部送信の許可範囲に載せる追補
- **S3 以降**: iOS（App Store・TestFlight）・Android（Google Play）への申請（#669・#674 の器の後）

## 背景・目的

- 一般の利用者は Node.js と npm を用意しないため、製品版はインストール型のアプリとして配る（#587 本文・ADR 0011 決定 1・5）。
- macOS は、インターネットから入手した（隔離属性 `com.apple.quarantine` の付いた）アプリを、**Developer ID で署名され公証されていなければ** Gatekeeper で開かせない。試用者に「右クリックで開く」「セキュリティ設定で許可する」といった回避を頼む配り方は採らない（試用者の体験と、回避を習慣にさせない安全の両面）。
- 製品版の BYOK のキーは**データ保護キーチェーン**に保管する（ADR 0002 改訂・#581 クリティカル設計決定 9）。未署名・ad-hoc 署名の `.app` ではキーの登録が OSStatus `-34018` になる（#581 決定 Q7）。**試用者が BYOK で LLM を使うには、配布物そのものが正しく署名され、キーチェーンの entitlement が認可されていなければならない**。
- 初回リリースは macOS と iOS / Android、Windows は後続リリース（ADR 0011 決定 5・19・#590）。Windows はこの仕様の範囲外。
- #587 本文の残論点（medium）: **自動更新の通信と ADR 0001 の整合**。更新の確認・取得の通信先を、ADR 0001 改訂の外部送信の許可範囲（推論リクエスト・ライセンス確認・同期の中継）にどう載せるかを S2 の設計として書く（ADR の改訂そのものは S2 の実装で行う）。

## ユーザーストーリー

- 試用者として、受け取った ai-boss をふつうのアプリと同じ手順（ディスクイメージを開いて「アプリケーション」へ入れ、開く）で使い始めたい。「開発元を確認できない」という警告を回避する操作をしたくない。
- 試用者として、自分の API キー（BYOK）を登録してボスと話したい（キーは自分の Mac のキーチェーンにだけ残ってほしい）。
- オーナーとして、試用者に配る版を、1 つのコマンドで作り、配ってよい状態か（署名・公証・staple）を機械的に確かめてから渡したい。証明書・パスワード・API キーがリポジトリやログに残らないようにしたい。
- オーナーとして（S2）、直した版を試用者に届けるのに、毎回ファイルを手で配り直したくない。偽の更新が配られないようにしたい。

## 実コードの実測（2026-10-05・`main` e75c91a）

### 製品版の器の設定（`native/tauri-app/tauri.conf.json`）

- `identifier` は `dev.aiboss.app`、`productName` は `ai-boss`。
- `version` は**未設定**。Tauri は `version` が無いと `Cargo.toml` の版を使う（`tauri-utils` 2.10.0 `config.rs` の `version` の説明: "If removed the version number from `Cargo.toml` is used. It's recommended to manage the app versioning in the Tauri config."）。`native/tauri-app/Cargo.toml` の版は `0.1.0` で、手元の `target/release/bundle/macos/ai-boss.app`（2026-10-05 01:08 のビルド）の `Info.plist` は `CFBundleShortVersionString`・`CFBundleVersion` とも `0.1.0`、`LSMinimumSystemVersion` は `10.13`（Tauri の既定）。ルートの `package.json` の `version` は `0.0.0` で、器の版とは別物。
- `bundle.targets` は `"app"` のみ。`bundle.macOS` の節は無い（署名の設定は `build:tauri:signed` が `--config` の上書きで渡す）。
- `plugins` は `sql` の preload だけ。updater の設定は無い。

### 今の `.app` の中身と署名（手元のビルド・読むだけ）

- 中身は `Contents/Info.plist`・`Contents/MacOS/ai-boss-tauri-app`（実行可能なファイルはこの 1 つ）・`Contents/Resources/icon.icns` だけ。**入れ子のフレームワーク・サイドカー・ヘルパーは無い**（`verify-tauri-bundle.mjs` が `node`・`node_modules` の不在を検査している。#579 の決定 Q4-b）。
- `codesign -dv`: `Signature=adhoc`・`TeamIdentifier=not set`・`flags=0x20002(adhoc,linker-signed)`。`spctl -a -vv` は "code has no resources but signature indicates they must be present" で拒否。
- バイナリは **arm64 のみ**（`Mach-O thin (arm64)`）。Intel の Mac では動かない。`rust-toolchain.toml` の `targets` に `x86_64-apple-darwin` は無い。

### npm のスクリプト（`package.json`）

- `build:tauri`: `cd native/tauri-app && npx @tauri-apps/cli build --bundles app`（未署名＝ad-hoc）
- `build:tauri:signed`: `node scripts/build-tauri-signed.mjs`（#581 S3）
- `verify:tauri-bundle`: `node scripts/verify-tauri-bundle.mjs`（`node`・`node_modules` の不在の検査。対象は `native/tauri-app/target/release/bundle/macos/` の `.app`）
- `@tauri-apps/cli` は `^2.12.0`（入っているのは 2.12.0）。

### 署名つきのビルド（`scripts/tauri-signing.mjs`・`scripts/build-tauri-signed.mjs`・#581 S3）

- `readSigningConfig(env)`: `APPLE_SIGNING_IDENTITY`（必須。案内の文言は「Apple Development の証明書の名前」）・`APPLE_TEAM_ID`（必須・`/^[A-Z0-9]{10}$/`）・`APPLE_PROVISIONING_PROFILE`（任意）を読み、足りなければ `SigningConfigError`。**署名 ID の種類（Apple Development か Developer ID か）は見ていない**。署名 ID とチーム ID の食い違いも見ていない。
- `buildEntitlementsPlist(teamId)`: `keychain-access-groups` に `<チーム ID>.dev.aiboss.app` の 1 要素だけ。`com.apple.application-identifier`・`com.apple.developer.team-identifier` は無い。
- `buildTauriConfigOverride`: `bundle.macOS.signingIdentity`・`entitlements`・（プロファイルがあれば）`files["embedded.provisionprofile"]`。`hardenedRuntime` は指定しない（Tauri の既定に任せる）。
- `planSignedBuild`: 生成先は `native/tauri-app/target/signing/`（`entitlements.plist`・`tauri.signing.conf.json`）。Tauri の CLI は `build --bundles app --config <上書き>` に、残りの引数（`--debug` 等）を足して呼ぶ。
- 副作用（`mkdir`・`writeFile`・`run`・`logError`）は依存として受け取り、`scripts/tauri-signing.test.mjs` の S3-G1〜S3-G7 が組み立てを固定している。**このスクリプトは実際には一度も実行されていない**（PR #653 の未検証事項「署名 ID が開発機に無い」。プロファイルの要否は #581 の仮定 A23 で「未実測」のまま）。

### 秘密情報とリポジトリ

- リポジトリは **public**（`masanami/ai-boss`）。
- `.gitignore` は `.env`・`.env.*`・`target/`・Android の `*.jks`・`*.keystore` を無視するが、**`*.p12`・`*.p8`（App Store Connect の API キー）・`*.provisionprofile`・`*.cer` は無視していない**。

### 識別子 `dev.aiboss.app` の使われ方

- 追跡しているファイルのうち 21 ファイル・57 か所に現れる（`tauri.conf.json`・`gen/apple`〔`project.yml`・`project.pbxproj`〕・`gen/android`〔`build.gradle.kts`・`MainActivity.kt` のパッケージ〕・`src/lib.rs`・器のテスト・`scripts/tauri-signing.mjs` の `APP_IDENTIFIER`・web の `tauri-db` テスト・仕様）。
- 識別子は、アプリのデータのディレクトリ（DB の置き場所）・キーチェーンのアクセスグループ（`<チーム ID>.dev.aiboss.app`）・Apple の App ID・iOS / Android のバンドル ID を決める。
- Tauri CLI 2.12.0 は、識別子が `.app` で終わると警告を出す（`crates/tauri-cli/src/build.rs` 190 行: "ends with `.app`. This is not recommended because it conflicts with the application bundle extension on macOS."）。エラーではない。

### ホスト（2026-10-05）

- `security find-identity -v -p codesigning`: **0 valid identities found**（署名 ID は 0 件。2026-09-29 の記録から変わらない）。
- `xcrun notarytool --version`: `1.1.2 (41)`（ある）。
- `xcrun --find stapler`: `/Applications/Xcode.app/Contents/Developer/usr/bin/stapler`（ある）。
- Xcode 26.6（Build 17F113）・macOS 26.6.2。
- `hdiutil` はある（`/usr/bin/hdiutil`）。`create-dmg`（Homebrew の同名の道具）は無い（Tauri は DMG の作成に同梱のスクリプトを使うため、要らない見込み。推論）。

### Tauri の署名・公証・DMG（一次情報。Tauri CLI 2.12.0 のタグ `tauri-cli-v2.12.0` のソースと v2.tauri.app の文書）

- **証明書の種類**: 文書（`/distribute/sign/macos/`）は "`Apple Distribution` to submit apps to the App Store, and `Developer ID Application` to ship apps outside the App Store" とする。
- **署名の流れ**（`crates/tauri-bundler/src/bundle/macos/app.rs` 114〜149 行）: `--no-sign` でなく、署名 ID（`bundle.macOS.signingIdentity` または `APPLE_CERTIFICATE`）があれば、入れ子のフレームワーク・サイドカーを先に、最後に `.app` を署名する（内から外へ）。続けて公証の資格情報を環境変数から読む。
- **公証の資格情報**（`sign.rs` の `notarize_auth`）: `APPLE_ID`＋`APPLE_PASSWORD`＋`APPLE_TEAM_ID`（Apple ID とアプリ用パスワード）か、`APPLE_API_KEY`＋`APPLE_API_ISSUER`（＋`APPLE_API_KEY_PATH`。無ければ `./private_keys`・`~/private_keys`・`~/.private_keys`・`~/.appstoreconnect/private_keys` の `AuthKey_<キー ID>.p8` を探す）の App Store Connect の API キー。
- **資格情報が無いとき、Tauri は公証を飛ばしてビルドを成功させる**（`app.rs` 143〜147 行: `APPLE_ID` と `APPLE_PASSWORD` があって `APPLE_TEAM_ID` が無いときだけエラー、それ以外は `log::warn!("skipping app notarization, {e}")`）。**署名だけされ公証されていない `.app` が、成功の終了コードで出来上がる**。
- **公証**（`crates/tauri-macos-sign/src/lib.rs`）: `.app` を `ditto` で zip にし、`xcrun notarytool submit <zip> --output-format json --wait` で送る。状態が `Accepted` でなければ `notarytool log` を添えてエラーにする。
- **Apple ID 方式では、パスワードが `notarytool` のコマンドラインの引数（`--password`）に載る**（`notarytool_args`）。API キー方式では、キー ID・発行者 ID・キーのファイルのパスが引数に載る（キーの中身は載らない）。
- **staple の失敗は検出されない**: `staple_app` は `xcrun stapler staple -v <名前>` を起動するが、終了コードを見ていない（起動そのものの失敗だけをエラーにする）。
- **hardened runtime の既定は真**（`tauri-utils` 2.10.0 `MacConfig::hardened_runtime`・`default_true`）。実行可能なファイルの署名に `--options runtime` が付く（`sign.rs`: `target.is_an_executable && settings.macos().hardened_runtime`）。
- **DMG**: `--bundles dmg`（または `bundle.targets`）で作る。DMG の中の `.app` は、上の署名・公証・staple を済ませた後のもの。**DMG 自体は署名されるが、公証も staple もされない**（`dmg/mod.rs` 194〜205 行。署名 ID が `-`〔ad-hoc〕のときは署名もしない）。文書（`/distribute/dmg/`）は、CI では DMG のアイコンの位置が反映されない既知の問題を挙げる。
- **版番号**: 上記「製品版の器の設定」のとおり。`bundle.macOS.bundleVersion` で `CFBundleVersion` を別に指定できる。

### Apple の一次情報で確かめたこと（2026-10-05）

- **Developer ID の配布でデータ保護キーチェーンを使うには、プロビジョニングプロファイルの認可が要る**。Apple の DTS の回答（developer.apple.com/forums/thread/826107）: "the data protection keychain _is_ available to directly distributed programs that use Developer ID signing" ／ "that access must be authorised by a provisioning profile"。アクセスグループはチーム ID を接頭辞にする必要がある。
- プロファイルを使うとき、**`com.apple.application-identifier`・`com.apple.developer.team-identifier` の entitlement は、プロファイルと署名で一致していなければならない**（DTS の回答・developer.apple.com/forums/thread/692904 の要旨）。**今の `buildEntitlementsPlist` はこの 2 つを持たない**。
- したがって、**#581 の仮定 A23（プロファイルの要否は未実測）は、Developer ID の配布については「要る」に倒すのが一次情報に沿う**。プロファイルの無い署名つきの `.app` で、制限つきの entitlement が認可されずに起動で落ちる（`Code Signature Invalid`）か、登録が `-34018` になるかは**未実測**（推論。手動の確認手順で観測する）。
- hardened runtime で WKWebView を使うアプリに、JIT 等の例外の entitlement（`com.apple.security.cs.allow-jit` 等）が要るかは、一次情報で確かめられなかった。WKWebView の JavaScript はアプリのプロセスではなく WebKit の別プロセスで動くため要らない見込みで、Tauri の署名の文書も例外の entitlement に触れていない（**推論**。手動の確認手順 6・7〔公証済みの `.app` でチャットが動くこと〕で確かめる）。
- 公証は、デバッグ用の entitlement `com.apple.security.get-task-allow` を持つ実行ファイルを受け付けない（Apple の公証の要件として広く知られた事実だが、この起動では文書の該当箇所を取得していない。**推論**）。Tauri の release ビルドはこれを付けない見込みで、S1 は生成する entitlements に含めないことをテストで固定する。

### `tauri-plugin-updater`（S2 の設計の材料。v2.tauri.app `/plugin/updater/`）

- 更新は**署名の検証を外せない**（"Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled."）。鍵の組は `tauri signer generate` で作り、公開鍵を `plugins.updater.pubkey` に置く。秘密鍵は `TAURI_SIGNING_PRIVATE_KEY`（パスか中身）・`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` でビルドに渡す（`.env` は効かない）。**秘密鍵を失うと、入っているアプリへ更新を配れなくなる**。
- `bundle.createUpdaterArtifacts: true` で、macOS では `ai-boss.app.tar.gz` と `ai-boss.app.tar.gz.sig` を作る。**updater は DMG を使わない**。
- `plugins.updater.endpoints` は静的な JSON か動的なサーバー。`{{current_version}}`・`{{target}}`・`{{arch}}` を URL に埋められる。静的な JSON は `version`（SemVer）・`platforms.<OS-ARCH>.url`・`platforms.<OS-ARCH>.signature`（ファイルの中身）を持つ（キーの例 `darwin-aarch64`）。
- **本番では TLS が強制される**（`dangerousInsecureTransportProtocol` を真にしない限り）。
- 権限 `updater:allow-check`・`allow-download`・`allow-install`・`allow-download-and-install` を capability で明示的に許す必要がある。
- 更新の確認・取得の HTTP 要求を Rust 側から送るか WebView から送るかは、文書からは読み取れなかった（Rust のプラグインの中で送る見込み。**推論**。S2 の仕様でソースを読んで確かめる）。

## 機能要件（機能全体。スライスごとの範囲は「スライス」節）

- **S1**: オーナーの開発機で 1 つのコマンドを実行すると、Developer ID Application の証明書で署名し（hardened runtime・キーチェーンの entitlement・Developer ID のプロビジョニングプロファイルつき）、Apple の公証を通して staple した `.app` と、それを入れた DMG（DMG も公証・staple する。決定 O2・P5）ができる。
- **S1**: 配布物を作るスクリプトは、署名・公証の前提（証明書の種類・チーム ID・プロファイル・公証の資格情報）が足りない・食い違うとき、**Tauri のビルドを始めずに**失敗する（Tauri は資格情報が無いと公証を飛ばして成功するため、スクリプトの側で塞ぐ）。
- **S1**: 配布物の検査のコマンドが、`.app` と配布物について、署名の検証・Developer ID による公証の受理・staple・hardened runtime・entitlements を確かめ、1 つでも満たさなければ 0 以外で終わる。**検査に合格した配布物だけを配る**。
- **S1**: 公証済みの配布物で、試用者が BYOK のキーを登録し、チャット・朝会・夕会を使える（#581 S3 の手動の確認手順を、配布物で行う）。
- **S1**: 開発者用の版（`npm run dev`・`npm run start`）と、今の `build:tauri`・`build:tauri:signed` の振る舞いを変えない。
- **S2**: 製品版のアプリが、決められた配信の置き場所から更新を確認し、更新の署名を検証できたものだけを取得・適用する。検証できない・通信できないときは更新を適用せず、今の版で動き続ける。更新の通信を ADR 0001 の外部送信の許可範囲に追補する。
- **S3 以降**: iOS（TestFlight・App Store）・Android（Google Play）へ申請できる状態にする。

## 非機能要件

- **秘密情報**: 証明書（`.p12`）・App Store Connect の API キー（`.p8`）・アプリ用パスワード・プロビジョニングプロファイル・更新の署名の秘密鍵（S2）を、リポジトリのファイル・コミット・スクリプトの出力に出さない。値はシェルの環境変数かリポジトリの外のファイルで渡す。
- **安全側**: 確定しないもの（公証の結果が分からない・staple を確かめられない・更新の署名を検証できない）は、配らない・適用しない側に倒す。
- **再現性**: 配布物は、同じコミット・同じ環境変数から同じ手順で作れる。スクリプトの組み立て（引数・生成するファイル・前提の検査）は、副作用を差し替えた単体テストで固定する（`tauri-signing.mjs` と同じ型）。
- **費用**: Apple Developer Program の年会費が要る（個人で登録する。決定 O1）。S1 は CI を使わず、オーナーの開発機で作る（「やらないこと」）。

## 技術的な制約・方針

- 正はコードとテスト。この仕様は非権威の作業文書（リポジトリの `CLAUDE.md`）。
- **Apple のサービスと証明書が要る操作（公証の送信・Gatekeeper の判定）は、自動のテストに入れない**。自動のテストは、スクリプトの組み立てと、検査のコマンドの出力の判定（純粋関数）までを固定し、実際の公証と判定は「手動の確認手順（S1）」でオーナーが行う。
- クリティカル箇所: **API キーの取り扱い**（キーチェーンの entitlement とプロファイル。キーを登録できるかを左右する）。S1 の実装 PR は人間レビュー必須。
- 製品版のキーの属性（データ保護キーチェーン・初回ロック解除後・この端末のみ・同期しない）は変えない（#581 決定 Q7）。
- Windows・Linux は範囲外（ADR 0011 決定 19・「未決」）。

## クリティカル設計決定

### 1. 配布物は Developer ID Application の証明書で署名し、Developer ID のプロビジョニングプロファイルを必須にする（P6・【決定】2026-10-05・親）

- **採用案**: 配布用のビルドは、署名 ID が `Developer ID Application:` で始まる証明書だけを受け付ける。プロビジョニングプロファイル（Developer ID・macOS・App ID は `dev.aiboss.app`〔決定 O4〕）を**必須**にし、`.app` の `Contents/embedded.provisionprofile` に入れる。entitlements は次の 3 つだけにする。
  - `keychain-access-groups`: `[<チーム ID>.<識別子>]`（今の `build:tauri:signed` と同じ値）
  - `com.apple.application-identifier`: `<チーム ID>.<識別子>`
  - `com.apple.developer.team-identifier`: `<チーム ID>`
- **理由**: Apple の DTS の回答（「Apple の一次情報で確かめたこと」）で、Developer ID の配布でデータ保護キーチェーンを使うにはプロファイルの認可が要り、application-identifier・team-identifier はプロファイルと一致させる必要がある。プロファイルを任意のままにすると、キーを登録できない（または起動しない）配布物を、成功の終了コードで作れてしまう。証明書の種類を見ないと、Apple Development の署名（他人の Mac では Gatekeeper に拒否される）を配布物として作れてしまう。
- **代替案**: (a) 今の `build:tauri:signed` に Developer ID を渡すだけにする — プロファイルが任意・entitlement が足りない・公証の資格情報が無くても成功する。(b) キーの保管をファイル型のキーチェーンに変えてプロファイルを不要にする — #581 決定 Q7（キーの属性を変えない）に反する。
- **影響範囲**: `scripts/`（配布用のビルドのスクリプトとテスト）・`package.json`・`.gitignore`。`build:tauri:signed` の entitlements（Apple Development 用）は変えない。

### 2. 公証の資格情報が API キーの 3 つちょうどでなければ、Tauri のビルドを始めずに失敗する（作成者の判断・2026-10-05。2026-10-05 の PR #701 のレビューで親が改めた）

- **採用案**: 配布用のビルドのスクリプトは、次のいずれかのとき、Tauri のビルドを始めずに 0 以外で終わる（fail-closed）。
  - App Store Connect の API キーの 3 つ（`APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH`。決定 P1）が 1 つも無い、または一部だけある
  - Apple ID 方式の変数（`APPLE_ID`・`APPLE_PASSWORD`）のどちらか 1 つでも環境にある
  - 証明書の取り込みの変数（`APPLE_CERTIFICATE`・`APPLE_CERTIFICATE_PASSWORD`）のどちらか 1 つでも環境にある
- **理由**:
  - Tauri は資格情報が無いと警告を出して公証を飛ばし、成功の終了コードで終わる（`app.rs` 143〜147 行）。警告はビルドの大量の出力に埋もれる。
  - Tauri の `notarize_auth`（`sign.rs`）は、`APPLE_ID`・`APPLE_PASSWORD`・`APPLE_TEAM_ID` の組を API キーより先に評価する。配布用のビルドは `APPLE_TEAM_ID` を必須にするため、シェルに `APPLE_ID`・`APPLE_PASSWORD` が残っていると Apple ID 方式が選ばれ、パスワードが `notarytool --password` の引数に載る（`notarytool_args`）。
  - Tauri の `keychain`（`sign.rs`）は、`APPLE_CERTIFICATE`・`APPLE_CERTIFICATE_PASSWORD` の両方があると、`.p12` を一時のキーチェーンへ取り込んで署名に使う。配布用のビルドはログインキーチェーンの証明書だけを使う前提で、別の経路を開けておかない。
- **影響範囲**: 配布用のビルドのスクリプト。

### 3. 配る DMG の中の `.app` と DMG を、Tauri の成功に頼らず検査で確かめる（作成者の判断・2026-10-05。2026-10-05 の PR #701 のレビューで親が改めた）

- **採用案**: 配布物の検査のコマンド（新しい npm スクリプト）は、配る DMG を 1 つに決め、その中の `.app` と DMG を検査する。判定は、コマンドの出力から**肯定の事実**を読む純粋関数にする（「エラーが出ない」を合格の根拠にしない）。
  - **対象**: `native/tauri-app/target/release/bundle/dmg/ai-boss_<version>_aarch64.dmg`（`<version>` は `tauri.conf.json` の `version`。名前の形は Tauri の `dmg/mod.rs` 40〜56 行の `{productName}_{version}_{arch}.dmg`）。その名前のファイルが無い、または同じディレクトリに別の `.dmg` があるときは 0 以外で終わる（あいまいな対象を検査しない）。
  - **期待するチーム ID**: 環境変数 `APPLE_TEAM_ID` で受け取る。無い・形が違うときは 0 以外で終わる。
  - **マウント**: DMG を `hdiutil attach -readonly -nobrowse -mountpoint <一時ディレクトリ>` でマウントし、中の `ai-boss.app` を検査する。合否にかかわらず `hdiutil detach` で外す。`bundle/macos/ai-boss.app` は検査しない（`npm run build:tauri` が ad-hoc 署名の `.app` で上書きしうるため。配るのは DMG の中の `.app`）。
  - **`.app` の検査**: `codesign --verify --deep --strict` の `valid on disk` と `satisfies its Designated Requirement`／`codesign -dv` の `Authority=Developer ID Application:`・`TeamIdentifier=`・`flags=` の `runtime`／entitlements が決定 1 の 3 つちょうど／`Contents/embedded.provisionprofile` がファイルとしてあり、その `Entitlements.com.apple.application-identifier` が `<チーム ID>.dev.aiboss.app`／`spctl -a -vv -t exec` の `accepted` と `source=Notarized Developer ID`／`xcrun stapler validate` の `The validate action worked!`
  - **DMG の検査**: `spctl -a -vv -t open --context context:primary-signature` の `accepted` と `source=Notarized Developer ID`／`xcrun stapler validate` の `The validate action worked!`
- **理由**: Tauri の `staple_app` は `stapler` の終了コードを見ない。staple が漏れると、オフラインの Mac で Gatekeeper が公証を確かめられず拒否する。プロファイルが `.app` に入っていないと、キーチェーンの entitlement が認可されない（決定 1）。検査するのが配る物そのもの（DMG の中の `.app`）でなければ、合格が配る物の状態を表さない。
- **影響範囲**: `scripts/`（検査のスクリプトとテスト）・`package.json`。

### 4. DMG も公証し staple する（P5・【決定】2026-10-05・親。配布の形は DMG＝決定 O2）

- **採用案**: Tauri のビルド（`.app` の署名・公証・staple と、DMG の作成・署名）が成功した後、スクリプトが DMG を `xcrun notarytool submit <dmg> --wait` で公証し、`xcrun stapler staple <dmg>` で staple する。どちらかが 0 以外で終われば、スクリプトも 0 以外で終わる。
- **理由**: Tauri は DMG を公証も staple もしない（`dmg/mod.rs`）。中の `.app` は staple 済みだが、外側の DMG が公証されていないと、ダウンロードした DMG を開くときの Gatekeeper の判定が `.app` の判定と食い違いうる（DMG の判定の結果は**推論**。手動の確認手順で観測する）。公証の送信が 1 回増えるだけで、配る物の全体を公証済みにできる。
- **代替案**: (a) DMG を公証しない — 上の不確かさを残す。(b) zip で配る — 公証は `.app` の分だけで済むが、zip は staple できない（中の `.app` の staple は残る）。配布の形は DMG に決まった（決定 O2）。

### 5. 配布用のビルドは、今の `build:tauri`・`build:tauri:signed` と別の入口にする（P2・【決定】2026-10-05・親）

- **採用案**: 新しい npm スクリプト（仮に `build:tauri:dist`）と、組み立ての純粋関数のモジュール（仮に `scripts/tauri-distribution.mjs`）・入口（`scripts/build-tauri-dist.mjs`）を足す。識別子は `tauri-signing.mjs` の `APP_IDENTIFIER` を import する。チーム ID の形の検査は複製してよい（`readSigningConfig` は案内の文言が「Apple Development の証明書の名前」で配布用と違うため流用しない）。**`tauri-signing.mjs` の既存の関数の振る舞いと `tauri-signing.test.mjs` は変えない**。配布用のビルドは**追加の引数を一切受け付けない**（`--skip-stapling`・`--no-sign`・追加の `--config`・`--target`・`--debug` で公証・staple・hardened runtime・アーキテクチャを外せるため。受入基準 B5）。`tauri.conf.json` の `bundle.targets` は `"app"` のままにし、DMG は配布用のビルドの `--bundles` の引数で指定する。
- **理由**: `build:tauri:signed` は Apple Development の証明書でキーの登録を確かめる開発用の入口で（#581 S3）、プロファイル任意・公証なしが正しい。配布用の必須条件（Developer ID・プロファイル必須・公証必須）を同じ入口に混ぜると、開発用の手順が壊れるか、配布用の検査が緩む。

### 6. 自動更新の通信を ADR 0001 の許可範囲へ追補する中身（S2 の設計。ADR の改訂は S2 の実装で行う）

S2 で ADR 0001 に「改訂（アプリ本体の更新）」を足す。中身は次のとおりとする（S2 の仕様で確定する。未決は S2 の起票の前にオーナーへ問う）。

- **外部送信の 4 つ目として「アプリ本体の更新の確認と取得」を加える。** 送信先は、**ビルド時に固定した配信の置き場所**（`plugins.updater.endpoints`。https のみ）と、そこが返す更新の記述（JSON）が指す取得先だけとする。実行時に配信の置き場所を変える手段（設定・WebView）は作らない（#583 の決定 S2-Q2 と同じ考え方。任意の宛先から更新を取らせないため）。
- **送ってよいのは、更新の判定に要る情報だけ**: 今の版・OS・アーキテクチャ（URL に埋める `{{current_version}}`・`{{target}}`・`{{arch}}`）と、HTTP の要求に付く標準の情報。**業務データ・アカウントの識別子・ライセンストークン・BYOK のキーを送らない**。
- **適用してよいのは、組み込んだ公開鍵で署名を検証できた更新だけ**（`tauri-plugin-updater` は検証を外せない）。検証できない・通信できない・記述が壊れているときは、適用せず今の版で動き続ける（失敗は利用者の作業を止めない）。
- 配信の置き場所は**推論リクエストと同じく、業務データを受け取らない**。置き場所がアクセスの記録（IP アドレス・時刻・要求の URL）を残すことは、ホスティングの性質として避けられない。これを許容するかと、確認の頻度・利用者が更新の確認を止められるかは、S2 の起票の前にオーナーへ問う（製品方針・プライバシーの約束に関わるため）。
- 更新の取得先が記述の中の任意の URL に向かうのを避けるため、取得先のホストを配信の置き場所と同じホストに限ることを S2 で検討する（プラグインは制限しない見込み。**推論**。S2 でソースを読んで確かめる）。

## 機能全体の設計

### 失敗の経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| 署名 ID が無い（証明書がキーチェーンに無い・環境変数が無い） | スクリプトが Tauri のビルドを始めずに失敗する（受入基準 D1）。証明書がキーチェーンに無いときは Tauri の署名で失敗する（手動の確認手順の準備で `security find-identity` を確かめる） |
| 証明書の種類の取り違え（Apple Development・Apple Distribution・Developer ID Installer を渡す） | 署名 ID が `Developer ID Application:` で始まらなければ失敗する（D2・D3）。検査で `Authority=` の先頭を確かめる（V9） |
| 署名 ID のチーム ID と `APPLE_TEAM_ID` が食い違う（entitlements のアクセスグループが別のチームを指す） | 署名 ID の末尾の `(<チーム ID>)` と `APPLE_TEAM_ID` が一致しなければ失敗する（D6・D7）。検査で `TeamIdentifier=` を確かめる（V10） |
| 証明書の失効・期限切れ | Tauri の署名（`codesign`）か公証で失敗し、ビルドが 0 以外で終わる。検査の `codesign --verify` と `spctl` でも不合格になる（V8・V15）。期限の管理そのものは「やらないこと」 |
| プロビジョニングプロファイルが無い・App ID が違う・期限切れ（キーチェーンの entitlement が認可されず、起動しないか登録が `-34018`） | プロファイルを必須にする（D8・D9）。entitlements を決定 1 の 3 つに固定する（B1・V12）。配る `.app` にプロファイルが入っていること（V13）と、その App ID が `<チーム ID>.dev.aiboss.app` であること（V14）を検査する。プロファイルの期限の照合は自動にしない（期限切れは署名か公証で失敗する見込み。**推論**）。公証済みの配布物でキーを登録できることを手動の確認手順 6 で確かめる |
| 公証の資格情報が無く、Tauri が公証を飛ばして成功する | スクリプトが Tauri のビルドを始めずに失敗する（D10・D11）。検査で `source=Notarized Developer ID` を確かめる（V15・V17） |
| シェルに `APPLE_ID`・`APPLE_PASSWORD` が残っていて、Tauri が Apple ID 方式を選び、パスワードを `notarytool --password` の引数に載せる（`notarize_auth` は Apple ID の組を先に評価する） | どちらか 1 つでも環境にあれば、Tauri を起動せずに失敗する（D12・決定 2） |
| `APPLE_CERTIFICATE`・`APPLE_CERTIFICATE_PASSWORD` が残っていて、Tauri が別の証明書を一時のキーチェーンへ取り込んで署名する | どちらか 1 つでも環境にあれば、Tauri を起動せずに失敗する（D13・決定 2） |
| 追加の引数（`--skip-stapling`・`--no-sign`・`--config`・`--target`・`--debug`）で公証・staple・hardened runtime・アーキテクチャが外れる | 引数を 1 つでも受け取れば、Tauri を起動せずに失敗する（B5）。Tauri の引数を完全一致で固定する（B4） |
| 検査が配る物と別の物を見る（`build:tauri` が上書きした `bundle/macos/ai-boss.app`・古い DMG・別の版の DMG） | 対象の DMG を版と `aarch64` から決まる 1 つの名前にし、無い・あいまいなら失敗する（V1〜V3）。DMG をマウントして中の `.app` を検査し、必ず外す（V5〜V7）。Tauri はビルドのたびに `bundle/dmg` を作り直す（`dmg/mod.rs` 68〜73 行） |
| hardened runtime が外れる（公証が拒否する） | 設定の上書きで `hardenedRuntime: true` を明示する（B3）。検査で `flags=` の `runtime` を確かめる（V11） |
| hardened runtime と entitlements の衝突（WKWebView・通知・ファイルの保存が hardened runtime で動かない） | 例外の entitlement は足さない（決定 1）。動くことは手動の確認手順 6〜8（チャット・朝会・証跡の保存・トレイ・通知）で確かめる。動かなければ、足す entitlement を S1 の実装で親に問う（推論の段階で entitlement を広げない） |
| デバッグ用の entitlement（`get-task-allow`）で公証が拒否される | 生成する entitlements を 3 つちょうどに固定する（B1）。配布用のビルドは `--debug` を含む引数を受け付けない（B5）。検査でも 3 つちょうどであることを確かめる（V12） |
| 公証の拒否（未署名の入れ子のバイナリ・サイドカー・フレームワーク） | 今の `.app` の実行可能なファイルは 1 つだけ（実測）。入れ子のコードは Tauri が内から外へ署名する。拒否されたら Tauri が `notarytool log` を添えて 0 以外で終わる（`tauri-macos-sign`）。`verify:tauri-bundle`（`node`・`node_modules` の不在）を手動の確認手順 3 で走らせる |
| staple の漏れ（Tauri は `stapler` の失敗を見ない）で、オフラインの Mac の Gatekeeper が拒否する | 検査で `stapler validate` を確かめる（V16・決定 3。これを正とする）。DMG は自分で staple し、終了コードを見る（N5・N6）。手動の確認手順 2 で `Notarization Ticket=stapled` を観測し、手順 4 でオフラインで開けることを補助として確かめる |
| DMG が公証されていない | DMG を公証・staple する（決定 4・N1〜N7）。公証の結果は `status` が `Accepted` のときだけ成功とする（N2・N4）。検査で DMG の `spctl`・`stapler validate` を確かめる（V16・V17） |
| 秘密情報（証明書・パスワード・API キー・プロファイル）がリポジトリに入る | `.gitignore` に `*.p12`・`*.p8`・`*.cer`・`*.provisionprofile`・`*.mobileprovision` を足し、`git check-ignore` で確かめる（G1）。生成するファイルは `target/` の下に置く（B2）。追跡しているファイルにこれらの拡張子が無いことを確かめる（G2） |
| 秘密情報がスクリプトの出力・ログに出る | スクリプト自身の出力に発行者 ID を出さない（K1）。スクリプトはキーのファイルを読まず（K2）、`notarytool` にはパスで渡す（N1）。Tauri の Apple ID 方式はパスワードを `notarytool` の引数に載せるため、API キー方式にする（決定 P1）。ビルドのログを PR・Issue へ貼らない（手動の確認手順の記録の規則。リポジトリは public） |
| 識別子を配布の後で変える（データのディレクトリ・キーチェーンのグループが変わり、試用者のデータと登録したキーが見えなくなる） | `dev.aiboss.app` のまま変えないと決めた（決定 O4）。App ID・プロファイルはこの識別子で作る。U7 で、配布用のビルドの識別子と器の識別子が等しいことを固定する |
| arm64 のみの配布物を Intel の Mac の試用者が受け取る（起動しない） | arm64 のみで配ると決めた（決定 O2）。配るときに Apple シリコン専用と伝える |
| 試用者がキーを登録できない（BYOK）・中継が使えない | オーナーが試用者ごとに Anthropic の API キーを発行して渡し、試用者が BYOK に登録する（決定 O3）。S1 は中継の URL を渡さずにビルドする。キーを登録できることは手動の確認手順 6 で確かめる |
| （S2）偽の更新が配られる（配信の置き場所の乗っ取り・中間者） | 更新の署名の検証（外せない）と TLS の強制。秘密鍵をリポジトリの外に置き、ビルドだけに渡す（S2 の受入基準） |
| （S2）更新の署名の秘密鍵を失う | 入っているアプリへ更新を配れなくなる。秘密鍵の保管と控えの方法を S2 で決める（オーナー）。失ったら手で配り直す |
| （S2）更新の通信先が ADR 0001 の許可範囲の外 | 決定 6 の追補を S2 で ADR 0001 に入れる。入るまで updater を配線しない |
| （S2）更新の適用の途中の失敗で起動しなくなる | S2 の仕様で、適用の失敗の扱い（今の版で動き続ける）を受入基準にする |

### 実装計画（S1 のチケット分解の見通し）

S1 は 1 チケットで足りる見込み（触るファイルは 12 前後）。

1. `.gitignore` に秘密情報の拡張子を足し、`git check-ignore` の検査を `scripts/*.test.mjs` に置く
2. 配布用のビルドの組み立て（`scripts/tauri-distribution.mjs`）と単体テスト（前提の検査 D1〜D13・Tauri の起動 B1〜B5・DMG の公証と staple N1〜N8・出力の秘密情報 K1〜K2）。識別子は `scripts/tauri-signing.mjs` の `APP_IDENTIFIER` を import して使い、テストの期待値にも `APP_IDENTIFIER` を使う（U7 で `tauri.conf.json` と一致を固定）
3. 入口 `scripts/build-tauri-dist.mjs` と npm スクリプト `build:tauri:dist`
4. 配布物の検査の判定（純粋関数）と単体テスト（記録した出力の例で合格・不合格。V8〜V17）と、入口 `scripts/verify-tauri-dist.mjs`・npm スクリプト `verify:tauri-dist`（対象の DMG の決定・マウントと後始末。V1〜V7・V18）
5. 版番号（`tauri.conf.json` の `version`。決定 P3）
6. `CLAUDE.md` の「よく使うコマンド」、`secure-transport-byok.md` の仮定 A23 の更新

## スライス（出荷の単位）

| スライス | 内容 | 触るファイル数（概算） | 出荷条件 |
|---|---|---|---|
| S1（最小） | macOS の配布物（Developer ID の署名・hardened runtime・キーチェーンの entitlement とプロファイル・公証・staple。DMG・arm64 のみ。決定 O2）を作るスクリプトと、配布物の検査（決定 1〜5）。秘密情報の `.gitignore`。版番号（決定 P3）。公証済みの配布物で、Gatekeeper の受理・オフラインでの起動・BYOK のキーの登録とチャットを手動の確認手順で確かめる。**開発者用の版と、今の `build:tauri`・`build:tauri:signed` の振る舞いは変えない**。**自動更新は無い**（新しい版は手で配り直す。決定 O2） | 12 前後 | **この仕様の PR がマージされてから**。**手動の確認手順の前に、オーナーが Apple Developer Program に個人で登録し、Developer ID Application の証明書・App ID・Developer ID のプロビジョニングプロファイル・公証の資格情報を用意してから**（実装とテストはそれより先に進められる） |
| S2 | アプリ本体の自動更新（`tauri-plugin-updater`・更新の署名の鍵・`createUpdaterArtifacts`・配信の置き場所・確認の頻度と利用者の操作・capability）と、ADR 0001 の追補（決定 6）。**外部送信の追加のため、ADR の改訂と PR は人間レビュー必須** | 未見積もり | S1 がマージされてから。配信の置き場所・アクセスの記録の許容・確認の頻度・秘密鍵の保管がオーナーに決まってから |
| S3 | iOS の配布: App Store Connect への登録・Apple Distribution の署名・TestFlight での配布・App Store の審査への申請の準備（プライバシーの記述・暗号の輸出の申告） | 未見積もり | #669 S2 がマージされてから。S1 の Apple Developer Program の登録の後 |
| S4 | Android の配布: アップロードの鍵・リリースの署名・Google Play Console への登録・内部テストの配布・申請の準備（データの安全性の記述） | 未見積もり | #674 S2・S3 がマージされてから。Google Play の開発者の登録（オーナー） |

実装対象: S1

## やらないこと

- Windows の署名・配布（理由: ADR 0011 決定 19・#590。後続リリース）
- Linux の配布（理由: ADR 0011「未決」で検討していない）
- Mac App Store への申請（理由: App Store の外の配布を S1 とした。Mac App Store はサンドボックスが必須で、今の器の機能〔トレイ・ファイルの保存等〕の見直しが要る。必要になったら別の Issue）
- CI（GitHub Actions 等）での署名・公証（理由: 証明書・API キーを CI の秘密に置く判断と費用が要る。試用の段階ではオーナーの開発機で作れば足りる。YAGNI）
- 証明書・プロファイルの期限の監視（理由: 試用の段階では、期限が切れたら作り直せば足りる。期限が切れると配布用のビルドか検査が失敗して気づける）
- 自動更新（理由: S2。S1 の試用は手で配り直す〔決定 O2〕）
- 中継（プラン込み）の URL を入れたビルド（理由: #583 S3〔ホスティング〕・#584〔トークン〕の範囲。S1 は中継の URL を渡さずにビルドし、#583 の決定 S2-Q2 のとおり中継の行は作られない。試用者はオーナーが発行した Anthropic の API キーを BYOK に登録する〔決定 O3〕）
- 試用者へ API キーを渡すことの規約上の扱いの確認（理由: オーナーが確認する事項〔決定 O3〕。アプリの振る舞いに関わらないため受入基準に入れない。仮定 B7）
- zip での配布・GitHub Releases 等の公開の置き場所での配布（理由: DMG を直接受け渡すと決めた〔決定 O2〕。公開の置き場所は外部への公開に当たるため、配る範囲を広げるときに別に決める）
- 利用規約・プライバシーポリシー・特商法表記（理由: #589 の範囲。友人・身内の試用で要るかはオーナーの判断）
- Gatekeeper の判定・公証の送信を自動のテストに入れること（理由: Apple のサービスと証明書が要る。判定の純粋関数までを自動にし、実行は手動の確認手順で行う）
- 識別子の変更（理由: `dev.aiboss.app` のまま変えないと決めた〔決定 O4〕）
- Intel の Mac 向け（universal）のビルド（理由: Apple シリコンのみで配ると決めた〔決定 O2〕）

## 受入基準（S1）

検査は、ホスト（macOS）の `node --test`（`npm test` の `test:scripts`）・`npm run`・`git` で行う。Apple のサービスと証明書が要るもの（実際の署名・公証・Gatekeeper の判定・キーの登録）は「手動の確認手順（S1）」に置く。

**比較の基準点**: 「変更されない」の項目は、S1 の実装ブランチの分岐元の `main` を基準点とし、`git diff --name-only <基準点>...HEAD -- <パス>` の出力が空であることで判定する。

**配布用のビルドの前提の検査**（副作用を差し替えた単体テスト。下の「ビルドを始めない」は、Tauri の CLI と `xcrun` の起動の依存が一度も呼ばれないことで判定する）:

- [ ] D1: `APPLE_SIGNING_IDENTITY` が無いと、ビルドを始めずに 0 以外の終了コードで終わる
- [ ] D2: `APPLE_SIGNING_IDENTITY` が `Developer ID Application:` で始まらない（例: `Apple Development: Taro (ABCDE12345)`・`Apple Distribution: Taro (ABCDE12345)`・`Developer ID Installer: Taro (ABCDE12345)`）と、ビルドを始めずに 0 以外で終わる
- [ ] D3: D2 の失敗の文言は `Developer ID Application` を含む
- [ ] D4: `APPLE_TEAM_ID` が無いと、ビルドを始めずに 0 以外で終わる
- [ ] D5: `APPLE_TEAM_ID` が英大文字と数字の 10 文字でない（例: `abc`・`ABCDEFGHIJK`・`abcde12345`）と、ビルドを始めずに 0 以外で終わる
- [ ] D6: `APPLE_SIGNING_IDENTITY` の末尾の括弧の中（例: `Developer ID Application: Taro (ABCDE12345)` の `ABCDE12345`）が `APPLE_TEAM_ID` と一致しないと、ビルドを始めずに 0 以外で終わる
- [ ] D7: D6 の括弧の中が `APPLE_TEAM_ID` と一致し、ほかの前提（D1〜D13）がすべてそろっているとき、Tauri の CLI を起動する（D1〜D13 の対照）
- [ ] D8: `APPLE_PROVISIONING_PROFILE` が無いと、ビルドを始めずに 0 以外で終わる
- [ ] D9: `APPLE_PROVISIONING_PROFILE` が指すパスにファイルが無いと、ビルドを始めずに 0 以外で終わる（ファイルの有無の確認は差し替えられる依存にする）
- [ ] D10: `APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH` が 1 つも無いと、ビルドを始めずに 0 以外で終わる
- [ ] D11: `APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH` の一部だけがある（3 つのうち 1 つ・2 つの全 6 通り）と、ビルドを始めずに 0 以外で終わる
- [ ] D12: API キーの 3 つがそろっていても、`APPLE_ID` か `APPLE_PASSWORD` のどちらか 1 つでも環境にある（空文字でない）と、ビルドを始めずに 0 以外で終わる（Tauri は Apple ID の組を API キーより先に評価し、パスワードを `notarytool --password` の引数に載せるため。決定 2）
- [ ] D13: `APPLE_CERTIFICATE` か `APPLE_CERTIFICATE_PASSWORD` のどちらか 1 つでも環境にある（空文字でない）と、ビルドを始めずに 0 以外で終わる（Tauri は両方があると証明書を一時のキーチェーンへ取り込む。決定 2）

**Tauri のビルドの起動**（同上）:

- [ ] B1: 生成する entitlements の鍵と値は、`keychain-access-groups`（`["<APPLE_TEAM_ID>.dev.aiboss.app"]`）・`com.apple.application-identifier`（`"<APPLE_TEAM_ID>.dev.aiboss.app"`）・`com.apple.developer.team-identifier`（`"<APPLE_TEAM_ID>"`）の 3 つちょうどである（`com.apple.security.get-task-allow` などほかの鍵を持たない）
- [ ] B2: 生成するファイル（entitlements・設定の上書き）は `native/tauri-app/target/` の下に置かれる
- [ ] B3: Tauri へ渡す設定の上書きは、`{"bundle":{"macOS":{"signingIdentity":<APPLE_SIGNING_IDENTITY>,"entitlements":<生成した entitlements のパス>,"hardenedRuntime":true,"files":{"embedded.provisionprofile":<APPLE_PROVISIONING_PROFILE>}}}}` と等しい
- [ ] B4: Tauri の CLI の起動は、コマンド `npx`・引数 `["@tauri-apps/cli","build","--bundles","app,dmg","--config",<生成した設定の上書きのパス>]`（完全一致）・作業ディレクトリ `native/tauri-app` である
- [ ] B5: スクリプトに引数が 1 つでも渡される（例: `--debug`・`--skip-stapling`・`--no-sign`・`--config x.json`・`--target x86_64-apple-darwin`）と、ビルドを始めずに 0 以外で終わる

**DMG の公証と staple**（同上。`<dmg>` は `native/tauri-app/target/release/bundle/dmg/ai-boss_<version>_aarch64.dmg`、`<version>` は `tauri.conf.json` の `version`）:

- [ ] N1: Tauri の CLI が 0 で終わると、続けて `xcrun` を引数 `["notarytool","submit",<dmg>,"--key",<APPLE_API_KEY_PATH>,"--key-id",<APPLE_API_KEY>,"--issuer",<APPLE_API_ISSUER>,"--output-format","json","--wait"]`（完全一致）で起動する（API キーはファイルのパスで渡す）
- [ ] N2: `notarytool` の出力の判定（純粋関数）は、JSON の `status` が `Accepted` のときだけ成功とし、`Invalid`・`Rejected`・`In Progress`・JSON でない出力の記録した例で失敗とする
- [ ] N3: `notarytool` が 0 以外で終わると、`stapler` を起動せずに 0 以外で終わる
- [ ] N4: `notarytool` が 0 で終わり N2 の判定が失敗だと、`stapler` を起動せずに 0 以外で終わる
- [ ] N5: N2 の判定が成功だと、続けて `xcrun` を引数 `["stapler","staple",<dmg>]`（完全一致）で起動する
- [ ] N6: `stapler` が 0 以外で終わると、0 以外で終わる
- [ ] N7: N2 の判定が成功で `stapler` が 0 で終わると、0 で終わり、`Accepted` と提出の ID を含む行を 1 行出す
- [ ] N8: Tauri の CLI が 0 以外で終わると、`xcrun` を起動せずに 0 以外で終わる

**秘密情報の出力**（同上）:

- [ ] K1: D1〜D13・B5・N3・N4・N6・N8 の各失敗の経路と N7 の成功の経路で、スクリプト自身が書き出す行（`logError`・`log` の依存に渡す文字列）に、`APPLE_API_ISSUER` に渡した値が含まれない（テストは、他の文字列に現れない値を渡して確かめる。子プロセス〔Tauri・`xcrun`〕がそのまま出す出力は対象外）
- [ ] K2: N7 までの成功の経路で、ファイルの読み込みの依存は `APPLE_API_KEY_PATH` のパスで一度も呼ばれない（spy の呼び出しが 0 回。スクリプトはキーのファイルを読まない。対照として、N1 でそのパスが `--key` の引数に載ることを確かめる）

**配布物の検査**（判定は純粋関数で、記録した出力の例を入力にする。入口は、コマンドの実行・ファイルの有無・ディレクトリの一覧を差し替えた単体テスト）:

- [ ] V1: 検査の対象の DMG は `native/tauri-app/target/release/bundle/dmg/ai-boss_<version>_aarch64.dmg`（`<version>` は `tauri.conf.json` の `version`）の 1 つである
- [ ] V2: V1 の名前のファイルが無いと、0 以外で終わる（「対象なし」を合格にしない）
- [ ] V3: V1 と同じディレクトリに、V1 の名前でない `.dmg` のファイルがあると、0 以外で終わる（対象があいまい）
- [ ] V4: 期待するチーム ID は環境変数 `APPLE_TEAM_ID` で受け取り、無い・英大文字と数字の 10 文字でないと、コマンドを 1 つも実行せずに 0 以外で終わる
- [ ] V5: 検査は DMG を `hdiutil` の引数 `["attach","-readonly","-nobrowse","-mountpoint",<一時ディレクトリ>,<dmg>]` でマウントし、V8〜V15 の `.app` の検査を `<一時ディレクトリ>/ai-boss.app`（DMG の中の `.app`）にかける（`native/tauri-app/target/release/bundle/macos/ai-boss.app` を検査しない）
- [ ] V6: マウントに成功した後は、検査の合否にかかわらず（途中のコマンドの起動が例外を投げた場合を含む）、`hdiutil` を引数 `["detach",<一時ディレクトリ>]` で 1 回起動する
- [ ] V7: マウントした DMG の中に `ai-boss.app` が無いと、0 以外で終わる（V6 の detach は行う）
- [ ] V8: `codesign --verify --deep --strict --verbose=2` の判定は、終了コードが 0 で、出力に `valid on disk` と `satisfies its Designated Requirement` の両方があるときだけ合格にする（終了コードが 0 でも片方が無ければ不合格）
- [ ] V9: `codesign -dv --verbose=4` の判定は、最初の `Authority=` の行が `Developer ID Application:` で始まるときだけ合格にする（`Authority=Apple Development: …` の例で不合格）
- [ ] V10: 同じ出力の判定は、`TeamIdentifier=` が V4 のチーム ID と等しいときだけ合格にする（`TeamIdentifier=not set`・別のチーム ID の例で不合格）
- [ ] V11: 同じ出力の判定は、`flags=` に `runtime` を含み `adhoc` を含まないときだけ合格にする（`flags=0x20002(adhoc,linker-signed)`・`flags=0x0(none)` の例で不合格）
- [ ] V12: `codesign -d --entitlements - --xml` の判定は、entitlements の鍵と値が B1 の 3 つと等しいときだけ合格にする（`keychain-access-groups` だけの例〔今の `build:tauri:signed` の形〕と、B1 の 3 つに `com.apple.security.get-task-allow` を足した例で不合格）
- [ ] V13: `<app>/Contents/embedded.provisionprofile` がファイルとして存在しないと不合格にする（存在しない例・同じ名前のディレクトリの例で不合格）
- [ ] V14: `security cms -D -i <app>/Contents/embedded.provisionprofile` の出力（plist）の判定は、`Entitlements` の `com.apple.application-identifier` が `<V4 のチーム ID>.dev.aiboss.app` と等しいときだけ合格にする（別のチーム ID・別の識別子・鍵が無い例で不合格）
- [ ] V15: `spctl -a -vv -t exec` の判定は、出力に `: accepted` と `source=Notarized Developer ID` の両方があるときだけ合格にする（`source=Developer ID`〔公証されていない〕・`: rejected`・`source=no usable signature` の例で不合格）
- [ ] V16: `xcrun stapler validate` の判定は、終了コードが 0 で、出力に `The validate action worked!` があるときだけ合格にする（終了コードが 0 で文言が無い例・`does not have a ticket stapled to it` と 0 以外の終了コードの例で不合格）。`.app` と DMG の両方にかける
- [ ] V17: DMG の `spctl -a -vv -t open --context context:primary-signature` の判定は V15 と同じ条件で合格にする（`source=Developer ID`〔公証されていない〕の例で不合格）
- [ ] V18: 検査の入口は、V8〜V17 の判定のうち 1 つでも不合格なら 0 以外で終わり、不合格の項目の名前を標準エラーに出す。すべて合格のときだけ 0 で終わる

**秘密情報**:

- [ ] G1: `git check-ignore` が、リポジトリの直下と `native/tauri-app/` の下の `x.p12`・`AuthKey_X.p8`・`x.cer`・`x.provisionprofile`・`x.mobileprovision` をすべて無視の対象と答える（`scripts/*.test.mjs` の単体テスト）
- [ ] G2: `git ls-files` の出力に、拡張子が `.p12`・`.p8`・`.cer`・`.provisionprofile`・`.mobileprovision` のファイルが無い（同上）

**今の振る舞いを変えない**:

- [ ] U1: `scripts/tauri-signing.mjs`・`scripts/tauri-signing.test.mjs`・`scripts/build-tauri-signed.mjs`・`scripts/verify-tauri-bundle.mjs` は変更されない（基準点からの `git diff --name-only` が空）。`tauri-signing.test.mjs` の S3-G1〜S3-G7 が合格する
- [ ] U2: `package.json` の `dev`・`start`・`build:tauri`・`build:tauri:signed`・`verify:tauri-bundle` のスクリプトの値は、基準点の `package.json`（`git show <基準点>:package.json`）の同名の値と文字列で等しい（`scripts/*.test.mjs` の単体テストで比べる。基準点のコミットはテストの定数に持つ）
- [ ] U3: `native/tauri-app/tauri.conf.json` の `bundle.targets` は `"app"` のままである（器の設定の検査テスト）
- [ ] U4: `server/` と `web/` は変更されない（基準点からの `git diff --name-only -- server web` が空）
- [ ] U5: S1 の PR で、`native/tauri-app/tauri.conf.json` に `"version": "0.1.0"` を置く（決定 P3。PR の差分で確かめる一度限りの項目で、常設のテストにはしない）
- [ ] U6: `tauri.conf.json` の `version` は、`native/tauri-app/Cargo.toml` の `package.version` と等しい（器の設定の検査テスト。常設。版を上げるときに片方だけ上げる漏れを塞ぐ）
- [ ] U7: `scripts/tauri-signing.mjs` の `APP_IDENTIFIER` は、`native/tauri-app/tauri.conf.json` の `identifier` と等しい（`scripts/*.test.mjs` の単体テスト。配布物の entitlements の識別子と器の識別子の食い違いを塞ぐ）

**文書**:

- [ ] W1: リポジトリの `CLAUDE.md` の「よく使うコマンド」に、配布用のビルドと配布物の検査のコマンドがある（値は環境変数で渡し、リポジトリに書かないことの注記つき）
- [ ] W2: `docs/features/secure-transport-byok.md` の仮定 A23 に、Developer ID の配布ではプロファイルが要る（この仕様の決定 1）旨と、Apple Development の `build:tauri:signed` での要否は未実測のままである旨が書かれている

**品質ゲート**:

- [ ] Q1: `npm run lint` が合格する
- [ ] Q2: `npm run typecheck` が合格する
- [ ] Q3: `npm test` が合格する
- [ ] Q4: `npm run test:rust` が合格する
- [ ] Q5: `npm run test:tauri` が合格する
- [ ] Q6: `npm run check:ios`・`npm run check:android` が合格する
- [ ] Q7: `npm run lint:rust`・`npm run fmt:rust` が合格する

（日付の境界に触らないため、`test:tz` は対象にしない。）

## 手動の確認手順（S1）

オーナーが開発機（macOS・Apple シリコン）で行う。**証明書・チーム ID・Apple ID・API キーの値は、リポジトリのファイル・PR・Issue に書かない**（リポジトリは public）。結果を S1 の PR に記録するときは、名前・チーム ID・キー ID を伏せる（例: `Developer ID Application: <名前> (<チーム ID>)`）。ビルドのログをそのまま貼らない。

**準備**（オーナー。この仕様の作成では行っていない。S1 の出荷条件）:

| 準備 | 内容 | 確かめ方 |
|---|---|---|
| Apple Developer Program | 個人で登録する（年会費。決定 O1）。オーナーがアカウントの保有者（Account Holder）になる | developer.apple.com のアカウントにメンバーシップが表示される |
| Developer ID Application の証明書 | アカウントの保有者（個人の登録ではオーナー本人）が作り、ログインキーチェーンに入れる（秘密鍵ごと） | `security find-identity -v -p codesigning` に `Developer ID Application: …` が 1 件出る |
| App ID | 識別子 `dev.aiboss.app`（決定 O4）の明示的な App ID を登録する | developer.apple.com の Identifiers に出る |
| Developer ID のプロビジョニングプロファイル | 種類 Developer ID・プラットフォーム macOS・上の App ID・上の証明書で作り、**リポジトリの外**に置く | ファイルがある。`security cms -D -i <ファイル>` の `Entitlements` に `com.apple.application-identifier` が `<チーム ID>.<識別子>` で出る |
| 公証の資格情報 | App Store Connect の API キー（決定 P1。役割 Developer 以上・`.p8` を**リポジトリの外**に置く） | `xcrun notarytool history --key <パス> --key-id <ID> --issuer <ID>` が認証エラーにならない |

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | 環境変数（署名 ID・チーム ID・プロファイルのパス・API キーの 3 つ）をシェルで渡して `npm run build:tauri:dist` を実行する。シェルに `APPLE_ID`・`APPLE_PASSWORD`・`APPLE_CERTIFICATE`・`APPLE_CERTIFICATE_PASSWORD` を置かない（置いてあると D12・D13 で止まる） | 0 で終わる。スクリプトが DMG の公証の `Accepted` の行を出す。続けて `xcrun notarytool history --key <パス> --key-id <ID> --issuer <ID>` を実行し、最新の 2 件（`.app` の zip と DMG）の状態が `Accepted` である |
| 2 | `APPLE_TEAM_ID=<チーム ID> npm run verify:tauri-dist` を実行する（チーム ID はシェルの環境変数で渡す。V4）。あわせて、手で `hdiutil attach -readonly -nobrowse -mountpoint <一時ディレクトリ> <dmg>` でマウントし、中の `.app` に `spctl -a -vv -t exec`・`xcrun stapler validate`・`codesign --verify --deep --strict --verbose=2`・`codesign -dvv` を、DMG に `spctl -a -vv -t open --context context:primary-signature`・`xcrun stapler validate` を実行し、`hdiutil detach <一時ディレクトリ>` で外す | 検査が 0 で終わる。`spctl` は `.app`・DMG とも `accepted` と `source=Notarized Developer ID` を返す。`stapler validate` は両方で `The validate action worked!` を返す。`codesign --verify` は `valid on disk` と `satisfies its Designated Requirement` を返す。`codesign -dvv` は `flags=` に `runtime` を含み、`Notarization Ticket=stapled` の行を含む（staple の観測。仮定 B4） |
| 3 | `npm run verify:tauri-bundle` を実行する | 合格する（`node`・`node_modules` が無い） |
| 4 | DMG を、**この配布物をまだ一度も開いていない・判定していない Mac か別のユーザーのアカウント**へ、ブラウザのダウンロードか AirDrop で移す（隔離属性が付く。`xattr -p com.apple.quarantine <dmg>` で値が出ることを確かめる）。その Mac で**先に**ネットワークを切り（Wi-Fi を切る）、DMG を開いて `.app` を「アプリケーション」へ入れて開く | 「開発元を確認できない」の警告は出ずに開ける（staple が効いている）。**staple の担保は自動の検査（V16）を正とし、この手順は補助とする**（同じ Mac で先にオンラインで判定すると、判定の結果が残って staple の有無を見分けられないことがあるため、オフラインを先に行う） |
| 5 | 手順 4 の Mac でネットワークをつなぎ直し、DMG から新しく入れ直した `.app`（隔離属性つき）を開く | 「開発元を確認できない」の警告は出ない。出るのは、インターネットから入手したアプリを初めて開く確認だけで、その文面に Apple が悪質なソフトウェアを確認済みである旨が含まれる。「開く」で製品版のダッシュボードが表示される（画面の写しを PR に貼る） |
| 6 | 公証済みの `.app` の設定画面で、自分の Anthropic の API キーを登録する。アプリを終了して起動し直す | 「登録済み」になり、入力欄が空になる。起動し直しても「登録済み」のまま。失敗したら表示された種類と OSStatus を記録する（`-34018` ならプロファイル・entitlement の不足） |
| 7 | タスクを 1 件以上登録してから、チャットで話しかけ、続けて朝会を始める（#581 の手動の確認手順（S3）の 6・8 と同じ） | ボスの応答が逐次表示される。朝会の開始の発言が、登録したタスクの名前か件数に触れている（目視） |
| 8 | 証跡ファイルを 1 つ添えて保存し、メニューバーのアイコンの「開く」「終了」を試す（#579 S3・S4 の手動の確認と同じ）。催促の通知が出る状況（未着手のタスクを置いて閾値の時間を待つ、または #579 S3 の手動の確認の通知の手順）を作る | 保存できる。トレイの操作が未署名の版と同じに動く。macOS の通知が表示される（初回は通知の許可を求められうる。表示された内容を記録する）（hardened runtime で壊れていない） |
| 9 | 署名・公証を済ませた後で `npm run build:tauri` を実行し、`codesign -dv native/tauri-app/target/release/bundle/macos/ai-boss.app` と `plutil -p …/Contents/Info.plist` を見る。続けて `APPLE_TEAM_ID=<チーム ID> npm run verify:tauri-dist` をもう一度実行する | `Signature=adhoc` のまま（今の振る舞い）。`CFBundleShortVersionString` は手順 1 の配布物と同じ版。`build:tauri` は `bundle/macos/ai-boss.app` を ad-hoc 署名の `.app` で上書きするが、検査は DMG の中の `.app` を見る（V5）ため、検査は手順 2 と同じく 0 で終わる（配る DMG は `build:tauri` の影響を受けない） |
| 10 | `git status --short` を見る | 証明書・プロファイル・API キー・生成した entitlements が未追跡のファイルとして出ない |
| 11 | （既知の失敗の確認・任意）`APPLE_SIGNING_IDENTITY` に Apple Development の証明書の名前を渡して `npm run build:tauri:dist` を実行する | Tauri のビルドが始まらずに 0 以外で終わり、`Developer ID Application` を含む文言が出る |

## 決定（2026-10-05）

| ID | 論点 | 決定 | 決めた人 | 反映先 |
|---|---|---|---|---|
| — | #587 を先に進め、S1 を「試用者に配れる macOS 版の署名・公証」にする（ストア申請・自動更新は後のスライス） | 確定（FR-13 で承認） | ★オーナー | 概要・スライス |
| — | Windows の扱い | 後続リリース（この仕様の範囲外） | ★オーナー（#590・2026-09-26） | やらないこと |
| — | 未署名の `.app` でキーを登録できないこと・キーの属性を変えないこと | #581 決定 Q7 のまま | ★オーナー（2026-09-29） | 背景・技術的な制約・決定 1 |
| O1 | Apple Developer Program の登録と、Developer ID の証明書・プロファイルの用意 | **個人で登録する**（登録済み、またはこれから登録する）。証明書・App ID・プロファイルの作成はオーナーが行う。手動の確認手順の準備は個人のアカウント（オーナーが保有者）を前提にする。代替案: 組織で登録（D-U-N-S 番号が要る）／登録しない | ★オーナー | 手動の確認手順（S1）の準備・スライス S1 |
| O2 | 試用者への配布の形 | **DMG・直接の受け渡し（AirDrop・個別のクラウドのリンク）・自動更新なし（新しい版は手で配り直す）・Apple シリコン（arm64）のみ**。代替案: zip／GitHub Releases での公開／universal | ★オーナー | 決定 4・受入基準 B4・N1〜N8・V1・V17・やらないこと |
| O3 | 試用者が使う LLM の経路 | **オーナーが試用者ごとに Anthropic の API キーを発行して渡し、試用者がアプリの BYOK に登録する**。アプリから見れば BYOK と同じ経路で、S1 は中継の URL を渡さずにビルドする。キーを人に渡すことの規約上の扱いは未確認で、**オーナーが確認する事項**とする（受入基準には入れない。仮定 B7）。代替案: 試用者が各自のキーを用意する／中継を使えるようにしてから配る | ★オーナー | やらないこと・仮定 B7・手動の確認手順 6 |
| O4 | 識別子 `dev.aiboss.app` を最初の配布の前に変えるか | **変えない**（`dev.aiboss.app` のまま。Tauri の `.app` で終わる識別子の警告は受け入れる）。識別子の変更の独立チケットは作らない。代替案: 所有するドメインに基づく識別子へ変える | ★オーナー | 決定 1・受入基準 B1・V14・U7・手動の確認手順の準備 |
| P1 | 公証の資格情報の方式 | **App Store Connect の API キー**（`APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH`）。Apple ID とアプリ用パスワードの方式は、Tauri がパスワードを `notarytool` の引数に載せるため採らない | 親 | 決定 2・受入基準 D10〜D13・N1・K1・K2 |
| P2 | 配布用のビルドの入口 | **`build:tauri:signed` と別の入口**（決定 5） | 親 | 決定 5・受入基準 U1・U2 |
| P3 | 版番号の置き場所 | **`tauri.conf.json` に `version` を置き、`0.1.0` から始める**。S1 では版を手で上げ、上げるときは `native/tauri-app/Cargo.toml` の `package.version` も同じ値にする（U6 で一致を固定） | 親 | 受入基準 U5・U6 |
| P4 | 配布物の検査の自動化の範囲 | **判定の純粋関数は単体テスト、実際の実行は npm スクリプトを手動の確認手順から呼ぶ**（決定 3） | 親 | 決定 3・受入基準 V1〜V18・手動の確認手順 2 |
| P5 | DMG を公証するか | **公証し staple する**（決定 4） | 親 | 決定 4・受入基準 N1〜N8・V16・V17 |
| P6 | Developer ID の配布でプロファイルを必須にするか | **必須にし、entitlements を 3 つ（`keychain-access-groups`・`com.apple.application-identifier`・`com.apple.developer.team-identifier`）にする**（決定 1）。#581 の仮定 A23 は、Developer ID の配布については一次情報で「要る」に倒す | 親 | 決定 1・受入基準 D8・D9・B1・V12〜V14・W2 |

## 仮定（軽微・可逆）

- B1: 仕様のファイル名は `docs/features/app-distribution.md` とする。
- B2: スライスを 4 つ（S1 macOS の署名・公証／S2 自動更新と ADR 0001 の追補／S3 iOS の配布／S4 Android の配布）に切る。iOS と Android を分けたのは、器の Issue（#669・#674）と開発者の登録（Apple・Google）が別だからである。
- B3: npm スクリプトの名前は `build:tauri:dist`（配布用のビルド）・`verify:tauri-dist`（配布物の検査）、モジュールは `scripts/tauri-distribution.mjs`・入口は `scripts/build-tauri-dist.mjs`・`scripts/verify-tauri-dist.mjs` とする（`build:tauri:signed`・`verify:tauri-bundle` に揃える）。実装で変えてよい。
- B4: 検査の判定に使う出力の文字列（`valid on disk`・`satisfies its Designated Requirement`・`The validate action worked!`・`source=Notarized Developer ID`・`: accepted`・`Notarization Ticket=stapled`・`does not have a ticket stapled to it`）は、Xcode 26.6 の `codesign`・`stapler`・`spctl` の出力の形に拠る。この起動ではホストに署名 ID が無く、合格の出力を実測していない（不合格の出力〔ad-hoc の `.app`〕は実測した）。手動の確認手順 2 で合格の出力を実測し、形が違えば S1 の実装で判定を直す。
- B5: 手動の確認手順 4 の「まだ開いていない・判定していない Mac か別のユーザーのアカウント」は、隔離属性の付いた状態で初めて開く体験を再現し、先のオンラインの判定の結果が残らないようにするためのもの。同じ Mac で先にオンラインで判定すると staple の有無を見分けられないことがある（推論）ため、staple の担保は自動の検査（V16）を正とする。
- B6: 識別子は、この仕様では `<識別子>` と書く。値は `dev.aiboss.app`（決定 O4）で、`scripts/tauri-signing.mjs` の `APP_IDENTIFIER` から取る（実装計画の 2・U7）。
- B7: 試用者へ渡すキーは、オーナーが Anthropic のコンソールで試用者ごとに発行する（利用額の上限・個別の無効化はオーナーの運用）。試用者へキーを渡すことが Anthropic の規約上許されるかはオーナーが確認する（決定 O3。未確認）。アプリはこれを区別せず、BYOK のキーとして扱う。
- B8: 配る DMG の名前は `ai-boss_<version>_aarch64.dmg` で、置き場所は `native/tauri-app/target/release/bundle/dmg/`（Tauri CLI 2.12.0 の `dmg/mod.rs` 40〜56 行。`productName` は `ai-boss`）。Tauri はビルドのたびにこのディレクトリを消して作り直す（同 68〜73 行）ため、別の `.dmg` が並ぶのは手で置いた場合に限られる。検査はそれをあいまいとして失敗させる（V3）。
- B9: 検査のマウント先は一時ディレクトリ（`-mountpoint`）にする。マウント先を決め打ちにすることで、`hdiutil attach` の出力からマウント先を読み取る処理を持たない。
