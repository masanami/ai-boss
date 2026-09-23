# spike: iOS 技術検証 — Flutter トラック（#576）

**スパイク（技術検証）であり製品コードではない。`main` へはマージしない。**

## 構成

| パス | 内容 |
|---|---|
| `app/` | `flutter create`（iOS のみ）で作った検証アプリ。`lib/dashboard/` が Dashboard / BossAvatar / DashboardMeetingSchedule の移植、`lib/spike/` が項目 2〜5 の検証コード |
| `detection/` | `server/src/detection/`（＋依存する `tasks/due-at.ts`・`activity/local-day.ts`・`lib/iso-date.ts`・型）の **Dart 翻訳**と、テスト全件の翻訳 |
| `../tools/sim-tapper/` | 通知許可ダイアログを XCUITest でタップする補助ツール（Tauri トラックと共通） |

## 結果（2026-09-23）

### 項目 6: 検知エンジンの Dart 翻訳（完了・ホストの Dart VM で実行）

- 所要: **17:04:29〜17:15:55（約 11.5 分・AI エージェントによる翻訳の壁時計時間）**。元の本体・テストの読み込みを含む
- 規模: TS（検知エンジン本体 約 940 行＋依存 約 280 行・テスト 約 2,820 行）→ Dart 本体 754 行・テスト 1,432 行（Dart 版は 1 行が長い書式のため行数は単純比較できない）
- テスト: **Asia/Tokyo 219 件合格＋2 件 skip（DST スイート）／ America/New_York 221 件すべて合格／ UTC 219 件合格＋2 件 skip**。翻訳は初回実行で time_utils の 2 件（下記 4）以外すべて合格
- 実行: `cd detection && dart pub get && dart test/all_test.dart`（`TZ=America/New_York dart test/all_test.dart` で DST スイートも走る）

#### 日付・タイムゾーン（ADR 0007 / 0010）まわりで要った手当て

1. **JS `Date` と Dart `DateTime` の意味差**を吸収する層（`lib/src/js_date.dart`）が要った。とくに `new Date("YYYY-MM-DD")` は JS では **UTC 0 時**、`DateTime.parse` では**ローカル 0 時**。`new Date(y, m, d)` の月は 0 始まり（Dart は 1 始まり）。JS は不正な文字列で Invalid Date（NaN）、Dart は例外
2. `toISOString()` 相当（UTC・ミリ秒 3 桁・`Z`）を自前で用意（Dart の `toIso8601String()` は桁や `Z` の有無が入力依存）
3. `Intl.DateTimeFormat(..., { timeZone })` の代わりに `package:timezone`。**IANA DB に `"UTC"` が無く**（`Etc/UTC` のみ）1 件落ちた → `tz.UTC` へ写して解消
4. Dart 標準には**実行環境の IANA タイムゾーン名を返す API が無い**（`timeZoneName` は "JST" 等の略称）。テストの「実行 TZ 自身を明示したときの一致」ケース用に `TZ` 環境変数 → `/etc/localtime` のリンク先から求めた（アプリでは `flutter_timezone` を使う）
5. 西暦 0〜99 年を 1900 年代へ写す JS の仕様は Dart に無い（`iso-date.ts` の回避策が不要になる）。検知エンジンのテストはこの範囲を検証していないため差は表面化しない
6. 時刻の加減算・`DateTime(y, m, d + 1)` の繰り上がり・DST 下の翌暦日計算は JS と同じ挙動で、DST テストも America/New_York で通った

#### 翻訳の機械的な摩擦（TS 固有の書き方）

- `Partial<T>` とスプレッド（`{ ...defaults, ...overrides }`）→ `copyWith`・番兵値付きの名前付き引数へ置き換え
- 構造的等価（`toEqual`）→ モデルに `==`/`hashCode` を実装
- `vi.spyOn(console, "warn")` → 差し替え可能な `warn` 関数（本体側に注入点を 1 つ追加）
- `it.each` / `describe.runIf` → `for` ループ／`group(..., skip:)`

