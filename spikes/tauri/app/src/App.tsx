import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Dashboard from "./dashboard/Dashboard";
import { runSqliteCheck } from "./spike/sqlite";
import { runLlmCheck } from "./spike/llm";
import { runNotifyBasic, runNotifyLimit } from "./spike/notify";
import { keychainSet, runKeychainCheck } from "./spike/keychain";
import { runDetectionCheck } from "./spike/detection";
import "./dashboard/index.css";

type Result = Record<string, unknown>;

// 各検証を手動ボタン、または SIMCTL_CHILD_SPIKE_SELFTEST=<カンマ区切りのステップ> で自動実行する。
function App() {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [streamText, setStreamText] = useState("");
  const [keyInput, setKeyInput] = useState("");

  const run = async (name: string, fn: () => Promise<Result>) => {
    let result: Result;
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    setResults((r) => ({ ...r, [name]: result }));
    await invoke("write_report", { name, text: JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) });
    return result;
  };

  const steps: Record<string, () => Promise<Result>> = {
    keychain: runKeychainCheck,
    sqlite: runSqliteCheck,
    detection: runDetectionCheck,
    llm: () => runLlmCheck(setStreamText),
    notify: runNotifyBasic,
    notifyLimit: runNotifyLimit,
  };

  useEffect(() => {
    (async () => {
      const t = Math.round(performance.now());
      await invoke("write_report", { name: "boot", text: JSON.stringify({ at: new Date().toISOString(), msSinceNavigationStart: t }) });
      const selftest = await invoke<string>("selftest_steps");
      for (const step of selftest.split(",").filter(Boolean)) {
        if (steps[step]) await run(step, steps[step]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={{ padding: "56px 16px 32px" }}>
      <Dashboard />
      <hr />
      <section>
        <h3>BYOK（キーチェーン）</h3>
        <input type="password" placeholder="sk-ant-..." value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        <button onClick={() => keychainSet(keyInput).then(() => setKeyInput(""))}>保存</button>
      </section>
      <section style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {Object.entries(steps).map(([name, fn]) => (
          <button key={name} onClick={() => run(name, fn)}>{name}</button>
        ))}
      </section>
      {streamText && <p data-testid="stream">{streamText}</p>}
      <pre style={{ fontSize: 10, whiteSpace: "pre-wrap" }}>
        {Object.entries(results).map(([k, v]) => `${k}: ${v.ok ? "OK" : "NG"} ${JSON.stringify(v).slice(0, 300)}\n`).join("")}
      </pre>
    </main>
  );
}

export default App;
