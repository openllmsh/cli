/**
 * Hermes — ledger-tracked sticky profile (proposal
 * `docs/proposals/hermes-client-integration.md`).
 *
 * After `openllm hermes install`, `openllm hermes` launches the TUI with
 * `HERMES_HOME` set to the sticky `openllm` profile (already overlaid). Without
 * a ledger (or with `--no-persist`) it uses the ephemeral session overlay
 * (`planHermes`). Native args other than install/uninstall/status are
 * forwarded. Default `~/.hermes/config.yaml` is never edited.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "../env";
import { requireCliApiKey } from "../onboarding";
import { contextStateDir, fetchTier, resolveGateway } from "./gateway";
import {
  hermesActiveProfilePath,
  hermesBundledTuiDir,
  hermesLedgerPath,
  hermesProfileDir,
  hermesRoot,
  isHermesProfileName,
  readActiveProfile,
  readHermesStickyProfile,
} from "./hermes-home";
import type { TLaunchInputs } from "./launch";
import { overlayVars } from "./launch";
import type { TJsonObject } from "./merge";
import { deepMerge, parseYaml, serializeYaml, substitute } from "./merge";
import { OVERLAYS } from "./overlays";
import type { TClientFlags } from "./registry";
import { CLIENTS } from "./registry";
import {
  execClient,
  findClientBinary,
  forwardedVendorArgs,
  runSessionClient,
} from "./session";

export {
  hermesProfileConfigPath,
  isHermesProfileName,
  readActiveProfile,
} from "./hermes-home";

const DEFAULT_PROFILE_NAME = "openllm";
const COLLISION_PROFILE_NAME = "openllm-gateway";
const CLONE_FILES = ["config.yaml", ".env", "SOUL.md"] as const;
const CLONE_DIRS = ["skills"] as const;

export type THermesLedger = {
  readonly version: 1;
  readonly cli_version: string;
  readonly previousProfile: string;
  readonly profileName: string;
  readonly createdProfile: boolean;
};

export const readHermesLedger = (): THermesLedger | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(hermesLedgerPath(), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const ledger = parsed as THermesLedger;
    if (
      !isHermesProfileName(ledger.previousProfile) ||
      !isHermesProfileName(ledger.profileName)
    ) {
      return null;
    }
    return ledger;
  } catch {
    return null;
  }
};

const writeLedger = (ledger: THermesLedger): void => {
  const path = hermesLedgerPath();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
};

export const setActiveProfile = (name: string): void => {
  const path = hermesActiveProfilePath();
  mkdirSync(hermesRoot(), { recursive: true, mode: 0o700 });
  if (name === "default") {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, `${name}\n`, { mode: 0o600 });
};

const openllmBinPath = (): string =>
  process.env.OPENLLM_BIN_OVERRIDE !== undefined &&
  process.env.OPENLLM_BIN_OVERRIDE.length > 0
    ? process.env.OPENLLM_BIN_OVERRIDE
    : process.execPath;

const parseConfig = (path: string): TJsonObject => {
  if (!existsSync(path)) return {};
  try {
    return parseYaml(readFileSync(path, "utf-8")) ?? {};
  } catch {
    return {};
  }
};

/** Read a profile config strictly: `{}` when absent or blank (nothing to
 *  lose), `null` when it exists but does not parse to an object — never
 *  silently `{}` (FS-12). */
const readProfileConfig = (path: string): TJsonObject | null => {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  if (text.trim().length === 0) return {};
  return parseYaml(text);
};

/** Copy an unparseable config aside before refusing — timestamped like the
 *  profile backups, private `0600`, never overwriting an earlier backup.
 *  Returns the backup path, or null when the backup itself could not be
 *  written (the refusal still stands either way). */
const backupUnparseableConfig = (configPath: string): string | null => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i += 1) {
    const candidate = `${configPath}.${stamp}${i === 0 ? "" : `-${i}`}.bak`;
    try {
      writeFileSync(candidate, readFileSync(configPath, "utf-8"), {
        mode: 0o600,
        flag: "wx",
      });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return null;
    }
  }
};

