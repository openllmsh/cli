/**
 * Per-request team grant context for the daemon. The mux tunnel server sets
 * the grant while dispatching a team hop; `report()` reads it so the cloud
 * usage record can attribute the row to the consumer and settle caps.
 *
 * Single-threaded Bun event loop — nested dispatches restore the previous
 * token in `finally`.
 */

let currentTeamGrant: string | null = null;

export const withTeamGrant = async <T>(
  token: string,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = currentTeamGrant;
  currentTeamGrant = token;
  try {
    return await run();
  } finally {
    currentTeamGrant = previous;
  }
};

export const currentTeamGrantToken = (): string | null => currentTeamGrant;
