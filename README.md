# AIボス

AIが「上司（ボス）」を演じるセルフマネジメント支援アプリ。仕事の報告・相談を受けて優先順位を決定し、朝会・夕会・催促通知で自己管理の弱さを外部の強制力とモチベーション演出で補う。

## コンセプト

- **報告する相手がいる**: 朝会で今日の計画を報告し、夕会で進捗を報告する。ボスがノルマと優先順位を決定する
- **意思決定してくれる**: 迷ったら随時チャットで相談。ボスは決定の形で断言する。異議があれば進言でき、ボスが再裁定する
- **サボると来る**: 未着手・嫌なタスクの回避・休憩の延伸・無音をボスが検知し、ボスの人格を反映した macOS 通知で催促される。無視し続けると頻度・口調が段階的にエスカレーションする
- **モチベーション演出**: 表情が変わるボスのアバター、進捗ゲージ、褒め・叱咤の演出

## 技術スタック（予定）

| 領域 | 技術 |
|------|------|
| フロントエンド | Vite + React + TypeScript |
| バックエンド | Node.js + Hono（REST + SSE） |
| DB | SQLite（better-sqlite3、完全ローカル保存） |
| LLM | Claude Code（`@anthropic-ai/claude-agent-sdk`、既定・サブスクリプション認証） / Claude API（`@anthropic-ai/sdk`、`LLM_BACKEND=api` で切替・従量課金） |
| 通知 | macOS 通知センター |

対象OS: macOS

## ドキュメント

- [機能仕様（MVP）](docs/features/ai-boss-mvp.md) — 要件・クリティカル設計決定・全体設計
- [将来アイデア](docs/features/future-ideas.md) — MVPスコープ外のバックログ

## 開発状況

要件定義フェーズ完了。実装はこれから。

## セットアップ（予定）

LLM バックエンドは既定で `claude-code`（Claude Code のログイン済み環境が前提・サブスクリプション認証、`ANTHROPIC_API_KEY` 不要）を使う。従来の Claude API 従量課金経路に切り替えるには、サーバー側 `.env` に `LLM_BACKEND=api` と `ANTHROPIC_API_KEY` を設定する（詳細は `server/.env.example`）。

```bash
# 従来の Claude API 従量課金経路を使う場合のみ（リポジトリにはコミットしない）
cat <<'EOF' > server/.env
LLM_BACKEND=api
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

## 起動

```bash
# 日常利用（本番相当）: 自動で build し、ビルド成果物を server が一体配信する
npm run start
# → http://localhost:8787 を開く（API・SSE も同一オリジンで動作）

# 開発（Vite ホットリロード + server 並行起動）
npm run dev
```
