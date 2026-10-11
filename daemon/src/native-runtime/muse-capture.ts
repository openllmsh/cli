/**
 * Muse bridge request-capture capability (W5 / P6).
 *
 * Static evidence (installed `muse-bin-1.4.0-R4302.1` + `@muse-code/sdk@1.3.0`,
 * MUSE_NO_AUTO_UPDATE=1; NO live inference; NO real credential inspection):
 *
 *   - Inference HTTP is native Rust (reqwest/hyper/rustls). SDK/JS `fetch`
 *     patches cannot observe Meta request bodies/headers.
 *   - `muse serve --base-url` is rejected (`unknown option --base-url`). Root
 *     flags cannot prefix `serve` (`invalid TUI options: unknown argument
 *     'serve'`). Serve help is sandbox/session only.
 *   - Enterprise **defaults** plane ACCEPTS nested
 *     `settings.endpoint_transport.{base_url,auth}` (`muse config validate
 *     --plane defaults` → `valid`, members `active`, `user_overridable=true`).
 *     Flat `settings.base_url` / `settings.api_base_url` remain
 *     `unknown_member`. Binary strings document the opt-in:
 *     "set the base_url in settings `endpoint_transport` AND pin its
 *     `auth = \"bearer\"`". Meta paths observed statically include
 *     `/v1/chat/completions` and `/v1/models`.
 *   - Auth-store `api_base_url` (typed in delegation) is an observation clue
 *     only; mutating credentials for capture is out of scope.
 *   - Proxy env / CONNECT sees ciphertext — not request capture. TLS
 *     interception is forbidden.
 *   - `muse exec --base-url` accepts a base URL, but switching the builder from
 *     MSP `serve` to `exec` requires unproven tools/history/input parity. Not a
 *     drop-in capture seam for the daemon MSP path.
 *   - MSP schema exposes `turn/cancel`, `session/resume` (history is a READ
 *     preference), and `turn/steer`. No client history-injection method
 *     comparable to Codex `thread/inject_items`.
 *
 * KEYCHAIN INCIDENT (2026-09-27): scratch probes under
 * `/tmp/muse-capture-experiment/{run,run-oauth}.ts` spawned the REAL host
 * `muse-bin` via MuseClient.spawn with a REPLACING env (Node does not merge
 * `process.env`). `run-oauth.ts` omitted `TBH_CREDENTIAL_BACKEND=file` (and
 * `MUSE_LOGIN=0`) under a temp HOME + synthetic oauth auth.json — muse-bin
 * then opened macOS Keychain UI. Production `cliEnv("muse")` +
 * `cleanMuseSpawnEnv` + overlay already pin the file backend; the bug was the
 * wrong invocation, not durable auth. Hermetic capture therefore uses fake
 * MSP/HTTP fixtures only. Live verification MUST reuse the durable XDG store
 * via the production env chain (no login, no dummy HOME, no separate product
 * enable flag — bridge-capture is the only variant gate).
 *
 * Muse request capture is SERVE-ACTIVATED via `settings.endpoint_transport`
 * under the bridge-capture variant (Keychain-free durable auth proven
 * 2026-09-27). Default MSP bridge remains for non-capture hops.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import type { TChatGptStreamEvent } from "@openllmsh/wire/providers/chatgpt/streaming";
import {
  chatGptEventToChunk,
  isChatGptResponsesTerminalEvent,
  newChatGptStreamState,
} from "@openllmsh/wire/providers/chatgpt/streaming";
import { Schema } from "effect";
import {
  createCaptureLoopbackProxyGuard,
  museCaptureProxyNoProxyHosts,
} from "./capture-loopback-proxy-guard";
import type { TMuseToolNameMap } from "./muse-mcp-server";
import { mapMuseCapturedToolName } from "./muse-mcp-server";
import type { TMuseCallerTool, TMuseInputPart } from "./muse-request";
import type {
  TMuseHostFactory,
  TMuseSpawnTarget,
  TMuseTurnSessionResult,
} from "./muse-runtime";
import {
  MUSE_SERVE_SAFETY_ARGS,
  museTurnDeclineReason,
  openMuseTurnSession,
  wrapMuseServeSpawn,
} from "./muse-runtime";
import type {
  TBuilderSettlement,
  TCaptureDestinationPolicy,
  TCapturedDispatchSender,
  TCapturedHeaderPair,
  TCapturedRequestEnvelope,
  TRequestCaptureSession,
} from "./request-capture";
import {
  createRequestCaptureSession,
  openCaptureDecoration,
  preserveCapturedHeaders,
  requestFromCapturedEnvelope,
  runCapturedDispatch,
} from "./request-capture";
import type { TCaptureHistoryBuilderPlan } from "./request-capture-history";
import { captureAwareHistoryBuilderPlan } from "./request-capture-history";
import { requireCaptureTerminalFinishReason } from "./request-capture-output";
import type { TNativeHistoryTurn, TNativeRunResult } from "./types";
import { captureOwnershipFromSession, PRE_COMMIT_TIMEOUT_MS } from "./types";

export type TMuseCaptureBlockerCode =
  | "native_reqwest_stack"
  | "serve_rejects_base_url"
  | "endpoint_transport_redirect_unproven"
  | "keychain_isolation_unproven"
  | "proxy_ciphertext_only"
  | "exec_builder_parity_unproven"
  | "no_msp_history_inject";

export type TMuseCaptureBlocker = {
  readonly code: TMuseCaptureBlockerCode;
  readonly detail: string;
};

/**
 * Capability report for Muse capture.
 *
 * Live-proven 2026-09-27 (durable cliEnv→cleanMuseSpawnEnv→overlay, file
 * backend, no Keychain UI): `settings.endpoint_transport.{base_url,auth:bearer}`
 * redirects muse-bin POST `/responses` to loopback plaintext; remapped relay to
 * `https://api.meta.ai/v1/responses` returned 200 text/event-stream.
 */
export type TMuseRequestCaptureCapability = {
  readonly supported: true;
  readonly provider: "muse";
  readonly mechanism: "settings.endpoint_transport";
  /** Nested settings key that activates the proven redirect. */
  readonly schemaCandidate: "settings.endpoint_transport";
  /** Residual limitations — not activation blockers for cold plaintext capture. */
  readonly blockers: ReadonlyArray<TMuseCaptureBlocker>;
  readonly inspected: {
    readonly sdk: string;
    readonly native: string;
  };
  readonly proven: {
    readonly keychainFreeDurableAuth: true;
    readonly plaintextPath: "/responses";
    readonly externalApiBase: "https://api.meta.ai/v1";
  };
};

