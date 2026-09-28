# tauri-plugin-sql（ai-boss のリポジトリ内 fork）

ai-boss の製品版（Tauri アプリ）が使う `tauri-plugin-sql` の Rust 側の fork。機能仕様 `docs/features/async-db-layer.md`（#580）のクリティカル設計決定 1 と「S2 の設計」に拠る。JS 側（`@tauri-apps/plugin-sql`）は上流のパッケージをそのまま使う。

## 由来

| 項目 | 値 |
|---|---|
| 上流 | `tauri-apps/plugins-workspace` の `plugins/sql` |
| 版 | `2.4.1`（crates.io の配布物 `tauri-plugin-sql-2.4.1.crate`） |
| 上流のコミット | `6aa2854f314481a459be1189b02c65a2450789ab`（配布物の `.cargo_vcs_info.json`） |
| ライセンス | `Apache-2.0 OR MIT`（上流の `LICENSE_APACHE-2.0`・`LICENSE_MIT`・`LICENSE.spdx` をそのまま置く） |

配布物の中身は、下の差分を除いてそのまま置いている（`Cargo.toml` は crates.io が正規化したもの、`Cargo.toml.orig` は上流のワークスペースでの原本、`Cargo.lock` は配布物に同梱のものに、差分 3 の依存を足した分だけ cargo が更新したもの）。

## 上流からの差分

1. **SQLite の接続を 1 本に固定する**（`src/wrapper.rs` の `DbPool::connect` と `sqlite_pool_options`）。上流の `Pool::connect(conn_url)`（sqlx の既定: 最大 10 接続・寿命 30 分・アイドルの期限 10 分）を、`SqlitePoolOptions::new().max_connections(1).max_lifetime(None).idle_timeout(None).connect(conn_url)` に替えた。
   - 理由: ai-boss の TS 側の直列化層（`server/src/db/serialized-db.ts`）は `BEGIN IMMEDIATE`〜`COMMIT`／`ROLLBACK` を別々の `execute` で送るため、すべての文が同じ接続に乗らなければならない。寿命とアイドルの期限も外すのは、sqlx が寿命を過ぎた接続をプールへ返す時点で閉じ、次の文を新しい接続（オートコミット）で実行するため（`sqlx-core` 0.8 の `pool/connection.rs` `return_to_pool`）。
2. **1 の単体テスト**（`src/wrapper.rs` の末尾の `ai_boss_fork_tests`）。
3. **接続に別の DB ファイルを付け足せないようにする**（`src/wrapper.rs` の `forbid_attaching_other_databases`。`after_connect` で `sqlite3_limit(SQLITE_LIMIT_ATTACHED, 0)`。`Cargo.toml` に `libsqlite3-sys`〔sqlx-sqlite 0.8 と同じ 0.30.1〕を `sqlite` 機能の依存として足した）。
   - 理由: WebView に `execute` を許可しているため、上流のままだと `ATTACH DATABASE '<任意のパス>'` や `VACUUM INTO '<任意のパス>'` でアプリのデータディレクトリの外の DB ファイル（オーナーの開発者用の版の DB を含む）を読み書きできる。`load` を許可しないだけではこの経路は塞がらない。ai-boss のスキーマとマイグレーションは ATTACH を使わない。
4. **この `FORK.md` を足し、配布物のキャッシュの目印 `.cargo-ok` を置かない**。

ai-boss で足した行には `ai-boss fork` の注記を付けている。上流との差分は、上流の配布物（`cargo` のキャッシュ、または crates.io の `tauri-plugin-sql-2.4.1.crate`）とこのディレクトリの `diff -r` で確かめられる。

## テスト

- fork の単体テスト: `cargo test --manifest-path native/tauri-plugin-sql/Cargo.toml --features sqlite`（`npm run test:tauri` に含む）
- 器の上の結合テスト: `native/tauri-app/tests/sql_plugin.rs`（`npm run test:tauri`）
- 両版で同じ契約スイート: `npm run test:tauri-db`

## 上流への追従

必要になったときに、新しい版の配布物を置き直して上の差分を当て直す（仕様の仮定 A4）。
