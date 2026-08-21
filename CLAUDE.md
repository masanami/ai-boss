# ai-boss - Claude Code プロジェクトコンテキスト

## プロジェクト概要

AI が「上司（ボス）」を演じるセルフマネジメント支援アプリ。朝会・夕会での報告、随時のチャット相談に対しボスが決定の形で断言し、サボり（未着手・回避・休憩延伸・無音）を検知して macOS 通知で段階的に催促する。macOS ローカル完結・シングルユーザー。

## 開発フェーズ

- **フェーズ**: GDD期

駆動文書は**保証台帳** `docs/guarantees.md`（現に守られている公開面の約束）と、恒常的な設計決定を記録した `docs/adr/` の 2 つ。MVP 期の機能仕様（旧 `docs/features/` の 5 ファイル）は退役済み。

**新機能の開発では機能仕様ドキュメントを作り続ける**が、位置づけは「**リリースまでの短命な作業文書**」であり駆動文書ではない。クリティカル設計をまとめて決めておく価値（実装フェーズに人間ゲートを残さない）はフェーズに依存しないため。**リリース後は退役手順**（ADR 昇格の要否判定 → 保証台帳・ADR へ吸収してファイルごと削除）**で必ず片付ける**——残すと駆動文書が二重になり、GDD が解こうとした「仕様と実装の乖離」が戻る。

- 実装は**保証を足す・変える・消す**という単位で考える。保証を変える PR は台帳と参照テストを同時に変える
- まだ守っていない「やりたいこと」は GitHub Issue が正本。台帳には書かない
- テストで担保されていない公開面は台帳の「Gaps」に列挙してある。約束ではないので、Gaps の項目に依存した実装をしない

## 開発原則

- **YAGNI**: 必要になるまで機能を追加しない。「念のため」の実装をしない
- **KISS**: シンプルで直接的なコードを書く。過度な抽象化を避ける
- **DRY**: 共通処理は再利用可能な関数・コンポーネントに抽出
- **ローカルファースト**: 全データはローカル SQLite のみ。外部送信は Anthropic への推論リクエストだけ（不変制約）。既定の claude-code バックエンドはローカルの Claude Code 実行系を経由するが、この不変制約はビルトインツール無効化・セッション永続化無効化・テレメトリ／自動更新確認の無効化で担保する（[ADR 0001](docs/adr/0001-local-only-data-boundary.md)・[ADR 0003](docs/adr/0003-llm-backend-isolation.md)）
- **秘密情報の分離**: `ANTHROPIC_API_KEY` は `server/.env` のみ。フロントエンドへ渡さない・コミットしない（claude-code バックエンドは API キーを子プロセス環境から明示除外する）（[ADR 0002](docs/adr/0002-api-key-and-llm-call-path.md)）
- **検知ロジックは純粋関数**: サボり検知ルールエンジンは入力（activity_events 等）→ 出力の純粋関数として実装し、LLM は文面生成のみに使う

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| Frontend | Vite + React + TypeScript（`web/`） |
| Backend | Node.js + Hono（REST + SSE）+ node-cron（`server/`） |
| DB | SQLite（better-sqlite3、完全ローカル保存） |
| LLM | 既定: Claude Code（`@anthropic-ai/claude-agent-sdk`、サブスクリプション認証・`ANTHROPIC_API_KEY` 不要）。`LLM_BACKEND=api` で Claude API（`@anthropic-ai/sdk`、従量課金）へ切替可（既定モデル claude-sonnet-5・設定で変更可、両バックエンド共通） |
| Test | Vitest（unit / integration） |
| Infra | macOS ローカル実行のみ。通知は terminal-notifier 優先 / osascript フォールバック |
| Package | npm（workspaces: `server/` + `web/`） |

> 現に守られている API・画面・検知ロジックの約束は [docs/guarantees.md](docs/guarantees.md) が正本。実装と台帳が食い違う場合、**どちらが正しいかを判断してから**直す（台帳が古いなら台帳を、実装が壊れたなら実装を直す。片方だけ黙って合わせない）。

## 開発フロー（claude-harness）

開発は claude-harness プラグインのスキル群で行う（**GDD期のフロー**）:

- 起票 `/create-ticket`（保証節を含める）→ 裁可（`guarantee:approved`）→ 実装 `/para-impl`（裁可済み Issue のみ・内部で TDD・QC 通過まで）
- 単発実装は `/tdd-impl`、品質確認は `/quality-check`（保証索引ゲートを含む）、コミットは `/commit`
- 台帳の監査は `/guarantee-audit drift`（台帳と実態の乖離を検出）、恒常的な設計決定の記録は `/create-adr`
- レビュー対応 `/pr-review-respond` → マージ `/pr-merge`（**`main` への昇格マージのみ人間承認**）

> 新機能は `/define-feature` で機能仕様（短命な作業文書）を作ってから `/create-ticket` へ渡す。GDD期では機能仕様に「## 宣言予定の保証」節が加わり、`/create-ticket` が Issue の「## 保証（Guarantees）」節を組み立てる材料になる。**リリース後の退役までが 1 セット**（上記「開発フェーズ」節）。

## 開発規約

### ブランチ・コミット
- **方針**: 1チケット = 1ブランチ → PR → 必須ゲート通過後にマージ（GitHub Flow）
- **ブランチ**: `{type}/{issue番号}-{説明}`（例: `feat/4-task-crud-api`）
- **コミット**: Conventional Commits + 日本語
  - type: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`
  - scope: `server`, `web`, `db`, `docs`
- **PR**: ≤400行目安、squash マージ

### 命名規則

| 対象 | スタイル | 例 |
|------|---------|-----|
| ファイル名 | kebab-case | `rule-engine.ts` |
| ディレクトリ名 | kebab-case | `activity-events/` |
| コンポーネント | PascalCase | `TaskBoard.tsx` |
| 関数 | camelCase | `detectIdleness()` |
| 定数 | UPPER_SNAKE_CASE | `DEFAULT_IDLE_MINUTES` |

## テスト方針

- サボり検知ルールエンジンは純粋関数としてユニットテスト必須（時刻・閾値・エスカレーション段階を網羅）
- Mock対象: Claude API（`@anthropic-ai/sdk`）、現在時刻、macOS 通知コマンド
- Mockしない: SQLite（一時ファイル or `:memory:` で実 DB を使う）

## ドキュメントマップ

| カテゴリ | パス | 状態 |
|---------|------|------|
| 保証台帳（駆動文書・正本） | `docs/guarantees.md` | 整備済み |
| 設計判断記録 | `docs/adr/` | 整備済み |

## 品質方針

```text
- 必須ゲート: lint / typecheck / test の全通過（/quality-check が機械可読で pass を返すこと）
- クリティカル箇所（変更時は人間レビュー必須）: Claude API 連携・DB スキーマ・API キーの取り扱い・通知の実行系
- サボり検知の閾値・エスカレーションはユニットテストで仕様（保証台帳の「1. サボり検知ルールエンジン」）との一致を担保する
```

## よく使うコマンド

```bash
# 依存インストール（ルートで workspaces 一括）
npm install

# 開発サーバー（server + web 並行起動、Vite ホットリロード）
npm run dev

# 本番相当の起動（自動で build → ビルド成果物を server が一体配信、http://localhost:8787）
npm run start

# 品質ゲート
npm run lint
npm run typecheck
npm test

# ビルド
npm run build
```
