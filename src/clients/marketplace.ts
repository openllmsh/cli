import type { TGateway } from "./gateway";

/**
 * One resolved MCP server from `/api/marketplace/launch`. Mirrors
 * the protocol contract `MarketplaceLaunchServer`, redeclared because CLI
 * command code stays free of the protocol workspace package (source-hygiene test); the
 * guard below validates the wire shape instead of decoding it.
 */
export type TMarketplaceLaunchServer = {
  readonly id: string;
  readonly transport: "http" | "sse" | "stdio";
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

const isStringRecord = (v: unknown): v is Record<string, string> =>
  v !== null &&
  typeof v === "object" &&
  Object.values(v).every((x) => typeof x === "string");

const isLaunchServer = (v: unknown): v is TMarketplaceLaunchServer => {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    /^[a-z][a-z0-9-]{1,47}$/.test(s.id) &&
    (s.transport === "http" ||
      s.transport === "sse" ||
      s.transport === "stdio") &&
    (s.url === undefined || typeof s.url === "string") &&
    (s.headers === undefined || isStringRecord(s.headers)) &&
    (s.command === undefined || typeof s.command === "string") &&
    (s.args === undefined ||
      (Array.isArray(s.args) && s.args.every((a) => typeof a === "string"))) &&
    (s.env === undefined || isStringRecord(s.env))
  );
};

const LAUNCH_TIMEOUT_MS = 5_000;

/** Reserved ids — an integration can never shadow the built-in server. */
const RESERVED = new Set(["openllm"]);

/**
 * The user's enabled marketplace integrations as ready upstream MCP servers,
 * dialled by `openllm mcp` and re-exported through its single entry
 * (`GET /api/marketplace/launch`). The gateway decrypts BYOK secrets with the
 * key's request-scoped DEK, the same way it decrypts provider keys. Fails
 * open to none: a slow or older gateway must never block the MCP server.
 */
export const fetchMarketplaceServers = async (
  gateway: TGateway,
): Promise<readonly TMarketplaceLaunchServer[]> => {
  if (gateway.apiKey.length === 0) return [];
  try {
    const res = await fetch(`${gateway.cloudOrigin}/api/marketplace/launch`, {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: AbortSignal.timeout(LAUNCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { servers?: unknown };
    if (!Array.isArray(body.servers)) return [];
    // Drop anything malformed rather than failing the launch.
    return body.servers
      .filter(isLaunchServer)
      .filter((s) => !RESERVED.has(s.id));
  } catch {
    return [];
  }
};