### 項目 1〜5: iOS アプリ（2026-09-23 再開後に検証・**iOS 26.5 シミュレータ**）

前回は Flutter SDK 同梱バイナリの Gatekeeper 拒否（quarantine 属性）でビルドできなかった。オーナーが個別に承認して解消した後に検証した。

| # | 項目 | 結果 | 実測・所見 |
|---|---|---|---|
| 1 | 画面の表示 | ✅ | 移植した Dashboard が表示され、表情 4 種の切替（`AnimatedSwitcher` の縮小＋回転＋フェード）とゲージの遷移（`AnimatedContainer`）が動作（`evidence/dashboard.png`・`evidence/expression-switch-strip.png`）。**移植時間: コード作成 約 1 分（16:44:20〜16:45:32）＋表示確認まで 約 1 分（17:30:47〜17:31:44・修正なし）＝ 約 2 分（AI の壁時計）** |
| 2 | アプリ内 SQLite | ✅ | drift（生 SQL の API・コード生成なし）で `tasks` 相当を作成・INSERT・UPDATE・SELECT（88ms）。`db.transaction` 内で例外 → ロールバックが効いた（drift のトランザクションは同一接続で直列化される） |
| 3 | LLM ストリーミング＋tool use | ✅ | 公式 Dart SDK は無いため `package:http` の `send()`＋SSE 手書きパース。HTTP 200、最初のテキスト 1.16 秒・全体 2.19 秒、`create_task` の tool_use → stop_reason=tool_use。**Origin を付けないため CORS 用ヘッダは不要** |
| 4 | 予約通知 | ✅ | `flutter_local_notifications` の `zonedSchedule` で予約→取り消し→再予約（`pending` で確認）。**アプリ終了（`simctl terminate`）後、取り消した分は届かず、再予約分が予定時刻どおり届いた**（`evidence/notification-while-terminated.png`）。上限: 70 件登録でエラー無く**黙って 64 件**（先に登録した 6 件が消える＝Tauri と同じ OS の挙動）。TZ のずれは無し（`timezone`＋`flutter_timezone` でローカル TZ を設定） |
| 5 | API キーの保管 | ✅ | `flutter_secure_storage` でキーチェーンへ保存 → 再起動後に読み出し |

### その他の実測

- アプリサイズ: **release（実機 arm64・署名なし）20.1MB**（Flutter.framework 10MB・App.framework 7.1MB・sqlite3 1.6MB）。debug のシミュレータ用は 178MB（JIT・参考外）
- 起動: `simctl launch` から最初のフレーム後のコールバックまで約 1.1 秒（debug ビルド。release はシミュレータで動かせないため未計測）
- メモリ: debug ビルドでシミュレータ RSS 約 437MB（JIT のため参考外。release の値は実機で要確認）
- ビルド時間: シミュレータ用 debug 25 秒（親の事前ビルドのキャッシュあり）・差分 12〜13 秒・release（実機用）30 秒。`flutter run` の起動 約 30 秒
- ホットリロード: `flutter run` 中に 1 ファイル変更 → 270ms で反映

### 詰まった点と回避策（再開後）

1. **iOS の Flutter では `Platform.environment` に `SIMCTL_CHILD_*` で渡した変数が現れなかった**（自動検証の起動引数が届かない）。dart:ffi で libc の `getenv` を直接呼んで回避（`app/lib/spike/env.dart`・自動検証専用）
2. 前回書いた未コンパイルの検証コード（drift・http・flutter_local_notifications・flutter_secure_storage）は**修正なしでそのままビルド・動作した**
3. Gatekeeper（前回のブロッカー）: Homebrew の Flutter は同梱バイナリに quarantine 属性が付いており、`dart`・`dartaotruntime`・`dartvm`・`impellerc`・`font-subset`・`gen_snapshot_arm64` を個別に承認する必要があった。初回の環境構築で詰まりうる点として記録する
