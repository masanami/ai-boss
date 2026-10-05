# 署名・公証・ストア申請とアプリ本体の自動更新（製品版の配布）

> Issue #587。2026-10-05 に作成した。範囲と前提は、ADR 0011 の決定 5・9〜11・19、#590 のオーナーの決定（2026-09-26。Windows は後続リリース）、#581 のオーナーの決定 Q7（未署名の `.app` ではデータ保護キーチェーンへ登録できない）に拠る。**オーナーは 2026-10-05、友人・身内に試してもらう段階に入るため、#587 を先に進め、最小スライス S1 を「試用者に配れる macOS 版の署名・公証」にすると決めた**（FR-13 で承認済み。ストア申請・自動更新は後のスライス）。同日、作成時点の未決（オーナーへの問い O1〜O4・親への問い P1〜P6）が決まった（★ はオーナーの決定。「決定（2026-10-05）」節）。

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

### 2. 公証の資格情報が無ければ、Tauri のビルドを始めずに失敗する（作成者の判断・2026-10-05）

- **採用案**: 配布用のビルドのスクリプトは、公証の資格情報（App Store Connect の API キー〔`APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH` の 3 つ〕。決定 P1）がそろっていないとき、Tauri のビルドを始めずに 0 以外で終わる。片方の方式だけが中途半端にある（例: `APPLE_API_KEY` だけ）ときも失敗する。
- **理由**: Tauri は資格情報が無いと警告を出して公証を飛ばし、成功の終了コードで終わる（`app.rs` 143〜147 行）。警告はビルドの大量の出力に埋もれる。
- **影響範囲**: 配布用のビルドのスクリプト。

### 3. staple と公証の結果は、Tauri の成功に頼らず検査で確かめる（作成者の判断・2026-10-05）

- **採用案**: 配布物の検査のコマンド（新しい npm スクリプト）が、次をすべて満たすときだけ 0 で終わる。判定は、コマンドの出力から**肯定の事実**を読む純粋関数にする（「エラーが出ない」を合格の根拠にしない）。
  - `codesign --verify --deep --strict --verbose=2 <app>` が 0 で終わり、出力に `valid on disk` と `satisfies its Designated Requirement` がある
  - `codesign -dv --verbose=4 <app>` の `Authority=` の先頭が `Developer ID Application:`、`TeamIdentifier=` が `APPLE_TEAM_ID`、`flags=` に `runtime` がある（`adhoc` が無い）
  - `codesign -d --entitlements - --xml <app>` の entitlements が、決定 1 の 3 つと一致し、`com.apple.security.get-task-allow` を持たない
  - `spctl -a -vv -t exec <app>` の出力に `accepted` と `source=Notarized Developer ID` がある（`source=Developer ID`〔公証されていない〕は不合格）
  - `xcrun stapler validate <app>` が 0 で終わり、出力に `The validate action worked!` がある
  - 配布物が DMG なら、DMG について `spctl -a -vv -t open --context context:primary-signature <dmg>` が `accepted` と `source=Notarized Developer ID` を返し、`xcrun stapler validate <dmg>` が成功する
- **理由**: Tauri の `staple_app` は `stapler` の終了コードを見ない。staple が漏れると、オフラインの Mac で Gatekeeper が公証を確かめられず拒否する。
- **影響範囲**: `scripts/`（検査のスクリプトとテスト）・`package.json`。

### 4. DMG も公証し staple する（P5・【決定】2026-10-05・親。配布の形は DMG＝決定 O2）

