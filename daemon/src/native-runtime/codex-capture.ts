/**
 * Codex / ChatGPT bridge request capture (W4).
 *
 * Keeps existing inbound adapters + `runCodexNative` routing. When the
 * selected sub-method is `bridge-capture` for chatgpt, an ISOLATED
 * `codex app-server` child is spawned with `CODEX_HOME` pointed at a fresh,
 * request-private ephemeral home (`codex-capture-ephemeral-home.ts`) whose
 * `config.toml` carries:
 *
 *   chatgpt_base_url = "<loopback>/<nonce>/backend-api"
 *   openai_base_url = "<loopback>/<nonce>/openllm-capture/codex"
 *
 * never as `-c key=value` argv (world-readable via `ps`/cmdline) and never
 * written into the daemon's shared, durable `cliEnv("chatgpt").CODEX_HOME` —
 * see `codex-capture-ephemeral-home.ts` for the full source-verified
 * rationale (auth-storage-backend selection, keyring keying, refresh/logout
 * safety through the `auth.json` symlink).
 *
 * `<nonce>` is a fresh, unguessable per-receiver secret path segment from
 * the shared `createCaptureLoopbackGuard()` (`capture-loopback-guard.ts`).
 * Loopback + an OS-assigned ephemeral port is NOT authentication: any local
 * process (a different OS user, or a webpage in the user's own browser via a
 * blind cross-origin POST) that discovers the port could otherwise submit a
 * valid-shaped request and win the single-shot capture race. Every inbound
 * request is REQUIRED to present the exact nonce as its leading path segment
 * — checked in constant time — and is rejected 404 BEFORE any preamble
 * forward, capture offer, or WS upgrade when it is missing, wrong, or a
 * same-prefix lookalike. The nonce is transport-only: it is peeled off (never
 * inspected/rewritten) before path classification and before restoring the
 * external URL, and it is never forwarded upstream or logged.
 *
 * The openai path (after the nonce) deliberately does NOT end in
 * `/backend-api/codex`, so `supports_codex_backend_routes` is false and
 * WorkspaceRouting cannot rewrite the Responses authority off loopback
 * (openai/codex rust-v0.156.0). Preamble still uses `/backend-api` and is
 * forwarded to chatgpt.com with application JSON semantics preserved. Bun
 * `fetch` may decompress control responses while leaving stale
 * `content-encoding`/`content-length`; the receiver reframes those headers
 * around the decoded body before serving (inference envelopes never take
 * this path). `/wham/accounts/check` vendor-selected
 * `workspace_backend_origin` values are recorded in request-private memory
 * (never logged) and restored as the daemon dispatch origin. Dispatch never
 * hardcodes production chatgpt.com when a constrained backend was selected.
 * Scheme mapping for WS is `http→ws` / `https→wss`. Inference is never
 * forwarded from the receiver; the daemon dispatches once and settles via
 * `turn/interrupt` + authoritative `turn/completed`.
 *
 * Warm `thread/inject_items` continuation is intentionally NOT claimed here:
 * schema existence is established offline, but interrupt→inject→next-turn
 * parity is unproven. Cold / isolated builders only.
 */

import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import type { TChatGptStreamEvent } from "@openllmsh/wire/providers/chatgpt/streaming";
import {
  chatGptEventToChunk,
  isChatGptResponsesTerminalEvent,
  newChatGptStreamState,
} from "@openllmsh/wire/providers/chatgpt/streaming";
import { Schema } from "effect";
import { logError, safeDiagnosticMessage } from "../logger";
import { daemonTempDir } from "../sandbox/working-set";
import { createCaptureLoopbackGuard } from "./capture-loopback-guard";
import type { TCodexNativeParams } from "./codex-app-server";
import {
  codexBaseStartParams,
  codexTurnStartParams,
  createIsolatedCodexAppServerClient,
  effortOf,
} from "./codex-app-server";
import type { TCodexCaptureEphemeralHomeHandle } from "./codex-capture-ephemeral-home";
import { createCodexCaptureEphemeralHome } from "./codex-capture-ephemeral-home";
import type {
  TBuilderSettlement,
  TCaptureDestinationPolicy,
  TCapturedHeaderPair,
  TCapturedRequestEnvelope,
  TCaptureTransport,
  TRequestCaptureSession,
} from "./request-capture";
import {
  createRequestCaptureSession,
  DEFAULT_MAX_BODY_BYTES,
  headersInitFromCaptured,
  preserveCapturedHeaders,
  requestFromCapturedEnvelope,
  runCapturedDispatch,
} from "./request-capture";
import { requireCaptureTerminalFinishReason } from "./request-capture-output";
import type { TNativeRunResult } from "./types";
import { PRE_COMMIT_TIMEOUT_MS } from "./types";

/** Default production ChatGPT origin (fallback only when routing is unconstrained). */
export const CODEX_CAPTURE_EXTERNAL_ORIGIN = "https://chatgpt.com";

/** Canonical Responses path under ChatGPT auth (never the local capture prefix). */
export const CODEX_CAPTURE_EXTERNAL_RESPONSES_PATH =
  "/backend-api/codex/responses";

/** Canonical Responses URL on the default production origin. */
export const CODEX_CAPTURE_EXTERNAL_RESPONSES_URL = `${CODEX_CAPTURE_EXTERNAL_ORIGIN}${CODEX_CAPTURE_EXTERNAL_RESPONSES_PATH}`;

/**
 * Local-only openai_base_url path prefix. MUST NOT end with `/backend-api/codex`
 * — `ModelProviderInfo::supports_codex_backend_routes` (openai/codex
 * rust-v0.156.0) is true iff the openai provider base ends with that suffix.
 *
 * Call sites gated by that flag (same tag):
 *   - `model-provider/src/provider.rs` — WorkspaceRouting / authority rewrite
 *     (the reason we avoid the suffix)
 *   - `core/src/client.rs` `responses_headers` — model-specific Codex header
 *     bundle when `uses_codex_backend` (skipped when flag false)
 *   - `core/src/client.rs` `set_guardian_metadata` — may omit
 *     `guardian_credits_requested` (skipped when flag false)
 *   - `core/src/session/token_budget.rs` — experimental context / token-budget
 *     eligibility (skipped when flag false)
 *
 * ChatGPT auth, bearer headers, and Responses body construction still follow
 * `uses_codex_backend` (does NOT require this flag). Capture still expects
 * `/wham/accounts/check` via `chatgpt_base_url` preamble (account bootstrap /
 * `read_account`); empty route memory is NOT treated as unconstrained.
 */
export const CODEX_CAPTURE_OPENAI_PATH_PREFIX = "/openllm-capture/codex";

/**
 * The real chatgpt.com path prefix `openai_base_url`-scoped controls resolve
 * against on production (`model-provider/src/models_endpoint.rs`
 * `MODELS_ENDPOINT = "/models"`, resolved against the codex backend base as
 * `https://chatgpt.com/backend-api/codex/models`) — distinct from
 * {@link CODEX_CAPTURE_EXTERNAL_RESPONSES_PATH}'s `/backend-api/codex/responses`
 * (inference only, never forwarded from the preamble path).
 */
const CODEX_CAPTURE_REAL_OPENAI_PATH_PREFIX = "/backend-api/codex";

/**
 * Confirmed model-catalog control path landing under the LOCAL
 * {@link CODEX_CAPTURE_OPENAI_PATH_PREFIX} redirect (observed empirically:
 * `${CODEX_CAPTURE_OPENAI_PATH_PREFIX}/models`, 404 when forwarded verbatim
 * — that internal prefix is capture plumbing only and never a real
 * chatgpt.com route). Narrowly scoped to this ONE confirmed control, not a
 * broad prefix-swap allowlist for arbitrary `openai_base_url`-prefixed
 * preamble traffic — every other path under that prefix (there is currently
 * no other known non-inference traffic there) is left forwarded exactly as
 * before rather than guessed at.
 */
