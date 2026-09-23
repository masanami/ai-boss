# spike: iOS 技術検証 — Tauri 2 トラック（#576）

**スパイク（技術検証）であり製品コードではない。`main` へはマージしない。** 検証はすべて **iOS 26.5 シミュレータ（iPhone 17）** で行った（実機未確認）。

## 構成

| パス | 内容 |
|---|---|
| `app/` | `create-tauri-app@4.7.4`（react-ts・Tauri 2）で生成した検証アプリ |
| `app/src/dashboard/` | `web/src/Dashboard.tsx` ほか依存一式のコピー。API フックだけダミーデータの巡回に差し替え、表情切替時の CSS アニメーション（スパイク専用）を追加 |
| `app/src/engine/` | `server/src/detection/` の本体とテスト（`due-at-interpretation.test.ts` は `node:fs` 依存のため除外）＋依存する型・関数を**無改変でコピー** |
| `app/src/selftest/vitest-shim.ts` | 上のテストを WebView 内で走らせる最小 vitest 互換シム |
| `app/src/spike/` | 項目 2〜6 の検証コード（`sqlite.ts` / `llm.ts` / `notify.ts` / `keychain.ts` / `detection.ts`） |
| `app/src-tauri/src/lib.rs` | キーチェーン（`security-framework`）・自動検証用の Rust コマンド |
| `../tools/sim-tapper/` | 通知許可ダイアログを XCUITest でタップする補助ツール（シミュレータ自動検証用） |

## 自動検証の回し方

```sh
cd app && npm install
npx tauri ios build --target aarch64-sim --ci    # 2 回目以降は gen/apple/build/arm64-sim を退避してから（下記「詰まった点」）
xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/AiBossSpikeTauri.app
# キーは画面の入力欄から保存するか、シミュレータ検証に限り環境変数で渡す（ビルドには埋め込まない）
SIMCTL_CHILD_ANTHROPIC_API_KEY=... SIMCTL_CHILD_SPIKE_SELFTEST=keychain,sqlite,detection,llm,notify xcrun simctl launch booted dev.aiboss.spike.tauri
# 結果は <data container>/Library/Application Support/dev.aiboss.spike.tauri/<step>.json
```

## 結果（2026-09-23・シミュレータ）

| # | 項目 | 結果 | 実測・所見 |
|---|---|---|---|
| 1 | 画面の表示 | ✅ | コピーした Dashboard / BossAvatar がそのまま描画。表情 4 種の切替・ゲージの幅/色の遷移・CSS keyframes アニメーションが WKWebView で動作（`evidence/expression-switch-strip.png`）。変更はダミーフック 2 ファイルのみ |
| 2 | アプリ内 SQLite | ✅ | `@tauri-apps/plugin-sql` で `tasks` 相当を作成・INSERT・UPDATE・SELECT（15ms）。`BEGIN`→`INSERT`→`ROLLBACK` は今回は効いた（ただし sqlx のコネクションプール越しで同一接続の保証が無い。下記） |
| 3 | LLM ストリーミング＋tool use | ✅（ヘッダ 1 つ追加） | `@tauri-apps/plugin-http` の `fetch` で `ReadableStream` を逐次読めた。haiku-4.5・max_tokens 256 で HTTP 200、チャンク 9 回、最初のチャンク 0.99 秒・全体 2.3 秒、`create_task` の tool_use（input_json_delta 18 回）→ stop_reason=tool_use。**plugin-http は WebView の Origin を転送するため初回は 401**（`CORS requests must set 'anthropic-dangerous-direct-browser-access' header`）。同ヘッダの付与で解消 |
| 4 | 予約通知 | ✅（プラグインの不具合を回避して） | 予約→取り消し→再予約が `pending()` で確認できた。**アプリ終了（`simctl terminate`）後に再予約分が予定時刻に届いた**（`evidence/notification-while-terminated.png`）。上限: 70 件を登録してもエラーは出ず、**黙って 64 件に切り詰められる**（先に登録した 6 件が消えた） |
| 5 | API キーの保管 | ✅ | Rust の `security-framework`（generic password）で保存→アプリ再起動後に読み出せた。公式プラグインは無い（stronghold は別物）ため自前コマンド約 30 行 |
| 6 | ロジック移植 | ✅ | 検知エンジンの本体とテストを**無改変で** WKWebView（JavaScriptCore）上で実行: **216/216 件合格**（DST スイート 2 件は Asia/Tokyo のため skip＝vitest の結果と同数）。140ms |