- **採用案**: Tauri のビルド（`.app` の署名・公証・staple と、DMG の作成・署名）が成功した後、スクリプトが DMG を `xcrun notarytool submit <dmg> --wait` で公証し、`xcrun stapler staple <dmg>` で staple する。どちらかが 0 以外で終われば、スクリプトも 0 以外で終わる。
- **理由**: Tauri は DMG を公証も staple もしない（`dmg/mod.rs`）。中の `.app` は staple 済みだが、外側の DMG が公証されていないと、ダウンロードした DMG を開くときの Gatekeeper の判定が `.app` の判定と食い違いうる（DMG の判定の結果は**推論**。手動の確認手順で観測する）。公証の送信が 1 回増えるだけで、配る物の全体を公証済みにできる。
- **代替案**: (a) DMG を公証しない — 上の不確かさを残す。(b) zip で配る — 公証は `.app` の分だけで済むが、zip は staple できない（中の `.app` の staple は残る）。配布の形は DMG に決まった（決定 O2）。

### 5. 配布用のビルドは、今の `build:tauri`・`build:tauri:signed` と別の入口にする（P2・【決定】2026-10-05・親）

- **採用案**: 新しい npm スクリプト（仮に `build:tauri:dist`）と、組み立ての純粋関数のモジュール（仮に `scripts/tauri-distribution.mjs`）・入口（`scripts/build-tauri-dist.mjs`）を足す。チーム ID の形の検査など共通の部品は `tauri-signing.mjs` から import してよいが、**`tauri-signing.mjs` の既存の関数の振る舞いと `tauri-signing.test.mjs` は変えない**。`tauri.conf.json` の `bundle.targets` は `"app"` のままにし、DMG は配布用のビルドの `--bundles` の引数で指定する。
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
| 証明書の種類の取り違え（Apple Development・Apple Distribution・Developer ID Installer を渡す） | 署名 ID が `Developer ID Application:` で始まらなければ失敗する（D2）。検査で `Authority=` の先頭を確かめる（V3a） |
| 署名 ID のチーム ID と `APPLE_TEAM_ID` が食い違う（entitlements のアクセスグループが別のチームを指す） | 署名 ID の末尾の `(<チーム ID>)` と `APPLE_TEAM_ID` が一致しなければ失敗する（D4）。検査で `TeamIdentifier=` を確かめる（V3b） |
| 証明書の失効・期限切れ | Tauri の署名（`codesign`）か公証で失敗し、ビルドが 0 以外で終わる。検査の `codesign --verify` と `spctl` でも不合格になる（V1・V4）。期限の管理そのものは「やらないこと」 |
| プロビジョニングプロファイルが無い・App ID が違う・期限切れ（キーチェーンの entitlement が認可されず、起動しないか登録が `-34018`） | プロファイルを必須にする（D5）。entitlements を決定 1 の 3 つに固定する（D8）。プロファイルの中身（App ID・期限）の照合は自動にしない（**推論**で中身の形式を固定しないため）。公証済みの配布物でキーを登録できることを手動の確認手順 6 で確かめる |
| 公証の資格情報が無く、Tauri が公証を飛ばして成功する | スクリプトが Tauri のビルドを始めずに失敗する（D6・D7）。検査で `source=Notarized Developer ID` を確かめる（V4） |
| hardened runtime が外れる（公証が拒否する） | 設定の上書きで `hardenedRuntime: true` を明示する（D10）。検査で `flags=` の `runtime` を確かめる（V3c） |
| hardened runtime と entitlements の衝突（WKWebView・通知・ファイルの保存が hardened runtime で動かない） | 例外の entitlement は足さない（決定 1）。動くことは手動の確認手順 6〜8（チャット・朝会・証跡の保存・トレイ・通知）で確かめる。動かなければ、足す entitlement を S1 の実装で親に問う（推論の段階で entitlement を広げない） |
| デバッグ用の entitlement（`get-task-allow`）で公証が拒否される | 生成する entitlements に含めないことをテストで固定する（D8）。配布用のビルドは `--debug` を受け付けない（D11）。検査でも不在を確かめる（V3e） |
| 公証の拒否（未署名の入れ子のバイナリ・サイドカー・フレームワーク） | 今の `.app` の実行可能なファイルは 1 つだけ（実測）。入れ子のコードは Tauri が内から外へ署名する。拒否されたら Tauri が `notarytool log` を添えて 0 以外で終わる（`tauri-macos-sign`）。`verify:tauri-bundle`（`node`・`node_modules` の不在）を手動の確認手順 3 で走らせる |
| staple の漏れ（Tauri は `stapler` の失敗を見ない）で、オフラインの Mac の Gatekeeper が拒否する | 検査で `stapler validate` を確かめる（V2・決定 3）。DMG は自分で staple し、終了コードを見る（D14）。オフラインで開けることを手動の確認手順 5 で確かめる |
| DMG が公証されていない | DMG を公証・staple する（決定 4・D14）。検査で DMG の `spctl`・`stapler validate` を確かめる（V5） |
| 秘密情報（証明書・パスワード・API キー・プロファイル）がリポジトリに入る | `.gitignore` に `*.p12`・`*.p8`・`*.cer`・`*.provisionprofile`・`*.mobileprovision` を足し、`git check-ignore` で確かめる（G1）。生成するファイルは `target/` の下に置く（D9）。追跡しているファイルにこれらの拡張子が無いことを確かめる（G2） |
| 秘密情報がスクリプトの出力・ログに出る | スクリプトの失敗の文言・出力に、発行者 ID・API キーのファイルの中身を出さない（D12a・D12b）。スクリプトは API キーをパスで渡し、中身を子プロセスの引数に載せない（D13）。Tauri の Apple ID 方式はパスワードを `notarytool` の引数に載せるため、API キー方式にする（決定 P1）。ビルドのログを PR・Issue へ貼らない（手動の確認手順の記録の規則。リポジトリは public） |
| 識別子を配布の後で変える（データのディレクトリ・キーチェーンのグループが変わり、試用者のデータと登録したキーが見えなくなる） | `dev.aiboss.app` のまま変えないと決めた（決定 O4）。App ID・プロファイルはこの識別子で作る。U6 で、配布用のビルドの識別子と器の識別子が等しいことを固定する |
| arm64 のみの配布物を Intel の Mac の試用者が受け取る（起動しない） | arm64 のみで配ると決めた（決定 O2）。配るときに Apple シリコン専用と伝える |
| 試用者がキーを登録できない（BYOK）・中継が使えない | オーナーが試用者ごとに Anthropic の API キーを発行して渡し、試用者が BYOK に登録する（決定 O3）。S1 は中継の URL を渡さずにビルドする。キーを登録できることは手動の確認手順 6 で確かめる |
| （S2）偽の更新が配られる（配信の置き場所の乗っ取り・中間者） | 更新の署名の検証（外せない）と TLS の強制。秘密鍵をリポジトリの外に置き、ビルドだけに渡す（S2 の受入基準） |
| （S2）更新の署名の秘密鍵を失う | 入っているアプリへ更新を配れなくなる。秘密鍵の保管と控えの方法を S2 で決める（オーナー）。失ったら手で配り直す |
| （S2）更新の通信先が ADR 0001 の許可範囲の外 | 決定 6 の追補を S2 で ADR 0001 に入れる。入るまで updater を配線しない |
| （S2）更新の適用の途中の失敗で起動しなくなる | S2 の仕様で、適用の失敗の扱い（今の版で動き続ける）を受入基準にする |

