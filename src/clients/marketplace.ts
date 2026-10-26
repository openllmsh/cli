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
  /** Upstream tools never exposed — account-owner operations. */
  readonly blocked_tools?: readonly string[];
};

export type TMarketplaceLaunch = {
  readonly servers: readonly TMarketplaceLaunchServer[];
  /** Enabled first-party builtins (e.g. `"openllm-memory"`). */
  readonly builtins: readonly string[];
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
    (s.env === undefined || isStringRecord(s.env)) &&
    (s.blocked_tools === undefined ||
      (Array.isArray(s.blocked_tools) &&
        s.blocked_tools.every((t) => typeof t === "string")))
  );
};

/** Bound for `/api/marketplace/launch` and for the MCP factory wait on it. */
export const LAUNCH_TIMEOUT_MS = 5_000;

/** Reserved ids — an integration can never shadow the built-in server. */
const RESERVED = new Set(["openllm"]);

const EMPTY_LAUNCH: TMarketplaceLaunch = { servers: [], builtins: [] };

/**
 * The user's enabled marketplace integrations as ready upstream MCP servers
 * plus first-party builtins (`GET /api/marketplace/launch`). The gateway
 * decrypts BYOK secrets with the key's request-scoped DEK, the same way it
 * decrypts provider keys. Fails open to none: a slow or older gateway must
 * never block the MCP server. Older gateways that omit `builtins` leave it
 * empty — the CLI then skips builtin tool groups.
 */
export const fetchMarketplaceLaunch = async (
  gateway: TGateway,
): Promise<TMarketplaceLaunch> => {
  if (gateway.apiKey.length === 0) return EMPTY_LAUNCH;
  try {
    const res = await fetch(`${gateway.cloudOrigin}/api/marketplace/launch`, {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: AbortSignal.timeout(LAUNCH_TIMEOUT_MS),
    });
    if (!res.ok) return EMPTY_LAUNCH;
    const body = (await res.json()) as {
      servers?: unknown;
      builtins?: unknown;
    };
    const servers = Array.isArray(body.servers)
      ? body.servers.filter(isLaunchServer).filter((s) => !RESERVED.has(s.id))
      : [];
    const builtins = Array.isArray(body.builtins)
      ? body.builtins.filter(
          (id): id is string =>
            typeof id === "string" &&
            /^[a-z][a-z0-9-]{1,47}$/.test(id) &&
            !RESERVED.has(id),
        )
      : [];
    return { servers, builtins };
  } catch {
    return EMPTY_LAUNCH;
  }
};

/** Convenience: only the remote MCP servers from {@link fetchMarketplaceLaunch}. */
export const fetchMarketplaceServers = async (
  gateway: TGateway,
): Promise<readonly TMarketplaceLaunchServer[]> =>
  (await fetchMarketplaceLaunch(gateway)).servers;
