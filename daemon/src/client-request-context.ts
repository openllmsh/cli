/**
 * Per-request client origin for the daemon: which client (Claude Code, Codex,
 * the desktop app, a website, …) sent the inference request being walked.
 * `handleInference` derives it from the inbound headers once; `recordRequest`
 * stamps it on the usage record so the cloud's `public.requests` row knows
 * where the request came from (`client_kind` / `client_host`).
 *
 * Bound with AsyncLocalStorage, like the team grant and the hold session, so
 * concurrent requests and stream-completion records scheduled inside the
 * dispatch keep their own client.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TClientOrigin } from "@openllmsh/sdk/protocol";
import {
  clientOriginOfRequest,
  normalizeClientOrigin,
} from "@openllmsh/sdk/protocol";

/**
 * In-process headers `tunnel-server.ts` sets from a tunnel OPEN's
 * `client_kind` / `client_host` (the client the consumer — origin — already
 * derived). Honoured only for tunneled requests: on the loopback surface a
 * local caller could otherwise name any client it liked.
 */
export const FORWARDED_CLIENT_KIND_HEADER = "x-openllm-forwarded-client";
export const FORWARDED_CLIENT_HOST_HEADER = "x-openllm-forwarded-client-host";

const clientContext = new AsyncLocalStorage<TClientOrigin>();

/** The request's client: the forwarded one when trusted, else its headers. */
export const clientOriginOf = (
  req: Request,
  trustForwarded: boolean,
): TClientOrigin => {
  if (trustForwarded) {
    const forwarded = normalizeClientOrigin(
      req.headers.get(FORWARDED_CLIENT_KIND_HEADER),
      req.headers.get(FORWARDED_CLIENT_HOST_HEADER),
    );
    if (forwarded !== null) return forwarded;
  }
  return clientOriginOfRequest(req);
};

export const withRequestClient = <T>(
  req: Request,
  run: () => T,
  trustForwarded = false,
): T => clientContext.run(clientOriginOf(req, trustForwarded), run);

export const currentRequestClient = (): TClientOrigin | null =>
  clientContext.getStore() ?? null;

/** The record fields for the current request's client; none outside one. */
export const clientFieldsForRecord = (): {
  readonly client_kind?: string;
  readonly client_host?: string;
} => {
  const client = currentRequestClient();
  if (client === null) return {};
  return {
    client_kind: client.kind,
    ...(client.host === null ? {} : { client_host: client.host }),
  };
};