### その他の実測

- アプリサイズ: `.app` 8.8MB（release・シミュレータ用 arm64。うちバイナリ 8.5MB）
- 起動: `simctl launch` から JS の初回 effect まで約 1.1 秒（ウォームスタート）
- メモリ（シミュレータの RSS・目安）: アプリ本体 約 217MB＋WebContent 約 180MB（シミュレータの値は実機より大きく出る）
- ビルド時間: クリーン release 約 3.5 分（Rust 依存のコンパイル込み）、差分 33〜65 秒。`tauri ios dev` 初回 約 2 分
- ホットリロード: `tauri ios dev` で Vite の HMR が効く（シミュレータの WebView に即時反映）

### 詰まった点と回避策

1. **`@tauri-apps/plugin-notification` 2.4.0 の iOS 実装で予約時刻が UTC オフセット分ずれる**: `"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"` を timeZone 未設定の `DateFormatter` でパースするため、UTC の ISO 文字列が端末ローカル時刻として解釈される。JST では 9 時間早くなり `pastScheduledTime` で拒否（9 時間以上先なら黙って 9 時間早く鳴るはず）。回避: 壁時計のローカル時刻を `Z` 付きで渡す（`notify.ts` の `localWallClockAsUtc`）。製品化ならプラグインへ修正 PR か fork が要る
2. **`sendNotification()` は fire-and-forget** で、上の失敗が握りつぶされる。`invoke("plugin:notification|notify")` を直接呼ぶと失敗が見える
3. **plugin-http と Anthropic API の CORS 判定**: 上記。Rust 側で直接 reqwest を叩くコマンドにすれば Origin も付かず、キーを JS に渡さずに済む（製品ではこちらを推奨）
4. **Rust クレートと npm パッケージのマイナー版一致チェック**: `tauri-plugin-http` 2.7.0（crates.io）と `@tauri-apps/plugin-http` 2.6.1（npm 最新）がずれてビルド拒否。`~2.6` に固定して回避
5. **capability 名の誤り**（`notification:allow-pending` → 正しくは `allow-get-pending`）はビルド時に全候補一覧付きで弾かれる（分かりやすいが出力が長大）
6. **`tauri ios build` の 2 回目が `failed to rename app ... Directory not empty` で失敗**: 前回の `gen/apple/build/arm64-sim` を退避すると通る（CLI の不具合）
7. **`tauri ios init` が Homebrew で cocoapods を自動で再インストールした**（ruby 4.0.7・cocoapods 1.17.0 へ更新。開発機の環境が変わる副作用）
8. 通知の許可ダイアログはシミュレータでもタップが要る（`simctl privacy` に notifications が無い）。XCUITest の補助ツール（`../tools/sim-tapper`）で対処

### 項目 2: better-sqlite3（同期）→ plugin-sql（非同期）の移行見積もり

- 現行 server: DB を引数に取る関数 163 個（うち export 88 個・48 モジュール）、`prepare` 61 箇所、`db.transaction` 10 箇所（`checkins-routes` → `updateTask` の**入れ子トランザクション**あり）、DB を使うテスト 56 ファイル
- `tasks-repository.ts`（415 行）単体は機械的な `async/await` 化で 1〜2 時間。呼び出し元へ波及するため全体で **1〜1.5 週**（テスト込み）
- リスク: plugin-sql は sqlx のプール越しで、`BEGIN`〜`COMMIT` が同一接続に乗る保証が無い（今回の単発プローブでは効いた）。トランザクションは Rust 側コマンドにまとめる（rusqlite で同期 API のまま Rust に置く）方が安全。この場合は TS→Rust の書き直しが入る