const copyIfExists = (from: string, to: string): void => {
  if (!existsSync(from)) return;
  mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
  cpSync(from, to, { recursive: true });
};

const cloneProfile = (sourceName: string, destDir: string): void => {
  const sourceDir = hermesProfileDir(sourceName);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  // cpSync preserves the source mode — a world-readable source .env would
  // stay world-readable with the API key inside (FS-11). Normalize: profile
  // dir owner-only, the .env owner read/write only.
  chmodSync(destDir, 0o700);
  for (const file of CLONE_FILES) {
    copyIfExists(join(sourceDir, file), join(destDir, file));
  }
  for (const dir of CLONE_DIRS) {
    copyIfExists(join(sourceDir, dir), join(destDir, dir));
  }
  const envPath = join(destDir, ".env");
  if (existsSync(envPath)) chmodSync(envPath, 0o600);
};

const upsertEnvKey = (envPath: string, key: string, value: string): void => {
  let body = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) body = body.replace(re, line);
  else
    body = `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(envPath, body.endsWith("\n") ? body : `${body}\n`, {
    mode: 0o600,
  });
  // The create mode is ignored for an existing file — a .env carried over with
  // loose permissions stays loose while holding the API key (FS-11).
  chmodSync(envPath, 0o600);
};

const pickProfileName = (ledger: THermesLedger | null): string => {
  if (ledger !== null) return ledger.profileName;
  if (!existsSync(hermesProfileDir(DEFAULT_PROFILE_NAME)))
    return DEFAULT_PROFILE_NAME;
  return COLLISION_PROFILE_NAME;
};

const buildOverlay = (opts: {
  readonly apiBase: string;
  readonly apiKey: string;
  readonly binPath: string;
  readonly stateDir: string;
  readonly tier: "free" | "trial" | "pro" | undefined;
}): TJsonObject => {
  const vars = overlayVars({
    client: CLIENTS.hermes,
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    binPath: opts.binPath,
    runDir: opts.stateDir,
    stateDir: opts.stateDir,
    tier: opts.tier,
  } satisfies TLaunchInputs);
  return parseYaml(substitute(OVERLAYS.hermes.config, vars)) ?? {};
};

const restartRootGateway = (bin: string | null): void => {
  if (bin === null) return;
  try {
    execFileSync(bin, ["gateway", "restart"], {
      stdio: "ignore",
      timeout: 15_000,
      env: { ...process.env, HERMES_HOME: hermesRoot() },
    });
  } catch {
    // Best-effort: sticky file still helps the next `hermes` and the next boot.
  }
};

export type THermesApplyResult = {
  readonly code: number;
  readonly profileHome?: string;
  readonly apiKey?: string;
};

export const applyHermes = async (opts?: {
  readonly remote?: boolean;
  readonly restartGateway?: boolean;
}): Promise<THermesApplyResult> => {
  const credential = requireCliApiKey("human");
  if (!credential.ok) {
    process.stderr.write(credential.message);
    return { code: 1 };
  }
  const gateway = await resolveGateway({
    remote: opts?.remote,
    config: credential.config,
  });
  const ledger = readHermesLedger();
  const sticky = readActiveProfile();
  const previousProfile =
    ledger !== null
      ? ledger.previousProfile
      : sticky === DEFAULT_PROFILE_NAME || sticky === COLLISION_PROFILE_NAME
        ? "default"
        : sticky;
  const name = pickProfileName(ledger);
  if (
    ledger === null &&
    name === COLLISION_PROFILE_NAME &&
    existsSync(hermesProfileDir(COLLISION_PROFILE_NAME))
  ) {
    process.stderr.write(
      "Hermes already has profiles named openllm and openllm-gateway; refuse to clobber. Rename one, then re-run.\n",
    );
    return { code: 1 };
  }
  const dest = hermesProfileDir(name);
  const created = !existsSync(dest);
  const sourceName = previousProfile === name ? "default" : previousProfile;
  if (created) cloneProfile(sourceName, dest);
  else {
    // Pull newly added source files (skills / SOUL) without clobbering
    // profile-only extras; config is merged below.
    for (const dir of CLONE_DIRS) {
      const from = join(hermesProfileDir(sourceName), dir);
      const to = join(dest, dir);
      if (existsSync(from) && !existsSync(to)) copyIfExists(from, to);
    }
    for (const file of CLONE_FILES) {
      if (file === "config.yaml" || file === ".env") continue;
      const from = join(hermesProfileDir(sourceName), file);
      const to = join(dest, file);
      if (existsSync(from) && !existsSync(to)) copyIfExists(from, to);
    }
    // An existing profile dir keeps its own mode — re-normalize it owner-only
    // (FS-11; cloneProfile does the same on the create path).
    chmodSync(dest, 0o700);
  }
  const tier = await fetchTier(gateway);
  const overlay = buildOverlay({
    apiBase: gateway.base,
    apiKey: gateway.apiKey,
    binPath: openllmBinPath(),
    stateDir: contextStateDir(),
    tier,
  });
  const sourceCfg = parseConfig(
    join(hermesProfileDir(sourceName), "config.yaml"),
  );
  const destConfigPath = join(dest, "config.yaml");
  const existing = readProfileConfig(destConfigPath);
  if (existing === null) {
    // FS-12: a config that fails to parse must never be rewritten from {} —
    // that would silently drop the user's profile. Back it up (0600), then
    // refuse and tell the user how to repair.
    if (created) {
      // This run just cloned the profile: its config is only a copy of the
      // SOURCE profile's config, which stays untouched. Remove the clone, or
      // the next run sees `openllm` taken, picks the collision name and
      // clones the same broken config again.
      const sourceConfig = join(hermesProfileDir(sourceName), "config.yaml");
      rmSync(dest, { recursive: true, force: true });
      process.stderr.write(
        `Refusing to install: ${sourceConfig} does not parse as YAML.\n` +
          `  repair it, then re-run \`openllm hermes install\`. Nothing was changed.\n`,
      );
      return { code: 1 };
    }
    const backup = backupUnparseableConfig(destConfigPath);
    process.stderr.write(
      `Refusing to rewrite ${destConfigPath}: it does not parse as YAML.\n` +
        (backup !== null
          ? `  the file was backed up to ${backup}\n`
          : "  the backup could not be written — the file was left untouched\n") +
        "  repair or remove it, then re-run `openllm hermes install`.\n",
    );
    return { code: 1 };
  }
  // Source fills gaps; existing profile edits win on conflict; overlay last.
  const merged = deepMerge(
    deepMerge(sourceCfg, existing),
    overlay,
  ) as TJsonObject;
  writeFileSync(destConfigPath, serializeYaml(merged), {
    mode: 0o600,
  });
  upsertEnvKey(join(dest, ".env"), "OPENLLM_API_KEY", gateway.apiKey);
  setActiveProfile(name);
  writeLedger({
    version: 1,
    cli_version: CLI_VERSION,
    previousProfile,
    profileName: name,
    createdProfile: ledger?.createdProfile === true || created,
  });
  if (opts?.restartGateway !== false) {
    restartRootGateway(findClientBinary(CLIENTS.hermes));
  }
  process.stdout.write(
    `Hermes profile '${name}' now routes through OpenLLM.\n` +
      `  sticky profile: ${name} (was ${previousProfile})\n` +
      `  launch TUI: openllm hermes\n` +
      `  uninstall: openllm hermes uninstall\n`,
  );
  return { code: 0, profileHome: dest, apiKey: gateway.apiKey };
};

