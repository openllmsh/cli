/**
 * The WebSocket control transport — the daemon's ONLY control channel. Uses
 * `partysocket` for auto-reconnect + backoff; its url provider re-fetches a
 * fresh channel (ticket + wss url) before every (re)connect. Holds ONE socket to
 * the relay, runs pushed commands with `runCommandInner`, and acks + pushes
 * status over the socket. See `docs/proposals/daemon-relay-websocket-push.md`.
 */

import type {
  TAuthEvent,
  TDaemonCommandAck,
  TDaemonProviderConnection,
  TDaemonSessionLost,
  TDaemonStatus,
  TIceServer,
  TRelayFrame,
} from "@openllmsh/protocol";
import { RELAY_PROTOCOL_VERSION, RelayFrame } from "@openllmsh/protocol";
import { Schema } from "effect";
import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { setAuthSink } from "./auth-events";
import {
  clearAuthGap,
  enqueueAuthGap,
  flushAuthGap as flushAuthGapBuffer,
} from "./auth-gap-buffer";
import type { TAuthStatusBaseline } from "./auth-session-lost";
import {
  detectAuthLossEdge,
  noteConnectionsForSessionLost,
} from "./auth-session-lost";
import {
  DeviceLimitExceededError,
  fetchChannel,
  notifyQuotaStatus,
  notifySessionLost,
} from "./cloud-client";
import { runCommandInner } from "./control-relay";
import { logKeychainWatcherTick } from "./delegation/keychain";
import {
  createDeviceLimitBackoff,
  deviceLimitBackoffConfig,
} from "./device-limit-backoff";
import { opaqueDoctorCorrelation } from "./doctor-report/correlation";
import { takeRepeatWindow } from "./doctor-report/repeat";
import { daemonApiKeyId, daemonEnv } from "./env";
import { createHeartbeat } from "./heartbeat";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  safeDiagnosticMessage,
} from "./logger";
import {
  acceptChannel,
  closeChannelFromRelay,
  configureMuxHost,
  currentDaemonCaps,
  handleChannelOpenAck,
  muxHostOnBytes,
  replaceMuxPeerCaps,
  resetAllChannels,
  updateMuxPeerCaps,
} from "./mux-host";
import {
  withCommandReplayContext,
  withoutCommandReplayContext,
} from "./op-context";
import { noteConnectionsForQuota } from "./quota-status-notify";
import {
  configureRtcClient,
  handleRtcAnswer,
  handleRtcClientIce,
  handleRtcNack,
  resetUnmountedRtcClientSessions,
} from "./rtc-client";
import {
  configureRtcHost,
  handleRtcIce,
  handleRtcOffer,
  resetUnmountedRtcSessions,
} from "./rtc-host";
import { scheduleDaemonCommand } from "./scheduled-command";
import { computeStatusFresh, setStatusPublishQueueSnapshot } from "./status";
import type { TStatusPublishTrigger } from "./status-publish-coalesce";
import { createStatusPublishCoalescer } from "./status-publish-coalesce";
import { createSupersedeBackoff, isSupersededClose } from "./supersede-backoff";

const decodeFrame = Schema.decodeUnknownEither(RelayFrame);

/** Full-snapshot stringify — only on a changed watcher tick / actual publish. */
export const stringifyStatusSnapshot = (status: unknown): string =>
  JSON.stringify(status);

/** JSON-encode a key segment so `:` / `|` in free-text cannot collide. */
const changeKeySegment = (value: string): string => JSON.stringify(value);

const joinChangeKeyParts = (parts: readonly string[]): string =>
  parts.map(changeKeySegment).join(":");

/**
 * Distinguishes omitted optional arrays from explicit `[]` in the change key
 * (JSON omits vs emits the field). Does not alter the snapshot itself.
 */
const optionalArrayChangeKey = (
  value: readonly unknown[] | undefined,
  encodedItems: string,
): string =>
  joinChangeKeyParts([value === undefined ? "0" : "1", encodedItems]);

/**
 * Cheap change key: concatenates wire-visible primitives. Nested `usage` /
 * `pending_auth` are small optional blobs; they are stringified individually
 * rather than walking the whole snapshot. Each primitive is JSON-encoded
 * before joining so free-text (`detail`, `title`, `last_exit_reason`, …)
 * cannot collide across `:` / `|` field separators.
 */
export const statusChangeKey = (status: TDaemonStatus): string => {
  const connections = status.connections
    .map((c) =>
      joinChangeKeyParts([
        c.provider,
        c.status,
        c.observation ?? "",
        c.reason_code ?? "",
        c.cli_installed === undefined ? "" : String(c.cli_installed),
        c.cli_install === undefined ? "" : JSON.stringify(c.cli_install),
        c.cli_version ?? "",
        c.detail ?? "",
        c.last_login_at_ms === undefined || c.last_login_at_ms === null
          ? ""
          : String(c.last_login_at_ms),
        c.account_hash ?? "",
        c.pending_auth === undefined || c.pending_auth === null
          ? ""
          : JSON.stringify(c.pending_auth),
        c.upstream_auth_cooldown === undefined
          ? ""
          : JSON.stringify(c.upstream_auth_cooldown),
        c.usage === undefined || c.usage === null
          ? ""
          : JSON.stringify(c.usage),
      ]),
    )
    .join("|");
  const sessions = optionalArrayChangeKey(
    status.sessions,
    (status.sessions ?? [])
      .map((s) =>
        joinChangeKeyParts([
          s.id,
          s.cli,
          String(s.started_at_ms),
          s.attached ? "1" : "0",
          s.live ? "1" : "0",
          s.busy === undefined ? "" : String(s.busy),
          s.title ?? "",
          s.last_exit_reason ?? "",
          s.vendor_session_id ?? "",
        ]),
      )
      .join("|"),
  );
  return [
    status.daemon_version,
    status.key_configured ? "1" : "0",
    status.auto_update === undefined ? "" : String(status.auto_update),
    status.pty_sessions === undefined ? "" : String(status.pty_sessions),
    status.cloud_state,
    // Omitted/undefined is "0" so a false→true flip is a real key change.
    status.identity_conflict ? "1" : "0",
    status.pubkey ?? "",
    status.port === undefined ? "" : String(status.port),
    status.sandbox ?? "",
    status.cli === undefined
      ? ""
      : joinChangeKeyParts([
          String(status.cli.installed),
          status.cli.version ?? "",
        ]),
    optionalArrayChangeKey(status.caps, (status.caps ?? []).join(",")),
    optionalArrayChangeKey(
      status.control_caps,
      (status.control_caps ?? []).join(","),
    ),
    status.pty_supported === undefined ? "" : String(status.pty_supported),
    connections,
    sessions,
  ].join("\n");
};

export type TWatcherSnapshotPlan = {
  readonly key: string;
  readonly skipSerialize: boolean;
};