export const MUSE_REQUEST_CAPTURE_BLOCKERS: ReadonlyArray<TMuseCaptureBlocker> =
  [
    {
      code: "native_reqwest_stack",
      detail:
        "muse serve inference uses a native Rust HTTP stack; SDK/JS fetch patches do not see Meta envelopes — capture uses settings.endpoint_transport redirect instead",
    },
    {
      code: "serve_rejects_base_url",
      detail:
        "muse serve rejects --base-url; capture uses nested settings.endpoint_transport, not argv",
    },
    {
      code: "proxy_ciphertext_only",
      detail:
        "HTTPS CONNECT / packet redirect sees ciphertext, not headers/body; TLS interception remains out of scope",
    },
    {
      code: "exec_builder_parity_unproven",
      detail:
        "muse exec accepts --base-url but is not the MSP serve builder; capture stays on serve + endpoint_transport",
    },
    {
      code: "no_msp_history_inject",
      detail:
        "MSP has turn/cancel and resume history read preferences, not a client history-injection API for warm capture — cold+seed only",
    },
  ] as const;

/** Snapshot of the offline-inspected Muse artifact tuple (not a package pin). */
export const MUSE_REQUEST_CAPTURE_INSPECTED = {
  sdk: "1.3.0",
  native: "1.4.0-R4302.1",
} as const;

/**
 * Meta application paths observed in the native binary strings (static).
 * Live capture observed application path `/responses` under the `/v1` API base.
 */
export const MUSE_META_APPLICATION_PATHS = {
  chatCompletions: "/v1/chat/completions",
  models: "/v1/models",
  responses: "/responses",
} as const;

export const MUSE_REQUEST_CAPTURE_CAPABILITY: TMuseRequestCaptureCapability = {
  supported: true,
  provider: "muse",
  mechanism: "settings.endpoint_transport",
  schemaCandidate: "settings.endpoint_transport",
  blockers: MUSE_REQUEST_CAPTURE_BLOCKERS,
  inspected: MUSE_REQUEST_CAPTURE_INSPECTED,
  proven: {
    keychainFreeDurableAuth: true,
    plaintextPath: "/responses",
    externalApiBase: "https://api.meta.ai/v1",
  },
};

/** Static capability evaluation — no process spawn, no credential access. */
export const evaluateMuseRequestCaptureCapability =
  (): TMuseRequestCaptureCapability => MUSE_REQUEST_CAPTURE_CAPABILITY;

/**
 * Whether Muse serve argv (the daemon's real builder) admits a base-URL
 * override. Encoded from verified help/rejection — always false today.
 */
export const museServeAcceptsBaseUrlFlag = (): boolean => false;

/**
 * Pre-sandbox serve argv the daemon uses for MSP hosts. Pure; mirrors
 * `wrapMuseServeSpawn` inputs so capture work cannot invent a different
 * builder under the same helper.
 */
export const museServeCaptureArgv = (
  museBin: string,
): ReadonlyArray<string> => [museBin, "serve", ...MUSE_SERVE_SAFETY_ARGS];

/**
 * Actual daemon spawn target for Muse MSP hosts (includes sandbox wrap).
 * Capture adapters must reuse this — never invent a `--base-url` serve argv.
 */
export const museDaemonServeSpawnTarget = (museBin: string): TMuseSpawnTarget =>
  wrapMuseServeSpawn(museBin);

/**
 * True when a candidate serve argv would attempt the rejected `--base-url`
 * shape. Used by tests / future adapters to refuse unsafe argv mutation.
 */
export const museServeArgvAttemptsBaseUrl = (
  argv: ReadonlyArray<string>,
): boolean => {
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--base-url") return true;
    if (part?.startsWith("--base-url=") === true) return true;
  }
  return false;
};

/**
 * Flat settings keys that must NOT be written into the Muse overlay for
 * capture. They are rejected as unknown_member (or would mutate auth). Nested
 * `endpoint_transport` is the activated capture seam — see
 * {@link museCaptureEndpointTransportSettings} / `runMuseNativeCapture`.
 */
export const MUSE_CAPTURE_FORBIDDEN_SETTINGS_KEYS = [
  "base_url",
  "api_base_url",
  "endpoint",
  "meta_base_url",
] as const;

export type TMuseCaptureForbiddenSettingsKey =
  (typeof MUSE_CAPTURE_FORBIDDEN_SETTINGS_KEYS)[number];

export const museCaptureForbiddenSettingsPresent = (
  settings: Readonly<Record<string, unknown>>,
): ReadonlyArray<TMuseCaptureForbiddenSettingsKey> =>
  MUSE_CAPTURE_FORBIDDEN_SETTINGS_KEYS.filter((key) => key in settings);

/**
 * Nested endpoint-transport settings document validated by
 * `muse config validate --plane defaults` (static schema evidence).
 *
 * Pure builder for overlay merge. Does NOT activate capture, does NOT spawn
 * muse-bin. The nested `{base_url,auth}` object is what
 * {@link createMuseExecutionOverlay}'s `endpointTransport` accepts.
 */
export type TMuseCaptureEndpointTransportDocument = {
  readonly schema_version: 1;
  readonly endpoint_transport: {
    readonly base_url: string;
    readonly auth: "bearer";
  };
};

/**
 * Origin-only BY THIS PARSER'S OWN (conservative) choice, not a real vendor
 * schema requirement: `muse config validate --plane defaults` accepts a
 * `settings.endpoint_transport.base_url` carrying a path segment and only
 * rejects a query string. This parser stays stricter as defense-in-depth —
 * accepting a path here would invite the "generic unsafe URL accept" this
 * receiver must not do, since nothing downstream can act on it correctly
 * (see below).
 *
 * A path-embedded nonce still can't reach this receiver: the real
 * muse-bin's startup model-catalog fetch (observed both via `muse exec
 * --base-url` and via the production `settings.endpoint_transport` seam
 * through `runMuseNativeCapture`'s own composition) lands at the base
 * URL's bare origin with any path segment silently dropped. That is
 * evidence about the CATALOG endpoint specifically, not a proven property
 * of every Meta-provider endpoint or every muse-bin version — treat it as
 * the concrete, evidenced reason this parser can't rely on a URL path,
 * not as a blanket claim.
 *
 * `startMuseCaptureReceiver` instead uses the private `HTTP_PROXY`/
 * `http_proxy` proxy-hop guard (`capture-loopback-proxy-guard.ts`): the
 * nonce rides `Proxy-Authorization`, never the destination URL. This is
 * now verified positive on the real production seam — a real
 * `runMuseNativeCapture` run (real `cliEnv("muse")`, real default
 * `hostFactory`, real registered tool, `fetchImpl` as the only override)
 * captured the real `/responses` request with valid proxy auth, the real
 * `Authorization` header intact, no proxy-header leak, and the registered
 * tool's schema present in the body — see
 * `tests/transport/muse-capture-real-cli-construction.e2e.test.ts`.
 *
 * `tests/transport/muse-bridge-request-capture.test.ts` has a regression
 * asserting a `capture-loopback-guard.ts`-produced (path-nonce) URL is
 * still rejected here — this parser's own choice, not a vendor requirement.
 */
