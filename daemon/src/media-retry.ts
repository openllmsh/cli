/**
 * Daemon adapter over protocol `mediaActionFor` + shared `classifyHopError`.
 * Do not fork policy — quirks only via `provider-error-rules.ts`.
 */

import type {
  TCooldownPolicy,
  TCooldownReason,
  TMediaActionFacts,
  TMediaActionReason,
} from "@openllmsh/sdk/protocol";
import { mediaActionFor } from "@openllmsh/sdk/protocol";
import { classifyHopError } from "@openllmsh/sdk/wire/lib/error-class";
import { errorEnvelopeFrom } from "@openllmsh/sdk/wire/lib/error-envelope";

export type {
  TMediaActionFacts,
  TMediaActionReason,
} from "@openllmsh/sdk/protocol";

/** Hop continues when the overlay says cool-and-advance or walk-without-cool. */
const advances = (policy: TCooldownPolicy): boolean =>
  policy.action === "cool_and_advance" || policy.action === "walk_no_cool";

/**
 * Classify a media HTTP response with the shared hop classifier.
 * Forwarded cloud bodies and subscription media wires are OpenAI-shaped.
 */
export const classifyMediaHttp = (
  status: number,
  raw: string,
  opts?: {
    readonly provider?: string;
    readonly aborted?: boolean;
  },
):
  | { readonly kind: "abort" }
  | { readonly kind: "transient"; readonly reason: TCooldownReason } =>
  classifyHopError({
    status,
    envelope: errorEnvelopeFrom(raw),
    providerFormat: "openai",
    aborted: opts?.aborted === true,
    provider: opts?.provider,
  });

export const mediaPolicyForReason = (
  reason: TMediaActionReason,
  facts: TMediaActionFacts,
): TCooldownPolicy => mediaActionFor(reason, facts);

export const mediaHopAdvancesForReason = (
  reason: TMediaActionReason,
  facts: TMediaActionFacts,
): boolean => advances(mediaActionFor(reason, facts));

export const mediaPolicyForHttp = (
  status: number,
  raw: string,
  facts: TMediaActionFacts,
  provider?: string,
): TCooldownPolicy => {
  const cls = classifyMediaHttp(status, raw, {
    provider,
    aborted: facts.cancelled === true,
  });
  if (cls.kind === "abort") return { action: "surface" };
  return mediaActionFor(cls.reason, facts);
};

export const mediaHopAdvancesForHttp = (
  status: number,
  raw: string,
  facts: TMediaActionFacts,
  provider?: string,
): boolean => advances(mediaPolicyForHttp(status, raw, facts, provider));

/**
 * Account-level cool reason for a media upstream status (+ body).
 * Only cool-and-advance reasons rotate accounts (quota/auth/rate/payment,
 * including credits wording on any 4xx).
 */
export const accountCoolReasonForHttp = (
  status: number,
  raw: string,
  provider?: string,
): TCooldownReason | undefined => {
  const cls = classifyMediaHttp(status, raw, { provider });
  if (cls.kind === "abort") return undefined;
  return mediaActionFor(cls.reason, { dispatched: true, accepted: false })
    .action === "cool_and_advance"
    ? cls.reason
    : undefined;
};
