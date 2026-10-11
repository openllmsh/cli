/**
 * Cursor bridge request-capture (W3) — parent-side IPC + spawn decoration.
 *
 * The child preload (`cursor-capture-preload.txt` → materialized `.cjs`) hooks
 * ConnectRPC send paths inside Cursor's bundled Node. This module:
 *   1. materializes that preload (embedded text → temp `.cjs` file),
 *   2. listens on a request-private unix socket,
 *   3. validates AgentService Run* envelopes (+ BidiAppend observation),
 *   4. offers them to the shared `request-capture` session,
 *   5. settles the child locally (maps onto ACP `session/cancel`).
 *
 * Default off. Do not set the child env unless serve activates a ready
 * `bridge-capture` route for cursor (capability table currently omits it).
 *
 * ## Packaging (integrator-owned compile)
 *
 * The preload source lives as `.txt` and is imported with `{ type: "text" }` so
 * `bun build --compile` inlines it and TypeScript does not type it through
 * `allowJs` as a CommonJS exports object. At runtime
 * `materializeCursorCapturePreload` writes the bytes to a temp `.cjs` path the
 * child can `--require`. No separate compile asset copy is required when the
 * text import stays in the daemon's compile graph (this file is reachable from
 * `cursor-acp.ts` → `serve.ts` → `main.ts`).
 *
 * If a future compile split drops native-runtime from the binary entry, the
 * integrator must either keep this module imported from the entry graph or
 * ship a materialized `cursor-capture-preload.cjs` beside the binary and point
 * `OPENLLM_CURSOR_CAPTURE_PRELOAD_PATH` at it.
 *
 * ## Response decode (hermetic)
 *
 * Connect→chunk decoding for `AgentServerMessage.interaction_update` lives in
 * `cursor-capture-decode.ts` (`chunksFromCursorCapturedResponse`,
 * `chunksFromCursorConnectResponseBytes`). Integrator wiring:
 *   1. after `runCapturedDispatch`, call `chunksFromCursorCapturedResponse`
 *      (or `publishCapturedDirectOutput` with that stream);
 *   2. settle ACP via `settleCursorCaptureViaAcpCancel` — never feed chunks
 *      back into the vendor child;
 *   3. flip `SUB_METHOD_CAPABILITIES.cursor` to include `bridge-capture` only
 *      after serve uses this path and the HTTP/1 multi-RPC note below is
 *      accepted or solved.
 *
 * HTTP/1 `RunSSE` + `BidiAppend` is owned by {@link runCursorCapturedTransaction}:
 * collect the primary AgentService envelope and every companion RPC sharing
 * the same opaque `BidiRequestId` (logical transaction id — NOT a removed
 * conversation_id / caller metadata), then dispatch each exact vendor URL /
 * headers / body once in the vendor's concurrency order. Companion RPCs are
 * ack'd locally with a control-only unary success so the vendor append loop
 * finishes constructing the input; the true inference stream never returns
 * to the child.
 *
 * HTTP/2 `request_context_args` is bridged: inject the server control frame into
 * the live builder, forward its native RequestContextResult upstream unchanged.
 * Other exec subtypes stay fail-closed (no fabricated success / no native exec).
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http2 from "node:http2";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { providerDeclaresBridgeCapture } from "../sub-method";
import type {
  TCursorAgentServiceMethod,
  TCursorDecodeBlock,
  TCursorFollowUpClassification,
} from "./cursor-capture-decode";
import {
  CURSOR_CAPTURE_DECODE_STATUS,
  CursorCaptureDecodeError,
  chunksFromCursorCapturedResponse,
  chunksFromCursorConnectResponseBytes,
  chunksFromCursorConnectResponseBytesTolerant,
  chunksStreamFromCursorConnectResponse,
  chunksStreamFromCursorConnectResponseBody,
  classifyAgentClientFollowUp,
  cursorAgentServiceMethodOfPath,
  cursorExecServerFailure,
  decodeAgentServerMessage,
  decodeCapturedBidiAppendBody,
  encodeConnectEnvelope,
  execServerContextNumericId,
  isCursorBidiAppendPath,
  requestIdFromCapturedRunSseBody,
  resolveConnectEnvelopePayload,
  takeConnectEnvelopes,
} from "./cursor-capture-decode";
import preloadSource from "./cursor-capture-preload.txt" with { type: "text" };
import type {
  TBuilderSettlement,
  TCaptureDestinationPolicy,
  TCapturedHeaderPair,
  TCapturedRequestEnvelope,
  TCaptureTerminalOutcome,
  TRequestCaptureSession,
} from "./request-capture";
import {
  createRequestCaptureSession,
  isHttpPseudoHeaderName,
  RequestCaptureError,
  requestFromCapturedEnvelope,
} from "./request-capture";

export type { TCursorAgentServiceMethod, TCursorDecodeBlock };
export {
  CURSOR_CAPTURE_DECODE_STATUS,
  CursorCaptureDecodeError,
  chunksFromCursorCapturedResponse,
  chunksFromCursorConnectResponseBytes,
  chunksFromCursorConnectResponseBytesTolerant,
  chunksStreamFromCursorConnectResponse,
  chunksStreamFromCursorConnectResponseBody,
  cursorAgentServiceMethodOfPath,
  decodeCapturedBidiAppendBody,
  isCursorBidiAppendPath,
  requestIdFromCapturedRunSseBody,
};

export const CURSOR_CAPTURE_SOCK_ENV = "OPENLLM_CURSOR_CAPTURE_SOCK";
export const CURSOR_CAPTURE_TOKEN_ENV = "OPENLLM_CURSOR_CAPTURE_TOKEN";
export const CURSOR_CAPTURE_EXTERNAL_ORIGIN_ENV =
  "OPENLLM_CURSOR_CAPTURE_EXTERNAL_ORIGIN";
export const CURSOR_CAPTURE_PRELOAD_LOADED_ENV =
  "OPENLLM_CURSOR_CAPTURE_PRELOAD_LOADED";

/** Default Cursor agent API origin (CLI `--endpoint` default). */
export const CURSOR_AGENT_DEFAULT_ORIGIN = "https://api2.cursor.sh";

/**
 * Static HTTPS origins from the installed agent-cli-runtime artifact
 * (`2026.07.23-e383d2b`) — CLI default + staging backends the vendor's own
 * `t2` URL picker leaves on `backendUrl`.
 */
export const CURSOR_AGENT_STATIC_ORIGINS: ReadonlySet<string> = new Set([
  CURSOR_AGENT_DEFAULT_ORIGIN,
  "https://staging.cursor.sh",
  "https://dev-staging.cursor.sh",
]);

/**
 * Dynamic agent backends from authenticated `serverAgentUrlConfig`
 * (`agentUrl` / `agentnUrl`). Live observation: `agentn.global.api5.cursor.sh`.
 * Artifact picker: when both URLs are set, HTTP/1 uses `agentUrl`, HTTP/2 uses
 * `agentnUrl`. Bound to `agent` / `agentn` + optional region labels + `apiN` +
 * proper `.cursor.sh` public-suffix host — not every `*.cursor.sh` host.
 */
/**
 * `agent` / `agentn` + optional region labels + `apiN` + `.cursor.sh`
 * (backtracking keeps `apiN` as its own label — not every `*.cursor.sh`).
 */
export const CURSOR_DYNAMIC_AGENT_HOST_RE =
  /^agentn?(?:\.[a-z0-9-]+)*\.api[1-9][0-9]*\.cursor\.sh$/;

export const CURSOR_AGENT_SERVICE_PATH_RE =
  /\/agent\.v1\.AgentService\/(Run|RunSSE|RunPoll)(?:\?|$)/;

/** HTTP/1 companion RPC that carries AgentClientMessage bytes for RunSSE. */
export const CURSOR_BIDI_APPEND_PATH_RE =
  /\/aiserver\.v1\.BidiService\/BidiAppend(?:\?|$)/;

export const CURSOR_CONNECT_CONTENT_TYPE_RE =
  /(?:^|;\s*)application\/connect\+(?:proto|json)(?:\s|;|$)/i;

/**
 * Proper Cursor-owned hostname: `cursor.sh` or a subdomain of it — never a
 * lookalike like `cursor.sh.evil.com` or `notcursor.sh`.
 */
export const isCursorOwnedHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return host === "cursor.sh" || host.endsWith(".cursor.sh");
};

/**
 * Whether `url` is an official Cursor agent inference destination the capture
 * dispatcher may contact. HTTPS + default port + Cursor-owned host family +
 * AgentService/BidiAppend path. Does not rewrite the URL — admission only.
 */
export const isOfficialCursorAgentCaptureUrl = (url: URL): boolean => {
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  // Default HTTPS port only (empty or "443").
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (!isCursorOwnedHostname(host)) return false;

  const pathWithQuery = `${url.pathname}${url.search}`;
  const isInferencePath =
    CURSOR_AGENT_SERVICE_PATH_RE.test(pathWithQuery) ||
    CURSOR_BIDI_APPEND_PATH_RE.test(pathWithQuery);
  if (!isInferencePath) return false;

  if (CURSOR_AGENT_STATIC_ORIGINS.has(url.origin)) return true;
  // Staging hosts are also named without a port in the artifact picker.
  if (host === "staging.cursor.sh" || host === "dev-staging.cursor.sh") {
    return true;
  }
  return CURSOR_DYNAMIC_AGENT_HOST_RE.test(host);
};

export type TCursorCaptureIpcCaptureMessage = {
  readonly type: "capture" | "capture_companion" | "capture_followup";
  readonly token: string;
  readonly id: string;
  readonly parentId?: string;
  readonly transport: "connect";
  readonly wire: "http" | "http2" | "fetch";
  readonly method: string;
  readonly observedUrl: string;
  readonly externalUrl: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64: string | null;
  readonly framing: Readonly<Record<string, string | number | boolean | null>>;
};

export type TCursorCaptureChildEnv = {
  readonly NODE_OPTIONS: string;
  readonly [CURSOR_CAPTURE_SOCK_ENV]: string;
  readonly [CURSOR_CAPTURE_TOKEN_ENV]: string;
  readonly [CURSOR_CAPTURE_EXTERNAL_ORIGIN_ENV]?: string;
};

/**
 * One buffered BidiAppend companion, still carrying the exact vendor envelope
 * the child would have sent. `appendSeqno` / `requestId` are decoded for
 * ordering / correlation only — the envelope body is what gets dispatched.
 */
export type TCursorCapturedCompanion = {
  readonly envelope: TCapturedRequestEnvelope;
  readonly requestId: string | null;
  readonly appendSeqno: number | null;
};

