/**
 * The cross-platform OS-sandbox entry (`applyDaemonSandbox`) + the Linux
 * Landlock backend — `docs/proposals/daemon-os-sandbox-and-typed-control.md`
 * §3.3a. `applyDaemonSandbox` dispatches by platform: **Linux → Landlock**
 * (here), **macOS → Seatbelt** (`./seatbelt.ts`), other → unsupported. Both
 * backends are in-process, unprivileged, derived from the same working set
 * (`./working-set/`), and inherited across `execve`. The sandbox is
 * PER-CHILD, not process-wide: the daemon itself boots unconfined (so device
 * session PTYs can run the user's real CLI over their real files) and each
 * risky child is wrapped through the `--sandbox-exec` self-re-exec shim
 * (`./exec.ts`), whose re-exec'd process calls `applyDaemonSandbox({ force:
 * true })` before running the child — so `bash` running a SHA-gated
 * integration script, `curl`, and the vendor CLIs are confined, and
 * everything outside the working set (`~/.ssh`, `~/.aws`, the user's real
 * `~/.codex`, browser profiles) is unreachable from them. See
 * `docs/audits/daemon-sandbox-scoping.md`.
 *
 * Landlock (this file): a ruleset granting only the working-set paths, on
 * kernels ≥ 5.13. It can't restrict the network on the kernels we target —
 * the systemd user unit's `RestrictAddressFamilies` (`service.ts`) covers that
 * side; the two layers overlap deliberately (Landlock also confines a manual
 * foreground run with no systemd).
 *
 * Failure posture is FAIL-OPEN with a loud log: the daemon must keep serving
 * on a kernel/libc this shim can't drive (the state is surfaced on
 * `DaemonStatus.sandbox` so an unconfined daemon is visible, not silent).
 * Kill switch: `OPENLLM_DAEMON_NO_SANDBOX=1`. Dev source runs are OPT-IN via
 * `OPENLLM_DAEMON_SANDBOX=1` (§3.5) so the sandbox never impedes iteration.
 *
 * Landlock rules only ever NARROW and cannot be loosened in-process — a
 * future §3.4 consent grant takes effect via the self-updater's existing
 * drain-and-exit + supervisor relaunch, never by widening a live ruleset.
 */
