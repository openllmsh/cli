import { daemonEnv } from "./env";

const DISPATCH_REPORT_TIMEOUT_MS = 5_000;
const DISPATCH_REPORT_ATTEMPTS = 2;

const dispatchUrl = (): string =>
  `${daemonEnv().cloudOrigin}/api/daemon/team-leg/dispatch`;

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
      if (response.ok || response.status < 500) return;
    } catch {
      // A second bounded attempt is enough for a fire-and-forget safety mark.
    }
  }
};
