import type { TRelayFrame } from "@openllmsh/protocol";
import {
  AGENT_CAP,
  MEDIA_HTTP_CAP,
  MEDIA_HTTP_VIDEO_CAP,
  MUX_CAP,
  REALTIME_DUPLEX_CAP,
  RTC_CAP,
  SEEDGATE_CAP,
  streamOpenKindOf,
  TEAM_RTC_CAP,
  TEAM_SERVE_CAP,
} from "@openllmsh/protocol";
import {
  channelIdToBytes,
  decodeChannelEnvelope,
  encodeChannelEnvelopeWithTag,
} from "@openllmsh/tunnel/channel-envelope";
import { decodeJsonPayload, encodeJsonPayload } from "@openllmsh/tunnel/codec";
import { noiseGrantBinding } from "@openllmsh/tunnel/device-grant";
import type { TDuplex, TMuxChannel, TMuxStream } from "@openllmsh/tunnel/mux";
import { createChannel } from "@openllmsh/tunnel/mux";
import {
  PEER_LINK_DEFAULTS,
  peerLinkFailureCache,
} from "@openllmsh/tunnel/peer-link";
import type {
  TNoiseStaticKey,
  TSecureAuthorizeContext,
} from "@openllmsh/tunnel/secure";
import {
  SecureChannelError,
  secureMuxStream,
  x25519RawFromSpkiB64,
} from "@openllmsh/tunnel/secure";
import type { TServeAgent, TServeTunnel } from "@openllmsh/tunnel/streams";
import {
  AGENT_SECURE_PROLOGUE_INFO,
  agentSecurePrologue,
  serveStream,
} from "@openllmsh/tunnel/streams";
import { daemonUserId } from "./config";
import {
  AGENT_PIN_REFUSALS,
  agentSessionRefusal,
  enforceSeedGate,
  getDeviceAccessPubkey,
} from "./device-access-verify";
import { daemonApiKeyId } from "./env";
import { daemonPublicKey, daemonX25519Dh } from "./keypair";
import { logDebug, logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import { serveMuxRealtime } from "./realtime-handler";
import {
  admitChannelTeamGrant,
  teamGrantFromStreamOpen,
} from "./team-grant-admit";

export { teamGrantFromStreamOpen } from "./team-grant-admit";

import { withTeamChannelScope } from "./team-request-context";
import { teamServeEnabled } from "./team-serve";
import {
  admitMuxTunnel,
  serveMuxTunnel,
  serveRtcTunnel,
} from "./tunnel-server";

/** Re-export so daemon tests keep a single import site with the mux host. */
export { AGENT_SECURE_PROLOGUE_INFO, agentSecurePrologue };

/**
 * Base capabilities advertised on hello/status.
 * `mux` (wire `"mux2"`) = binary mux over the relay WS with the channel-id
 * envelope on each binary message, which lets ONE relay socket carry several
 * concurrent channels; `rtc1` = WebRTC data-channel mux host and fleet consumer
 * offerer (RTC → relay mux). RTC data channels are NEVER enveloped — they carry
 * a single mux directly, with no relay hop. `seedgate1` is layered on when a
 * device-access pubkey is pinned, and `agent1` once an agent handler is
 * registered — see {@link currentDaemonCaps}.
 */
export const DAEMON_MUX_CAPS = [
  MUX_CAP,
  RTC_CAP,
  REALTIME_DUPLEX_CAP,
  MEDIA_HTTP_CAP,
  MEDIA_HTTP_VIDEO_CAP,
] as const;
// `REALTIME_DUPLEX_CAP` ("realtime1") ENABLED — the prior "not yet advertised"
// state is resolved. A live probe through this exact source path
// (`realtime-handler.ts` -> `realtime-session.ts` -> the Grok delegate's
// `credentialForRealtime`, dialing `wss://api.x.ai/v1/realtime`, driven by
// `tests/transport/realtime-live-local.e2e.ts`) completed a full session
// against the real vendor: `session.created -> session.updated ->
// response.created -> response.output_audio.delta (real non-zero PCM16) ->
// response.output_audio_transcript.delta -> response.done`, then a clean
// close. That same probe surfaced (and this change fixes) two real races the
// live path exposed that no unit double had caught: `realtime-handler.ts`
// silently dropped a client event sent before the local WS's async admission
// resolved, and `realtime-session.ts` threw `dispatch_failed` on the first
// `sendClientEvent` because the vendor WebSocket hadn't finished ITS OWN
// handshake yet. Both are now bounded queues, flushed in order once ready —
// see each file's regression tests. A peer that opens `kind:"realtime"`
// without seeing this cap still gets an honest
// `realtime_unsupported`/`realtime_refused` (old-peer-fail-before-OPEN stays
// a consumer-side check on `hasRealtimeDuplexCap`).

/**
 * `OPENLLM_RTC_DISABLE=1` withdraws `rtc1` only.
 *
 * The escape hatch for a host where the peer-to-peer path is a liability: on a
 * network that answers unreachable ICE candidates with ICMP, WebRTC produced a
 * stream of socket errors with nothing to show for it. Withdrawing the
 * capability means the browser never offers, so no ICE agent is built and no
 * UDP is sent — and everything still works over relay mux, one hop slower.
 *
 * Deliberately separate from `OPENLLM_MUX_DISABLE`, which withdraws the mux
 * transport wholesale and takes agent sessions down with it. That was the
 * only lever available the first time this was needed, and it was too blunt.
 */
const rtcDisabled = (): boolean => process.env.OPENLLM_RTC_DISABLE === "1";

/**
 * Registration seam for the agent dispatcher (owned by the agent workstream).
 * `null` restores the default, which resets every `kind:"agent"` OPEN with
 * `agent_unavailable`. Looked up per OPEN, so registering after the mux host
 * and RTC host are wired still takes effect.
 */
let agentStreamHandler: TServeAgent | null = null;

export const setAgentStreamHandler = (handler: TServeAgent | null): void => {
  agentStreamHandler = handler;
};

const unavailableAgentHandler: TServeAgent = (stream) => {
  stream.reset(
    encodeJsonPayload({
      code: "agent_unavailable",
      message: "agent sessions are not available on this device",
    }),
  );
};

/**
 * Live capability list — includes `seedgate1` when device access is
 * provisioned and `agent1` when an agent stream handler is registered
 * ({@link setAgentStreamHandler}). `agent1` stays off until something can
 * actually serve `kind:"agent"`, so the UI shows "update your device" rather
 * than an OPEN that can only reset `agent_unavailable`.
 */
export const currentDaemonCaps = (): string[] => {
  const caps: string[] = DAEMON_MUX_CAPS.filter(
    (cap) => cap !== RTC_CAP || !rtcDisabled(),
  );
  if (getDeviceAccessPubkey() !== null) caps.push(SEEDGATE_CAP);
  if (agentStreamHandler !== null) caps.push(AGENT_CAP);
  // Team serving: advertised when the local kill switch is on. Origin only
  // offers devices that list this cap; older daemons omit it.
  if (teamServeEnabled()) {
    caps.push(TEAM_SERVE_CAP);
    if (!rtcDisabled()) caps.push(TEAM_RTC_CAP);
  }
  return caps;
};

/**
 * How a serving mux channel admits each stream kind — the SAME table on the
 * relay-WS mux and on an RTC-mounted mux ({@link admitStreamKind}).
 *
 * - `open`      — served on any same-user channel the relay admitted
 *                 (request tunnelling, realtime voice). Origin and fleet
 *                 (`consumer:"daemon"`) peers live here and only here.
 * - `seedgated` — requires a BROWSER consumer that presented a verified vault
 *                 device grant whose `dpk` is this daemon's own X25519 key.
 *                 A `consumer:"daemon"` peer (origin, fleet) can never satisfy
 *                 it: it has no vault DEK, and an API key is not a grant. On
 *                 the relay mux an admitted `agent` stream must additionally
 *                 complete a Noise_IK handshake (responder = this daemon's
 *                 key) whose message-1 payload is a FRESH grant for the same
 *                 channel ({@link serveSecureAgentStream}). Refused with RESET
 *                 `unauthorized` otherwise.
 * - `retired`   — no longer served; dispatch resets it with a clear code
 *                 (`RETIRED_STREAM_KIND_RESET`).
 *
 * A kind missing from the table is treated as `seedgated` (fail closed), so a
 * new kind cannot ride an ungated channel by omission.
 */
export type TStreamKindGate = "open" | "seedgated" | "retired";

export const STREAM_KIND_GATES: Readonly<Record<string, TStreamKindGate>> = {
  tunnel: "open",
  realtime: "open",
  agent: "seedgated",
  session: "retired",
};

/** Gate for a raw OPEN kind; unknown or missing kinds fail closed. */
export const streamKindGateOf = (kind: string | null): TStreamKindGate =>
  kind !== null && Object.hasOwn(STREAM_KIND_GATES, kind)
    ? (STREAM_KIND_GATES[kind] ?? "seedgated")
    : "seedgated";

export type TStreamGateContext = {
  readonly transport: "relay" | "rtc";
  readonly channelId: string;
  /**
   * The channel carries a verified BROWSER device grant bound to this
   * daemon's key (`dpk`). Always false for a `consumer:"daemon"` peer.
   */
  readonly seedGated: boolean;
  /**
   * Channel was admitted via an origin-signed `team_grant`. Team channels
   * may open ONLY the `tunnel` stream kind — realtime/agent/others reset.
   */
  readonly teamGranted?: boolean;
};

/**
 * Apply {@link STREAM_KIND_GATES} to one OPEN. Returns false after RESETting
 * the stream `unauthorized` when the kind is `seedgated` and the channel is
 * not; `open` and `retired` kinds pass through (dispatch resets a retired
 * kind with its own clear code). Shared by the relay mux and RTC host.
 */
export const admitStreamKind = (
  stream: TMuxStream,
  kind: string | null,
  context: TStreamGateContext,
): boolean => {
  if (kind === "agent") {
    // Every agent OPEN, on either rung, so "the browser never opened" and
    // "the daemon refused" are distinguishable in the log.
    logDebug("agent", "agent stream open received", {
      channelId: context.channelId,
      transport: context.transport,
      seedGated: context.seedGated,
    });
  }
  // Team-grant channels are inference-only: refuse realtime/agent/session/
  // unknown kinds with a clear reason so a cross-user peer cannot widen
  // the blast radius past the granted model hop.
  if (context.teamGranted === true && kind !== "tunnel") {
    logWarn(
      "mux-host",
      safeDiagnosticMessage`stream open refused: team channel allows tunnel only`,
      {
        channelId: context.channelId,
        transport: context.transport,
        kind: kind ?? "unknown",
      },
    );
    stream.reset(
      encodeJsonPayload({ code: "unauthorized", reason: "team_tunnel_only" }),
    );
    return false;
  }
  if (streamKindGateOf(kind) !== "seedgated") return true;
  // Re-checked per OPEN: a channel / RTC session admitted while the device was
  // anchored must not keep serving agent streams after a signed remote
  // disable or a local `openllm daemon device disable` (both blank the anchor).
  const refusal = context.seedGated ? agentSessionRefusal() : null;
  if (context.seedGated && refusal === null) return true;
  logWarn(
    "mux-host",
    safeDiagnosticMessage`stream open refused: channel not seed-gated`,
    {
      channelId: context.channelId,
      transport: context.transport,
      kind: kind ?? "unknown",
      ...(refusal === null ? {} : { reason: refusal }),
    },
  );
  stream.reset(
    encodeJsonPayload(
      refusal === null ? { code: "unauthorized" } : { code: refusal },
    ),
  );
  return false;
};

/**
 * Require each inference OPEN on a team-admitted channel to carry its own
 * grant. The tunnel server verifies that fresh grant (signature, expiry,
 * consumer/device/model/cap scope) before dispatch. The channel grant is
 * admission-only, so a long-lived channel never pins a short-lived token.
 * Shared by relay-mux and RTC hosts.
 */
export const admitTeamTunnelGrant = (
  stream: TMuxStream,
  decodedOpen: unknown,
  context: {
    readonly channelId: string;
    readonly transport: "relay" | "rtc";
    readonly teamGranted: boolean;
    readonly teamGrantToken: string | null;
  },
): boolean => {
  if (!context.teamGranted) return true;
  const openGrant = teamGrantFromStreamOpen(decodedOpen);
  if (openGrant !== null && context.teamGrantToken !== null) {
    logInfo("mux-host", "team stream open received", {
      channelId: context.channelId,
      transport: context.transport,
    });
    return true;
  }
  logWarn(
    "mux-host",
    safeDiagnosticMessage`stream open refused: team tunnel missing or mismatched grant`,
    {
      channelId: context.channelId,
      transport: context.transport,
      hasOpenGrant: openGrant !== null,
    },
  );
  stream.reset(
    encodeJsonPayload({
      code: "unauthorized",
      reason: "team_grant_required",
    }),
  );
  return false;
};

/** This daemon's long-lived X25519 identity as a Noise static key. */
const daemonNoiseStaticKey = (): TNoiseStaticKey => {
  const publicKey = x25519RawFromSpkiB64(daemonPublicKey());
  if (publicKey === null) {
    throw new Error("daemon identity is not an X25519 SPKI key");
  }
  return {
    publicKey,
    dh: async (remotePublic) => daemonX25519Dh(remotePublic),
  };
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Noise `authorize` for a relay-mux agent stream. Admits only when the
 * channel is STILL seed-gated (a browser `channel_open` grant with our `dpk`)
 * AND the message-1 payload is a fresh device grant — its own nonce, the same
 * `cid`, `aud` and `dpk` = this daemon's key, signed for use `noise` and bound
 * to the initiator's Noise static key. The relay sees every `channel_open`
 * grant in plaintext (and can withhold one before its nonce is spent), so
 * only the use + binding stop it replaying one here as its own initiator.
 */
const authorizeAgentHandshake =
  (channelId: string, isGated: () => boolean) =>
  ({ payload, remoteStatic }: TSecureAuthorizeContext): Uint8Array | null => {
    if (!isGated()) {
      logInfo("mux-host", "agent handshake refused: channel not seed-gated", {
        channelId,
      });
      return null;
    }
    let grant: string;
    try {
      grant = strictUtf8.decode(payload);
    } catch {
      return null;
    }
    // A `noise` grant bound to the initiator's static key: the relay sees the
    // `channel_open` grant in plaintext, and a harvested grant of any other
    // use, or one bound to another initiator, is refused.
    const gate = enforceSeedGate(grant, {
      use: "noise",
      bind: noiseGrantBinding(remoteStatic),
      keyId: daemonApiKeyId(),
      cid: channelId,
      aud: daemonPublicKey(),
      requireDpk: true,
    });
    if (gate.mode === "reject") {
      logInfo("mux-host", "agent handshake refused: grant", {
        channelId,
        reason: gate.reason,
      });
      return null;
    }
    return new Uint8Array();
  };

/**
 * Relay-mux agent rung: run the Noise_IK responder on the raw stream, then
 * hand the E2E-encrypted stream to `handler`. Starts synchronously (the
 * wrapper must subscribe to DATA before the peer's message 1 can land). A
 * refused or failed handshake RESETs `unauthorized` inside
 * {@link secureMuxStream}; the agent handler is never reached.
 */
export const serveSecureAgentStream = (
  stream: TMuxStream,
  open: Uint8Array,
  options: {
    readonly channelId: string;
    readonly isGated: () => boolean;
    readonly handler: (stream: TMuxStream, open: Uint8Array) => void;
  },
): void => {
  let localStatic: TNoiseStaticKey;
  try {
    localStatic = daemonNoiseStaticKey();
  } catch (err) {
    logWarn("mux-host", safeDiagnosticMessage`agent handshake unavailable`, {
      channelId: options.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    stream.reset(encodeJsonPayload({ code: "unauthorized" }));
    return;
  }
  void secureMuxStream(stream, {
    role: "responder",
    localStatic,
    prologue: agentSecurePrologue(options.channelId, stream.id),
    authorize: authorizeAgentHandshake(options.channelId, options.isGated),
  }).then(
    (secured) => {
      options.handler(secured, open);
    },
    (err: unknown) => {
      logInfo("mux-host", "agent handshake failed", {
        channelId: options.channelId,
        code: err instanceof SecureChannelError ? err.code : "unknown",
      });
    },
  );
};

/**
 * One live relay-WS mux channel. Several may coexist (`mux2`): a serving
 * channel the daemon accepted (`side: "daemon"`), or a consumer channel it
 * opened to a fleet peer (`side: "consumer"`, keyed by that peer's `keyId`).
 */
type TRelayChannel = {
  readonly channelId: string;
  /**
   * Cached 16-byte mux2 tag — avoids per-frame UUID string→bytes. Filled on
   * the first outbound binary frame (admission can register before any send).
   */
  channelTag: Uint8Array | null;
  readonly keyId: string | null;
  /** Relay-stamped peer role of the latest (re)open; `null` on consumer side. */
  consumer: "browser" | "daemon" | null;
  readonly channel: TMuxChannel;
  /**
   * Seed gate outcome for this channel, re-evaluated on every (re)open. True
   * ONLY for a browser consumer whose `channel_open` grant verified with a
   * `dpk` equal to this daemon's key — never for `consumer:"daemon"`. Which
   * stream kinds require it is {@link STREAM_KIND_GATES}.
   */
  seedGated: boolean;
  /** True when this channel was admitted with a verified `team_grant`. */
  teamGranted: boolean;
  /**
   * Admission token for this team channel. Every tunnel OPEN must carry a
   * non-empty fresh `headers.team_grant`; it need not equal this token, but
   * the tunnel server verifies it against the relay-stamped team scope.
   */
  teamGrantToken: string | null;
  /** Relay-stamped scope from the admission grant. */
  teamScope: {
    readonly consumer: string;
    readonly teamId: string;
    readonly deviceKeyId: string;
  } | null;
  /** The mux's durable inbound callback, installed exactly once at construction. */
  muxSink: ((bytes: Uint8Array | null) => void) | null;
  /** The relay binding currently allowed to deliver to {@link muxSink}. */
  sink: ((bytes: Uint8Array | null) => void) | null;
  lastActivityAt: number;
};

let sendFrame: ((frame: TRelayFrame) => void) | null = null;
let sendBinary: ((bytes: Uint8Array) => void) | null = null;
let relayBufferedAmount: (() => number) | null = null;
let onRelayDrain: ((callback: () => void) => () => void) | null = null;
/** Live channels by relay-assigned channel id. */
const channels = new Map<string, TRelayChannel>();
const peerCaps = new Map<string, ReadonlySet<string>>();
const opening = new Map<
  string,
  {
    resolve: (channel: TMuxChannel | null) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly channelId: string;
    readonly relayKeyId: string;
    readonly teamGrant?: string;
  }
>();
const MUX_ACK_TIMEOUT_MS = PEER_LINK_DEFAULTS.muxAckSameUserMs;
export const MUX_CHANNEL_IDLE_TTL_MS = PEER_LINK_DEFAULTS.idleTtlMs;
const MUX_CHANNEL_REAPER_INTERVAL_MS = 10_000;
const DEMUX_WARNING_THROTTLE_MS = 5_000;
let muxAckTimeoutMs: number = MUX_ACK_TIMEOUT_MS;
// Overridable via configureMuxChannelIdleTtl; default matches the export.
let muxChannelIdleTtlMs: number = MUX_CHANNEL_IDLE_TTL_MS;
let channelReaper: ReturnType<typeof setInterval> | null = null;
const lastDemuxWarningAt = new Map<string, number>();

const touchChannel = (record: TRelayChannel): void => {
  record.lastActivityAt = Date.now();
};

const logDemuxWarning = (
  reason: string,
  meta: Record<string, unknown>,
): void => {
  const now = Date.now();
  const last = lastDemuxWarningAt.get(reason) ?? 0;
  if (now - last < DEMUX_WARNING_THROTTLE_MS) return;
  lastDemuxWarningAt.set(reason, now);
  logWarn("mux-host", safeDiagnosticMessage`relay mux frame dropped`, {
    reason,
    channelCount: channels.size,
    ...meta,
  });
};

const reapIdleChannels = (): void => {
  const now = Date.now();
  for (const record of [...channels.values()]) {
    // Consumer records are relay-owned channels opened to fleet peers. Closing
    // one locally without a matching relay close leaves the peer bound to it —
    // still true for serving records if we only tear the local map: the peer
    // keeps a live consumer half and the next hop reuses a zombie channel.
    // Always notify the relay so both ends free the id.
    if (record.keyId !== null) continue;
    if (record.channel.openStreamCount() > 0) continue;
    if (now - record.lastActivityAt < muxChannelIdleTtlMs) continue;
    logInfo("mux-host", "mux channel reaped: idle", {
      channelId: record.channelId,
      idleMs: now - record.lastActivityAt,
    });
    // Tell the relay first so the consumer is unbound before we drop local
    // state (closeChannelFromRelay only mutates this daemon's map).
    sendFrame?.({
      type: "channel_close",
      channel_id: record.channelId,
      reason: "done",
    });
    closeChannelFromRelay({
      channel_id: record.channelId,
      reason: "done",
    });
  }
};

const ensureChannelReaper = (): void => {
  if (channelReaper !== null) return;
  channelReaper = setInterval(
    reapIdleMuxChannels,
    MUX_CHANNEL_REAPER_INTERVAL_MS,
  );
  channelReaper.unref();
};

/** Run one idle-channel reaper pass (same work as the interval tick). */
export const reapIdleMuxChannels = (): void => reapIdleChannels();

/** Configure idle TTL for open mux channels; `null` restores the default. */
export const configureMuxChannelIdleTtl = (ttlMs: number | null): void => {
  muxChannelIdleTtlMs = ttlMs ?? MUX_CHANNEL_IDLE_TTL_MS;
};

/** Configure channel-ack timeout; `null` restores the default. */
export const configureMuxAckTimeout = (timeoutMs: number | null): void => {
  muxAckTimeoutMs = timeoutMs ?? MUX_ACK_TIMEOUT_MS;
};

const readPositiveMsEnv = (name: string): number | null => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
};

// Optional ops knobs — same configure path tests use for short TTLs.
configureMuxChannelIdleTtl(
  readPositiveMsEnv("OPENLLM_MUX_CHANNEL_IDLE_TTL_MS"),
);
configureMuxAckTimeout(readPositiveMsEnv("OPENLLM_MUX_ACK_TIMEOUT_MS"));

/** Latest relay-advertised peer caps, used by the fleet RTC path. */
export const getMuxPeerCaps = (
  keyId: string,
): ReadonlySet<string> | undefined => peerCaps.get(keyId);

export const updateMuxPeerCaps = (
  keyId: string,
  caps: readonly string[] | undefined,
): void => {
  if (caps === undefined) peerCaps.delete(keyId);
  else peerCaps.set(keyId, new Set(caps));
  peerLinkFailureCache.clear(keyId);
};

/**
 * Replace every peer's caps with a relay snapshot. A snapshot is the relay's
 * whole current view, so open failures remembered against the previous view
 * go with it — the next open re-asks instead of waiting out a stale cache.
 */
export const replaceMuxPeerCaps = (
  caps: Readonly<Record<string, readonly string[]>> | undefined,
): void => {
  peerCaps.clear();
  peerLinkFailureCache.clear();
  if (caps === undefined) return;
  for (const [keyId, values] of Object.entries(caps))
    updateMuxPeerCaps(keyId, values);
};

/** The consumer channel already open to `keyId`, if any. */
const consumerChannelFor = (
  keyId: string,
  teamId?: string,
): TRelayChannel | undefined => {
  const channelKey = teamId === undefined ? keyId : `${keyId}\u0000${teamId}`;
  for (const channel of channels.values())
    if (channel.keyId === channelKey) return channel;
  return undefined;
};

const failOpen = (keyId: string, reason?: string): void => {
  const pending = opening.get(keyId);
  if (pending === undefined) return;
  opening.delete(keyId);
  clearTimeout(pending.timer);
  peerLinkFailureCache.set(keyId, "mux", "transport");
  sendFrame?.({
    type: "channel_close",
    channel_id: pending.channelId,
    ...(reason === undefined ? {} : { reason }),
  });
  pending.resolve(null);
};

export type TMuxChannelOptions = {
  /** A team channel is distinct from the same-user fleet channel to this device. */
  readonly teamId?: string;
  /** Admission-only grant; every tunnel OPEN carries a fresh grant separately. */
  readonly teamGrant?: string;
};

const channelLookupKey = (keyId: string, teamId?: string): string =>
  teamId === undefined ? keyId : `${keyId}\u0000${teamId}`;

/** Whether the consumer already has a live relay-mux channel to this scope. */
export const hasMuxChannelTo = (
  keyId: string,
  options?: TMuxChannelOptions,
): boolean => consumerChannelFor(keyId, options?.teamId) !== undefined;

/** Consumer-side negotiation. `mux2` permits separate fleet and team channels. */
export const muxChannelTo = async (
  keyId: string,
  options?: TMuxChannelOptions,
): Promise<TMuxChannel | null> => {
  if (process.env.OPENLLM_MUX_DISABLE === "1") return null;
  const caps = peerCaps.get(keyId);
  if (caps === undefined || !caps.has(MUX_CAP)) return null;
  const lookupKey = channelLookupKey(keyId, options?.teamId);
  if (peerLinkFailureCache.has(lookupKey, "mux")) return null;
  const existing = consumerChannelFor(keyId, options?.teamId);
  if (existing !== undefined) return existing.channel;
  const pending = opening.get(lookupKey);
  if (pending !== undefined)
    return new Promise((resolve) => {
      const previousResolve = pending.resolve;
      pending.resolve = (channel) => {
        previousResolve(channel);
        resolve(channel);
      };
    });
  const send = sendFrame;
  const binary = sendBinary;
  if (send === null || binary === null) return null;
  const channelId = crypto.randomUUID();
  return new Promise<TMuxChannel | null>((resolve) => {
    const timer = setTimeout(
      () => failOpen(lookupKey, "consumer_gone"),
      muxAckTimeoutMs,
    );
    opening.set(lookupKey, {
      resolve,
      timer,
      channelId,
      relayKeyId: keyId,
      ...(options?.teamGrant === undefined
        ? {}
        : { teamGrant: options.teamGrant }),
    });
    send({
      type: "channel_open",
      channel_id: channelId,
      key_id: keyId,
      consumer: "daemon",
      ...(options?.teamGrant === undefined
        ? {}
        : { team_grant: options.teamGrant }),
    });
  });
};

export const handleChannelOpenAck = (frame: {
  readonly channel_id: string;
  readonly ok: boolean;
}): void => {
  const entry = [...opening.entries()].find(
    ([, pending]) => pending.channelId === frame.channel_id,
  );
  if (entry === undefined) return;
  const [keyId] = entry;
  if (!frame.ok) {
    failOpen(keyId);
    return;
  }
  const pending = opening.get(keyId);
  if (pending === undefined) return;
  const binary = sendBinary;
  if (binary === null) {
    opening.delete(keyId);
    clearTimeout(pending.timer);
    peerLinkFailureCache.set(keyId, "mux", "transport");
    sendFrame?.({
      type: "channel_close",
      channel_id: pending.channelId,
      reason: "channel_exists",
    });
    pending.resolve(null);
    return;
  }
  opening.delete(keyId);
  clearTimeout(pending.timer);
  const record = registerChannel(pending.channelId, keyId, "consumer");
  pending.resolve(record.channel);
};

/**
 * (Re)attach the relay binding onto the channel's durable mux sink. Fresh
 * registration AND a channel_open rebind share this: the mux callback is
 * installed exactly once at channel construction, so swapping the relay-facing
 * {@link TRelayChannel.sink} wrapper never disturbs attached session streams.
 */
const bindSink = (record: TRelayChannel): void => {
  const muxSink = record.muxSink;
  record.sink =
    muxSink === null
      ? null
      : (bytes) => {
          touchChannel(record);
          muxSink(bytes);
        };
};

/**
 * Register a relay-WS channel (both consumer + serving sides). The duplex
 * envelopes every outbound message with the channel id and reads its inbound
 * bytes from the shared {@link muxHostOnBytes} demux — so several channels can
 * share the one relay socket.
 */
const registerChannel = (
  channelId: string,
  keyId: string | null,
  side: "consumer" | "daemon",
): TRelayChannel => {
  let muxSink: ((bytes: Uint8Array | null) => void) | null = null;
  let record: TRelayChannel | null = null;
  // Lazily cache the 16-byte mux2 tag on first send. Admission / seed-gate
  // paths register a channel before any binary frame; forcing UUID parse at
  // register time rejected otherwise-valid control-plane channel ids.
  const tagOf = (): Uint8Array => {
    if (record === null) return channelIdToBytes(channelId);
    if (record.channelTag === null) {
      record.channelTag = channelIdToBytes(channelId);
    }
    return record.channelTag;
  };
  const duplex = relayDuplex(
    (bytes) => sendBinary?.(encodeChannelEnvelopeWithTag(tagOf(), bytes)),
    (callback) => {
      muxSink = callback;
      if (record !== null) {
        record.muxSink = callback;
        bindSink(record);
      }
    },
    relayBufferedAmount ?? undefined,
    onRelayDrain ?? undefined,
  );
  const channel = createChannel({
    duplex,
    side,
    ...(side === "daemon"
      ? {
          onStream: (stream, open) => {
            if (record !== null) touchChannel(record);
            const decodedOpen = decodeJsonPayload(open);
            const kind = streamOpenKindOf(decodedOpen);
            const isGated = (): boolean =>
              record !== null &&
              record.consumer === "browser" &&
              record.seedGated;
            if (
              !admitStreamKind(stream, kind, {
                transport: "relay",
                channelId,
                seedGated: isGated(),
                teamGranted: record?.teamGranted === true,
              })
            ) {
              return;
            }
            if (
              kind === "tunnel" &&
              !admitTeamTunnelGrant(stream, decodedOpen, {
                channelId,
                transport: "relay",
                teamGranted: record?.teamGranted === true,
                teamGrantToken: record?.teamGrantToken ?? null,
              })
            ) {
              return;
            }
            const handler = streamHandler ?? serveMuxOnStream;
            if (kind === "agent") {
              // The relay sees every byte of this rung: run Noise_IK first so
              // the agent handler only ever sees an E2E-encrypted stream.
              serveSecureAgentStream(stream, open, {
                channelId,
                isGated,
                handler,
              });
              return;
            }
            const scope = record?.teamScope ?? null;
            if (scope === null) {
              handler(stream, open);
            } else {
              withTeamChannelScope(scope, () => handler(stream, open));
            }
          },
        }
      : {}),
    onClose: () => {
      if (record !== null && channels.get(channelId) === record) {
        channels.delete(channelId);
      }
      if (record !== null) {
        record.muxSink = null;
        record.sink = null;
      }
    },
  });
  record = {
    channel,
    channelId,
    channelTag: null,
    keyId,
    consumer: side === "daemon" ? "browser" : null,
    seedGated: false,
    teamGranted: false,
    teamGrantToken: null,
    teamScope: null,
    muxSink,
    sink: null,
    lastActivityAt: Date.now(),
  };
  bindSink(record);
  channels.set(channelId, record);
  return record;
};

/** Host transport seam: control-channel owns the WebSocket, this module owns mux state. */
export const relayDuplex = (
  sendBytes: (bytes: Uint8Array) => void,
  registerOnBytes: (callback: (bytes: Uint8Array | null) => void) => void,
  bufferedAmount?: () => number,
  onDrain?: (callback: () => void) => () => void,
): TDuplex => ({
  send: sendBytes,
  bufferedAmount,
  highWaterMark: bufferedAmount === undefined ? undefined : 1024 * 1024,
  onDrain,
  onBytes: registerOnBytes,
  close: () => registerOnBytes(() => {}),
});

let streamHandler: typeof serveMuxOnStream | null = null;

export const configureMuxHost = (options: {
  readonly send: (frame: TRelayFrame) => void;
  readonly sendBytes: (bytes: Uint8Array) => void;
  readonly bufferedAmount?: () => number;
  readonly onDrain?: (callback: () => void) => () => void;
  /** Stream handler for relay mux channels; defaults to {@link serveMuxOnStream}. */
  readonly onStream?: typeof serveMuxOnStream;
}): void => {
  sendFrame = options.send;
  streamHandler = options.onStream ?? null;
  sendBinary = options.sendBytes;
  relayBufferedAmount = options.bufferedAmount ?? null;
  onRelayDrain = options.onDrain ?? null;
  // The reaper lives with the host lifecycle, not the relay socket: the shared
  // persistent relay sandbox keeps sockets up for days, so relay-socket death
  // (resetAllChannels) can no longer be the only channel cleanup.
  ensureChannelReaper();
};

/** Whether any relay mux channel carries an open stream (a request in flight). */
export const muxStreamsInFlight = (): boolean => {
  for (const record of channels.values())
    if (record.channel.openStreamCount() > 0) return true;
  return false;
};

/** Live mux channel for `channelId`, if still open. */
export const getMuxChannel = (channelId: string): TMuxChannel | undefined =>
  channels.get(channelId)?.channel;

/**
 * Build the daemon's mux stream handler over a tunnel server — the shared
 * OPEN dispatcher for every daemon-side mux channel (relay WS + RTC). Pure;
 * the production handler is {@link serveMuxOnStream}. `agent` overrides the
 * registered handler (tests); otherwise {@link setAgentStreamHandler}'s
 * handler is looked up per OPEN. A legacy PTY `kind:"session"` OPEN is reset
 * by `serveStream` with `pty_unsupported`.
 */
export const createMuxOnStream = ({
  tunnel,
  agent,
}: {
  readonly tunnel: TServeTunnel;
  readonly agent?: TServeAgent;
}): ReturnType<typeof serveStream> =>
  serveStream({
    tunnel,
    realtime: (stream, open) => serveMuxRealtime(stream, open),
    agent: (stream, open) =>
      (agent ?? agentStreamHandler ?? unavailableAgentHandler)(stream, open),
    admitTunnel: () => admitMuxTunnel(),
    invalidOpenCode: "invalid_tunnel",
  });

export const serveMuxOnStream = createMuxOnStream({
  // Keep the tunnel-server reference lazy: its production dispatcher reaches
  // the control channel, which imports this host during daemon initialization.
  tunnel: (open, body, signal) => serveMuxTunnel(open, body, signal),
});

/** RTC uses the same OPEN policy but preserves its transport in diagnostics. */
export const serveRtcOnStream = createMuxOnStream({
  tunnel: (open, body, signal) => serveRtcTunnel(open, body, signal),
});

/**
 * Seed gate — `seedgated` kinds only ({@link STREAM_KIND_GATES}: agent
 * streams), never request tunnelling. ONLY a browser consumer presenting a
 * vault-signed grant bound to this daemon's key (`dpk`) is gated. A
 * `consumer:"daemon"` peer (origin, fleet) is never gated — its relay
 * identity is an API key, which is exactly what the seed gate exists to not
 * trust; it keeps `tunnel`/`realtime` only. The result is recorded on the
 * channel; the open is never refused for it. Shared by fresh opens AND
 * rebinds.
 */
/**
 * Strict-gate refusals that still leave a valid grant usable for the
 * tunnel/realtime kinds — the same set the RTC offer gate degrades on
 * (`rtc-host.ts`). They fail before the grant's nonce is spent.
 */
const MUX_TUNNEL_ONLY_REASONS: ReadonlySet<string> = new Set([
  "dpk_missing",
  ...AGENT_PIN_REFUSALS,
]);

/** `ok` = agent-eligible; `tunnel_only` = valid grant, agent refused. */
type TSeedGateOutcome = "ok" | "tunnel_only" | "reject";

/**
 * The strict (agent-eligible) gate. With `allowTunnelOnly`, a grant refused
 * only for a tunnel-only reason is re-checked without the agent requirements;
 * that second check spends the grant's nonce, so only a rebind asks for it.
 */
const seedGateOutcomeOf = (
  frame: {
    readonly channel_id: string;
    readonly grant?: string;
    readonly consumer?: "browser" | "daemon";
  },
  allowTunnelOnly: boolean,
): TSeedGateOutcome => {
  if (frame.consumer === "daemon") return "reject";
  const expect = {
    use: "channel" as const,
    keyId: daemonApiKeyId(),
    cid: frame.channel_id,
    aud: daemonPublicKey(),
  };
  const gate = enforceSeedGate(frame.grant, { ...expect, requireDpk: true });
  if (gate.mode !== "reject") return "ok";
  logInfo("mux-host", "channel_open not seed-gated (agent refused)", {
    channelId: frame.channel_id,
    reason: gate.reason,
  });
  if (!allowTunnelOnly || !MUX_TUNNEL_ONLY_REASONS.has(gate.reason)) {
    return "reject";
  }
  return enforceSeedGate(frame.grant, expect).mode === "ok"
    ? "tunnel_only"
    : "reject";
};

const seedGateOf = (frame: {
  readonly channel_id: string;
  readonly grant?: string;
  readonly consumer?: "browser" | "daemon";
}): boolean => seedGateOutcomeOf(frame, false) === "ok";

/** Accept the relay-authorized channel. `mux2` allows several concurrent. */
export const acceptChannel = (frame: {
  readonly channel_id: string;
  readonly grant?: string;
  readonly team_grant?: string;
  readonly peer_user_id?: string;
  readonly consumer?: "browser" | "daemon";
}): void => {
  // An admission throw must still answer the peer, or its open hangs.
  acceptChannelAsync(frame).catch((err: unknown) => {
    logWarn("mux-host", safeDiagnosticMessage`channel_open admission threw`, {
      channelId: frame.channel_id,
      err: err instanceof Error ? err.message : String(err),
    });
    sendFrame?.({
      type: "channel_open_ack",
      channel_id: frame.channel_id,
      ok: false,
      error: "unauthorized",
    });
  });
};

const acceptChannelAsync = async (frame: {
  readonly channel_id: string;
  readonly grant?: string;
  readonly team_grant?: string;
  readonly peer_user_id?: string;
  readonly consumer?: "browser" | "daemon";
}): Promise<void> => {
  const send = sendFrame;
  const binary = sendBinary;
  if (send === null || binary === null) return;
  if (process.env.OPENLLM_MUX_DISABLE === "1") {
    // Every reject is logged. A silently-refused channel_open is invisible on
    // the daemon and indistinguishable, from the browser, from a device that
    // never answered — which is exactly the shape of the hardest transport
    // bugs to diagnose.
    logWarn(
      "mux-host",
      safeDiagnosticMessage`channel_open rejected: mux disabled`,
      {
        channelId: frame.channel_id,
      },
    );
    send({
      type: "channel_open_ack",
      channel_id: frame.channel_id,
      ok: false,
      error: "not_capable",
    });
    return;
  }
  // Team admission. A new relay stamps peer_user_id (authenticated consumer).
  // When that differs from our bootstrap user_id, a valid team_grant is
  // REQUIRED. Absent peer_user_id (older relay) → today's behaviour: verify
  // a present grant, otherwise trust the relay not to forward grant-less
  // cross-user opens. Model/cap run per request.
  const ownUserId = daemonUserId();
  const peerUserId =
    frame.peer_user_id !== undefined && frame.peer_user_id.length > 0
      ? frame.peer_user_id
      : null;
  const hasGrant =
    frame.team_grant !== undefined && frame.team_grant.length > 0;
  const crossUser =
    peerUserId !== null && ownUserId !== null && peerUserId !== ownUserId;
  let teamGranted = false;
  let teamScope: {
    readonly consumer: string;
    readonly teamId: string;
    readonly deviceKeyId: string;
  } | null = null;
  if (crossUser) {
    if (!hasGrant || frame.team_grant === undefined) {
      logWarn("mux-host", "channel_open cross-user without team grant", {
        channelId: frame.channel_id,
      });
      send({
        type: "channel_open_ack",
        channel_id: frame.channel_id,
        ok: false,
        error: "unauthorized",
      });
      return;
    }
    const decision = await admitChannelTeamGrant(frame.team_grant, peerUserId);
    if (!decision.ok) {
      logWarn("mux-host", "channel_open team grant refused", {
        channelId: frame.channel_id,
        reason: decision.reason,
      });
      send({
        type: "channel_open_ack",
        channel_id: frame.channel_id,
        ok: false,
        error: "unauthorized",
      });
      return;
    }
    teamGranted = true;
    teamScope = {
      consumer: decision.grant.consumer,
      teamId: decision.grant.team_id,
      deviceKeyId: decision.grant.device_key_id,
    };
  } else if (hasGrant && frame.team_grant !== undefined) {
    // A same-user channel is never a team channel. Accepting a team grant here
    // would let a caller turn an authenticated fleet channel into team traffic.
    logWarn("mux-host", "channel_open same-user team grant refused", {
      channelId: frame.channel_id,
    });
    send({
      type: "channel_open_ack",
      channel_id: frame.channel_id,
      ok: false,
      error: "unauthorized",
    });
    return;
  }
  const existing = channels.get(frame.channel_id);
  if (existing !== undefined && existing.muxSink !== null) {
    if (existing.keyId !== null) {
      // A consumer-side channel id is OURS — a peer re-opening it is a
      // protocol bug, not a reconnect. Keep the refusal for that narrow case.
      logWarn(
        "mux-host",
        safeDiagnosticMessage`channel_open rejected: duplicate id`,
        {
          channelId: frame.channel_id,
        },
      );
      send({
        type: "channel_open_ack",
        channel_id: frame.channel_id,
        ok: false,
        error: "channel_exists",
      });
      return;
    }
    // REBIND: the browser derives its channel id deterministically and the
    // relay re-forwards it after a reconnect, so a same-id re-open of a live
    // serving channel is the consumer re-attaching — NOT a collision. Swap the
    // inbound sink onto the EXISTING channel (its attached streams survive
    // untouched; agent sessions are durable and never respawned here) and
    // re-ack so the peer's open settles. The rebind re-evaluates the seed gate.
    // A grant-less consumer must not inherit a gated channel's live agent
    // streams: refuse the downgrade, leave the incumbent alone.
    // Losing the local device anchor turns agent sessions off but does not
    // invalidate a control-signed browser grant for the tunnel/realtime kinds,
    // so a tunnel-only refusal still authorizes this rebind. The channel is
    // then left un-gated below, which keeps agent streams refused.
    const outcome = seedGateOutcomeOf(frame, existing.seedGated);
    const gated = outcome === "ok";
    if (existing.seedGated && outcome === "reject") {
      send({
        type: "channel_open_ack",
        channel_id: frame.channel_id,
        ok: false,
        error: "unauthorized",
      });
      return;
    }
    existing.seedGated = gated;
    existing.teamGranted = teamGranted;
    existing.teamGrantToken = teamGranted ? (frame.team_grant ?? null) : null;
    existing.teamScope = teamScope;
    existing.consumer = frame.consumer ?? "browser";
    bindSink(existing);
    touchChannel(existing);
    logInfo("mux-host", "channel_open rebind", {
      channelId: frame.channel_id,
      consumer: frame.consumer ?? "browser",
    });
    send({ type: "channel_open_ack", channel_id: frame.channel_id, ok: true });
    return;
  }
  // A map-resident record with a null mux sink is a closed shell that never
  // got reaped — drop it so the re-open registers fresh below.
  if (existing !== undefined) channels.delete(frame.channel_id);
  const seedGated = seedGateOf(frame);
  const record = registerChannel(frame.channel_id, null, "daemon");
  record.seedGated = seedGated;
  record.teamGranted = teamGranted;
  record.teamGrantToken = teamGranted ? (frame.team_grant ?? null) : null;
  record.teamScope = teamScope;
  record.consumer = frame.consumer ?? "browser";
  logInfo("mux-host", "channel_open accepted", {
    channelId: frame.channel_id,
    consumer: frame.consumer ?? "browser",
  });
  send({ type: "channel_open_ack", channel_id: frame.channel_id, ok: true });
};

/**
 * The relay says this channel's peer is gone (`consumer_gone` when a browser
 * socket dies, `daemon_gone` for a serving peer). Tear the local half down so
 * its streams RESET — which detaches any agent session bound to them — and so the
 * next `channel_open` is not refused `channel_exists` by a channel whose other
 * end no longer exists. Previously this frame had no handler at all: the stale
 * channel survived until the daemon's OWN relay socket cycled, stranding every
 * session on it in the meantime.
 */
export const closeChannelFromRelay = (frame: {
  readonly channel_id: string;
  /** Open-vocabulary reason from a forward-compatible relay peer. */
  readonly reason?: string;
}): void => {
  // A close for a channel still being negotiated settles that open instead.
  for (const [keyId, pending] of [...opening.entries()]) {
    if (pending.channelId === frame.channel_id) {
      failOpen(keyId, frame.reason);
    }
  }
  const record = channels.get(frame.channel_id);
  if (record === undefined) return;
  channels.delete(frame.channel_id);
  record.sink = null;
  record.channel.close(frame.reason ?? "peer_gone");
};

/** Feed a complete binary websocket message to the channel its envelope tags. */
export const muxHostOnBytes = (bytes: Uint8Array | null): void => {
  if (bytes === null) {
    // Transport died — fan the null through every channel so each resets.
    for (const record of [...channels.values()]) record.sink?.(null);
    return;
  }
  const envelope = decodeChannelEnvelope(bytes);
  if (!envelope.ok) {
    // Was a silent `return`: an undecodable frame vanished here with no trace.
    logDemuxWarning(`invalid_envelope:${envelope.error}`, {
      byteLength: bytes.byteLength,
    });
    return;
  }
  if (getMuxChannel(envelope.channelId) === undefined) {
    // Was a silent no-op: relay bytes for a channel the daemon never accepted
    // (or already tore down) disappeared here — the invisible half of the
    // production "device did not answer" black hole.
    logDemuxWarning("unknown_channel", { channelId: envelope.channelId });
    return;
  }
  const record = channels.get(envelope.channelId);
  if (record === undefined) return;
  record.sink?.(envelope.payload);
};

/** A dead relay socket tears down all stream state without ending agent sessions. */
export const resetAllChannels = (): void => {
  for (const keyId of [...opening.keys()]) failOpen(keyId);
  for (const record of [...channels.values()]) {
    channels.delete(record.channelId);
    record.sink = null;
    record.channel.close("relay_restart");
  }
  // Demux warn throttle is per-process; clear so parallel/rerun workers don't
  // suppress the first warn of a fresh test after a sibling already logged.
  lastDemuxWarningAt.clear();
};
