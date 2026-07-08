/**
 * supermemory plugin config.
 *
 * Embedding happens entirely on the gateway (host-paid Bedrock Titan v2
 * at 1024-d, fixed). The bundle ships raw text to
 * `/api/plugins/supermemory/{save,forget,search}` and never touches an
 * embedding endpoint — keeps the host model off the public surface.
 */

export const COLLECTION_NAME = "memories";

// Gateway credentials are resolved by the unified server (`../server.ts` via
// `requireKeyedConfig` in `src/env.ts`) — this module only carries the shape
// the tools receive. No env reads here.
export interface PluginConfig {
  name: string;
  version: string;
  gatewayUrl: string;
  gatewayApiKey: string;
}