import { fstatSync } from "node:fs";
import { logDebug, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import { DAEMON_VERSION } from "../version";
import { daemonWorkingSet } from "./working-set";

/** The sandbox posture this process ended up with, for `DaemonStatus`. */
export type TSandboxState = "enforced" | "off" | "unsupported" | "error";

// ─── Landlock ABI (uapi/linux/landlock.h) ────────────────────────────
// Syscall numbers are uniform across architectures (allocated post-table-
// unification): 444/445/446.
const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1; // flags probe: returns the ABI
const LANDLOCK_RULE_PATH_BENEATH = 1;

// Filesystem access rights. v1 = bits 0..12; REFER (v2) must be handled +
// granted on read-write paths or EVERY cross-directory rename/link is denied
// (the v1 quirk REFER exists to fix); TRUNCATE (v3) likewise for truncation.
const ACCESS_FS_EXECUTE = 1n << 0n;
const ACCESS_FS_WRITE_FILE = 1n << 1n;
const ACCESS_FS_READ_FILE = 1n << 2n;
const ACCESS_FS_READ_DIR = 1n << 3n;
const ACCESS_FS_V1_ALL = 0x1fffn;
const ACCESS_FS_REFER = 1n << 13n; // ABI v2
const ACCESS_FS_TRUNCATE = 1n << 14n; // ABI v3

// The ONLY access rights Landlock permits on a rule whose `parent_fd` is a
// REGULAR FILE (not a directory): execute, read-file, write-file, truncate.
// Adding ANY directory-only right (read-dir, make/remove-*, refer, …) to a
// file rule makes `landlock_add_rule` fail EINVAL — which is why the lone
// regular-file working-set entry (`~/.claude.json`) failed to grant and a
// confined write to it got EACCES (→ the integration script exits 1). We mask
// the requested rights down to this set for a file. TRUNCATE is &-ed against
// `handled` by the caller, so it's only present when the ABI supports it.
const ACCESS_FS_FILE_MASK =
  ACCESS_FS_EXECUTE |
  ACCESS_FS_WRITE_FILE |
  ACCESS_FS_READ_FILE |
  ACCESS_FS_TRUNCATE;

/**
 * The access mask to put on a `path_beneath` rule for one working-set entry.
 * A regular-FILE rule may carry only file-applicable rights — directory-only
 * bits make `landlock_add_rule` fail EINVAL (the `~/.claude.json` grant
 * failure). A directory keeps the full requested set. Pure (no syscalls) so the
 * file-vs-dir mask decision is unit-testable without a live kernel.
 */
export const ruleAccessFor = (
  requested: bigint,
  isRegularFile: boolean,
): bigint => (isRegularFile ? requested & ACCESS_FS_FILE_MASK : requested);

// asm-generic open(2) flags (identical on x86_64 + aarch64).
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;

const PR_SET_NO_NEW_PRIVS = 38;

type TLibc = {
  readonly syscall3: (n: number, a: bigint, b: bigint, c: bigint) => bigint;
  readonly syscall4: (
    n: number,
    a: bigint,
    b: bigint,
    c: bigint,
    d: bigint,
  ) => bigint;
  readonly open: (path: Uint8Array, flags: number) => number;
  readonly close: (fd: number) => number;
  readonly prctl: (
    op: number,
    a: bigint,
    b: bigint,
    c: bigint,
    d: bigint,
  ) => number;
};

/**
 * Bind the libc entry points through `bun:ffi`. `syscall(2)` is variadic;
 * declaring it with fixed integer signatures is sound on the Linux x86_64
 * SysV and aarch64 AAPCS ABIs (integer varargs ride the same registers as
 * named args). Imported lazily so non-Linux platforms never load `bun:ffi`.
 */
const bindLibc = async (): Promise<TLibc | null> => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  for (const lib of ["libc.so.6", "libc.so"]) {
    try {
      const { symbols } = dlopen(lib, {
        syscall: {
          args: [
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
          ],
          returns: FFIType.i64,
        },
        open: {
          args: [FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        prctl: {
          args: [
            FFIType.i32,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
          ],
          returns: FFIType.i32,
        },
      });
      // Bun maps `FFIType.i64` to a `bigint` in BOTH directions, so `sys`
      // takes + returns bigints. The wrappers convert the `number` syscall
      // NUMBER `n` to bigint once and return the raw bigint result unwrapped.
      const sys = symbols.syscall as unknown as (
        n: bigint,
        a: bigint,
        b: bigint,
        c: bigint,
        d: bigint,
      ) => bigint;
      return {
        syscall3: (n, a, b, c) => sys(BigInt(n), a, b, c, 0n),
        syscall4: (n, a, b, c, d) => sys(BigInt(n), a, b, c, d),
        open: (path, flags) =>
          Number(
            (symbols.open as unknown as (p: number, f: number) => number)(
              ptr(path),
              flags,
            ),
          ),
        close: (fd) =>
          Number((symbols.close as unknown as (f: number) => number)(fd)),
        prctl: (op, a, b, c, d) =>
          Number(
            (
              symbols.prctl as unknown as (
                o: number,
                a: bigint,
                b: bigint,
                c: bigint,
                d: bigint,
              ) => number
            )(op, a, b, c, d),
          ),
      };
    } catch {
      // try the next libc name (glibc vs musl)
    }
  }
  return null;
};

const cstr = (s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
};

/** struct landlock_ruleset_attr — only `handled_access_fs` (size 8 = ABI-v1
 *  layout; newer kernels accept smaller, older sizes by design). */
const rulesetAttr = (handled: bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, handled, true);
  return buf;
};

/** struct landlock_path_beneath_attr — { u64 allowed_access; s32 parent_fd; }
 *  packed (12 bytes). */
const pathBeneathAttr = (allowed: bigint, fd: number): Uint8Array => {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, allowed, true);
  view.setInt32(8, fd, true);
  return buf;
};

let appliedState: TSandboxState = "off";

/** The posture this process reached (for `status.ts` / `health.ts`). In the
 *  daemon server it is fed by the boot-time capability probe
 *  (`exec.ts` `probeSandboxCapability`) — "enforced" means risky CHILDREN are
 *  wrapped via the `--sandbox-exec` shim, not that this process is confined. */