const isCodexCaptureModelCatalogPreamblePath = (pathname: string): boolean =>
  pathname === `${CODEX_CAPTURE_OPENAI_PATH_PREFIX}/models` ||
  pathname.startsWith(`${CODEX_CAPTURE_OPENAI_PATH_PREFIX}/models/`);

/**
 * The real chatgpt.com pathname to forward a preamble request to. Relocates
 * ONLY the allowlisted model-catalog control path back onto the vendor's
 * real `/backend-api/codex` prefix; every other preamble path (the
 * `chatgpt_base_url`-prefixed `/backend-api/*` traffic, which already
 * matches real routes exactly) is returned unchanged. This only fixes OUR
 * OWN outbound forwarding target for this one control — it never touches
 * the native client's own `supports_codex_backend_routes` decision, which is
 * already fixed at configuration time by keeping `openai_base_url` off that
 * suffix (see that constant's doc comment); nothing here changes what base
 * URL the native binary itself was configured with.
 */
const codexCapturePreambleForwardPath = (pathname: string): string =>
  isCodexCaptureModelCatalogPreamblePath(pathname)
    ? pathname.replace(
        CODEX_CAPTURE_OPENAI_PATH_PREFIX,
        CODEX_CAPTURE_REAL_OPENAI_PATH_PREFIX,
      )
    : pathname;

/** Sentinel stored when accounts/check reports literal `NO_CONSTRAINT`. */
export const CODEX_CAPTURE_UNCONSTRAINED_BACKEND = "NO_CONSTRAINT";

/** Exact hosts + dotted suffixes trusted as ChatGPT workspace backends. */
const TRUSTED_CHATGPT_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "chatgpt-staging.com",
]);

export const isTrustedChatgptBackendHost = (host: string): boolean => {
  const h = host.toLowerCase();
  if (TRUSTED_CHATGPT_HOSTS.has(h)) return true;
  return (
    h.endsWith(".chatgpt.com") ||
    h.endsWith(".chat.openai.com") ||
    h.endsWith(".chatgpt-staging.com")
  );
};

/**
 * Validate a vendor-selected workspace backend origin for dispatch.
 * HTTPS only; host must be a trusted ChatGPT family name. Returns the
 * normalized `origin` string or null (fail closed — never log the value).
 */
