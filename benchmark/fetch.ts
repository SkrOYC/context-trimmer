import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HF_ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows";

export interface FetchProgress {
  fetched: number;
  source: string;
  total: number;
}

export async function fetchHuggingFaceRows(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number
): Promise<unknown[]> {
  const url = new URL(HF_ROWS_ENDPOINT);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("config", config);
  url.searchParams.set("split", split);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(length));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${dataset} rows ${offset}-${offset + length}: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { rows: Array<{ row: unknown }> };
  return data.rows.map((r) => r.row);
}

export async function fetchGitHubRawFile(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return response.text();
}

export function ensureCacheDir(cacheDir: string): string {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

export function cacheJsonl(
  cacheDir: string,
  source: string,
  records: unknown[]
): string {
  const dir = ensureCacheDir(join(cacheDir, source));
  const path = join(dir, "data.jsonl");
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(path, lines, "utf8");
  return path;
}

export function cacheText(
  cacheDir: string,
  source: string,
  filename: string,
  content: string
): string {
  const dir = ensureCacheDir(join(cacheDir, source));
  const path = join(dir, filename);
  writeFileSync(path, content, "utf8");
  return path;
}
