import type { TRelayFrame } from "@openllmsh/protocol";
import {
  MEDIA_HTTP_CAP,
  MEDIA_HTTP_VIDEO_CAP,
  MUX_CAP,
  REALTIME_DUPLEX_CAP,
  RTC_CAP,
  SEEDGATE_CAP,
} from "@openllmsh/protocol";
import {
  decodeChannelEnvelope,
  encodeChannelEnvelope,
} from "@openllmsh/tunnel/channel-envelope";
import { encodeJsonPayload } from "@openllmsh/tunnel/codec";
import type { TDuplex, TMuxChannel } from "@openllmsh/tunnel/mux";
import { createChannel } from "@openllmsh/tunnel/mux";
import { serveStream } from "@openllmsh/tunnel/streams";
import { enforceSeedGate, getDeviceAccessPubkey } from "./device-access-verify";
import { daemonApiKeyId } from "./env";
import { daemonPublicKey } from "./keypair";
import { logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import { ptySessionsEnabled } from "./pty-sessions-pref";
import { serveMuxRealtime } from "./realtime-handler";
import type { TSessionStream } from "./session-core";
import {
  attachSessionHostViaCli,
  findSessionHost,
  spawnSessionHostProc,
} from "./session-host-proc";
import { admitMuxTunnel, serveMuxTunnel } from "./tunnel-server";

/**
 * Base capabilities advertised on hello/status.
 * `mux` (wire `"mux2"`) = binary mux over the relay WS with the channel-id
 * envelope on each binary message, which lets ONE relay socket carry several
 * concurrent channels; `rtc1` = WebRTC data-channel mux host and fleet consumer
 * offerer (RTC → relay mux). RTC data channels are NEVER enveloped — they carry
 * a single mux directly, with no relay hop. `seedgate1` is layered on when a
 * device-access pubkey is pinned — see {@link currentDaemonCaps}.
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
 * transport wholesale and takes terminal sessions down with it. That was the
 * only lever available the first time this was needed, and it was too blunt.
 */
const rtcDisabled = (): boolean => process.env.OPENLLM_RTC_DISABLE === "1";

/** Live capability list — includes `seedgate1` when device access is provisioned. */
export const currentDaemonCaps = (): string[] => {
  const caps: string[] = DAEMON_MUX_CAPS.filter(
    (cap) => cap !== RTC_CAP || !rtcDisabled(),
  );
  if (getDeviceAccessPubkey() !== null) caps.push(SEEDGATE_CAP);
  return caps;
};

/**
 * One live relay-WS mux channel. Several may coexist (`mux2`): a serving
 * channel the daemon accepted (`side: "daemon"`), or a consumer channel it
 * opened to a fleet peer (`side: "consumer"`, keyed by that peer's `keyId`).
 */
type TRelayChannel = {
  readonly channelId: string;
  readonly keyId: string | null;
  readonly consumer: "browser" | "daemon" | null;
  readonly channel: TMuxChannel;
  /** The mux's durable inbound callback, installed exactly once at construction. */
  muxSink: ((bytes: Uint8Array | null) => void) | null;
  /** The relay binding currently allowed to deliver to {@link muxSink}. */
  sink: ((bytes: Uint8Array | null) => void) | null;
  lastActivityAt: number;
};

let sendFrame: ((frame: TRelayFrame) => void) | null = null;
let sendBinary: ((bytes: Uint8Array) => void) | null = null;
/** Live channels by relay-assigned channel id. */
const channels = new Map<string, TRelayChannel>();
const peerCaps = new Map<string, ReadonlySet<string>>();
const opening = new Map<
  string,
  {
    resolve: (channel: TMuxChannel | null) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly channelId: string;
  }
>();
const failedUntil = new Map<string, number>();
const MUX_ACK_TIMEOUT_MS = 5_000;
const MUX_FAILURE_CACHE_MS = 60_000;
export const MUX_CHANNEL_IDLE_TTL_MS = 90_000;
const MUX_CHANNEL_REAPER_INTERVAL_MS = 10_000;
const DEMUX_WARNING_THROTTLE_MS = 5_000;
let muxAckTimeoutMs = MUX_ACK_TIMEOUT_MS;
// Mutable ONLY for the test seam below; production keeps the constant export.
let muxChannelIdleTtlMs = MUX_CHANNEL_IDLE_TTL_MS;
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
  channelReaper = setInterval(reapIdleChannels, MUX_CHANNEL_REAPER_INTERVAL_MS);
  channelReaper.unref();
};

