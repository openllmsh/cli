/**
 * Thin runtime wrapper over the generated operations table — the OpenLLM
 * SDK's transport. Resolves an operation's path/query/body from the tool
 * args, authenticates with the user's `sk-llm-...` key, and returns the
 * parsed response. No workspace deps — the cli mirror is
 * self-contained.
 */

import type { TApiOperation } from "./generated/operations";

/**
 * The daemon's per-boot local caller credential, injected by the CLI process
 * (`sdk/daemon-auth.ts`, installed from `main.ts`). This module is also
 * bundled into the WEB app through the shared MCP tool definitions, so it must
 * not import the Node-only `../env` itself: a static import put `node:fs` into
 * the browser bundle and broke the Next.js build. Unset (the browser), no
 * target counts as the daemon and no token is ever attached.
 */
export type TDaemonCallerAuth = {
  readonly ports: () => ReadonlySet<number>;
  readonly header: string;
  readonly token: () => string | null;
};

let daemonCallerAuth: TDaemonCallerAuth | null = null;

export const setDaemonCallerAuth = (auth: TDaemonCallerAuth | null): void => {
  daemonCallerAuth = auth;
};

/** Optional transport controls for latency-sensitive embedded consumers. */
export type THttpClientOptions = {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
};

/** A `http://` loopback target. */
const isLoopbackUrl = (url: URL): boolean =>
  url.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

/**
 * A loopback target that IS this machine's daemon — the only destination the
 * per-boot local caller token may be sent to. Port-bound so a redirect to an
 * arbitrary local port can't harvest the credential (see
 * `env.daemonTokenPorts`).
 */
const isDaemonUrl = (url: URL): boolean =>
  daemonCallerAuth !== null &&
  isLoopbackUrl(url) &&
  daemonCallerAuth.ports().has(url.port === "" ? 80 : Number(url.port));

/**
 * The canonical cloud move — the only cross-origin redirect the `sk-llm`
 * bearer may ride (mirrors `memory-hooks/transport.ts`). `?__origin=`-
 * signed or arbitrary 30x targets are never followed carrying credentials.
 */
const isCanonicalCloudMove = (from: URL, to: URL): boolean =>
  from.origin === "https://openllm.sh" &&
  to.origin === "https://www.openllm.sh";

const MAX_FETCH_REDIRECTS = 4;

/**
 * The SDK's default transport: MANUAL redirects plus the daemon's per-boot
 * local caller credential.
 *
 * Why manual: the gateway answers subscription `/v1/*` calls with a 307 to
 * `http://127.0.0.1:<port>` — an auto-following fetch would (a) strip
 * `Authorization` on the cross-origin hop, leaving the loopback request
 * unauthenticated against the daemon's caller gate, and (b) happily carry
 * the `sk-llm` bearer (and the request body) to ANY origin the upstream
 * named. This transport follows only method-preserving 307/308s to a
 * same-origin, loopback, or canonical-cloud target; every other redirect is
 * returned to the caller verbatim.
 *
 * On a DAEMON target (loopback + the configured daemon port) the caller's
 * own credential headers are ALWAYS stripped — `authorization` and
 * `x-api-key` never ride a loopback daemon hop, so a process squatting on
 * the port is never handed the `sk-llm`. Only the per-boot local caller
 * token is presented (`x-openllm-local-token`), the loopback-only
 * credential the daemon swaps for the paired key before any upstream call.
 * When no token is readable the hop goes unauthenticated and the daemon's
 * 401 is the honest answer. Other loopback ports get neither the token nor
 * a stripped bearer — a mock or third-party local server keeps the caller's
 * own credential.
 */
export const localAwareFetch = async (
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> => {
  let target = new URL(String(input));
  for (let hop = 0; ; hop++) {
    const headers = new Headers(init.headers);
    if (daemonCallerAuth !== null && isDaemonUrl(target)) {
      headers.delete("authorization");
      headers.delete("x-api-key");
      const token = daemonCallerAuth.token();
      if (token !== null) {
        headers.set(daemonCallerAuth.header, token);
      }
    }
    const res = await fetch(target, {
      ...init,
      headers,
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (
      (res.status !== 307 && res.status !== 308) ||
      location === null ||
      hop >= MAX_FETCH_REDIRECTS
    ) {
      return res;
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return res;
    }
    // Redirected hops re-issue the request — body included — so the only
    // loopback target allowed is the daemon itself; any other local port is
    // surfaced verbatim (following would leak the prompt AND, pre-port-bound,
    // the token).
    const allowed =
      next.origin === target.origin ||
      isDaemonUrl(next) ||
      isCanonicalCloudMove(target, next);
    if (!allowed) return res;
    // Drain the redirect body so the socket is reusable before re-issue.
    await res.arrayBuffer().catch(() => undefined);
    target = next;
  }
};

export type TSdkConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
};

export type TSdkResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
};

/** Substitute `{param}` path segments and collect query params. */
const resolveUrl = (
  config: TSdkConfig,
  op: TApiOperation,
  args: Record<string, unknown>,
): string => {
  let path = op.path;
  for (const p of op.pathParams) {
    const v = args[p];
    if (v === undefined || v === null || String(v).length === 0) {
      throw new Error(`missing required path parameter "${p}"`);
    }
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }
  const url = new URL(
    // The spec binds operations to the `/api` server (same as the served
    // swagger doc); `/v1/*` paths are already absolute under the origin.
    path.startsWith("/v1/") ? path : `/api${path}`,
    config.baseUrl,
  );
  for (const q of op.queryParams) {
    const v = args[q.name];
    if (v === undefined || v === null) {
      if (q.required)
        throw new Error(`missing required query parameter "${q.name}"`);
      continue;
    }
    url.searchParams.set(q.name, String(v));
  }
  return url.toString();
};

// Generous ceiling: some native operations proxy long-running provider calls
// (image generation, chat), but a tool call must never hang the MCP server
// forever on a wedged upstream.
const REQUEST_TIMEOUT_MS = 120_000;

export const callOperation = async (
  config: TSdkConfig,
  op: TApiOperation,
  args: Record<string, unknown>,
  options: THttpClientOptions = {},
): Promise<TSdkResponse> => {
  const url = resolveUrl(config, op, args);
  const init: RequestInit = {
    method: op.method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(op.hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(op.hasBody && args.body !== undefined
      ? { body: JSON.stringify(args.body) }
      : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  };
  const res = await (options.fetch ?? localAwareFetch)(url, init);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  return { ok: res.ok, status: res.status, body, headers: res.headers };
};