export const sandboxState = (): TSandboxState => appliedState;

/** Record the posture for {@link sandboxState} — used by the boot-time
 *  capability probe, which computes the posture without applying anything. */
export const recordSandboxState = (state: TSandboxState): void => {
  appliedState = state;
};

/**
 * Bind libc and probe the kernel's Landlock ABI in one step — the
 * `LANDLOCK_CREATE_RULESET_VERSION` flags syscall creates no ruleset and
 * restricts nothing. Shared by the boot-time capability probe
 * ({@link probeLandlockSupport}) and the real apply (`applyInner`), so the
 * ABI detection can never drift between the two. `abi <= 0` = unsupported.
 */
const probeLandlockAbi = async (): Promise<{
  readonly libc: TLibc;
  readonly abi: number;
} | null> => {
  const libc = await bindLibc();
  if (libc === null) return null;
  const abi = Number(
    libc.syscall3(
      SYS_LANDLOCK_CREATE_RULESET,
      0n,
      0n,
      BigInt(LANDLOCK_CREATE_RULESET_VERSION),
    ),
  );
  return { libc, abi };
};

/**
 * Cheap Linux capability probe: is Landlock actually available on this
 * kernel? Runs only the ABI flags syscall — no ruleset is created, nothing
 * is restricted. Feeds the boot-time posture so `"unsupported"` stays
 * accurate under the per-child model.
 */
export const probeLandlockSupport = async (): Promise<TSandboxState> => {
  if (process.platform !== "linux") return "unsupported";
  try {
    const probed = await probeLandlockAbi();
    if (probed === null) return "error";
    return probed.abi <= 0 ? "unsupported" : "enforced";
  } catch {
    return "error";
  }
};

export type TApplySandboxOpts = {
  /** Bypass the dev-version opt-in gate (used by the `--sandbox-exec` shim,
   *  which is invoked deliberately). The `OPENLLM_DAEMON_NO_SANDBOX=1` kill
   *  switch still wins. */
  readonly force?: boolean;
  /** The DAEMON's home, when this process's `HOME` is NOT it — the
   *  `--sandbox-exec` shim runs with the CHILD's isolated `HOME`. Threaded
   *  into the working set; see `sandbox/exec.ts` `HOME_FLAG`. */
  readonly home?: string;
};

/**
 * Apply the Landlock working-set ruleset to THIS process (and, by
 * inheritance, every child it ever spawns). Called by the `--sandbox-exec`
 * shim before it runs its tail argv (and by the sandbox test probes).
 * Never throws; returns + records the resulting posture.
 */
let inProcessApplied = false;

export const applyDaemonSandbox = async (
  opts?: TApplySandboxOpts,
): Promise<TSandboxState> => {
  appliedState = await applyInner(opts);
  if (appliedState === "enforced") inProcessApplied = true;
  return appliedState;
};

/** Whether THIS process is itself confined (a real in-process apply reached
 *  `enforced` — the shim's re-exec, or a test probe). Children then inherit
 *  the confinement, so `sandboxSpawnArgs` must NOT re-wrap them: the dev-run
 *  wrap re-execs `process.argv[1]`, which inside a probe is not the daemon
 *  entry, and a double apply is pointless anyway. */
export const sandboxAppliedInProcess = (): boolean => inProcessApplied;