/** Decide whether a watcher tick should stringify the full snapshot. */
export const planWatcherSnapshot = (
  previousKey: string,
  status: TDaemonStatus,
  stringify: (status: unknown) => string = stringifyStatusSnapshot,
): TWatcherSnapshotPlan => {
  const key = statusChangeKey(status);
  if (previousKey !== "" && key === previousKey) {
    return { key, skipSerialize: true };
  }
  stringify(status);
  return { key, skipSerialize: false };
};

export const WATCH_MS = 15_000;
// Heartbeat: the daemon sends its OWN `ping` on this interval and arms the
// liveness watchdog off the relay's `pong` (not off arbitrary inbound frames),
// so it detects a dead daemon→relay direction itself and reconnects — rather
// than waiting for the relay to terminate the socket (a `1006`). See `heartbeat.ts`
// and R4 in docs/audit/2026-06-08-daemon-relay-websocket-stability.md.
export const HEARTBEAT_MS = 20_000;
// Reap only after three consecutive missed relay pongs. The heartbeat checks
// before incrementing: after its immediate ping, 20s/40s/60s are grace ticks and
// the 80s tick reaps. partysocket owns dial/backoff.
export const MAX_MISSED_PONGS = 3;
/** @deprecated Legacy compatibility export; active liveness is miss-counted (~80s), not this deadline. */
export const LIVENESS_TIMEOUT_MS = 70_000;
// Reconnect jitter: a relay redeploy closes EVERY daemon's socket at once, and
// partysocket's backoff is deterministic (no jitter of its own), so without this
// the whole fleet re-dials in lockstep and stampedes the successor box. Add up to
// this much random delay before a RE-dial (gated on `hasConnected`, so the first
// connect stays immediate). Small vs the 35s presence grace, so it never surfaces
// as a flap. See `docs/audit/presence-reconnect-prior-art.md` §3.
const RECONNECT_JITTER_MS = 3_000;

// Partysocket's default 4_000ms connection timeout is too short for WSS upgrades
// through the Vercel relay/sandbox path, where TLS handshakes can stall past
// that budget and drop healthy links as `TIMEOUT` before OPEN. Keep 20s to give
// each pre-open attempt enough time to complete before partysocket bails.
export const CONTROL_CHANNEL_CONNECT_TIMEOUT_MS = 20_000;

export const controlSocketOptions = (): {
  readonly WebSocket: typeof WebSocket;
  readonly minReconnectionDelay: number;
  readonly maxReconnectionDelay: number;
  readonly connectionTimeout: number;
} => ({
  WebSocket: globalThis.WebSocket,
  minReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  connectionTimeout: CONTROL_CHANNEL_CONNECT_TIMEOUT_MS,
});

// Stand-down when ANOTHER daemon on the same API key evicts us (`4000
// superseded`). partysocket resets its backoff on every OPEN, and in a
// supersede war every dial opens — so without this the two contenders re-dial
// in ~1s forever and each reconnect drops browser attachment transports every
// few seconds. See `supersede-backoff.ts`.
const SUPERSEDE_BASE_MS = 15_000;
const SUPERSEDE_MAX_MS = 300_000;
// An eviction after this much uptime is a fresh conflict, not an escalation.
const SUPERSEDE_STABLE_MS = 120_000;
// Stand-down when the plan's concurrent-device cap is full
// (`403 device_limit_exceeded` on GET /api/daemon/channel). Slots free when an
// incumbent disconnects or ages out of the 90s presence window — so base at
// 60s (order of that window) rather than partysocket's 1–30s reconnect, and
// escalate to a few minutes under sustained over-cap. Values live on the pure
// module so unit tests pin the same pair. See `device-limit-backoff.ts` and
// docs/audit/device-cap-mechanism.md §7 item 5.
/** Check a healthy relay connection for a deploy handoff without waiting for
 * the five-minute bootstrap loop. Small jitter prevents fleet lockstep. */
const MIGRATION_CHECK_MS = 45_000;
const MIGRATION_JITTER_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let ws: ReconnectingWebSocket | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let migrationTimer: ReturnType<typeof setTimeout> | null = null;
let migrationInFlight: Promise<void> | null = null;
let migrationEnabled = false;
// The daemon's liveness heartbeat. `sendPing` and `onSilent` close over `ws`,
// which is reassigned per connection, so they read the live binding at call
// time. partysocket reuses one instance across reconnects, so this one heartbeat
// is started on each open and stopped on each close.
const heartbeat = createHeartbeat({
  sendPing: () => send({ type: "ping" }),
  onSilent: () => {
    handleControlChannelHeartbeatSilent();
  },
  onFirstPong: () => armProbesAfterPong(),
  heartbeatMs: HEARTBEAT_MS,
  maxMissedPongs: MAX_MISSED_PONGS,
});
/** Escalating stand-down when a same-key daemon evicts this connection. */
const supersedeBackoff = createSupersedeBackoff({
  baseMs: SUPERSEDE_BASE_MS,
  maxMs: SUPERSEDE_MAX_MS,
  stableAfterMs: SUPERSEDE_STABLE_MS,
  jitterMs: RECONNECT_JITTER_MS,
});
/** Escalating stand-down when the plan's concurrent-device cap is full. */
const deviceLimitBackoff = createDeviceLimitBackoff(deviceLimitBackoffConfig);
/** Fresh connect ticket, stashed by the url provider for the next `hello`. */
let ticket = "";
/** Origin of the wss url the CURRENT connection dialed (set by `channelUrl`).
 *  `migrateIfRelayMoved` compares it to a fresh channel fetch to detect a
 *  deploy that moved the relay to a new content-addressed sandbox. */
let connectedWssOrigin: string | null = null;
let lastFingerprint = "";
/** Monotonic connection counter. Each `onopen` bumps this; stale hello/status
 *  continuations whose captured generation no longer matches simply bail. */
