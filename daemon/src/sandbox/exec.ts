/**
 * Per-child OS sandboxing — the ONE module that knows about the
 * `openllmd --sandbox-exec -- <argv…>` self-re-exec shim
 * (`docs/audits/daemon-sandbox-scoping.md` §2). It owns three things:
 *
 *   - `sandboxSpawnArgs()` — the call-site entry point: wrap a child argv so
 *     the child runs confined. Pure argv-in/argv-out; call sites contain no
 *     platform checks, no gate checks, no verb knowledge.
 *   - `runSandboxExec()` — the `--sandbox-exec` verb handler (`cli.ts`
 *     delegates here): apply the working-set sandbox to THIS re-exec'd
 *     process (`applyDaemonSandbox({ force: true })` — inherited by the tail
 *     command), spawn the tail with inherited stdio, and mirror its exit.
 *   - the env-gate logic (kill switch + dev-source opt-in), resolved in one
 *     place.
 *
 * The daemon process itself is NOT sandboxed (device-session PTYs must run
 * the user's real CLI over their real files); each risky child is confined at
 * spawn time instead. Fail-open lives HERE and in the shim, nowhere else:
 * when sandboxing is off/unsupported the wrap is an identity passthrough and
 * a shim whose apply degrades still runs the child — surfaced loudly
 * per-spawn (stderr + `logWarn` in `runSandboxExec`) on top of the boot-time
 * capability posture (`probeSandboxCapability`).
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { logWarn, safeDiagnosticMessage } from "../logger";
import { DAEMON_VERSION } from "../version";
import type { TSandboxState } from "./landlock";
import {
  applyDaemonSandbox,
  probeLandlockSupport,
  sandboxAppliedInProcess,
} from "./landlock";

export type TSandboxSpawnOpts = {
  /** Extra allow-list paths for THIS child (v1: ignored; future: appended to
   *  the child's profile via a working-set extension the shim applies). */
  readonly extraReadWrite?: readonly string[];
  readonly extraReadOnly?: readonly string[];
  /** Future network on/off knob (v1: ignored — network policy stays with
   *  systemd / (allow default)). */
  readonly network?: boolean;
  /** Fixed-argv read-only probe (`<bin> --version`, keychain `security`
   *  reads): skip the shim. The shim re-execs the whole daemon binary and
   *  rebuilds the working set PER SPAWN, and probes run on the 30s status hot
   *  path — that cost dwarfs any risk from a no-untrusted-input probe. Risky
   *  children (vendor scripts, login flows, anything fed remote data) must
   *  never set this. */
  readonly probe?: boolean;
};

/** Whether per-child sandboxing is enabled for this process — the two env
 *  gates plus the platform support check, resolved in ONE place. */
const sandboxingEnabled = (): boolean => {
  // Kill switch: children spawn unwrapped.
  if (process.env.OPENLLM_DAEMON_NO_SANDBOX === "1") return false;
  // Already confined in-process (the shim's own re-exec, or a test probe that
  // applied directly): children INHERIT the confinement — re-wrapping would
  // double-apply and, in a probe, re-exec the wrong entry script.
  if (sandboxAppliedInProcess()) return false;
  // No backend on this platform (win32 etc.) — identity passthrough.
  if (process.platform !== "darwin" && process.platform !== "linux")
    return false;
  return true;
};

/** A from-source run (`bun src/main.ts`) — `process.execPath` is `bun`, which
 *  would swallow `--sandbox-exec`, so the wrap must re-insert the entry
 *  script (`process.argv[1]` in both run forms — see `cli.ts` `userArgs`). */
const isDevSourceRun = (): boolean => DAEMON_VERSION === "0.0.0-dev";

/** The dev entry script as an ABSOLUTE path, captured at module load while
 *  `process.cwd()` is still the repo root (`bun run dev:sb` launches there).
 *  `sandboxSpawnArgs` call sites spawn the shim with the CHILD's cwd (the
 *  isolated CLI home — `spawnCwd`), where a relative
 *  `packages/cli/daemon/src/main.ts` no longer resolves: every wrapped dev spawn
 *  died with "Module not found" instead of running confined, silently
 *  diverging `dev:sb` from the shipped binary's sandbox behaviour. */
