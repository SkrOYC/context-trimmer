import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelPricing {
  cacheReadPrice: number;
  cacheReadPriceOver200k: number;
  cacheWritePrice: number;
  cacheWritePriceOver200k: number;
  inputPrice: number;
  inputPriceOver200k: number;
  modelId: string;
  modelName: string;
  outputPrice: number;
  outputPriceOver200k: number;
}

const MODELS_DEV_API_URL = "https://models.dev/api.json";

interface ApiJsonModel {
  cost?: {
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: {
      cache_read?: number;
      cache_write?: number;
      input?: number;
      output?: number;
    };
    input: number;
    output: number;
    tiers?: Array<{
      cache_read?: number;
      cache_write?: number;
      input?: number;
      output?: number;
      tier: { size?: number; type?: string };
    }>;
  };
  name: string;
}

interface ApiJsonProvider {
  models: Record<string, ApiJsonModel>;
}

interface ApiJson {
  [provider: string]: ApiJsonProvider;
}

async function fetchApiJson(cacheDir: string): Promise<ApiJson> {
  const cachePath = join(cacheDir, "pricing", "api.json");

  if (existsSync(cachePath)) {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(cachePath, "utf8")) as ApiJson;
  }

  const response = await fetch(MODELS_DEV_API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${MODELS_DEV_API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as ApiJson;

  const pricingDir = join(cacheDir, "pricing");
  if (!existsSync(pricingDir)) {
    mkdirSync(pricingDir, { recursive: true });
  }
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");

  return data;
}

function extractOver200kCost(
  cost: ApiJsonModel["cost"]
): Pick<
  ModelPricing,
  "cacheReadPrice" | "cacheWritePrice" | "inputPrice" | "outputPrice"
> | null {
  if (!cost) {
    return null;
  }

  if (cost.context_over_200k) {
    return {
      cacheReadPrice: cost.context_over_200k.cache_read ?? cost.cache_read ?? 0,
      cacheWritePrice:
        cost.context_over_200k.cache_write ?? cost.cache_write ?? cost.input,
      inputPrice: cost.context_over_200k.input ?? cost.input,
      outputPrice: cost.context_over_200k.output ?? cost.output,
    };
  }

  const tier = cost.tiers?.find(
    (t) =>
      t.tier.type === "context" &&
      (t.tier.size === 200_000 || t.tier.size === 200_000)
  );
  if (tier) {
    return {
      cacheReadPrice: tier.cache_read ?? cost.cache_read ?? 0,
      cacheWritePrice: tier.cache_write ?? cost.cache_write ?? cost.input,
      inputPrice: tier.input ?? cost.input,
      outputPrice: tier.output ?? cost.output,
    };
  }

  return null;
}

function buildModelPricing(
  provider: string,
  modelId: string,
  model: ApiJsonModel
): ModelPricing | undefined {
  if (!model.cost) {
    return;
  }

  const over200k = extractOver200kCost(model.cost);
  const cacheReadPrice = model.cost.cache_read ?? 0;
  const cacheWritePrice = model.cost.cache_write ?? model.cost.input;

  return {
    cacheReadPrice,
    cacheReadPriceOver200k: over200k?.cacheReadPrice ?? cacheReadPrice,
    cacheWritePrice,
    cacheWritePriceOver200k:
      over200k?.cacheWritePrice ?? over200k?.inputPrice ?? cacheWritePrice,
    inputPrice: model.cost.input,
    inputPriceOver200k: over200k?.inputPrice ?? model.cost.input,
    modelId: `${provider}/${modelId}`,
    modelName: model.name,
    outputPrice: model.cost.output,
    outputPriceOver200k: over200k?.outputPrice ?? model.cost.output,
  };
}

export async function fetchModelPricing(
  cacheDir: string,
  provider: string,
  modelId: string
): Promise<ModelPricing | undefined> {
  const data = await fetchApiJson(cacheDir);
  const providerData = data[provider];
  if (!providerData) {
    return;
  }

  const model = providerData.models[modelId];
  if (!model) {
    return;
  }

  return buildModelPricing(provider, modelId, model);
}

export async function fetchOpencodeGoPricing(
  cacheDir: string
): Promise<ModelPricing[]> {
  const data = await fetchApiJson(cacheDir);
  const providerData = data["opencode-go"];
  if (!providerData) {
    return [];
  }

  const results: ModelPricing[] = [];
  for (const [id, model] of Object.entries(providerData.models)) {
    const pricing = buildModelPricing("opencode-go", id, model);
    if (pricing) {
      results.push(pricing);
    }
  }
  return results;
}

/**
 * Prices are stored as dollars per 1M tokens. Convert to dollars per token.
 */
export function pricePerToken(dollarsPerMillion: number): number {
  return dollarsPerMillion / 1_000_000;
}
