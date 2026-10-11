/**
 * `fleet` sub-process layer — daemon-to-daemon channel: the peer
 * consumer/server (RTC client, tunnel client/server for peer daemons). `/v1`
 * ENDPOINTS ONLY: like `browser-chat`, it terminates network transport and
 * proxies inference between peer daemons, so it needs NO filesystem-secret
 * grants (in-memory + egress). It never sees the keychain, credential files,
 * real `$HOME`, or the device key.
 *
 * Its working set is exactly the shared base (`base.ts`) — the empty
 * layer-specific set here is the point (R2-T9): a network-facing compromise in
 * the peer channel has no credential path to reach.
 *
 * See `docs/proposals/daemon-subprocess-isolation.md` §3.1 (`peer-channel`
 * row — "—").
 */
import type { TWorkingSet } from "./base";

/**
 * The `fleet` layer's unique working set: empty. All it needs is the shared
 * base, unioned in by `index.ts`.
 */
export const fleetLayer = (_home: string): TWorkingSet => ({
  readWrite: [],
  readOnly: [],
});
