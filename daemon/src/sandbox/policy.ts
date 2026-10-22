/**
 * The daemon's ONE child-sandbox exemption policy — the single place that
 * decides which vendor spawns run UNCONFINED, and why.
 *
 * Baseline: the per-child model confines every risky spawn through the
 * `--sandbox-exec` shim (`./exec.ts`). The daemon and the device-session PTYs
 * are the intentional unconfined paths (see `./landlock.ts` header); THIS module
 * governs the only remaining exemptions among the confined-by-default children.
 *
 * Two independent exemptions (call sites pass the matching predicate as the
 * spawn's `probe` flag — never branch on platform/provider themselves):
 *
 *   1. macOS keychain (securityd). macOS `securityd` refuses keychain access to
 *      a Seatbelt-confined caller (empirically verified: a wrapped
 *      `claude auth status` returns `loggedIn:false` on a signed-in box even
 *      though the isolated keychain file is inside the granted working set —
 *      the denial is securityd, NOT the filesystem, so no SBPL allow-rule can
 *      fix it). So any spawn that reads or writes the macOS login keychain must
 *      run unwrapped ON macOS.
 *
 *   2. Linux Muse `serve` (#781). muse-bin's durable session store walks its
 *      data dir from `/` component-by-component (`open("/", O_NOFOLLOW|
 *      O_DIRECTORY)` → openat…). Landlock grants nothing at `/`, so the first
 *      open gets EACCES and Muse reports `UnsafePath`. No Muse setting moves
 *      the walk anchor (XDG_DATA_HOME/HOME only move the leaf);
 *      `--no-session-log` avoids the walk but on muse 1.4.1 turns never start.
 *      Isolation (overlay HOME/XDG, file credential backend, MUSE_LOGIN=0,
 *      `--disable-write` / `--disable-shell`) stays — only FS confinement is
 *      dropped, and ONLY for the `serve` host. macOS Muse serve stays
 *      confined (Seatbelt does not reproduce this root-anchored walk failure).
 *
 *   provider   store on macOS        unconfined spawns
 *   ─────────  ────────────────────  ───────────────────────────────────────────
 *   claude     login keychain        auth status · refresh (`-p ping`) · login
 *                                      (browser + paste-back) · native bridge
 *                                      — unwrapped on macOS only
 *   cursor     login keychain        refresh (`status`) · login · ACP bridge
 *                                      — unwrapped on macOS only
 *   muse       file (TBH=file)       `muse serve` host ONLY — unwrapped on
 *                                      Linux only (#781 root-anchored
 *                                      ConfinedDir walk). Login / logout /
 *                                      version stay confined on both platforms.
 *   codex      ~/.codex/auth.json     — file-backed: CONFINED on both platforms
 *   kimi       creds file            — file-backed: CONFINED on both platforms
 *   grok       ~/.grok/auth.json      — file-backed: CONFINED on both platforms
 *
 * On LINUX, file-backed credential stores live inside the granted isolated
 * home and stay confined — the Muse `serve` exemption above is the sole Linux
 * exception, and it is not credential-driven. Non-keychain / non-serve vendor
 * ops (`--version`, codex/kimi/grok anything, Muse login/logout) stay confined
 * on BOTH platforms. Version probes additionally avoid the hot-path cost of
 * confinement by only re-spawning when the binary's stat signature changes
 * (`../bin-signature.ts`), so they can stay wrapped for free.
 *
 * Call sites never branch on platform or provider themselves — they pass the
 * result of {@link unwrapKeychainSpawn} / {@link unwrapMuseServeSpawn} as the
 * spawn's `probe` flag, keeping the whole policy in this one module.
 */

/** Providers whose credential store is the macOS login keychain (securityd). */
const MAC_KEYCHAIN_PROVIDERS: ReadonlySet<string> = new Set([
  "claude_code",
  "cursor",
]);

/** True when the provider's macOS credential store is the login keychain. */
export const isMacKeychainProvider = (provider: string): boolean =>
  MAC_KEYCHAIN_PROVIDERS.has(provider);

/**
 * Does a KEYCHAIN-DEPENDENT spawn run unconfined here? True only on macOS, and
 * (when a provider is given) only for the keychain-backed providers. The
 * `security(1)` keychain tool itself carries no provider — call with no argument
 * and it unwraps on macOS (it is inherently a keychain operation, and is guarded
 * to macOS at its own call sites anyway).
 *
 * Pass the result straight to a spawn's `probe` flag. Non-keychain spawns
 * (`--version`, codex/kimi/grok, Muse login/logout, any Linux keychain-style
 * spawn) never call this and stay confined. Muse `serve` uses
 * {@link unwrapMuseServeSpawn} instead.
 */
export const unwrapKeychainSpawn = (provider?: string): boolean =>
  process.platform === "darwin" &&
  (provider === undefined || isMacKeychainProvider(provider));

/**
 * Does Muse's `serve` host run unconfined here? True ONLY on Linux — see the
 * module header (#781: root-anchored ConfinedDir walk under Landlock).
 *
 * `platform` is injectable so tests can assert both sides without a
 * process-global `mock.module("node:os")`. Production call sites omit it.
 *
 * Pass the result straight to `sandboxSpawnArgs(..., { probe })` from
 * {@link wrapMuseServeSpawn}. Login / logout / version probes must NOT call
 * this.
 */
export const unwrapMuseServeSpawn = (
  platform: NodeJS.Platform = process.platform,
): boolean => platform === "linux";
