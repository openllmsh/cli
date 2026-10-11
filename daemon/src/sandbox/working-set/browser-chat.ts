/**
 * `browser chat` sub-process layer — RTC host + mux + `/v1` tunnel serving for
 * the dashboard. `/v1` ENDPOINTS ONLY: this layer terminates network transport
 * and proxies inference, so it needs NO filesystem-secret grants at all
 * (in-memory + egress). It never sees the keychain, the credential files, the
 * real `$HOME`, or the device key.
 *
 * This emptiness is the whole security point of the split (R2-T9): a compromised
 * tunnel parser in this subprocess has no credential path to pivot from. Its
 * working set is exactly the shared base (`base.ts`) and nothing more.
 *
 * See `docs/proposals/daemon-subprocess-isolation.md` §3.1 (`browser-tunnel`
 * row — "— (in-memory)").
 */
import type { TWorkingSet } from "./base";

/**
 * The `browser-chat` layer's unique working set: empty. All it needs is the
 * shared base, unioned in by `index.ts`.
 */
export const browserChatLayer = (_home: string): TWorkingSet => ({
  readWrite: [],
  readOnly: [],
});
