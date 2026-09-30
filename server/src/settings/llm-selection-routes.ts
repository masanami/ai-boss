import { Hono } from "hono";
import type { Db } from "../db/db-port.js";
import { readJsonBody } from "../lib/read-json-body.js";
import {
  BYOK_MODEL_SETTING_KEY,
  BYOK_PROVIDER_SETTING_KEY,
} from "../llm/llm-selection.js";
import { MODEL_CATALOG, isBossProvider, isModelInCatalog, type BossProvider } from "../llm/model-catalog.js";
import { readSettingsSnapshot, setSettingValue } from "./settings-repository.js";

/**
 * 製品版の LLM の選択（プロバイダとモデル）の保存の入口
 * （機能仕様 docs/features/llm-provider-abstraction.md クリティカル設計決定 5
 * 「S2 の形」・仮定 A11・A13・A14）。`/api/settings` には足さず、専用の
 * `GET`・`PUT /api/llm-selection` に置く——`createCoreApp` の引数で有効にした
 * ときだけ振り向け、開発者用の版は有効にしない。
 *
 * `PUT` はプロバイダとモデルを必ず組で受け取り、モデルがそのプロバイダの
 * 一覧に無ければ 400 で拒否して何も保存しない（画面を経ずに直接呼んでも
 * 一覧外のモデルを保存できない）。2 つのキーは 1 つのトランザクションで書く。
 */

export interface LlmSelectionResponse {
  /** 保存値が `anthropic`・`openai` 以外（未保存を含む）のときは `null`（未選択）。 */
  provider: BossProvider | null;
  model: string | null;
  /** 保存したモデルが保存したプロバイダの一覧にあるか（未選択では `false`）。 */
  modelInCatalog: boolean;
  catalog: Array<{ provider: BossProvider; modelId: string; displayName: string; isDefault: boolean }>;
}

async function readSelection(db: Db): Promise<LlmSelectionResponse> {
  const stored = await readSettingsSnapshot(db);
  const rawProvider = stored.get(BYOK_PROVIDER_SETTING_KEY);
  const provider = isBossProvider(rawProvider) ? rawProvider : null;
  // 空の文字列は解決関数と同じく「モデルが無い」（未選択）として扱う。
  const storedModel = stored.get(BYOK_MODEL_SETTING_KEY);
  const model = storedModel === undefined || storedModel === "" ? null : storedModel;
  return {
    provider,
    model,
    modelInCatalog: provider !== null && model !== null && isModelInCatalog(provider, model),
    catalog: MODEL_CATALOG.map(({ provider: p, modelId, displayName, isDefault }) => ({
      provider: p,
      modelId,
      displayName,
      isDefault,
    })),
  };
}

const INVALID_BODY_ERROR = "プロバイダとモデルを組で指定してください";
const INVALID_PROVIDER_ERROR = "プロバイダは Anthropic か OpenAI から選んでください";
const INVALID_MODEL_ERROR = "選んだプロバイダで使えるモデルの一覧から選んでください";

export function createLlmSelectionRouter(db: Db): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await readSelection(db)));

  router.put("/", async (c) => {
    const body = await readJsonBody(c);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: INVALID_BODY_ERROR }, 400);
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      !keys.includes("provider") ||
      !keys.includes("model") ||
      typeof record.provider !== "string" ||
      typeof record.model !== "string"
    ) {
      return c.json({ error: INVALID_BODY_ERROR }, 400);
    }
    const { provider, model } = record as { provider: string; model: string };
    if (!isBossProvider(provider)) {
      return c.json({ error: INVALID_PROVIDER_ERROR }, 400);
    }
    if (!isModelInCatalog(provider, model)) {
      return c.json({ error: INVALID_MODEL_ERROR }, 400);
    }

    // 片方だけが保存された状態を作らない（2 つのキーは 1 つのトランザクション）。
    // 応答は同じトランザクションの中で読み直し、この要求が保存した値を返す。
    const saved = await db.transaction(async (tx) => {
      await setSettingValue(tx, BYOK_PROVIDER_SETTING_KEY, provider);
      await setSettingValue(tx, BYOK_MODEL_SETTING_KEY, model);
      return readSelection(tx);
    });
    return c.json(saved);
  });

  return router;
}
