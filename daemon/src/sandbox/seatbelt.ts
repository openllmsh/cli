/**
 * macOS in-process Seatbelt sandbox — the darwin counterpart to Linux Landlock
 * (`sandbox/landlock.ts`). Applied once at boot via `sandbox_init` (libsandbox)
 * through `bun:ffi`, BEFORE the listener binds: a deny-by-default SBPL profile
 * grants filesystem access ONLY to the daemon's working set (`working-set/`)
 * plus the system trees the runtime needs, and is inherited by every spawned
 * child — the same confinement model `sandbox-exec` uses. Both WRITES and READS
 * are deny-by-default whitelists (parity with Landlock): reads are open outside
 * `$HOME` — where the dynamic loader's broad system read lives and no user
 * secret does — but deny-by-default inside it, so `~/.ssh`, `~/.aws`, the user's
 * real `~/.codex`, keychains, browser cookies, and any other `$HOME` secret are
 * unreadable even if the daemon process is fully compromised.
 *
 * Why Seatbelt and not the App Sandbox: the App Sandbox (proposal §3.2) is the
 * "fully supported" path but requires Developer ID signing + notarization + a
 * container migration. Seatbelt's `sandbox_init` is deprecated-but-functional
 * (it's what `sandbox-exec` wraps) and works UNPRIVILEGED, in-process, with no
 * signing — exactly parallel to Landlock. The App Sandbox stays the future
 * Phase-C upgrade; this delivers real confinement now, on parity with Linux.
 *
 * Fail-open with a loud log (parity with Landlock): a macOS where the profile
 * is rejected must not stop the daemon serving — the posture rides
 * `DaemonStatus.sandbox` so an unconfined daemon is visible, not silent.
 */

import type { Pointer } from "bun:ffi";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logDebug, logWarn } from "../logger";
import type { TSandboxState } from "./landlock";
import { daemonWorkingSet } from "./working-set";

/** Escape a path for embedding in an SBPL `(subpath "...")` / `(literal "...")`. */
const esc = (p: string): string =>
  p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** macOS runtime paths the process tree must WRITE (beyond the daemon working
 *  set): device nodes, the per-user temp/cache (LaunchServices + Bun mmap),
 *  and the user-Library bits the vendor-CLI / browser-open flows write —
 *  `Caches` (npm/node + CLI caches) and `Preferences` (CLI prefs / Launch
 *  Services). The read side is open (see {@link buildProfile}); these are the
 *  WRITE allow-list additions. */
const macRuntimeWrite = (home: string): string[] => [
  "/dev",
  "/private/tmp",
  "/tmp",
  "/private/var/folders",
  join(home, "Library", "Caches"),
  join(home, "Library", "Preferences"),
];

/**
 * Read-allow paths INSIDE `$HOME`, beyond the working set: the macOS runtime
 * read surface the browser-open / LaunchServices path needs (`Caches` +
 * `Preferences` — the LaunchServices database `open` consults). Everything
 * OUTSIDE `$HOME` is blanket-readable (see {@link buildProfile}), so only the
 * in-home additions live here.
 */
const macHomeRead = (home: string): string[] => [
  join(home, "Library", "Caches"),
  join(home, "Library", "Preferences"),
];

/**
 * Vendor credential stores that sit INSIDE (or under) re-allowed working-set
 * config dirs and so must be re-denied even though a parent is granted — the
 * daemon writes config there but never needs the user's vendor tokens:
 *   - `~/.codex/auth.json` — codex OAuth store (its dir is a setup target);
 *   - `~/.claude/.credentials.json` — belt-and-braces: the working set now
 *     grants only scoped `~/.claude` subtrees (never the root), but macOS is
 *     where Claude Code keeps tokens in the keychain anyway — keep the file
 *     deny in case a future grant re-widens.
 * (`~/.grok/auth.json` needs no entry: the working set grants only the
 * config.toml FILE + the bin/downloads EXEC dirs at that root, so the
 * credential is never under a granted path.)
 * Denied for BOTH read (exfiltration) and write (tampering / token swap) —
 * `buildProfile` emits each rule under `file-read*` AND `file-write*`. Every
 * OTHER user secret (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/{gcloud,gh}`,
 * the login keychain, browser cookies, and anything unenumerated) is already
 * denied by the deny-`$HOME`-default and needs no explicit entry — that is
 * the whole point of flipping to a whitelist.
 */
