/**
 * ChatGPT Mac app — always-on client (`openllm chatgpt`).
 *
 * ChatGPT.app (`com.openai.codex`) is Codex Desktop: it spawns its embedded
 * `codex` binary as an app-server and honours `$CODEX_CLI_PATH` to replace it.
 * A live probe confirmed that a shim there, adding the Codex overlay as `-c`
 * overrides, routes both `/v1/models` and `/v1/responses` through OpenLLM —
 * env-only, with the user's REAL `~/.codex` (chats, auth) untouched. See
 * docs/audit/2026-08-23-cowork-codex-mac-app-setups.md §9.0 / §9.2.
 *
 * Three moving parts, all reversible from one ledger:
 *
 *   - `openllm chatgpt` installs `/Applications/OpenLLM ChatGPT.app`, a
 *     logic-free launcher whose executable runs `openllm chatgpt launch`;
 *   - `launch` rewrites the codex shim under `~/.openllm/clients/chatgpt/`
 *     (fresh gateway/catalog/tier on every click) and starts ChatGPT with
 *     `CODEX_CLI_PATH` pointing at it;
 *   - `uninstall` removes the launcher, the shim dir, and the ledger.
 *
 * Nothing here ever writes `~/.codex`. The API key reaches the app-server via
 * the `env_key` overlay + `open --env`, never argv or disk.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { CLI_VERSION, cliBinPath, openllmDir } from "../env";
import { requireCliApiKey } from "../onboarding";
import {
  contextStateDir,
  fetchModelCatalog,
  fetchTier,
  resolveGateway,
} from "./gateway";
import { codexOverrideArgs, mcpArgsJson } from "./launch";
import {
  appIconPath,
  installMacLauncher,
  macLauncherPath,
  shellQuote,
  uninstallMacLauncher,
} from "./mac-launcher";
import { requireProviderRouting } from "./provider-preflight";
import type { TClientFlags } from "./registry";
import { CLIENTS } from "./registry";

export const CHATGPT_BUNDLE_ID = "com.openai.codex";
export const CHATGPT_LAUNCHER_BUNDLE_ID = "sh.openllm.chatgpt-launcher";
const LAUNCHER_APP_NAME = "OpenLLM ChatGPT.app";
const LAUNCHER_EXEC = "OpenLLMChatGPT";
const DOWNLOAD_URL = "https://chatgpt.com/download";

const USAGE = `usage: openllm [-r] chatgpt [uninstall|status]

Installs "OpenLLM ChatGPT" in /Applications. Open it instead of ChatGPT to run
the ChatGPT Mac app through OpenLLM — your chats and ~/.codex stay as they are.

  openllm chatgpt              install / refresh the launcher
  openllm -r chatgpt           launcher uses the CLOUD gateway instead of the daemon
  openllm chatgpt uninstall    remove the launcher and everything it wrote
  openllm chatgpt status       report whether the launcher is installed

macOS only. Requires /Applications/ChatGPT.app (${DOWNLOAD_URL}).
`;

export const chatgptLedgerPath = (): string =>
  join(openllmDir(), "clients", "chatgpt.json");

/** OpenLLM-owned scratch for the shim + catalog. Removed whole on uninstall. */
export const chatgptStateDir = (): string =>
  join(openllmDir(), "clients", "chatgpt");

export const chatgptShimPath = (): string =>
  join(chatgptStateDir(), "codex-shim");

export const chatgptLauncherPath = (): string =>
  macLauncherPath(LAUNCHER_APP_NAME);

export const chatgptAppPath = (): string => {
  const override = process.env.OPENLLM_CHATGPT_APP;
  return override !== undefined && override.length > 0
    ? override
    : "/Applications/ChatGPT.app";
};

/**
 * Where ChatGPT.app has shipped its embedded codex, newest layout first:
 * `Resources/codex-cli/bin/codex` (26.9xx+), `Resources/codex` (≤26.8xx).
 */
const CODEX_CANDIDATES = [["codex-cli", "bin", "codex"], ["codex"]] as const;

/** The codex binary ChatGPT.app embeds — what the shim forwards to. Null when
 *  no known layout matches (an app update moved it again). */
export const chatgptCodexPath = (): string | null => {
  const resources = join(chatgptAppPath(), "Contents", "Resources");
  for (const segments of CODEX_CANDIDATES) {
    const path = join(resources, ...segments);
    if (existsSync(path)) return path;
  }
  return null;
};

export type TChatgptLedger = {
  readonly version: 1;
  readonly cli_version: string;
  readonly launcher_path: string;
  /** `-r` at install time — the launcher passes it on every launch. */
  readonly remote: boolean;
};

const readLedger = (): TChatgptLedger | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(chatgptLedgerPath(), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as TChatgptLedger;
  } catch {
    return null;
  }
};

const writeLedger = (ledger: TChatgptLedger): void => {
  const path = chatgptLedgerPath();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
};

const macOk = (): boolean =>
  process.platform === "darwin" ||
  process.env.OPENLLM_MAC_APPS_ALLOW_NON_DARWIN === "1";

