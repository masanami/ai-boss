// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "web/dist-app/**",
      "native/tauri-app/gen/**",
      "native/tauri-app/target/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // LLM 中継サーバー（docs/features/llm-relay-server.md）。中継の本体は
    // Web 標準の API だけで書く（Node のグローバルを使わないことは
    // relay/src/relay-bundle.test.ts の AST 検査が担保する）が、テストは
    // Node で動くため server と同じ globals.node を割り当てる。
    files: ["relay/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // エージェント用ハーネス（run-ai-boss スキルのドライバ）。Node で直接実行する
    // スクリプトなので node グローバルを許可する。プロダクトコードではないが、
    // `eslint .` の対象からは外さず lint は通す。
    files: [".claude/skills/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Tauri の器（機能仕様 docs/features/tauri-in-app-runtime.md S2）の
    // 補助スクリプト。Node で直接実行するので node グローバルを許可する。
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