const credentialDeny = (home: string): string[] => [
  `(literal "${esc(home)}/.codex/auth.json")`,
  `(literal "${esc(home)}/.claude/.credentials.json")`,
];

/**
 * Every strict in-`$HOME` ANCESTOR directory of the granted paths (plus
 * `$HOME` itself), for `file-read-metadata` literals. Path resolution + BSD
 * `mkdir -p` walk every ancestor of a target and `stat()` each one; with the
 * working set now SCOPED (e.g. `~/.claude/plugins` granted but `~/.claude`
 * not), a vendor script's `mkdir -p ~/.claude/plugins/x` would EPERM at the
 * unreadable `~/.claude` node exactly like the original `$HOME` bug this
 * generalises (see the profile comment). Metadata only — never contents: the
 * ancestors' OTHER children (e.g. `~/.claude/.credentials.json`) stay
 * deny-default. Pure + exported for unit tests.
 */
export const homeAncestorPaths = (
  granted: readonly string[],
  home: string,
): string[] => {
  const out = new Set<string>([home]);
  for (const p of granted) {
    if (!p.startsWith(`${home}/`)) continue;
    let cur = dirname(p);
    while (cur.startsWith(`${home}/`)) {
      out.add(cur);
      cur = dirname(cur);
    }
  }
  return [...out].sort();
};

/**
 * Build the SBPL profile. WRITES and READS are now BOTH deny-by-default
 * whitelists — parity with Linux Landlock (`landlock.ts`):
 *
 *   WRITES — only the daemon working set + the workflow targets
 *   (`working-set/`, incl. the scoped ~/.claude subtrees, ~/.codex,
 *   ~/.grok/config.toml)
 *   + the macOS runtime ({@link macRuntimeWrite}) are writable. Everything else
 *   (the rest of `$HOME`, the system) is write-denied — tamper protection.
 *
 *   READS — **deny-by-default WITHIN `$HOME`, whitelisted.** Everything OUTSIDE
 *   `$HOME` stays readable: the OS, the dyld shared cache, frameworks, the
 *   vendor binaries, and the TLS trust store hold no USER secret, and the
 *   dynamic loader needs broad system read at every child `exec`. Inside
 *   `$HOME` only the daemon's own footprint (the working set + {@link
 *   macHomeRead}) is granted, so the user's secrets are unreadable even if the
 *   daemon is fully compromised. (The earlier note that a read-whitelist
 *   "SIGABRTs every child" was a too-narrow system-read set, not a hard limit:
 *   a `(require-not (subpath $HOME))` allow keeps the loader's reads open while
 *   confining the only zone that holds secrets — validated in-process via
 *   `sandbox_init` + child inheritance, `tests/sandbox`.)
 *
 * `(allow default)` keeps non-file ops (mach/IPC/process/network) allowed so
 * the OAuth browser launch + keychain access run. `(with kill)` is NOT used —
 * a denial is a graceful `EPERM`. SBPL is last-match-wins, so the trailing
 * credential-file deny overrides the broader working-set allow above it.
 */
