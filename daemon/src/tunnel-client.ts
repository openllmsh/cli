/**
 * The CONSUMING end of the subscription tunnel, daemon side
 * (`docs/features/sub-tunnel-and-chat-sessions.md` §1). When the walker
 * hits a subscription hop this box has no credential for, and the
 * bootstrap's `fleet_subscriptions` names an online peer serving that
 * provider, the request tunnels to the peer. Fleet hops prefer an
 * already-open direct RTC mux, then relay binary mux. There is no JSON
 * `tunnel_*` splice — if neither RTC nor mux is available the hop fails and
 * the walker continues.
 *
 * Both rungs go through `fleetRequest` (`@openllmsh/sdk/tunnel/fleet`), the one
 * handler origin also uses: it sets `consumer:"daemon"` so the peer's
 * tunnel-server stamps `x-openllm-tunneled` and the peer walker loop-guards
 * further fleet hops.
 *
 * Any failure rejects — the walker treats it as a failed hop and continues
 * the walk (degradation preserved).
 */

import type { TTunnelSurface } from "@openllmsh/sdk/protocol";
import {
  RTC_CAP,
  SEEDGATE_CAP,
  TEAM_RTC_CAP,
  TRANSPORT_HEADER,
} from "@openllmsh/sdk/protocol";
import { fleetRequest } from "@openllmsh/sdk/tunnel/fleet";
import {
  createPeerLink,
  peerLinkFailureCache,
  peerLinkFailureReasonOf,
} from "@openllmsh/sdk/tunnel/peer-link";
import { fleetSubscriptionPubkeyFor } from "./config";
import { logInfo, safeDiagnosticMessage } from "./logger";
import { dropMuxChannel, getMuxPeerCaps, muxChannelTo } from "./mux-host";
import { ensureRtcTo, getRtcMuxChannel, markRtcFailure } from "./rtc-client";

export {
  FLEET_DECLINE_HEADER,
  FLEET_PROVIDER_HEADER,
} from "@openllmsh/sdk/protocol";

export type TTunnelCauseCode =
  | "presence"
  | "relay_unavailable"
  | "timeout"
  | "nack"
  | "channel_closed"
  | "cached_failure"
  | "unknown";

/** A local transport failure that happened before a tunnel OPEN was sent. */
export class PreDispatchTunnelError extends Error {
  readonly causeCode: TTunnelCauseCode;

  constructor(
    message: string,
    options?: ErrorOptions & { causeCode?: TTunnelCauseCode },
  ) {
    super(message, options);
    this.causeCode = options?.causeCode ?? "unknown";
    this.name = "PreDispatchTunnelError";
  }
}

/** Local failures before OPEN can safely re-dispatch an inference request. */
export const isPreDispatchTunnelError = (error: unknown): boolean =>
  error instanceof PreDispatchTunnelError;

const preDispatchError = (error: unknown): PreDispatchTunnelError | null => {
  if (error instanceof PreDispatchTunnelError) return error;
  if (
    error instanceof Error &&
    (error.message === "channel is closed" ||
      error.message === "stream ids exhausted")
  ) {
    return new PreDispatchTunnelError(error.message, {
      cause: error,
      causeCode: "channel_closed",
    });
  }
  return null;
};

const recordTunnelRequest = (input: {
  readonly keyId: string;
  readonly provider?: string;
  readonly causeCode?: TTunnelCauseCode;
  readonly transport: "rtc" | "mux";
  readonly rungFallbackReason:
    | "none"
    | "rtc_failed"
    | "rtc_unavailable"
    | "mux_unavailable"
    | "channel_open_failed";
  readonly channelReused: boolean;
  readonly openMs: number;
  readonly resHeadMs: number;
}): void => {
  logInfo(
    "tunnel_request",
    safeDiagnosticMessage`tunnel_request`,
    {
      peer_key_id: input.keyId,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.causeCode === undefined ? {} : { cause_code: input.causeCode }),
    },
    {
      tunnel_path: "fleet",
      tunnel_transport: input.transport,
      rung_fallback_reason: input.rungFallbackReason,
      channel_reused: input.channelReused,
      plan_cache: "miss",
      serving_inflight: 0,
      timings: {
        open_ms: input.openMs,
        admission_ms: 0,
        res_head_ms: input.resHeadMs,
      },
    },
  );
};

export type TTunnelToPeerArgs = {
  keyId: string;
  provider?: string;
  fleetProvider?: string;
  fleetModel?: string;
  surface: TTunnelSurface;
  body: Uint8Array;
  accept: "application/json" | "text/event-stream";
  anthropicVersion?: string | null;
  anthropicBeta?: string | null;
  userAgent?: string | null;
  /** Per-request team grant; channel admission has its own initial grant. */
  teamGrant?: string;
  /** Scopes a reusable cross-user relay channel. */
  teamId?: string;
  signal: AbortSignal;
  /** Optional transport override (harness / instrumented host). */
  transport?: TTunnelToPeer;
};

export type TTunnelToPeer = (args: TTunnelToPeerArgs) => Promise<Response>;