let connectionGeneration = 0;
/** True once this socket has completed one ping/pong round-trip. */
let probesArmed = false;
/** Welcome arrived before the first pong — flush `pushStatus` on arm. */
let pendingWelcomeStatus = false;
let armProbesAfterPong = (): void => {};
/** Relay session negotiated by the current connection. Null until welcome. */
let daemonSessionId: string | null = null;
/** Null while handshake is pending; false for an older relay welcome. */
let supportsOrderedStatus: boolean | null = null;
let statusSeq = 0;
const statusPublishCoalescer = createStatusPublishCoalescer({
  now: () => Date.now(),
  epoch: () => connectionGeneration,
  computeFresh: async (trigger) => {
    const status = await computeStatusFresh({
      trigger,
      ...(trigger === "late-probe" ? { reuseSettledSlugProbes: true } : {}),
    });
    return { status, fingerprint: statusChangeKey(status) };
  },
  canSend: (jobEpoch) =>
    jobEpoch === connectionGeneration &&
    supportsOrderedStatus !== null &&
    ws !== null &&
    ws.readyState === ws.OPEN,
  lastFingerprint: () => lastFingerprint,
  setLastFingerprint: (fingerprint) => {
    lastFingerprint = fingerprint;
  },
  observe: (connections) => {
    observeNotificationTransitions(
      connections as ReadonlyArray<TDaemonProviderConnection>,
    );
  },
  send: (status, active, trigger) => {
    const ordered = supportsOrderedStatus === true && daemonSessionId !== null;
    if (ordered) statusSeq += 1;
    send({
      type: "status",
      ...(active === undefined ? {} : { active }),
      status,
      ...(ordered && daemonSessionId !== null
        ? { daemon_session_id: daemonSessionId, status_seq: statusSeq }
        : {}),
    });
    if (
      trigger === "command" ||
      trigger === "auth-sink" ||
      trigger === "late-probe"
    ) {
      try {
        logInfo(
          "control-channel",
          safeDiagnosticMessage`Status publish requested.`,
          { trigger },
          {
            operation_kind: "status_publish",
            ...(ordered ? { status_seq: statusSeq } : {}),
          },
        );
      } catch {
        // Reporting must never change publication.
      }
    }
  },
  onCollapsed: (queue) => {
    if (queue.collapsed_count !== 1) return;
    logDebug("control-channel", "status publish coalesced", {
      queued_publish_depth: queue.queued_publish_depth,
      collapsed_count: queue.collapsed_count,
      oldest_queued_publish_age_ms: queue.oldest_queued_publish_age_ms,
      status_trigger: queue.status_trigger,
    });
  },
});
/** Binary WebSocket frames can arrive as a mix of Blobs and ArrayBuffers. Blob
 * conversion is async, so queue all binary delivery to preserve wire order. */
let binaryFrameTail: Promise<void> = Promise.resolve();
/** Whether THIS connection's `hello` has been sent. The relay 4001-closes any
 *  connection whose FIRST frame isn't a hello, and an out-of-band status push
 *  (the bootstrap scheduler fires `pushStatusIfChanged` the moment
 *  `cloud_state` changes — e.g. the cloud coming up seconds after the daemon)
 *  can resolve its `computeStatus` between the socket opening and the hello's
 *  own snapshot resolving — putting a `status` frame on the wire first and
 *  killing the handshake. So `send` drops every non-hello frame until the
 *  hello is out; the dropped status is lossless (the hello carries a fresh
 *  snapshot, and the periodic observer re-pushes on change). */
let helloSent = false;
/** Whether the socket has opened at least once — lets `onopen` log a first
 *  "connected" vs a recovery "reconnected", so the log shows the channel coming
 *  back, not just dropping. */
let hasConnected = false;
/** Last logged socket error reason / close line, to SUPPRESS the per-dial repeat
 *  during a sustained outage (cloud down, keyless): partysocket re-dials forever,
 *  and an unguarded warn-per-attempt floods the log. We log a NEW reason once,
 *  then stay quiet until it changes; `onopen` resets both so the next outage logs
 *  fresh (paired with the `reconnected` line). */
let lastErrorReason = "";
let lastCloseLine = "";

/** Retryable socket errors stay local at debug, once per reason. */
export const handleControlChannelSocketError = (
  ev: {
    readonly message?: unknown;
    readonly error?: unknown;
  } | null,
): void => {
  const reason =
    (typeof ev?.message === "string" && ev.message) ||
    (ev?.error instanceof Error && ev.error.message) ||
    "unknown";
  if (reason !== lastErrorReason) {
    lastErrorReason = reason;
    logDebug("control-channel", `socket error: ${reason} (reconnecting)`);
  }
};

const reportControlChannelRepeat = (
  key: string,
  message: ReturnType<typeof safeDiagnosticMessage>,
): void => {
  const repeatCount = takeRepeatWindow(key);
  if (repeatCount === null) return;
  logWarn("control-channel", message, undefined, {
    timings: { repeat_count: repeatCount },
  });
};

export const handleControlChannelProtocolFailure = (): void => {
  reportControlChannelRepeat(
    "control-channel:protocol",
    safeDiagnosticMessage`The control channel received an invalid frame.`,
  );
};

/** Heartbeat silence is a control-channel timeout, never provider-auth
 *  `liveness_degraded`. */
export const handleControlChannelHeartbeatSilent = (): void => {
  reportControlChannelRepeat(
    "control-channel:transport",
    safeDiagnosticMessage`The control connection failed unexpectedly.`,
  );
  logDebug(
    "control-channel",
    `no relay pong after ${MAX_MISSED_PONGS} missed heartbeats; forcing reconnect`,
  );
  ws?.reconnect();
};

const sendBytes = (bytes: Uint8Array): void => {
  if (ws === null || ws.readyState !== ws.OPEN || !helloSent) return;
  try {
    ws.send(bytes.slice());
  } catch {
    // best-effort while the socket races a close
  }
};

const authTransportReady = (): boolean =>
  ws !== null && ws.readyState === ws.OPEN && helloSent;

const send = (frame: TRelayFrame): void => {
  if (ws === null || ws.readyState !== ws.OPEN) {
    if (frame.type === "auth") enqueueAuthGap(frame.auth);
    return;
  }
  // Nothing may precede the hello on a fresh connection (see `helloSent`).
  if (!helloSent && frame.type !== "hello") {
    if (frame.type === "auth") enqueueAuthGap(frame.auth);
    return;
  }
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // best-effort: a failed send means the socket is closing; partysocket reconnects
    if (frame.type === "auth") enqueueAuthGap(frame.auth);
  }
};

const emitAuthFrame = (auth: TAuthEvent): void => {
  const key_id = daemonApiKeyId();
  if (key_id === null) return;
  send({ type: "auth", key_id, auth });
};

type TAuthFlushTransportForTests = {
  readonly keyId: string | null;
  readonly ready: () => boolean;
  readonly send: (payload: string) => void;
};

let authFlushTransportForTests: TAuthFlushTransportForTests | null = null;

/** Test seam: stub key id + send readiness without dialing a real socket. */
export const installAuthFlushTransportForTests = (
  transport: TAuthFlushTransportForTests,
): (() => void) => {
  authFlushTransportForTests = transport;
  return () => {
    authFlushTransportForTests = null;
  };
};

/**
 * Replay auth events that landed while the socket was down, after hello.
 * Never drains until a usable key id and OPEN+helloSent hold; a mid-flush
 * socket close retains the unsent tail (send is best-effort, not exactly-once).
 */
