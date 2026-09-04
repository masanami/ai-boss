# ai-boss - Claude Code プロジェクトコンテキスト

## プロジェクト概要

AI が「上司（ボス）」を演じるセルフマネジメント支援アプリ。朝会・夕会での報告、随時のチャット相談に対しボスが決定の形で断言し、サボり（未着手・回避・休憩延伸・無音）を検知して macOS 通知で段階的に催促する。macOS ローカル完結・シングルユーザー。

## 開発方針（正はコードとテスト）

**正はコードとテストである。** 機能仕様（`docs/features/`）は実装を駆動する作業文書、`docs/adr/` は恒常的な設計決定の記録であり、**docs はいずれも非権威（実装の補助資料）**として扱う。正しさを docs で担保しようとせず、**コードの可読性を上げてコードが正**という状態を保つ。

- 実装と docs が食い違ったら、**コードとテストを読んで実態を確かめてから** docs を直す（docs に合わせて実装を曲げない）
- **未起票のアイデア・要望は GitHub Issue が正本で、docs には書かない**（`docs/features/` をバックログにしない）。これは着手前の構想の話であり、**着手する機能について `/define-feature` が作る機能仕様は実装前に書いてよい**——それが実装を駆動する作業文書だからである（下記）
- 機能仕様は**実装を駆動するための作業文書**。クリティカル設計をまとめて決めておく価値（実装フェーズに人間ゲートを残さない）はフェーズに依存しないため作り続ける。リリース後も**残してよい**（経緯の記録として読める）。ただし**権威は持たない**——実装と食い違ったらコードとテストが正であり、機能仕様は追随するか、古い記録として扱う。**恒常的な設計決定だけは ADR へ昇格**させる（機能仕様に埋もれさせない）
- **保証駆動開発（GDD）は不採用**（2026-08-21 決定）。保証台帳は退役済みで、**claude-harness 4.0.0 が GDD 機構ごと撤去した**ため、保証 ID（`G-NNN-N`）・裁可ラベル（`guarantee:proposed` / `guarantee:approved`）・保証索引ゲートはいずれも存在しない。ただし既存テスト名に含まれる `G-179-*` は**そのまま残す**（テスト名の変更はテストの変更であり、`#179` が併記されているため追跡は維持される）。一括改名しないこと

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
- 統合ブランチ → `main` の昇格に限り、`/pr-merge` の前に `/promote-verify` で親 Issue の受入基準を全数チェックする（親 Issue と統合ブランチが前提のスキルなので、統合ブランチ宛の子 PR には使わない）
- E2E は `/create-e2e` で実装し `/explain-e2e` で解説・検証する。テスト未担保の公開面の洗い出しは `/surface-audit`
- マイルストーン完了後は `/demo`（テストケースカタログと突き合わせるなら `/demo-e2e`）で実ブラウザ検証する。QC・AI レビューをすり抜ける結合欠陥に有効

> 新機能は `/define-feature` で機能仕様を作ってから `/create-ticket` へ渡す。機能仕様は**実装を駆動する作業文書**であり、リリース後も経緯の記録として残してよい（**権威は持たない**。上記「開発方針」節）。

## 開発規約

### ブランチ・コミット
- **方針**: 1チケット = 1ブランチ → PR → 必須ゲート通過後にマージ（GitHub Flow）
- **ブランチ**: `{type}/{issue番号}-{説明}`（例: `feat/4-task-crud-api`）
- **コミット**: Conventional Commits + 日本語
  - type: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`
  - scope: `server`, `web`, `db`, `docs`
- **PR**: ≤400行目安、squash マージ
- **`main` のゲートは GitHub の branch protection が持つ**（2026-09-01 設定・`enforce_admins` 有効）。`main` への直 push・force push・ブランチ削除は**サーバ側で拒否される**（管理者も例外なし。実測で `GH006: Changes must be made through a pull request.` を確認）。したがって `main` への変更は必ず PR を経る
  - **機械的に担保されるのは「PR を経ること」まで**。必要な承認数は 0（単独オーナーは自分の PR を承認できずデッドロックするため）なので、**PR のマージ自体は人間の判断に委ねられている**。`/pr-merge` はオーナーが起動する
  - `.claude/settings.json` の deny（`git push origin main` 等）は、この本ゲートの手前で事故を早く止める**多層防御**。permission は**先頭のコマンドで照合される**ため、許可済みの実行系（`node:*` / `npm:*` / `gh api:*` / `gh pr:*` / `claude-harness-run`）から子プロセス・API 経由で迂回できる＝**deny 単体を境界と当てにしない**
- **`doctor.sh` が advisory で勧めるベース allow のうち、repo の `.claude/settings.json` に入れるのは `Bash(git ls-remote:*)` だけ。`Bash(bash:*)` は入れない**（2026-09-05 オーナー決定）
  - **`Bash(bash:*)` は許可範囲が広すぎる**: `bash -c '<任意のコマンド>'` が通り、実質すべてのコマンドを 1 ルールで許可することになる。必要になった個別コマンドは**都度そのコマンド単位で allow に足す**（`bash:*` でまとめて開けない）
  - **`Bash(git ls-remote:*)` も任意コマンド実行に使える**（`git ls-remote --upload-pack='<任意のコマンド>' .` は値がそのまま実行される。2026-09-01 にローカルで再現確認）。それでも入れるのは、**本ゲートが上記のとおり branch protection 側にあり**、permission を絞っても迂回路は許可済みの実行系に残るため。ここを締めて得られるのは僅かな事故低減で、代わりに委譲した子セッションが permission 拒否で止まる（過去 3 回再発）
  - **repo の設定に入れたくない広い allow は、リポジトリではなくユーザー側**（`~/.claude/settings.json` / `.claude/settings.local.json`）で設定する。repo の `.claude/settings.json` はコミット対象＝チームの規範なので、個人の実行環境の都合を混ぜない
  - プラグイン配下スクリプトは PATH 上の `claude-harness-run` ランチャー（`Bash(claude-harness-run:*)` で許可済み・`doctor.sh` の blocking チェックは pass）から呼ぶため、`bash:*` を入れなくても実運用の経路は塞がらない
- **統合ブランチ**: 親 Issue の実装は統合ブランチ `feat/issue-{親Issue番号}` に集約し、実装チケットの子 PR は統合ブランチへマージする（本番非反映）。`main` への昇格は統合ブランチからの PR 1 本で行う
- **stacked PR を作らない**: 統合ブランチは常に最新 `main` から独立に切る。base が他の統合ブランチの PR を作ると、先行 PR が `--delete-branch` でマージされた時点で base ブランチが消え、**後続 PR は自動クローズされ reopen も base 変更も 422 で拒否されて復旧不能**になる（2026-08-18 実測）。依存があってどうしても stacked にする場合は「先行マージ前に base を `main` へ付け替える」必要を PR 本文の冒頭に明記する

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
| 機能仕様（実装を駆動する作業文書・非権威） | `docs/features/` | 整備済み |
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
