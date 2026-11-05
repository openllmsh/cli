import type {
  TMarketplaceLaunch,
  TMarketplaceLaunchServer,
} from "@openllmsh/sdk/mcp";
import {
  LAUNCH_TIMEOUT_MS,
  fetchMarketplaceLaunch as sdkFetchMarketplaceLaunch,
} from "@openllmsh/sdk/mcp";
import type { TGateway } from "./gateway";

export type { TMarketplaceLaunch, TMarketplaceLaunchServer };
export { LAUNCH_TIMEOUT_MS };

/**
 * The user's enabled marketplace integrations as ready upstream MCP servers
 * (`GET /api/marketplace/launch`). Delegates to
 * `@openllmsh/sdk/mcp` (which goes through `@openllmsh/sdk/client` HTTP).
 */
export const fetchMarketplaceLaunch = async (
  gateway: TGateway,
): Promise<TMarketplaceLaunch> =>
  sdkFetchMarketplaceLaunch({
    cloudOrigin: gateway.cloudOrigin,
    apiKey: gateway.apiKey,
  });

/** Convenience: only the remote MCP servers from {@link fetchMarketplaceLaunch}. */
export const fetchMarketplaceServers = async (
  gateway: TGateway,
): Promise<readonly TMarketplaceLaunchServer[]> =>
  (await fetchMarketplaceLaunch(gateway)).servers;
