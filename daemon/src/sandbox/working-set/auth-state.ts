/**
 * `auth & state` sub-process layer — vendor CLI delegation: login flows,
 * credential capture, usage reads, the Keychain dance. This layer owns
 * essentially ALL of the daemon's filesystem-secret grants: the isolated vendor
 * CLI homes + keychain-adjacent config under the state dir, and READ+EXEC of the
 * vendor binaries it spawns.
 *
 * Returns ONLY this layer's UNIQUE grants — the shared state dir, temp, `/dev`,
 * and system read trees live in `base.ts`. `index.ts` unions the two. The whole
 * `state` dir (which holds `<state>/cli/<provider>/**`) is granted by the base
 * for M1.5 union parity; when the `--sub auth` subprocess drops the base's broad
 * `state` grant (R2-M2), the `<state>/cli` slice moves here.
 *
 * See `docs/proposals/daemon-subprocess-isolation.md` §3.1 (`auth` row).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cliConfigDir } from "../../cli-paths";
import type { TWorkingSet } from "./base";
import { vendorExecDirs } from "./base";
import { delegatedCliRuntimeSet } from "./delegated-cli-runtime";

/**
 * The `auth-state` layer's unique working set (pre-normalization — `index.ts`
 * runs `existing()`).
 */
export const authStateLayer = (home: string): TWorkingSet => {
  // Muse's isolated auth store is `$XDG_CONFIG_HOME/muse` →
  // `<cliHome("muse")>/.config/muse` (auth.json). Pre-create that leaf so a
  // future decomposed `<state>/cli` grant can address it; today the whole
  // state dir already covers it.
  //
  // Claude's XDG STATE + CACHE are under the ISOLATED home
  // (`cliEnv` pins XDG_STATE_HOME/XDG_CACHE_HOME → `<cliHome>/.local/state` /
  // `.cache`). Do NOT mkdir or RW-grant the real-home
  // `~/.local/state/claude` / `~/.cache/claude` — that contradicted L3
  // ("never RW real ~/.local/state") once L2 isolation landed. Isolated
  // leaves are covered by `delegatedCliRuntimeSet` → `cliHome` RW.
  try {
    mkdirSync(cliConfigDir("muse"), { recursive: true });
  } catch {
    // best-effort — an ungranted leaf just fails that vendor's run visibly.
  }
  // bun's global install cache — the RW half of the split ~/.bun grant. Only
  // pre-create it when bun IS installed: absent bun means the plugin install
  // fails its own `command -v bun` check, and fabricating ~/.bun on a bun-less
  // box would be pure noise.
  const bunCache = join(home, ".bun", "install", "cache");
  if (existsSync(join(home, ".bun"))) {
    try {
      mkdirSync(bunCache, { recursive: true });
    } catch {
      // best-effort — see the claude-dir loop above.
    }
  }
  // L3 shared delegated-CLI runtime owns isolated homes + state tmp +
  // launcher data roots (incl. mise via launcher-roots). One owner — do not
  // also union `miseDirs` here (was a duplicate RO grant source).
  const runtime = delegatedCliRuntimeSet(home);
  const readWrite = new Set<string>([
    ...runtime.readWrite,
    //   bun's global install cache ONLY (the SPLIT ~/.bun grant — audit §5-B):
    //   a plugin install running `bun install` populates
    //   ~/.bun/install/cache. The `bun` BINARY dir (~/.bun/bin) is read+exec in
    //   the readOnly set below — write access there would let a compromised
    //   daemon trojan the user's `bun` launcher. `existing()` drops it when bun
    //   isn't installed (the install then fails its own `command -v bun` check,
    //   correctly). Holds no credentials.
    bunCache,
  ]);
  const readOnly = new Set<string>([
    // The vendor-CLI binary dirs — READ+EXEC only (hardcoded floor + dynamic
    // symlink-chain resolution). The daemon RUNS the vendor CLIs (login/usage
    // delegation) but never WRITES them: installs are user-run + unsandboxed.
    ...vendorExecDirs(home),
    ...runtime.readOnly,
    // bun's BINARY dir — read+exec only (the split ~/.bun grant, audit §5-B):
    // the plugin install must EXEC `bun`, but a write grant here would let a
    // compromised daemon replace the user's `bun` launcher. The cache half
    // (~/.bun/install/cache) is read-write above. `existing()` returns the
    // path unchanged when bun isn't installed, and the missing-path rule is
    // skipped at apply time — correct (nothing to exec anyway).
    join(home, ".bun", "bin"),
  ]);
  // A read-write grant subsumes a read-only one.
  for (const rw of readWrite) readOnly.delete(rw);
  return {
    readWrite: [...readWrite],
    readOnly: [...readOnly],
  };
};
