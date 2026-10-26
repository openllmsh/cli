import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "../cli-version";
import type { TCliConfig } from "../env";
import { openllmDir } from "../env";
import { MemoryClient } from "../mcp/memory/client";
import { memoryHookTransport } from "./transport";

/** Short TTL — toggles should take effect within a minute without hammering. */
const ENABLED_CACHE_TTL_MS = 60_000;

type TEnabledCache = {
  readonly ts: number;
  readonly enabled: boolean;
};

const cachePath = (config: TCliConfig): string => {
  const dir = join(openllmDir(), "cache", "memory-enabled");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(`${config.gatewayUrl}\0${config.apiKey}`)
    .digest("hex")
    .slice(0, 32);
  return join(dir, `${key}.json`);
};

const readCache = (path: string): TEnabledCache | null => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as TEnabledCache;
    if (
      typeof raw.ts !== "number" ||
      typeof raw.enabled !== "boolean" ||
      Date.now() - raw.ts > ENABLED_CACHE_TTL_MS
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
};

const writeCache = (path: string, enabled: boolean): void => {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ts: Date.now(), enabled } satisfies TEnabledCache),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } catch {
    // Cache is best-effort.
  }
};

/**
 * Cheap personal OpenLLM Memory enablement check for hooks.
 *
 * Fail-open = skip: any network/parse failure returns `false` so the hook
 * never blocks the prompt. A positive/negative answer is cached briefly.
 */
export const isPersonalMemoryEnabledCached = async (
  config: TCliConfig,
): Promise<boolean> => {
  if (!config.apiKey || !config.gatewayUrl) return false;
  const path = cachePath(config);
  const cached = readCache(path);
  if (cached !== null) return cached.enabled;
  try {
    const client = new MemoryClient(
      {
        name: "openllm-memory",
        version: CLI_VERSION,
        gatewayUrl: config.gatewayUrl,
        gatewayApiKey: config.apiKey,
      },
      { timeoutMs: 1_500, fetch: memoryHookTransport() },
    );
    const enabled = await client.isEnabled();
    writeCache(path, enabled);
    return enabled;
  } catch {
    // Fail-open = skip (do not block the prompt / extract).
    return false;
  }
};
