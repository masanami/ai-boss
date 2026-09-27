// ---------------------------------------------------------------------------
// SSE の区切り処理（BYOK の Anthropic・OpenAI の両バックエンドで共有する。
// #636。JSON の解釈と失敗の値はバックエンドごとに異なるため、ここでは
// `data:` のペイロードの文字列までを返す）
// ---------------------------------------------------------------------------

/** `rawEvent`（空行で区切られた1イベント分のテキスト。行末は LF に揃え
 * 済み）から `data:` 行の値を取り出す（複数の `data:` 行は `\n` で連結する
 * ——SSE の仕様どおり）。`data:` 行が無ければ `undefined`（例: 空行のみの
 * イベント）。 */
function extractSseDataPayload(rawEvent: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length > 0 ? dataLines.join("\n") : undefined;
}

/** SSE の行末（CRLF・CR・LF のいずれも可）を LF に揃える（PR #633 の Codex の指摘）。 */
function normalizeSseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 本文のバイト列の非同期の列から、SSE の `data:` ペイロードの文字列を順に
 * 生成する。断片の区切りが SSE イベントの途中・多バイト文字の途中・CRLF の
 * `\r` と `\n` の間にあっても、イベントの境界が揃うまでバッファへ溜めるので
 * 壊れない。 */
export async function* iterateSseDataPayloadTexts(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  // 断片の末尾の "\r" は、次の断片の先頭の "\n" と組の CRLF でありうるため、
  // 次の断片が来るまで行末の正規化を保留する（単独の CR として先に LF へ
  // 変えると、続く "\n" と合わせて偽の空行＝イベントの境界になる）。
  let pendingCr = "";
  for await (const chunk of body) {
    const text = pendingCr + decoder.decode(chunk, { stream: true });
    pendingCr = text.endsWith("\r") ? "\r" : "";
    buffer += normalizeSseLineEndings(pendingCr ? text.slice(0, -1) : text);
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = extractSseDataPayload(rawEvent);
      if (payload !== undefined) {
        yield payload;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += normalizeSseLineEndings(pendingCr + decoder.decode());
  const trimmed = buffer.trim();
  if (trimmed !== "") {
    const payload = extractSseDataPayload(trimmed);
    if (payload !== undefined) {
      yield payload;
    }
  }
}
