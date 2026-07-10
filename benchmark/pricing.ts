import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelPricing {
  cacheReadPrice: number;
  cacheWritePrice: number;
  inputPrice: number;
  modelId: string;
  modelName: string;
  outputPrice: number;
}

const MODELS_DEV_API_URL = "https://models.dev/api.json";

const DEFAULT_SOTA_MODELS = [
  { modelId: "deepseek-v4-pro", provider: "opencode-go" },
  { modelId: "deepseek-v4-flash", provider: "opencode-go" },
  { modelId: "qwen3.7-max", provider: "opencode-go" },
  { modelId: "mimo-v2.5-pro", provider: "opencode-go" },
  { modelId: "kimi-k2.7-code", provider: "opencode-go" },
  { modelId: "minimax-m3", provider: "opencode-go" },
  { modelId: "glm-5", provider: "opencode-go" },
];

interface ApiJsonModel {
  cost?: {
    cache_read?: number;
    cache_write?: number;
    input: number;
    output: number;
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

export async function fetchOpencodeGoPricing(
  cacheDir: string,
  models: Array<{ modelId: string; provider: string }> = DEFAULT_SOTA_MODELS
): Promise<ModelPricing[]> {
  const data = await fetchApiJson(cacheDir);
  const results: ModelPricing[] = [];

  for (const { modelId, provider } of models) {
    const providerData = data[provider];
    if (!providerData) {
      console.warn(`  provider not found: ${provider}`);
      continue;
    }

    const model = providerData.models[modelId];
    if (!model) {
      console.warn(`  model not found: ${provider}/${modelId}`);
      continue;
    }

    if (!model.cost) {
      console.warn(`  no pricing for ${provider}/${modelId}`);
      continue;
    }

    results.push({
      cacheReadPrice: model.cost.cache_read ?? 0,
      cacheWritePrice: model.cost.cache_write ?? 0,
      inputPrice: model.cost.input,
      modelId: `${provider}/${modelId}`,
      modelName: model.name,
      outputPrice: model.cost.output,
    });
  }

  return results;
}

/**
 * Prices are stored as dollars per 1M tokens. Convert to dollars per token.
 */
export function pricePerToken(dollarsPerMillion: number): number {
  return dollarsPerMillion / 1_000_000;
}