const flushAuthGap = (): void => {
  const key_id = authFlushTransportForTests?.keyId ?? daemonApiKeyId();
  flushAuthGapBuffer(key_id, (auth) => {
    const ready =
      authFlushTransportForTests !== null
        ? authFlushTransportForTests.ready()
        : authTransportReady();
    if (key_id === null || !ready) return false;
    try {
      const payload = JSON.stringify({ type: "auth", key_id, auth });
      if (authFlushTransportForTests !== null) {
        authFlushTransportForTests.send(payload);
        return true;
      }
      if (ws === null) return false;
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  });
};

/** Test seam: run the same flush used after hello. */
export const flushAuthGapForTests = (): void => {
  flushAuthGap();
};

const lastPostedAuthStatus = new Map<string, TAuthStatusBaseline>();
let emitSessionLoss: (loss: TDaemonSessionLost) => Promise<void> =
  notifySessionLost;

/**
 * POST session-lost on a pure `connected → disconnected` edge. No settle,
 * no window, no latch — staying disconnected does not re-POST; a later
 * `→ connected` re-arms. `signed_out` never POSTs.
 */
const observeAuthStatusEdges = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
): void => {
  for (const conn of connections) {
    const edge = detectAuthLossEdge(
      lastPostedAuthStatus.get(conn.provider),
      conn,
    );
    if (edge === null) continue;
    if (edge.lost) {
      void emitSessionLoss({
        slug: edge.slug,
        diagnostic_code: edge.diagnostic_code ?? "unclassified",
        ...(edge.account_hash !== undefined
          ? { account_hash: edge.account_hash }
          : {}),
      });
    }
    lastPostedAuthStatus.set(edge.slug, edge.next);
  }
};

/** Test-only seam for the status-literal edge detector. */
export const startSessionLostNotifierForTests = (
  notify: (loss: TDaemonSessionLost) => Promise<void>,
): (() => void) => {
  emitSessionLoss = notify;
  lastPostedAuthStatus.clear();
  return () => {
    lastPostedAuthStatus.clear();
    emitSessionLoss = notifySessionLost;
  };
};

/** Test-only: feed one computed status snapshot into the edge detector. */
export const noteSessionLossStatusForTests = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
): void => observeAuthStatusEdges(connections);

/** Reset relay-owned work at a connection boundary. Mux channels and RTC
 * signaling sessions are tied to the old relay socket and must not continue
 * into the successor. Device PTYs DETACH (survive); the browser re-attaches
 * after reconnect. */
export const resetRelayScopedState = (): void => {
  resetAllChannels();
  // Keep RTC sessions whose mux already mounted — the peer connection and
  // data channel do not ride the relay socket and survive reconnect.
  resetUnmountedRtcSessions();
  resetUnmountedRtcClientSessions();
};

const enqueueStatusPublish = (opts: {
  skipUnchanged: boolean;
  active?: boolean;
  trigger: TStatusPublishTrigger;
}): Promise<void> => statusPublishCoalescer.request(opts);

/**
 * Shared observer choreography for a computed status snapshot: local
 * `auth.session.lost` emit, cloud POST on `→ disconnected`, then quota.
 */
const observeNotificationTransitions = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
): void => {
  noteConnectionsForSessionLost(connections);
  observeAuthStatusEdges(connections);
  for (const transition of noteConnectionsForQuota(connections)) {
    void notifyQuotaStatus(transition);
  }
};

const pushStatus = async (
  active?: boolean,
  trigger: TStatusPublishTrigger = "welcome",
): Promise<void> =>
  enqueueStatusPublish({
    skipUnchanged: false,
    active,
    trigger,
  });

/** Throttle for `notePresenceActivity` — traffic-driven presence refreshes are
 *  a liveness signal, not telemetry, so one per minute is ample (the routing
 *  freshness window is far wider) and an agentic client's burst costs one push. */
const PRESENCE_REFRESH_MS = 60_000;
let lastPresenceRefreshAt = 0;

/**
 * "A request just hit my LOCAL `/v1` surface" — proof this daemon is alive and
 * serving, so republish presence to the cloud (an unconditional `status` frame
 * makes the relay write `daemon_active = true` + slide `last_seen`).
 *
 * Without this, presence is only ever asserted on hello or on a CHANGED status
 * snapshot, so a daemon that is demonstrably serving traffic could still read
 * offline to the proxy — and the next chain that leads with a subscription hop
 * gets `subscription_requires_daemon` instead of a 307 to the very daemon that
 * just answered. Throttled, fire-and-forget, never on the response path.
 */
export const notePresenceActivity = (): void => {
  const now = Date.now();
  if (now - lastPresenceRefreshAt < PRESENCE_REFRESH_MS) return;
  lastPresenceRefreshAt = now;
  void pushStatus(undefined, "presence").catch(() => {
    // best-effort: presence also self-heals on the relay keepalive
  });
};

/** Send a fresh snapshot only when it changed — surfaces out-of-band flips
 *  (a device-code login completing) while a command isn't in flight. Exported
 *  so the bootstrap scheduler can push a `cloud_state` change immediately. */
export const pushStatusIfChanged = async (
  trigger: TStatusPublishTrigger = "watcher",
): Promise<void> =>
  enqueueStatusPublish({
    skipUnchanged: true,
    trigger,
  });

const startWatcher = (): void => {
  if (watchTimer !== null) return;
  watchTimer = setInterval(() => {
    logKeychainWatcherTick();
    pushStatusIfChanged().catch(() => {
      // best-effort: a failed snapshot push retries on the next tick
    });
  }, WATCH_MS);
  watchTimer.unref?.();
};

armProbesAfterPong = (): void => {
  if (probesArmed) return;
  probesArmed = true;
  startWatcher();
  if (pendingWelcomeStatus) {
    pendingWelcomeStatus = false;
    void pushStatus(undefined, "welcome");
  }
};

const stopWatcher = (): void => {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
};

const scheduleMigrationCheck = (): void => {
  if (!migrationEnabled || migrationTimer !== null) return;
  migrationTimer = setTimeout(
    () => {
      migrationTimer = null;
      if (migrationInFlight === null) {
        // Fence the check to the generation it starts under — a reconnect while
        // its channel fetch is in flight must not bounce the newer session.
        migrationInFlight = migrateIfRelayMoved(connectionGeneration)
          .catch((err) => logError("control-channel", err))
          .finally(() => {
            migrationInFlight = null;
          });
      }
      void migrationInFlight.finally(scheduleMigrationCheck);
    },
    MIGRATION_CHECK_MS + Math.random() * MIGRATION_JITTER_MS,
  );
  migrationTimer.unref?.();
};

const stopMigrationCheck = (): void => {
  migrationEnabled = false;
  if (migrationTimer !== null) clearTimeout(migrationTimer);
  migrationTimer = null;
};

const startMigrationCheck = (): void => {
  migrationEnabled = true;
  scheduleMigrationCheck();
};

