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
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "../env";
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

const copyIfExists = (from: string, to: string): void => {
  if (!existsSync(from)) return;
  mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
  cpSync(from, to, { recursive: true });
};

const cloneProfile = (sourceName: string, destDir: string): void => {
  const sourceDir = hermesProfileDir(sourceName);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const file of CLONE_FILES) {
    copyIfExists(join(sourceDir, file), join(destDir, file));
  }
  for (const dir of CLONE_DIRS) {
    copyIfExists(join(sourceDir, dir), join(destDir, dir));
  }
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
  const gateway = await resolveGateway({ remote: opts?.remote });
  if (gateway.apiKey.length === 0) {
    process.stderr.write(
      "No OpenLLM API key configured — set OPENLLM_API_KEY, or pair the daemon so ~/.openllm/.env carries it.\n",
    );
    return { code: 1 };
  }
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
  const existing = parseConfig(join(dest, "config.yaml"));
  // Source fills gaps; existing profile edits win on conflict; overlay last.
  const merged = deepMerge(
    deepMerge(sourceCfg, existing),
    overlay,
  ) as TJsonObject;
  writeFileSync(join(dest, "config.yaml"), serializeYaml(merged), {
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

export const uninstallHermes = (): number => {
  const ledger = readHermesLedger();
  if (ledger === null) {
    process.stdout.write(
      "Nothing to remove — Hermes is not wired to OpenLLM.\n",
    );
    return 0;
  }
  setActiveProfile(ledger.previousProfile);
  const dest = hermesProfileDir(ledger.profileName);
  if (ledger.createdProfile) {
    rmSync(dest, { recursive: true, force: true });
  }
  rmSync(hermesLedgerPath(), { force: true });
  restartRootGateway(findClientBinary(CLIENTS.hermes));
  process.stdout.write(
    `Restored Hermes sticky profile to '${ledger.previousProfile}'.\n`,
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
  openllm hermes uninstall       restore the previous sticky profile
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
  if (verb === "uninstall") return uninstallHermes();
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
    const gateway = await resolveGateway({ remote: clientFlags.remote });
    if (gateway.apiKey.length === 0) {
      process.stderr.write(
        "No OpenLLM API key configured — set OPENLLM_API_KEY, or pair the daemon so ~/.openllm/.env carries it.\n",
      );
      return 1;
    }
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
  attach: null,
  rest: ["hermes"],
});
