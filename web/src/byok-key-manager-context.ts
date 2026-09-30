import { createContext } from "react";

/**
 * BYOK のキー（1 プロバイダ分）の登録・削除・登録の有無（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 8）。
 *
 * 画面が知るのは登録の有無だけで、キーの値を読み出す手段は無い。登録の瞬間
 * だけキーが WebView を通る（オーナーの決定 Q1-b）。キーは `/api`（アプリ内の
 * Hono アプリ・DB）を通らない。
 */
export interface ByokKeyManager {
  isRegistered(): Promise<boolean>;
  register(key: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * プロバイダごとのキーの操作の組（#582 S2・仮定 A15）。欄ごとに対応する
 * プロバイダの操作を使う。
 */
export interface ByokKeyManagers {
  anthropic: ByokKeyManager;
  openai: ByokKeyManager;
}

/**
 * 製品版（Tauri アプリ）のエントリだけがこのコンテキストへ値を注入する
 * （`web/src/app-entry/main.tsx`）。既定値は `null` — 開発者用の版は注入しない
 * ため、設定画面にプロバイダ・モデルの選択の欄もキーの欄も出ず、自由入力の
 * 「モデル」の欄が出る（証跡の Blob URL の方式と同じ型。仮定 A16: 製品版かどうか
 * の判定はこの値の有無だけ）。
 */
export const ByokKeyManagerContext = createContext<ByokKeyManagers | null>(null);

/**
 * キーの操作の失敗。種類とキーチェーンの OSStatus だけを持つ（キーの値を
 * 含めない）。未署名のビルドではキーの登録が OSStatus -34018 になる（既知の
 * 制約。機能仕様 クリティカル設計決定 9）。
 */
export class ByokKeyCommandError extends Error {
  readonly kind: string;
  readonly osStatus?: number;

  constructor(kind: string, osStatus?: number) {
    super(
      `キーの操作に失敗しました（${kind}${osStatus === undefined ? "" : `・OSStatus ${osStatus}`}）`,
    );
    this.name = "ByokKeyCommandError";
    this.kind = kind;
    this.osStatus = osStatus;
  }
}