/**
 * Opaque logical transaction assembled from a primary AgentService capture
 * plus zero or more BidiAppend companions that share the same `BidiRequestId`.
 * Distinct from any removed conversation_id / caller metadata field.
 */
export type TCursorCaptureTransaction = {
  readonly logicalTransactionId: string | null;
  readonly primary: TCapturedRequestEnvelope;
  readonly companions: ReadonlyArray<TCursorCapturedCompanion>;
  readonly method: TCursorAgentServiceMethod | null;
};

export type TCursorCaptureBridge = {
  readonly session: TRequestCaptureSession;
  readonly childEnv: TCursorCaptureChildEnv;
  readonly preloadPath: string;
  readonly socketPath: string;
  /** Settle the child after daemon ownership transfer / cancel. */
  settleChild(settlement: TBuilderSettlement): void;
  /** Wait until the preload offers a primary capture (or the session aborts). */
  waitForOffer(): Promise<TCapturedRequestEnvelope>;
  /**
   * Wait for the primary + companions that share its opaque BidiRequestId.
   * Companions are ack'd locally as they arrive; this resolves after a quiet
   * window (default 50ms) once the primary is known, or immediately for
   * HTTP/2 Run / non-RunSSE primaries that need no companions.
   */
  waitForTransaction(opts?: {
    readonly quietMs?: number;
    readonly maxWaitMs?: number;
  }): Promise<TCursorCaptureTransaction>;
  /** Snapshot of companions buffered so far (tests / diagnostics). */
  companions(): ReadonlyArray<TCursorCapturedCompanion>;
  /**
   * Inject server→client Connect frames into the builder's intercepted stream
   * (duplex_bridge). `captureId` is the primary capture IPC id.
   */
  injectServerFrames(captureId: string, body: Uint8Array): void;
  /** Wait for a builder follow-up write correlated to `parentCaptureId`. */
  waitForFollowUp(args: {
    readonly parentCaptureId: string;
    readonly timeoutMs?: number;
  }): Promise<TCapturedRequestEnvelope>;
  /** Close the builder-side inject stream after context negotiation. */
  closeDuplexInject(captureId: string): void;
  /** Primary capture IPC id from the last offered AgentService envelope. */
  lastCaptureId(): string | null;
  dispose(): Promise<void>;
};

const appendNodeRequire = (
  existing: string | undefined,
  preloadPath: string,
): string => {
  const flag = `--require ${preloadPath}`;
  if (existing === undefined || existing.trim().length === 0) return flag;
  // Avoid double-injecting the same path.
  if (existing.includes(preloadPath)) return existing;
  return `${existing} ${flag}`;
};

export const isCursorAgentServiceInferencePath = (
  pathWithQuery: string,
): boolean => CURSOR_AGENT_SERVICE_PATH_RE.test(pathWithQuery);

export const isCursorConnectContentType = (
  contentType: string | undefined,
): boolean =>
  typeof contentType === "string" &&
  contentType.length > 0 &&
  CURSOR_CONNECT_CONTENT_TYPE_RE.test(contentType);

/**
 * Classify a candidate outbound request as Cursor AgentService inference
 * (capture) vs BidiAppend companion vs everything else (pass-through). Native
 * file_service traffic is not visible to the JS preload; this classifier
 * documents the JS boundary.
 */
