import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fetchHuggingFaceRawFile(url: string): Promise<string> {
  return fetchRawFile(url);
}

async function fetchRawFile(url: string): Promise<string> {
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
