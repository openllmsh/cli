/**
 * Thin runtime wrapper over the generated operations table — the OpenLLM
 * SDK's transport. Resolves an operation's path/query/body from the tool
 * args, authenticates with the user's `sk-llm-...` key, and returns the
 * parsed response. No workspace deps — the openllmc mirror is
 * self-contained.
 */

import type { TApiOperation } from "./generated/operations";

export type TSdkConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
};

export type TSdkResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
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

export const callOperation = async (
  config: TSdkConfig,
  op: TApiOperation,
  args: Record<string, unknown>,
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
  };
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  return { ok: res.ok, status: res.status, body };
};
