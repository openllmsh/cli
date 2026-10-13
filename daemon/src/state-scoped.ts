/**
 * In-process state that belongs to one daemon state dir.
 *
 * The state dir IS the daemon's identity on this machine (its key pair, env
 * file, caches). Memory derived from that daemon's observations — provider
 * auth snapshots, hop cooldowns — is scoped to it, so a process re-pointed at
 * another state dir starts from that daemon's own (empty) view instead of
 * carrying the previous one over. A deployed daemon has exactly one state
 * dir, so this is one entry for its whole life.
 */
import { stateDir } from "./env";

export const stateScoped = <TState>(make: () => TState): (() => TState) => {
  const byDir = new Map<string, TState>();
  return (): TState => {
    const dir = stateDir();
    const existing = byDir.get(dir);
    if (existing !== undefined) return existing;
    const next = make();
    byDir.set(dir, next);
    return next;
  };
};
