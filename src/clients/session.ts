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
import { basename, dirname, join } from "node:path";
import { openllmDir, userHome } from "../env";
import type { TLiveSessionHost } from "../session-host";
import {
  discoverLiveSessionHosts,
  findDaemonBinary,
  sessionHostSpawnArgv,
  spawnSessionHost,
  waitForSessionHostSocket,
} from "../session-host";
import { attachBrokerSession } from "./attach";
import {
  contextStateDir,
  fetchModelCatalog,
  fetchTier,
  resolveGateway,
} from "./gateway";
import { HOOK_SCRIPTS } from "./hooks";
import { buildLaunchPlan, type TLaunchPlan } from "./launch";
import { buildLiveJson, writeLiveJson } from "./live";
import type { TClient, TClientFlags, TDaemonCli } from "./registry";
import {
  buildSessionChoices,
  formatSessionPrompt,
  resolveById,
  resolvePick,
} from "./session-picker";

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
  if (plan.hooks) {
    const hooksDir = join(runDir, "hooks");
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    for (const [name, body] of Object.entries(HOOK_SCRIPTS)) {
      const abs = join(hooksDir, name);
      writeFileSync(abs, body, { mode: 0o700 });
      chmodSync(abs, 0o700);
    }
  }
  // Executable plan entries last, so they land whether or not the client uses
  // hooks and are never clobbered by the shared hook table above.
  for (const [rel, body] of Object.entries(plan.execFiles ?? {})) {
    const abs = join(runDir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, body, { mode: 0o700 });
    chmodSync(abs, 0o700); // force mode regardless of umask
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

/** The gate is ordered: device children bypass first; every later false selects direct launch. */
export const brokerEligible = (args: {
  readonly client: TClient;
  readonly userArgs: readonly string[];
  readonly flags: TClientFlags;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly platform: NodeJS.Platform;
  readonly deviceSessionId?: string;
}): boolean => {
  if (
    args.deviceSessionId !== undefined &&
    args.deviceSessionId.trim().length > 0
  )
    return false;
  if (args.flags.remote) return false;
  if (!args.stdinIsTty || !args.stdoutIsTty || args.platform === "win32")
    return false;
  return !args.client.nonInteractiveMarkers?.some((marker) =>
    args.userArgs.includes(marker),
  );
};

/** Remove the one optional argv disambiguator before handing args to a vendor or broker. */
export const forwardedVendorArgs = (
  userArgs: readonly string[],
): readonly string[] =>
  userArgs[0] === "--" ? userArgs.slice(1) : userArgs.slice(0);

/**
 * Run a session client: interactive local sessions get a detached durable host;
 * all other invocations retain the direct, inherited-stdio launch contract.
 */
const launchDurableSessionHost = async (args: {
  readonly client: TClient;
  readonly forwarded: readonly string[];
  readonly dangerous: boolean;
}): Promise<number | null> => {
  const cli = args.client.daemonCli;
  if (cli === undefined) return null;
  const binary = findDaemonBinary();
  if (binary === null) return null;
  const id = crypto.randomUUID();
  const terminalCols = process.stdout.columns ?? 80;
  const terminalRows = process.stdout.rows ?? 24;
  const argv = sessionHostSpawnArgv({
    id,
    cli,
    cols: terminalCols,
    rows: terminalRows,
    cwd: process.cwd(),
    title: basename(process.cwd()),
    dangerous: args.dangerous,
    vendorArgs: args.forwarded,
  });
  if (argv === null) return null;
  const spawned = spawnSessionHost({ binary, argv });
  if (spawned === null) return null;
  const socketPath = await waitForSessionHostSocket(id);
  if (socketPath === null) {
    // The host may still be starting. Reap it so the direct-launch fallback
    // does not leave a second vendor PTY on the same cwd.
    try {
      spawned.kill();
    } catch {
      // best-effort
    }
    return null;
  }
  const result = await attachBrokerSession({
    target: socketPath,
    open: {
      session_id: id,
      cli,
      cols: terminalCols,
      rows: terminalRows,
      mode: "attach",
    },
    announce: true,
  });
  if (result.kind === "completed") return result.code;
  try {
    spawned.kill();
  } catch {
    // best-effort
  }
  return null;
};

/**
 * Attach this terminal to an ALREADY-RUNNING durable session. Returns the exit
 * code, or null when the host went away between discovery and dial (raced
 * teardown) so the caller can fall through to starting a fresh session.
 */
const attachRunningSession = async (
  session: TLiveSessionHost,
): Promise<number | null> => {
  const result = await attachBrokerSession({
    target: session.socketPath,
    open: {
      session_id: session.id,
      cli: session.cli,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      mode: "attach",
    },
    announce: true,
  });
  return result.kind === "completed" ? result.code : null;
};

/**
 * Read one line from the terminal. Deliberately hand-rolled rather than
 * `node:readline`: this runs microseconds before `attachBrokerSession` takes
 * stdin into raw mode, and readline's interface leaves listeners and mode
 * changes behind that the attach path would then have to undo. Here stdin is
 * returned to exactly the state it was found in.
 */
const readLine = async (): Promise<string> =>
  new Promise<string>((resolve) => {
    const stdin = process.stdin;
    let buffer = "";
    const finish = (value: string): void => {
      stdin.off("data", onData);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Ctrl-C / Ctrl-D at the prompt: decline the offer, start fresh.
        if (byte === 0x03 || byte === 0x04) {
          process.stdout.write("\n");
          finish("n");
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          process.stdout.write("\n");
          finish(buffer);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 0x20) continue;
        const char = String.fromCharCode(byte);
        buffer += char;
        process.stdout.write(char);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  }).then((value) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    return value;
  });

/**
 * Offer the sessions already running on this machine for this client.
 *
 * Returns the session to attach to, or null to start a new one. Re-prompts on
 * unusable input rather than guessing — attaching to the wrong session drops
 * the user into someone else's working directory.
 */
const chooseRunningSession = async (args: {
  readonly client: TClient;
  readonly cli: TDaemonCli;
  readonly flags: TClientFlags;
  readonly vendorArgs: readonly string[];
}): Promise<TLiveSessionHost | null> => {
  if (args.flags.fresh) return null;
  // Client arguments describe a NEW invocation (`--resume x`, a prompt, a
  // model). An attach reaches an already-running process that can never receive
  // them, so silently swallowing them would be worse than not offering.
  // `--attach` is an explicit override and still wins.
  if (args.vendorArgs.length > 0 && args.flags.attach === null) return null;
  const choices = buildSessionChoices(
    discoverLiveSessionHosts(),
    args.cli,
    process.cwd(),
  );
  if (choices.length === 0) {
    if (args.flags.attach !== null && args.flags.attach.length > 0) {
      process.stderr.write(
        `[openllm] --attach ${args.flags.attach} is not a running session — starting a new session\n`,
      );
    }
    return null;
  }

  if (args.flags.attach !== null) {
    // Bare `--attach` (no id) still means "join something" — prefer the
    // same-cwd session when one exists, otherwise the first listed row.
    // Interactive Enter defaults to NEW; only the explicit flag auto-attaches.
    if (args.flags.attach.length === 0) {
      const preferred = choices.find((choice) => choice.sameCwd) ?? choices[0];
      return preferred?.session ?? null;
    }
    const resolved = resolveById(
      choices.map((choice) => choice.session),
      args.flags.attach,
    );
    if (resolved === "missing" || resolved === "ambiguous") {
      process.stderr.write(
        `[openllm] --attach ${args.flags.attach} is ${resolved === "missing" ? "not a running session" : "ambiguous"} — starting a new session\n`,
      );
      return null;
    }
    return resolved;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    process.stdout.write(
      `\n${formatSessionPrompt(choices, {
        clientName: args.client.name,
        nowMs: Date.now(),
        ...(process.env.HOME === undefined ? {} : { home: process.env.HOME }),
      })}`,
    );
    const pick = resolvePick(await readLine(), choices);
    if (pick.kind === "attach") return pick.session;
    if (pick.kind === "new") return null;
    process.stdout.write(
      "[openllm] pick a listed number, or n for a new session\n",
    );
  }
  return null;
};

/**
 * Run a session client: interactive local sessions get a detached durable host;
 * all other invocations retain the direct, inherited-stdio launch contract.
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
  const gateway = await resolveGateway({ remote: flags.remote });
  if (gateway.apiKey.length === 0) {
    process.stderr.write(
      "No OpenLLM API key configured — set OPENLLM_API_KEY, or pair the daemon so ~/.openllm/.env carries it.\n",
    );
    return 1;
  }

  const forwarded = forwardedVendorArgs(userArgs);
  // Durable local sessions do not need a running daemon. An explicit cloud
  // selection still means direct launch, preserving the existing `-r` and
  // OPENLLM_GATEWAY=cloud semantics.
  if (
    process.env.OPENLLM_GATEWAY !== "cloud" &&
    brokerEligible({
      client,
      userArgs: forwarded,
      flags,
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      platform: process.platform,
      deviceSessionId: process.env.OPENLLM_DEVICE_SESSION_ID,
    })
  ) {
    // Sessions already running on this machine — started here OR by the
    // browser, since both origins publish to the same filesystem registry —
    // are offered before a new one is spawned. Attaching joins the live PTY
    // alongside any existing viewer; no vendor `--resume` is involved.
    const cli = client.daemonCli;
    if (cli !== undefined) {
      const existing = await chooseRunningSession({
        client,
        cli,
        flags,
        vendorArgs: forwarded,
      });
      if (existing !== null) {
        const code = await attachRunningSession(existing);
        if (code !== null) return code;
        process.stderr.write(
          "[openllm] that session went away — starting a new one\n",
        );
      }
    }
    const code = await launchDurableSessionHost({
      client,
      forwarded,
      dangerous: flags.dangerous,
    });
    if (code !== null) return code;
  }

  const bin = findClientBinary(client);
  if (bin === null) {
    process.stderr.write(
      `${client.name} is not installed. Install it first:\n  ${client.installHint}\n\n` +
        `OpenLLM does not install third-party CLIs for you.\n`,
    );
    return 127;
  }

  // Catalog + tier are independent gateway reads — fetch them together. Tier
  // gates the code-search MCP group (free tier drops it); both fail open.
  const [catalog, tier] = await Promise.all([
    client.catalogSlug === undefined
      ? Promise.resolve(null)
      : fetchModelCatalog(gateway, client.catalogSlug),
    fetchTier(gateway),
  ]);

  const runDir = createRunDir(client.id);
  let code = 1;
  try {
    const plan = buildLaunchPlan({
      client,
      apiBase: gateway.base,
      apiKey: gateway.apiKey,
      // `OPENLLM_BIN` bakes this into wrapped-client MCP `command` entries. Run
      // from a compiled binary, `process.execPath` IS `openllm` — correct. Run
      // from source (dev: the daemon spawns us via a shim that execs
      // `bun main.ts`), `process.execPath` is `bun`, which would make those MCP
      // entries launch bun with no script. The daemon carries the shim path in
      // `OPENLLM_BIN_OVERRIDE` so MCP resolves to a real runnable `openllm`.
      binPath:
        process.env.OPENLLM_BIN_OVERRIDE !== undefined &&
        process.env.OPENLLM_BIN_OVERRIDE.length > 0
          ? process.env.OPENLLM_BIN_OVERRIDE
          : process.execPath,
      runDir,
      stateDir: contextStateDir(),
      userConfig: readUserConfig(client),
      catalog: catalog ?? undefined,
      tier,
    });
    materialize(plan, runDir);

    // `-d` becomes the client's OWN flag, ahead of the user's args so their
    // explicit choices still win on anything that conflicts.
    const dangerous =
      flags.dangerous && client.dangerousFlag !== undefined
        ? [client.dangerousFlag]
        : [];

    // Index this process for the daemon's local-session list / attach path.
    // Device PTYs set OPENLLM_DEVICE_SESSION_ID so host=device + openllm id
    // land here; local interactive launches stay host=local.
    writeLiveJson(
      runDir,
      buildLiveJson({
        clientId: client.id,
        cwd: process.cwd(),
        dangerous: flags.dangerous,
        userArgs: forwarded,
      }),
    );

    code = await execClient(
      bin,
      [...plan.args, ...dangerous, ...forwarded],
      plan.env,
      plan.unsetEnv,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  return code;
};

/**
 * Build the child environment as inherited env minus explicit removes, then
 * overlayed with plan-specific env. The overlay always wins: an unset name is
 * removed only when the plan does not explicitly set it.
 */
export const mergeSessionEnv = (
  inherited: NodeJS.ProcessEnv,
  env: Readonly<Record<string, string>>,
  unsetEnv: readonly string[] = [],
): NodeJS.ProcessEnv => {
  const remove = new Set(unsetEnv);
  const output = {} as NodeJS.ProcessEnv;

  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) {
      continue;
    }
    if (remove.has(name) && !Object.hasOwn(env, name)) {
      continue;
    }
    output[name] = value;
  }

  for (const [name, value] of Object.entries(env)) {
    output[name] = value;
  }

  return output;
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
  unsetEnv: readonly string[] = [],
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      env: mergeSessionEnv(process.env, env, unsetEnv),
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
