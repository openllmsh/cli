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
 * Both rungs go through `fleetRequest` (`@openllmsh/tunnel/fleet`), the one
 * handler origin also uses: it sets `consumer:"daemon"` so the peer's
 * tunnel-server stamps `x-openllm-tunneled` and the peer walker loop-guards
 * further fleet hops.
 *
 * Any failure rejects — the walker treats it as a failed hop and continues
 * the walk (degradation preserved).
 */

import type { TTunnelSurface } from "@openllmsh/protocol";
import { RTC_CAP, SEEDGATE_CAP, TEAM_RTC_CAP } from "@openllmsh/protocol";
import { fleetRequest } from "@openllmsh/tunnel/fleet";
import { createPeerLink } from "@openllmsh/tunnel/peer-link";
import { fleetSubscriptionPubkeyFor } from "./config";
import { logInfo, safeDiagnosticMessage } from "./logger";
import { getMuxPeerCaps, muxChannelTo } from "./mux-host";
import { ensureRtcTo, getRtcMuxChannel, markRtcFailure } from "./rtc-client";

/** Local failures before OPEN can safely re-dispatch an inference request. */
const isPreDispatchTunnelError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message === "channel is closed" ||
    error.message === "stream ids exhausted");

const recordTunnelRequest = (input: {
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
  logInfo("tunnel_request", safeDiagnosticMessage`tunnel_request`, undefined, {
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
  });
};

export type TTunnelToPeerArgs = {
  keyId: string;
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
  };

  const peerCaps = getMuxPeerCaps(args.keyId);
  const peerPubkey = fleetSubscriptionPubkeyFor(args.keyId);
  const request = {
    surface: args.surface,
    headers,
    body: args.body,
    signal: args.signal,
  };

  const startedAt = Date.now();
  let rtcFailed = false;
  const link = createPeerLink({
    target: args.keyId,
    rtc: {
      open: () => getRtcMuxChannel(args.keyId),
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
                hasTeamRtc1: peerCaps?.has(TEAM_RTC_CAP) ?? false,
              }),
        });
      },
      dial: async () => getRtcMuxChannel(args.keyId),
      drop: () => markRtcFailure(args.keyId),
    },
    mux: {
      // `muxChannelTo` owns its channel map and joins an in-flight open.
      // Its dial result therefore carries reuse semantics without a second lookup.
      open: () => null,
      dial: async () =>
        muxChannelTo(args.keyId, {
          ...(args.teamId === undefined ? {} : { teamId: args.teamId }),
          ...(args.teamGrant === undefined
            ? {}
            : { teamGrant: args.teamGrant }),
        }),
    },
    policy: {
      retrySafe: (error) =>
        !args.signal.aborted && isPreDispatchTunnelError(error),
      classifyFailure: (error) => {
        rtcFailed = true;
        return error instanceof Error && error.message.includes("tunnel_busy")
          ? "tunnel_busy"
          : "transport";
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
      selection.reused = selected.reused;
      try {
        return await fleetRequest(selected.channel, request);
      } finally {
        selected.release();
      }
    });
    recordTunnelRequest({
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
    return response;
  } catch (error) {
    if (args.signal.aborted) {
      throw error instanceof Error
        ? error
        : new DOMException("Aborted", "AbortError");
    }
    if (error instanceof Error && error.message === "peer link unavailable") {
      throw new Error(
        "Device transport unavailable. Peer has neither RTC nor mux — update OpenLLM on the peer.",
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
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
