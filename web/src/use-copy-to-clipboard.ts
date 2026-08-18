import { useEffect, useRef, useState, type RefObject } from "react";

export type CopyState =
  | { kind: "idle" }
  | { kind: "success" }
  | { kind: "failure" };

export interface UseCopyToClipboardResult {
  copyState: CopyState;
  /** `content` をクリップボードへコピーする。`content` が null なら何もしない。 */
  copy: () => void;
  /** 失敗時の手動コピー退避用 textarea に付ける ref。失敗遷移時に全選択される。 */
  textareaRef: RefObject<HTMLTextAreaElement>;
}

/**
 * クリップボードコピーと成功/失敗フィードバックの共通フック（Issue #161 で
 * DailyReportView から抽出。日報ビューと作業ログビューで共用する —
 * docs/features/work-log.md「画面」）。
 *
 * - 成功/失敗の状態は `copyState` で公開し、表示（`role="status"` /
 *   `role="alert"`）は呼び出し側のビューが担う
 * - `content` が変わったら（日付切り替え・再生成）、直前のコピー結果表示は
 *   古い本文についてのものなので idle へ戻す
 * - 失敗時は `textareaRef` の要素（手動コピー退避用 textarea）を全選択する
 */
export function useCopyToClipboard(
  content: string | null,
): UseCopyToClipboardResult {
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  // ChatView.tsx と同じ DOM ref の書き方に揃える（`useRef<T>(null)` →
  // `RefObject<T>`。JSX の ref 属性へそのまま渡せる）。
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setCopyState({ kind: "idle" });
  }, [content]);

  useEffect(() => {
    if (copyState.kind === "failure" && textareaRef.current) {
      textareaRef.current.select();
    }
  }, [copyState]);

  const copy = () => {
    if (content === null) {
      return;
    }
    // 非セキュアコンテキストでは navigator.clipboard 自体が undefined で、
    // .writeText を呼ぶと同期的に TypeError が投げられる（.then の失敗
    // ハンドラには届かない）。try/catch で同期例外も失敗扱いに落とす。
    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard API is unavailable");
      }
      navigator.clipboard.writeText(content).then(
        () => setCopyState({ kind: "success" }),
        () => setCopyState({ kind: "failure" }),
      );
    } catch {
      setCopyState({ kind: "failure" });
    }
  };

  return { copyState, copy, textareaRef };
}
