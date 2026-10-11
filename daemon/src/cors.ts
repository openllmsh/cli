/**
 * Shared CORS for the daemon's localhost surfaces.
 *
 * Both the control surface (`/status`, `/connect`, …) and the `/v1/*`
 * inference surface are called by the dashboard browser (an HTTPS page
 * fetching `http://127.0.0.1`), so both need to answer the CORS preflight
 * + reflect an allowed origin. Access control stays the localhost bind +
 * this origin lock — no control token.
 */
import {
  MEDIA_ERROR_RESPONSE_HEADER,
  MEDIA_PERSISTENCE_RESPONSE_HEADER,
  NO_DAEMON_HEADER,
  TOOL_SESSION_HEADER,
} from "@openllmsh/protocol";
import { daemonEnv, isDevMode } from "./env";

/**
 * Swap localhost <-> 127.0.0.1 in an origin. `localhost` and `127.0.0.1`
 * are DISTINCT origins to the browser, so a fixed allow-origin pinned to
 * one breaks the other (a dashboard on `localhost:3000` calling a daemon
 * configured for `127.0.0.1:3000` would be CORS-blocked).
 */
const loopbackSibling = (origin: string): string | null => {
  if (origin.includes("127.0.0.1")) {
    return origin.replace("127.0.0.1", "localhost");
  }
  if (origin.includes("localhost")) {
    return origin.replace("localhost", "127.0.0.1");
  }
  return null;
};

/**
 * The OpenLLM product's own deployment origins. ONE daemon serves EVERY
 * deployment (prod + previews), not just the one it was paired with — the
 * whole point of the deployment-agnostic design
 * (`docs/proposals/daemon-presence-without-heartbeat.md`). So the control
 * surface reflects any of these, regardless of the daemon's configured origin.
 */
const PROD_ORIGINS: ReadonlySet<string> = new Set([
  "https://openllm.sh",
  "https://www.openllm.sh",
]);

/**
 * OpenLLM's own Vercel preview deployments:
 *   `openllm-<hash>-quantide.vercel.app`
 *   `openllm-git-<branch>-quantide.vercel.app`
 * Anchored to the `openllm` project + `quantide` team so a stranger's
 * `*.vercel.app` can't reach the daemon's localhost control surface.
 */
const PREVIEW_ORIGIN = /^https:\/\/openllm-[a-z0-9-]+-quantide\.vercel\.app$/;

/** A real `http(s)://localhost[:port]` origin — parsed, not substring-matched, so
 *  `https://localhost.attacker.com` / `https://evil-localhost.io` can't slip past
 *  an `includes("localhost")`. Dev-only trust (see `isTrustedDeploymentOrigin`). */
const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.hostname === "localhost"
    );
  } catch {
    return false;
  }
};

export const isTrustedDeploymentOrigin = (origin: string): boolean =>
  PROD_ORIGINS.has(origin) ||
  PREVIEW_ORIGIN.test(origin) ||
  (process.env.NODE_ENV === "development" && isLocalhostOrigin(origin));

/**
 * The `access-control-allow-origin` to return for THIS request: the request's
 * `Origin` when it's the configured dashboard origin / its loopback sibling, a
 * trusted OpenLLM deployment (prod or a project preview), or — in dev — ANY
 * origin; else the configured origin.
 */
const allowOrigin = (req: Request): string => {
  const configured = daemonEnv().dashboardOrigin;
  const origin = req.headers.get("origin");
  if (origin === null) return configured;
  if (origin === configured || loopbackSibling(configured) === origin) {
    return origin;
  }
  // Any OpenLLM deployment's dashboard may drive this daemon — reflect the
  // prod origins + the project's own previews even when the daemon was
  // installed against a different one (e.g. a prod daemon used from a preview).
  if (isTrustedDeploymentOrigin(origin)) return origin;
  // Dev mode (`OPENLLM_DAEMON_DEV=1`) is an explicit local-developer opt-in and
  // the daemon binds to loopback only, so reflect ANY origin — covers a local
  // Next dev server on an arbitrary port with zero config.
  if (isDevMode()) return origin;
  return configured;
};

/**
 * CORS response headers. `allow-headers` includes:
 *  - `authorization` — the `/v1/*` surface takes `Authorization: Bearer sk-llm-…`;
 *  - `x-openllm-daemon` / `x-openllm-no-daemon` — when the gateway 307s a
 *    subscription request to `127.0.0.1`, the browser REPLAYS the original
 *    request (incl. these presence headers) to the daemon as a fresh
 *    cross-origin call; the preflight must allow them even though the daemon
 *    ignores them (the plan rides in the `?__plan=` query, not a header).
 * (The control surface only needs `content-type`, but a superset is harmless.)
 *
 * `expose-headers` covers the DIRECT cross-origin path only (the browser
 * replaying a gateway 307 to `127.0.0.1`); the mux carries its own closed
 * `res_head` struct instead. An unexposed response header is unreadable to
 * the page and therefore indistinguishable from one the daemon never sent —
 * so every media header the browser BRANCHES on must be listed, or an
 * omission degrades silently into the WRONG diagnosis rather than an error.
 */
export const corsHeaders = (req: Request): Record<string, string> => ({
  "access-control-allow-origin": allowOrigin(req),
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": `content-type, authorization, ${TOOL_SESSION_HEADER}, ${NO_DAEMON_HEADER}`,
  "access-control-expose-headers": `x-openllm-media-id, x-openllm-media-url, x-openllm-resolved-model, x-openllm-chain, ${MEDIA_ERROR_RESPONSE_HEADER}, ${MEDIA_PERSISTENCE_RESPONSE_HEADER}, ${TOOL_SESSION_HEADER}`,
  "access-control-allow-private-network": "true",
  vary: "origin",
});

/** True for a CORS/PNA preflight (handle with a 204 + cors headers). */
export const isPreflight = (req: Request): boolean => req.method === "OPTIONS";

export const preflightResponse = (req: Request): Response =>
  new Response(null, { status: 204, headers: corsHeaders(req) });

/** A JSON error envelope (`{ error: { message, type? } }`) — the daemon's
 *  standard error shape, shared by the listener + the walker. CORS is
 *  layered on by the caller's `withCors`. */
export const errorJson = (
  status: number,
  message: string,
  type?: string,
  code?: string,
): Response =>
  new Response(
    JSON.stringify({
      error: {
        message,
        ...(type !== undefined ? { type } : {}),
        ...(code !== undefined ? { code } : {}),
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