export const classifyCursorOutboundRequest = (args: {
  readonly url: string;
  readonly headers?: ReadonlyArray<TCapturedHeaderPair> | Headers;
}):
  | { readonly kind: "agent_service_inference"; readonly path: string }
  | {
      readonly kind: "bidi_append_companion";
      readonly path: string;
      readonly note: string;
    }
  | { readonly kind: "non_inference"; readonly reason: string } => {
  let path: string;
  try {
    const u = new URL(args.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return { kind: "non_inference", reason: "invalid_url" };
  }
  if (isCursorAgentServiceInferencePath(path)) {
    return { kind: "agent_service_inference", path };
  }
  if (CURSOR_BIDI_APPEND_PATH_RE.test(path) || isCursorBidiAppendPath(path)) {
    return {
      kind: "bidi_append_companion",
      path,
      note: CURSOR_CAPTURE_DECODE_STATUS.http1RunSseRequestCompleteness,
    };
  }
  if (path.includes("file_service") || path.includes("FileService")) {
    return {
      kind: "non_inference",
      reason: "file_service_codebase_sync_not_js_inference",
    };
  }
  return { kind: "non_inference", reason: "not_agent_service_run" };
};

export const cursorCaptureDestinationPolicy = (args?: {
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly allowLoopback?: boolean;
  /**
   * Override the official-host matcher. Production omits →
   * {@link isOfficialCursorAgentCaptureUrl}.
   */
  readonly allowUrl?: (url: URL) => boolean;
}): TCaptureDestinationPolicy => ({
  allowedOrigins: args?.allowedOrigins ?? CURSOR_AGENT_STATIC_ORIGINS,
  allowLoopback: args?.allowLoopback ?? false,
  allowUrl: args?.allowUrl ?? isOfficialCursorAgentCaptureUrl,
});

/**
 * Write the embedded preload source to `targetDir/cursor-capture-preload.cjs`.
 * Mode 0o600 — child-readable via the daemon-chosen path in NODE_OPTIONS.
 */
export const materializeCursorCapturePreload = async (
  targetDir: string,
): Promise<string> => {
  await mkdir(targetDir, { recursive: true });
  const path = join(targetDir, "cursor-capture-preload.cjs");
  await writeFile(path, preloadSource, { mode: 0o600 });
  return path;
};

export const buildCursorCaptureChildEnv = (args: {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly preloadPath: string;
  readonly socketPath: string;
  readonly token: string;
  readonly externalOrigin?: string;
}): TCursorCaptureChildEnv => {
  const base = args.baseEnv ?? {};
  const nodeOptions = appendNodeRequire(
    typeof base.NODE_OPTIONS === "string" ? base.NODE_OPTIONS : undefined,
    args.preloadPath,
  );
  const env: TCursorCaptureChildEnv = {
    NODE_OPTIONS: nodeOptions,
    [CURSOR_CAPTURE_SOCK_ENV]: args.socketPath,
    [CURSOR_CAPTURE_TOKEN_ENV]: args.token,
  };
  if (args.externalOrigin !== undefined && args.externalOrigin.length > 0) {
    return {
      ...env,
      [CURSOR_CAPTURE_EXTERNAL_ORIGIN_ENV]: args.externalOrigin,
    };
  }
  return env;
};

/**
 * Whether Cursor declares a serve-activated `bridge-capture` route.
 */
export const isCursorBridgeRequestCaptureEnabled = (): boolean =>
  providerDeclaresBridgeCapture("cursor");

const decodeBodyBase64 = (raw: string | null): Uint8Array | null => {
  if (raw === null || raw.length === 0) return null;
  return new Uint8Array(Buffer.from(raw, "base64"));
};

const toCapturedEnvelope = (
  msg: TCursorCaptureIpcCaptureMessage,
): TCapturedRequestEnvelope => ({
  transport: "connect",
  method: msg.method,
  observedUrl: msg.observedUrl,
  externalUrl: msg.externalUrl,
  headers: msg.headers.map(([n, v]) => [n, v] as const),
  body: decodeBodyBase64(msg.bodyBase64),
  framing: {
    entries: {
      ...msg.framing,
      wire: msg.wire,
      provider: "cursor",
    },
  },
});

/**
 * Open a parent-side capture bridge: temp preload + unix IPC + capture session.
 *
 * Call only when capture is enabled for `cursor`. The returned `childEnv` must
 * be merged into the AcpClient spawn env (after `cliEnv`, before/through
 * `cleanNativeSpawnEnv` — NODE_OPTIONS is not poison-stripped).
 */
export const openCursorCaptureBridge = async (args: {
  readonly destinationPolicy?: TCaptureDestinationPolicy;
  readonly signal?: AbortSignal;
  readonly maxBodyBytes?: number;
  readonly captureTimeoutMs?: number;
  readonly externalOrigin?: string;
  /** Override temp root (tests). */
  readonly tempRoot?: string;
}): Promise<TCursorCaptureBridge> => {
  // CodeRabbit round 2: production must NOT default to `allowLoopback: true`
  // — loopback destinations are a hermetic-test-only relaxation. The real
  // production call site (`runCursorNativeCapture`) passes no
  // `destinationPolicy`, so it now gets the STRICT default (official Cursor
  // hosts only via `isOfficialCursorAgentCaptureUrl`); every test that needs
  // loopback already passes `destinationPolicy:
  // cursorCaptureDestinationPolicy({ allowLoopback: true })` explicitly.
  const policy = args.destinationPolicy ?? cursorCaptureDestinationPolicy();
  const session = createRequestCaptureSession({
    destinationPolicy: policy,
    signal: args.signal,
    maxBodyBytes: args.maxBodyBytes,
    captureTimeoutMs: args.captureTimeoutMs,
  });

  const root =
    args.tempRoot ?? (await mkdtemp(join(tmpdir(), "openllm-cursor-capture-")));
  const preloadPath = await materializeCursorCapturePreload(root);
  const socketPath = join(root, "ipc.sock");
  const token = randomBytes(32).toString("hex");

  let childSettle: ((settlement: TBuilderSettlement) => void) | null = null;
  let lastCaptureId: string | null = null;
  /** @type {import('node:net').Socket | null} */
  let activeSocket: import("node:net").Socket | null = null;
  const sockets = new Set<import("node:net").Socket>();
  let disposed = false;

  const companions: TCursorCapturedCompanion[] = [];
  let companionsChanged: (() => void) | null = null;
  const notifyCompanions = (): void => {
    companionsChanged?.();
  };
  const followUps: TCapturedRequestEnvelope[] = [];
  const followUpWaiters: Array<{
    readonly parentCaptureId: string;
    readonly resolve: (envelope: TCapturedRequestEnvelope) => void;
    readonly reject: (err: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  const notifyFollowUp = (envelope: TCapturedRequestEnvelope): void => {
    const parentId =
      typeof envelope.framing?.entries.parentCaptureId === "string"
        ? envelope.framing.entries.parentCaptureId
        : null;
    // Prefer delivering to a waiter (consumed). Otherwise queue for later
    // waitForFollowUp dequeues — never sticky-duplicate across both paths.
    if (parentId !== null) {
      for (let i = 0; i < followUpWaiters.length; i += 1) {
        const waiter = followUpWaiters[i];
        if (waiter === undefined || waiter.parentCaptureId !== parentId) {
          continue;
        }
        clearTimeout(waiter.timer);
        followUpWaiters.splice(i, 1);
        waiter.resolve(envelope);
        return;
      }
    }
    followUps.push(envelope);
  };

  const server = createServer((socket) => {
    if (disposed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    activeSocket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        void handleLine(line, socket);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (activeSocket === socket) activeSocket = null;
    });
  });

  const handleLine = async (
    line: string,
    socket: import("node:net").Socket,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const msgType = (parsed as { type?: unknown }).type;
    if (
      msgType !== "capture" &&
      msgType !== "capture_companion" &&
      msgType !== "capture_followup" &&
      msgType !== "builder_stream_error"
    ) {
      return;
    }
    if (msgType === "builder_stream_error") {
      const errMsg = parsed as {
        readonly token?: unknown;
        readonly id?: unknown;
        readonly code?: unknown;
        readonly message?: unknown;
      };
      if (errMsg.token !== token) return;
      const parentId = typeof errMsg.id === "string" ? errMsg.id : null;
      const detail = [
        typeof errMsg.code === "string" ? errMsg.code : "stream_error",
        typeof errMsg.message === "string"
          ? errMsg.message
          : "builder stream error",
      ].join(": ");
      // Fail any duplex waiters correlated to this capture — don't opaque-timeout.
      for (let i = followUpWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = followUpWaiters[i];
        if (waiter === undefined) continue;
        if (parentId !== null && waiter.parentCaptureId !== parentId) continue;
        clearTimeout(waiter.timer);
        followUpWaiters.splice(i, 1);
        waiter.reject(
          new RequestCaptureError(
            "aborted",
            `builder stream error during duplex: ${detail}`,
          ),
        );
      }
      return;
    }
    const msg = parsed as TCursorCaptureIpcCaptureMessage;
    if (msg.token !== token) {
      socket.write(
        `${JSON.stringify({
          type: "settle",
          id: msg.id,
          settlement: { kind: "failed", reason: "unauthorized ipc token" },
        })}\n`,
      );
      return;
    }
    if (msg.type === "capture_followup") {
      const envelope = toCapturedEnvelope(msg);
      notifyFollowUp(envelope);
      socket.write(
        `${JSON.stringify({
          type: "settle",
          id: msg.id,
          settlement: {
            kind: "suppressed",
            reason: "follow-up frame buffered for duplex forward",
          },
        })}\n`,
      );
      return;
    }
    const classified = classifyCursorOutboundRequest({
      url: msg.observedUrl,
      headers: msg.headers.map(([n, v]) => [n, v] as const),
    });
    if (
      classified.kind === "bidi_append_companion" ||
      msg.type === "capture_companion"
    ) {
      // Buffer the exact companion envelope for the transaction adapter, then
      // ack the child with a control-only unary success so the vendor append
      // loop keeps constructing AgentClientMessage bytes. Never replace the
      // primary AgentService envelope in the shared capture session.
      const envelope = toCapturedEnvelope(msg);
      const decoded = decodeCapturedBidiAppendBody(envelope.body);
      companions.push({
        envelope,
        requestId: decoded.requestId,
        appendSeqno: decoded.appendSeqno,
      });
      notifyCompanions();
      socket.write(
        `${JSON.stringify({
          type: "settle",
          id: msg.id,
          companionAck: true,
          settlement: {
            kind: "suppressed",
            reason:
              "bidi_append companion buffered; control-only unary ack; daemon owns exact RPC replay",
          },
        })}\n`,
      );
      return;
    }
    if (classified.kind !== "agent_service_inference") {
      const reason =
        classified.kind === "non_inference"
          ? classified.reason
          : "rejected non-inference capture";
      socket.write(
        `${JSON.stringify({
          type: "settle",
          id: msg.id,
          settlement: {
            kind: "failed",
            reason: `rejected non-inference capture: ${reason}`,
          },
        })}\n`,
      );
      return;
    }

    lastCaptureId = msg.id;
    childSettle = (settlement) => {
      try {
        socket.write(
          `${JSON.stringify({
            type: "settle",
            id: msg.id,
            settlement,
          })}\n`,
        );
      } catch {
        // child gone
      }
    };

    try {
      // Offer to the shared session — this suppresses "daemon send" ownership
      // transfer; the child's await resolves only when settleChild runs (or
      // session terminal settles the builder).
      const settlement = await session.captureSend(toCapturedEnvelope(msg));
      childSettle?.(settlement);
    } catch (err) {
      const reason =
        err instanceof RequestCaptureError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      childSettle?.({ kind: "failed", reason });
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const childEnv = buildCursorCaptureChildEnv({
    preloadPath,
    socketPath,
    token,
    externalOrigin: args.externalOrigin,
  });

  const assembleTransaction = (
    primary: TCapturedRequestEnvelope,
  ): TCursorCaptureTransaction => {
    let path = "";
    try {
      const u = new URL(primary.observedUrl);
      path = `${u.pathname}${u.search}`;
    } catch {
      path = primary.observedUrl;
    }
    const method = cursorAgentServiceMethodOfPath(path);
    const logicalTransactionId =
      method === "RunSSE"
        ? requestIdFromCapturedRunSseBody(primary.body)
        : typeof primary.framing?.entries.logicalTransactionId === "string"
          ? primary.framing.entries.logicalTransactionId
          : null;

    const matched =
      logicalTransactionId === null
        ? [...companions]
        : companions.filter(
            (c) => c.requestId === null || c.requestId === logicalTransactionId,
          );
    matched.sort((a, b) => {
      const as = a.appendSeqno ?? Number.MAX_SAFE_INTEGER;
      const bs = b.appendSeqno ?? Number.MAX_SAFE_INTEGER;
      return as - bs;
    });
    return {
      logicalTransactionId,
      primary,
      companions: matched,
      method,
    };
  };

  const waitForTransaction = async (opts?: {
    readonly quietMs?: number;
    readonly maxWaitMs?: number;
  }): Promise<TCursorCaptureTransaction> => {
    const quietMs = opts?.quietMs ?? 50;
    const maxWaitMs = opts?.maxWaitMs ?? 5_000;
    const primary = await session.takeCaptured();
    let path = "";
    try {
      const u = new URL(primary.observedUrl);
      path = `${u.pathname}${u.search}`;
    } catch {
      path = primary.observedUrl;
    }
    const method = cursorAgentServiceMethodOfPath(path);
    // HTTP/2 Run / RunPoll carry application bytes on the primary envelope —
    // no companion wait required.
    if (method !== "RunSSE") {
      return assembleTransaction(primary);
    }

    const deadline = Date.now() + maxWaitMs;
    let lastCount = companions.length;
    let quietSince = Date.now();
    for (;;) {
      if (Date.now() >= deadline) {
        return assembleTransaction(primary);
      }
      if (companions.length !== lastCount) {
        lastCount = companions.length;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs && lastCount >= 0) {
        // Quiet window elapsed after primary is known. Zero companions is a
        // valid (rare) RunSSE that never appended — still return.
        return assembleTransaction(primary);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            companionsChanged = null;
            resolve();
          },
          Math.min(quietMs, 25),
        );
        companionsChanged = () => {
          clearTimeout(timer);
          companionsChanged = null;
          resolve();
        };
      });
    }
  };

  return {
    session,
    childEnv,
    preloadPath,
    socketPath,
    settleChild(settlement) {
      // Unblocks captureSend (handleLine) and the child's offer waiter. For
      // duplex_bridge the child keeps its stream open; daemon still owns
      // upstream inference output.
      session.settleBuilder(settlement);
      if (childSettle !== null) {
        childSettle(settlement);
        return;
      }
      if (lastCaptureId !== null && activeSocket !== null) {
        try {
          activeSocket.write(
            `${JSON.stringify({
              type: "settle",
              id: lastCaptureId,
              settlement,
            })}\n`,
          );
        } catch {
          // ignore
        }
      }
    },
    waitForOffer: () => session.takeCaptured(),
    waitForTransaction,
    companions: () => companions.slice(),
    lastCaptureId: () => lastCaptureId,
    injectServerFrames(captureId, body) {
      if (activeSocket === null) {
        throw new RequestCaptureError(
          "not_captured",
          "no active capture IPC socket for inject",
        );
      }
      activeSocket.write(
        `${JSON.stringify({
          type: "inject",
          id: captureId,
          bodyBase64: Buffer.from(body).toString("base64"),
        })}\n`,
      );
    },
    closeDuplexInject(captureId) {
      if (activeSocket === null) return;
      try {
        activeSocket.write(
          `${JSON.stringify({ type: "duplex_close", id: captureId })}\n`,
        );
      } catch {
        // ignore
      }
    },
    waitForFollowUp(args) {
      // Consume (dequeue) the next matching follow-up so heartbeats can be
      // skipped and the next frame waited on — do not sticky-return the first.
      const existingIdx = followUps.findIndex(
        (e) => e.framing?.entries.parentCaptureId === args.parentCaptureId,
      );
      if (existingIdx >= 0) {
        const [existing] = followUps.splice(existingIdx, 1);
        if (existing !== undefined) return Promise.resolve(existing);
      }
      const timeoutMs = args.timeoutMs ?? 10_000;
      return new Promise<TCapturedRequestEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = followUpWaiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) followUpWaiters.splice(idx, 1);
          reject(
            new RequestCaptureError(
              "timeout",
              `timed out waiting for duplex follow-up to ${args.parentCaptureId}`,
            ),
          );
        }, timeoutMs);
        followUpWaiters.push({
          parentCaptureId: args.parentCaptureId,
          resolve,
          reject,
          timer,
        });
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      companionsChanged = null;
      for (const waiter of followUpWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new RequestCaptureError("disposed", "capture bridge disposed"),
        );
      }
      session.dispose();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
};

/**
 * Map a builder settlement onto ACP cancel. Prefer `session/cancel` + await
 * terminal; process kill is cleanup only — not proof of graceful reuse.
 */
export const settleCursorCaptureViaAcpCancel = (args: {
  readonly cancelSession: () => void;
  readonly settlement: TBuilderSettlement;
}): void => {
  // Settlement kind does not invent assistant history — cancel is always the
  // local terminal for a suppressed inference send.
  void args.settlement;
  args.cancelSession();
};

// ── Coordinated RunSSE + BidiAppend transaction dispatch ───────────────────

export type TCursorTransactionSender = (
  request: Request,
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
) => Promise<Response>;

/** True when the capture framing identifies a Node HTTP/2 Connect send. */
export const isCursorHttp2Envelope = (
  envelope: TCapturedRequestEnvelope,
): boolean => {
  const entries = envelope.framing?.entries;
  if (entries === undefined) return false;
  if (entries.wire === "http2") return true;
  return entries.httpVersion === "2" || entries.httpVersion === 2;
};