### 実装計画（S1 のチケット分解の見通し）

S1 は 1 チケットで足りる見込み（触るファイルは 12 前後）。

1. `.gitignore` に秘密情報の拡張子を足し、`git check-ignore` の検査を `scripts/*.test.mjs` に置く
2. 配布用のビルドの組み立て（`scripts/tauri-distribution.mjs`）と単体テスト（環境変数の検査・entitlements・設定の上書き・Tauri の引数・DMG の公証と staple の順序と失敗の伝播・出力に秘密情報を出さない）
3. 入口 `scripts/build-tauri-dist.mjs` と npm スクリプト `build:tauri:dist`
4. 配布物の検査の判定（純粋関数）と単体テスト（記録した出力の例で合格・不合格）と、入口 `scripts/verify-tauri-dist.mjs`・npm スクリプト `verify:tauri-dist`
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

**配布用のビルドの組み立て**（副作用を差し替えた単体テスト。Tauri の CLI は起動しない）:

- [ ] D1: `APPLE_SIGNING_IDENTITY` が無いと、Tauri のビルドを始めずに 0 以外の終了コードで終わる
- [ ] D2: `APPLE_SIGNING_IDENTITY` が `Developer ID Application:` で始まらない（例: `Apple Development: Taro (ABCDE12345)`・`Apple Distribution: Taro (ABCDE12345)`・`Developer ID Installer: Taro (ABCDE12345)`）と、Tauri のビルドを始めずに 0 以外で終わり、失敗の文言に `Developer ID Application` を含む
- [ ] D3: `APPLE_TEAM_ID` が無い・英大文字と数字の 10 文字でない（例: `abc`・`ABCDEFGHIJK`）と、Tauri のビルドを始めずに 0 以外で終わる
- [ ] D4: `APPLE_SIGNING_IDENTITY` の末尾の括弧の中（例: `Developer ID Application: Taro (ABCDE12345)` の `ABCDE12345`）が `APPLE_TEAM_ID` と一致しないと、Tauri のビルドを始めずに 0 以外で終わる。一致するときはビルドへ進む
- [ ] D5: `APPLE_PROVISIONING_PROFILE` が無い、または指すパスにファイルが無いと、Tauri のビルドを始めずに 0 以外で終わる（ファイルの有無の確認は差し替えられる依存にする）
- [ ] D6: 公証の資格情報（`APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH`）が 1 つも無いと、Tauri のビルドを始めずに 0 以外で終わる
- [ ] D7: 公証の資格情報が欠けている（例: API キー方式で `APPLE_API_KEY` と `APPLE_API_ISSUER` があり `APPLE_API_KEY_PATH` が無い・`APPLE_API_KEY` だけがある）と、Tauri のビルドを始めずに 0 以外で終わる
- [ ] D8: 生成する entitlements の鍵は（`<識別子>` は `scripts/tauri-signing.mjs` の `APP_IDENTIFIER` を import して使う。テストは期待値に `APP_IDENTIFIER` を使う）、`keychain-access-groups`（`[<APPLE_TEAM_ID>.<識別子>]` の 1 要素）・`com.apple.application-identifier`（`<APPLE_TEAM_ID>.<識別子>`）・`com.apple.developer.team-identifier`（`<APPLE_TEAM_ID>`）の 3 つちょうどである（`com.apple.security.get-task-allow` を含まない）
- [ ] D9: 生成するファイル（entitlements・設定の上書き）は `native/tauri-app/target/` の下に置かれる
- [ ] D10: Tauri へ渡す設定の上書きは、`bundle.macOS.signingIdentity` に `APPLE_SIGNING_IDENTITY`、`bundle.macOS.entitlements` に生成したファイル、`bundle.macOS.hardenedRuntime` に `true`、`bundle.macOS.files` の `embedded.provisionprofile` に `APPLE_PROVISIONING_PROFILE` を持つ
- [ ] D11: Tauri の CLI の引数は `build`・`--config <生成した上書き>`・`--bundles app,dmg` を含み、`--debug` を含まない。スクリプトに `--debug` を渡すと、Tauri のビルドを始めずに 0 以外で終わる
- [ ] D12a: D1〜D7・D11 の失敗の文言と、スクリプト自身が書き出す行（`logError`・`log` の依存に渡す文字列。成功の経路を含む）に、`APPLE_API_ISSUER` に渡した値が含まれない（テストは、他の文字列に現れない値を渡して確かめる。子プロセス〔Tauri・`xcrun`〕がそのまま出す出力は対象外）
- [ ] D12b: 同じ範囲に、`APPLE_API_KEY_PATH` が指すファイルの中身（テストでは差し替えた読み込みが返す値）が含まれない（スクリプトはキーのファイルを読まない）
- [ ] D13: スクリプトが起動する子プロセス（Tauri の CLI・`xcrun`）の引数のどれにも、`APPLE_API_KEY_PATH` が指すファイルの中身が含まれない（キーはパスで渡す）
- [ ] D14: Tauri のビルドが 0 で終わると、DMG について `xcrun notarytool submit <dmg> --wait`（`--key <APPLE_API_KEY_PATH> --key-id <APPLE_API_KEY> --issuer <APPLE_API_ISSUER>` つき）、続けて `xcrun stapler staple <dmg>` の順に起動する。`notarytool` は `--output-format json` で起動し、**出力の JSON の `status` が `Accepted` のときだけ**成功とみなす（判定は純粋関数。`Accepted`・`Invalid`・`Rejected`・JSON でない出力の記録した例で単体テストする）。`notarytool` が 0 以外で終わるか `status` が `Accepted` でないと、`stapler` を起動せずに 0 以外で終わる。`stapler` が 0 以外で終わると 0 以外で終わる。公証が `Accepted` で `stapler` が 0 のときだけ 0 で終わり、`Accepted` の事実（提出の ID つき）を 1 行出す
- [ ] D15: Tauri のビルドが 0 以外で終わると、`xcrun` を起動せずに同じく 0 以外で終わる