// Command dedup. The SAME command id can arrive more than once: the relay's
// delivery is at-least-once — its connect-time replay can overlap a live push,
// and its periodic sweep re-pushes any row that hasn't reached a terminal ack
// within the redeliver window (a long-running command like a browser login is
// legitimately un-acked for a while). Commands like `connect` aren't idempotent
// (a second run spawns a second login), so we dedupe by id here. `null` = still
// running (skip the re-ack — the in-flight run will ack); an ack value =
// completed (re-ack with the REAL result so a lost first-ack still reaches a
// terminal state, without clobbering an `error` with `done`). The map is
// in-memory: a daemon RESTART forgets it, so a command that was delivered but
// never terminally acked is re-delivered and re-run after the redeliver window
// — by design (the command never completed; the cloud's stale reaper is the
// give-up bound).
const commandResults = new Map<string, TDaemonCommandAck | null>();
/** Per-kind read admission (F7 generation fence). Hung list_local must not block status. */
let statusReadTail: Promise<void> = Promise.resolve();
let listLocalReadTail: Promise<void> = Promise.resolve();
const PROCESSED_CAP = 500;

/** Max chars of error detail carried into the log line — enough to name the
 *  failing step (integration output ends with the failing command), never a
 *  full transcript dump. */
const ERROR_DETAIL_MAX = 600;

/** Explicit auth commands only — never poll/status/refresh. */
const EXPLICIT_AUTH_COMMAND_KINDS = new Set<string>([
  "connect",
  "connect_device_code",
  "cancel_connect",
  "logout",
  "submit_login_code",
]);

const authCommandElapsedMs = (startedAt: number): number => {
  const ms = performance.now() - startedAt;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
};

const logAuthCommandStage = (
  message: ReturnType<typeof safeDiagnosticMessage>,
  kind: string,
  commandId: string,
  elapsedMs: number,
  level: "info" | "warn" = "info",
): void => {
  const correlation_id = opaqueDoctorCorrelation(commandId);
  const meta = {
    kind,
    elapsed_ms: elapsedMs,
    ...(correlation_id !== undefined ? { correlation_id } : {}),
  };
  const observation = {
    timings: { elapsed_ms: elapsedMs },
    ...(correlation_id !== undefined ? { correlation_id } : {}),
  };
  if (level === "warn") {
    logWarn("control-channel", message, meta, observation);
    return;
  }
  logInfo("control-channel", message, meta, observation);
};

/** Extract a loggable diagnostic from an error ack's `result`: prefer its
 *  `error` field, else the TAIL of its `output` (integration failures put the
 *  failing step last), else a compact JSON of the result. Never used for
 *  successful acks — success results can carry control-plane secrets.
 *
 *  Redacted before it hits the daemon log: `integrations.ts` returns the
 *  RAW `output` in the ack (it goes to the dashboard over the authed socket)
 *  and only redacts its own openllmd.err.log tail — so THIS log path must
 *  scrub the API key itself, or a failing script that echoes its env would
 *  persist the key to disk here. */
const ackErrorDetail = (result: unknown): string => {
  let detail: string;
  if (result === null || typeof result !== "object") {
    detail = String(result);
  } else {
    const r = result as { error?: unknown; output?: unknown };
    detail =
      typeof r.error === "string" && r.error.length > 0
        ? r.error
        : typeof r.output === "string" && r.output.length > 0
          ? r.output
          : JSON.stringify(result);
  }
  const apiKey = daemonEnv().apiKey;
  if (apiKey !== null && apiKey.length > 0) {
    detail = detail.split(apiKey).join("[REDACTED_OPENLLM_API_KEY]");
  }
  // Belt-and-suspenders: scrub anything shaped like a gateway key even if it
  // isn't THIS daemon's (a script may print another key it was handed).
  detail = detail.replace(/sk-llm-[A-Za-z0-9._-]+/g, "sk-llm-[REDACTED]");
  return detail.length > ERROR_DETAIL_MAX
    ? `…${detail.slice(-ERROR_DETAIL_MAX)}`
    : detail;
};