const absolute = (path: string | undefined): string | undefined =>
  path === undefined || path.length === 0
    ? undefined
    : isAbsolute(path)
      ? path
      : resolve(path);

/** `OPENLLM_DAEMON_SANDBOX_ENTRY` names the daemon entry explicitly. A host
 *  whose `argv[1]` is not the daemon (`bun test` puts the TEST FILE there)
 *  would otherwise re-exec that script as the shim, and every wrapped child
 *  dies before running. */
const DEV_ENTRY: string | undefined =
  absolute(process.env.OPENLLM_DAEMON_SANDBOX_ENTRY) ??
  absolute(process.argv[1]);

/**
 * Wrap a child argv for sandboxed execution via the `--sandbox-exec` shim.
 * INVARIANTS:
 *  - identity passthrough (`[...argv]`) when sandboxing is disabled
 *    (`OPENLLM_DAEMON_NO_SANDBOX=1`), unsupported (win32), or an ungated dev
 *    source run — callers never branch on posture;
 *  - never throws (fail-open lives HERE and in the shim, nowhere else);
 *  - pure argv-in/argv-out: no spawn, no I/O — callers keep their own
 *    `Bun.spawn` options (cwd, env, stdio) unchanged.
 *
 * `opts` is reserved (v1: ignored) so future per-child grants / network
 * policy never churn call sites.
 */
export const sandboxSpawnArgs = (
  argv: readonly string[],
  opts?: TSandboxSpawnOpts,
): string[] => {
  if (opts?.probe === true) return [...argv];
  if (!sandboxingEnabled()) return [...argv];
  if (isDevSourceRun()) {
    // Dev source runs are OPT-IN (`OPENLLM_DAEMON_SANDBOX=1`), and the wrap
    // must go through `bun <entry>` since execPath is the bun runtime.
    if (process.env.OPENLLM_DAEMON_SANDBOX !== "1") return [...argv];
    if (DEV_ENTRY === undefined) return [...argv];
    return [
      process.execPath,
      DEV_ENTRY,
      "--sandbox-exec",
      ...HOME_FLAG(),
      "--",
      ...argv,
    ];
  }
  return [process.execPath, "--sandbox-exec", ...HOME_FLAG(), "--", ...argv];
};

/**
 * `--home <realHome>` — the DAEMON's real home, pinned into the shim's argv.
 *
 * Load-bearing: most call sites spawn the shim with the CHILD's env, which
 * points `HOME` at the isolated CLI home (`cli-paths.ts` `cliEnv`). The shim
 * would then build its working set against THAT home — `stateDir()` resolves to
 * a nonexistent `<isolated>/.openllm` (so the real state dir is never granted)
 * and Seatbelt's deny-`$HOME`-by-default read rule lands on the isolated home
 * itself, EPERM-ing the very credential stores the child was spawned to read
 * (`~/.openllm/cli/<p>/home/.codex`, `.kimi-code`, `.grok/auth.json`). The
 * daemon process IS unconfined and has the real `HOME`, so it captures the
 * value at wrap time and the shim threads it into the working set — the tail
 * still runs with the isolated `HOME` it was given.
 *
 * It must travel in ARGV, not the env: the child owns `HOME` in the shared env,
 * and re-setting `process.env.HOME` inside the shim would not help anyway —
 * Bun caches `os.homedir()` on its first call, which module-load code has
 * already made.
 */
const HOME_FLAG = (): string[] => ["--home", homedir()];

/**
 * The `--sandbox-exec` verb: apply the working-set sandbox to this process
 * (inherited by the child), spawn the tail argv with inherited stdio, and
 * exit with the child's code (or `128 + signal` on a signal death — shell
 * convention, so `logIfKilled` still detects sandbox kills upstream).
 * Fail-open: if the apply degrades (`error`/`unsupported`) the child STILL
 * runs — parity with the old boot posture. Spawn failure of the inner
 * command (ENOENT etc.) exits 127 with a stderr line.
 */