**配布物の検査**（判定は純粋関数。記録した出力の例を入力にする単体テスト）:

- [ ] V1: `codesign --verify --deep --strict --verbose=2` の判定は、終了コードが 0 で、出力に `valid on disk` と `satisfies its Designated Requirement` の両方があるときだけ合格にする（終了コードが 0 でも片方が無ければ不合格）
- [ ] V2: `xcrun stapler validate` の判定は、終了コードが 0 で、出力に `The validate action worked!` があるときだけ合格にする
- [ ] V3a: `codesign -dv --verbose=4` の判定は、最初の `Authority=` の行が `Developer ID Application:` で始まるときだけ合格にする（`Authority=Apple Development: …` の例で不合格）
- [ ] V3b: 同じ出力の判定は、`TeamIdentifier=` が期待するチーム ID と等しいときだけ合格にする（`TeamIdentifier=not set`・別のチーム ID の例で不合格）
- [ ] V3c: 同じ出力の判定は、`flags=` に `runtime` を含み `adhoc` を含まないときだけ合格にする（`flags=0x20002(adhoc,linker-signed)`・`flags=0x0(none)` の例で不合格）
- [ ] V3d: `codesign -d --entitlements - --xml` の判定は、entitlements の鍵と値が D8 の 3 つと一致するときだけ合格にする（`keychain-access-groups` だけの例〔今の `build:tauri:signed` の形〕で不合格）
- [ ] V3e: 同じ出力の判定は、`com.apple.security.get-task-allow` を持つと不合格にする
- [ ] V4: `spctl -a -vv -t exec` の判定は、出力に `: accepted` と `source=Notarized Developer ID` の両方があるときだけ合格にする（`source=Developer ID`〔公証されていない〕・`: rejected`・`source=no usable signature` の例で不合格になる）
- [ ] V5: DMG の `spctl -a -vv -t open --context context:primary-signature` の判定は V4 と同じ条件で、DMG の `stapler validate` の判定は V2 と同じ条件で合格にする
- [ ] V6: 検査の入口は、V1〜V5（V3a〜V3e を含む）の判定のうち 1 つでも不合格なら 0 以外で終わり、不合格の項目の名前を標準エラーに出す。すべて合格のときだけ 0 で終わる（コマンドの実行を差し替えた単体テスト）
- [ ] V7: 検査の対象の `.app`・DMG が見つからないとき、検査の入口は 0 以外で終わる（「対象なし」を合格にしない）

