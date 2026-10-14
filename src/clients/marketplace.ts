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

/** Ids the launcher already writes — an integration can never shadow them. */
const RESERVED = new Set(["openllm"]);

/**
 * The user's enabled marketplace integrations as ready MCP servers
 * (`GET /api/marketplace/launch`). The gateway decrypts BYOK secrets with the
 * key's request-scoped DEK, the same way it decrypts provider keys. Fails
 * open to none: a slow or older gateway must never block a launch.
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

type TJson = Record<string, unknown>;

const isRemote = (s: TMarketplaceLaunchServer): boolean =>
  s.transport !== "stdio" && s.url !== undefined;

/** Claude Code `mcpServers` entries (`--mcp-config` file). */
export const claudeMcpServers = (
  servers: readonly TMarketplaceLaunchServer[],
): TJson =>
  Object.fromEntries(
    servers.map((s) => [
      s.id,
      isRemote(s)
        ? { type: s.transport, url: s.url, headers: s.headers ?? {} }
        : { command: s.command, args: s.args ?? [], env: s.env ?? {} },
    ]),
  );

/** OpenCode `mcp` entries (its own schema: `remote` / `local`). */
export const openCodeMcpServers = (
  servers: readonly TMarketplaceLaunchServer[],
): TJson =>
  Object.fromEntries(
    servers.map((s) => [
      s.id,
      isRemote(s)
        ? { type: "remote", url: s.url, headers: s.headers ?? {} }
        : {
            type: "local",
            command: [s.command, ...(s.args ?? [])],
            environment: s.env ?? {},
          },
    ]),
  );

/** Hermes and Grok `mcp_servers` entries (`url` + `headers` table). */
export const hermesMcpServers = (
  servers: readonly TMarketplaceLaunchServer[],
): TJson =>
  Object.fromEntries(
    servers.map((s) => [
      s.id,
      isRemote(s)
        ? { url: s.url, headers: s.headers ?? {} }
        : { command: s.command, args: s.args ?? [], env: s.env ?? {} },
    ]),
  );

/**
 * Codex: `-c` overrides plus env. Header VALUES never reach argv — each header
 * is mapped by `env_http_headers` to an env var carried in the child env.
 * Only remote servers are supported here; stdio entries need P3.
 */
export const codexMcpOverrides = (
  servers: readonly TMarketplaceLaunchServer[],
): {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
} => {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const s of servers) {
    if (!isRemote(s)) continue;
    const key = `mcp_servers.${s.id}`;
    args.push("-c", `${key}.url=${JSON.stringify(s.url)}`);
    const map: Record<string, string> = {};
    for (const [header, value] of Object.entries(s.headers ?? {})) {
      const varName = `OPENLLM_MCP_${s.id}_${header}`
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_");
      map[header] = varName;
      env[varName] = value;
    }
    if (Object.keys(map).length > 0) {
      const inline = Object.entries(map)
        .map(([h, v]) => `${JSON.stringify(h)} = ${JSON.stringify(v)}`)
        .join(", ");
      args.push("-c", `${key}.env_http_headers={ ${inline} }`);
    }
  }
  return { args, env };
};