const tunnelToPeerLive: TTunnelToPeer = async (args) => {
  const headers = {
    content_type: "application/json" as const,
    accept: args.accept,
    ...(args.anthropicVersion != null
      ? { anthropic_version: args.anthropicVersion.slice(0, 32) }
      : {}),
    ...(args.anthropicBeta != null
      ? { anthropic_beta: args.anthropicBeta }
      : {}),
    ...(args.userAgent != null
      ? { user_agent: args.userAgent.slice(0, 512) }
      : {}),
    ...(args.teamGrant === undefined ? {} : { team_grant: args.teamGrant }),
    ...(args.fleetProvider === undefined
      ? {}
      : { fleet_provider: args.fleetProvider }),
    ...(args.fleetModel === undefined ? {} : { fleet_model: args.fleetModel }),
  };

  const peerCaps = getMuxPeerCaps(args.keyId);
  const peerPubkey = fleetSubscriptionPubkeyFor(args.keyId);
  const request = {
    surface: args.surface,
    headers,
    body: args.body,
    signal: args.signal,
  };

  const lookupKey =
    args.teamId === undefined
      ? args.keyId
      : `${args.keyId}\u0000${args.teamId}`;
  const wasCached = peerLinkFailureCache.has(lookupKey, "mux");
  const startedAt = Date.now();
  let rtcFailed = false;
  let muxReused = false;
  const link = createPeerLink({
    // Same scope as `muxChannelTo`'s cache: a team's failure never hides
    // this peer's same-user (or another team's) channel.
    target: lookupKey,
    rtc: {
      open: () => getRtcMuxChannel(args.keyId, args.teamId),
      warm: () => {
        // Fleet's cold RTC setup stays best-effort: mux is not held behind ICE.
        ensureRtcTo(args.keyId, {
          pubkey: peerPubkey ?? "",
          hasRtc1:
            args.teamGrant === undefined && (peerCaps?.has(RTC_CAP) ?? false),
          hasSeedgate1: peerCaps?.has(SEEDGATE_CAP) ?? false,
          ...(args.teamGrant === undefined
            ? {}
            : {
                teamGrant: args.teamGrant,
                teamId: args.teamId,
                hasTeamRtc1: peerCaps?.has(TEAM_RTC_CAP) ?? false,
              }),
        });
      },
      dial: async () => getRtcMuxChannel(args.keyId, args.teamId),
      // Peer-link invokes `drop` only for an actual pre-dispatch failure;
      // ordinary idle release leaves this healthy RTC session intact.
      drop: () => markRtcFailure(args.keyId, args.teamId),
    },
    mux: {
      // `muxChannelTo` owns its channel map and joins an in-flight open.
      // Its dial result therefore carries reuse semantics without a second lookup.
      open: () => null,
      drop: (channel) =>
        dropMuxChannel(args.keyId, channel, { teamId: args.teamId }),
      dial: async () => {
        muxReused = false;
        return muxChannelTo(args.keyId, {
          onReuse: () => {
            muxReused = true;
          },
          ...(args.teamId === undefined ? {} : { teamId: args.teamId }),
          ...(args.teamGrant === undefined
            ? {}
            : { teamGrant: args.teamGrant }),
        });
      },
    },
    policy: {
      retrySafe: (error) =>
        !args.signal.aborted && preDispatchError(error) !== null,
      classifyFailure: (error) => {
        rtcFailed = true;
        return peerLinkFailureReasonOf(error);
      },
    },
  });
  const selection: { path: "rtc" | "mux"; reused: boolean } = {
    path: "mux",
    reused: false,
  };
  try {
    const response = await link.attempt(async (selected) => {
      selection.path = selected.path;
      selection.reused =
        selected.reused || (selected.path === "mux" && muxReused);
      try {
        return await fleetRequest(selected.channel, request);
      } finally {
        selected.release();
      }
    });
    recordTunnelRequest({
      keyId: args.keyId,
      provider: args.provider,
      transport: selection.path,
      rungFallbackReason:
        selection.path === "rtc"
          ? "none"
          : rtcFailed
            ? "rtc_failed"
            : "rtc_unavailable",
      channelReused: selection.reused,
      openMs: 0,
      resHeadMs: Date.now() - startedAt,
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set(TRANSPORT_HEADER, selection.path);
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (args.signal.aborted) {
      throw error instanceof Error
        ? error
        : new DOMException("Aborted", "AbortError");
    }
    let failure = preDispatchError(error);
    if (error instanceof Error && error.message === "peer link unavailable") {
      const reason = peerLinkFailureCache.reason(lookupKey, "mux");
      const causeCode: TTunnelCauseCode = wasCached
        ? "cached_failure"
        : reason === "presence" ||
            reason === "relay_unavailable" ||
            reason === "timeout" ||
            reason === "nack"
          ? reason
          : "unknown";
      failure = new PreDispatchTunnelError(
        "Device transport unavailable. Peer has neither RTC nor mux — update OpenLLM on the peer.",
        { cause: error, causeCode },
      );
    }
    recordTunnelRequest({
      keyId: args.keyId,
      provider: args.provider,
      causeCode: failure?.causeCode ?? "unknown",
      transport: selection.path,
      rungFallbackReason: "channel_open_failed",
      channelReused:
        selection.reused || (selection.path === "mux" && muxReused),
      openMs: 0,
      resHeadMs: Date.now() - startedAt,
    });
    throw (
      failure ?? (error instanceof Error ? error : new Error(String(error)))
    );
  }
};

/**
 * Tunnel one request to the fleet peer serving `keyId`. Resolves once the
 * response head arrives (body streams thereafter); rejects when neither RTC
 * nor mux is available, or when the stream fails. Pass `transport` to override
 * the live RTC→mux ladder for a single call; omitted, the live ladder is
 * used.
 */
export const tunnelToPeer: TTunnelToPeer = (args) => {
  const transport = args.transport ?? tunnelToPeerLive;
  return transport({ ...args, transport: undefined });
};
