/**
 * The IO half of session mode: materialize a launch plan into an ephemeral run
 * dir and exec the real client.
 *
 * Transparency is the contract (proposal §3.4.1.6): the child inherits stdio
 * and the TTY, every user argument is forwarded verbatim, signals reach the
 * child, and our exit code IS the child's — `ollm claude --resume` must be
 * indistinguishable from `claude --resume`.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { openllmDir, userHome } from "../env";
import { contextStateDir, fetchModelCatalog, resolveGateway } from "./gateway";
import { HOOK_SCRIPTS } from "./hooks";
import { buildLaunchPlan, type TLaunchPlan } from "./launch";
import type { TClient, TClientFlags } from "./registry";

/** `~/.openllm/run` — every ephemeral per-launch overlay lives here. */
export const runRoot = (): string => join(openllmDir(), "run");

const expandHome = (p: string): string =>
  p.startsWith("~/") ? join(userHome(), p.slice(2)) : p;

/** Resolve the client binary, or null when it isn't installed. */
export const findClientBinary = (client: TClient): string | null => {
  for (const candidate of client.binPaths) {
    const abs = expandHome(candidate);
    if (existsSync(abs)) return abs;
  }
  // Fall back to PATH resolution — `spawn` would do this anyway, but resolving
  // here lets us print the install hint instead of an ENOENT stack.
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const abs = join(dir, client.bin);
    if (existsSync(abs)) return abs;
  }
  return null;
};

/**
 * Reap run dirs from launches that crashed without cleaning up. Best-effort and
 * conservative: only directories whose pid is no longer alive are removed, so a
 * concurrent launch is never disturbed.
 */
