import type { TDaemonRecordRequest } from "@openllmsh/sdk/protocol";
import type { TAttemptOutcome } from "@openllmsh/sdk/wire/lib/attempt-outcome";
import { holdFieldsForRecord, trackHoldRecord } from "./access-hold-context";
import { recordRequest } from "./cloud-client";
import {
  currentTeamGrantFieldsOf,
  currentTeamGrantToken,
} from "./team-request-context";
import { teamUsageCharge } from "./team-usage";

export const attemptFromTokens = (
  tokens: Pick<TDaemonRecordRequest, "tokens_in" | "tokens_out">,
  complete: boolean,
  definiteProviderError = false,
): TAttemptOutcome => ({
  sent: true,
  usage: complete
    ? {
        in: Math.max(0, Math.floor(tokens.tokens_in)),
        out: Math.max(0, Math.floor(tokens.tokens_out)),
      }
    : null,
  definiteProviderError,
});

export const recordAttempt = (
  row: TDaemonRecordRequest,
  origin: string | null,
  attempt: TAttemptOutcome,
): TDaemonRecordRequest => {
  // Team hops: attribute the row to the consumer and charge the share cap,
  // exactly as the walker's `report` does.
  const teamGrant = currentTeamGrantToken();
  const holdFields =
    row.hold_nonce === undefined ? holdFieldsForRecord(row, attempt) : {};
  const holdNonce = row.hold_nonce ?? holdFields.hold_nonce ?? null;
  const recordedRow: TDaemonRecordRequest = {
    ...row,
    idempotency_key: row.idempotency_key ?? crypto.randomUUID(),
    ...(row.team_grant === undefined && teamGrant !== null
      ? { team_grant: teamGrant }
      : {}),
    ...holdFields,
  };
  const record = recordRequest(recordedRow, origin);
  if (holdNonce !== null) trackHoldRecord(holdNonce, record);
  const teamFields = currentTeamGrantFieldsOf();
  if (
    row.status === "success" &&
    teamFields !== null &&
    teamFields.cap_tokens !== undefined
  ) {
    const actual = Math.max(
      0,
      Math.floor(row.tokens_in) + Math.floor(row.tokens_out),
    );
    if (actual > 0) {
      teamUsageCharge(teamFields.share_id, actual, teamFields.cap_tokens);
    }
  }
  return recordedRow;
};
