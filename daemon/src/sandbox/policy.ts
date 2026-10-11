/**
 * The daemon's ONE child-sandbox exemption policy — the single place that
 * decides which vendor spawns run UNCONFINED, and why.
 *
 * Baseline: the per-child model confines every risky spawn through the
 * `--sandbox-exec` shim (`./exec.ts`). The daemon and the device-session PTYs
 * are the intentional unconfined paths (see `./landlock.ts` header); THIS module
 * governs the only remaining exemption among the confined-by-default children.
 *
 * The exemption is macOS-only and keychain-driven. macOS `securityd` refuses
 * keychain access to a Seatbelt-confined caller (empirically verified: a wrapped
 * `claude auth status` returns `loggedIn:false` on a signed-in box even though
 * the isolated keychain file is inside the granted working set — the denial is
 * securityd, NOT the filesystem, so no SBPL allow-rule can fix it). So any spawn
 * that reads or writes the macOS login keychain must run unwrapped ON macOS:
 *
 *   provider   store on macOS        keychain-dependent spawns (unwrapped on mac)
 *   ─────────  ────────────────────  ───────────────────────────────────────────
 *   claude     login keychain        auth status · refresh (`-p ping`) · login
 *                                     (browser + paste-back) · native bridge
 *   cursor     login keychain        refresh (`status`) · login · ACP bridge
 *   codex      ~/.codex/auth.json     — file-backed: CONFINED on both platforms
 *   kimi       creds file            — file-backed: CONFINED on both platforms
 *   grok       ~/.grok/auth.json      — file-backed: CONFINED on both platforms
 *
 * On LINUX every provider's store is a plain file inside the granted isolated
 * home, so NOTHING is exempt — Landlock confines all of them. Non-keychain
 * vendor ops (`--version`, codex/kimi/grok anything) stay confined on BOTH
 * platforms. Version probes additionally avoid the hot-path cost of confinement
 * by only re-spawning when the binary's stat signature changes
 * (`../bin-signature.ts`), so they can stay wrapped for free.
 *
 * Call sites never branch on platform or provider themselves — they pass the
 * result of {@link unwrapKeychainSpawn} as the spawn's `probe` flag, keeping the
 * whole policy in this one predicate.
 */

/** Providers whose credential store is the macOS login keychain (securityd). */
const MAC_KEYCHAIN_PROVIDERS: ReadonlySet<string> = new Set([
  "claude_code",
  "cursor",
]);

/**
 * Does a KEYCHAIN-DEPENDENT spawn run unconfined here? True only on macOS, and
 * (when a provider is given) only for the keychain-backed providers. The
 * `security(1)` keychain tool itself carries no provider — call with no argument
 * and it unwraps on macOS (it is inherently a keychain operation, and is guarded
 * to macOS at its own call sites anyway).
 *
 * Pass the result straight to a spawn's `probe` flag. Non-keychain spawns
 * (`--version`, codex/kimi/grok, any Linux spawn) never call this and stay
 * confined.
 */
export const unwrapKeychainSpawn = (provider?: string): boolean =>
  process.platform === "darwin" &&
  (provider === undefined || MAC_KEYCHAIN_PROVIDERS.has(provider));
