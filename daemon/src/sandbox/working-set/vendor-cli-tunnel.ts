/**
 * `tunnel` sub-process layer — device-session PTY hosting for browser-attached
 * vendor CLI sessions. Grants vendor-CLI access "as required by the vendor CLI,
 * incrementally": it EXECS the real vendor binaries (a session is the real CLI
 * under a real PTY), so it carries the shared READ+EXEC vendor binary dirs.
 *
 * The overlap with the `auth-state` layer on `vendorExecDirs` is expected and
 * correct — both legitimately exec the vendor CLIs. What R2-T9 guarantees is
 * that the network-facing `/v1`-only layers (`browser-chat`, `fleet`) carry NO
 * such grant, not that the two exec-capable layers are byte-disjoint.
 *
 * The `<state>/run` + `<state>/sessions` session registries this layer writes
 * are covered by the base's whole-`state` grant for M1.5 (see `base.ts`
 * TODO(R2-M2)). The broad real-`$HOME` grant device sessions ultimately need
 * (§3.1 `session-tunnel` row) is DEFERRED to M2/M3 — adding it now would widen
 * the single-process union beyond today's behavior and break the parity gate.
 *
 * See `docs/proposals/daemon-subprocess-isolation.md` §3.1 (`session-tunnel`
 * row) + §4 (the session supervisor).
 */

import type { TWorkingSet } from "./base";
import { miseDirs, vendorExecDirs } from "./base";

/**
 * The `vendor-cli-tunnel` layer's unique working set (pre-normalization —
 * `index.ts` runs `existing()`).
 */
export const vendorCliTunnelLayer = (home: string): TWorkingSet => {
  // A mise-managed vendor CLI runs through mise's roots (see `miseDirs`).
  const mise = miseDirs(home);
  return {
    readWrite: mise.readWrite,
    // The vendor-CLI binary dirs — READ+EXEC only. A device PTY session execs
    // the real vendor binary; the daemon never writes it (installs are
    // user-run + unsandboxed). Shared with `auth-state` via the base helper.
    readOnly: [...vendorExecDirs(home), ...mise.readOnly],
  };
};