/** Test seam for deterministic idle-channel coverage. */
export const reapIdleMuxChannelsForTest = (): void => reapIdleChannels();

/** Test seam for deterministic idle-channel coverage. */
export const setMuxChannelIdleTtlForTest = (ttlMs: number | null): void => {
  muxChannelIdleTtlMs = ttlMs ?? MUX_CHANNEL_IDLE_TTL_MS;
};

/** Test-only timeout override for deterministic channel-negotiation coverage. */
export const setMuxAckTimeoutForTest = (timeoutMs: number | null): void => {
  muxAckTimeoutMs = timeoutMs ?? MUX_ACK_TIMEOUT_MS;
};

/** Test-only cache reset; production invalidation follows presence replacement. */
export const resetMuxFailureCacheForTest = (): void => {
  failedUntil.clear();
};

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
  failedUntil.delete(keyId);
};

export const replaceMuxPeerCaps = (
  caps: Readonly<Record<string, readonly string[]>> | undefined,
): void => {
  peerCaps.clear();
  if (caps === undefined) return;
  for (const [keyId, values] of Object.entries(caps))
    updateMuxPeerCaps(keyId, values);
};

/** The consumer channel already open to `keyId`, if any. */
const consumerChannelFor = (keyId: string): TRelayChannel | undefined => {
  for (const channel of channels.values())
    if (channel.keyId === keyId) return channel;
  return undefined;
};

const failOpen = (keyId: string, reason?: string): void => {
  const pending = opening.get(keyId);
  if (pending === undefined) return;
  opening.delete(keyId);
  clearTimeout(pending.timer);
  failedUntil.set(keyId, Date.now() + MUX_FAILURE_CACHE_MS);
  sendFrame?.({
    type: "channel_close",
    channel_id: pending.channelId,
    ...(reason === undefined ? {} : { reason }),
  });
  pending.resolve(null);
};

