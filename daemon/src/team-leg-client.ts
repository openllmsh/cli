import type { TTunnelSurface } from "@openllmsh/protocol";
import { daemonEnv } from "./env";
import {
  observedTeamLegTokens,
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

const apiHeaders = (): Headers =>
  new Headers({
    authorization: `Bearer ${daemonEnv().apiKey}`,
    "content-type": "application/json",
  });

const refund = async (nonce: string, grant: string): Promise<void> => {
  await fetch(teamLegUrl(), {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ reservation_nonce: nonce, team_grant: grant }),
  }).catch(() => undefined);
};

const settle = async (
  nonce: string,
  grant: string,
  actualTokens: number,
): Promise<void> => {
  await fetch(teamLegUrl(), {
    method: "PATCH",
    headers: apiHeaders(),
    body: JSON.stringify({
      reservation_nonce: nonce,
      team_grant: grant,
      actual_tokens: actualTokens,
    }),
  }).catch(() => undefined);
};

const settleResponse = (
  response: Response,
  target: TTeamLegTarget,
): Response => {
  if (!response.ok || response.body === null) {
    void refund(target.reservation_nonce, target.team_grant);
    return response;
  }
  const [forClient, forUsage] = response.body.tee();
  const eventStream =
    response.headers.get("content-type")?.includes("text/event-stream") ===
    true;
  void observedTeamLegTokens(forUsage, eventStream)
    .then((observed) =>
      settle(
        target.reservation_nonce,
        target.team_grant,
        observed === 0 ? target.reserved_tokens : observed,
      ),
    )
    .catch(() => refund(target.reservation_nonce, target.team_grant));
  return new Response(forClient, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * Attempt one direct daemon→supplier team request. The endpoint is both the
 * reservation and channel-admission authority; a pre-dispatch failure refunds
 * before the caller falls back to origin.
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
      signal: args.request.signal,
    });
    return settleResponse(response, target);
  } catch (error) {
    // Once OPEN has been sent, retrying at origin can duplicate inference and
    // billing. Peer-link exposes this exact retry-safety classification.
    if (!isPreDispatchTunnelError(error)) throw error;
    await refund(target.reservation_nonce, target.team_grant);
    return null;
  }
};
