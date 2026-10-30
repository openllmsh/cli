import type { TTunnelSurface } from "@openllmsh/protocol";
import { TEAM_LEG_STREAM_DEADLINE_MS } from "@openllmsh/protocol";
import { daemonEnv } from "./env";
import {
  maxOutputTokensFromTeamLegBody,
  rewriteTeamLegBodyModel,
} from "./team-leg-body";
import { isPreDispatchTunnelError, tunnelToPeer } from "./tunnel-client";

export type TTeamLegTarget = {
  readonly device_key_id: string;
  readonly team_id: string;
  readonly team_grant: string;
  readonly reservation_nonce: string;
  readonly reserved_tokens: number;
  readonly resolved_model: string;
};

type TTeamLegResponse = { readonly targets: ReadonlyArray<TTeamLegTarget> };

const isTeamModel = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("team:");

/** A plan hop served by a teammate's device (`team:<slug>/<model>`). */
export const isTeamHop = (hop: { readonly modelId: string }): boolean =>
  isTeamModel(hop.modelId);

const teamSurfaceOf = (
  surface: TTunnelSurface,
): "chat_completions" | "messages" | "responses" | null =>
  surface === "chat_completions" ||
  surface === "messages" ||
  surface === "responses"
    ? surface
    : null;

const teamLegUrl = (): string =>
  `${daemonEnv().cloudOrigin}/api/daemon/team-leg`;

/** Combine client cancellation with the bounded direct-leg stream lifetime. */
export const teamLegStreamSignal = (
  requestSignal: AbortSignal,
  deadlineMs: number = TEAM_LEG_STREAM_DEADLINE_MS,
): AbortSignal =>
  AbortSignal.any([requestSignal, AbortSignal.timeout(deadlineMs)]);

const apiHeaders = (): Headers =>
  new Headers({
    authorization: `Bearer ${daemonEnv().apiKey}`,
    "content-type": "application/json",
  });

/**
 * Attempt one direct daemon→supplier team request. The endpoint is both the
 * reservation and channel-admission authority. A pre-dispatch failure abandons
 * its hold for the server-side stale sweep before falling back to origin; that
 * avoids racing the supplier's asynchronous dispatch report.
 */
export const tryDirectTeamLeg = async (args: {
  readonly request: Request;
  readonly body: Uint8Array;
  readonly model: unknown;
  readonly surface: TTunnelSurface;
}): Promise<Response | null> => {
  const surface = teamSurfaceOf(args.surface);
  if (!isTeamModel(args.model) || surface === null) return null;
  const reserve = await fetch(teamLegUrl(), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      model: args.model,
      surface,
      estimated_tokens: Math.ceil(args.body.byteLength / 4),
      max_output_tokens: maxOutputTokensFromTeamLegBody(args.body),
    }),
    signal: args.request.signal,
  }).catch(() => null);
  if (reserve === null || !reserve.ok) return null;
  const payload = (await reserve
    .json()
    .catch(() => null)) as TTeamLegResponse | null;
  const target = payload?.targets[0];
  if (target === undefined) return null;
  try {
    // This upper bound is shared with the origin sweep policy. A direct leg
    // must finish (or abort its peer stream) before its held cap can settle.
    const streamSignal = teamLegStreamSignal(args.request.signal);
    const response = await tunnelToPeer({
      keyId: target.device_key_id,
      teamId: target.team_id,
      teamGrant: target.team_grant,
      surface,
      // The grant is bound to the supplier's concrete model; preserve the
      // original body for origin fallback but pin the direct dispatch here.
      body: rewriteTeamLegBodyModel(args.body, target.resolved_model),
      accept:
        (args.model as string).length > 0 &&
        args.request.headers.get("accept")?.includes("text/event-stream") ===
          true
          ? "text/event-stream"
          : "application/json",
      anthropicVersion: args.request.headers.get("anthropic-version"),
      anthropicBeta: args.request.headers.get("anthropic-beta"),
      userAgent: args.request.headers.get("user-agent"),
      signal: streamSignal,
    });
    return response;
  } catch (error) {
    // Once OPEN has been sent, retrying at origin can duplicate inference and
    // billing. Peer-link exposes this exact retry-safety classification.
    if (!isPreDispatchTunnelError(error)) {
      // Once OPEN has left this daemon the supplier may have started work.
      // Its authenticated completion report, or the stale sweep, settles the
      // reservation; consumers never report usage.
      throw error;
    }
    // Do not refund from the consumer: the supplier's fire-and-forget dispatch
    // report may be in flight. The server releases this undispatched hold after
    // the grant expiry plus its reporting grace.
    return null;
  }
};