const launchEnabled = (): boolean =>
  process.platform === "darwin" &&
  process.env.OPENLLM_MAC_APPS_NO_LAUNCH !== "1";

/**
 * The binary the launcher (and the shim's MCP entry) runs: the compiled
 * `openllm` that is executing right now, so a launcher installed by a dev or
 * side-by-side build runs THAT build rather than an older installed one that
 * may not know `chatgpt`. Under `bun src/main.ts` execPath is bun itself, so
 * fall back to the installed CLI.
 */
const openllmBinPath = (): string => {
  const override = process.env.OPENLLM_BIN_OVERRIDE;
  if (override !== undefined && override.length > 0) return override;
  const self = basename(process.execPath);
  if (self === "openllm" || self === "ollm") return process.execPath;
  return existsSync(cliBinPath()) ? cliBinPath() : process.execPath;
};

/** A GUI launch has no terminal — surface failures as a dialog too. */
const alert = (title: string, message: string): void => {
  process.stderr.write(`${title}: ${message}\n`);
  if (!launchEnabled()) return;
  spawnSync(
    "osascript",
    [
      "-e",
      `display alert ${JSON.stringify(title)} message ${JSON.stringify(message)}`,
    ],
    { stdio: "ignore" },
  );
};

/**
 * The shim ChatGPT runs in place of its embedded codex. Carries no secret.
 *
 * Position matters: ChatGPT starts its main backend as
 * `codex -c … app-server … -c plugins.…`, and codex lets a subcommand's own
 * `-c` list REPLACE the top-level one — so overrides placed before
 * `app-server` were silently dropped and the UI fell back to the built-in
 * GPT models. For `app-server` we therefore append ours LAST (later `-c`
 * wins); every other invocation (exec-server, …) keeps them first.
 */
export const renderCodexShim = (
  codexPath: string,
  overrideArgs: readonly string[],
): string => {
  const bin = shellQuote(codexPath);
  const ours = overrideArgs.map(shellQuote).join(" ");
  return `#!/bin/sh
case " $* " in
  *" app-server "*) exec ${bin} "$@" ${ours} ;;
  *) exec ${bin} ${ours} "$@" ;;
esac
`;
};

/**
 * `open(1)` argv for a fresh ChatGPT process wired to the shim. Pure, for tests.
 * Deliberately no `CODEX_HOME`: the real home is what makes chats resume.
 * `CODEX_APP_SERVER_FORCE_CLI` forces the stdio spawn so the shim is used.
 */
export const chatgptOpenArgs = (
  shimPath: string,
  apiKey: string,
): readonly string[] => [
  "-n",
  "-b",
  CHATGPT_BUNDLE_ID,
  "--env",
  `CODEX_CLI_PATH=${shimPath}`,
  "--env",
  "CODEX_APP_SERVER_FORCE_CLI=1",
  "--env",
  `OPENLLM_API_KEY=${apiKey}`,
];

const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const chatgptRunning = (): boolean =>
  spawnSync("pgrep", ["-f", `${chatgptAppPath()}/Contents/MacOS/`], {
    stdio: "ignore",
  }).status === 0;

/** Env applies only to a fresh process, so quit a running ChatGPT first. */
const quitChatgpt = (): void => {
  if (!chatgptRunning()) return;
  spawnSync("osascript", ["-e", `quit app id "${CHATGPT_BUNDLE_ID}"`], {
    stdio: "ignore",
  });
  const deadline = Date.now() + 8_000;
  while (chatgptRunning() && Date.now() < deadline) sleepMs(200);
};

/** Install / refresh the launcher. Does not start ChatGPT. */
export const installChatgpt = async (opts?: {
  readonly remote?: boolean;
}): Promise<number> => {
  if (!macOk()) {
    process.stderr.write("openllm chatgpt is macOS-only.\n");
    return 1;
  }
  if (!existsSync(chatgptAppPath())) {
    process.stderr.write(
      `ChatGPT.app not found at ${chatgptAppPath()}.\n` +
        `Install it from ${DOWNLOAD_URL}, then re-run: openllm chatgpt\n`,
    );
    return 1;
  }
  const credential = requireCliApiKey("human");
  if (!credential.ok) {
    process.stderr.write(credential.message);
    return 1;
  }
  const gateway = await resolveGateway({
    remote: opts?.remote,
    config: credential.config,
  });
  if (!(await requireProviderRouting(gateway))) return 1;

  const remote = opts?.remote === true;
  const launcher = chatgptLauncherPath();
  const result = installMacLauncher(launcher, {
    displayName: "OpenLLM ChatGPT",
    bundleId: CHATGPT_LAUNCHER_BUNDLE_ID,
    executableName: LAUNCHER_EXEC,
    command: [openllmBinPath(), ...(remote ? ["-r"] : []), "chatgpt", "launch"],
    iconPath: appIconPath(chatgptAppPath()),
  });
  if (result === "foreign") {
    process.stderr.write(
      `${launcher} already exists and isn't an OpenLLM launcher — refusing to replace it.\n`,
    );
    return 1;
  }
  writeLedger({
    version: 1,
    cli_version: CLI_VERSION,
    launcher_path: launcher,
    remote,
  });
  process.stdout.write(
    `✓ Installed ${launcher}\n` +
      `  gateway: ${remote ? "cloud" : "local daemon (cloud fallback)"}\n` +
      '  Open "OpenLLM ChatGPT" from Spotlight or Launchpad to use ChatGPT through OpenLLM.\n' +
      "  Remove with: openllm chatgpt uninstall\n",
  );
  return 0;
};