const parseMuseCaptureOriginOnlyBaseUrl = (baseUrlRaw: string): string => {
  const baseUrl = baseUrlRaw.trim();
  if (baseUrl.length === 0) {
    throw new Error("museCaptureEndpointTransportSettings requires a baseUrl");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `museCaptureEndpointTransportSettings baseUrl is not a valid URL: ${baseUrl}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `museCaptureEndpointTransportSettings baseUrl must be http(s), got ${parsed.protocol}`,
    );
  }
  // Origin-only (no path/query) — matches native "provider endpoint override
  // must be origin-only" static diagnostic string.
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "museCaptureEndpointTransportSettings baseUrl must be origin-only (no path/query/hash)",
    );
  }
  return parsed.origin;
};

export const museCaptureEndpointTransportSettings = (args: {
  readonly baseUrl: string;
}): TMuseCaptureEndpointTransportDocument => {
  const origin = parseMuseCaptureOriginOnlyBaseUrl(args.baseUrl);
  return {
    schema_version: 1,
    endpoint_transport: {
      base_url: origin,
      auth: "bearer",
    },
  };
};

/** Overlay-ready nested fields (no schema_version wrapper). */
export const museCaptureEndpointTransportForOverlay = (args: {
  readonly baseUrl: string;
}): { readonly base_url: string; readonly auth: "bearer" } => {
  const doc = museCaptureEndpointTransportSettings(args);
  return doc.endpoint_transport;
};

/**
 * Muse history feed under capture. MSP has no inject_items equivalent —
 * `structuredInjectProven` is always false. Tool/reasoning history is
 * `unsupported`; plain text uses cold+seed via shared planner.
 */
export const museCaptureHistoryBuilderPlan = (args: {
  readonly systemText: string | null;
  readonly deltaText: string;
  readonly turns: ReadonlyArray<TNativeHistoryTurn>;
  readonly hasPrior: boolean;
}): TCaptureHistoryBuilderPlan =>
  captureAwareHistoryBuilderPlan({
    systemText: args.systemText,
    deltaText: args.deltaText,
    turns: args.turns,
    hasPrior: args.hasPrior,
    structuredInjectProven: false,
  });

/**
 * Native cancel settlement contract (static MSP schema): await authoritative
 * `turn/completed` / `turn/unqueued` after `turn/cancel`. Process kill is
 * cleanup / unknown termination — never success.
 */
export const MUSE_CAPTURE_CANCEL_SETTLEMENT = {
  cancelMethod: "turn/cancel",
  awaitTerminalMethods: ["turn/completed", "turn/unqueued"] as const,
  processKillIsSuccess: false,
} as const;

/**
 * Paths that look like a real installed muse-bin / launcher — hermetic capture
 * tests must refuse these and inject an explicit fake fixture instead.
 */
export const museCapturePathLooksLikeRealVendorBinary = (
  museBin: string,
): boolean => {
  const lower = museBin.toLowerCase();
  if (lower.includes("muse-bin-")) return true;
  if (lower.endsWith("/muse-bin") || lower === "muse-bin") return true;
  // Shell launcher install locations (auto-update + Keychain risk).
  if (lower.endsWith("/.local/bin/muse") || lower.endsWith("/bin/muse")) {
    return true;
  }
  return false;
};

/**
 * Pins required for Keychain-free muse-bin / launcher spawns. Node
 * `child_process.spawn({ env })` REPLACES `process.env` — omitting
 * `TBH_CREDENTIAL_BACKEND=file` is what opened Keychain in the scratch probes.
 * `MUSE_AUTH_PATH` is launcher-only and is NOT a substitute for these pins.
 * There is no separate product enable flag — bridge-capture is the variant.
 */
export const MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS = {
  TBH_CREDENTIAL_BACKEND: "file",
  MUSE_NO_AUTO_UPDATE: "1",
  MUSE_LOGIN: "0",
} as const;

export const museCaptureEnvMissingKeychainPins = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ReadonlyArray<keyof typeof MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS> => {
  const missing: Array<keyof typeof MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS> = [];
  for (const key of Object.keys(MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS) as Array<
    keyof typeof MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS
  >) {
    if (env[key] !== MUSE_CAPTURE_KEYCHAIN_SAFE_ENV_PINS[key]) {
      missing.push(key);
    }
  }
  return missing;
};

/**
 * Guard for any muse-bin spawn env (fake or live). Refuses empty HOME /
 * XDG_CONFIG_HOME and missing file-backend / auto-update / login pins.
 */
export const assertMuseCaptureEnvKeychainSafe = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void => {
  const missing = museCaptureEnvMissingKeychainPins(env);
  if (missing.length > 0) {
    throw new Error(
      `muse capture spawn env missing Keychain-safe pins: ${missing.join(", ")} (Node spawn env replaces process.env; omit TBH_CREDENTIAL_BACKEND=file → macOS Keychain)`,
    );
  }
  const home = env.HOME?.trim() ?? "";
  if (home.length === 0) {
    throw new Error(
      "muse capture spawn env requires non-empty HOME (durable provider home, not blank/temp-without-auth)",
    );
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() ?? "";
  if (xdg.length === 0) {
    throw new Error(
      "muse capture spawn env requires non-empty XDG_CONFIG_HOME",
    );
  }
};

/**
 * True when a spawn HOME does not match the durable provider HOME that owns
 * auth.json — the scratch-experiment mismatch class.
 */
export const museCaptureHomeMismatchesDurable = (args: {
  readonly durableHome: string;
  readonly spawnHome: string;
}): boolean => {
  const durable = args.durableHome.trim();
  const spawn = args.spawnHome.trim();
  if (durable.length === 0 || spawn.length === 0) return true;
  return durable !== spawn;
};

/**
 * Hermetic-test guard only: require an explicit fake fixture path. Product
 * live paths use the real vendor binary through the normal bridge-capture
 * variant — they do not go through this helper.
 */
export const assertMuseCaptureFixtureBin = (museBin: string): void => {
  if (museBin.trim().length === 0) {
    throw new Error("muse capture fixture bin path must be non-empty");
  }
  if (museCapturePathLooksLikeRealVendorBinary(museBin)) {
    throw new Error(
      `muse capture hermetic fixture forbids real vendor binary path: ${museBin}`,
    );
  }
};

export type TMuseRequestCapturePlan = {
  /**
   * `endpoint_transport_capture` when bridge-capture is selected and the
   * proven mechanism is active; otherwise keep today's MSP bridge.
   */
  readonly mode: "unchanged_bridge" | "endpoint_transport_capture";
  readonly reason: string;
  /** True when a caller asked for Muse bridge-capture. */
  readonly bridgeCaptureRequested: boolean;
  readonly capability: TMuseRequestCaptureCapability;
};

/**
 * Resolve what Muse should do under a requested `bridge-capture` selection.
 *
 * No separate product enable flag — bridge-capture is the only variant gate.
 */
export const resolveMuseRequestCapturePlan = (opts?: {
  readonly bridgeCaptureRequested?: boolean;
}): TMuseRequestCapturePlan => {
  const bridgeCaptureRequested = opts?.bridgeCaptureRequested === true;
  const capability = evaluateMuseRequestCaptureCapability();
  // Selection is the hop's sub-method. Capability-table declaration alone must
  // not arm capture — serve uses shouldActivateBridgeRequestCapture(selected).
  if (capability.supported && bridgeCaptureRequested) {
    return {
      mode: "endpoint_transport_capture",
      reason:
        "muse bridge-capture via settings.endpoint_transport (Keychain-free durable auth proven; plaintext POST /responses → api.meta.ai/v1)",
      bridgeCaptureRequested: true,
      capability,
    };
  }
  return {
    mode: "unchanged_bridge",
    reason: "muse keeps the existing MSP bridge (bridge-capture not selected)",
    bridgeCaptureRequested: false,
    capability,
  };
};

export type TOpenMuseRequestCaptureResult = {
  readonly plan: TMuseRequestCapturePlan;
  readonly decoration: ReturnType<typeof openCaptureDecoration>;
};

/**
 * Muse-owned entry point for capture decoration.
 *
 * When bridge-capture is selected, opens the shared capture session so serve
 * can attach the loopback receiver + overlay endpoint_transport. No separate
 * product enable flag.
 */
export const openMuseRequestCaptureDecoration = (args: {
  readonly bridgeCaptureRequested?: boolean;
  readonly enabled?: boolean;
  readonly destinationPolicy: TCaptureDestinationPolicy;
  readonly signal?: AbortSignal;
  readonly maxBodyBytes?: number;
  readonly captureTimeoutMs?: number;
  readonly museBin?: string;
}): TOpenMuseRequestCaptureResult => {
  void args.museBin;
  const plan = resolveMuseRequestCapturePlan({
    bridgeCaptureRequested: args.bridgeCaptureRequested === true,
  });
  if (plan.mode !== "endpoint_transport_capture") {
    return { plan, decoration: null };
  }
  const enabled = args.enabled !== false;
  return {
    plan,
    decoration: openCaptureDecoration({
      enabled,
      destinationPolicy: args.destinationPolicy,
      signal: args.signal,
      maxBodyBytes: args.maxBodyBytes,
      captureTimeoutMs: args.captureTimeoutMs,
    }),
  };
};

/**
 * Default (non-bridge-capture) Muse path must stay undecorated.
 */
export const assertMuseRequestCaptureUnarmed = (
  result: TOpenMuseRequestCaptureResult,
): void => {
  if (result.decoration !== null) {
    throw new Error(
      "muse request capture decoration must be null when bridge-capture is not selected",
    );
  }
  if (result.plan.mode !== "unchanged_bridge") {
    throw new Error(
      `muse request capture plan must be unchanged_bridge without bridge-capture, got ${result.plan.mode}`,
    );
  }
};

/** True when Muse should decorate the hop for bridge-capture. */
export const shouldDecorateMuseRequestCapture = (opts?: {
  readonly bridgeCaptureRequested?: boolean;
}): boolean => {
  const plan = resolveMuseRequestCapturePlan(opts);
  return (
    plan.mode === "endpoint_transport_capture" && plan.capability.supported
  );
};

// ---------------------------------------------------------------------------
// Hermetic transport helpers (NO muse-bin spawn).
//
// These prove loopback capture → daemon dispatch → Responses decode ownership
// with fake HTTP only. They do not flip capability.supported and must never
// invoke a real vendor binary (Keychain risk).
// ---------------------------------------------------------------------------

/**
 * External Meta Model API base the daemon may dispatch to.
 *
 * Live capture (2026-09-27): with `endpoint_transport.base_url` origin-only,
 * muse-bin POSTs application paths like `/responses` (not `/v1/responses`).
 * Durable auth `api_base_url` and native strings use `https://api.meta.ai/v1`
 * as the provider base — remap must join THAT base + observed path.
 */
export const MUSE_CAPTURE_EXTERNAL_ORIGIN = "https://api.meta.ai";
export const MUSE_CAPTURE_EXTERNAL_API_BASE = "https://api.meta.ai/v1";

export const museCaptureDestinationPolicy = (opts?: {
  readonly allowLoopback?: boolean;
}): TCaptureDestinationPolicy => ({
  allowedOrigins: new Set([MUSE_CAPTURE_EXTERNAL_ORIGIN]),
  allowLoopback: opts?.allowLoopback === true,
});

/** Match Meta Responses inference paths (hermetic + live: POST /responses). */
export const isMuseCaptureInferencePath = (pathname: string): boolean =>
  pathname === "/responses" ||
  pathname.endsWith("/responses") ||
  pathname === "/v1/responses" ||
  pathname.endsWith("/v1/responses") ||
  pathname === MUSE_META_APPLICATION_PATHS.chatCompletions ||
  pathname.endsWith(MUSE_META_APPLICATION_PATHS.chatCompletions);

/**
 * Remap a loopback-observed URL back to the external Meta Model API base while
 * preserving application path + query. Application headers/body are untouched.
 *
 * Observed `/responses` → `https://api.meta.ai/v1/responses`.
 * Observed `/v1/responses` stays under the same host without doubling `/v1`.
 */
export const remapMuseObservedUrlToExternal = (observedUrl: string): string => {
  const url = new URL(observedUrl);
  const base = new URL(MUSE_CAPTURE_EXTERNAL_API_BASE);
  const pathname = url.pathname;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    // Already v1-prefixed (e.g. /v1/chat/completions) — replace onto origin only.
    return `${base.origin}${pathname}${url.search}`;
  }
  const basePath = base.pathname.replace(/\/$/, "");
  return `${base.origin}${basePath}${pathname}${url.search}`;
};

/**
 * Reminder / observer posts must not become the capture envelope. Observed
 * offline: muse serve fires scope-reminder and reminder-observer `/responses`
 * bodies containing these markers before/around the main turn.
 */
export const isMuseReminderInferenceBody = (
  body: Uint8Array | null,
): boolean => {
  if (body === null || body.byteLength === 0) return false;
  const sampleLen = Math.min(body.byteLength, 64 * 1024);
  const sample = new TextDecoder().decode(body.subarray(0, sampleLen));
  if (sample.includes("submit_reminder_decision")) return true;
  if (sample.includes("You are a scope reminder")) return true;
  if (sample.includes("You are a reminder observer")) return true;
  if (sample.includes("<reminder-state>")) return true;
  return false;
};

export const isMusePrimaryCaptureBody = (body: Uint8Array | null): boolean =>
  body !== null && body.byteLength > 0 && !isMuseReminderInferenceBody(body);

const localSettlementHttpResponse = (): Response =>
  new Response(null, { status: 204 });

const localReminderStubResponse = (): Response =>
  new Response(
    JSON.stringify({
      error: {
        message: "muse capture: reminder/observer request stubbed locally",
      },
    }),
    {
      status: 500,
      headers: { "content-type": "application/json" },
    },
  );

const localPreambleResponse = (pathname: string): Response => {
  if (
    pathname.includes("/models") ||
    pathname.endsWith(MUSE_META_APPLICATION_PATHS.models)
  ) {
    return new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(null, { status: 204 });
};

export type TMuseCaptureReceiver = {
  readonly baseUrl: string;
  readonly stop: () => void;
  readonly capturedCount: () => number;
  readonly reminderStubCount: () => number;
  readonly suppressedRetryCount: () => number;
  /** Always 0 — non-inference / reminder traffic is stubbed locally. */
  readonly originalExternalSendCount: () => number;
  /**
   * Requests rejected before capture for missing/wrong `Proxy-Authorization`
   * — the loopback-guard authentication failures, never a body/path issue.
   */
  readonly proxyAuthRejectedCount: () => number;
  /**
   * Child-scoped `HTTP_PROXY`/`http_proxy`/`NO_PROXY`/`no_proxy` env
   * additions for this receiver's private proxy-hop guard. `mcpServerUrl`
   * excludes a registered local MCP server's own address so its
   * `tools/list`/`tools/call` traffic stays direct — never proxied, never
   * gated by this guard. Callers MUST merge this into the spawned child's
   * own env (never global/system config) alongside `baseUrl`.
   */
  readonly proxyEnv: (mcpServerUrl: string | null) => Record<string, string>;
  /**
   * The exact `Proxy-Authorization` header value a real proxy-aware client
   * (or a hermetic fixture simulating one) must present to this receiver.
   * See `TCaptureLoopbackProxyGuard.proxyAuthorizationHeaderValue`.
   */
  readonly proxyAuthorizationHeaderValue: () => string;
};

export type TStartMuseCaptureReceiverOptions = {
  readonly session: TRequestCaptureSession;
  readonly signal?: AbortSignal;
};

/**
 * Private loopback recorder for Muse Meta inference capture.
 *
 * Primary inference → `session.captureSend` then local 204 settlement.
 * Reminder/observer inference → local stub (never captureSend).
 * Preamble (`/models`, etc.) → local stub. Never forwards off-box.
 * Never spawns muse-bin.
 */
export const startMuseCaptureReceiver = (
  opts: TStartMuseCaptureReceiverOptions,
): TMuseCaptureReceiver => {
  let capturedCount = 0;
  let reminderStubCount = 0;
  let suppressedRetryCount = 0;
  let proxyAuthRejectedCount = 0;
  let builderSettlement: TBuilderSettlement | null = null;
  // Real muse-bin drops any path segment on `endpoint_transport.base_url`
  // before issuing a request (confirmed twice against the real binary —
  // see the doc comment on `parseMuseCaptureOriginOnlyBaseUrl`), so the
  // `capture-loopback-guard.ts` path-nonce cannot reach this receiver. This
  // header-based proxy-hop guard is the verified alternative: real muse-bin
  // (reqwest) honors `HTTP_PROXY`/`http_proxy` and sends a normal
  // `Proxy-Authorization` header, independent of the real `Authorization`
  // header and body (also confirmed against the real binary).
  const proxyGuard = createCaptureLoopbackProxyGuard();

  const offerEnvelope = async (
    envelope: TCapturedRequestEnvelope,
  ): Promise<TBuilderSettlement> => {
    if (capturedCount > 0) {
      suppressedRetryCount += 1;
      return (
        builderSettlement ?? {
          kind: "suppressed",
          reason: "muse capture already owns this turn; retry suppressed",
        }
      );
    }
    capturedCount += 1;
    const settlement = await opts.session.captureSend(envelope);
    builderSettlement = settlement;
    return settlement;
  };

  // IPv6 loopback (`::1`), deliberately DIFFERENT from the per-turn MCP
  // server's `127.0.0.1` (`muse-mcp-server.ts`) — a distinct address, not
  // just a distinct port. `NO_PROXY` entries are not reliably port-scoped
  // across HTTP client implementations (some match a bare hostname
  // regardless of the request's actual port); excluding the MCP server's
  // address by a DIFFERENT address family removes that ambiguity entirely,
  // rather than relying on `HTTP_PROXY`/`NO_PROXY` port-matching being
  // correct. Requires no OS-level alias configuration (unlike a second
  // `127.0.0.x` address, verified unreachable without one on this
  // development machine) — but IPv6 is not universally available or
  // enabled on every host; a host with IPv6 disabled would need a
  // different exclusion strategy, not assumed away here. `proxyEnv` also
  // always sets `NO_PROXY`/`no_proxy` explicitly (never omitted, even to
  // `""`), so an ambient inherited value can never survive the merge.
  const server = Bun.serve({
    port: 0,
    hostname: "::1",
    async fetch(req: Request): Promise<Response> {
      if (opts.signal?.aborted) {
        return new Response(null, { status: 499 });
      }
      // Authenticate BEFORE any body read, path classification, or capture —
      // a missing/wrong Proxy-Authorization is rejected here, before this
      // receiver does anything else with the request. 407 (Proxy
      // Authentication Required) is the correct status for this failure
      // mode, distinct from the 404 the path-based guard uses elsewhere —
      // never logs the presented or expected credential.
      if (!proxyGuard.authenticate(req.headers)) {
        proxyAuthRejectedCount += 1;
        return new Response(null, { status: 407 });
      }
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const rawBody =
        method === "GET" || method === "HEAD"
          ? null
          : new Uint8Array(await req.arrayBuffer());
      const body = rawBody !== null && rawBody.byteLength > 0 ? rawBody : null;

      if (!isMuseCaptureInferencePath(url.pathname)) {
        return localPreambleResponse(url.pathname);
      }

      if (isMuseReminderInferenceBody(body)) {
        reminderStubCount += 1;
        return localReminderStubResponse();
      }

      if (!isMusePrimaryCaptureBody(body)) {
        return localPreambleResponse(url.pathname);
      }

      // Strip the proxy hop-framing header before anything downstream sees
      // it — it authenticates the CHILD's hop to this receiver, never the
      // real application request, and must never be recorded, classified
      // as an application header, or forwarded anywhere.
      const headers: ReadonlyArray<TCapturedHeaderPair> =
        preserveCapturedHeaders(proxyGuard.stripHopFraming(req.headers));
      const envelope: TCapturedRequestEnvelope = {
        transport: "http",
        method,
        observedUrl: url.toString(),
        externalUrl: remapMuseObservedUrlToExternal(url.toString()),
        headers,
        body,
        framing: null,
      };

      try {
        await offerEnvelope(envelope);
        return localSettlementHttpResponse();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });

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

  // Bracketed IPv6 literal — required in both a URL host and a proxy
  // userinfo@host value.
  const hostAndPort = `[::1]:${server.port}`;
  return {
    baseUrl: `http://${hostAndPort}`,
    stop,
    capturedCount: (): number => capturedCount,
    reminderStubCount: (): number => reminderStubCount,
    suppressedRetryCount: (): number => suppressedRetryCount,
    originalExternalSendCount: (): number => 0,
    proxyAuthRejectedCount: (): number => proxyAuthRejectedCount,
    proxyEnv: (mcpServerUrl: string | null): Record<string, string> => {
      const proxyUrl = proxyGuard.proxyUrl(hostAndPort);
      const noProxy = museCaptureProxyNoProxyHosts(mcpServerUrl);
      // ALWAYS set NO_PROXY/no_proxy, even to "" when there is no MCP host
      // to exclude — never merely omit them. `cleanMuseSpawnEnv` inherits
      // the ambient process env (minus the poison list), so a pre-existing
      // NO_PROXY the parent process happened to carry (e.g. a blanket "*",
      // or an entry matching this receiver's own listen address) would
      // otherwise survive untouched into the child and could steer its
      // client away from the authenticated proxy hop for this receiver's
      // own address. An explicit (possibly empty) value here always wins
      // the merge, since this is applied last in the spawn-env composition.
      return {
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      };
    },
    proxyAuthorizationHeaderValue: (): string =>
      proxyGuard.proxyAuthorizationHeaderValue(),
  };
};

/**
 * Open the Muse loopback capture handle: receiver + overlay transport fields.
 * Caller passes `endpointTransport` into {@link createMuseExecutionOverlay} /
 * `runMuseNative`, then dispatches the captured envelope once via
 * {@link runCapturedDispatch} / {@link createMuseCapturedDispatchSender}.
 */
export type TMuseBridgeCaptureHandle = {
  readonly endpointTransport: {
    readonly base_url: string;
    readonly auth: "bearer";
  };
  readonly session: TRequestCaptureSession;
  readonly receiver: TMuseCaptureReceiver;
  readonly dispose: () => void;
};

export const openMuseBridgeCaptureHandle = (opts: {
  readonly signal?: AbortSignal;
  readonly captureTimeoutMs?: number;
}): TMuseBridgeCaptureHandle => {
  const session = createRequestCaptureSession({
    // PRODUCTION path: never allow a loopback destination. The receiver's
    // own `fetch` handler always sets `envelope.externalUrl` via
    // `remapMuseObservedUrlToExternal` — a fixed rewrite onto the trusted
    // `MUSE_CAPTURE_EXTERNAL_ORIGIN`, already in `allowedOrigins` — so a
    // genuine captured request is never loopback and this changes nothing
    // for real traffic. `allowLoopback: true` here would only matter if
    // some future bug ever fed an unremapped/loopback URL into
    // `captureSend`; keeping it `false` fails that closed instead of
    // silently accepting it. (The hermetic `runMuseHermeticCaptureRoundTrip`
    // below is a different, test-only session that legitimately dispatches
    // to a loopback mock and keeps `allowLoopback: true`.)
    destinationPolicy: museCaptureDestinationPolicy({ allowLoopback: false }),
    signal: opts.signal,
    captureTimeoutMs: opts.captureTimeoutMs ?? 60_000,
  });
  let receiver: TMuseCaptureReceiver;
  try {
    receiver = startMuseCaptureReceiver({ session, signal: opts.signal });
  } catch (error) {
    try {
      session.dispose();
    } catch {
      /* Preserve the receiver failure. */
    }
    throw error;
  }
  const dispose = (): void => {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    receiver.stop();
  };
  return {
    endpointTransport: museCaptureEndpointTransportForOverlay({
      baseUrl: receiver.baseUrl,
    }),
    session,
    receiver,
    dispose,
  };
};

const ChatGptStreamEventSchema: Schema.Schema<TChatGptStreamEvent> =
  Schema.Record({ key: Schema.String, value: Schema.Unknown });

/**
 * Decode the daemon-owned Meta `/responses` upstream via existing
 * ChatGPT/Responses wire helpers. Never rebuilds system/tools/history.
 * Passes the response body through without buffering.
 */
export const decodeMuseUpstreamResponse = (
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

const remapMuseToolCallsInChunk = (
  chunk: TChatCompletionChunk,
  nameMap: TMuseToolNameMap,
): TChatCompletionChunk => {
  let changed = false;
  const choices = chunk.choices.map((choice) => {
    const toolCalls = choice.delta.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return choice;
    const mapped = toolCalls.map((tc) => {
      const fn = tc.function;
      if (fn === undefined || fn === null || typeof fn.name !== "string") {
        return tc;
      }
      const result = mapMuseCapturedToolName(fn.name, nameMap);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      if (result.name === fn.name) return tc;
      changed = true;
      return {
        ...tc,
        // Preserve id + argument deltas; only the return-side name is remapped.
        function: { ...fn, name: result.name },
      };
    });
    return { ...choice, delta: { ...choice.delta, tool_calls: mapped } };
  });
  if (!changed) return chunk;
  return { ...chunk, choices };
};

/**
 * Return-side stream transform: Meta `mcp__openllm_muse_client_tools.<leaf>`
 * → caller tool name. Preserves call ids and argument fragments. Unknown
 * names under our MCP wire prefix refuse the stream (no blind stripping).
 */
export const mapMuseCaptureChunkToolNames = (
  chunks: ReadableStream<TChatCompletionChunk>,
  nameMap: TMuseToolNameMap,
): ReadableStream<TChatCompletionChunk> => {
  // Acquired once, up front, so `cancel()` can reach the SAME locked reader —
  // `chunks.cancel()` on a stream that already has an active reader (the one
  // `start()` acquires) rejects with "Cannot cancel a locked ReadableStream".
  const reader = chunks.getReader();
  return new ReadableStream<TChatCompletionChunk>({
    async start(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(remapMuseToolCallsInChunk(value, nameMap));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
};

/** Narrow fetch seam for hermetic stubs — not the full `typeof fetch` surface. */
export type TMuseCaptureFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Upstream sender for Muse capture. Marks accepted on HTTP ok WITHOUT reading
 * the body, then returns the live body stream — buffering would defeat TTFT
 * and aborting the session signal at dispatch-complete would cancel the body.
 */
export const createMuseCapturedDispatchSender = (args: {
  readonly session: TRequestCaptureSession;
  readonly fetchImpl?: TMuseCaptureFetch;
}): TCapturedDispatchSender => {
  const fetchImpl = args.fetchImpl ?? fetch;
  return async (request, _envelope, signal): Promise<Response> => {
    const response = await fetchImpl(request, { signal });
    if (response.ok) {
      args.session.markUpstreamAccepted();
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
};

export const museRequestFromCapturedEnvelope = (
  envelope: TCapturedRequestEnvelope,
): Request => requestFromCapturedEnvelope(envelope);

/**
 * Await an authoritative Muse turn terminal after `turn/cancel`. Kill is
 * cleanup, not settlement proof. Matches {@link MUSE_CAPTURE_CANCEL_SETTLEMENT}.
 */
export const settleMuseCaptureTurn = async (args: {
  readonly cancel: () => Promise<void>;
  readonly completed: Promise<unknown>;
  readonly timeoutMs?: number;
}): Promise<{ readonly status: string; readonly timedOut: boolean }> => {
  const settled = (async (): Promise<"completed"> => {
    try {
      await args.cancel();
    } catch {
      // interrupt is best-effort
    }
    await args.completed;
    return "completed";
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      settled,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), args.timeoutMs ?? 5_000);
      }),
    ]);
    return { status: outcome, timedOut: outcome === "timeout" };
  } finally {
    clearTimeout(timer);
  }
};

export type TMuseNativeCaptureParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly providerId?: string;
  readonly parts: ReadonlyArray<TMuseInputPart>;
  readonly promptText: string;
  readonly tools?: ReadonlyArray<TMuseCallerTool>;
  readonly signal: AbortSignal;
  readonly precommitMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly hostFactory?: TMuseHostFactory;
  readonly cwd?: string;
  /** Hermetic seam — production uses real fetch to the remapped external URL. */
  readonly fetchImpl?: TMuseCaptureFetch;
};

const MUSE_CAPTURE_RPC_TIMEOUT_MS = 45_000;

/**
 * Bridge-capture Muse path: overlay `endpoint_transport` → loopback capture →
 * one daemon-owned upstream dispatch (no request rewrite) → Responses SSE
 * decode. MSP turn is cancelled after capture; its (empty/error) settlement is
 * NOT the client response. Capture ownership accepted ⇒ no retry/fallback send.
 */
export const runMuseNativeCapture = async (
  params: TMuseNativeCaptureParams,
): Promise<TNativeRunResult> => {
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "muse CLI not installed" };
  }
  if (params.parts.length === 0) {
    return {
      kind: "declined",
      reason: "prompt contains no text or image content",
    };
  }

  const captureTimeoutMs = params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS;
  const rpcTimeoutMs = params.rpcTimeoutMs ?? MUSE_CAPTURE_RPC_TIMEOUT_MS;
  // Receiver bind pre-send decline: a `Bun.serve` throw here disposes its
  // own internal session before ever offering an envelope, so ownership
  // stays "none" — resolve `declined`, never reject.
  let handle: TMuseBridgeCaptureHandle;
  try {
    handle = openMuseBridgeCaptureHandle({
      signal: params.signal,
      captureTimeoutMs,
    });
  } catch (error) {
    if (params.signal.aborted) {
      return { kind: "declined", reason: "client aborted" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "declined",
      reason: `muse capture receiver failed to start: ${message}`,
    };
  }

  let captureOwnership: "none" | "accepted" | "uncertain" = "none";
  /**
   * Set when the native Muse turn ends BEFORE any capture envelope was ever
   * offered — preserves the real native failure (e.g. authRequired, launch
   * failure) instead of letting `runCapturedDispatch`'s `takeCaptured()` sit
   * out the full capture timeout for an envelope that will never arrive.
   */
  let turnEndedBeforeCaptureReason: string | null = null;
  let sessionHandle: TMuseTurnSessionResult | null = null;
  let turnSettled: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | null = null;

  const disposeAll = (): Promise<void> => {
    disposal ??= (async (): Promise<void> => {
      handle.dispose();
      const closing = sessionHandle;
      sessionHandle = null;
      await turnSettled;
      await closing?.cleanup();
    })();
    return disposal;
  };

  try {
    // Shared provider-owned opener — same dirs/MCP/overlay/spawn/session
    // lifecycle as the non-capture bridge (`runMuseNative`), with ONLY the
    // capture-specific options below: the endpoint-transport redirect,
    // hosted web-search folding, the private proxy-hop guard env, and the
    // Keychain-safety env assertion. Capture does not invent Meta-side
    // tools — caller tools still register on the same per-turn MCP server,
    // but a `tools/call` mid-capture is a no-op (capture owns the hop; the
    // builder's own body is forwarded verbatim, see the comment on
    // `openMuseTurnSession`'s `onToolCall` hook default).
    sessionHandle = await openMuseTurnSession({
      bin: params.bin,
      env: params.env,
      providerModelId: params.providerModelId,
      ...(params.providerId !== undefined
        ? { providerId: params.providerId }
        : {}),
      tools: params.tools ?? [],
      signal: params.signal,
      rpcTimeoutMs,
      ...(params.hostFactory !== undefined
        ? { hostFactory: params.hostFactory }
        : {}),
      cwd: params.cwd ?? tmpdir(),
      dirPrefix: "muse-capture-",
      endpointTransport: handle.endpointTransport,
      // Capture-only: server-executed search folds into the captured turn
      // instead of leaking an unresolved `muse.web_search` function_call
      // (live-verified, see `createMuseExecutionOverlay`'s doc comment).
      // Never applied to the non-capture bridge overlay.
      webSearchMode: "hosted",
      // Child-scoped only (never global/system config) — the private
      // proxy-hop guard authenticating this receiver's own loopback, since
      // its path-nonce sibling cannot reach real muse-bin (see
      // `startMuseCaptureReceiver`'s doc comment). Excludes the per-turn MCP
      // server's own address from proxying so `tools/list`/`tools/call`
      // stay direct, exactly as without capture.
      extraEnv: (mcpServerUrl) => handle.receiver.proxyEnv(mcpServerUrl),
      assertEnv: assertMuseCaptureEnvKeychainSafe,
    });

    const { session, callerToolNameMap } = sessionHandle;
    const turn = await session.sendUserTurn(params.parts);

    // If the native turn ends (completed/cancelled/failed) BEFORE any capture
    // envelope was ever offered, cancel the capture wait immediately instead
    // of leaving `runCapturedDispatch` blocked on `takeCaptured()` for the
    // full capture timeout (e.g. an authRequired/launch failure that never
    // even attempts the Meta HTTP call). `session.cancel()` is a no-op once a
    // terminal outcome already exists (captured/dispatched/failed), so this
    // never disturbs an already-captured or already-dispatched exchange.
    const abortCaptureOnEarlyTurnEnd = turn.completed
      .then((outcome) => {
        if (handle.session.captured() !== null) return;
        turnEndedBeforeCaptureReason = museTurnDeclineReason(outcome);
        handle.session.cancel(
          `muse turn ended before capture: ${turnEndedBeforeCaptureReason}`,
        );
      })
      .catch(() => {
        // turn.completed rejecting is not this watcher's concern — the
        // dispatch/settlement paths below handle their own failures.
      });

    const sender = createMuseCapturedDispatchSender({
      session: handle.session,
      fetchImpl: params.fetchImpl,
    });
    let dispatched: Awaited<ReturnType<typeof runCapturedDispatch>>;
    try {
      dispatched = await runCapturedDispatch({
        session: handle.session,
        sender,
        signal: params.signal,
        suppressReason:
          "muse original external send suppressed; daemon owns the exchange",
      });
    } catch (dispatchError) {
      if (turnEndedBeforeCaptureReason !== null) {
        throw new Error(turnEndedBeforeCaptureReason);
      }
      throw dispatchError;
    } finally {
      void abortCaptureOnEarlyTurnEnd;
    }
    captureOwnership = dispatched.response.ok ? "accepted" : "uncertain";

    // The upstream response is already owned. Builder settlement must not
    // delay its delivery or turn cleanup errors into a second-send opportunity.
    // Teardown still waits for settlement before closing the host.
    turnSettled = settleMuseCaptureTurn({
      cancel: () => turn.cancel(),
      completed: turn.completed,
      timeoutMs: 5_000,
    }).catch(() => {});

    if (!dispatched.response.ok) {
      await disposeAll();
      return {
        kind: "declined",
        reason: `muse capture upstream HTTP ${dispatched.response.status}`,
        captureOwnership,
      };
    }

    const rawChunks = decodeMuseUpstreamResponse(
      dispatched.response,
      params.providerModelId,
    );
    const nameMapped =
      callerToolNameMap.wireToCaller.size > 0
        ? mapMuseCaptureChunkToolNames(rawChunks, callerToolNameMap)
        : rawChunks;
    // Capture-only guard: a clean upstream EOF with no observed terminal
    // finish_reason (dropped connection, truncated body after 200) must not
    // silently become a synthesized "stop" — see request-capture-output.ts.
    const chunks = requireCaptureTerminalFinishReason(nameMapped);

    // Held reader lets cancel propagate: acquired once so `cancel()` can
    // reach the same locked reader `start()` uses, instead of only disposing.
    const reader = chunks.getReader();
    const stream = new ReadableStream<TChatCompletionChunk>({
      async start(controller) {
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
          await disposeAll();
        }
      },
      cancel(reason) {
        // Best-effort; swallow so a rejection here isn't unhandled.
        void reader.cancel(reason).catch(() => {});
        return disposeAll();
      },
    });

    return {
      kind: "committed",
      chunks: stream,
      sessionId: () => null,
    };
  } catch (error) {
    // `captureOwnership` (the local variable) is only ever assigned AFTER
    // `runCapturedDispatch` resolves (line ~1324 above) — if the sender
    // throws AFTER it already marked the session's own dispatchStarted /
    // upstreamAccepted (e.g. a real upstream send was attempted or even
    // accepted, then the sender itself threw), that assignment never runs
    // and this local stays "none", understating real ownership and letting
    // the walker retry/fall back to another fleet member on a request that
    // may have already reached (or been accepted by) the real upstream.
    // Read the session's OWN authoritative state — captured BEFORE
    // `disposeAll()` tears the session down — and prefer it whenever the
    // local variable was never set.
    const ownership =
      captureOwnership !== "none"
        ? captureOwnership
        : captureOwnershipFromSession(handle.session);
    await disposeAll();
    if (params.signal.aborted) {
      return {
        kind: "declined",
        reason: "client aborted",
        ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "declined",
      reason: `muse capture failed: ${message}`,
      ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
    };
  }
};

/**
 * Hermetic one-shot (fake HTTP only — never muse-bin): start receiver +
 * session, stub reminder if provided, capture primary envelope, daemon
 * dispatch once, decode Responses SSE.
 */
export const runMuseHermeticCaptureRoundTrip = async (args: {
  readonly primaryBody: Uint8Array;
  readonly reminderBody?: Uint8Array;
  readonly upstreamResponse: Response;
  readonly providerModelId: string;
  readonly signal?: AbortSignal;
  readonly captureTimeoutMs?: number;
}): Promise<{
  readonly chunks: ReadableStream<TChatCompletionChunk>;
  readonly captured: TCapturedRequestEnvelope;
  readonly reminderStubCount: number;
  readonly dispose: () => void;
}> => {
  // Fake HTTP only — no muse-bin argv. Live opt-in must not affect this path.
  const session = createRequestCaptureSession({
    destinationPolicy: museCaptureDestinationPolicy({ allowLoopback: true }),
    signal: args.signal,
    captureTimeoutMs: args.captureTimeoutMs ?? 10_000,
  });
  const receiver = startMuseCaptureReceiver({
    session,
    signal: args.signal,
  });

  const dispose = (): void => {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    receiver.stop();
  };

  // This helper fakes HTTP directly rather than spawning a client — so it
  // must present the SAME `Proxy-Authorization` a real proxy-aware client
  // (or a spawned fixture simulating one) would, or the receiver's guard
  // correctly 407s it before capture, same as it would an unauthenticated
  // caller.
  const proxyAuthHeader = receiver.proxyAuthorizationHeaderValue();
  try {
    if (args.reminderBody !== undefined) {
      const reminderRes = await fetch(`${receiver.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "proxy-authorization": proxyAuthHeader,
        },
        body: Buffer.from(args.reminderBody),
        signal: args.signal,
      });
      void reminderRes;
    }

    const offerPromise = fetch(`${receiver.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-exp-dummy-key",
        "proxy-authorization": proxyAuthHeader,
      },
      body: Buffer.from(args.primaryBody),
      signal: args.signal,
    });

    const sender = createMuseCapturedDispatchSender({
      session,
      fetchImpl: async (): Promise<Response> => args.upstreamResponse,
    });

    const dispatched = await runCapturedDispatch({
      session,
      sender,
      signal: args.signal,
      suppressReason:
        "muse original external send suppressed; daemon owns the exchange",
    });

    await offerPromise;

    const captured = session.captured();
    if (captured === null) {
      dispose();
      throw new Error("muse hermetic capture: no envelope captured");
    }

    return {
      chunks: decodeMuseUpstreamResponse(
        dispatched.response,
        args.providerModelId,
      ),
      captured,
      reminderStubCount: receiver.reminderStubCount(),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};
