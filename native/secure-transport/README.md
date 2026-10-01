# secure-transport

製品版（Tauri 2 アプリ）で BYOK の API キーを OS のセキュアストレージに保管し、キーを付与して決められた送信先へだけ送る Rust の通信層。**Tauri に依存しない**ライブラリで、Tauri のコマンド・`Channel` への橋渡しは別の層（#581 の S3）が行う。機能仕様は [`docs/features/secure-transport-byok.md`](../../docs/features/secure-transport-byok.md)（非権威。正はコードとテスト）。

| モジュール | 役割 |
|---|---|
| `key_store` | 保管のポート `KeyStore`（登録・削除・登録の有無）とテスト用の `MemoryKeyStore`。キーの値を読み出す `load` は封印つきで、クレートの外から呼べない（`compile_fail` の doctest で固定） |
| `keychain` | Apple のキーチェーン実装 `KeychainKeyStore`（データ保護キーチェーン・`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`・同期しない）。`security-framework` の高レベル API（`PasswordOptions`）は `kSecAttrAccessible` を直接指定できず、読み出した値も消去されない `Vec<u8>` で返すため、`security-framework-sys` を直接呼ぶ |
| `destination` | 宛先の表。製品版は `anthropic-messages` → `https://api.anthropic.com/v1/messages` と `openai-responses` → `https://api.openai.com/v1/responses` の 2 行に、ai-boss の LLM 中継 `relay-messages` を加える（#583 S2）。中継の URL はビルド時の環境変数 `AI_BOSS_RELAY_URL` だけから入り（`https`・ユーザー名とパスワードなしのときだけ。無い・不正なら行を作らず、送信は `UnknownDestination`）、実行時に変える手段は無い |
| `transport` | 宛先の資格情報に応じてキーを付与するストリーミング転送（Anthropic は `x-api-key` と `anthropic-version`、OpenAI は `authorization: Bearer <キー>`、中継は `authorization: Bearer <ライセンストークン>` だけ。中止つき・リダイレクトに追従しない） |

## テスト

```bash
# 既定のテスト（実キーチェーンの結合テストを除く）。品質ゲートの必須項目
npm run test:rust
```

送信のテストは手元の模擬 HTTP サーバー（`tests/support/`）へ送る。実際の Anthropic・OpenAI の API へは送らない。

## 実キーチェーンの結合テスト（手動）

実際のキーチェーンへの登録・登録の有無・削除と、登録した項目の属性（データ保護キーチェーン・アクセシビリティ・同期しない）を確かめるテストは `#[ignore]` で既定の実行から外している（キーチェーンのアクセス許可・署名の要否に左右されるため）。開発機（macOS）で次を実行する:

```bash
npm run test:rust:keychain
```

- テストはテストごとにテスト専用の service 名（`dev.aiboss.byok.integration-test.<テスト名>`）を使い、製品版の項目（service `dev.aiboss.byok`）やオーナーの本物のキーには触れない。作った項目は終了時に削除する
- 属性は属性だけの問い合わせで確かめ、キーの値は読み出さない
- 結果（全件合格、または失敗したテスト名と OSStatus の番号）を PR 本文に記録する

**既知の結果（2026-09-27・macOS・未署名のテストバイナリ）**: 5 件すべてが登録（`SecItemAdd`）で `-34018`（`errSecMissingEntitlement`）になり失敗する。未署名のバイナリからはデータ保護キーチェーンを使えない。開発ビルドの扱いは機能仕様のとおり別途決める（製品版の属性は変えない）。