**秘密情報**:

- [ ] G1: `git check-ignore` が、リポジトリの直下と `native/tauri-app/` の下の `x.p12`・`AuthKey_X.p8`・`x.cer`・`x.provisionprofile`・`x.mobileprovision` をすべて無視の対象と答える（`scripts/*.test.mjs` の単体テスト）
- [ ] G2: `git ls-files` の出力に、拡張子が `.p12`・`.p8`・`.cer`・`.provisionprofile`・`.mobileprovision` のファイルが無い（同上）

**今の振る舞いを変えない**:

- [ ] U1: `scripts/tauri-signing.mjs`・`scripts/tauri-signing.test.mjs`・`scripts/build-tauri-signed.mjs`・`scripts/verify-tauri-bundle.mjs` は変更されない（基準点からの `git diff --name-only` が空）。`tauri-signing.test.mjs` の S3-G1〜S3-G7 が合格する
- [ ] U2: `package.json` の `dev`・`start`・`build:tauri`・`build:tauri:signed`・`verify:tauri-bundle` のスクリプトの値は、基準点の `package.json`（`git show <基準点>:package.json`）の同名の値と文字列で等しい（`scripts/*.test.mjs` の単体テストで比べる。基準点のコミットはテストの定数に持つ）
- [ ] U3: `native/tauri-app/tauri.conf.json` の `bundle.targets` は `"app"` のままである（器の設定の検査テスト）
- [ ] U4: `server/` と `web/` は変更されない（基準点からの `git diff --name-only -- server web` が空）
- [ ] U6: `scripts/tauri-signing.mjs` の `APP_IDENTIFIER` は、`native/tauri-app/tauri.conf.json` の `identifier` と等しい（`scripts/*.test.mjs` の単体テスト。配布物の entitlements の識別子と器の識別子の食い違いを塞ぐ）
- [ ] U5: `tauri.conf.json` の `version` は `0.1.0` で（決定 P3）、`native/tauri-app/Cargo.toml` の `package.version` と等しい（器の設定の検査テスト。`build:tauri` の `.app` の版が変わらないことの担保）

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
| 1 | 環境変数（署名 ID・チーム ID・プロファイルのパス・公証の資格情報）をシェルで渡して `npm run build:tauri:dist` を実行する | 0 で終わる。スクリプトが DMG の公証の `Accepted` の行を出す。続けて `xcrun notarytool history`（公証の資格情報の引数つき）を実行し、最新の 2 件（`.app` の zip と DMG）の状態が `Accepted` である |
| 2 | `npm run verify:tauri-dist` を実行する。あわせて、`spctl -a -vv -t exec <app>`・`xcrun stapler validate <app>`・`codesign --verify --deep --strict --verbose=2 <app>`・`codesign -dv --verbose=4 <app>`・DMG の `spctl -a -vv -t open --context context:primary-signature <dmg>`・`xcrun stapler validate <dmg>` を手で実行する | 検査が 0 で終わる。`spctl` は `.app`・DMG とも `accepted` と `source=Notarized Developer ID` を返す。`stapler validate` は両方で `The validate action worked!` を返す。`codesign --verify` は `valid on disk` と `satisfies its Designated Requirement` を返す。`codesign -dv` は `flags=` に `runtime` を含む |
| 3 | `npm run verify:tauri-bundle` を実行する | 合格する（`node`・`node_modules` が無い） |
| 4 | DMG を、ブラウザのダウンロードか AirDrop で、**別の Mac か別のユーザーのアカウント**へ移す（隔離属性が付く。`xattr -p com.apple.quarantine <dmg>` で値が出ることを確かめる）。DMG を開き、`.app` を「アプリケーション」へ入れて開く | 「開発元を確認できない」の警告は出ない。出るのは、インターネットから入手したアプリを初めて開く確認だけで、その文面に Apple が悪質なソフトウェアを確認済みである旨が含まれる。「開く」で製品版のダッシュボードが表示される（画面の写しを PR に貼る） |
| 5 | 手順 4 の Mac でネットワークを切り（Wi-Fi を切る）、DMG から新しく入れ直した `.app`（隔離属性つき）を開く | 手順 4 と同じく開ける（staple が効いている） |
| 6 | 公証済みの `.app` の設定画面で、自分の Anthropic の API キーを登録する。アプリを終了して起動し直す | 「登録済み」になり、入力欄が空になる。起動し直しても「登録済み」のまま。失敗したら表示された種類と OSStatus を記録する（`-34018` ならプロファイル・entitlement の不足） |
| 7 | タスクを 1 件以上登録してから、チャットで話しかけ、続けて朝会を始める（#581 の手動の確認手順（S3）の 6・8 と同じ） | ボスの応答が逐次表示される。朝会の開始の発言が、登録したタスクの名前か件数に触れている（目視） |
| 8 | 証跡ファイルを 1 つ添えて保存し、メニューバーのアイコンの「開く」「終了」を試す（#579 S3・S4 の手動の確認と同じ）。催促の通知が出る状況（未着手のタスクを置いて閾値の時間を待つ、または #579 S3 の手動の確認の通知の手順）を作る | 保存できる。トレイの操作が未署名の版と同じに動く。macOS の通知が表示される（初回は通知の許可を求められうる。表示された内容を記録する）（hardened runtime で壊れていない） |
| 9 | 署名・公証を済ませた後で `npm run build:tauri` を実行し、`codesign -dv native/tauri-app/target/release/bundle/macos/ai-boss.app` と `plutil -p …/Contents/Info.plist` を見る | `Signature=adhoc` のまま（今の振る舞い）。`CFBundleShortVersionString` は手順 1 の配布物と同じ版 |
| 10 | `git status --short` を見る | 証明書・プロファイル・API キー・生成した entitlements が未追跡のファイルとして出ない |
| 11 | （既知の失敗の確認・任意）`APPLE_SIGNING_IDENTITY` に Apple Development の証明書の名前を渡して `npm run build:tauri:dist` を実行する | Tauri のビルドが始まらずに 0 以外で終わり、Developer ID Application の証明書を求める文言が出る |