export const trustedChatgptBackendOriginOf = (
  raw: string | null | undefined,
): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "NO_CONSTRAINT") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (!isTrustedChatgptBackendHost(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const ChatGptStreamEventSchema: Schema.Schema<TChatGptStreamEvent> =
  Schema.Record({ key: Schema.String, value: Schema.Unknown });

export type TCodexCaptureRedirectArgs = {
  readonly chatgptBaseUrl: string;
  readonly openaiBaseUrl: string;
};

/**
 * Redirect recipe for isolated capture app-server:
 *   - `chatgpt_base_url` → loopback `/backend-api` (preamble, incl. accounts/check)
 *   - `openai_base_url` → loopback {@link CODEX_CAPTURE_OPENAI_PATH_PREFIX}
 *     so workspace routing does NOT engage (base does not end in
 *     `/backend-api/codex`).
 *
 * These values are handed to the spawned app-server via a request-private,
 * per-capture ephemeral `CODEX_HOME` ({@link createCodexCaptureEphemeralHome}),
 * never as `-c key=value` argv — argv is visible to every local process/user
 * (`ps`, `/proc/<pid>/cmdline`), which would leak the loopback-guard nonce
 * embedded in these URLs to other local accounts. See
 * {@link createCodexCaptureEphemeralHome} for the source evidence.
 */
export const codexCaptureRedirectArgs = (
  loopbackBase: string,
): TCodexCaptureRedirectArgs => {
  const base = loopbackBase.replace(/\/+$/, "");
  const chatgptBaseUrl = `${base}/backend-api`;
  const openaiBaseUrl = `${base}${CODEX_CAPTURE_OPENAI_PATH_PREFIX}`;
  return { chatgptBaseUrl, openaiBaseUrl };
};

/** Trusted static origins + admission for validated discovered backends. */
export const codexCaptureDestinationPolicy = (opts?: {
  readonly allowLoopback?: boolean;
}): TCaptureDestinationPolicy => ({
  allowedOrigins: new Set([
    CODEX_CAPTURE_EXTERNAL_ORIGIN,
    "https://chat.openai.com",
    "https://chatgpt-staging.com",
  ]),
  allowLoopback: opts?.allowLoopback === true,
  allowUrl: (url: URL): boolean =>
    url.protocol === "https:" && isTrustedChatgptBackendHost(url.hostname),
});

/** Match the inference call only. */
export const isCodexCaptureInferencePath = (pathname: string): boolean =>
  pathname.endsWith("/responses");

/**
 * Non-inference traffic that hit the isolated redirect listener.
 * Forwarded to chatgpt.com (auth/body preserved). Inference is never
 * forwarded from the receiver.
 */
export const isCodexCapturePreamblePath = (pathname: string): boolean =>
  !isCodexCaptureInferencePath(pathname);

const isWorkspaceAccountsCheckPath = (pathname: string): boolean =>
  pathname.endsWith("/wham/accounts/check");

/** Methods we will forward for a recognized preamble path. */
const isCodexCapturePreambleMethod = (method: string): boolean => {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "POST" || m === "OPTIONS";
};

/**
 * Request-private memory of vendor-selected workspace backends discovered via
 * forwarded `/wham/accounts/check` (or hermetic injection). Never logged.
 *
 * Empty memory is NOT unconstrained — real ChatGPT OAuth must have an
 * authoritative route (constrained https origin or explicit `NO_CONSTRAINT`)
 * before dispatch. Unconstrained maps to Production
 * {@link CODEX_CAPTURE_EXTERNAL_ORIGIN} because native `resolve_routing` with
 * `NO_CONSTRAINT` and default `ChatGptEnvironment::Production` chatgpt_base_url
 * (`https://chatgpt.com/backend-api`) yields that origin (openai/codex
 * rust-v0.156.0).
 */
export type TCodexWorkspaceRouteMemory = {
  /** Record routes from an accounts/check JSON body (pass-through; no mutation). */
  recordFromAccountsCheckBody(body: unknown): void;
  /**
   * Hermetic/tests: mark one account as explicitly unconstrained
   * (`workspace_backend_origin = NO_CONSTRAINT`). Not a silent global default.
   */
  recordUnconstrained(accountId: string): void;
  /** Resolve dispatch origin from captured inference headers; fail closed. */
  resolveDispatchOrigin(headers: ReadonlyArray<TCapturedHeaderPair>):
    | {
        readonly ok: true;
        readonly origin: string;
      }
    | {
        readonly ok: false;
        readonly reason: string;
      };
  /** Test/helper: constrained account routes retained. */
  constrainedSize(): number;
  /** Test/helper: unconstrained account ids retained. */
  unconstrainedSize(): number;
  /** Test/helper: constrained origin for one account id. */
  originOf(accountId: string): string | undefined;
  /** Test/helper: whether account was recorded unconstrained. */
  isUnconstrained(accountId: string): boolean;
};

export const createCodexWorkspaceRouteMemory =
  (): TCodexWorkspaceRouteMemory => {
    const constrained = new Map<string, string>();
    const unconstrained = new Set<string>();

    const remember = (accountId: string, rawOrigin: unknown): void => {
      if (typeof accountId !== "string" || accountId.length === 0) return;
      if (typeof rawOrigin !== "string") return;
      const trimmed = rawOrigin.trim();
      if (trimmed === CODEX_CAPTURE_UNCONSTRAINED_BACKEND) {
        unconstrained.add(accountId);
        constrained.delete(accountId);
        return;
      }
      const origin = trustedChatgptBackendOriginOf(trimmed);
      if (origin === null) return;
      constrained.set(accountId, origin);
      unconstrained.delete(accountId);
    };

    return {
      recordFromAccountsCheckBody(body: unknown): void {
        if (
          typeof body !== "object" ||
          body === null ||
          !("accounts" in body)
        ) {
          return;
        }
        const accounts = (body as { accounts: unknown }).accounts;
        if (Array.isArray(accounts)) {
          for (const entry of accounts) {
            if (typeof entry !== "object" || entry === null) continue;
            const id =
              typeof (entry as { id?: unknown }).id === "string"
                ? (entry as { id: string }).id
                : typeof (entry as { account_id?: unknown }).account_id ===
                    "string"
                  ? (entry as { account_id: string }).account_id
                  : null;
            if (id === null) continue;
            remember(
              id,
              (entry as { workspace_backend_origin?: unknown })
                .workspace_backend_origin,
            );
          }
          return;
        }
        if (typeof accounts === "object" && accounts !== null) {
          for (const [id, value] of Object.entries(accounts)) {
            if (typeof value !== "object" || value === null) continue;
            const account =
              "account" in value &&
              typeof (value as { account: unknown }).account === "object" &&
              (value as { account: unknown }).account !== null
                ? (value as { account: Record<string, unknown> }).account
                : (value as Record<string, unknown>);
            const accountId =
              typeof account.account_id === "string"
                ? account.account_id
                : typeof account.id === "string"
                  ? account.id
                  : id;
            remember(accountId, account.workspace_backend_origin);
          }
        }
      },

      recordUnconstrained(accountId: string): void {
        if (accountId.length === 0) return;
        unconstrained.add(accountId);
        constrained.delete(accountId);
      },

      resolveDispatchOrigin(headers) {
        let accountId: string | null = null;
        for (const [name, value] of headers) {
          if (name.toLowerCase() === "chatgpt-account-id" && value.length > 0) {
            accountId = value;
            break;
          }
        }

        const hasAny = constrained.size > 0 || unconstrained.size > 0;
        if (!hasAny) {
          return {
            ok: false,
            reason:
              "codex capture: no authoritative workspace route recorded (empty discovery is not unconstrained)",
          };
        }

        if (accountId !== null) {
          if (unconstrained.has(accountId)) {
            // Native resolve_routing(NO_CONSTRAINT) + Production chatgpt_base_url
            // → https://chatgpt.com origin (ChatGptEnvironment::Production).
            return { ok: true, origin: CODEX_CAPTURE_EXTERNAL_ORIGIN };
          }
          const origin = constrained.get(accountId);
          if (origin === undefined) {
            return {
              ok: false,
              reason:
                "codex capture: ChatGPT-Account-Id has no recorded workspace backend origin",
            };
          }
          return { ok: true, origin };
        }

        // No account header: only succeed when every recorded account agrees.
        if (constrained.size === 0 && unconstrained.size > 0) {
          return { ok: true, origin: CODEX_CAPTURE_EXTERNAL_ORIGIN };
        }
        if (unconstrained.size > 0 && constrained.size > 0) {
          return {
            ok: false,
            reason:
              "codex capture: mixed constrained/unconstrained backends; ChatGPT-Account-Id required",
          };
        }
        const unique = new Set(constrained.values());
        if (unique.size === 1) {
          const origin = unique.values().next().value;
          if (typeof origin === "string") return { ok: true, origin };
        }
        return {
          ok: false,
          reason:
            "codex capture: multiple workspace backends recorded; ChatGPT-Account-Id required",
        };
      },

      constrainedSize: (): number => constrained.size,
      unconstrainedSize: (): number => unconstrained.size,
      originOf: (accountId: string): string | undefined =>
        constrained.get(accountId),
      isUnconstrained: (accountId: string): boolean =>
        unconstrained.has(accountId),
    };
  };

/**
 * Build the external Responses URL for daemon dispatch from a captured
 * loopback observation + a validated vendor backend origin. Always uses the
 * canonical `/backend-api/codex/responses` path — the local
 * {@link CODEX_CAPTURE_OPENAI_PATH_PREFIX} is capture plumbing only.
 */
export const remapCodexObservedUrlToExternal = (
  observedUrl: string,
  backendOrigin: string = CODEX_CAPTURE_EXTERNAL_ORIGIN,
): string => {
  const observed = new URL(observedUrl);
  const origin = new URL(backendOrigin).origin;
  return `${origin}${CODEX_CAPTURE_EXTERNAL_RESPONSES_PATH}${observed.search}`;
};

/**
 * Bun `fetch` decompresses gzip/br/deflate response bodies but can leave the
 * upstream `content-encoding` (and compressed `content-length`) intact on the
 * returned `Response`. Relaying that object through `Bun.serve` makes a raw
 * HTTP client (e.g. reqwest) see `content-encoding: gzip` with an already-
 * decoded body → gunzip "incorrect header check".
 *
 * Rebuild around the decoded body and drop stale framing headers. Application
 * JSON bytes/semantics are unchanged. Captured inference envelopes never use
 * this helper.
 */
export const reframeFetchedControlResponse = async (
  response: Response,
): Promise<Response> => {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const body = await response.arrayBuffer();
  headers.set("content-length", String(body.byteLength));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Record workspace routes from a forwarded accounts/check Response via
 * `clone().json()` (decoded JSON semantics). The Response returned to native
 * is separately reframed by {@link reframeFetchedControlResponse}.
 */
const recordWorkspaceRoutesFromResponse = async (
  response: Response,
  routes: TCodexWorkspaceRouteMemory,
): Promise<void> => {
  if (!response.ok) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return;
  try {
    const parsed: unknown = await response.clone().json();
    routes.recordFromAccountsCheckBody(parsed);
  } catch {
    // Unparsable — leave memory unchanged; dispatch may fail closed later.
  }
};

const localSettlementHttpResponse = (): Response =>
  new Response(null, { status: 204 });

type TWsCaptureData = {
  readonly headers: ReadonlyArray<TCapturedHeaderPair>;
  readonly observedUrl: string;
  bodyChunks: Uint8Array[];
  offered: boolean;
  warmupSkipped: number;
};

/**
 * openai/codex rust-v0.156.0 WebSocket prewarm is a v2 `response.create` with
 * `generate: false` (core/src/client.rs) — connection setup, not inference.
 * Capturing the first WS frame would steal the prewarm and miss the real turn.
 */
export const isCodexResponsesWebsocketWarmupPayload = (
  bytes: Uint8Array,
): boolean => {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    // Payload may be the create object itself or wrapped.
    if (record.generate === false) return true;
    const nested = record.response_create ?? record.responseCreate ?? record;
    if (
      typeof nested === "object" &&
      nested !== null &&
      (nested as { generate?: unknown }).generate === false
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

/** PATH/METHOD only — never bodies/headers/auth. */
export type TCodexCaptureObservedRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly kind: "inference" | "preamble" | "other";
};

export type TCodexCapturePreambleMode = "forward" | "stub-204";

export type TCodexCaptureReceiver = {
  readonly baseUrl: string;
  /**
   * The guarded base URL to hand to `codexCaptureRedirectArgs` (and thence to
   * the spawned official CLI) — `baseUrl` with the per-receiver secret path
   * prefix appended. Every request to this receiver MUST present that exact
   * prefix or is rejected 404 before any preamble/capture/WS-upgrade
   * handling. Never log this value or forward it upstream.
   */
  readonly guardedBaseUrl: string;
  readonly stop: () => void;
  /** Count of `/responses` offers accepted into the session (0 or 1). */
  readonly capturedCount: () => number;
  /**
   * Count of times the receiver would have forwarded the ORIGINAL INFERENCE
   * request off-box. Always 0 by construction — `/responses` is captured and
   * daemon-dispatched, never forwarded from the receiver. Do NOT use this to
   * prove "zero chatgpt.com egress overall"; preamble forwarding is separate.
   */
  readonly originalExternalSendCount: () => number;
  /**
   * Recognized non-inference ChatGPT preamble requests the receiver forwarded
   * to chatgpt.com (only under `preamble: "forward"`). Distinct from
   * {@link originalExternalSendCount}.
   */
  readonly preambleForwardCount: () => number;
  /** Extra `/responses` attempts after the first capture (WS→HTTP fallback). */
  readonly suppressedRetryCount: () => number;
  /** WS `generate:false` prewarm frames skipped before inference capture. */
  readonly warmupSkippedCount: () => number;
  /** Metadata-only request log (PATH/METHOD) for diagnostics/tests. */
  readonly observedRequests: () => ReadonlyArray<TCodexCaptureObservedRequest>;
  /** Request-private vendor workspace route memory (no secrets logged). */
  readonly workspaceRoutes: TCodexWorkspaceRouteMemory;
};

export type TStartCodexCaptureReceiverOptions = {
  readonly session: TRequestCaptureSession;
  readonly signal?: AbortSignal;
  /**
   * Non-inference handling for traffic that already hit this loopback
   * listener. Default `forward` matches `delegation/auth-config.ts` (forward
   * every non-`/responses` request to chatgpt.com). `stub-204` is for
   * hermetic negative tests that model starvation.
   */
  readonly preamble?: TCodexCapturePreambleMode;
  /**
   * Fetch used when forwarding preamble. Hermetic tests inject a loopback
   * stand-in; production uses real `fetch` to chatgpt.com.
   */
  readonly preambleFetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Optional pre-built route memory (tests); default creates a fresh one. */
  readonly workspaceRoutes?: TCodexWorkspaceRouteMemory;
};

/**
 * Loopback HTTP + WebSocket receiver. Captures the first `/responses`
 * inference offer (either transport) and settles it locally. Non-inference
 * preamble is forwarded to chatgpt.com (default) with auth/body preserved —
 * `/responses` itself is NEVER forwarded. Accounts/check bodies are passed
 * through unchanged while original workspace backends are recorded for
 * dispatch restoration. Subsequent `/responses` attempts receive the same
 * local settlement without a second `captureSend`.
 */
export const startCodexCaptureReceiver = (
  opts: TStartCodexCaptureReceiverOptions,
): TCodexCaptureReceiver => {
  let capturedCount = 0;
  let suppressedRetryCount = 0;
  let preambleForwardCount = 0;
  let warmupSkippedCount = 0;
  let builderSettlement: TBuilderSettlement | null = null;
  const observed: TCodexCaptureObservedRequest[] = [];
  const preambleMode: TCodexCapturePreambleMode = opts.preamble ?? "forward";
  const preambleFetch = opts.preambleFetch ?? fetch;
  const workspaceRoutes =
    opts.workspaceRoutes ?? createCodexWorkspaceRouteMemory();
  // Fresh, unguessable per-receiver secret — loopback + an OS-assigned
  // ephemeral port is not authentication (another local OS user, or a
  // same-machine webpage's blind cross-origin POST, could otherwise win the
  // single-shot capture race). Required as the exact leading path segment of
  // every inbound request; peeled off (never inspected/rewritten, never
  // logged, never forwarded upstream) before classification/handling.
  const loopbackGuard = createCaptureLoopbackGuard();

  const classify = (pathname: string): TCodexCaptureObservedRequest["kind"] => {
    if (isCodexCaptureInferencePath(pathname)) return "inference";
    if (isCodexCapturePreamblePath(pathname)) return "preamble";
    return "other";
  };

  /** Metadata log uses the PEELED pathname only — the nonce itself is never
   *  recorded, even in this diagnostics-only PATH/METHOD list. */
  const noteObserved = (req: Request, peeledUrl: URL): void => {
    observed.push({
      method: req.method.toUpperCase(),
      pathname: peeledUrl.pathname,
      kind: classify(peeledUrl.pathname),
    });
  };

  const offerEnvelope = async (
    envelope: TCapturedRequestEnvelope,
  ): Promise<TBuilderSettlement> => {
    if (capturedCount > 0) {
      suppressedRetryCount += 1;
      return (
        builderSettlement ?? {
          kind: "suppressed",
          reason: "codex capture already owns this turn; retry suppressed",
        }
      );
    }
    capturedCount += 1;
    const settlement = await opts.session.captureSend(envelope);
    builderSettlement = settlement;
    return settlement;
  };

  const resolveExternalUrl = (
    observedUrl: string,
    headers: ReadonlyArray<TCapturedHeaderPair>,
  ): string => {
    const resolved = workspaceRoutes.resolveDispatchOrigin(headers);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    return remapCodexObservedUrlToExternal(observedUrl, resolved.origin);
  };

  // `peeledUrl` is the guard-verified URL with the secret prefix already
  // stripped (same origin/search/hash, remaining pathname preserved) — every
  // classification/forward/capture decision below uses ONLY this, never the
  // raw `req.url`, so the nonce itself never reaches path matching, external
  // URL construction, logs, or upstream requests.
  const offerFromHttp = async (
    req: Request,
    peeledUrl: URL,
  ): Promise<Response> => {
    const observedUrl = peeledUrl.toString();
    const headers = preserveCapturedHeaders(req.headers);
    const bodyBuf = await req.arrayBuffer();
    const body = bodyBuf.byteLength === 0 ? null : new Uint8Array(bodyBuf);
    let externalUrl: string;
    try {
      externalUrl = resolveExternalUrl(observedUrl, headers);
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "workspace route unresolved";
      // Pre-send failure — no envelope was ever offered, so nothing else
      // will ever settle this session. Complete it now (usage: none) rather
      // than leaving `takeCaptured()` to hang until the capture timeout.
      try {
        opts.session.complete({
          kind: "failed",
          reason,
          usage: { kind: "none" },
        });
      } catch {
        // session may already be terminal/disposed
      }
      return new Response(reason, { status: 502 });
    }
    await offerEnvelope({
      transport: "http",
      method: req.method,
      observedUrl,
      externalUrl,
      headers,
      body,
      framing: null,
    });
    return localSettlementHttpResponse();
  };

  const forwardPreamble = async (
    req: Request,
    peeledUrl: URL,
  ): Promise<Response> => {
    // Trusted destination only — remap to chatgpt.com, preserve path/query and
    // the vendor-built application headers/body (auth included). Strip Host so
    // fetch sets it for the external origin.
    const fwd = new Headers(req.headers);
    fwd.delete("host");
    preambleForwardCount += 1;
    const recordRoutes = isWorkspaceAccountsCheckPath(peeledUrl.pathname);
    const forwardPath = codexCapturePreambleForwardPath(peeledUrl.pathname);
    try {
      const response = await preambleFetch(
        `${CODEX_CAPTURE_EXTERNAL_ORIGIN}${forwardPath}${peeledUrl.search}`,
        {
          method: req.method,
          headers: fwd,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
          signal: opts.signal,
        },
      );
      // Route memory reads decoded JSON via clone(); then reframe so Bun's
      // fetch decompression cannot leave stale content-encoding for reqwest.
      if (recordRoutes) {
        await recordWorkspaceRoutesFromResponse(response, workspaceRoutes);
      }
      return await reframeFetchedControlResponse(response);
    } catch {
      return new Response(null, { status: 502 });
    }
  };

  const server = Bun.serve<TWsCaptureData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv): Response | undefined | Promise<Response> {
      if (opts.signal?.aborted) {
        return new Response(null, { status: 499 });
      }
      // Gate FIRST, before any preamble/capture/WS-upgrade handling and
      // before reading the body: require the exact per-receiver secret path
      // segment. Missing/wrong/lookalike → 404, with nothing else touched
      // (no counting, no observation, no forward). The raw pre-peel URL is
      // never logged.
      const peeledUrl = loopbackGuard.peel(new URL(req.url));
      if (peeledUrl === null) {
        return new Response(null, { status: 404 });
      }
      const kind = classify(peeledUrl.pathname);
      noteObserved(req, peeledUrl);
      const wantsUpgrade =
        req.headers.get("upgrade")?.toLowerCase() === "websocket";

      if (kind === "inference" && wantsUpgrade) {
        const upgraded = srv.upgrade(req, {
          data: {
            headers: preserveCapturedHeaders(req.headers),
            observedUrl: peeledUrl.toString(),
            bodyChunks: [],
            offered: false,
            warmupSkipped: 0,
          },
        });
        return upgraded
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }

      if (kind === "inference") {
        return offerFromHttp(req, peeledUrl);
      }

      // Recognized preamble: forward to chatgpt.com (default) or stub for the
      // hermetic negative case. Unknown non-inference paths: local stub ONLY —
      // never open unbounded egress for arbitrary unmatched requests.
      if (
        kind === "preamble" &&
        preambleMode === "forward" &&
        isCodexCapturePreambleMethod(req.method) &&
        !wantsUpgrade
      ) {
        return forwardPreamble(req, peeledUrl);
      }
      return new Response(null, { status: 204 });
    },
    websocket: {
      message(ws, message): void {
        if (ws.data.offered) return;
        // Preserve the ORIGINAL WS opcode native sent (text vs binary) — the
        // dispatch sender must resend with the same opcode, never coerce to
        // binary. openai/codex Responses WS almost certainly speaks JSON text
        // frames; sending as binary is a plausible cause of upstream silence.
        const isText = typeof message === "string";
        const chunk = isText
          ? new TextEncoder().encode(message)
          : message instanceof Uint8Array
            ? message
            : new Uint8Array(message);
        // Skip v2 WS prewarm (`generate: false`) — keep the socket open for the
        // real inference frame (openai/codex core/src/client.rs).
        if (isCodexResponsesWebsocketWarmupPayload(chunk)) {
          ws.data.warmupSkipped += 1;
          warmupSkippedCount += 1;
          return;
        }
        ws.data.bodyChunks = [chunk];
        ws.data.offered = true;
        const body = chunk;
        let externalUrl: string;
        try {
          externalUrl = resolveExternalUrl(
            ws.data.observedUrl,
            ws.data.headers,
          );
        } catch (err) {
          // Pre-send failure — no envelope was ever offered, so nothing else
          // will ever settle this session. Complete it now (usage: none)
          // rather than leaving `takeCaptured()` to hang until the capture
          // timeout.
          try {
            opts.session.complete({
              kind: "failed",
              reason:
                err instanceof Error
                  ? err.message
                  : "workspace route unresolved",
              usage: { kind: "none" },
            });
          } catch {
            // session may already be terminal/disposed
          }
          try {
            ws.close(1011, "workspace-route-unresolved");
          } catch {
            // ignore
          }
          return;
        }
        void offerEnvelope({
          transport: "websocket",
          method: "GET",
          observedUrl: ws.data.observedUrl,
          externalUrl,
          headers: ws.data.headers,
          body,
          framing: {
            entries: {
              protocol: "responses-websocket",
              upgrade: true,
              wsOpcode: isText ? "text" : "binary",
              ...(ws.data.warmupSkipped > 0
                ? { warmupSkipped: ws.data.warmupSkipped }
                : {}),
            },
          },
        }).finally(() => {
          // Local settlement: close without feeding a model response.
          try {
            ws.close(1000, "capture-suppressed");
          } catch {
            // already closed
          }
        });
      },
      close(ws): void {
        // Upgrade-without-body / prewarm-only: leave the session open so an
        // HTTP fallback can still offer once.
        if (!ws.data.offered && ws.data.bodyChunks.length === 0) return;
      },
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const guardedBaseUrl = loopbackGuard.baseUrl(baseUrl);

  const stop = (): void => {
    try {
      server.stop(true);
    } catch {
      // already stopped
    }
  };

  opts.signal?.addEventListener(
    "abort",
    () => {
      stop();
    },
    { once: true },
  );

  return {
    baseUrl,
    guardedBaseUrl,
    stop,
    capturedCount: (): number => capturedCount,
    // Inference is never forwarded from this receiver.
    originalExternalSendCount: (): number => 0,
    preambleForwardCount: (): number => preambleForwardCount,
    workspaceRoutes,
    suppressedRetryCount: (): number => suppressedRetryCount,
    warmupSkippedCount: (): number => warmupSkippedCount,
    observedRequests: (): ReadonlyArray<TCodexCaptureObservedRequest> => [
      ...observed,
    ],
  };
};

/**
 * True when ONE upstream WS/SSE frame's text is (or contains) a Responses
 * terminal event. Checked per-frame — never against a running concatenation
 * of every frame received so far, which would make the wait loop O(n²) over
 * the exchange and would blur frame boundaries (`{}{}` back-to-back frames
 * mis-split by a boundary-losing regex/newline scan).
 */
export const codexWsFrameHasTerminal = (frameText: string): boolean => {
  if (frameText.length === 0) return false;
  return (
    /"type"\s*:\s*"response\.(completed|done|failed|incomplete)"/.test(
      frameText,
    ) || /\bresponse\.(completed|done|failed|incomplete)\b/.test(frameText)
  );
};

/**
 * Wrap discrete upstream WS frames as SSE for the shared Responses decoder.
 * Each frame becomes exactly one `data: …` event — frame boundaries are
 * preserved because they were never concatenated. Callers must already have
 * verified a terminal frame exists; this never invents a completed turn.
 */
export const wrapCodexWsFramesAsSse = (
  frames: ReadonlyArray<string>,
): Uint8Array => {
  const events = frames
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) =>
      frame.startsWith("data:") ? `${frame}\n\n` : `data: ${frame}\n\n`,
    )
    .join("");
  return new TextEncoder().encode(`${events}data: [DONE]\n\n`);
};

/**
 * Dispatch a captured Codex envelope. HTTP uses `fetch` with the preserved
 * Request. WebSocket keeps the WS transport (never coerced to HTTP POST):
 * opens the external URL, sends the captured body frame, marks accept on
 * open, and wraps inbound text frames as an SSE-shaped Response body so the
 * existing Responses decoder can run when the upstream speaks SSE-over-WS
 * or plain JSON event frames.
 *
 * Abort / peer-close without a Responses terminal (`response.completed` /
 * `failed` / …) throws — never returns an empty 200/`[DONE]` success. After
 * `markUpstreamAccepted`, that throw preserves accepted/uncertain ownership
 * via `runCapturedDispatch` (no silent zero-token success).
 */
export const createCodexCapturedDispatchSender = (args: {
  readonly session: TRequestCaptureSession;
  readonly fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}): ((
  request: Request,
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
) => Promise<Response>) => {
  const fetchImpl = args.fetchImpl ?? fetch;
  return async (request, envelope, signal): Promise<Response> => {
    if (envelope.transport === "http") {
      const response = await fetchImpl(request, { signal });
      // Buffer immediately. On a successful dispatch `session.complete` does
      // NOT abort `session.signal` (only cancel/fail/uncertain-accept do —
      // see `finishTerminal` in request-capture.ts), and `markDispatchStarted`
      // detaches the pre-capture budget so it can't fire mid-dispatch either.
      // Buffering here is still correct: `signal` is still the caller's own
      // abort (e.g. client disconnect), which SHOULD cut a live body read.
      const buffered = new Uint8Array(await response.arrayBuffer());
      return new Response(buffered, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (envelope.transport !== "websocket") {
      throw new Error(
        `codex capture: unsupported transport ${envelope.transport}`,
      );
    }

    const wsUrl = (() => {
      const u = new URL(envelope.externalUrl);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      return u.toString();
    })();

    const headerObj: Record<string, string> = {};
    for (const [name, value] of envelope.headers) {
      if (name.toLowerCase() === "host") continue;
      if (name.toLowerCase() === "upgrade") continue;
      if (name.toLowerCase() === "connection") continue;
      if (name.toLowerCase() === "sec-websocket-key") continue;
      if (name.toLowerCase() === "sec-websocket-version") continue;
      if (name.toLowerCase() === "sec-websocket-extensions") continue;
      headerObj[name] = value;
    }

    // lib.dom only models the protocol overload; Bun accepts custom headers.
    // Same local ctor cast as `audio/claude-ws.ts` / `cli/clients/attach.ts`.
    type TBunWebSocketCtor = new (
      url: string,
      options?: { readonly headers?: Readonly<Record<string, string>> },
    ) => WebSocket;
    const ws = new (WebSocket as unknown as TBunWebSocketCtor)(wsUrl, {
      headers: headerObj,
    });
    ws.binaryType = "arraybuffer";

    // Discrete inbound frames — each pushed exactly once, never concatenated
    // before a terminal check. Avoids O(n²) full-buffer rescans and preserves
    // frame boundaries (`{}{}` back-to-back frames stay two events, not one
    // ambiguously-split string).
    //
    // Buffered whole (not yet streamed to the daemon decoder — a follow-up
    // can make this genuinely streaming); bounded at the same
    // `DEFAULT_MAX_BODY_BYTES` cap the HTTP capture path already enforces on
    // a captured body, so an upstream that never terminates cannot grow this
    // buffer unbounded.
    const frames: string[] = [];
    let bufferedBytes = 0;
    let terminalSeen = false;
    let overBudget = false;
    let wake: (() => void) | null = null;
    let closed = false;
    let aborted = false;
    let openErr: Error | null = null;

    const wait = (): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });

    const notify = (): void => {
      wake?.();
      wake = null;
    };

    // `opened` must settle even if the server never answers the upgrade and
    // the caller aborts first — otherwise `await opened` hangs forever with
    // no "open" and no "error" event ever firing.
    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onErrBeforeOpen);
        signal.removeEventListener("abort", onAbortBeforeOpen);
        fn();
      };
      const onOpen = (): void =>
        finish(() => {
          args.session.markUpstreamAccepted();
          resolve();
        });
      const onErrBeforeOpen = (): void =>
        finish(() => {
          openErr = new Error("codex capture websocket failed before open");
          reject(openErr);
        });
      const onAbortBeforeOpen = (): void =>
        finish(() => {
          reject(new Error("codex capture websocket aborted before open"));
        });
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErrBeforeOpen, { once: true });
      signal.addEventListener("abort", onAbortBeforeOpen, { once: true });
      if (signal.aborted) onAbortBeforeOpen();
    });

    ws.addEventListener("message", (ev) => {
      if (overBudget) return;
      // Decode as UTF-8 text regardless of the inbound opcode — Responses WS
      // frames are JSON either way; only the RESEND opcode (below) must match
      // what native originally sent.
      const frame =
        typeof ev.data === "string"
          ? ev.data
          : new TextDecoder().decode(
              ev.data instanceof ArrayBuffer
                ? new Uint8Array(ev.data)
                : ev.data instanceof Uint8Array
                  ? ev.data
                  : new Uint8Array(0),
            );
      bufferedBytes += frame.length;
      if (bufferedBytes > DEFAULT_MAX_BODY_BYTES) {
        overBudget = true;
        try {
          ws.close(1009, "codex capture response exceeds max buffered size");
        } catch {
          // ignore
        }
        notify();
        return;
      }
      frames.push(frame);
      if (!terminalSeen && codexWsFrameHasTerminal(frame)) {
        terminalSeen = true;
      }
      notify();
    });
    ws.addEventListener("close", () => {
      closed = true;
      notify();
    });
    ws.addEventListener("error", () => {
      closed = true;
      notify();
    });

    const onAbort = (): void => {
      aborted = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      // Force the wait loop to observe the abort even with no pending
      // message/close event queued.
      notify();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      await opened;
      if (envelope.body !== null && envelope.body.byteLength > 0) {
        // Resend with the ORIGINAL opcode native used — never coerce text to
        // binary or vice versa. `framing.entries.wsOpcode` is set by the
        // receiver from the actual inbound frame type.
        const wsOpcode = envelope.framing?.entries.wsOpcode;
        if (wsOpcode === "binary") {
          ws.send(new Uint8Array(envelope.body));
        } else {
          // Default to text (the documented/expected Responses WS framing)
          // when framing metadata is absent (e.g. hermetic fixtures built
          // before this field existed).
          ws.send(new TextDecoder().decode(envelope.body));
        }
      }

      // Collect until a terminal frame arrives, the buffer cap trips, or the
      // peer closes / caller aborts. Do NOT treat abort or empty close as a
      // completed turn (live attempt-24 empty 200/[DONE]).
      while (!closed && !aborted && !terminalSeen && !overBudget) {
        await wait();
      }

      if (overBudget) {
        throw new Error(
          `codex capture websocket response exceeded ${DEFAULT_MAX_BODY_BYTES} buffered bytes before response.completed`,
        );
      }
      if (aborted || signal.aborted) {
        throw new Error(
          "codex capture websocket aborted before response.completed",
        );
      }
      if (!terminalSeen) {
        throw new Error(
          "codex capture websocket closed without response.completed",
        );
      }

      return new Response(new Uint8Array(wrapCodexWsFramesAsSse(frames)), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
};

export const decodeCodexUpstreamResponse = (
  response: Response,
  providerModelId: string,
): ReadableStream<TChatCompletionChunk> => {
  if (response.body === null) {
    return new ReadableStream<TChatCompletionChunk>({
      start(controller) {
        controller.close();
      },
    });
  }
  return decodeProviderEventStream(
    response.body,
    {
      eventSchema: ChatGptStreamEventSchema,
      initialState: newChatGptStreamState,
      eventToChunk: chatGptEventToChunk,
      isTerminalEvent: isChatGptResponsesTerminalEvent,
    },
    { providerModelId },
  );
};

export type TCodexCapturedTurnHandles = {
  readonly receiver: TCodexCaptureReceiver;
  readonly session: TRequestCaptureSession;
  readonly client: ReturnType<typeof createIsolatedCodexAppServerClient>;
  readonly threadId: string;
  readonly turnId: string | null;
  dispose(): void;
};

/**
 * Interrupt the isolated turn and wait for an authoritative terminal
 * (`turn/completed`). Kill is NOT used as settlement proof.
 */
export const settleCodexCaptureTurn = async (args: {
  readonly client: {
    request(method: string, params: unknown): Promise<unknown>;
    addSink(sink: {
      readonly threadId: string;
      onDelta: (text: string) => void;
      onAgentMessage: (text: string) => void;
      onUsage: (usage: unknown) => void;
      onCompleted: (status: string, errorMessage: string | null) => void;
      onToolCall?: (
        requestId: number,
        callId: string,
        tool: string,
        args: unknown,
      ) => void;
      onRetryError?: (
        message: string,
        info: {
          readonly willRetry: true;
          readonly codexErrorInfo: unknown;
          readonly additionalDetails: string | null;
        },
      ) => void;
    }): void;
    removeSink(threadId: string): void;
    respondToServer?(id: number, result: unknown): void;
  };
  readonly threadId: string;
  readonly turnId: string | null;
  readonly timeoutMs?: number;
  /**
   * Optional: keep refusing builder `item/tool/call` while awaiting the
   * interrupt terminal. `addSink` replaces any prior sink, so callers that
   * already attached an onToolCall must pass it here or lose it.
   */
  readonly onToolCall?: (
    requestId: number,
    callId: string,
    tool: string,
    args: unknown,
  ) => void;
}): Promise<{ readonly status: string; readonly error: string | null }> => {
  let status = "interrupted";
  let error: string | null = null;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const refuseToolCall = (
    requestId: number,
    callId: string,
    tool: string,
    toolArgs: unknown,
  ): void => {
    if (args.onToolCall !== undefined) {
      args.onToolCall(requestId, callId, tool, toolArgs);
      return;
    }
    // Default capture settlement: never execute builder tools.
    args.client.respondToServer?.(requestId, {
      contentItems: [
        {
          type: "inputText",
          text: "(capture: tool execution suppressed during settle)",
        },
      ],
      success: false,
    });
  };

  args.client.addSink({
    threadId: args.threadId,
    onDelta: () => {},
    onAgentMessage: () => {},
    onUsage: () => {},
    onCompleted: (s, e) => {
      status = s;
      error = e;
      done();
    },
    onToolCall: refuseToolCall,
  });

  if (args.turnId !== null) {
    try {
      await args.client.request("turn/interrupt", {
        threadId: args.threadId,
        turnId: args.turnId,
      });
    } catch {
      // interrupt is best-effort; we still wait for terminal / timeout
    }
  }

  const timeoutMs = args.timeoutMs ?? 5_000;
  await Promise.race([
    finished,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
  args.client.removeSink(args.threadId);
  return { status, error };
};

/** Safe metadata-only snapshot (PATH/METHOD; no query/headers/body/auth). */
export type TCodexCaptureDiagnostics = {
  readonly phase: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly observed: ReadonlyArray<TCodexCaptureObservedRequest>;
  readonly capturedCount: number;
  readonly preambleForwardCount: number;
  readonly originalExternalSendCount: number;
  readonly turnTerminal: {
    readonly status: string;
    readonly error: string | null;
  } | null;
  /**
   * Last non-terminal stream/retry notification (`willRetry: true`), e.g.
   * "Reconnecting... 2/5". Distinct from {@link turnTerminal}.
   */
  readonly lastRetryError: string | null;
};

export const formatCodexCaptureDiagnostics = (
  diag: TCodexCaptureDiagnostics,
): string => {
  const observed =
    diag.observed.length === 0
      ? "none"
      : diag.observed
          .map((r) => `${r.method} ${r.pathname} (${r.kind})`)
          .join("; ");
  const terminal =
    diag.turnTerminal === null
      ? "none"
      : `${diag.turnTerminal.status}${
          diag.turnTerminal.error !== null && diag.turnTerminal.error.length > 0
            ? `: ${diag.turnTerminal.error}`
            : ""
        }`;
  return [
    `phase=${diag.phase}`,
    `thread=${diag.threadId ?? "none"}`,
    `turn=${diag.turnId ?? "none"}`,
    `observed=[${observed}]`,
    `captured=${diag.capturedCount}`,
    `preambleForwards=${diag.preambleForwardCount}`,
    `inferenceExternal=${diag.originalExternalSendCount}`,
    `nativeTerminal=${terminal}`,
    `lastRetry=${diag.lastRetryError ?? "none"}`,
  ].join(" ");
};

/**
 * Isolated capture text route: vendor constructs the authenticated envelope
 * against loopback; daemon dispatches once; builder is interrupted locally;
 * true upstream bytes are decoded with the existing Responses helpers.
 *
 * Callers enter this only when the selected sub-method is `bridge-capture`
 * and readiness admits chatgpt ({@link runCodexNative} with `bridgeCapture`).
 *
 * The capture wait is raced against the builder's native `turn/completed` /
 * `error` so a real client failure is not swallowed as a generic 60s timeout.
 * Declined reasons include metadata-only diagnostics (PATH/METHOD counts).
 */
export type TCodexCaptureTextTurnParams = TCodexNativeParams & {
  /**
   * Hermetic/tests only. Production omits — routes come from forwarded
   * `/wham/accounts/check`. Empty memory fails closed.
   */
  readonly captureWorkspaceRoutes?: TCodexWorkspaceRouteMemory;
};

export const runCodexCapturedTextTurn = async (
  params: TCodexCaptureTextTurnParams,
): Promise<TNativeRunResult> => {
  const session = createRequestCaptureSession({
    destinationPolicy: codexCaptureDestinationPolicy({
      // Hermetic tests remap externalUrl to loopback via a custom sender;
      // production policy rejects non-chatgpt.com. Tests pass allowLoopback
      // destinations by rewriting externalUrl in the fake builder path —
      // the receiver always remaps to chatgpt.com; the dispatch sender in
      // tests overrides fetch to a loopback fake upstream.
      allowLoopback: false,
    }),
    signal: params.signal,
    captureTimeoutMs: params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
  });

  const receiver = startCodexCaptureReceiver({
    session,
    signal: params.signal,
    ...(params.captureWorkspaceRoutes !== undefined
      ? { workspaceRoutes: params.captureWorkspaceRoutes }
      : {}),
  });
  const redirects = codexCaptureRedirectArgs(receiver.guardedBaseUrl);

  let phase = "ephemeral-home";
  let threadId: string | null = null;
  let turnId: string | null = null;
  let captureOwnership: "none" | "accepted" | "uncertain" = "none";
  let turnTerminal: { status: string; error: string | null } | null = null;
  let lastRetryError: string | null = null;

  const snapshot = (): TCodexCaptureDiagnostics => ({
    phase,
    threadId,
    turnId,
    observed: receiver.observedRequests(),
    capturedCount: receiver.capturedCount(),
    preambleForwardCount: receiver.preambleForwardCount(),
    originalExternalSendCount: receiver.originalExternalSendCount(),
    turnTerminal,
    lastRetryError,
  });

  const decline = (reason: string): TNativeRunResult => ({
    kind: "declined",
    reason: `${reason} | ${formatCodexCaptureDiagnostics(snapshot())}`,
    ...(captureOwnership !== "none" ? { captureOwnership } : {}),
  });

  // Request-private ephemeral `CODEX_HOME` for the redirect keys — NEVER
  // `-c` argv (leaks to other local users via argv/cmdline) and NEVER the
  // daemon's shared/durable `cliEnv("chatgpt").CODEX_HOME/config.toml` (a
  // module-local lock cannot protect that against a second daemon process, a
  // legacy bridge binary, or a crash). See `codex-capture-ephemeral-home.ts`
  // for the full source-verified rationale. Must be built BEFORE
  // `ensureStarted()` spawns the child (it reads config.toml at startup) and
  // BEFORE the client is even constructed (the client's env carries the
  // ephemeral home). Missing `CODEX_HOME` or an unsafe durable auth-storage
  // mode fails closed — there is no safe fallback that still redirects the
  // real app-server away from production chatgpt.com.
  const durableCodexHome = params.env.CODEX_HOME;
  if (typeof durableCodexHome !== "string" || durableCodexHome.length === 0) {
    receiver.stop();
    session.dispose();
    return decline(
      "codex capture: CODEX_HOME missing from isolated env; refusing to spawn without a private redirect config",
    );
  }
  let ephemeralHome: TCodexCaptureEphemeralHomeHandle;
  try {
    ephemeralHome = await createCodexCaptureEphemeralHome({
      durableCodexHome,
      chatgptBaseUrl: redirects.chatgptBaseUrl,
      openaiBaseUrl: redirects.openaiBaseUrl,
      tempRoot: join(daemonTempDir(), "codex-capture-home"),
    });
  } catch (err) {
    receiver.stop();
    session.dispose();
    return decline(
      `codex capture: ephemeral CODEX_HOME setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const client = createIsolatedCodexAppServerClient(
    params.bin,
    {
      ...params.env,
      CODEX_HOME: ephemeralHome.ephemeralHome,
    },
    { modelMetadataHome: durableCodexHome },
  );

  const disposeAll = (): void => {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    receiver.stop();
    // `dispose()` only SIGNALS the child; the ephemeral home it was reading
    // its redirect config from must not be deleted until the child has
    // ACTUALLY exited (`disposeAndWaitForExit` awaits the persistent exit
    // promise) — otherwise a still-live child could be mid-read/mid-write
    // against a directory this removes out from under it. Fire-and-forget
    // from here (this function stays synchronous), but the two steps are
    // chained. An unexpected rejection from `disposeAndWaitForExit` is NOT
    // treated as a confirmed exit — cleanup only runs in the success branch,
    // never from a `.catch()` — so this deliberately leaks the ephemeral
    // directory rather than risk deleting it out from under a child we could
    // not confirm has exited; the rejection is logged, not swallowed, and
    // never left as an unhandled promise.
    client
      .disposeAndWaitForExit()
      .then(() => ephemeralHome.cleanup())
      .catch((err) => {
        logError(
          "native-runtime",
          safeDiagnosticMessage`codex capture: could not confirm isolated app-server exit; ephemeral CODEX_HOME left in place rather than risk deleting a live directory`,
          { message: err instanceof Error ? err.message : String(err) },
        );
      });
  };

  try {
    phase = "initialize";
    await client.ensureStarted();
    const startParams = await client.prepareThreadParams(
      codexBaseStartParams(
        params.providerModelId,
        params.systemText,
        params.serviceTier,
        params.modelContextWindow,
      ),
    );
    // Capture path always starts a FRESH isolated thread — do not resume the
    // shared warm map's thread ids (history injection unproven).
    phase = "thread-start";
    const opened = (await client.request("thread/start", startParams)) as {
      thread?: { id?: string };
    };
    if (typeof opened.thread?.id !== "string") {
      disposeAll();
      return decline("codex capture thread/start returned no thread id");
    }
    threadId = opened.thread.id;

    // Attach BEFORE turn/start so an early native failure is not lost while we
    // wait for capture. If the turn ends with zero captures, fail the capture
    // session immediately (do not wait for the generic PRE_COMMIT timeout).
    client.addSink({
      threadId,
      onDelta: () => {},
      onAgentMessage: () => {},
      onUsage: () => {},
      onRetryError: (message, info) => {
        // Non-terminal. Record for diagnostics; do NOT end the capture wait.
        lastRetryError = info.additionalDetails
          ? `${message} (${info.additionalDetails})`
          : message;
      },
      onCompleted: (status, errorMessage) => {
        turnTerminal = { status, error: errorMessage };
        if (receiver.capturedCount() > 0 || session.dispatchStarted()) {
          return;
        }
        const detail =
          errorMessage !== null && errorMessage.length > 0
            ? `${status}: ${errorMessage}`
            : status;
        try {
          session.complete({
            kind: "failed",
            reason: `codex turn ended before capture (${detail})`,
            usage: { kind: "none" },
          });
        } catch {
          // session may already be terminal/disposed
        }
      },
      onToolCall: (requestId) => {
        client.respondToServer?.(requestId, {
          contentItems: [
            {
              type: "inputText",
              text: "(capture: tool execution suppressed before settle)",
            },
          ],
          success: false,
        });
      },
    });

    phase = "turn-start";
    const effort = effortOf(params.reasoningEffort);
    const turn = (await client.request(
      "turn/start",
      codexTurnStartParams(
        threadId,
        params.userText,
        effort,
        params.serviceTier,
      ),
    )) as { turn?: { id?: string } };
    turnId = typeof turn.turn?.id === "string" ? turn.turn.id : null;

    if (params.signal.aborted) {
      if (turnId !== null) {
        await settleCodexCaptureTurn({ client, threadId, turnId });
      }
      disposeAll();
      return decline("client aborted");
    }

    phase = "awaiting-capture";
    const sender = createCodexCapturedDispatchSender({ session });
    const dispatched = await runCapturedDispatch({
      session,
      sender,
      signal: params.signal,
      suppressReason:
        "codex original external send suppressed; daemon owns the exchange",
    });
    captureOwnership = "accepted";
    phase = "dispatched";
    // Builder settlement: interrupt + authoritative terminal. Do NOT treat
    // process kill as proof of graceful reuse. Re-attach sink via settle —
    // addSink replaces the early-watch sink.
    const terminal = await settleCodexCaptureTurn({
      client,
      threadId,
      turnId,
    });
    turnTerminal = { status: terminal.status, error: terminal.error };
    phase = "settled";

    const rawChunks = decodeCodexUpstreamResponse(
      dispatched.response,
      params.providerModelId,
    );
    // Capture-only guard: on HTTP, a clean upstream EOF with no observed
    // terminal `finish_reason` (dropped connection, truncated body after a
    // 200) must not silently become an empty "success" — see
    // request-capture-output.ts and the live attempt-24 WS analogue (already
    // guarded at the WS sender via `codexWsFrameHasTerminal` /
    // `terminalSeen`). This is the HTTP-transport counterpart of that same
    // failure class. WS dispatch never reaches this wrapper twice — its own
    // guard already ran inside the sender before this Response existed.
    const chunks = requireCaptureTerminalFinishReason(rawChunks);

    // Capture the thread id for sessionId(); the isolated client is disposed
    // after the stream cancels/closes.
    const capturedThreadId = threadId;
    const stream = new ReadableStream<TChatCompletionChunk>({
      async start(controller) {
        const reader = chunks.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
          disposeAll();
        }
      },
      cancel() {
        disposeAll();
      },
    });

    return {
      kind: "committed",
      chunks: stream,
      sessionId: () => capturedThreadId,
    };
  } catch (error) {
    phase = "failed";
    if (threadId !== null) {
      try {
        const settled = await settleCodexCaptureTurn({
          client,
          threadId,
          turnId,
          timeoutMs: 1_000,
        });
        if (turnTerminal === null) {
          turnTerminal = { status: settled.status, error: settled.error };
        }
      } catch {
        // best-effort
      }
    }
    if (captureOwnership === "none" && session.dispatchStarted()) {
      captureOwnership = session.upstreamAccepted() ? "accepted" : "uncertain";
    }
    const base = error instanceof Error ? error.message : String(error);
    disposeAll();
    return decline(base);
  }
};

/** Test/helper: build a Request from a captured envelope (HTTP path). */
export const codexHttpRequestFromCaptured = (
  envelope: TCapturedRequestEnvelope,
): Request => requestFromCapturedEnvelope(envelope);

/** Test/helper: rebuild headers without stripping auth. */
export const codexHeadersFromCaptured = (
  pairs: ReadonlyArray<TCapturedHeaderPair>,
): Headers => headersInitFromCaptured(pairs, { dropHost: true });

export type { TCaptureTransport };