/** What the launcher runs: refresh the shim, then (re)start ChatGPT on it. */
export const launchChatgpt = async (opts?: {
  readonly remote?: boolean;
}): Promise<number> => {
  if (!macOk()) {
    process.stderr.write("openllm chatgpt is macOS-only.\n");
    return 1;
  }
  if (!existsSync(chatgptAppPath())) {
    alert(
      "ChatGPT not found",
      `Install ChatGPT from ${DOWNLOAD_URL}, then open OpenLLM ChatGPT again.`,
    );
    return 1;
  }
  const codex = chatgptCodexPath();
  if (codex === null) {
    alert(
      "Unsupported ChatGPT version",
      "This ChatGPT build moved its embedded codex. Update OpenLLM (openllm update), then try again.",
    );
    return 1;
  }
  const credential = requireCliApiKey("machine");
  if (!credential.ok) {
    alert("OpenLLM needs an API key", "Run `openllm chatgpt` in a terminal.");
    return 1;
  }
  const gateway = await resolveGateway({
    remote: opts?.remote,
    config: credential.config,
  });
  const [catalog, tier] = await Promise.all([
    fetchModelCatalog(gateway, CLIENTS.chatgpt.catalogSlug ?? "codex"),
    fetchTier(gateway),
  ]);

  const dir = chatgptStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const catalogPath = join(dir, "models.json");
  if (catalog !== null) writeFileSync(catalogPath, catalog, { mode: 0o600 });
  else rmSync(catalogPath, { force: true });
  const args = codexOverrideArgs(
    {
      OPENLLM_API_BASE: gateway.base,
      OPENLLM_BIN: openllmBinPath(),
      STATE_DIR: contextStateDir(),
      MODEL_CATALOG_PATH: catalogPath,
      MCP_ARGS: mcpArgsJson(tier),
    },
    catalog !== null,
  );
  const shim = chatgptShimPath();
  writeFileSync(shim, renderCodexShim(codex, args), {
    mode: 0o755,
  });

  if (!launchEnabled()) return 0;
  quitChatgpt();
  const opened = spawnSync("open", chatgptOpenArgs(shim, gateway.apiKey), {
    stdio: "ignore",
  });
  if (opened.status !== 0) {
    alert("Couldn't open ChatGPT", "Try opening OpenLLM ChatGPT again.");
    return 1;
  }
  return 0;
};

export const uninstallChatgpt = (): number => {
  const ledger = readLedger();
  const launcherRemoved = uninstallMacLauncher(
    ledger?.launcher_path ?? chatgptLauncherPath(),
    CHATGPT_LAUNCHER_BUNDLE_ID,
  );
  const hadState = existsSync(chatgptStateDir());
  rmSync(chatgptStateDir(), { recursive: true, force: true });
  rmSync(chatgptLedgerPath(), { force: true });
  process.stdout.write(
    launcherRemoved || hadState || ledger !== null
      ? "✓ Removed OpenLLM ChatGPT.\n  If ChatGPT is running through OpenLLM, quit it and reopen it normally.\n"
      : "Nothing to remove — OpenLLM ChatGPT is not installed.\n",
  );
  return 0;
};

/** One JSON line for scripts and the dashboard. */
export const statusChatgpt = (): number => {
  const ledger = readLedger();
  const launcher = ledger?.launcher_path ?? chatgptLauncherPath();
  const launcherInstalled =
    existsSync(launcher) && existsSync(join(launcher, "Contents"));
  process.stdout.write(
    `${JSON.stringify({
      installed: ledger !== null && launcherInstalled,
      app_installed: existsSync(chatgptAppPath()),
      launcher_installed: launcherInstalled,
      remote: ledger?.remote ?? null,
      cli_version: ledger?.cli_version ?? null,
      stale_ledger: ledger !== null && !launcherInstalled,
    })}\n`,
  );
  return 0;
};

export const runChatgptCommand = async (
  args: readonly string[],
  flags?: TClientFlags,
): Promise<number> => {
  if (flags?.dangerous === true) {
    process.stderr.write(
      "-d does not apply to chatgpt — it installs a launcher rather than running a session.\n",
    );
    return 2;
  }
  const verb = args[0];
  if (verb === undefined) return installChatgpt({ remote: flags?.remote });
  if (verb === "launch") return launchChatgpt({ remote: flags?.remote });
  if (verb === "uninstall") return uninstallChatgpt();
  if (verb === "status") return statusChatgpt();
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown chatgpt verb "${verb}"\n\n${USAGE}`);
  return 2;
};
