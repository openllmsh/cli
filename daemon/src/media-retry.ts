/**
 * Daemon adapter over protocol `decideMediaChainAdvance`. Do not fork policy.
 */

import type { TMediaAttemptFacts } from "@openllmsh/protocol";
import { decideMediaChainAdvance } from "@openllmsh/protocol";

export type {
  TMediaAdvanceDecision,
  TMediaAttemptFacts,
} from "@openllmsh/protocol";
export { decideMediaChainAdvance } from "@openllmsh/protocol";

export const mediaHopAdvances = (facts: TMediaAttemptFacts): boolean =>
  decideMediaChainAdvance(facts).action === "advance";

export const mediaHttpErrorCode = (
  status: number,
): TMediaAttemptFacts["errorCode"] => {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 402) return "quota_exhausted";
  if (status === 404) return "model_unavailable";
  return undefined;
};
