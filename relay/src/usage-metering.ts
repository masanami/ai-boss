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

/**
 * 利用量のポートが扱う原価単位の**整数表現**: 原価単位 × 10^10 を 1 とする。
 * 浮動小数で足すと「合計がちょうど上限に等しいなら成功」の契約が崩れる
 * （0.1 + 0.1 + 0.1 > 0.3）ため、予約・精算・上限の判定はすべてこの整数で行う。
 */
export const COST_UNIT_SCALE = 10_000_000_000;

/**
 * 重み（1M トークンあたり）の整数表現の倍率。重みは 10^-4 刻みで持つ
 * （設定の検証が刻みに合わない重みを拒否する）。トークン数 × 整数の重みが、
 * そのまま {@link COST_UNIT_SCALE} の整数表現の原価単位になる
 * （Σ トークン数 × 重み ÷ 10^6 × 10^10 ＝ Σ トークン数 × 重み × 10^4）。
 */
export const WEIGHT_SCALE = 10_000;

/** 重みを整数表現にする。 */
export function scaledWeight(weight: number): number {
  return Math.round(weight * WEIGHT_SCALE);
}

/** 設定の原価単位（上限値）を整数表現にする。 */
export function scaledUnits(units: number): number {
  return Math.round(units * COST_UNIT_SCALE);
}

/** 原価単位（整数表現）＝ Σ（トークン数 × 重み）÷ 1,000,000 × 10^10。 */
export function costUnits(usage: TokenUsage, weights: CostWeights): number {
  return (
    usage.inputTokens * scaledWeight(weights.input) +
    usage.outputTokens * scaledWeight(weights.output) +
    usage.cacheReadInputTokens * scaledWeight(weights.cacheRead) +
    usage.cacheCreationInputTokens * scaledWeight(weights.cacheWrite)
  );
}

/**
 * 送信前に予約する最大原価（整数表現）。入力側の重みは入力・キャッシュ読み出し・
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
  const inputWeight = Math.max(scaledWeight(weights.input), scaledWeight(weights.cacheRead), scaledWeight(weights.cacheWrite));
  return estimatedInputTokens * inputWeight + maxTokens * scaledWeight(weights.output);
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

/** `[上流の項目名, 内部の名前, 必須か]`。必須の項目は `null` も壊れた値とみなす。 */
const USAGE_FIELDS = [
  ["input_tokens", "inputTokens", true],
  ["output_tokens", "outputTokens", true],
  ["cache_read_input_tokens", "cacheReadInputTokens", false],
  ["cache_creation_input_tokens", "cacheCreationInputTokens", false],
] as const;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 上流の `usage` からトークン数の項目を拾う。項目があるのに値が壊れている
 * （負の数・小数・文字列、必須の項目の `null`）ときは `malformed` にする——
 * 壊れた項目を黙って落とすと、前のイベントの値が残ったまま確定してしまう
 * （PR #638 の Codex の指摘）。キャッシュの項目の `null` は「無い」として扱う。
 */
function readUsageFields(raw: unknown): { fields: PartialUsage; malformed: boolean } {
  const fields: PartialUsage = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { fields, malformed: true };
  }
  const record = raw as Record<string, unknown>;
  for (const [wire, name, required] of USAGE_FIELDS) {
    if (!(wire in record) || (!required && record[wire] === null)) {
      continue;
    }
    const value = record[wire];
    if (!isTokenCount(value)) {
      return { fields, malformed: true };
    }
    fields[name] = value;
  }
  return { fields, malformed: false };
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
  let malformed = false;
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
      // 解釈できないイベントが 1 つでもあれば、終端まで届いても実額には使わない
      // （そのイベントが usage を運んでいた可能性がある。PR #638 の Codex の 2 巡目の指摘）。
      malformed = true;
      return;
    }
    if (typeof event !== "object" || event === null) {
      malformed = true;
      return;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "message_start") {
      const message = record.message as Record<string, unknown> | undefined;
      const read = readUsageFields(message?.usage);
      usage = read.fields;
      malformed ||= read.malformed;
    } else if (record.type === "message_delta" && record.usage !== undefined) {
      const read = readUsageFields(record.usage);
      usage = { ...usage, ...read.fields };
      malformed ||= read.malformed;
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
      // 壊れた usage が 1 度でも届いたら、実額には使わない（予約額で確定する）。
      return sawMessageStop && !malformed ? completeUsage(usage) : null;
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
      const read = readUsageFields((body as Record<string, unknown>).usage);
      return read.malformed ? null : completeUsage(read.fields);
    },
  };
}