const framingString = (
  entries: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
): string | null => {
  const value = entries[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Opaque read of `signal.aborted` via a function call — a direct
 * `signal?.aborted === true` comparison repeated later in the same function
 * gets incorrectly narrowed by TS's control-flow analysis to a literal
 * `false` after an earlier identical check throws, even though the mutable
 * DOM property can flip to `true` between statements. Wrapping the read in a
 * function call is the standard way to defeat that stale narrowing.
 */
const isAbortSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/**
 * Dispatch one captured Cursor envelope with the protocol it was captured on.
 * HTTP/2 → `node:http2` (pseudoheaders from framing + exact application
 * headers/body). HTTP/1 / fetch-wire → `fetch(Request)`. Never rewrites the
 * vendor URL onto HTTP/1 when framing says H2.
 */
export const sendCursorCapturedEnvelope = async (
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
): Promise<Response> => {
  if (isCursorHttp2Envelope(envelope)) {
    return sendCursorCapturedHttp2(envelope, signal);
  }
  const request = requestFromCapturedEnvelope(envelope);
  return fetch(request, { signal });
};

/**
 * Production/default transaction sender — routes by capture framing.
 * Injected test senders may still override; this is what live capture uses.
 */
export const defaultCursorCaptureSender: TCursorTransactionSender = async (
  _request,
  envelope,
  signal,
): Promise<Response> => sendCursorCapturedEnvelope(envelope, signal);

export type TCursorHttp2DispatchSession = {
  readonly response: Response;
  /** Write exact captured client follow-up frames on the same stream. */
  writeClientFollowUp(body: Uint8Array): void;
  endClient(): void;
  close(): void;
};

/**
 * Open a captured HTTP/2 Connect request via `node:http2` and keep the stream
 * available for allowlisted duplex follow-ups (`request_context_result`).
 */
export const openCursorCapturedHttp2Session = (
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
): Promise<TCursorHttp2DispatchSession> => {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError"),
    );
  }

  let url: URL;
  try {
    url = new URL(envelope.externalUrl);
  } catch {
    return Promise.reject(
      new RequestCaptureError(
        "invalid_destination",
        `invalid externalUrl for HTTP/2 dispatch: ${envelope.externalUrl}`,
      ),
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(
      new RequestCaptureError(
        "invalid_destination",
        `unsupported HTTP/2 protocol ${url.protocol}`,
      ),
    );
  }

  const entries = envelope.framing?.entries ?? {};
  const method = (
    framingString(entries, "method") ?? envelope.method
  ).toUpperCase();
  const scheme =
    framingString(entries, "scheme") ?? url.protocol.replace(/:$/, "");
  const authority = framingString(entries, "authority") ?? url.host;
  const path = framingString(entries, "path") ?? `${url.pathname}${url.search}`;
  const leaveOpen = entries.writableEnded === false;

  const headerMap: Record<string, string | string[]> = {
    ":method": method,
    ":scheme": scheme,
    ":authority": authority,
    ":path": path.startsWith("/") ? path : `/${path}`,
  };
  for (const [name, value] of envelope.headers) {
    if (isHttpPseudoHeaderName(name)) continue;
    if (name.toLowerCase() === "host") continue;
    const existing = headerMap[name];
    if (existing === undefined) {
      headerMap[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headerMap[name] = [existing, value];
    }
  }

  return new Promise<TCursorHttp2DispatchSession>((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | null = null;
    let stream: http2.ClientHttp2Stream | null = null;
    let closed = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", onAbort);
      try {
        stream?.destroy();
      } catch {
        // ignore
      }
      try {
        session?.close();
      } catch {
        // ignore
      }
      try {
        session?.destroy();
      } catch {
        // ignore
      }
    };

    // Torn down independent of whether we've already resolved — a caller
    // abort AFTER the response headers arrive (e.g. while the duplex context
    // handshake or model stream is still pending) must still close the real
    // H2 stream/session and end the consumer's reader promptly. Previously
    // this listener was removed at resolve time, so a post-resolve abort left
    // `reader.read()` hanging forever with no rejection/close — observed as a
    // caller-side hard timeout with no structured decline.
    const onAbort = (): void => {
      if (!settled) {
        fail(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
        return;
      }
      cleanup();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      session = http2.connect(url.origin);
    } catch (err) {
      fail(err);
      return;
    }
    session.on("error", fail);

    const body =
      method === "GET" || method === "HEAD" || envelope.body === null
        ? null
        : Buffer.from(envelope.body);
    try {
      stream = session.request(headerMap, {
        endStream: method === "GET" || method === "HEAD",
      });
    } catch (err) {
      fail(err);
      return;
    }
    stream.on("error", fail);

    if (body !== null && body.byteLength > 0) {
      stream.write(body);
    }
    if (leaveOpen !== true && method !== "GET" && method !== "HEAD") {
      stream.end();
    }

    stream.on("response", (headers) => {
      if (settled) return;
      const statusRaw = headers[http2.constants.HTTP2_HEADER_STATUS];
      const status =
        typeof statusRaw === "string"
          ? Number.parseInt(statusRaw, 10)
          : typeof statusRaw === "number"
            ? statusRaw
            : 200;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(headers)) {
        if (isHttpPseudoHeaderName(name)) continue;
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, String(item));
        } else {
          responseHeaders.append(name, String(value));
        }
      }

      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      let writerClosed = false;
      const closeWriter = (): void => {
        if (writerClosed) return;
        writerClosed = true;
        void writer.close().catch(() => undefined);
      };

      stream?.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        void writer.write(new Uint8Array(bytes)).catch(() => undefined);
      });
      stream?.on("trailers", (trailers) => {
        for (const [name, value] of Object.entries(trailers)) {
          if (isHttpPseudoHeaderName(name) || value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(name, String(item));
            }
          } else {
            responseHeaders.append(name, String(value));
          }
        }
      });
      stream?.on("end", () => {
        closeWriter();
      });
      stream?.on("close", () => {
        closeWriter();
      });

      const activeStream = stream;
      settled = true;
      // Do NOT remove the abort listener here — it must keep tearing the
      // session down (via `cleanup()`, now handled in `onAbort`) if the
      // caller aborts after the response headers already arrived.
      resolve({
        response: new Response(readable, {
          status: Number.isFinite(status) ? status : 200,
          headers: responseHeaders,
        }),
        writeClientFollowUp(followUpBody) {
          if (activeStream === null || activeStream.destroyed) {
            throw new RequestCaptureError(
              "disposed",
              "HTTP/2 stream closed; cannot write follow-up",
            );
          }
          activeStream.write(Buffer.from(followUpBody));
        },
        endClient() {
          try {
            activeStream?.end();
          } catch {
            // ignore
          }
        },
        close: cleanup,
      });
    });
  });
};

/** Convenience: open H2 session and return only the Response (no follow-ups). */
export const sendCursorCapturedHttp2 = async (
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
): Promise<Response> => {
  const session = await openCursorCapturedHttp2Session(envelope, signal);
  // When the response body completes, close the session.
  const body = session.response.body;
  if (body === null) {
    session.close();
    return session.response;
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const reader = body.getReader();
    const writer = writable.getWriter();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        // ignore
      }
    } finally {
      session.close();
    }
  })();
  return new Response(readable, {
    status: session.response.status,
    statusText: session.response.statusText,
    headers: session.response.headers,
  });
};

export type TCursorTransactionDispatchResult = {
  readonly response: Response;
  readonly transaction: TCursorCaptureTransaction;
  readonly outcome: TCaptureTerminalOutcome;
  /** True once any upstream RPC was accepted — no second send of the set. */
  readonly noSecondSend: true;
  readonly companionResponses: ReadonlyArray<{
    readonly envelope: TCapturedRequestEnvelope;
    readonly status: number;
  }>;
};

export type TCursorTransactionDecodeResult = {
  readonly chunks: ReadonlyArray<TChatCompletionChunk>;
  readonly blocked: TCursorDecodeBlock | null;
  readonly stream: ReadableStream<TChatCompletionChunk>;
};

/**
 * Dispatch a collected Cursor capture transaction exactly once:
 *   1. settle the builder locally (suppress original egress),
 *   2. open the primary AgentService RPC,
 *   3. replay every buffered BidiAppend companion with its exact URL / headers /
 *      body (seqno order; up to 16 in flight, matching the vendor client),
 *   4. return the primary response body to the daemon caller — never to the
 *      vendor child.
 *
 * On failure after any upstream accept, the terminal is `uncertain_accept` /
 * `failed` with `daemon_upstream` usage and callers must not retry the set.
 */
export const runCursorCapturedTransaction = async (args: {
  readonly session: TRequestCaptureSession;
  readonly transaction: TCursorCaptureTransaction;
  readonly sender: TCursorTransactionSender;
  readonly signal?: AbortSignal;
  readonly suppressReason?: string;
  /** Max concurrent companion RPCs (vendor default is 16). */
  readonly companionConcurrency?: number;
}): Promise<TCursorTransactionDispatchResult> => {
  const { session, transaction, sender } = args;
  const captured = session.captured();
  if (captured === null) {
    // Allow callers that assembled the transaction via waitForTransaction
    // (which already called takeCaptured) — the envelope must match.
    throw new RequestCaptureError(
      "not_captured",
      "runCursorCapturedTransaction requires a captured primary envelope",
    );
  }

  session.markDispatchStarted();
  session.settleBuilder({
    kind: "suppressed",
    reason:
      args.suppressReason ??
      "original AgentService + BidiAppend sends suppressed; daemon owns the transaction",
  });

  const dispatchSignal =
    args.signal === undefined
      ? session.signal
      : AbortSignal.any([session.signal, args.signal]);

  const companionConcurrency = Math.max(
    1,
    Math.min(args.companionConcurrency ?? 16, 16),
  );
  const companionResponses: Array<{
    readonly envelope: TCapturedRequestEnvelope;
    readonly status: number;
  }> = [];

  let primaryAccepted = false;
  try {
    const primaryRequest = requestFromCapturedEnvelope(transaction.primary);
    const primaryPromise = sender(
      primaryRequest,
      transaction.primary,
      dispatchSignal,
    ).then((response) => {
      primaryAccepted = true;
      session.markUpstreamAccepted();
      return response;
    });
    // CodeRabbit round 2: `primaryPromise` isn't awaited until AFTER the
    // companion loop below. If it rejects while that loop is still running,
    // it would be a rejected promise with no attached handler at that point
    // in time — flagged as an unhandled rejection by Node/Bun even though
    // the code intends to observe it later. Attach a no-op catch on a
    // SEPARATE consumer immediately so the promise is marked handled; this
    // does not swallow the rejection for the real awaiter — `await
    // primaryPromise` further down still receives the original error
    // unchanged, since a `.catch` creates a new derived promise rather than
    // mutating `primaryPromise` itself.
    primaryPromise.catch(() => undefined);

    // Vendor order: open RunSSE, then append while the stream is live.
    // Cap in-flight companions at companionConcurrency (vendor default 16).
    const companions = [...transaction.companions];
    for (
      let batchStart = 0;
      batchStart < companions.length;
      batchStart += companionConcurrency
    ) {
      const batch = companions.slice(
        batchStart,
        batchStart + companionConcurrency,
      );
      await Promise.all(
        batch.map(async (companion) => {
          const request = requestFromCapturedEnvelope(companion.envelope);
          const response = await sender(
            request,
            companion.envelope,
            dispatchSignal,
          );
          companionResponses.push({
            envelope: companion.envelope,
            status: response.status,
          });
          // Drain / drop companion body — BidiAppendResponse is empty; never
          // feed into the inference decode path.
          try {
            await response.arrayBuffer();
          } catch {
            // ignore drain errors; status already recorded
          }
        }),
      );
    }

    const response = await primaryPromise;
    const outcome: TCaptureTerminalOutcome = {
      kind: "dispatched",
      usage: { kind: "daemon_upstream" },
    };
    session.complete(outcome);
    return {
      response,
      transaction,
      outcome,
      noSecondSend: true,
      companionResponses,
    };
  } catch (err) {
    if (session.upstreamAccepted() || primaryAccepted) {
      session.complete({
        kind: "failed",
        reason: err instanceof Error ? err.message : String(err),
        usage: { kind: "daemon_upstream" },
      });
    } else if (session.dispatchStarted()) {
      session.failUncertain(err instanceof Error ? err.message : String(err));
    } else {
      session.complete({
        kind: "failed",
        reason: err instanceof Error ? err.message : String(err),
        usage: { kind: "none" },
      });
    }
    throw err;
  }
};

