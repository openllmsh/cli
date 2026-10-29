import { daemonEnv } from "./env";

const DISPATCH_REPORT_TIMEOUT_MS = 5_000;
const DISPATCH_REPORT_ATTEMPTS = 2;

type TDispatchReportResult = "marked" | "already_marked" | "not_found";

const isDispatchReportResult = (
  value: unknown,
): value is TDispatchReportResult =>
  value === "marked" || value === "already_marked" || value === "not_found";

const dispatchUrl = (): string =>
  `${daemonEnv().cloudOrigin}/api/daemon/team-leg/dispatch`;

const completionUrl = (): string =>
  `${daemonEnv().cloudOrigin}/api/daemon/team-leg/completion`;

/**
 * Best-effort supplier proof that a direct-leg stream was admitted. The report
 * contains only the signed nonce-bound grant, never request bytes. A bounded
 * retry tolerates one transient cloud failure without delaying the stream.
 */
export const reportTeamLegDispatch = async (input: {
  readonly nonce: string;
  readonly teamGrant: string;
}): Promise<void> => {
  const { apiKey } = daemonEnv();
  if (apiKey === null) return;
  for (let attempt = 0; attempt < DISPATCH_REPORT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(dispatchUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reservation_nonce: input.nonce,
          team_grant: input.teamGrant,
        }),
        signal: AbortSignal.timeout(DISPATCH_REPORT_TIMEOUT_MS),
      });
      if (response.status >= 500) continue;
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as {
        readonly result?: unknown;
      } | null;
      // `marked` and `already_marked` are both idempotent success. `not_found`
      // cannot become markable on a retry, so it also ends this bounded loop.
      if (isDispatchReportResult(body?.result)) return;
    } catch {
      // A second bounded attempt is enough for a fire-and-forget safety mark.
    }
  }
};

/**
 * Best-effort supplier observation for a completed direct-leg response. Only
 * the supplier named in the grant can settle, and the cloud clamps this value
 * to the reservation. A failed report deliberately leaves the held row for
 * the dispatched-reservation sweep to settle at its full amount.
 */
export const reportTeamLegCompletion = async (input: {
  readonly nonce: string;
  readonly teamGrant: string;
  readonly actualTokens: number;
}): Promise<void> => {
  const { apiKey } = daemonEnv();
  if (apiKey === null) return;
  for (let attempt = 0; attempt < DISPATCH_REPORT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(completionUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reservation_nonce: input.nonce,
          team_grant: input.teamGrant,
          actual_tokens: input.actualTokens,
        }),
        signal: AbortSignal.timeout(DISPATCH_REPORT_TIMEOUT_MS),
      });
      if (response.status >= 500) continue;
      return;
    } catch {
      // A second bounded attempt is enough for a fire-and-forget observation.
    }
  }
};
