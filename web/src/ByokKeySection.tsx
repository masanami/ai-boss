import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ByokKeyCommandError, type ByokKeyManager } from "./byok-key-manager-context";

/**
 * 設定画面の「API キー（{プロバイダ}）」の欄（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 8）。製品版で
 * キーの操作が注入されたときだけ表示される（`SettingsView`）。
 *
 * - 表示するのは登録の有無だけ
 * - 入力は `type="password"`。登録に成功したら入力欄を空にする
 * - キーは `console` に出さない。失敗の表示は種類と OSStatus だけ
 */

function describeFailure(error: unknown): string {
  return error instanceof ByokKeyCommandError ? error.message : "キーの操作に失敗しました";
}

export default function ByokKeySection({
  manager,
  providerName = "Anthropic",
}: {
  manager: ByokKeyManager;
  /** 見出しに出すプロバイダの表示名（省略時は Anthropic。#582 S2）。 */
  providerName?: string;
}) {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    manager.isRegistered().then(
      (value) => {
        if (active) setRegistered(value);
      },
      (err: unknown) => {
        if (active) setError(describeFailure(err));
      },
    );
    return () => {
      active = false;
    };
  }, [manager]);

  const key = input.trim();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (key === "" || busy) return;
    setBusy(true);
    setError(null);
    manager
      .register(key)
      .then(
        () => {
          setInput("");
          setRegistered(true);
        },
        (err: unknown) => setError(describeFailure(err)),
      )
      .finally(() => setBusy(false));
  };

  const handleRemove = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    manager
      .remove()
      .then(
        () => setRegistered(false),
        (err: unknown) => setError(describeFailure(err)),
      )
      .finally(() => setBusy(false));
  };

  const statusText = registered === null ? "確認中…" : registered ? "登録済み" : "未登録";

  const heading = `API キー（${providerName}）`;

  return (
    <form aria-label={heading} onSubmit={handleSubmit}>
      <fieldset disabled={busy}>
        <legend>{heading}</legend>
        <p>状態: {statusText}</p>
        <label>
          API キー
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <button type="submit" disabled={key === ""}>
          登録
        </button>
        <button type="button" onClick={handleRemove} disabled={registered !== true}>
          削除
        </button>
      </fieldset>
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
}
