/**
 * The daemon's filesystem working set — the SINGLE allow-list both sandbox
 * backends consume (the Landlock ruleset in `../landlock.ts`, and the macOS
 * Seatbelt profile in `../seatbelt.ts`). Derived from the existing path helpers
 * (`env.ts` / `cli-paths.ts`), never re-hardcoded, so a relocated state dir or a
 * new provider home is picked up automatically.
 *
 * Structure (R2 M1.5 — `docs/proposals/daemon-subprocess-isolation.md` §3.1):
 * the working set is split into a shared `base` plus one module per
 * externally-reachable sub-process concern —
 *
 *   - `auth-state`        — vendor CLI delegation: login, credential capture,
 *                           usage reads (owns the FS-secret grants);
 *   - `browser-chat`      — RTC + mux + `/v1` serving for the dashboard
 *                           (`/v1`-only, no FS secrets);
 *   - `fleet`             — daemon-to-daemon peer channel (`/v1`-only);
 *   - `vendor-cli-tunnel` — device-session PTY hosting (vendor-CLI exec, as
 *                           required, incrementally).
 *
 * Today the daemon still runs as ONE process: `daemonWorkingSet()` returns the
 * UNION of every layer + base, and the current callers (`landlock.ts`,
 * `seatbelt.ts`) consume that union — so runtime behavior is unchanged. M2–M3
 * wire the actual `--sub <layer>` subprocesses, each selecting a single layer
 * via `workingSetForLayer()`; R2-T9 (no process loads another layer's set) is
 * already satisfied structurally — the layers are disjoint modules that never
 * import each other.
 */

import { homedir } from "node:os";
import { authStateLayer } from "./auth-state";
import type { TWorkingSet } from "./base";
import { baseWorkingSet, existing } from "./base";
import { browserChatLayer } from "./browser-chat";
import { fleetLayer } from "./fleet";
import { vendorCliTunnelLayer } from "./vendor-cli-tunnel";

export type { TWorkingSet } from "./base";
export { daemonTempDir, resolveCliExecDirs } from "./base";

/** The four sub-process sandbox layers M2's `--sub` bootstrap selects between. */
export type TWorkingSetLayer =
  | "auth-state"
  | "browser-chat"
  | "fleet"
  | "vendor-cli-tunnel";

const LAYER_BUILDERS: Readonly<
  Record<TWorkingSetLayer, (home: string) => TWorkingSet>
> = {
  "auth-state": authStateLayer,
  "browser-chat": browserChatLayer,
  fleet: fleetLayer,
  "vendor-cli-tunnel": vendorCliTunnelLayer,
};

/** Merge a set of layer results into deduped read-write / read-only sets, then
 *  apply the two final normalization steps shared with the pre-split builder:
 *  keep the lists disjoint (a read-write grant subsumes a read-only one), then
 *  `existing()` both (drop/normalize missing paths so a not-yet-created leaf
 *  never widens onto bare `$HOME`). */
const composeWorkingSet = (parts: readonly TWorkingSet[]): TWorkingSet => {
  const readWrite = new Set<string>();
  const readOnly = new Set<string>();
  for (const part of parts) {
    for (const p of part.readWrite) readWrite.add(p);
    for (const p of part.readOnly) readOnly.add(p);
  }
  // A read-write grant subsumes a read-only one — keep the lists disjoint.
  for (const rw of readWrite) readOnly.delete(rw);
  return {
    readWrite: existing([...readWrite]),
    readOnly: existing([...readOnly]),
  };
};

/**
 * The daemon's full base working set (no user grants — the §3.4 consent flow
 * will union persisted grants in here when it lands). The UNION of the shared
 * base and all four sub-process layers — the single-process daemon's allow-list,
 * consumed unchanged by `landlock.ts` + `seatbelt.ts`.
 *
 * `homeOverride` supplies the DAEMON's home explicitly instead of reading
 * `homedir()` (load-bearing for the `--sandbox-exec` shim — see
 * `base.ts#baseWorkingSet`).
 */
export const daemonWorkingSet = (homeOverride?: string): TWorkingSet => {
  const home = homeOverride ?? homedir();
  return composeWorkingSet([
    baseWorkingSet(homeOverride),
    authStateLayer(home),
    browserChatLayer(home),
    fleetLayer(home),
    vendorCliTunnelLayer(home),
  ]);
};

/**
 * The working set for ONE sub-process layer: the shared base ∪ that layer's
 * unique grants. This is the seam M2's `--sub <layer>` bootstrap calls so each
 * subprocess confines itself to exactly its own surface. Unused by the
 * single-process daemon today (which calls `daemonWorkingSet()` for the union).
 */
export const workingSetForLayer = (
  layer: TWorkingSetLayer,
  homeOverride?: string,
): TWorkingSet => {
  const home = homeOverride ?? homedir();
  return composeWorkingSet([
    baseWorkingSet(homeOverride),
    LAYER_BUILDERS[layer](home),
  ]);
};