const reapStaleRuns = (clientRoot: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(clientRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isFinite(pid)) continue;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
      continue; // still running — leave it
    } catch {
      // ESRCH (dead) → its run dir is garbage
    }
    try {
      rmSync(join(clientRoot, name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
};

/** Create `~/.openllm/run/<client>/<pid>/` (0700) and return it. */
const createRunDir = (clientId: string): string => {
  const clientRoot = join(runRoot(), clientId);
  mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  reapStaleRuns(clientRoot);
  const dir = join(clientRoot, String(process.pid));
  rmSync(dir, { recursive: true, force: true }); // pid reuse after a crash
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // force mode regardless of umask
  return dir;
};

/**
 * Symlink every entry of the user's real config dir into the run dir, so a
 * private `GROK_HOME`-style redirect still resolves credentials, sessions, and
 * history to the user's own files. Entries the plan writes itself are skipped
 * (a real file must win over the symlink).
 */
const mirrorConfigDir = (
  realDir: string,
  runDir: string,
  ownPaths: readonly string[],
): void => {
  if (!existsSync(realDir)) return;
  const owned = new Set(ownPaths.map((p) => p.split("/")[0]));
  for (const entry of readdirSync(realDir)) {
    if (owned.has(entry)) continue;
    try {
      symlinkSync(join(realDir, entry), join(runDir, entry));
    } catch {
      // already present / unsupported — skip
    }
  }
};

/** Write the plan's files, materialize hooks, and set up any symlink farm. */
const materialize = (plan: TLaunchPlan, runDir: string): void => {
  if (plan.mirrorDir !== undefined) {
    mirrorConfigDir(
      expandHome(plan.mirrorDir),
      runDir,
      Object.keys(plan.files),
    );
  }
  for (const [rel, contents] of Object.entries(plan.files)) {
    const abs = join(runDir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, contents, { mode: 0o600 });
  }
  if (!plan.hooks) return;
  const hooksDir = join(runDir, "hooks");
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(HOOK_SCRIPTS)) {
    const abs = join(hooksDir, name);
    writeFileSync(abs, body, { mode: 0o700 });
    chmodSync(abs, 0o700);
  }
};

/** The user's existing config text for a client, when readable. */
const readUserConfig = (client: TClient): string | undefined => {
  const paths: Partial<Record<string, string>> = {
    grok: join(userHome(), ".grok", "config.toml"),
    opencode: join(
      process.env.XDG_CONFIG_HOME ?? join(userHome(), ".config"),
      "opencode",
      "opencode.json",
    ),
  };
  const path = paths[client.id];
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

/**
 * Run a session client: merge, materialize, exec, clean up.
 *
 * Returns the child's exit code so the caller can exit with it. `userArgs` is
 * everything after the client name and is forwarded VERBATIM (one leading `--`
 * is stripped, so `openllm claude -- --help` reaches the client). `flags` are
 * openllm's own, already parsed off the front of argv by the caller.
 */
export const runSessionClient = async (
  client: TClient,
  userArgs: readonly string[],
  flags: TClientFlags,
): Promise<number> => {
  // `-d` must fail loudly on a client with no equivalent: silently launching
  // WITH approval prompts after the user asked to skip them is the wrong
  // surprise.
  if (flags.dangerous && client.dangerousFlag === undefined) {
    process.stderr.write(
      `${client.name} has no skip-approvals flag, so -d does not apply.\n`,
    );
    return 2;
  }
  const bin = findClientBinary(client);
  if (bin === null) {
    process.stderr.write(
      `${client.name} is not installed. Install it first:\n  ${client.installHint}\n\n` +
        `OpenLLM does not install third-party CLIs for you.\n`,
    );
    return 127;
  }

  const gateway = await resolveGateway({ remote: flags.remote });
  if (gateway.apiKey.length === 0) {
    process.stderr.write(
      "No OpenLLM API key configured — set OPENLLM_API_KEY, or pair the daemon so ~/.openllm/.env carries it.\n",
    );
    return 1;
  }

  const catalog =
    client.catalogSlug === undefined
      ? null
      : await fetchModelCatalog(gateway, client.catalogSlug);

  const runDir = createRunDir(client.id);
  let code = 1;
  try {
    const plan = buildLaunchPlan({
      client,
      apiBase: gateway.base,
      apiKey: gateway.apiKey,
      binPath: process.execPath,
      runDir,
      stateDir: contextStateDir(),
      userConfig: readUserConfig(client),
      catalog: catalog ?? undefined,
    });
    materialize(plan, runDir);

    // Strip ONE leading `--` (the disambiguator), then forward verbatim.
    const forwarded =
      userArgs[0] === "--" ? userArgs.slice(1) : userArgs.slice(0);
    // `-d` becomes the client's OWN flag, ahead of the user's args so their
    // explicit choices still win on anything that conflicts.
    const dangerous =
      flags.dangerous && client.dangerousFlag !== undefined
        ? [client.dangerousFlag]
        : [];
    code = await execClient(
      bin,
      [...plan.args, ...dangerous, ...forwarded],
      plan.env,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  return code;
};

/**
 * Spawn the client with inherited stdio (so it owns the TTY) and forward
 * signals, resolving to the exit code the child produced. A signal-terminated
 * child maps to the conventional 128+signo so shell callers see the same thing
 * they would from a direct invocation.
 */
const execClient = (
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    const forward = (signal: NodeJS.Signals) => (): void => {
      // Let the child decide how to die; our own exit follows its code.
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    const sigint = forward("SIGINT");
    const sigterm = forward("SIGTERM");
    const sighup = forward("SIGHUP");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    process.on("SIGHUP", sighup);
    const cleanup = (): void => {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      process.off("SIGHUP", sighup);
    };
    child.on("error", (err) => {
      cleanup();
      process.stderr.write(`failed to launch ${bin}: ${err.message}\n`);
      resolve(127);
    });
    child.on("exit", (exitCode, signal) => {
      cleanup();
      if (signal !== null) {
        // Shell convention for a signal-terminated child. Use Node's own signal
        // table rather than a hand-rolled map so every signal maps correctly.
        const signo: number = osConstants.signals[signal] ?? 0;
        resolve(128 + signo);
        return;
      }
      resolve(exitCode ?? 0);
    });
  });