const onCommand = async (command: TRelayFrame): Promise<void> => {
  if (command.type !== "command") return;
  // The relay session this command arrived on. A reconnect can happen while
  // the command waits in the FIFO queue; work owned by that obsolete session
  // must not execute or ack through the replacement session.
  const generation = connectionGeneration;
  const id = command.command.id;
  const prior = commandResults.get(id);
  if (prior !== undefined) {
    logDebug("control-channel", "duplicate command ignored", {
      id,
      kind: command.command.kind,
    });
    if (prior !== null) send({ type: "ack", ack: prior });
    return;
  }
  commandResults.set(id, null); // mark in-flight
  const kind = command.command.kind;
  const isAuthCommand = EXPLICIT_AUTH_COMMAND_KINDS.has(kind);
  const receivedAt = performance.now();
  if (isAuthCommand) {
    logAuthCommandStage(
      safeDiagnosticMessage`auth command received`,
      kind,
      id,
      0,
    );
  }
  if (commandResults.size > PROCESSED_CAP) {
    // Evict the oldest COMPLETED entry. Skipping in-flight (`null`) entries is
    // load-bearing: evicting one would let a duplicate delivery of a still-
    // running command slip past the dedup above and execute twice (a second
    // `connect` spawns a second login). Map iteration is insertion-ordered, so
    // the first non-null is the oldest completed. If EVERY entry is in-flight we
    // keep them all — the cap is a soft bound, not a hard guarantee.
    for (const [key, value] of commandResults) {
      if (value !== null) {
        commandResults.delete(key);
        break;
      }
    }
  }
  const run = (): Promise<void> =>
    withCommandReplayContext(command.command.replay_session_id, async () => {
      if (isAuthCommand) {
        logAuthCommandStage(
          safeDiagnosticMessage`auth command queue wait ended`,
          kind,
          id,
          authCommandElapsedMs(receivedAt),
        );
      }
      // Queued under a replaced session — skip, and drop the in-flight dedup
      // marker so the relay's redelivery of this id can run on the CURRENT
      // session (a retained `null` entry would suppress that valid redelivery).
      if (generation !== connectionGeneration) {
        commandResults.delete(id);
        logDebug("control-channel", "stale-session command dropped", {
          kind: command.command.kind,
          id,
        });
        return;
      }
      // Log only non-sensitive metadata — a command `payload` (e.g. `set_config`)
      // and an ack `result` can carry control-plane secrets, so they must not land
      // in the daemon's logs. Kind + id + status are enough to trace a command.
      logInfo("control-channel", "command received", {
        kind: command.command.kind,
        id: command.command.id,
      });
      // This daemon, not the relay's socket send, confirms execution has started.
      send({ type: "ack", ack: { id, status: "ack" } });
      if (isAuthCommand) {
        logAuthCommandStage(
          safeDiagnosticMessage`auth command execution started`,
          kind,
          id,
          0,
        );
      }
      const executionStartedAt = performance.now();
      const afterAckHolder: { fn: (() => Promise<void>) | null } = {
        fn: null,
      };
      const ack = await runCommandInner(command.command, {
        registerAfterAck: (work) => {
          afterAckHolder.fn = work;
        },
      });
      const pendingAfterAck = afterAckHolder.fn;
      // Stale AFTER execute: side effects already ran. Keep a completed dedup
      // result so redelivery re-acks instead of repeating logout/connect/CLI
      // update. Suppress the old-session terminal ack and afterAck. An update
      // whose reexec was skipped is cancelled/retryable — not `{ checking: true }`.
      if (generation !== connectionGeneration) {
        const stored: TDaemonCommandAck =
          pendingAfterAck !== null
            ? {
                id,
                status: "error",
                result: {
                  error: "cancelled",
                  retryable: true,
                  deferred: true,
                },
              }
            : ack;
        commandResults.set(id, stored);
        logDebug("control-channel", "stale-session executed command kept", {
          kind: command.command.kind,
          id,
          afterAckSkipped: pendingAfterAck !== null,
        });
        return;
      }
      commandResults.set(id, ack);
      if (isAuthCommand) {
        logAuthCommandStage(
          safeDiagnosticMessage`auth command terminal`,
          kind,
          id,
          authCommandElapsedMs(executionStartedAt),
        );
      }
      // On SUCCESS the result stays out of the log (it can carry control-plane
      // secrets — see the received-side note above). On ERROR, surface the
      // diagnostic fields (`error` / the tail of `output`) — without them a
      // failed command logs only `status: "error"`, which is undebuggable from
      // the daemon log alone (field-reported). Truncated: diagnostics, not dumps.
      logInfo("control-channel", "command done", {
        kind: command.command.kind,
        id: command.command.id,
        status: ack.status,
        ...(ack.status === "error"
          ? { error: ackErrorDetail(ack.result) }
          : {}),
      });
      send({ type: "ack", ack });
      if (pendingAfterAck !== null) await pendingAfterAck();
      // `pushStatus` returning is the publish *request* settling (compute /
      // enqueue / local send attempt). It is not browser receipt or relay persistence.
      if (isAuthCommand) {
        logAuthCommandStage(
          safeDiagnosticMessage`auth command status publish request attempted`,
          kind,
          id,
          0,
        );
      }
      const publishStartedAt = performance.now();
      void withoutCommandReplayContext(() =>
        pushStatus(undefined, "command")
          .then(() => {
            if (isAuthCommand) {
              logAuthCommandStage(
                safeDiagnosticMessage`auth command status publish request completed`,
                kind,
                id,
                authCommandElapsedMs(publishStartedAt),
              );
            }
          })
          .catch((err: unknown) => {
            if (isAuthCommand) {
              logAuthCommandStage(
                safeDiagnosticMessage`auth command status publish request error`,
                kind,
                id,
                authCommandElapsedMs(publishStartedAt),
                "warn",
              );
            }
            logDebug("control-channel", "status publish request failed", {
              kind,
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    });
  if (command.command.kind === "status") {
    statusReadTail = statusReadTail.catch(() => undefined).then(run);
    await statusReadTail;
    return;
  }
  if (command.command.kind === "list_local_sessions") {
    listLocalReadTail = listLocalReadTail.catch(() => undefined).then(run);
    await listLocalReadTail;
    return;
  }
  const ack = await scheduleDaemonCommand(command.command, run);
  if (ack !== null) {
    commandResults.set(id, ack);
    send({ type: "ack", ack: { id, status: "ack" } });
    send({ type: "ack", ack });
    return;
  }
};

const onFrame = (frame: TRelayFrame): void => {
  // Synchronous dispatch below (acceptChannel, handleChannelOpenAck,
  // updateMuxPeerCaps, …) must never throw through the WebSocket callback —
  // that would tear down the whole control channel over one bad frame.
  try {
    dispatchFrame(frame);
  } catch (err: unknown) {
    logDebug("control-channel", "frame dispatch failed", {
      frameType: frame.type,
      err: err instanceof Error ? err.message : String(err),
    });
    handleControlChannelProtocolFailure();
  }
};

const dispatchFrame = (frame: TRelayFrame): void => {
  switch (frame.type) {
    case "command":
      onCommand(frame).catch(() => {
        // best-effort: a command failure is reflected by the next status push
      });
      return;
    case "welcome":
      replaceMuxPeerCaps(frame.snapshot_caps);
      daemonSessionId = frame.daemon_session_id ?? null;
      supportsOrderedStatus = frame.daemon_session_id !== undefined;
      // Sequence 1 of the session is reserved for the hello snapshot the relay
      // publishes on this daemon's behalf, so our own publisher starts above it.
      statusSeq = 1;
      startMigrationCheck();
      if (probesArmed) {
        void pushStatus(undefined, "welcome");
      } else {
        pendingWelcomeStatus = true;
      }
      return;
    case "ping":
      // The relay's keepalive ping → answer so its missed-pong reap stays happy.
      send({ type: "pong" });
      return;
    case "pong":
      // The relay's answer to OUR heartbeat ping → the daemon→relay round-trip
      // is alive, so re-arm the liveness window (R4: arm off pong, not off any
      // inbound frame — that's how we notice a dead outbound direction).
      heartbeat.notePong();
      return;
    case "channel_open":
      acceptChannel(frame);
      return;
    case "channel_open_ack":
      handleChannelOpenAck(frame);
      return;
    case "channel_close":
      closeChannelFromRelay(frame);
      return;
    case "rtc_offer":
      // Daemon is the responder: open seal, answer, trickle ICE.
      // Log async failures (parity with serveTunnel) — never crash the process.
      void handleRtcOffer(frame).catch((err: unknown) => {
        logWarn(
          "control-channel",
          safeDiagnosticMessage`rtc_offer handler failed`,
          {
            channelId: frame.channel_id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
      return;
    case "rtc_ice":
      void handleRtcIce(frame).catch((err: unknown) => {
        logWarn(
          "control-channel",
          safeDiagnosticMessage`rtc host ICE handler failed`,
          {
            channelId: frame.channel_id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
      void handleRtcClientIce(frame).catch((err: unknown) => {
        logWarn(
          "control-channel",
          safeDiagnosticMessage`rtc client ICE handler failed`,
          {
            channelId: frame.channel_id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
      return;
    case "rtc_answer":
      void handleRtcAnswer(frame).catch((err: unknown) => {
        logWarn(
          "control-channel",
          safeDiagnosticMessage`rtc answer handler failed`,
          {
            channelId: frame.channel_id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
      return;
    case "rtc_nack":
      // This daemon is the fleet OFFERER: a serving peer refused our offer.
      handleRtcNack(frame);
      return;
    case "presence":
      updateMuxPeerCaps(frame.key_id, frame.active ? frame.caps : undefined);
      return;
    default:
      // Subscription tunnels + device sessions are mux-only (RTC → relay
      // binary mux). No JSON `tunnel_*`/`session_*` splice remains — an
      // unrecognized frame has nothing to do (partysocket owns reconnection).
      return;
  }
};

/**
 * Queue a binary frame for ordered delivery, tagged with the connection
 * generation that received it. After a reconnect/reset, a late Blob conversion
 * from the prior socket must not feed muxHostOnBytes for the successor.
 */
const enqueueBinaryFrame = (
  generation: number,
  read: () => Promise<Uint8Array>,
): void => {
  binaryFrameTail = binaryFrameTail
    .then(async () => {
      const bytes = await read();
      if (generation !== connectionGeneration) return;
      if (ws === null || ws.readyState !== ws.OPEN) return;
      muxHostOnBytes(bytes);
    })
    .catch((err: unknown) => {
      logWarn(
        "control-channel",
        safeDiagnosticMessage`blob binary frame read failed`,
        {
          err: err instanceof Error ? err.message : String(err),
        },
      );
    });
};

const onMessage = (data: unknown): void => {
  // Capture generation at receive time so async Blob reads cannot deliver into
  // a later connection after reconnect/reset.
  const generation = connectionGeneration;
  if (data instanceof ArrayBuffer) {
    enqueueBinaryFrame(generation, async () => new Uint8Array(data));
    return;
  }
  if (data instanceof Uint8Array) {
    enqueueBinaryFrame(generation, async () => data);
    return;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    enqueueBinaryFrame(generation, async () => new Uint8Array(data));
    return;
  }
  // partysocket defaults binaryType to "blob". We force "arraybuffer" on
  // open, but a reconnect race can still deliver a Blob once — convert
  // rather than drop (silent Blob drops hang fleet tunnels forever).
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    enqueueBinaryFrame(
      generation,
      async () => new Uint8Array(await data.arrayBuffer()),
    );
    return;
  }
  if (typeof data !== "string") return;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  const r = decodeFrame(json);
  if (r._tag === "Right") onFrame(r.right);
};

/** partysocket calls this before every (re)connect — fetch a fresh channel so
 *  each connection presents a fresh short-lived ticket. Throws when keyless /
 *  unreachable / over the device cap; partysocket backs off and retries. The
 *  daemon process keeps running either way — only the reconnect cadence changes. */
const channelUrl = async (): Promise<string> => {
  // Device-limit stand-down can apply even before the first successful open
  // (a new daemon can be over-cap at boot). Supersede stand-down only applies
  // after we've connected at least once. The two are mutually exclusive on a
  // given dial (device-limit never opens; supersede only fires after an open),
  // so prefer the active device-limit delay when present.
  const deviceLimitDelay = deviceLimitBackoff.nextDelayMs();
  if (deviceLimitDelay > 0) {
    await sleep(deviceLimitDelay);
  } else if (hasConnected) {
    // De-sync fleet reconnect storms (relay redeploy). First connect is
    // immediate; only re-dials are delayed. Normally that is plain jitter;
    // after a `4000 superseded` it is the escalating stand-down that ends a
    // same-key eviction war (partysocket's own backoff cannot — it resets on
    // every open, and a superseded dial DOES open).
    await sleep(supersedeBackoff.nextDelayMs());
  }
  let channel: Awaited<ReturnType<typeof fetchChannel>>;
  try {
    channel = await fetchChannel();
  } catch (err) {
    // Soft plan cap — not an auth failure, not a process-ending condition.
    // Escalate the stand-down and rethrow so partysocket retries after its
    // own short delay; the long sleep above applies on the NEXT dial.
    if (err instanceof DeviceLimitExceededError) {
      deviceLimitBackoff.noteDenied();
      logWarn(
        "control-channel",
        `device limit reached (${err.deviceCount}/${err.deviceCap} active devices) — standing down ~${Math.round(deviceLimitBackoff.standDownMs() / 1000)}s before retry`,
      );
    }
    throw err;
  }
  // Admitted — clear any prior over-cap stand-down so a later unrelated denial
  // restarts at the base delay rather than inheriting a multi-minute ceiling.
  deviceLimitBackoff.noteSuccess();
  ticket = channel.ticket;
  connectedWssOrigin = wssOrigin(channel.wss_url);
  // Thread the cloud-served ICE config (B2) into the RTC configs so both the
  // host (responder) and client (fleet offerer) prefer it over the default
  // STUN. A locally-set `OPENLLM_RTC_ICE_SERVERS` still wins (resolveIceServers
  // precedence); this just fills the surface when the daemon has no env value.
  const iceServers: ReadonlyArray<TIceServer> | null =
    channel.ice_servers ?? null;
  configureRtcHost({ send, iceServers });
  configureRtcClient({ send, iceServers });
  return channel.wss_url;
};

/** Origin of a ws(s) url (`wss://host[:port]`), or null when unparseable. */
export const wssOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Detect a relay that MOVED and reconnect to it. Relay sandboxes are
 * content-addressed (name = bundle hash), so a deploy whose relay bundle
 * changed provisions a NEW box at a new origin — but a daemon with a healthy
 * socket to the OLD box never re-fetches the channel on its own (partysocket
 * only calls `channelUrl` before a (re)connect), so it stays parked on the
 * superseded box while fresh dashboard connections land on the new one and
 * see this daemon as offline. Called on each healthy bootstrap tick
 * (`main.ts`), bounding that split-brain window to ~one tick (5 min).
 *
 * Best-effort: a failed channel fetch is swallowed (the next tick retries).
 * The fetch's side effects are free-or-useful — the minted ticket is a
 * stateless short-lived signature (unused when the origin matches), and the
 * cloud handler provisions + TTL-extends the CURRENT box, keeping the
 * successor warm before we (and the fleet) reconnect to it.
 *
 * Mid-command race: `reconnect()` can close the socket while a command runs;
 * its ack `send()` silently drops (socket not OPEN), the relay's
 * at-least-once redelivery re-pushes the command, and `commandResults` dedup
 * re-acks with the stored terminal result — no extra handling needed.
 *
 * `generation` fences a SCHEDULED check to the connection it was started
 * under: the socket can be replaced while `fetchChannel` is awaited (the
 * liveness check above only runs before it), and a stale check must not
 * `reconnect()` a newer healthy session. Callers without a generation (tests,
 * ad-hoc probes) keep the unfenced behavior.
 */
export const migrateIfRelayMoved = async (
  generation?: number,
): Promise<void> => {
  // Only act on a HEALTHY connection: while disconnected/reconnecting,
  // partysocket already re-fetches the channel itself — probing here would
  // double-dial and could hand the pending reconnect a stale ticket. Capture
  // the socket locally: `stopControlChannel` nulls the module binding, and a
  // shutdown racing the await below must not turn `ws.reconnect()` into a
  // null deref (a reconnect on a manually-closed partysocket is a no-op).
  const socket = ws;
  if (socket === null || socket.readyState !== socket.OPEN) return;
  const current = connectedWssOrigin;
  if (current === null) return;
  let freshUrl: string;
  try {
    // Probe — not a dial. Marks the request so cloud skips `daemon_connected`
    // (F6: otherwise every healthy daemon emits ~60/h from this 45s check).
    freshUrl = (await fetchChannel({ purpose: "probe" })).wss_url;
  } catch {
    return; // keyless / cloud unreachable — nothing to migrate to
  }
  const fresh = wssOrigin(freshUrl);
  if (fresh === null || fresh === current) return;
  if (generation !== undefined && generation !== connectionGeneration) return;
  logDebug("control-channel", "relay moved to a new box; reconnecting", {
    from: current,
    to: fresh,
  });
  socket.reconnect();
};

/** Start the WebSocket control loop (idempotent). */
export const startControlChannel = (): void => {
  setStatusPublishQueueSnapshot(() => statusPublishCoalescer.snapshot());
  setAuthSink({
    emit: emitAuthFrame,
    pushStatus: () => {
      void pushStatus(undefined, "auth-sink");
    },
  });
  if (ws !== null) return;
  logDebug("control-channel", "connecting over websocket");
  configureMuxHost({ send, sendBytes });
  configureRtcHost({ send });
  configureRtcClient({ send });
  const socket = new ReconnectingWebSocket(
    channelUrl,
    undefined,
    controlSocketOptions(),
  );
  ws = socket;
  // partysocket defaults binaryType to "blob". Fleet mux frames must arrive
  // as ArrayBuffer/Uint8Array — a Blob is dropped by onMessage and the peer
  // hang looks like "channel accepted, zero stream activity, idle reaped".
  // Set before open so the native socket inherits it (same fix as the browser
  // store in lib/stores/daemon-store.ts).
  socket.binaryType = "arraybuffer";
  socket.onopen = (): void => {
    logDebug(
      "control-channel",
      hasConnected ? "reconnected over websocket" : "connected over websocket",
    );
    hasConnected = true;
    supersedeBackoff.noteOpen(Date.now()); // starts the stability clock
    lastErrorReason = ""; // recovered — let the next outage log fresh
    lastCloseLine = "";
    helloSent = false; // a fresh connection — nothing may precede ITS hello
    connectionGeneration += 1;
    statusPublishCoalescer.abandon();
    // Re-assert on every open: partysocket re-applies its cached binaryType
    // to the native socket in _handleOpen, but be explicit after reconnect.
    socket.binaryType = "arraybuffer";
    resetRelayScopedState();
    daemonSessionId = null;
    supportsOrderedStatus = null;
    statusSeq = 0;
    // A fresh connection re-arms the traffic-driven presence refresh: the first
    // local request after a reconnect should be able to republish presence
    // rather than sit out the remainder of the previous socket's throttle.
    lastPresenceRefreshAt = 0;
    // Drop the previous generation's publish follow-up so a slow probe cannot
    // delay this session's first status behind dead work. In-flight compute
    // is generation-fenced in the coalescer (`canSend`).
    // Same for binary frames: a late Blob conversion from the prior socket
    // must not sit ahead of this connection's first mux bytes.
    binaryFrameTail = Promise.resolve();
    probesArmed = false;
    pendingWelcomeStatus = false;
    // Do not block registration on provider/CLI probes. The relay needs identity
    // first; welcome supplies this connection's session before status starts.
    // Ping only AFTER hello is on the wire — `send` drops non-hello frames until
    // then. Watcher + welcome `pushStatus` wait for the first pong (P1-A).
    helloSent = true;
    send({
      type: "hello",
      ticket,
      protocol_version: RELAY_PROTOCOL_VERSION,
      caps: currentDaemonCaps(),
    });
    flushAuthGap();
    heartbeat.start();
  };
  socket.onmessage = (ev: MessageEvent): void => {
    onMessage(ev.data);
  };
  socket.onerror = (ev): void => {
    // Retryable dial failures are debug-only; partysocket backs off and retries.
    // Read both partysocket's `.message` and native websocket `.error`.
    handleControlChannelSocketError(
      ev as { message?: unknown; error?: unknown } | null,
    );
  };
  socket.onclose = (ev): void => {
    stopWatcher();
    stopMigrationCheck();
    helloSent = false; // the next connection must lead with its own hello
    heartbeat.stop(); // disarm until the next open re-starts it
    const closeReason = ev.reason ?? "";
    supersedeBackoff.noteClose(ev.code, closeReason, Date.now());
    // `4000 superseded` = ANOTHER daemon connected with this same API key and
    // took the relay's one slot for it. Never a transient blip and never our
    // own reconnect (partysocket detaches the old socket's listeners before
    // dialing), so say what it is and how to fix it rather than logging a bare
    // close code. `channelUrl` applies the stand-down before the next dial.
    if (isSupersededClose(ev.code, closeReason)) {
      logWarn(
        "control-channel",
        `another OpenLLM daemon is connected with this API key and took over the relay slot; standing down ~${Math.round(supersedeBackoff.standDownMs() / 1000)}s before re-dialing (run one daemon per key, or mint a separate key per device)`,
      );
      return;
    }
    const clean = ev.code === 1000 || ev.code === 1001;
    // 4003 = relay rejected our ticket (usually a NEON_AUTH_COOKIE_SECRET
    // mismatch); 1006 = relay unreachable. 1000/1001 = relay cycling. partysocket
    // reconnects automatically in all cases.
    const line = `socket closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}${clean ? "" : " (reconnecting)"}`;
    // Automatic reconnects are debug-only, including transient 1006 closes.
    // Rejected tickets remain actionable warnings. Suppress unchanged retries.
    if (clean) {
      logDebug("control-channel", line);
    } else if (line !== lastCloseLine) {
      lastCloseLine = line;

      logDebug("control-channel", line);
      if (ev.code === 4003) handleControlChannelProtocolFailure();
    }
  };
};

/** Graceful-exit beacon: flip the key offline, then close. Best-effort. */
export const stopControlChannel = async (): Promise<void> => {
  lastPostedAuthStatus.clear();
  clearAuthGap();
  if (ws === null) return;
  stopWatcher();
  stopMigrationCheck();
  heartbeat.stop();
  if (ws.readyState === ws.OPEN) send({ type: "status", active: false });
  // Tear relay-scoped transports before nulling the socket so in-flight
  // tunnels/mux/unmounted RTC do not outlive process stop. Mounted RTC is
  // intentionally kept by resetUnmountedRtcSessions — full process exit
  // reaps those with the peer connections.
  resetRelayScopedState();
  ws.close(); // partysocket: a manual close() disables further reconnection
  ws = null;
  setAuthSink(null);
  setStatusPublishQueueSnapshot(null);
};