/**
 * Where an uninstalled profile is preserved. Under the Hermes root (same
 * filesystem as the profile, so the move is a rename) but outside `profiles/`
 * so Hermes never lists it as a selectable profile.
 */
const profileBackupPath = (profileName: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i += 1) {
    const candidate = join(
      hermesRoot(),
      "backups",
      `${profileName}-${stamp}${i === 0 ? "" : `-${i}`}`,
    );
    if (!existsSync(candidate)) return candidate;
  }
};

const KEY_LINE = /^\s*(export\s+)?OPENLLM_API_KEY\s*=/;

/**
 * The `.env` entry's pre-redact state, captured before the first change. A
 * redact failure rolls the whole profile move back (LM-1), so the profile
 * that returns to its live path must be the one the uninstall found — not
 * a partially redacted version.
 */
type TEnvRestore =
  | { readonly kind: "file"; readonly body: string; readonly mode: number }
  | { readonly kind: "symlink"; readonly target: string };

/**
 * Write `content` as a NEW private temp file next to `envPath`. Returns the
 * temp path, or null when the temp could not be created — nothing at
 * `envPath` is touched either way.
 */
const writeEnvTmp = (envPath: string, content: string): string | null => {
  const tmp = `${envPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    return tmp;
  } catch {
    return null;
  }
};

/**
 * Write the redacted `.env` as a NEW regular file swapped atomically over
 * the checked path — the checked path is never opened for writing, so a
 * symlink swapped in after the `lstat` can never redirect the write into an
 * external target.
 */
const writeRedactedEnv = (envPath: string, kept: string[]): boolean => {
  const tmp = writeEnvTmp(envPath, kept.join("\n").replace(/\n*$/, "\n"));
  if (tmp === null) return false;
  try {
    renameSync(tmp, envPath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort — a leftover temp is not the secret itself
    }
    return false;
  }
};

/**
 * Put a captured `.env` entry back: the same symlink, or a regular file
 * with the original bytes and mode. Best-effort — the caller still rolls
 * the profile move back even when a restore cannot run.
 */
const restoreEnvEntry = (envPath: string, saved: TEnvRestore): void => {
  try {
    if (saved.kind === "symlink") {
      try {
        rmSync(envPath, { force: true });
      } catch {
        // nothing occupying the path, or the occupant cannot be removed —
        // the link create below reports its own failure
      }
      symlinkSync(saved.target, envPath);
      return;
    }
    const tmp = writeEnvTmp(envPath, saved.body);
    if (tmp === null) return;
    renameSync(tmp, envPath);
    chmodSync(envPath, saved.mode & 0o7777);
  } catch {
    // best effort — a restore failure never keeps the run from failing
  }
};

/**
 * FSS-19: a preserved profile must not keep a copy of the API key. Strip the
 * `OPENLLM_API_KEY=` lines `install` wrote (any other keys in a cloned .env
 * are the user's own and stay). A .env symlink is never followed for writing:
 * the link's target is an external file that must not be modified, so the
 * link is dropped and replaced by a redacted regular file built from the
 * target's contents. Returns true only when the key is verifiably absent —
 * an unverifiable result makes the caller fail loudly, never silently retain.
 * Every change this function makes is undone before a false return, so the
 * caller's rollback puts back exactly what the redact found.
 */
const redactProfileBackupKey = (backupDir: string): boolean => {
  const envPath = join(backupDir, ".env");
  // Verified-absent: the path is gone, or it is a REGULAR non-symlink file
  // with no key line. Anything else fails the check loudly.
  const verifiedAbsent = (): boolean => {
    try {
      const stat = lstatSync(envPath);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        !KEY_LINE.test(readFileSync(envPath, "utf-8"))
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };
  // Pre-mutation state: the dir mode before normalization, and the `.env`
  // entry before removal or replacement. `envMutated` tracks whether the
  // entry on disk still matches `savedEnv`.
  let dirMode: number | null = null;
  let savedEnv: TEnvRestore | null = null;
  let envMutated = false;
  const fail = (): boolean => {
    // Restore the `.env` entry first — it needs a writable dir, which the
    // dir-mode restore below can take away.
    if (envMutated && savedEnv !== null) restoreEnvEntry(envPath, savedEnv);
    if (dirMode !== null) {
      try {
        chmodSync(backupDir, dirMode);
      } catch {
        // best effort — a leftover widened mode never keeps the secret
      }
    }
    return false;
  };
  try {
    // The backup dir may carry a read-only mode cloned from the profile —
    // cpSync preserves directory modes, and a renamed dir keeps its own.
    // Every write below (tmp + rename, rm) needs owner write+exec on the
    // dir itself, so normalize it before the first mutation attempt.
    try {
      const dirStat = statSync(backupDir);
      if ((dirStat.mode & 0o700) !== 0o700) {
        dirMode = dirStat.mode;
        chmodSync(backupDir, dirStat.mode | 0o700);
      }
    } catch {
      // cannot normalize — the writes below report their own failure
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return fail();
    }
    if (stat.isSymbolicLink()) {
      const target = readFileSync(envPath, "utf-8");
      savedEnv = { kind: "symlink", target: readlinkSync(envPath) };
      const kept = target.split("\n").filter((line) => !KEY_LINE.test(line));
      if (kept.every((line) => line.trim() === "")) {
        rmSync(envPath, { force: true });
        envMutated = true;
        return verifiedAbsent() ? true : fail();
      }
      // Build the redacted replacement BEFORE dropping the link — when the
      // temp cannot be written the entry stays exactly as it was.
      const tmp = writeEnvTmp(envPath, kept.join("\n").replace(/\n*$/, "\n"));
      if (tmp === null) return fail();
      try {
        rmSync(envPath, { force: true });
        envMutated = true;
        renameSync(tmp, envPath);
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // best effort — a leftover temp is not the secret itself
        }
        return fail();
      }
      return verifiedAbsent() ? true : fail();
    }
    if (!stat.isFile()) {
      // A directory or other non-regular entry is not a backup env file.
      // Never remove it recursively. The caller must fail closed.
      return fail();
    }
    const body = readFileSync(envPath, "utf-8");
    savedEnv = { kind: "file", body, mode: stat.mode };
    const kept = body.split("\n").filter((line) => !KEY_LINE.test(line));
    if (kept.every((line) => line.trim() === "")) {
      rmSync(envPath, { force: true });
      envMutated = true;
      return verifiedAbsent() ? true : fail();
    }
    // A false return here means the checked file was never replaced — the
    // swap only runs after the redacted temp was written.
    if (!writeRedactedEnv(envPath, kept)) return fail();
    envMutated = true;
    return verifiedAbsent() ? true : fail();
  } catch {
    return fail();
  }
};

/**
 * Move a profile tree `from` to `to`: a same-filesystem rename, with a
 * copy+remove fallback for the cross-device case. The uninstall move and
 * its rollback run through this one helper so a restore puts back the same
 * shape the move found.
 */
const moveProfileDir = (from: string, to: string): void => {
  mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
};

/**
 * The `.env` path that still holds the key after a FAILED `uninstallHermes`
 * — the live profile's `.env` when the profile is in place (the move never
 * ran or was rolled back), else the preserved backup's `.env`. The command
 * layer reports exactly this path instead of inferring one from whatever
 * older backups happen to exist. Null when the last run did not fail.
 */
let residuePath: string | null = null;
export const hermesUninstallResiduePath = (): string | null => residuePath;

/**
 * The profile `install` created is the STICKY one — it holds every Hermes
 * session, memory, state.db and SOUL edit since then. Uninstall must not
 * delete it: move it to a timestamped backup and tell the user where.
 * The move runs BEFORE the ledger/sticky-pointer changes so a failure
 * leaves the wiring intact for a retry. A redaction failure after the move
 * rolls the move back (LM-1): a failed uninstall leaves the profile, the
 * ledger and the sticky pointer exactly as they were — no half-state.
 */
export const uninstallHermes = (): number => {
  residuePath = null;
  const ledger = readHermesLedger();
  if (ledger === null) {
    process.stdout.write(
      "Nothing to remove — Hermes is not wired to OpenLLM.\n",
    );
    return 0;
  }
  const dest = hermesProfileDir(ledger.profileName);
  let backup: string | null = null;
  if (ledger.createdProfile && existsSync(dest)) {
    backup = profileBackupPath(ledger.profileName);
    try {
      moveProfileDir(dest, backup);
    } catch {
      // The profile stays live at `dest`, but a partial backup may already
      // hold a copied .env — redact whatever landed before reporting the
      // failure so no copy of the key is left behind.
      const redacted = redactProfileBackupKey(backup);
      residuePath = existsSync(join(dest, ".env"))
        ? join(dest, ".env")
        : join(backup, ".env");
      process.stderr.write(
        `Could not move the Hermes profile to a backup — leaving ${dest} in place.\n` +
          (redacted
            ? ""
            : `  the partial backup at ${backup} may still contain OPENLLM_API_KEY — delete it by hand.\n`),
      );
      return 1;
    }
    if (!redactProfileBackupKey(backup)) {
      // The move is final only once the key is verifiably gone from the
      // copy. Put the profile back so the ledger, the sticky pointer and
      // the profile still agree, and the retry sees the same state the
      // first run saw.
      try {
        moveProfileDir(backup, dest);
        residuePath = join(dest, ".env");
        process.stderr.write(
          `Could not strip OPENLLM_API_KEY from ${join(dest, ".env")} — the profile stays in place, unchanged and still wired.\n` +
            "  fix or remove that entry, then re-run the uninstall.\n",
        );
      } catch {
        residuePath = join(backup, ".env");
        process.stderr.write(
          `Could not remove OPENLLM_API_KEY from the preserved profile — delete ${join(
            backup,
            ".env",
          )} by hand.\n` + `  the profile itself is preserved at ${backup}.\n`,
        );
      }
      return 1;
    }
  }
  setActiveProfile(ledger.previousProfile);
  rmSync(hermesLedgerPath(), { force: true });
  restartRootGateway(findClientBinary(CLIENTS.hermes));
  process.stdout.write(
    `Restored Hermes sticky profile to '${ledger.previousProfile}'.\n` +
      (backup !== null
        ? `  profile preserved at ${backup}\n` +
          "  (it holds your Hermes sessions and memories — delete it by hand when ready)\n"
        : ""),
  );
  return 0;
};

export const statusHermes = (): number => {
  const ledger = readHermesLedger();
  const sticky = readActiveProfile();
  process.stdout.write(
    `${JSON.stringify(
      {
        installed: ledger !== null,
        sticky,
        ...(ledger === null
          ? {}
          : {
              cli_version: ledger.cli_version,
              previousProfile: ledger.previousProfile,
              profileName: ledger.profileName,
              profile_exists: existsSync(hermesProfileDir(ledger.profileName)),
            }),
      },
      null,
      0,
    )}\n`,
  );
  return 0;
};

const HERMES_USAGE = `usage: openllm hermes [...args]
       openllm hermes install | uninstall | status

Launches Hermes TUI through OpenLLM. EVERY argument after hermes is forwarded
to hermes except our reserved verbs (install, uninstall, status). Native
commands such as profile, gateway, chat, and --tui/--cli are never overwritten.

  openllm hermes                 launch Hermes TUI (sticky profile after install)
  openllm hermes --tui           same; --tui is implied when argv is empty
  openllm hermes -z "prompt"     one-shot prompt (native -z)
  openllm hermes profile list    native profile command, forwarded
  openllm hermes install         sticky openllm profile (gateway/cron)
  openllm hermes uninstall       restore the previous sticky profile; the
                                 profile we created is moved to a timestamped
                                 backup under ~/.hermes/backups/, never deleted
  openllm hermes uninstall --yes skip the confirmation prompt
  openllm hermes status          report whether the sticky profile is wired
  openllm hermes --no-persist    session overlay (skip sticky profile)

Default ~/.hermes/config.yaml is never edited. Points at this machine's
daemon by default.

${CLIENTS.hermes.note}
`;

/** Empty launch (or only our overlay flag) → native TUI. Never inject --tui
 *  when the user already picked an interface or a native subcommand. */
const withImpliedTui = (forwarded: readonly string[]): readonly string[] => {
  if (forwarded.length > 0) return forwarded;
  return ["--tui"];
};

/** Read one line of confirmation from the terminal (canonical stdin). */
const readConfirmLine = async (): Promise<string> =>
  new Promise<string>((resolve) => {
    const stdin = process.stdin;
    let buffer = "";
    const onData = (chunk: string | Buffer): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        stdin.off("data", onData);
        stdin.pause();
        resolve(buffer.slice(0, newline));
      }
    };
    stdin.setEncoding("utf-8");
    stdin.on("data", onData);
    stdin.resume();
  });

/**
 * FS-5: the sticky profile is the user's Hermes history. The standalone
 * `openllm hermes uninstall` asks for a typed yes before touching it unless
 * `--yes` was passed; `uninstallHermes` itself never prompts (the product
 * `openllm uninstall` already confirmed) and only ever moves it to a backup.
 */
const confirmHermesUninstall = async (
  profileDir: string,
  previousProfile: string,
): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Refusing to remove the Hermes profile without a terminal — re-run with --yes.\n",
    );
    return false;
  }
  process.stdout.write(
    `This moves the Hermes profile at ${profileDir} to a timestamped backup\n` +
      `(nothing is deleted) and restores sticky profile '${previousProfile}'.\n` +
      "Type 'yes' to continue: ",
  );
  return (await readConfirmLine()).trim().toLowerCase() === "yes";
};

export const runHermesCommand = async (
  args: readonly string[],
  flags?: TClientFlags,
): Promise<number> => {
  const verb = args[0];
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(HERMES_USAGE);
    return 0;
  }
  if (verb === "install") {
    const applied = await applyHermes({ remote: flags?.remote });
    return applied.code;
  }
  if (verb === "uninstall") {
    const yes = args.includes("--yes") || args.includes("-y");
    if (!yes) {
      const ledger = readHermesLedger();
      // Confirmation is required only when a created profile would actually
      // be moved — restoring a pointer the user already had is loss-free.
      if (
        ledger?.createdProfile === true &&
        existsSync(hermesProfileDir(ledger.profileName))
      ) {
        if (
          !(await confirmHermesUninstall(
            hermesProfileDir(ledger.profileName),
            ledger.previousProfile,
          ))
        ) {
          process.stdout.write("Aborted — nothing changed.\n");
          return 1;
        }
      }
    }
    return uninstallHermes();
  }
  if (verb === "status") return statusHermes();
  const noPersist = args.includes("--no-persist");
  const forwarded = withImpliedTui(
    forwardedVendorArgs(args.filter((a) => a !== "--no-persist")),
  );
  const clientFlags = flags ?? parseEmptyFlags();
  const sticky = noPersist ? null : readHermesStickyProfile();
  if (sticky !== null) {
    const bin = findClientBinary(CLIENTS.hermes);
    if (bin === null) {
      process.stderr.write(
        `${CLIENTS.hermes.name} is not installed. Install it first:\n  ${CLIENTS.hermes.installHint}\n`,
      );
      return 127;
    }
    const credential = requireCliApiKey("human");
    if (!credential.ok) {
      process.stderr.write(credential.message);
      return 1;
    }
    const gateway = await resolveGateway({
      remote: clientFlags.remote,
      config: credential.config,
    });
    const dangerous =
      clientFlags.dangerous === true &&
      CLIENTS.hermes.dangerousFlag !== undefined
        ? [CLIENTS.hermes.dangerousFlag]
        : [];
    const tuiDir = hermesBundledTuiDir(bin);
    return execClient(
      bin,
      [...dangerous, ...forwarded],
      {
        HERMES_HOME: hermesProfileDir(sticky),
        OPENLLM_API_KEY: gateway.apiKey,
        OPENLLM_BIN: openllmBinPath(),
        CLAUDE_CONTEXT_STATE_DIR: contextStateDir(),
        ...(tuiDir === undefined ? {} : { HERMES_TUI_DIR: tuiDir }),
      },
      ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    );
  }
  return runSessionClient(CLIENTS.hermes, forwarded, clientFlags);
};

const parseEmptyFlags = (): TClientFlags => ({
  dangerous: false,
  remote: false,
  fresh: false,
  bare: false,
  attach: null,
  rest: ["hermes"],
});