## 決定（2026-10-05）

| ID | 論点 | 決定 | 決めた人 | 反映先 |
|---|---|---|---|---|
| — | #587 を先に進め、S1 を「試用者に配れる macOS 版の署名・公証」にする（ストア申請・自動更新は後のスライス） | 確定（FR-13 で承認） | ★オーナー | 概要・スライス |
| — | Windows の扱い | 後続リリース（この仕様の範囲外） | ★オーナー（#590・2026-09-26） | やらないこと |
| — | 未署名の `.app` でキーを登録できないこと・キーの属性を変えないこと | #581 決定 Q7 のまま | ★オーナー（2026-09-29） | 背景・技術的な制約・決定 1 |
| O1 | Apple Developer Program の登録と、Developer ID の証明書・プロファイルの用意 | **個人で登録する**（登録済み、またはこれから登録する）。証明書・App ID・プロファイルの作成はオーナーが行う。手動の確認手順の準備は個人のアカウント（オーナーが保有者）を前提にする。代替案: 組織で登録（D-U-N-S 番号が要る）／登録しない | ★オーナー | 手動の確認手順（S1）の準備・スライス S1 |
| O2 | 試用者への配布の形 | **DMG・直接の受け渡し（AirDrop・個別のクラウドのリンク）・自動更新なし（新しい版は手で配り直す）・Apple シリコン（arm64）のみ**。代替案: zip／GitHub Releases での公開／universal | ★オーナー | 決定 4・受入基準 D11・D14・V5・やらないこと |
| O3 | 試用者が使う LLM の経路 | **オーナーが試用者ごとに Anthropic の API キーを発行して渡し、試用者がアプリの BYOK に登録する**。アプリから見れば BYOK と同じ経路で、S1 は中継の URL を渡さずにビルドする。キーを人に渡すことの規約上の扱いは未確認で、**オーナーが確認する事項**とする（受入基準には入れない。仮定 B7）。代替案: 試用者が各自のキーを用意する／中継を使えるようにしてから配る | ★オーナー | やらないこと・仮定 B7・手動の確認手順 6 |
| O4 | 識別子 `dev.aiboss.app` を最初の配布の前に変えるか | **変えない**（`dev.aiboss.app` のまま。Tauri の `.app` で終わる識別子の警告は受け入れる）。識別子の変更の独立チケットは作らない。代替案: 所有するドメインに基づく識別子へ変える | ★オーナー | 決定 1・受入基準 D8・U6・手動の確認手順の準備 |
| P1 | 公証の資格情報の方式 | **App Store Connect の API キー**（`APPLE_API_KEY`・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH`）。Apple ID とアプリ用パスワードの方式は、Tauri がパスワードを `notarytool` の引数に載せるため採らない | 親 | 決定 2・受入基準 D6・D7・D12・D13・D14 |
| P2 | 配布用のビルドの入口 | **`build:tauri:signed` と別の入口**（決定 5） | 親 | 決定 5・受入基準 U1・U2 |
| P3 | 版番号の置き場所 | **`tauri.conf.json` に `version` を置き、`0.1.0` から始める**。S1 では版を手で上げ、上げるときは `native/tauri-app/Cargo.toml` の `package.version` も同じ値にする（U5 で一致を固定） | 親 | 受入基準 U5 |
| P4 | 配布物の検査の自動化の範囲 | **判定の純粋関数は単体テスト、実際の実行は npm スクリプトを手動の確認手順から呼ぶ**（決定 3） | 親 | 決定 3・受入基準 V1〜V7・手動の確認手順 2 |
| P5 | DMG を公証するか | **公証し staple する**（決定 4） | 親 | 決定 4・受入基準 D14・V5 |
| P6 | Developer ID の配布でプロファイルを必須にするか | **必須にし、entitlements を 3 つ（`keychain-access-groups`・`com.apple.application-identifier`・`com.apple.developer.team-identifier`）にする**（決定 1）。#581 の仮定 A23 は、Developer ID の配布については一次情報で「要る」に倒す | 親 | 決定 1・受入基準 D5・D8・V3d・W2 |

## 仮定（軽微・可逆）

- B1: 仕様のファイル名は `docs/features/app-distribution.md` とする。
- B2: スライスを 4 つ（S1 macOS の署名・公証／S2 自動更新と ADR 0001 の追補／S3 iOS の配布／S4 Android の配布）に切る。iOS と Android を分けたのは、器の Issue（#669・#674）と開発者の登録（Apple・Google）が別だからである。
- B3: npm スクリプトの名前は `build:tauri:dist`（配布用のビルド）・`verify:tauri-dist`（配布物の検査）、モジュールは `scripts/tauri-distribution.mjs`・入口は `scripts/build-tauri-dist.mjs`・`scripts/verify-tauri-dist.mjs` とする（`build:tauri:signed`・`verify:tauri-bundle` に揃える）。実装で変えてよい。
- B4: 検査の判定に使う出力の文字列（`valid on disk`・`satisfies its Designated Requirement`・`The validate action worked!`・`source=Notarized Developer ID`・`: accepted`）は、Xcode 26.6 の `codesign`・`stapler`・`spctl` の出力の形に拠る。この起動ではホストに署名 ID が無く、合格の出力を実測していない（不合格の出力〔ad-hoc の `.app`〕は実測した）。手動の確認手順 2 で合格の出力を実測し、形が違えば S1 の実装で判定を直す。
- B5: 手動の確認手順 4 の「別の Mac か別のユーザーのアカウント」は、隔離属性の付いた状態で初めて開く体験を再現するためのもの。同じアカウントでも隔離属性が付いていれば判定は同じ見込み（推論）。
- B6: 識別子は、この仕様では `<識別子>` と書く。値は `dev.aiboss.app`（決定 O4）で、`scripts/tauri-signing.mjs` の `APP_IDENTIFIER` から取る（D8・U6）。
- B7: 試用者へ渡すキーは、オーナーが Anthropic のコンソールで試用者ごとに発行する（利用額の上限・個別の無効化はオーナーの運用）。試用者へキーを渡すことが Anthropic の規約上許されるかはオーナーが確認する（決定 O3。未確認）。アプリはこれを区別せず、BYOK のキーとして扱う。
