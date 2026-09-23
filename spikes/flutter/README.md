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

### 項目 1〜5: iOS アプリ（**未検証**。下記の環境問題でビルドできず）

- 画面移植のコード（`app/lib/dashboard/`）は **16:44:20〜16:45:32（約 1 分）で作成**。`flutter analyze` はエラー 0 件。**シミュレータでの表示は未確認**
- 項目 2〜5 の検証コード（`app/lib/spike/`）は書いたが**一度もコンパイルしていない**（analyzer も起動しないため API の型整合も未確認）
- **ブロッカー**: この開発機では Flutter SDK 同梱の `dartaotruntime`（`frontend_server_aot` / `gen_kernel_aot` / `analysis_server` を動かす実行系）が**起動直後（`_dyld_start`）で停止したまま進まない**。`flutter build ios` は `objective_c` パッケージのビルドフックのカーネルコンパイルで 10 分以上 CPU 0% のまま止まり、最小の `dart compile kernel` でも再現。`dart <file>`（VM 内の JIT）は動くため、項目 6 はこの経路で実施した
  - `dartaotruntime` には `com.apple.quarantine` 属性が付いている（Homebrew cask 由来）。Developer ID（FLUTTER.IO LLC）で署名済み。Gatekeeper の初回起動確認で待たされている可能性が高いが、GUI を確認できないため未確定