/**
 * Decode a dispatched Cursor transaction's primary response into canonical
 * chunks. Duplex / native-tool blocks return partial chunks + `blocked` so
 * the integrator can emit any already-seen caller tool intents and cancel —
 * never fabricate exec success or invent finish_reason for the blocked turn.
 */
/**
 * Prefer streaming decode for production. The tolerant buffered path remains
 * for hermetic block-boundary tests that need `blocked` + partial chunks.
 */
export const decodeCursorTransactionResponse = async (args: {
  readonly response: Response;
  readonly providerModelId: string;
  readonly signal?: AbortSignal;
  /**
   * When true, buffer the body and use the tolerant decoder (partial chunks +
   * explicit block). Default false — stream envelopes as they arrive.
   */
  readonly tolerantBuffered?: boolean;
}): Promise<TCursorTransactionDecodeResult> => {
  if (args.response.body === null) {
    return {
      chunks: [],
      blocked: null,
      stream: new ReadableStream<TChatCompletionChunk>({
        start(controller) {
          controller.close();
        },
      }),
    };
  }
  const connectContentEncoding = args.response.headers.get(
    "connect-content-encoding",
  );
  if (args.tolerantBuffered === true) {
    const buf = new Uint8Array(await args.response.arrayBuffer());
    const decoded = chunksFromCursorConnectResponseBytesTolerant(buf, {
      providerModelId: args.providerModelId,
      connectContentEncoding,
    });
    const stream = new ReadableStream<TChatCompletionChunk>({
      start(controller) {
        try {
          for (const chunk of decoded.chunks) controller.enqueue(chunk);
          controller.close();
        } catch (err) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
      cancel() {},
    });
    return { chunks: decoded.chunks, blocked: decoded.blocked, stream };
  }
  const stream = chunksStreamFromCursorConnectResponseBody(args.response.body, {
    providerModelId: args.providerModelId,
    signal: args.signal,
    connectContentEncoding,
  });
  return { chunks: [], blocked: null, stream };
};

/**
 * Allowlisted pre-inference duplex: when upstream sends
 * `exec_server_message.request_context_args`, inject that Connect frame into
 * the live builder, wait for its native `request_context_result` follow-up,
 * and write those exact bytes upstream. Does not fabricate context or feed
 * model output to the builder. Rejects any non-allowlisted follow-up.
 */
const MAX_KV_CONTROL_FOLLOW_UPS = 32;

/**
 * Relay one real `KvServerMessage.get_blob_args` / `.set_blob_args` envelope
 * into the still-live native builder and forward its matching real
 * `KvClientMessage` reply upstream unchanged. The builder's ControlledKvManager
 * owns actual blob-store semantics; the daemon never reads blob ids/data or
 * fabricates cache misses/write acknowledgements. Genuine client heartbeats
 * emitted while waiting are forwarded 1:1 as their original Connect envelopes
 * — never replayed or scheduled by the daemon.
 */
export const forwardCursorKvControlThroughBuilder = async (args: {
  readonly captureBridge: TCursorCaptureBridge;
  readonly captureId: string;
  readonly http2: TCursorHttp2DispatchSession;
  readonly serverKvEnvelope: Uint8Array;
  readonly connectContentEncoding?: string | null;
  readonly followUpTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Numeric ids of EARLIER exec exchanges (request_context and/or
   * mcp_state_exec) already forwarded in this capture. The native
   * generic-exec loop writes an `ExecClientControlMessage.stream_close`
   * unconditionally after EVERY exec result, so one for any earlier
   * completed exchange can still be queued on the IPC channel and only
   * surface here, during a later KV wait. Each distinct id is relayed
   * EXACTLY ONCE — a DIFFERENT known id is a separate, legitimate signal
   * (e.g. a batch of several completed exchanges), never conflated with
   * "already forwarded". KV ids are a completely separate id namespace and
   * must never be used for this match. `undefined`/`null`/empty means no
   * known completed exchange, so any stream_close observed here is
   * unattributable and still rejected — this is never relaxed to "most
   * recent id only", which would incorrectly reject a still-valid stream_close
   * for an OLDER completed exchange once a newer one has also completed.
   */
  readonly knownControlExecNumericIds?: ReadonlySet<number> | null;
}): Promise<{ readonly forwardedFollowUps: number }> => {
  if (isAbortSignalAborted(args.signal)) {
    throw new RequestCaptureError("aborted", "client aborted before KV inject");
  }
  const { envelopes, rest } = takeConnectEnvelopes(args.serverKvEnvelope);
  if (rest.byteLength > 0 || envelopes.length !== 1) {
    throw new CursorCaptureDecodeError(
      "truncated_connect_frame",
      "KV inject requires exactly one complete Connect envelope",
    );
  }
  const [serverEnvelope] = envelopes;
  if (serverEnvelope === undefined || serverEnvelope.endStream) {
    throw new CursorCaptureDecodeError(
      "invalid_protobuf",
      "KV inject rejects missing/end-stream control frames",
    );
  }
  const serverPayload = resolveConnectEnvelopePayload(
    serverEnvelope,
    args.connectContentEncoding,
  );
  const serverDecoded = decodeAgentServerMessage(serverPayload);
  // `id` is a proto3 implicit-presence uint32 — 0 is a real, valid id (live
  // retest #34), never treated as "missing". Only subtype/kind gate this.
  if (
    serverDecoded.kind !== "kv_server" ||
    (serverDecoded.subtype !== "get_blob" &&
      serverDecoded.subtype !== "set_blob")
  ) {
    throw new CursorCaptureDecodeError(
      "unsupported_native_kv",
      `refusing unsupported KV server control subtype=${serverDecoded.kind === "kv_server" ? serverDecoded.subtype : "not_kv"} id=${serverDecoded.kind === "kv_server" ? serverDecoded.id : "null"}`,
    );
  }
  const expectedId = serverDecoded.id;
  const expectedReplyCase =
    serverDecoded.subtype === "get_blob"
      ? "get_blob_result"
      : "set_blob_result";

  // Preserve compressed/uncompressed envelope bytes exactly for the native
  // builder: inspect only a decompressed COPY above.
  args.captureBridge.injectServerFrames(args.captureId, args.serverKvEnvelope);

  const deadline =
    Date.now() + Math.max(1_000, args.followUpTimeoutMs ?? 10_000);
  let forwardedFollowUps = 0;
  let observedFollowUps = 0;
  // Each DISTINCT known-completed-exchange id gets its queued stream_close
  // relayed exactly once — tracked per id, never a single boolean (which
  // would incorrectly reject a second, legitimately different known id in a
  // batch scenario).
  const forwardedControlStreamCloseIds = new Set<number>();
  let aborted = isAbortSignalAborted(args.signal);
  const onAbort = (): void => {
    aborted = true;
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!aborted && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const followUpPromise = args.captureBridge.waitForFollowUp({
        parentCaptureId: args.captureId,
        timeoutMs: remaining,
      });
      // A per-iteration abort listener is tracked locally and removed in a
      // `finally` below, regardless of which side of the race wins — no
      // listener may outlive the iteration that registered it.
      let onIterationAbort: (() => void) | null = null;
      const abortPromise =
        args.signal === undefined
          ? null
          : new Promise<"aborted">((resolve) => {
              const abortSignal: AbortSignal = args.signal as AbortSignal;
              if (abortSignal.aborted) {
                resolve("aborted");
                return;
              }
              onIterationAbort = () => resolve("aborted");
              abortSignal.addEventListener("abort", onIterationAbort, {
                once: true,
              });
            });
      let followUp: Awaited<typeof followUpPromise> | "aborted";
      try {
        followUp =
          abortPromise === null
            ? await followUpPromise
            : await Promise.race([followUpPromise, abortPromise]);
      } finally {
        if (onIterationAbort !== null) {
          args.signal?.removeEventListener("abort", onIterationAbort);
        }
      }
      if (followUp === "aborted") {
        throw new RequestCaptureError(
          "aborted",
          "client aborted while waiting for KV control reply",
        );
      }
      if (followUp.body === null || followUp.body.byteLength === 0) continue;
      const taken = takeConnectEnvelopes(followUp.body);
      if (taken.rest.byteLength > 0 || taken.envelopes.length === 0) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          "builder KV follow-up is not complete Connect envelope(s)",
        );
      }
      // The ENTIRE batch is validated before anything is written upstream:
      // `orderedForwardBytes` buffers every forwardable envelope (e.g. a
      // queued stream_close trailing the KV reply in one native write) in
      // original position, so nothing is dropped by an early return and a
      // forbidden envelope later in the batch aborts with zero partial
      // forwards.
      const orderedForwardBytes: Uint8Array[] = [];
      let acceptedResultBytes: Uint8Array | null = null;
      for (const env of taken.envelopes) {
        observedFollowUps += 1;
        if (observedFollowUps > MAX_KV_CONTROL_FOLLOW_UPS) {
          throw new CursorCaptureDecodeError(
            "unsupported_native_kv",
            `KV control follow-up limit exceeded (${MAX_KV_CONTROL_FOLLOW_UPS})`,
          );
        }
        if (env.endStream) {
          throw new CursorCaptureDecodeError(
            "unsupported_native_kv",
            "builder sent end-stream while KV control reply was required",
          );
        }
        const inspectPayload = resolveConnectEnvelopePayload(
          env,
          args.connectContentEncoding,
        );
        const classification = classifyAgentClientFollowUp(inspectPayload, {
          flags: env.flags,
          payloadBytes: env.payload.byteLength,
        });
        if (
          classification.kind === "benign_control" &&
          classification.agentClientCase === "client_heartbeat"
        ) {
          // The native builder emitted this exact keepalive while its own KV
          // manager was working. Buffer that exact envelope in original
          // position; never manufacture or replay keepalives ourselves.
          orderedForwardBytes.push(
            encodeConnectEnvelope(env.payload, env.flags),
          );
          continue;
        }
        if (classification.kind === "exec_stream_close") {
          // Live retest #35: the native generic-exec loop writes
          // `ExecClientControlMessage.stream_close` unconditionally after
          // EVERY exec result — including an earlier request_context_args/
          // mcp_state_exec_args exchange — so it can still be queued on the
          // IPC channel and only surface here, mid-KV-wait. Narrow, verified
          // relay: forward it UNCHANGED, and ONLY when its id is a member of
          // the KNOWN set of already-completed control exchanges. KV and
          // exec numeric ids are DIFFERENT namespaces — this is a hard
          // invariant, never relaxed: a stream_close is NEVER accepted
          // merely because it numerically equals `expectedId` (the KV
          // request's own id); it must be a member of
          // `knownControlExecNumericIds`, full stop. Also never a
          // generic/blanket exec-control approval, and never rejected
          // merely because a DIFFERENT known id was already forwarded (each
          // distinct id is tracked, and relayed, independently — this is
          // what a batch of several completed exchanges legitimately looks
          // like).
          const id = classification.execNumericId;
          if (
            id === null ||
            args.knownControlExecNumericIds === undefined ||
            args.knownControlExecNumericIds === null ||
            !args.knownControlExecNumericIds.has(id) ||
            forwardedControlStreamCloseIds.has(id)
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_kv",
              `unattributed stream_close during KV control (already_forwarded_ids=[${[...forwardedControlStreamCloseIds].join(",")}] actual_id=${id ?? "null"})`,
            );
          }
          orderedForwardBytes.push(
            encodeConnectEnvelope(env.payload, env.flags),
          );
          forwardedControlStreamCloseIds.add(id);
          continue;
        }
        if (classification.kind !== "kv_client_result") {
          throw new CursorCaptureDecodeError(
            "unsupported_native_kv",
            `unexpected builder follow-up during KV control (${classification.diagnostic})`,
          );
        }
        if (classification.execNumericId !== expectedId) {
          throw new CursorCaptureDecodeError(
            "unsupported_native_kv",
            `KV reply id mismatch expected=${expectedId} actual=${classification.execNumericId ?? "null"} case=${classification.execClientCase ?? "null"}`,
          );
        }
        if (classification.execClientCase !== expectedReplyCase) {
          throw new CursorCaptureDecodeError(
            "unsupported_native_kv",
            `KV reply case mismatch expected=${expectedReplyCase} actual=${classification.execClientCase ?? "null"} id=${expectedId}`,
          );
        }
        const resultBytes = encodeConnectEnvelope(env.payload, env.flags);
        acceptedResultBytes = resultBytes;
        orderedForwardBytes.push(resultBytes);
      }
      // The whole batch validated cleanly — flush every buffered envelope
      // now, in its original order.
      for (const part of orderedForwardBytes) {
        args.http2.writeClientFollowUp(part);
        forwardedFollowUps += 1;
      }
      if (acceptedResultBytes !== null) {
        return { forwardedFollowUps };
      }
      // Only benign/close frames in this IPC message — keep waiting.
    }
    if (aborted) {
      throw new RequestCaptureError(
        "aborted",
        "client aborted while waiting for KV control reply",
      );
    }
    throw new CursorCaptureDecodeError(
      "requires_kv_control_duplex",
      `timed out waiting for KV control reply id=${expectedId} case=${expectedReplyCase}`,
    );
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
};

