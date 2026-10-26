/**
 * Per-request team grant context for the daemon. The mux tunnel server sets
 * the grant while dispatching a team hop; `report()` reads it so the cloud
 * usage record can attribute the hop, and the local cap can charge actual
 * tokens on success.
 *
 * Single-threaded Bun event loop — nested dispatches restore the previous
 * token in `finally`.
 */

import type { TTeamGrant } from "@openllmsh/tunnel";

let currentTeamGrant: string | null = null;
let currentTeamGrantFields: TTeamGrant | null = null;

export const withTeamGrant = async <T>(
  token: string,
  grant: TTeamGrant,
  run: () => Promise<T>,
): Promise<T> => {
  const previousToken = currentTeamGrant;
  const previousFields = currentTeamGrantFields;
  currentTeamGrant = token;
  currentTeamGrantFields = grant;
  try {
    return await run();
  } finally {
    currentTeamGrant = previousToken;
    currentTeamGrantFields = previousFields;
  }
};

export const currentTeamGrantToken = (): string | null => currentTeamGrant;

export const currentTeamGrantFieldsOf = (): TTeamGrant | null =>
  currentTeamGrantFields;
