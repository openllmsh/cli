/**
 * Per-request team grant context for the daemon. The mux tunnel server sets
 * the grant while dispatching a team hop; `report()` reads it so the cloud
 * usage record can attribute the hop, and the local cap can charge actual
 * tokens on success.
 *
 * Bound with AsyncLocalStorage so concurrent tunnels (up to MAX_SERVED_TUNNELS)
 * and stream-completion `report()` callbacks scheduled inside the dispatch
 * keep the correct grant — module globals cannot.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TTeamGrant } from "@openllmsh/tunnel";

type TTeamGrantStore = {
  readonly token: string;
  readonly grant: TTeamGrant;
};

const teamGrantContext = new AsyncLocalStorage<TTeamGrantStore>();

export const withTeamGrant = async <T>(
  token: string,
  grant: TTeamGrant,
  run: () => Promise<T>,
): Promise<T> => teamGrantContext.run({ token, grant }, run);

export const currentTeamGrantToken = (): string | null =>
  teamGrantContext.getStore()?.token ?? null;

export const currentTeamGrantFieldsOf = (): TTeamGrant | null =>
  teamGrantContext.getStore()?.grant ?? null;
