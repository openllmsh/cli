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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "./cli-version";
import { openllmDir, sharedFileConfig } from "./env";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

/** The detached child: converge only when no daemon owns updates here.
 *  `daemonRunning` / `converge` are injectable for tests. */
export const runLaunchUpdateChild = async (
  deps: {
    readonly daemonRunning?: () => Promise<boolean>;
    readonly converge?: () => Promise<unknown>;
  } = {},
): Promise<"daemon" | "converged"> => {
  const daemonRunning =
    deps.daemonRunning ??
    (async (): Promise<boolean> => {
      const { daemonPort, daemonReachable } = await import("./clients/gateway");
      return daemonReachable(daemonPort());
    });
  if (await daemonRunning()) return "daemon";
  const converge =
    deps.converge ??
    (async (): Promise<unknown> => {
      const { convergeSelf } = await import("./self-update");
      return convergeSelf({ quiet: true });
    });
  await converge();
  return "converged";
};
