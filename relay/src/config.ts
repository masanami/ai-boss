import { WEIGHT_SCALE, scaledUnits } from "./usage-metering.js";

/**
 * 中継の設定の型と検証（機能仕様 docs/features/llm-relay-server.md
 * クリティカル設計決定 3・4、「機能全体の設計」の「設定の検証」）。
 *
 * 本番の値（既定モデル・重み・上限値）は S3 で入れる。S1 はテストが値を渡す。
 */

/** 原価単位の重み（いずれも 1M トークンあたり。10^-4 刻み）。 */
export interface CostWeights {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** adaptive thinking を受けたときに代わりに送る値（仮定 A4。必要になったら種類を足す）。 */
export type ThinkingReplacement = { type: "disabled" };

/** モデルの許可リストの 1 行。 */
export interface RelayModel {
  id: string;
  weights: CostWeights;
  /**
   * 要求の `thinking` が `{ type: "adaptive" }` のときに代わりに送る値。
   * `undefined` は書き換えない（adaptive thinking に対応するモデル）。
   */
  adaptiveThinkingReplacement?: ThinkingReplacement;
  /** `output_config.effort` に対応するか。`false` なら effort を取り除く。 */
  supportsEffort: boolean;
}

export interface RelayConfig {
  /** 上流（プロバイダ）の Messages API の URL。 */
  upstreamUrl: string;
  /** 既定モデルのモデル ID（`models` のいずれかの行の `id`）。 */
  defaultModel: string;
  models: RelayModel[];
  /** `max_tokens` の上限（これを超える要求は 400）。 */
  maxTokensCap: number;
  /** 要求本文の UTF-8 のバイト数の上限（これを超える要求は 413）。 */
  maxRequestBytes: number;
  /** 入力の見積もりトークン数 ＝ ceil(本文のバイト数 × これ)（仮定 A10）。 */
  inputTokensPerByte: number;
  /** 1 日（UTC の暦日）の原価単位の上限。 */
  dailyLimit: number;
  /** 1 か月（UTC の暦月）の原価単位の上限。 */
  monthlyLimit: number;
  /** アカウントごとの同時要求数（未精算の予約の件数）の上限。 */
  maxConcurrentRequests: number;
  /** 予約の期限（予約の時刻からのミリ秒）。 */
  reservationTtlMs: number;
  /**
   * 1 要求の応答について中継が内部に持つバイト数の上限（#641）。次の 2 つに
   * **それぞれ**効く（非ストリーミングの応答では両方が同時にありうるため、1 要求の
   * 保持量はこの値のおよそ 2 倍まで）:
   * - アプリがまだ読んでいない断片の待ち行列。これを超えたらアプリ側を中止する。
   * - 非ストリーミングの計測器が持つ本文。これを超えたら持つのをやめ、予約額で
   *   確定する（この値を下げると、実額で精算できる本文の大きさも狭まる）。
   * 省略時は {@link DEFAULT_MAX_BUFFERED_RESPONSE_BYTES}。
   */
  maxBufferedResponseBytes?: number;
}

/**
 * `maxBufferedResponseBytes` の既定（1 MiB）。読み続けるアプリの待ち行列はほぼ空の
 * ため、これを超えるのは読まない（止まった）アプリだけである。非ストリーミングの
 * 本文は出力 128k トークンの日本語（1 トークン 3 バイト程度）でも 400KB 程度に
 * 収まる。本番の値は実行基盤のメモリと合わせて S3 で決める。
 */
export const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 1024 * 1024;

/** 設定が不正なときに `createRelayApp` が投げる例外。 */
export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** 重みは 10^-4 刻み（`usage-metering.ts` の `WEIGHT_SCALE`。原価単位を整数で数えるため）。 */
function isOnWeightGrid(weight: number): boolean {
  const scaled = weight * WEIGHT_SCALE;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function assertWeights(model: RelayModel): void {
  const { weights } = model;
  for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!isNonNegativeFinite(weights?.[name]) || !isOnWeightGrid(weights[name])) {
      throw new RelayConfigError(`model "${model.id}" has an invalid ${name} weight`);
    }
  }
}

function assertThinkingReplacement(model: RelayModel): void {
  const replacement = model.adaptiveThinkingReplacement;
  if (replacement !== undefined && replacement.type !== "disabled") {
    throw new RelayConfigError(`model "${model.id}" has an invalid adaptiveThinkingReplacement`);
  }
}

/**
 * 設定を検証し、既定モデルの行を返す。不正なら {@link RelayConfigError} を
 * 投げる（中継を組み立てさせない）。
 */
export function validateRelayConfig(config: RelayConfig): RelayModel {
  let upstream: URL;
  try {
    upstream = new URL(config.upstreamUrl);
  } catch {
    throw new RelayConfigError("upstreamUrl is not a valid URL");
  }
  // 事業者のキーを平文で送らない。
  if (upstream.protocol !== "https:") {
    throw new RelayConfigError("upstreamUrl must be an https URL");
  }
  // 資格情報を含む URL は fetch の Request が拒否する（予約の後で失敗させない）。
  if (upstream.username !== "" || upstream.password !== "") {
    throw new RelayConfigError("upstreamUrl must not contain credentials");
  }
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new RelayConfigError("models must be a non-empty list");
  }
  const seen = new Set<string>();
  for (const model of config.models) {
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new RelayConfigError("every model must have a non-empty id");
    }
    if (seen.has(model.id)) {
      throw new RelayConfigError(`model "${model.id}" is listed more than once`);
    }
    seen.add(model.id);
    assertWeights(model);
    assertThinkingReplacement(model);
    if (typeof model.supportsEffort !== "boolean") {
      throw new RelayConfigError(`model "${model.id}" must declare supportsEffort`);
    }
  }
  const defaultModel = config.models.find((model) => model.id === config.defaultModel);
  if (!defaultModel) {
    throw new RelayConfigError("defaultModel is not in the model allowlist");
  }
  for (const name of ["maxTokensCap", "maxRequestBytes", "maxConcurrentRequests"] as const) {
    if (!isPositiveInteger(config[name])) {
      throw new RelayConfigError(`${name} must be a positive integer`);
    }
  }
  if (config.maxBufferedResponseBytes !== undefined && !isPositiveInteger(config.maxBufferedResponseBytes)) {
    throw new RelayConfigError("maxBufferedResponseBytes must be a positive integer");
  }
  for (const name of ["inputTokensPerByte", "reservationTtlMs"] as const) {
    if (!isPositiveFinite(config[name])) {
      throw new RelayConfigError(`${name} must be a positive number`);
    }
  }
  for (const name of ["dailyLimit", "monthlyLimit"] as const) {
    // 整数表現（原価単位 × 10^10）が正確に数えられる範囲に限る。
    if (!isNonNegativeFinite(config[name]) || !Number.isSafeInteger(scaledUnits(config[name]))) {
      throw new RelayConfigError(`${name} must be a non-negative number within the countable range`);
    }
  }
  return defaultModel;
}
