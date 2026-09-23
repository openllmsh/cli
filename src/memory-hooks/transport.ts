import type { THttpClientOptions } from "../sdk/client";

const HOOK_USER_AGENT = "OpenLLM/memory-hooks (+https://openllm.sh)";
const RESPONSE_LIMIT = 2 * 1024 * 1024;

export type THookStage =
  | "recall"
  | "whoami"
  | "projects"
  | "context"
  | "inference"
  | "parse"
  | "dedupe"
  | "save"
  | "forget"
  | "transcript";
export type THookDiagnostic = {
  stage: THookStage;
  code: string;
  status?: number;
  origin?: string;
  contentType?: string;
};

export class MemoryHookFailure extends Error {
  constructor(readonly diagnostic: THookDiagnostic) {
    super(diagnostic.code);
  }
}

export const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const diagnosticOf = (
  error: unknown,
  stage: THookStage,
): THookDiagnostic =>
  error instanceof MemoryHookFailure
    ? { ...error.diagnostic, stage }
    : { stage, code: "invalid_response" };

const checkedUrl = (value: string): URL => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("invalid_origin");
  }
  return url;
};

const isLoopback = (url: URL): boolean =>
  url.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

/** Historical installs used the apex; only its exact HTTPS canonical move is
 * credential-preserving. Never trust arbitrary cross-origin redirects.
 */
const isCanonicalCloudRedirect = (from: URL, to: URL): boolean =>
  from.origin === "https://openllm.sh" &&
  to.origin === "https://www.openllm.sh" &&
  from.pathname === to.pathname &&
  from.search === to.search;

const contentTypeOf = (headers: Headers): string => {
  const value =
    headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "unknown";
  return [
    "application/json",
    "text/html",
    "text/plain",
    "application/problem+json",
  ].includes(value)
    ? value
    : "other";
};

const errorCodeOf = (text: string): string => {
  if (/error code\s*:\s*1010\b/i.test(text)) return "cloudflare_1010";
  try {
    const body = recordOf(JSON.parse(text));
    const error = recordOf(body?.error);
    const code = error?.type ?? error?.code;
    if (
      typeof code === "string" &&
      [
        "subscription_requires_daemon",
        "invalid_api_key",
        "insufficient_quota",
        "rate_limit_exceeded",
        "authentication_error",
      ].includes(code)
    )
      return code;
  } catch {
    /* A bounded error sample is classification-only, never logged. */
  }
  return "http_error";
};

const readBounded = async (
  response: Response,
  limit: number,
): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("response_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Uses native compiled-CLI fetch. No interpreter, browser UA, or global patch.
 * Manual redirects keep secrets on the original origin. Legacy signed /v1
 * loopback redirects are allowed without Authorization, matching normal fetch.
 */
export const memoryHookTransport =
  (inference = false): NonNullable<THttpClientOptions["fetch"]> =>
  async (input, init = {}): Promise<Response> => {
    let initial: URL;
    try {
      initial = checkedUrl(input);
    } catch {
      throw new MemoryHookFailure({
        stage: "inference",
        code: "invalid_origin",
      });
    }
    let target = initial;
    let cloudTarget = initial;
    let redirectedToDaemon = false;
    let noDaemonRetry = false;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", HOOK_USER_AGENT);
    const diagnostic = (code: string, response?: Response): MemoryHookFailure =>
      new MemoryHookFailure({
        stage: "inference",
        code,
        origin: target.origin,
        ...(response
          ? {
              status: response.status,
              contentType: contentTypeOf(response.headers),
            }
          : {}),
      });
    for (let hop = 0; hop < 5; hop++) {
      const requestHeaders = new Headers(headers);
      if (target.origin !== cloudTarget.origin)
        requestHeaders.delete("Authorization");
      if (noDaemonRetry) requestHeaders.set("x-openllm-no-daemon", "1");
      let response: Response;
      try {
        response = await fetch(target, {
          ...init,
          headers: requestHeaders,
          redirect: "manual",
        });
      } catch (error) {
        const detail = recordOf(error);
        const code = detail?.code ?? recordOf(detail?.cause)?.code;
        // Negative liveness only for an actually refused daemon socket, never
        // for auth/provider HTTP failures or an ambiguous accepted request.
        if (
          redirectedToDaemon &&
          !noDaemonRetry &&
          (code === "ECONNREFUSED" || code === "ConnectionRefused")
        ) {
          target = cloudTarget;
          noDaemonRetry = true;
          redirectedToDaemon = false;
          continue;
        }
        throw diagnostic(init.signal?.aborted ? "timeout" : "network_error");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = checkedUrl(new URL(location ?? "", target).href);
        } catch {
          throw diagnostic("redirect_blocked", response);
        }
        const preservesMethod =
          init.method === "GET" || [307, 308].includes(response.status);
        const sameOrigin = next.origin === target.origin;
        const canonical =
          !redirectedToDaemon && isCanonicalCloudRedirect(target, next);
        const daemon: boolean =
          inference &&
          !redirectedToDaemon &&
          !noDaemonRetry &&
          target.origin === cloudTarget.origin &&
          [307, 308].includes(response.status) &&
          isLoopback(next) &&
          next.pathname === initial.pathname &&
          next.pathname === "/v1/chat/completions";
        if (
          !location ||
          !preservesMethod ||
          (!sameOrigin && !canonical && !daemon)
        )
          throw diagnostic("redirect_blocked", response);
        if (canonical) cloudTarget = next;
        target = next;
        redirectedToDaemon ||= daemon;
        continue;
      }
      let text: string;
      try {
        text = await readBounded(response, response.ok ? RESPONSE_LIMIT : 4096);
      } catch {
        throw diagnostic(
          init.signal?.aborted ? "timeout" : "response_too_large",
          response,
        );
      }
      if (!response.ok) throw diagnostic(errorCodeOf(text), response);
      if (response.status === 204)
        return new Response(null, { status: 204, headers: response.headers });
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw diagnostic("invalid_json", response);
      }
      const object = recordOf(body);
      if (!object || object.error != null || object.success === false)
        throw diagnostic("application_error", response);
      return new Response(text, {
        status: response.status,
        headers: response.headers,
      });
    }
    throw diagnostic("redirect_limit");
  };
