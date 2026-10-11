/**
 * Request-private HTTP-proxy authentication for the Muse capture receiver,
 * whose `endpoint_transport.base_url` path segment `muse-bin` doesn't
 * reflect back onto its own requests (see `muse-capture.ts`'s
 * `parseMuseCaptureOriginOnlyBaseUrl` doc comment) — so
 * `capture-loopback-guard.ts`'s URL-path nonce can't reach it here.
 *
 * The nonce instead rides `Proxy-Authorization`: a process configured with
 * `HTTP_PROXY`/`http_proxy` (honored by `muse-bin`'s real `reqwest` client)
 * sends every proxied request with that header carrying the proxy URL's
 * userinfo, independent of the real application `Authorization` header and
 * body. `Proxy-Authorization`/`Proxy-Connection` are hop-by-hop framing
 * (RFC 7230 §6.1) — authenticate on it, strip it, never record or forward
 * it. Verified positive against the real production seam: see
 * `tests/transport/muse-capture-real-cli-construction.e2e.test.ts`.
 *
 * Scope: guards the model-capture receiver's own address only.
 * `HTTP_PROXY`/`http_proxy` are process-wide, so they would also redirect a
 * session's local MCP-server traffic (`tools/list`/`tools/call`) through
 * this same proxy, which only understands the model-capture shape.
 * Callers MUST also always set `NO_PROXY`/`no_proxy` — even to `""` when no
 * MCP server is registered, never merely omitted, since an inherited
 * ambient value would otherwise survive the child-env merge — to the local
 * MCP server's bare hostname (see {@link museCaptureProxyNoProxyHosts}; a
 * bare hostname, not `host:port` — NO_PROXY port-matching is not reliably
 * portable across clients). Env vars are set on the spawned child's own env
 * only, never global/system config.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** 128 bits — same minimum as `capture-loopback-guard.ts`. */
const CREDENTIAL_BYTES = 16;
const PROXY_USERNAME = "openllm-capture";

export type TCaptureLoopbackProxyGuard = {
  /**
   * `http://<fresh-nonce-userinfo>@<host>` for the given `hostAndPort`
   * (e.g. `127.0.0.1:54321`) — set this as `HTTP_PROXY`/`http_proxy` on the
   * child's env. The destination the child ACTUALLY dials is irrelevant to
   * this value: the proxy hop authenticates the CHILD, not the target.
   */
  readonly proxyUrl: (hostAndPort: string) => string;
  /**
   * True iff `headers` carries exactly this guard's `Proxy-Authorization`
   * Basic credential (constant-time compare on the decoded fixed-length
   * secret). Never reads/compares the real `Authorization` header.
   */
  readonly authenticate: (headers: Headers) => boolean;
  /**
   * The exact `Proxy-Authorization` header VALUE a correctly-configured
   * proxy-aware HTTP client presents for this guard (`Basic <base64>`).
   * Not a new capability — anyone holding `proxyUrl`'s userinfo can derive
   * this by hand; exposed directly so hermetic fixtures that simulate a
   * real client's request (rather than running one) can present it without
   * each re-implementing Basic-auth encoding.
   */
  readonly proxyAuthorizationHeaderValue: () => string;
  /**
   * A NEW `Headers` with `proxy-authorization` and `proxy-connection`
   * removed (case-insensitive) and every other header preserved verbatim
   * — the hop-framing strip this module's contract requires before the
   * request is recorded, classified, or dispatched anywhere.
   */
  readonly stripHopFraming: (headers: Headers) => Headers;
};

const PROXY_HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

/** Fresh, unguessable per-receiver proxy credential. Never reuse across receivers. */
export const createCaptureLoopbackProxyGuard =
  (): TCaptureLoopbackProxyGuard => {
    const password = randomBytes(CREDENTIAL_BYTES).toString("hex");
    const expected = `Basic ${Buffer.from(`${PROXY_USERNAME}:${password}`, "utf8").toString("base64")}`;
    const expectedBytes = Buffer.from(expected, "utf8");

    const proxyUrl = (hostAndPort: string): string =>
      `http://${PROXY_USERNAME}:${password}@${hostAndPort}`;

    const authenticate = (headers: Headers): boolean => {
      const presented = headers.get("proxy-authorization");
      if (presented === null) return false;
      const presentedBytes = Buffer.from(presented, "utf8");
      if (presentedBytes.length !== expectedBytes.length) return false;
      return timingSafeEqual(presentedBytes, expectedBytes);
    };

    const stripHopFraming = (headers: Headers): Headers => {
      const out = new Headers();
      for (const [name, value] of headers) {
        if (PROXY_HOP_HEADERS.has(name.toLowerCase())) continue;
        out.append(name, value);
      }
      return out;
    };

    return {
      proxyUrl,
      authenticate,
      stripHopFraming,
      proxyAuthorizationHeaderValue: (): string => expected,
    };
  };

/**
 * `NO_PROXY`/`no_proxy` value excluding a local MCP server's own address
 * from the child-scoped `HTTP_PROXY` above, so its `tools/list`/`tools/call`
 * traffic stays direct — never proxied, never gated by this guard, exactly
 * as it is without capture. Pass the MCP server's own `url` (whatever
 * `TMuseMcpServer.url` — e.g. `http://127.0.0.1:12345/mcp`) when one is
 * registered; omit/empty when `mcp` is null (today's bridge-capture path).
 *
 * Returns the BARE hostname (`.hostname`, e.g. `127.0.0.1`) — deliberately
 * NOT `.host` (host:port). A real reqwest client's `NO_PROXY` matching is
 * not reliably port-scoped (confirmed against the real crate: a bare
 * hostname entry excludes every port on that address; a `host:port` entry
 * is a needless, narrower bet this module must not make). Since the model
 * receiver listens on a wholly different address (`::1`, not `127.0.0.1`
 * — see `startMuseCaptureReceiver`), a bare-hostname exclusion here can
 * never accidentally swallow the model-capture target regardless of port.
 */
export const museCaptureProxyNoProxyHosts = (
  mcpServerUrl: string | null,
): string => {
  if (mcpServerUrl === null) return "";
  try {
    return new URL(mcpServerUrl).hostname;
  } catch {
    return "";
  }
};