const buildProfile = (home: string, homeOverride?: string): string => {
  const ws = daemonWorkingSet(homeOverride);
  const writeAllow = [...ws.readWrite, ...macRuntimeWrite(home)]
    .map((p) => `  (subpath "${esc(p)}")`)
    .join("\n");
  // Re-allow the daemon's own footprint inside `$HOME` (the working set + the
  // macOS runtime read paths). Non-home reads are blanket-allowed below, so only
  // in-`$HOME` paths need explicit re-granting — everything outside is already
  // covered by the `(require-not (subpath $HOME))` allow. Filter them out so the
  // profile carries only live rules (on a prod build `ws.readOnly` is entirely
  // system paths, so the unfiltered list was all dead rules).
  const inHome = (p: string): boolean => p === home || p.startsWith(`${home}/`);
  const readAllow = [...ws.readWrite, ...ws.readOnly, ...macHomeRead(home)]
    .filter(inHome)
    .map((p) => `  (subpath "${esc(p)}")`)
    .join("\n");
  const credDeny = credentialDeny(home)
    .map((rule) => `  ${rule}`)
    .join("\n");
  // stat()-only ancestors of every granted in-home path (see homeAncestorPaths)
  // — the working set is scoped now, so intermediate nodes like `~/.claude`
  // must be stat-able for `mkdir -p` / path resolution without exposing their
  // contents.
  const metadataAllow = homeAncestorPaths(
    [...ws.readWrite, ...ws.readOnly, ...macRuntimeWrite(home)].filter(inHome),
    home,
  )
    .map((p) => `  (literal "${esc(p)}")`)
    .join("\n");
  return `(version 1)
(allow default)
; WRITES — deny-by-default whitelist: only the working set + workflow targets +
; macOS runtime are writable; everything else is write-denied (tamper guard).
(deny file-write*)
(allow file-write*
${writeAllow})
; READS — deny-by-default WITHIN $HOME, whitelisted. Everything outside $HOME
; stays readable (the dynamic loader needs broad system read at every child
; exec, and no USER secret lives there); inside $HOME only the daemon footprint
; is granted, so ~/.ssh, ~/.aws, keychains, browser cookies — every user secret
; — are unreadable even if the daemon is fully compromised.
(deny file-read*)
(allow file-read* (require-not (subpath "${esc(home)}")))
(allow file-read*
${readAllow})
; STAT (metadata only, NOT contents) of $HOME and every in-home ANCESTOR of a
; granted path. Path resolution + BSD \`mkdir -p\` walk every ancestor of a
; target and \`stat()\` each one; the working set is SCOPED (e.g.
; \`~/.claude/plugins\` granted, \`~/.claude\` not), so denying an intermediate
; node's metadata would EPERM \`mkdir -p ~/.claude/plugins/x\` at \`~/.claude\` —
; the same bug class as the original \`$HOME\`-only literal (claude.ai/install.sh
; \`mkdir -p $HOME/.claude/downloads\`). These are \`file-read-metadata\` literals
; on the DIRECTORY nodes only — not contents (every unenumerated subpath stays
; deny-default, and the credential denies below still apply), so no user secret
; becomes readable.
(allow file-read-metadata
${metadataAllow})
; …but the vendor credential STORES inside/under re-allowed config dirs stay
; denied (last-match-wins), for BOTH read (exfiltration) and write (token
; tampering): the daemon writes config there but never needs the tokens.
(deny file-read*
${credDeny})
(deny file-write*
${credDeny})
`;
};

let cachedState: TSandboxState | null = null;

/**
 * Apply the Seatbelt profile to THIS process (and, by inheritance, every child
 * it spawns). Idempotent. Never throws; returns + caches the resulting posture.
 */
export const applySeatbelt = (homeOverride?: string): TSandboxState => {
  if (cachedState !== null) return cachedState;
  try {
    const profile = `${buildProfile(homeOverride ?? homedir(), homeOverride)}\0`;
    const profileBuf = new TextEncoder().encode(profile);
    const lib = dlopen("/usr/lib/libsandbox.1.dylib", {
      sandbox_init: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      sandbox_free_error: { args: [FFIType.ptr], returns: FFIType.void },
    });
    // `int sandbox_init(const char *profile, uint64_t flags, char **errorbuf)`
    // — flags 0 = the profile arg is an SBPL string (not a named profile).
    const errBuf = new BigUint64Array(1);
    const rc = Number(
      lib.symbols.sandbox_init(ptr(profileBuf), 0n, ptr(errBuf)),
    );
    if (rc !== 0) {
      let msg = "unknown";
      const e = errBuf[0];
      if (e !== 0n) {
        const errPtr = Number(e) as unknown as Pointer;
        try {
          msg = new CString(errPtr).toString();
        } catch {
          // best-effort error text
        }
        lib.symbols.sandbox_free_error(errPtr);
      }
      logWarn(
        "sandbox",
        `seatbelt sandbox_init failed (${rc}): ${msg} — running unconfined`,
      );
      cachedState = "error";
      return cachedState;
    }
    // Debug, not info: this now runs inside the per-spawn `--sandbox-exec`
    // shim (the daemon process itself is unconfined), so at info it floods the
    // shared log with one line per wrapped child spawn.
    logDebug("sandbox", "seatbelt enforced", {
      allowWrite: daemonWorkingSet(homeOverride).readWrite.length,
    });
    cachedState = "enforced";
    return cachedState;
  } catch (err) {
    logWarn(
      "sandbox",
      `seatbelt setup threw (${err instanceof Error ? err.message : String(err)}) — running unconfined`,
    );
    cachedState = "error";
    return cachedState;
  }
};