/** Consumer-side negotiation. `mux2` permits one channel per fleet peer. */
export const muxChannelTo = async (
  keyId: string,
): Promise<TMuxChannel | null> => {
  if (process.env.OPENLLM_MUX_DISABLE === "1") return null;
  const caps = peerCaps.get(keyId);
  if (caps === undefined || !caps.has(MUX_CAP)) return null;
  const failedAt = failedUntil.get(keyId);
  if (failedAt !== undefined && failedAt > Date.now()) return null;
  const existing = consumerChannelFor(keyId);
  if (existing !== undefined) return existing.channel;
  const pending = opening.get(keyId);
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
      () => failOpen(keyId, "consumer_gone"),
      muxAckTimeoutMs,
    );
    opening.set(keyId, { resolve, timer, channelId });
    // Fleet peer hop: mark consumer so the serving daemon can skip browser-only
    // seedgate (this process has no vault DEK to mint a grant).
    send({
      type: "channel_open",
      channel_id: channelId,
      key_id: keyId,
      consumer: "daemon",
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
    failedUntil.set(keyId, Date.now() + MUX_FAILURE_CACHE_MS);
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
  const duplex = relayDuplex(
    (bytes) => sendBinary?.(encodeChannelEnvelope(channelId, bytes)),
    (callback) => {
      muxSink = callback;
      if (record !== null) {
        record.muxSink = callback;
        bindSink(record);
      }
    },
  );
  const channel = createChannel({
    duplex,
    side,
    ...(side === "daemon"
      ? {
          onStream: (stream, open) => {
            if (record !== null) touchChannel(record);
            serveMuxOnStream(stream, open);
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
    keyId,
    consumer: side === "daemon" ? "browser" : null,
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
): TDuplex => ({
  send: sendBytes,
  onBytes: registerOnBytes,
  close: () => registerOnBytes(() => {}),
});

export const configureMuxHost = (options: {
  readonly send: (frame: TRelayFrame) => void;
  readonly sendBytes: (bytes: Uint8Array) => void;
}): void => {
  sendFrame = options.send;
  sendBinary = options.sendBytes;
  // The reaper lives with the host lifecycle, not the relay socket: the shared
  // persistent relay sandbox keeps sockets up for days, so relay-socket death
  // (resetAllChannels) can no longer be the only channel cleanup.
  ensureChannelReaper();
};

/** Test seam: the live channel for `channelId` (identity checks across a rebind). */
export const getMuxChannelForTest = (
  channelId: string,
): TMuxChannel | undefined => channels.get(channelId)?.channel;

/**
 * Shared OPEN dispatcher for every daemon-side mux channel (relay WS + RTC).
 * Keep tunnel-server reachable through this single closure so rtc-host does
 * not re-implement admit/serve. Session OPEN binds a PTY via session-host.
 */
const pipeSessionStreams = (
  relay: TSessionStream,
  host: TSessionStream,
): void => {
  let closed = false;
  const closeHost = (): void => {
    if (closed) return;
    closed = true;
    host.end();
  };
  relay.onData((bytes) => {
    void host.write(bytes).catch(() => {
      closed = true;
      host.reset();
      relay.reset();
    });
  });
  relay.onCtrl((payload) => host.sendCtrl(payload));
  relay.onReset((payload) => {
    host.reset(payload);
    closed = true;
  });
  relay.onEnd(closeHost);
  host.onData((bytes) => {
    void relay.write(bytes).catch(() => {
      // Mirror the host-write rejection path: tear down both sides so a
      // rejected relay write cannot leave the TSessionStream half-open.
      if (closed) return;
      closed = true;
      host.reset();
      relay.reset();
    });
  });
  host.onCtrl((payload) => relay.sendCtrl(payload));
  host.onReset((payload) => {
    closed = true;
    relay.reset(payload);
  });
  host.onEnd(() => {
    if (closed) return;
    closed = true;
    relay.end();
  });
};

/** Browser mux streams are attach clients; durable hosts own every PTY. */
export const serveMuxOnStream = serveStream({
  // Keep the tunnel-server import lazy: its production dispatcher reaches the
  // control channel, which imports this host during daemon initialization.
  tunnel: (open, body, signal) => serveMuxTunnel(open, body, signal),
  realtime: (stream, open) => serveMuxRealtime(stream, open),
  session: async (stream, open) => {
    if (!ptySessionsEnabled()) {
      logInfo("session", "remote session open refused: sessions disabled", {
        id: open.session_id,
      });
      stream.reset(
        encodeJsonPayload({
          code: "sessions_disabled",
          message:
            "remote terminal sessions are disabled on this device — run: openllmd sessions on",
        }),
      );
      return;
    }
    // Spawn (if needed) then attach via a CLI pipe child. The CLI owns the
    // unix-socket dial; the daemon never opens a session socket itself.
    if (open.mode !== "attach") {
      const socketPath = await spawnSessionHostProc({
        id: open.session_id,
        cli: open.cli,
        cols: open.cols,
        rows: open.rows,
        ...(open.cwd === undefined ? {} : { cwd: open.cwd }),
        ...(open.title === undefined ? {} : { title: open.title }),
        ...(open.dangerous === undefined ? {} : { dangerous: open.dangerous }),
        ...(open.resume_session_id === undefined
          ? {}
          : { resume: open.resume_session_id }),
      });
      if (socketPath === null) {
        stream.reset(encodeJsonPayload({ code: "spawn_failed" }));
        return;
      }
    } else if ((await findSessionHost(open.session_id)) === null) {
      stream.reset(encodeJsonPayload({ code: "session_not_found" }));
      return;
    }
    const host = attachSessionHostViaCli({ ...open, mode: "attach" });
    if (host === null) {
      stream.reset(
        encodeJsonPayload({
          code: open.mode === "attach" ? "session_not_found" : "spawn_failed",
        }),
      );
      return;
    }
    pipeSessionStreams(stream, host);
  },
  admitTunnel: () => admitMuxTunnel(),
  invalidOpenCode: "invalid_tunnel",
});

/**
 * Seed-gate: browser consumers must present a vault-signed grant when
 * provisioned. Fleet daemon→daemon hops set consumer:"daemon" and have no
 * vault DEK — skip enforcement for those (parity with tunnel-server).
 * Trust boundary: the relay stamps `consumer` from the authenticated
 * socket role before forward, so a watcher cannot claim "daemon" to
 * skip the gate. Direct (non-relay) sockets must not self-assert.
 * Shared by fresh opens AND rebinds — a rebind is still a consumer proving
 * access. Sends the `unauthorized` nack and returns false on rejection.
 */
const admitBySeedGate = (
  frame: {
    readonly channel_id: string;
    readonly grant?: string;
    readonly consumer?: "browser" | "daemon";
  },
  send: (frame: TRelayFrame) => void,
): boolean => {
  if (frame.consumer === "daemon") return true;
  const gate = enforceSeedGate(frame.grant, {
    keyId: daemonApiKeyId(),
    cid: frame.channel_id,
    aud: daemonPublicKey(),
  });
  if (gate.mode !== "reject") return true;
  logWarn("mux-host", safeDiagnosticMessage`channel_open rejected: seedgate`, {
    channelId: frame.channel_id,
    reason: gate.reason,
  });
  send({
    type: "channel_open_ack",
    channel_id: frame.channel_id,
    ok: false,
    error: "unauthorized",
  });
  return false;
};

/** Accept the relay-authorized channel. `mux2` allows several concurrent. */
export const acceptChannel = (frame: {
  readonly channel_id: string;
  readonly grant?: string;
  readonly consumer?: "browser" | "daemon";
}): void => {
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
    // inbound sink onto the EXISTING channel (its attached session streams
    // survive untouched; PTY hosts are durable and never respawned here) and
    // re-ack so the peer's open settles. A refused rebind (seed gate) leaves
    // the incumbent channel alone.
    if (!admitBySeedGate(frame, send)) return;
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
  if (!admitBySeedGate(frame, send)) return;
  registerChannel(frame.channel_id, null, "daemon");
  logInfo("mux-host", "channel_open accepted", {
    channelId: frame.channel_id,
    consumer: frame.consumer ?? "browser",
  });
  send({ type: "channel_open_ack", channel_id: frame.channel_id, ok: true });
};

/**
 * The relay says this channel's peer is gone (`consumer_gone` when a browser
 * socket dies, `daemon_gone` for a serving peer). Tear the local half down so
 * its streams RESET — which detaches any device PTY bound to them — and so the
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
  const record = channels.get(envelope.channelId);
  if (record === undefined) {
    // Was a silent no-op: relay bytes for a channel the daemon never accepted
    // (or already tore down) disappeared here — the invisible half of the
    // production "device did not answer" black hole.
    logDemuxWarning("unknown_channel", { channelId: envelope.channelId });
    return;
  }
  record.sink?.(envelope.payload);
};

/** A dead relay socket tears down all stream state without killing PTYs. */
export const resetAllChannels = (): void => {
  for (const keyId of [...opening.keys()]) failOpen(keyId);
  for (const record of [...channels.values()]) {
    channels.delete(record.channelId);
    record.sink = null;
    record.channel.close("relay_restart");
  }
};
