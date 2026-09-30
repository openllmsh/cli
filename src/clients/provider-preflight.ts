import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openllmDir } from "../env";
import type { TGateway } from "./gateway";
import { CATALOG_TIMEOUT_MS } from "./gateway";

export const PROVIDER_PREFLIGHT_TTL_MS = 5 * 60_000;
export type TProviderPreflight =
  | "configured"
  | "empty"
  | "unavailable"
  | "denied";

const cachePath = (gateway: TGateway): string => {
  const key = createHash("sha256")
    .update(JSON.stringify([gateway.cloudOrigin, gateway.apiKey]))
    .digest("hex");
  return join(openllmDir(), "cache", "provider-routing", `${key}.json`);
};

const hasFreshCache = (path: string): boolean => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("checkedAt" in value) ||
      typeof value.checkedAt !== "number"
    )
      return false;
    const age = Date.now() - value.checkedAt;
    return age >= 0 && age < PROVIDER_PREFLIGHT_TTL_MS;
  } catch {
    return false;
  }
};

const cacheSuccess = (path: string): void => {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ checkedAt: Date.now() }), {
      mode: 0o600,
    });
    renameSync(temp, path);
  } catch {
    // A read-only home must not prevent a configured client from launching.
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best-effort cache */
    }
  }
};

/** `/v1/models` is cloud-owned even through the daemon. Never probe local auth. */
export const fetchProviderPreflight = async (
  gateway: TGateway,
): Promise<TProviderPreflight> => {
  if (gateway.apiKey.length === 0) return "unavailable";
  const path = cachePath(gateway);
  if (hasFreshCache(path)) return "configured";
  try {
    const response = await fetch(`${gateway.base}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return "denied";
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("data" in body) ||
      !Array.isArray(body.data) ||
      !body.data.every(
        (row: unknown) =>
          typeof row === "object" &&
          row !== null &&
          "id" in row &&
          typeof row.id === "string" &&
          row.id.trim().length > 0,
      )
    )
      return "unavailable";
    // Do not cache empty/failed reads: newly connected providers should unblock
    // the next launch immediately. Only successful eligibility is cached.
    if (body.data.length === 0) return "empty";
    cacheSuccess(path);
    return "configured";
  } catch {
    return "unavailable";
  }
};

/** One gate/message for ephemeral launches and persistent client applies. */
export const requireProviderRouting = async (
  gateway: TGateway,
): Promise<boolean> => {
  const result = await fetchProviderPreflight(gateway);
  if (result === "empty") {
    process.stderr.write(
      "No models are available for your OpenLLM account.\n" +
        "Connect a subscription provider on any device or add an API-key provider at:\n" +
        `  ${gateway.cloudOrigin.replace(/\/+$/, "")}/providers\n` +
        "Then run your OpenLLM client command again.\n",
    );
    return false;
  }
  if (result === "denied") {
    process.stderr.write(
      "OpenLLM could not authorize the model-list check. Check your API key and account access.\n",
    );
    return false;
  }
  if (result === "unavailable") {
    process.stderr.write(
      "[openllm] Could not verify available models; continuing with the configured gateway.\n",
    );
  }
  return true;
};