const applyInner = async (opts?: TApplySandboxOpts): Promise<TSandboxState> => {
  if (process.env.OPENLLM_DAEMON_NO_SANDBOX === "1") {
    logWarn(
      "sandbox",
      safeDiagnosticMessage`OPENLLM_DAEMON_NO_SANDBOX=1 — running unconfined`,
    );
    return "off";
  }
  // Source runs opt in (§3.5); the shim (`force`) and the compiled binary
  // always apply it.
  if (
    opts?.force !== true &&
    DAEMON_VERSION === "0.0.0-dev" &&
    process.env.OPENLLM_DAEMON_SANDBOX !== "1"
  ) {
    return "off";
  }
  if (process.platform === "darwin") {
    // macOS gets the in-process Seatbelt sandbox — the deny-by-default
    // counterpart to Landlock, applied via `sandbox_init` (no signing needed).
    // The App Sandbox (proposal §3.2 / Phase C) remains the future upgrade.
    const { applySeatbelt } = await import("./seatbelt");
    return applySeatbelt(opts?.home);
  }
  if (process.platform !== "linux") {
    return "unsupported";
  }
  try {
    const probed = await probeLandlockAbi();
    if (probed === null) {
      logWarn(
        "sandbox",
        safeDiagnosticMessage`could not bind libc — running unconfined`,
      );
      return "error";
    }
    const { libc, abi } = probed;
    // ≤ 0 = unsupported / disabled kernel.
    if (abi <= 0) {
      logInfo(
        "sandbox",
        "landlock unavailable on this kernel — relying on systemd hardening",
      );
      return "unsupported";
    }

    let handled = ACCESS_FS_V1_ALL;
    if (abi >= 2) handled |= ACCESS_FS_REFER;
    if (abi >= 3) handled |= ACCESS_FS_TRUNCATE;

    const attr = rulesetAttr(handled);
    const { ptr } = await import("bun:ffi");
    const rulesetFd = Number(
      libc.syscall3(
        SYS_LANDLOCK_CREATE_RULESET,
        BigInt(ptr(attr)),
        BigInt(attr.length),
        0n,
      ),
    );
    if (rulesetFd < 0) {
      logWarn("sandbox", `landlock_create_ruleset failed (${rulesetFd})`);
      return "error";
    }

    const readOnlyAccess =
      ACCESS_FS_EXECUTE | ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR;
    const ws = daemonWorkingSet(opts?.home);
    const addRules = (paths: readonly string[], allowed: bigint): void => {
      for (const path of paths) {
        const fd = libc.open(cstr(path), O_PATH | O_CLOEXEC);
        if (fd < 0) continue; // raced away since the existence filter — skip
        try {
          // A regular-file path_beneath rule may ONLY carry file-applicable
          // rights — directory-only bits make `add_rule` fail EINVAL, leaving
          // the file ungranted (the `~/.claude.json` failure). `ruleAccessFor`
          // narrows the mask for a file; directories keep the full set.
          // Classify the OPENED object via `fstatSync(fd)` (not `statSync(path)`)
          // so a path swapped between open() and the stat can't misclassify the
          // rule — the fd already references the real object. Fall back to
          // "directory" (the prior behaviour) if the fstat fails.
          let isFile = false;
          try {
            isFile = fstatSync(fd).isFile();
          } catch {
            isFile = false;
          }
          const rule = pathBeneathAttr(
            ruleAccessFor(allowed & handled, isFile),
            fd,
          );
          const rc = Number(
            libc.syscall4(
              SYS_LANDLOCK_ADD_RULE,
              BigInt(rulesetFd),
              BigInt(LANDLOCK_RULE_PATH_BENEATH),
              BigInt(ptr(rule)),
              0n,
            ),
          );
          if (rc !== 0) logWarn("sandbox", `landlock rule failed for ${path}`);
        } finally {
          libc.close(fd);
        }
      }
    };
    addRules(ws.readWrite, handled);
    addRules(ws.readOnly, readOnlyAccess);

    // restrict_self requires no_new_privs (we're an unprivileged process).
    if (libc.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
      libc.close(rulesetFd);
      logWarn(
        "sandbox",
        safeDiagnosticMessage`prctl(NO_NEW_PRIVS) failed — running unconfined`,
      );
      return "error";
    }
    const rc = Number(
      libc.syscall3(SYS_LANDLOCK_RESTRICT_SELF, BigInt(rulesetFd), 0n, 0n),
    );
    libc.close(rulesetFd);
    if (rc !== 0) {
      logWarn("sandbox", `landlock_restrict_self failed (${rc})`);
      return "error";
    }
    // Debug, not info: runs inside the per-spawn `--sandbox-exec` shim — at
    // info it floods the shared log with one line per wrapped child spawn.
    logDebug("sandbox", "landlock enforced", {
      abi,
      readWrite: ws.readWrite.length,
      readOnly: ws.readOnly.length,
    });
    return "enforced";
  } catch (err) {
    logWarn(
      "sandbox",
      `landlock setup threw (${err instanceof Error ? err.message : String(err)}) — running unconfined`,
    );
    return "error";
  }
};
