# tauri-plugin-notification（ai-boss のリポジトリ内 fork）

ai-boss の製品版（Tauri アプリ）が使う `tauri-plugin-notification` の fork。機能仕様 `docs/features/scheduled-nudges.md`（#585）のクリティカル設計決定 6 と「S3 の設計」の「通知プラグインの fork」に拠る。器（`native/tauri-app/`）はこのディレクトリを path 依存で使い、crates.io の `tauri-plugin-notification` には依存しない。JS のパッケージ（`@tauri-apps/plugin-notification`）は使わない（web は `invoke("plugin:notification|…")` を直接呼ぶ）。

## 由来

| 項目 | 値 |
|---|---|
| 上流 | `tauri-apps/plugins-workspace` の `plugins/notification` |
| 版 | `2.5.0`（crates.io の配布物 `tauri-plugin-notification-2.5.0.crate`） |
| 上流のコミット | `a2364a5f216324439feedeb25b2db74e7b1eba90`（配布物の `.cargo_vcs_info.json`） |
| ライセンス | `Apache-2.0 OR MIT`（上流の `LICENSE_APACHE-2.0`・`LICENSE_MIT`・`LICENSE.spdx` をそのまま置く） |

配布物の中身は、下の差分を除いてそのまま置いている（`Cargo.toml` は crates.io が正規化したもの、`Cargo.toml.orig` は上流のワークスペースでの原本）。

## 上流からの差分

差分は iOS の Swift だけにする。デスクトップ（`src/desktop.rs`）と Android は変えないため、macOS の即時の通知の振る舞いは変わらない。

1. **差分 1: iOS の予約時刻を UTC として読む**（`ios/Sources/Notification.swift` の `handleScheduledNotification`）。`DateFormatter` の `timeZone` を UTC にした。
   - 理由: 上流は書式 `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` の `Z` を文字として読み、`timeZone` を指定しないため、UTC の時刻を端末の時間帯の時刻として読む（JST では 9 時間早くなり、過去の時刻として拒否される。#576 の実測・上流 issue tauri-apps/plugins-workspace#3256）。
   - Swift に届く文字列: JS が渡した `date`（例 `2026-10-02T00:00:00.000Z`）は、Rust の `NotificationData` で `time::OffsetDateTime` に読まれ、`src/models.rs` の `iso8601::serialize`（`time` の `Iso8601` の既定の設定: 小数部 9 桁・UTC は末尾 `Z`）で書き直されてから渡る（例 `2026-10-02T00:00:00.000000000Z`）。書式はこの形を読めること（2.4.0 の同じ書式でも、時差の分ずれただけで解釈はできていた〔#576〕）。実機・シミュレータで届いた文字列は、PR の手動の確認の結果に記録する。
   - JS 側で時差を補正しない（`spike/ios-tauri` の `localWallClockAsUtc` は採らない。上流が直った時点で黙って逆方向にずれるため）。
2. **差分 2: iOS の `show` は `UNUserNotificationCenter.add` の完了を待ってから応答し、`add` の失敗を拒否で返す**（`ios/Sources/NotificationPlugin.swift`）。
   - 上流は `add` の完了を待たずに `invoke.resolve` を呼ぶため、`add` が失敗して完了ハンドラが `invoke.reject` を呼んでも、応答済みで呼び出し側へ届かない。
   - 要求の組み立て（内容・日時の解釈・過去の時刻の拒否）を `makeNotificationRequest` に切り出し、`show` は `add` の完了ハンドラの中で解決か拒否の**どちらか 1 回だけ**を呼ぶ。前面での表示の設定の控え（`saveNotification`）は `add` が成功したときだけ行う。完了ハンドラは任意のスレッドで呼ばれるため、控えと応答はメインのキューで行う。
   - 組み立ての失敗は、上流と同じく `add` の前に同期で投げる（既存の予約に触れない）。
   - `batch`（`showNotification`）は変えない（ai-boss は使わず、capability でも許さない）。
3. **この `FORK.md` を足し、配布物のキャッシュの目印 `.cargo-ok` を置かない**。

ai-boss で足した行には `ai-boss fork` の注記を付けている。上流との差分は、上流の配布物（`cargo` のキャッシュ、または crates.io の `tauri-plugin-notification-2.5.0.crate`）とこのディレクトリの `diff -r` で確かめられる。

## テスト

- Swift の差分は自動テストで動かせない。機能仕様の「手動の確認手順（S3）」（iOS シミュレータ）で確かめる。
- 器が path 依存で使うこと・権限の分け方は、器の設定の検査（`native/tauri-app/tests/config_checks.rs`・`npm run test:tauri`）が確かめる。

## 上流への追従

- 差分 1・2 は上流へ PR する（組織外への送信のため、オーナーの承認を得てから行う）。
- 上流に取り込まれた版が出たら、fork をやめて crates.io の版へ戻す（別 Issue）。
