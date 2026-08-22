# ai-boss - Claude Code プロジェクトコンテキスト

## プロジェクト概要

AI が「上司（ボス）」を演じるセルフマネジメント支援アプリ。朝会・夕会での報告、随時のチャット相談に対しボスが決定の形で断言し、サボり（未着手・回避・休憩延伸・無音）を検知して macOS 通知で段階的に催促する。macOS ローカル完結・シングルユーザー。

## 開発フェーズ

- **フェーズ**: SDD期

**正はコードとテストである。** 機能仕様（`docs/features/`）は実装を駆動する作業文書、`docs/adr/` は恒常的な設計決定の記録であり、**docs はいずれも非権威（実装の補助資料）**として扱う。正しさを docs で担保しようとせず、**コードの可読性を上げてコードが正**という状態を保つ。

- 実装と docs が食い違ったら、**コードとテストを読んで実態を確かめてから** docs を直す（docs に合わせて実装を曲げない）
- まだ実装していない「やりたいこと」は GitHub Issue が正本。docs には書かない
- 機能仕様は**実装を駆動するための作業文書**。クリティカル設計をまとめて決めておく価値（実装フェーズに人間ゲートを残さない）はフェーズに依存しないため作り続ける。リリース後も**残してよい**（経緯の記録として読める）。ただし**権威は持たない**——実装と食い違ったらコードとテストが正であり、機能仕様は追随するか、古い記録として扱う。**恒常的な設計決定だけは ADR へ昇格**させる（機能仕様に埋もれさせない）
- **保証駆動開発（GDD）は不採用・凍結**（2026-08-21 決定）。保証台帳は退役済みで、保証 ID（`G-NNN-N`）・裁可ラベル（`guarantee:proposed` / `guarantee:approved`）・保証索引ゲートはいずれも使わない

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

> API・画面・検知ロジックが実際にどう振る舞うかは、**コードと `*.test.ts` が正本**。docs（機能仕様・ADR）は実装の補助資料であり、食い違ったら実装を読んで確かめてから docs を直す。

## 開発フロー（claude-harness）

開発は claude-harness プラグインのスキル群で行う（**SDD期のフロー**）:

- 要件化 `/define-feature` → 起票 `/create-ticket` → 実装 `/para-impl`（内部で TDD・QC 通過まで）
- 単発実装は `/tdd-impl`、品質確認は `/quality-check`、コミットは `/commit`
- 恒常的な設計決定の記録は `/create-adr`（定常フローの必須ステップではなく、必要時に呼ぶオンデマンドスキル）
- レビュー対応 `/pr-review-respond` → マージ `/pr-merge`（**`main` への昇格マージのみ人間承認**）

> 新機能は `/define-feature` で機能仕様（短命な作業文書）を作ってから `/create-ticket` へ渡す。**リリース後の退役までが 1 セット**（上記「開発フェーズ」節）。

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

> docs はいずれも**非権威（実装の補助資料）**。正本はコードとテストである。

| カテゴリ | パス | 状態 |
|---------|------|------|
| 機能仕様（短命な作業文書・リリース後に退役） | `docs/features/` | 整備済み |
| 設計判断記録（ADR） | `docs/adr/` | 整備済み |

## 品質方針

```text
- 必須ゲート: lint / typecheck / test の全通過（/quality-check が機械可読で pass を返すこと）
- クリティカル箇所（変更時は人間レビュー必須）: Claude API 連携・DB スキーマ・API キーの取り扱い・通知の実行系
- サボり検知の閾値・エスカレーションはユニットテストが仕様の正本（[ADR 0004](docs/adr/0004-deterministic-detection-engine.md)）。閾値を変える PR はテストを同時に変える
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
