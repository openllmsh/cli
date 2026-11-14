/**
 * The CLI-launch update check. At most once per {@link CHECK_INTERVAL_MS}, an
 * `openllm` invocation spawns a DETACHED copy of itself running
 * `__self-update`, so the user's command never waits on the network. The
 * child first asks whether this machine's daemon answers: a running daemon
 * owns updates (its bootstrap tick converges the same file under the same
 * update lease), so the child leaves it alone. Only with no daemon running —
 * a minimal install, a sandbox, a stopped daemon — does the child run the
 * quiet {@link convergeSelf}. The swap lands next run.
 *
 * Runs with or without a TTY, so headless sandboxes (which never run a
 * daemon) don't drift behind the cloud. Skipped for: dev builds, machine
 * invocations that run per prompt or own stdio (hooks, MCP stdio, `exec`,
 * the daemon half), the auto-update opt-out, and an explicit
 * `OPENLLM_NO_UPDATE_CHECK=1`.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "./cli-version";
import { daemonStateDir, openllmDir, sharedFileConfig } from "./env";

/** Short on purpose: releases ship often and the cloud moves on with them, so
 *  a headless sandbox with no daemon must not sit hours behind. One check is
 *  a single small version GET, made by a detached child. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The hidden subcommand the detached child runs. */
export const SELF_UPDATE_CHILD = "__self-update";

/** Commands that are machine-driven or already about updating. */
const SKIP_COMMANDS: ReadonlySet<string> = new Set([
  "mcp",
  "exec",
  "memory",
  "api",
  "completion",
  "update",
  "self-update",
  SELF_UPDATE_CHILD,
]);

const stampPath = (): string => join(openllmDir(), "cli", "update-check");

const lastCheck = (): number => {
  try {
    const value = Number(readFileSync(stampPath(), "utf8").trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

/** The same opt-out the daemon honours (`OPENLLM_DAEMON_AUTO_UPDATE`). */
const autoUpdateOff = (): boolean => {
  const raw =
    process.env.OPENLLM_DAEMON_AUTO_UPDATE ??
    sharedFileConfig().OPENLLM_DAEMON_AUTO_UPDATE;
  return raw === "0" || raw === "false";
};

/** Whether this invocation should kick a background check. Pure inputs so
 *  tests can drive it. */
export const shouldCheck = (args: {
  readonly command: string | undefined;
  readonly now: number;
  readonly last: number;
  readonly version: string;
  readonly disabled: boolean;
}): boolean =>
  args.version !== "0.0.0-dev" &&
  !args.disabled &&
  !(args.command !== undefined && SKIP_COMMANDS.has(args.command)) &&
  args.now - args.last >= CHECK_INTERVAL_MS;

/** Fire-and-forget: record the attempt, then spawn the detached checker. */
export const maybeLaunchUpdateCheck = (command: string | undefined): void => {
  try {
    const now = Date.now();
    if (
      !shouldCheck({
        command,
        now,
        last: lastCheck(),
        version: CLI_VERSION,
        disabled:
          process.env.OPENLLM_NO_UPDATE_CHECK === "1" || autoUpdateOff(),
      })
    )
      return;
    mkdirSync(join(openllmDir(), "cli"), { recursive: true });
    writeFileSync(stampPath(), String(now));
    const child = Bun.spawn([process.execPath, SELF_UPDATE_CHILD], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  } catch {
    // Never let an update check break the user's command.
  }
};

/** The file the daemon's updater converges (`~/.openllm/bin/openllm`). */
const managedBinaryPath = (): string =>
  join(daemonStateDir(), "bin", "openllm");

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** A real OpenLLM daemon that is updating itself, not just anything that
 *  answers 200: its `/status` carries the daemon's `version`. */
const openllmDaemonAnswers = async (): Promise<boolean> => {
  const { daemonPort } = await import("./clients/gateway");
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    return daemonHealthOwnsUpdates(await res.json());
  } catch {
    return false;
  }
};

/** Whether a daemon `/status` body (`buildHealth` in the daemon half) says it
 *  is an OpenLLM daemon that will update itself. It converges only while its
 *  `cloud_state` is `ok` (revoked key, unreachable cloud → no updater), so we
 *  defer only to one that will. */
export const daemonHealthOwnsUpdates = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { version?: unknown }).version === "string" &&
  (body as { cloud_state?: unknown }).cloud_state === "ok";

/** The detached child: converge unless a running daemon owns updates for
 *  THIS file. The daemon converges only the managed install, so a separate
 *  copy on PATH updates itself even while a daemon runs (the shared update
 *  lease still serialises swaps of one file). Deps are injectable for tests. */
export const runLaunchUpdateChild = async (
  deps: {
    readonly daemonRunning?: () => Promise<boolean>;
    readonly isManagedBinary?: () => boolean;
    readonly converge?: () => Promise<unknown>;
  } = {},
): Promise<"daemon" | "converged"> => {
  const isManagedBinary =
    deps.isManagedBinary ??
    ((): boolean => sameFile(process.execPath, managedBinaryPath()));
  const daemonRunning = deps.daemonRunning ?? openllmDaemonAnswers;
  if (isManagedBinary() && (await daemonRunning())) return "daemon";
  const converge =
    deps.converge ??
    (async (): Promise<unknown> => {
      const { convergeSelf } = await import("./self-update");
      return convergeSelf({ quiet: true });
    });
  await converge();
  return "converged";
};
