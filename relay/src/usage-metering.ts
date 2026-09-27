import type { CostWeights } from "./config.js";

/**
 * 利用量の計測と原価単位（機能仕様 クリティカル設計決定 4）。
 *
 * 応答の本文から読むのは `usage` の 4 種のトークン数だけで、推論内容
 * （本文の差分・ツールの入力）は読み捨てる（保持しない）。
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/** 原価単位 ＝ Σ（トークン数 × 重み）÷ 1,000,000。 */
export function costUnits(usage: TokenUsage, weights: CostWeights): number {
  return (
    (usage.inputTokens * weights.input +
      usage.outputTokens * weights.output +
      usage.cacheReadInputTokens * weights.cacheRead +
      usage.cacheCreationInputTokens * weights.cacheWrite) /
    TOKENS_PER_MILLION
  );
}

/**
 * 送信前に予約する最大原価。入力側の重みは入力・キャッシュ読み出し・
 * キャッシュ書き込みのうち最大のもの（入力がキャッシュに書き込まれて
 * 課金されても予約を下回らないため）。
 */
export function maxCostUnits(
  bodyBytes: number,
  maxTokens: number,
  inputTokensPerByte: number,
  weights: CostWeights,
): number {
  const estimatedInputTokens = Math.ceil(bodyBytes * inputTokensPerByte);
  const inputWeight = Math.max(weights.input, weights.cacheRead, weights.cacheWrite);
  return (estimatedInputTokens * inputWeight + maxTokens * weights.output) / TOKENS_PER_MILLION;
}

/** UTC の暦日（`YYYY-MM-DD`）と暦月（`YYYY-MM`）の期間キー（仮定 A5）。 */
export function periodKeys(at: Date): { dayKey: string; monthKey: string } {
  const iso = at.toISOString();
  return { dayKey: iso.slice(0, 10), monthKey: iso.slice(0, 7) };
}

// ---------------------------------------------------------------------------
// usage の読み取り
// ---------------------------------------------------------------------------

type PartialUsage = Partial<TokenUsage>;

const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["cache_read_input_tokens", "cacheReadInputTokens"],
  ["cache_creation_input_tokens", "cacheCreationInputTokens"],
] as const;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 上流の `usage` のうち、正しい形のトークン数の項目だけを拾う。 */
function readUsageFields(raw: unknown): PartialUsage {
  const picked: PartialUsage = {};
  if (typeof raw !== "object" || raw === null) {
    return picked;
  }
  const record = raw as Record<string, unknown>;
  for (const [wire, name] of USAGE_FIELDS) {
    if (isTokenCount(record[wire])) {
      picked[name] = record[wire];
    }
  }
  return picked;
}

/**
 * 実額に使える `usage` に確定する。入力と出力のトークン数が無い `usage`
 * は使わない（`null`。呼び出し側は予約額で確定する——安全側）。キャッシュの
 * 項目が無いときは 0。
 */
function completeUsage(partial: PartialUsage): TokenUsage | null {
  if (partial.inputTokens === undefined || partial.outputTokens === undefined) {
    return null;
  }
  return {
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    cacheReadInputTokens: partial.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: partial.cacheCreationInputTokens ?? 0,
  };
}

/** 応答の本文を断片ごとに受け、終わりに実額の `usage` を返す計測器。 */
export interface UsageMeter {
  push(chunk: Uint8Array): void;
  /** 実額の精算に使える `usage`。確定しないときは `null`（予約額で確定する）。 */
  result(): TokenUsage | null;
}

/**
 * ストリーミング（SSE）の計測器。`message_start` の `message.usage` を土台に、
 * 最後に届いた `message_delta` の `usage` の項目で上書きする。実額に使うのは
 * **終端（`message_stop`）まで受け取ったとき**だけ（PR #634 の 3 巡目の指摘。
 * 途中までの `usage` はその後に生成・課金された分を含まない）。
 */
export function createSseUsageMeter(): UsageMeter {
  const decoder = new TextDecoder();
  let pending = "";
  let dataLines: string[] = [];
  let usage: PartialUsage = {};
  let sawMessageStop = false;

  function dispatch(): void {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n");
    dataLines = [];
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      // 壊れた断片は計測に使わない（終端に届かなければ予約額で確定する）。
      return;
    }
    if (typeof event !== "object" || event === null) {
      return;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "message_start") {
      const message = record.message as Record<string, unknown> | undefined;
      usage = readUsageFields(message?.usage);
    } else if (record.type === "message_delta") {
      usage = { ...usage, ...readUsageFields(record.usage) };
    } else if (record.type === "message_stop") {
      sawMessageStop = true;
    }
  }

  function consumeLine(line: string): void {
    if (line === "") {
      dispatch();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
  }

  function consume(text: string): void {
    pending += text;
    let newline = pending.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const separatorLength = pending.startsWith("\r\n", newline) ? 2 : 1;
      // 末尾の "\r" は次の断片の "\n" と組になりうるため、次の断片を待つ。
      if (pending[newline] === "\r" && newline === pending.length - 1) {
        break;
      }
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + separatorLength);
      newline = pending.search(/\r\n|\r|\n/);
    }
  }

  return {
    push(chunk) {
      consume(decoder.decode(chunk, { stream: true }));
    },
    result() {
      return sawMessageStop ? completeUsage(usage) : null;
    },
  };
}

/** 非ストリーミング（JSON）の計測器。本文を最後まで受けてから `usage` を読む。 */
export function createJsonUsageMeter(): UsageMeter {
  const decoder = new TextDecoder();
  let text = "";
  return {
    push(chunk) {
      text += decoder.decode(chunk, { stream: true });
    },
    result() {
      text += decoder.decode();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return null;
      }
      if (typeof body !== "object" || body === null) {
        return null;
      }
      return completeUsage(readUsageFields((body as Record<string, unknown>).usage));
    },
  };
}