export const forwardCursorRequestContextThroughBuilder = async (args: {
  readonly captureBridge: TCursorCaptureBridge;
  readonly captureId: string;
  readonly http2: TCursorHttp2DispatchSession;
  readonly serverExecEnvelope: Uint8Array;
  readonly followUpTimeoutMs?: number;
  /** Present when the server frame may be gzip-compressed (inspection only). */
  readonly connectContentEncoding?: string | null;
  /** Caller abort — must stop waiting for a follow-up promptly, not just at the deadline. */
  readonly signal?: AbortSignal;
  /**
   * Numeric ids of EARLIER request_context and/or mcp_state_exec exchanges
   * already forwarded in this capture. The generic-exec loop can leave a
   * stream_close for any such exchange queued on the IPC channel until this
   * later request_context wait. Each known id is relayed exactly once; an
   * unknown/null/duplicate id remains fail-closed. This set is intentionally
   * exec-only: KV uses a separate numeric id namespace.
   */
  readonly knownControlExecNumericIds?: ReadonlySet<number> | null;
}): Promise<{
  readonly forwardedFollowUp: Uint8Array;
  /**
   * The numeric id of THIS request_context_args/result exchange (proto3
   * implicit presence — 0 is a real id, never "unknown"). The native
   * generic-exec loop writes an `ExecClientControlMessage.stream_close`
   * unconditionally after every exec result, including this one; it is
   * commonly still queued on the IPC channel when this call returns and
   * only observed later (e.g. during a subsequent KV control wait). The
   * caller passes this id forward so that a later queued stream_close can
   * be verified against it before being relayed — never against an
   * unrelated id namespace (KV ids are a separate space).
   */
  readonly contextExecNumericId: number | null;
}> => {
  if (isAbortSignalAborted(args.signal)) {
    throw new RequestCaptureError(
      "aborted",
      "client aborted before request_context inject",
    );
  }
  // Validate the server frame is exactly request_context_args before inject.
  // Inspect a DECOMPRESSED COPY only — `args.serverExecEnvelope` (forwarded to
  // the builder byte-for-byte via injectServerFrames) is never mutated.
  const { envelopes, rest } = takeConnectEnvelopes(args.serverExecEnvelope);
  if (rest.byteLength > 0 || envelopes.length === 0) {
    throw new CursorCaptureDecodeError(
      "truncated_connect_frame",
      "request_context inject requires complete Connect envelope(s) only",
    );
  }
  for (const env of envelopes) {
    if (env.endStream) {
      throw new CursorCaptureDecodeError(
        "invalid_protobuf",
        "request_context inject rejects end-stream control frames",
      );
    }
    const inspectPayload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    const decoded = decodeAgentServerMessage(inspectPayload);
    if (
      decoded.kind !== "exec_server" ||
      decoded.subtype !== "request_context_args"
    ) {
      throw cursorExecServerFailure(
        decoded.kind === "exec_server"
          ? {
              id: decoded.id,
              execId: decoded.execId,
              subtype: decoded.subtype,
              classification: decoded.classification,
              mcp: decoded.mcp,
            }
          : {
              id: null,
              execId: null,
              subtype: "unknown_exec_server_message",
              classification: "unknown",
              mcp: null,
            },
      );
    }
  }

  // Expected correlation ids from the server request_context_args frame
  // (read from the decompressed inspection copy).
  let expectedExecId: string | null = null;
  let expectedNumericId: number | null = null;
  for (const env of envelopes) {
    const inspectPayload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    const decoded = decodeAgentServerMessage(inspectPayload);
    if (decoded.kind === "exec_server") {
      expectedExecId = decoded.execId;
      // Proto3-correct numeric id (0 is validly omitted on the wire) — used
      // both for request_context_result acceptance below AND to let the
      // caller later verify a queued stream_close against this exact
      // exchange, never a plain nullable `decoded.id`.
      expectedNumericId = execServerContextNumericId(inspectPayload);
    }
  }

  args.captureBridge.injectServerFrames(
    args.captureId,
    args.serverExecEnvelope,
  );

  const deadline =
    Date.now() + Math.max(1_000, args.followUpTimeoutMs ?? 10_000);
  const skipped: string[] = [];
  let lastClassification: TCursorFollowUpClassification | null = null;
  // Each DISTINCT known-completed-exchange id (or this exchange's own id,
  // once accepted) gets its queued stream_close relayed exactly once —
  // tracked per id, never a single boolean.
  const forwardedControlStreamCloseIds = new Set<number>();
  let aborted = isAbortSignalAborted(args.signal);
  const onAbort = (): void => {
    aborted = true;
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!aborted && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const followUpPromise = args.captureBridge.waitForFollowUp({
        parentCaptureId: args.captureId,
        timeoutMs: remaining,
      });
      // A per-iteration abort listener is tracked locally and removed in a
      // `finally` below, regardless of which side of the race wins — no
      // listener may outlive the iteration that registered it.
      let onIterationAbort: (() => void) | null = null;
      const abortPromise =
        args.signal === undefined
          ? null
          : new Promise<"aborted">((resolve) => {
              const abortSignal: AbortSignal = args.signal as AbortSignal;
              if (abortSignal.aborted) {
                resolve("aborted");
                return;
              }
              onIterationAbort = () => resolve("aborted");
              abortSignal.addEventListener("abort", onIterationAbort, {
                once: true,
              });
            });
      let followUp: Awaited<typeof followUpPromise> | "aborted";
      try {
        followUp =
          abortPromise === null
            ? await followUpPromise
            : await Promise.race([followUpPromise, abortPromise]);
      } finally {
        if (onIterationAbort !== null) {
          args.signal?.removeEventListener("abort", onIterationAbort);
        }
      }
      if (followUp === "aborted") {
        throw new RequestCaptureError(
          "aborted",
          `client aborted while waiting for request_context_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
        );
      }
      if (followUp.body === null || followUp.body.byteLength === 0) {
        skipped.push("empty_body");
        continue;
      }
      const followTaken = takeConnectEnvelopes(followUp.body);
      if (followTaken.envelopes.length === 0) {
        lastClassification = classifyAgentClientFollowUp(followUp.body, {
          payloadBytes: followUp.body.byteLength,
        });
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          `builder follow-up is not a complete Connect envelope (${lastClassification.diagnostic})`,
        );
      }
      // A single capture_followup IPC may carry one or more Connect envelopes
      // (e.g. heartbeat + result). Evaluate each; forward only when we see the
      // allowlisted result (possibly after skipping benign controls in-band).
      // Classification inspects a DECOMPRESSED COPY of the payload — the bytes
      // forwarded upstream (`forwardParts`) are always the original envelope
      // (compressed or not) unchanged, using the same negotiated
      // `connect-content-encoding` this duplex stream was opened with.
      // The whole batch is validated before anything is written upstream —
      // `orderedForwardBytes` buffers every forwardable envelope in
      // original position; a forbidden envelope later in the same batch
      // never lets an earlier benign one leak through first.
      const orderedForwardBytes: Uint8Array[] = [];
      const forwardParts: Uint8Array[] = [];
      let accepted: TCursorFollowUpClassification | null = null;
      for (const env of followTaken.envelopes) {
        if (env.endStream) {
          skipped.push(`end_stream_flags=${env.flags}`);
          continue;
        }
        let inspectPayload: Uint8Array;
        try {
          inspectPayload = resolveConnectEnvelopePayload(
            env,
            args.connectContentEncoding,
          );
        } catch (err) {
          throw err instanceof CursorCaptureDecodeError
            ? new CursorCaptureDecodeError(
                err.code,
                `builder follow-up ${err.message} (flags=${env.flags} bytes=${env.payload.byteLength})`,
              )
            : err;
        }
        const classification = classifyAgentClientFollowUp(inspectPayload, {
          flags: env.flags,
          payloadBytes: env.payload.byteLength,
        });
        lastClassification = classification;
        if (classification.kind === "exec_stream_close") {
          // The native generic-exec loop writes stream_close
          // unconditionally AFTER every exec result. A queued close is
          // accepted only when its id is either a member of
          // `knownControlExecNumericIds` (an earlier completed exec
          // exchange) or THIS exchange's own id — and for the own-id case,
          // only once this exchange's own result has already been
          // accepted earlier in this same batch's iteration order; a
          // self-id close observed before its own result is rejected.
          // Each distinct id is forwarded exactly once — a duplicate for
          // an already-forwarded id is rejected. KV numeric ids are a
          // separate namespace and are never a member of this set.
          const id = classification.execNumericId;
          const isKnownEarlierExchange =
            id !== null && args.knownControlExecNumericIds?.has(id) === true;
          const isOwnExchangeAfterAccepted =
            id !== null &&
            expectedNumericId !== null &&
            id === expectedNumericId &&
            accepted !== null;
          if (
            id === null ||
            forwardedControlStreamCloseIds.has(id) ||
            !(isKnownEarlierExchange || isOwnExchangeAfterAccepted)
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `unattributed stream_close during request_context control (expected_id=${expectedNumericId ?? "null"} already_forwarded_ids=[${[...forwardedControlStreamCloseIds].join(",")}] actual_id=${id ?? "null"})`,
            );
          }
          orderedForwardBytes.push(
            encodeConnectEnvelope(env.payload, env.flags),
          );
          forwardedControlStreamCloseIds.add(id);
          continue;
        }
        if (classification.kind === "benign_control") {
          skipped.push(classification.diagnostic);
          continue;
        }
        if (classification.kind === "request_context_result") {
          // Optional correlation: when both sides carry ids, they must match.
          if (
            expectedExecId !== null &&
            classification.execId !== null &&
            classification.execId !== expectedExecId
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `request_context_result exec_id mismatch (refusing to forward); ${classification.diagnostic}`,
              {
                execSubtype: "request_context_result_id_mismatch",
                execClass: "protocol_control",
              },
            );
          }
          if (
            expectedNumericId !== null &&
            classification.execNumericId !== null &&
            classification.execNumericId !== expectedNumericId
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `request_context_result id mismatch (refusing to forward); ${classification.diagnostic}`,
              {
                execSubtype: "request_context_result_id_mismatch",
                execClass: "protocol_control",
              },
            );
          }
          accepted = classification;
          const resultBytes = encodeConnectEnvelope(env.payload, env.flags);
          forwardParts.push(resultBytes);
          orderedForwardBytes.push(resultBytes);
          continue;
        }
        // Forbidden / unknown — fail closed with metadata-only diagnostics.
        // Nothing in `orderedForwardBytes` has been written yet.
        throw new CursorCaptureDecodeError(
          "unsupported_native_exec",
          `builder follow-up is not an allowlisted request_context_result; refusing to forward (${classification.diagnostic}; skipped=[${skipped.join("; ")}])`,
          {
            execSubtype:
              classification.execClientCase ?? classification.agentClientCase,
            execClass:
              classification.kind === "forbidden_native"
                ? "native_exec"
                : "unknown",
          },
        );
      }
      if (followTaken.rest.byteLength > 0) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          `builder follow-up has trailing ${followTaken.rest.byteLength} incomplete bytes (${lastClassification?.diagnostic ?? "no_class"})`,
        );
      }
      // The whole batch validated cleanly — flush every buffered envelope
      // now, in its original order.
      for (const part of orderedForwardBytes) {
        args.http2.writeClientFollowUp(part);
      }
      if (accepted !== null && forwardParts.length > 0) {
        const [soleForwardPart] = forwardParts;
        const forwarded =
          forwardParts.length === 1 && soleForwardPart !== undefined
            ? soleForwardPart
            : concatBytesLocal(forwardParts);
        return {
          forwardedFollowUp: forwarded,
          contextExecNumericId: expectedNumericId,
        };
      }
      // Only benign frames in this IPC message — keep waiting.
    }
    if (aborted) {
      throw new RequestCaptureError(
        "aborted",
        `client aborted while waiting for request_context_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
      );
    }

    throw new CursorCaptureDecodeError(
      "requires_request_context_duplex",
      `timed out waiting for request_context_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
      {
        execSubtype: "request_context_args",
        execClass: "protocol_control",
      },
    );
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Relay one real `AgentServerMessage.exec_server_message.mcp_state_exec_args`
 * envelope into the still-live native builder and forward its matching real
 * `ExecClientMessage.mcp_state_exec_result` reply upstream unchanged.
 *
 * Verified native schema (installed artifact 2026.07.23-e383d2b):
 * `McpStateExecArgs { server_identifiers: repeated string(1),
 * kick_only: bool(2) }` → `McpStateExecResult { success | error | rejected }`
 * (a `McpStateSuccess` lists the user's configured MCP servers, their tools,
 * and instructions). This is a real control-plane exchange — never a tool
 * call, never model output — so it is relayed exactly like
 * `request_context_args`/KV: the daemon injects the EXACT original server
 * bytes into the builder, waits for its own authoritative reply, and
 * forwards those exact bytes upstream. It never decodes or reports server
 * names / tool schemas / instructions anywhere (they may be sensitive user
 * configuration) and never fabricates a state reply of its own.
 */
const MAX_MCP_STATE_EXEC_FOLLOW_UPS = 32;
const MAX_MCP_STATE_EXEC_SKIPPED_DIAGNOSTICS = 16;

export const forwardCursorMcpStateExecThroughBuilder = async (args: {
  readonly captureBridge: TCursorCaptureBridge;
  readonly captureId: string;
  readonly http2: TCursorHttp2DispatchSession;
  readonly serverExecEnvelope: Uint8Array;
  readonly followUpTimeoutMs?: number;
  /** Present when the server frame may be gzip-compressed (inspection only). */
  readonly connectContentEncoding?: string | null;
  /** Caller abort — must stop waiting for a follow-up promptly, not just at the deadline. */
  readonly signal?: AbortSignal;
  /**
   * Numeric ids of EARLIER exec exchanges (request_context and/or
   * mcp_state_exec) already forwarded in this capture. The native
   * generic-exec loop writes an `ExecClientControlMessage.stream_close`
   * unconditionally after every exec result, so one for an earlier
   * exchange can still be queued on the IPC channel and only surface here,
   * during a later mcp_state_exec wait. Relayed exactly once, and ONLY
   * when its id is a member of this set — never against an unrelated id
   * namespace (KV ids are separate). `undefined`/`null`/empty means no
   * known completed exchange, so any stream_close observed here is
   * unattributable and still rejected.
   */
  readonly knownControlExecNumericIds?: ReadonlySet<number> | null;
}): Promise<{
  readonly forwardedFollowUp: Uint8Array;
  /** This exchange's own numeric id — feed into a later wait's
   * `knownControlExecNumericIds` so a queued stream_close for THIS
   * exchange can still be correlated and relayed if it arrives late. */
  readonly completedExecNumericId: number | null;
}> => {
  if (isAbortSignalAborted(args.signal)) {
    throw new RequestCaptureError(
      "aborted",
      "client aborted before mcp_state_exec inject",
    );
  }
  // Validate the server frame is exactly mcp_state_exec_args before inject.
  // Inspect a DECOMPRESSED COPY only — `args.serverExecEnvelope` (forwarded
  // to the builder byte-for-byte via injectServerFrames) is never mutated.
  const { envelopes, rest } = takeConnectEnvelopes(args.serverExecEnvelope);
  if (rest.byteLength > 0 || envelopes.length === 0) {
    throw new CursorCaptureDecodeError(
      "truncated_connect_frame",
      "mcp_state_exec inject requires complete Connect envelope(s) only",
    );
  }
  for (const env of envelopes) {
    if (env.endStream) {
      throw new CursorCaptureDecodeError(
        "invalid_protobuf",
        "mcp_state_exec inject rejects end-stream control frames",
      );
    }
    const inspectPayload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    const decoded = decodeAgentServerMessage(inspectPayload);
    if (
      decoded.kind !== "exec_server" ||
      decoded.subtype !== "mcp_state_exec_args"
    ) {
      throw cursorExecServerFailure(
        decoded.kind === "exec_server"
          ? {
              id: decoded.id,
              execId: decoded.execId,
              subtype: decoded.subtype,
              classification: decoded.classification,
              mcp: decoded.mcp,
            }
          : {
              id: null,
              execId: null,
              subtype: "unknown_exec_server_message",
              classification: "unknown",
              mcp: null,
            },
      );
    }
  }

  // Expected correlation ids from the server mcp_state_exec_args frame.
  let expectedExecId: string | null = null;
  let expectedNumericId: number | null = null;
  for (const env of envelopes) {
    const inspectPayload = resolveConnectEnvelopePayload(
      env,
      args.connectContentEncoding,
    );
    const decoded = decodeAgentServerMessage(inspectPayload);
    if (decoded.kind === "exec_server") {
      expectedExecId = decoded.execId;
      expectedNumericId = execServerContextNumericId(inspectPayload);
    }
  }

  args.captureBridge.injectServerFrames(
    args.captureId,
    args.serverExecEnvelope,
  );

  const deadline =
    Date.now() + Math.max(1_000, args.followUpTimeoutMs ?? 10_000);
  const skipped: string[] = [];
  let observedFollowUps = 0;
  // Each DISTINCT known-completed-exchange id gets its queued stream_close
  // relayed exactly once — tracked per id, never a single boolean (which
  // would incorrectly reject a second, legitimately different known id in a
  // batch scenario, e.g. two sequential mcp_state_exec queries).
  const forwardedControlStreamCloseIds = new Set<number>();
  let lastClassification: TCursorFollowUpClassification | null = null;
  let aborted = isAbortSignalAborted(args.signal);
  const onAbort = (): void => {
    aborted = true;
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!aborted && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const followUpPromise = args.captureBridge.waitForFollowUp({
        parentCaptureId: args.captureId,
        timeoutMs: remaining,
      });
      // A per-iteration abort listener is tracked locally and removed in a
      // `finally` below, regardless of which side of the race wins — no
      // listener may outlive the iteration that registered it.
      let onIterationAbort: (() => void) | null = null;
      const abortPromise =
        args.signal === undefined
          ? null
          : new Promise<"aborted">((resolve) => {
              const abortSignal: AbortSignal = args.signal as AbortSignal;
              if (abortSignal.aborted) {
                resolve("aborted");
                return;
              }
              onIterationAbort = () => resolve("aborted");
              abortSignal.addEventListener("abort", onIterationAbort, {
                once: true,
              });
            });
      let followUp: Awaited<typeof followUpPromise> | "aborted";
      try {
        followUp =
          abortPromise === null
            ? await followUpPromise
            : await Promise.race([followUpPromise, abortPromise]);
      } catch (err) {
        // The REAL `captureBridge.waitForFollowUp()` owns its own internal
        // timer and REJECTS (never hangs) once `timeoutMs` elapses without a
        // reply — this loop does not own that timer itself, only the outer
        // `deadline`. Preserve abort identity first: if the caller aborted
        // around the same moment, surface that, never a misattributed
        // timeout. Otherwise normalize the bridge's own rejection to the
        // correct semantic code rather than leaking its internal error
        // shape to callers who only expect `CursorCaptureDecodeError`.
        if (aborted || isAbortSignalAborted(args.signal)) {
          throw new RequestCaptureError(
            "aborted",
            `client aborted while waiting for mcp_state_exec_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
          );
        }
        throw new CursorCaptureDecodeError(
          "requires_mcp_state_exec_duplex",
          `builder follow-up wait failed (${err instanceof Error ? err.message : String(err)}; last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
          {
            execSubtype: "mcp_state_exec_args",
            execClass: "protocol_control",
          },
        );
      } finally {
        if (onIterationAbort !== null) {
          args.signal?.removeEventListener("abort", onIterationAbort);
        }
      }
      if (followUp === "aborted") {
        throw new RequestCaptureError(
          "aborted",
          `client aborted while waiting for mcp_state_exec_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
        );
      }
      if (followUp.body === null || followUp.body.byteLength === 0) {
        if (skipped.length < MAX_MCP_STATE_EXEC_SKIPPED_DIAGNOSTICS) {
          skipped.push("empty_body");
        }
        continue;
      }
      const followTaken = takeConnectEnvelopes(followUp.body);
      if (followTaken.envelopes.length === 0) {
        lastClassification = classifyAgentClientFollowUp(followUp.body, {
          payloadBytes: followUp.body.byteLength,
        });
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          `builder follow-up is not a complete Connect envelope (${lastClassification.diagnostic})`,
        );
      }
      // This batch is fully classified and validated before anything is
      // written upstream. `orderedForwardBytes` accumulates every
      // forwardable envelope in its original position; nothing is written
      // via `writeClientFollowUp` until the whole batch has been walked
      // with no rejection — preserving native wire order and avoiding a
      // partial forward if a later envelope turns out to be forbidden.
      const orderedForwardBytes: Uint8Array[] = [];
      const forwardParts: Uint8Array[] = [];
      let accepted: TCursorFollowUpClassification | null = null;
      for (const env of followTaken.envelopes) {
        observedFollowUps += 1;
        if (observedFollowUps > MAX_MCP_STATE_EXEC_FOLLOW_UPS) {
          throw new CursorCaptureDecodeError(
            "unsupported_native_exec",
            `mcp_state_exec control follow-up limit exceeded (${MAX_MCP_STATE_EXEC_FOLLOW_UPS})`,
          );
        }
        if (env.endStream) {
          if (skipped.length < MAX_MCP_STATE_EXEC_SKIPPED_DIAGNOSTICS) {
            skipped.push(`end_stream_flags=${env.flags}`);
          }
          continue;
        }
        let inspectPayload: Uint8Array;
        try {
          inspectPayload = resolveConnectEnvelopePayload(
            env,
            args.connectContentEncoding,
          );
        } catch (err) {
          throw err instanceof CursorCaptureDecodeError
            ? new CursorCaptureDecodeError(
                err.code,
                `builder follow-up ${err.message} (flags=${env.flags} bytes=${env.payload.byteLength})`,
              )
            : err;
        }
        const classification = classifyAgentClientFollowUp(inspectPayload, {
          flags: env.flags,
          payloadBytes: env.payload.byteLength,
        });
        lastClassification = classification;
        if (
          classification.kind === "benign_control" &&
          classification.agentClientCase === "client_heartbeat"
        ) {
          // The native builder emitted this exact keepalive while its own
          // MCP-state manager was working — this exchange can legitimately
          // take a while (listing/kicking multiple configured servers).
          // Buffer that exact envelope in original position; never
          // manufacture or replay keepalives ourselves (mirrors the KV
          // control relay).
          orderedForwardBytes.push(
            encodeConnectEnvelope(env.payload, env.flags),
          );
          continue;
        }
        if (classification.kind === "exec_stream_close") {
          // Verified generic-exec-loop behavior (same as request_context):
          // stream_close is written unconditionally after EVERY exec
          // result, so one for an EARLIER completed control exchange can
          // still be queued and only surface here. Relay it unchanged,
          // exactly once, and ONLY when its id is either (a) a member of
          // the known set of ALREADY-completed control exchanges from
          // PRIOR waits, or (b) THIS exchange's own expected id, but ONLY
          // once this exchange's own result has already been accepted
          // earlier in this SAME batch's iteration order — a self-id close
          // observed BEFORE its own result is not a legitimate native
          // shape (the generic-exec loop writes stream_close AFTER the
          // result) and stays rejected. Never a generic/blind approval.
          const id = classification.execNumericId;
          const isKnownEarlierExchange =
            id !== null && args.knownControlExecNumericIds?.has(id) === true;
          const isOwnExchangeAfterAccepted =
            id !== null &&
            expectedNumericId !== null &&
            id === expectedNumericId &&
            accepted !== null;
          if (
            id === null ||
            forwardedControlStreamCloseIds.has(id) ||
            !(isKnownEarlierExchange || isOwnExchangeAfterAccepted)
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `unattributed stream_close during mcp_state_exec control (already_forwarded_ids=[${[...forwardedControlStreamCloseIds].join(",")}] actual_id=${id ?? "null"})`,
            );
          }
          orderedForwardBytes.push(
            encodeConnectEnvelope(env.payload, env.flags),
          );
          forwardedControlStreamCloseIds.add(id);
          continue;
        }
        if (classification.kind === "benign_control") {
          if (skipped.length < MAX_MCP_STATE_EXEC_SKIPPED_DIAGNOSTICS) {
            skipped.push(classification.diagnostic);
          }
          continue;
        }
        if (classification.kind === "mcp_state_exec_result") {
          // Optional correlation: when both sides carry ids, they must match.
          if (
            expectedExecId !== null &&
            classification.execId !== null &&
            classification.execId !== expectedExecId
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `mcp_state_exec_result exec_id mismatch (refusing to forward); ${classification.diagnostic}`,
              {
                execSubtype: "mcp_state_exec_result_id_mismatch",
                execClass: "protocol_control",
              },
            );
          }
          if (
            expectedNumericId !== null &&
            classification.execNumericId !== null &&
            classification.execNumericId !== expectedNumericId
          ) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_exec",
              `mcp_state_exec_result id mismatch (refusing to forward); ${classification.diagnostic}`,
              {
                execSubtype: "mcp_state_exec_result_id_mismatch",
                execClass: "protocol_control",
              },
            );
          }
          accepted = classification;
          const resultBytes = encodeConnectEnvelope(env.payload, env.flags);
          forwardParts.push(resultBytes);
          orderedForwardBytes.push(resultBytes);
          continue;
        }
        // Forbidden / unknown — fail closed with metadata-only diagnostics.
        // Nothing in `orderedForwardBytes` has been written yet, so an
        // earlier benign envelope in this same batch is never leaked
        // upstream ahead of discovering this rejection.
        throw new CursorCaptureDecodeError(
          "unsupported_native_exec",
          `builder follow-up is not an allowlisted mcp_state_exec_result; refusing to forward (${classification.diagnostic}; skipped=[${skipped.join("; ")}])`,
          {
            execSubtype:
              classification.execClientCase ?? classification.agentClientCase,
            execClass:
              classification.kind === "forbidden_native"
                ? "native_exec"
                : "unknown",
          },
        );
      }
      if (followTaken.rest.byteLength > 0) {
        throw new CursorCaptureDecodeError(
          "truncated_connect_frame",
          `builder follow-up has trailing ${followTaken.rest.byteLength} incomplete bytes (${lastClassification?.diagnostic ?? "no_class"})`,
        );
      }
      // The whole batch validated cleanly — flush every buffered envelope
      // now, in its original order.
      for (const part of orderedForwardBytes) {
        args.http2.writeClientFollowUp(part);
      }
      if (accepted !== null && forwardParts.length > 0) {
        const [soleForwardPart] = forwardParts;
        const forwarded =
          forwardParts.length === 1 && soleForwardPart !== undefined
            ? soleForwardPart
            : concatBytesLocal(forwardParts);
        return {
          forwardedFollowUp: forwarded,
          completedExecNumericId: expectedNumericId,
        };
      }
      // Only benign frames in this IPC message — keep waiting.
    }
    if (aborted) {
      throw new RequestCaptureError(
        "aborted",
        `client aborted while waiting for mcp_state_exec_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
      );
    }

    throw new CursorCaptureDecodeError(
      "requires_mcp_state_exec_duplex",
      `timed out waiting for mcp_state_exec_result (last=${lastClassification?.diagnostic ?? "none"}; skipped=[${skipped.join("; ")}])`,
      {
        execSubtype: "mcp_state_exec_args",
        execClass: "protocol_control",
      },
    );
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
};

const concatBytesLocal = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

/**
 * Integration seam: after waitForTransaction on an H2 capture, settle the child
 * with duplex_bridge, open {@link openCursorCapturedHttp2Session}, and use
 * {@link forwardCursorRequestContextThroughBuilder} when the first server
 * frame is request_context_args. Model output is decoded for the CALLER only.
 */
