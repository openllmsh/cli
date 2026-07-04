/**
 * supermemory plugin config.
 *
 * Embedding happens entirely on the gateway (host-paid Bedrock Titan v2
 * at 1024-d, fixed). The bundle ships raw text to
 * `/api/plugins/supermemory/{save,forget,search}` and never touches an
 * embedding endpoint — keeps the host model off the public surface.
 */

export const COLLECTION_NAME = "memories";

export interface PluginConfig {
  name: string;
  version: string;
  gatewayUrl: string;
  gatewayApiKey: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    console.error(`[config] ${name} is required but not set`);
    process.exit(1);
  }
  return v;
}

// TODO: Prefer LITELLMCTL_URL / LITELLMCTL_API_KEY once deployments migrate; keep LLM_GATEWAY_* as canonical for now.
export function createConfig(): PluginConfig {
  return {
    name: process.env.MCP_SERVER_NAME || "supermemory",
    version: process.env.MCP_SERVER_VERSION || "1.0.0",
    gatewayUrl: requireEnv("LLM_GATEWAY_URL"),
    gatewayApiKey: requireEnv("LLM_GATEWAY_API_KEY"),
  };
}

export function logSummary(config: PluginConfig): void {
  console.log(`[MCP] Starting ${config.name} v${config.version}`);
  console.log(`[MCP]   Gateway URL: ${config.gatewayUrl}`);
  console.log(`[MCP]   Collection:  ${COLLECTION_NAME}`);
}

export function showHelp(): void {
  console.log(`
supermemory (OpenLLM plugin)

Usage: bun run src/index.ts

Required env:
  LLM_GATEWAY_URL       e.g. http://localhost:14041
  LLM_GATEWAY_API_KEY   User's gateway API key
  (TODO: document LITELLMCTL_* aliases when we switch defaults.)

Embeddings run on the gateway with host-paid Bedrock Titan v2 (1024-d).
The bundle ships raw text; nothing here calls /v1/embeddings.
`);
}
