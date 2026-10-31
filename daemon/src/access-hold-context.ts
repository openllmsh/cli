/**
 * Per-request cap hold for a capped key. The cloud answers a capped key's
 * plan fetch with a one-hop plan bound to a token reservation (`hold_nonce`,
 * part of the signed payload). The listener runs the walk inside this
 * context so every signature check verifies against the nonce and every
 * usage record carries it, letting the cloud settle or refund the hold
 * exactly once. AsyncLocalStorage keeps concurrent requests apart, the same
 * way `team-request-context.ts` does for team grants.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const holdContext = new AsyncLocalStorage<string>();

export const withHoldNonce = <T>(nonce: string, run: () => T): T =>
  holdContext.run(nonce, run);

export const currentHoldNonce = (): string | null =>
  holdContext.getStore() ?? null;