export const runSandboxExec = async (
  tail: readonly string[],
  opts?: { readonly home?: string },
): Promise<never> => {
  // Build the working set from the DAEMON's home (see `HOME_FLAG`), NOT this
  // process's `HOME` — the shim inherits the child's isolated one. The tail's
  // env is untouched, so the child still gets its isolated `HOME`.
  const state = await applyDaemonSandbox({
    force: true,
    ...(opts?.home !== undefined ? { home: opts.home } : {}),
  });
  if (state === "error" || state === "unsupported") {
    // Loud on BOTH channels: stderr for the immediate caller, and the shared
    // daemon log so per-spawn degradation is visible next to the boot-time
    // capability probe's posture (the probe can say "enforced" while an
    // individual apply later degrades — fail-open, but never silent).
    process.stderr.write(
      `openllmd --sandbox-exec: sandbox not applied (${state}) — running unconfined\n`,
    );
    logWarn("sandbox", "Sandbox-exec apply degraded.", {
      state,
      command: tail[0] ?? "?",
    });
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...tail], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
      cwd: process.cwd(),
    });
  } catch (err) {
    process.stderr.write(
      `openllmd --sandbox-exec: failed to spawn ${tail[0] ?? "?"}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return process.exit(127);
  }
  // Forward termination signals to the tail: the daemon kills the SHIM
  // (`proc.kill()` at the call site reaches the wrapper, not the child), so
  // without forwarding the sandboxed tail would outlive its parent. The shim
  // then exits via the child's `128 + signal` mirror below.
  //
  // RESIDUAL GAP (documented, accepted): a SIGKILL of the shim cannot be
  // forwarded (uncatchable), so a kill -9 of the wrapper can orphan the tail.
  // Bun does support detached process groups (`detached: true` performs
  // POSIX setsid) and the durable session host uses that deliberately; it does
  // not supply `PR_SET_PDEATHSIG`, however, nor can an FFI prctl run in the
  // child between fork and exec. Every daemon-side kill path uses catchable
  // signals (`proc.kill()` = SIGTERM, spawnLogin's reaper uses SIGKILL on the
  // SHIM only after the `until`/timeout capture). Revisit if Bun adds a
  // parent-death signal spawn option.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      try {
        proc.kill(signal);
      } catch {
        // child already gone — the exit mirror below finishes up
      }
    });
  }
  await proc.exited;
  if (proc.signalCode !== null) {
    // The shim's exit-code mirror means the DAEMON-side caller sees
    // `128 + N`, not a signalCode — so `logIfKilled` can't fire there. Log
    // the kill HERE (the shim shares the daemon's log file), preserving the
    // "child killed by a signal — likely a sandbox denial" breadcrumb.
    logWarn("sandbox", "Sandbox-exec child killed by signal.", {
      command: tail[0] ?? "?",
      signal: proc.signalCode,
    });
    return process.exit(128 + (signalNumber(proc.signalCode) ?? 15));
  }
  return process.exit(proc.exitCode ?? 1);
};

/** Map a signal NAME to its conventional number for the `128 + N` exit. */
const signalNumber = (signal: string): number | null => {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return table[signal] ?? null;
};

/**
 * Boot-time capability probe for `DaemonStatus.sandbox` / `/health` — the
 * posture-reporting replacement for the removed process-wide boot apply.
 * Computes what a wrapped child WILL get without restricting anything:
 * platform supported, kill switch off, dev gate satisfied — and on Linux the
 * cheap Landlock ABI probe so `"unsupported"` stays accurate. `"enforced"`
 * now means "risky children are wrapped", not "this process is confined".
 */
export const probeSandboxCapability = async (): Promise<TSandboxState> => {
  if (process.env.OPENLLM_DAEMON_NO_SANDBOX === "1") {
    logWarn(
      "sandbox",
      safeDiagnosticMessage`Sandbox disabled by environment; children run unconfined.`,
    );
    return "off";
  }
  if (isDevSourceRun() && process.env.OPENLLM_DAEMON_SANDBOX !== "1") {
    return "off";
  }
  if (process.platform === "darwin") return "enforced";
  if (process.platform !== "linux") return "unsupported";
  return probeLandlockSupport();
};
