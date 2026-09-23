import { fetch } from "@tauri-apps/plugin-http";
import { keychainGet } from "./keychain";

// 項目 3: Anthropic Messages API を plugin-http（Rust 側 reqwest）経由でストリーミング呼び出しする。tool use を 1 つ含める。
const CREATE_TASK_TOOL = {
  name: "create_task",
  description: "新しいタスクを作成する。カテゴリは 'work' 固定で自動設定される。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "タスクのタイトル（必須）" },
      due_at: { type: "string", description: '締切（ローカル暦日 "YYYY-MM-DD"）' },
      boss_comment: { type: "string", description: "ボスの決定・コメント" },
    },
    required: ["title"],
  },
};

export interface StreamLog { t: number; kind: string; text?: string }

export async function runLlmCheck(onDelta: (text: string) => void) {
  const key = await keychainGet();
  if (!key) return { ok: false, error: "no api key in keychain" };
  const t0 = performance.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
      // plugin-http は WebView の Origin（tauri://localhost）を転送するため、Anthropic 側でブラウザ直アクセス扱いになり 401 になる（実測）。
      // 明示のオプトインヘッダで通す（BYOK＝利用者自身のキーなので漏洩リスクの前提は同じ）。
      "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      stream: true,
      system: "あなたは部下を管理する上司。まず日本語で一言だけ決定を述べ、その後に必ず create_task ツールを 1 回呼ぶこと。",
      tools: [CREATE_TASK_TOOL],
      messages: [{ role: "user", content: "明日までに週報を書かないといけません。" }],
    }),
  });
  if (!res.ok || !res.body) return { ok: false, status: res.status, error: await res.text() };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolJson: string[] = [];
  let toolName = "";
  let stopReason = "";
  const chunkTimes: number[] = [];
  let firstTextAt = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkTimes.push(Math.round(performance.now() - t0));
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const ev = JSON.parse(dataLine.slice(6));
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") toolName = ev.content_block.name;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (firstTextAt < 0) firstTextAt = Math.round(performance.now() - t0);
        text += ev.delta.text;
        onDelta(text);
      }
      if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") toolJson.push(ev.delta.partial_json);
      if (ev.type === "message_delta") stopReason = ev.delta.stop_reason;
    }
  }
  const totalMs = Math.round(performance.now() - t0);
  let toolInput: unknown = null;
  try { toolInput = JSON.parse(toolJson.join("") || "null"); } catch { toolInput = toolJson.join(""); }
  return { ok: toolName === "create_task" && text.length > 0, status: res.status, text, toolName, toolInput, stopReason, chunks: chunkTimes.length, firstChunkMs: chunkTimes[0], firstTextMs: firstTextAt, totalMs, inputJsonDeltas: toolJson.length };
}
