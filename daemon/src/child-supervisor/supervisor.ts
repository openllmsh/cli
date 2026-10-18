import { logError, logWarn, safeDiagnosticMessage } from "../logger";
import { linuxPdeathsigArgv } from "./linux-pdeathsig";
import type { TReapOutcome } from "./posix";
import {
  DEFAULT_FINAL_REAP_MS,
  DEFAULT_TERMINATE_GRACE_MS,
  processGroupExists,
  signalGroup,
  terminateProcessGroup,
} from "./posix";
import type {
  TChildRegistryRecord,
  TDisposableChildKind,
  TProcessStartTimeHelperSpawn,
} from "./registry";
import {
  addChildRegistryRecord,
  argvDigest,
  childProcessMatchesRecord,
  currentChildSupervisorInstanceId,
  defaultProcessStartTimeHelperSpawn,
  listChildRegistryRecords,
  readProcessStartTime,
  removeChildRegistryRecord,
} from "./registry";
import { daemonSelfInvocation } from "./self-exec";

export type TSuperviseSpawnOptions = Omit<
  Bun.SpawnOptions.SpawnOptions<
    Bun.SpawnOptions.Writable,
    Bun.SpawnOptions.Readable,
    Bun.SpawnOptions.Readable
  >,
  "detached" | "onExit"
> & {
  readonly kind: TDisposableChildKind;
};

export type TTerminateOptions = {
  readonly graceMs?: number;
  readonly finalReapMs?: number;
};

export type TSupervisedChild = {
  readonly subprocess: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  readonly pgid: number;
  readonly terminate: (opts?: TTerminateOptions) => Promise<TReapOutcome>;
  readonly beginTask: () => () => void;
  /** Settles when tracking is dropped (confirmed exit). Pending while unconfirmed. */
  readonly whenReleased: Promise<TReapOutcome>;
};

type TTrackedChild = {
  readonly handle: TSupervisedChild;
  terminating: Promise<TReapOutcome> | null;
  lastReap: TReapOutcome | null;
  activeTasks: number;
  resolveReleased: (outcome: TReapOutcome) => void;
};

type TExitWait = (child: TSupervisedChild) => Promise<void>;

type TUnconfirmedWatchScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

export type TChildSupervisorDeps = {
  /** Replace the Bun `proc.exited` wait (e.g. never-settling exit hosts). */
  readonly exitWait?: TExitWait;
  /**
   * Map the real reap result to the label reported to callers. Used to
   * surface `reap_unconfirmed` after a confirmed group kill without leaving
   * live unreaped containment.
   */
  readonly mapReapOutcome?: (outcome: TReapOutcome) => TReapOutcome;
  /** Override `kill(-pgid, 0)` while proving unconfirmed containment. */
  readonly processGroupExists?: (pgid: number) => boolean;
  /**
   * Schedule unconfirmed-group fallback probes. Must clear its own timers
   * or delegate to `setTimeout`.
   */
  readonly unconfirmedWatchScheduler?: TUnconfirmedWatchScheduler;
  /**
   * Ops/safety switch for process-group signal delivery. Dry-run hosts and
   * containment fixtures pass `false` so `kill(-pgid, 0)` still probes
   * existence while TERM/KILL are withheld. Default `true`.
   */
  readonly deliverTerminationSignals?: boolean;
  /** Replace the async `ps -o lstart=` helper spawn. */
  readonly processStartTimeHelperSpawn?: TProcessStartTimeHelperSpawn;
};

const defaultUnconfirmedWatchScheduler: TUnconfirmedWatchScheduler = (
  callback,
  delayMs,
) => setTimeout(callback, delayMs);

/**
 * Adaptive fallback when the supervised root has exited (or never will
 * notify) but `kill(-pgid, 0)` still succeeds — descendants are not
 * SIGCHLD-visible. Short first probe, then exponential cap. Correctness
 * of cancel/release does not wait on this interval: explicit terminate
 * checks the group immediately, and root `exited` checks immediately.
 */
export const UNCONFIRMED_GROUP_FALLBACK_INITIAL_MS = 250;
export const UNCONFIRMED_GROUP_FALLBACK_MAX_MS = 5_000;

const nextFallbackDelayMs = (currentMs: number): number =>
  Math.min(UNCONFIRMED_GROUP_FALLBACK_MAX_MS, currentMs * 2);

export type TChildSupervisor = {
  readonly superviseSpawn: (
    argv: ReadonlyArray<string>,
    opts: TSuperviseSpawnOptions,
  ) => TSupervisedChild;
  readonly terminate: (
    handle: TSupervisedChild,
    opts?: TTerminateOptions,
  ) => Promise<TReapOutcome>;
  readonly terminateAllDisposable: (opts?: TTerminateOptions) => Promise<void>;
  readonly sweepStaleChildrenOnBoot: (
    opts?: TTerminateOptions,
  ) => Promise<void>;
  readonly notifySupervisedProcessExit: (pid: number) => void;
  readonly isChildTracked: (pid: number) => boolean;
};

/**
 * Build one child supervisor instance. Pure: it never touches module state.
 * Production uses the module's single default instance (built from real
 * defaults); a caller that needs different deps holds its own instance and
 * calls its methods directly.
 */
export const createChildSupervisor = (
  deps: TChildSupervisorDeps = {},
): TChildSupervisor => {
  const trackedChildren = new Map<number, TTrackedChild>();
  const unconfirmedWatchAbort = new Map<number, AbortController>();
  const deliver = deps.deliverTerminationSignals ?? true;
  const groupExistsProbe = deps.processGroupExists ?? null;
  const startTimeHelperSpawn =
    deps.processStartTimeHelperSpawn ?? defaultProcessStartTimeHelperSpawn;

  const childIsTracked = (pid: number): boolean => trackedChildren.has(pid);

  const notifySupervisedProcessExit = (pid: number): void => {
    unconfirmedWatchAbort.get(pid)?.abort();
  };

  const groupStillPresent = (pgid: number): boolean =>
    groupExistsProbe !== null
      ? groupExistsProbe(pgid)
      : processGroupExists(pgid);

  const exited = async (child: TSupervisedChild): Promise<void> => {
    try {
      await child.subprocess.exited;
    } catch {
      // Bun exposes exit status through the subprocess even for signal exits.
    }
  };

  const waitChildExited = (child: TSupervisedChild): Promise<void> =>
    deps.exitWait !== undefined ? deps.exitWait(child) : exited(child);

  const raceExitOrBudget = async (
    child: TSupervisedChild,
    budgetMs: number,
  ): Promise<"exited" | "budget"> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        waitChildExited(child).then(() => "exited" as const),
        new Promise<"budget">((resolve) => {
          timer = setTimeout(() => resolve("budget"), Math.max(0, budgetMs));
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const releaseChild = (
    tracked: TTrackedChild,
    outcome: TReapOutcome,
  ): void => {
    const child = tracked.handle;
    if (!childIsTracked(child.pid)) return;
    unconfirmedWatchAbort.get(child.pid)?.abort();
    unconfirmedWatchAbort.delete(child.pid);
    removeChildRegistryRecord(child.pid);
    trackedChildren.delete(child.pid);
    tracked.resolveReleased(outcome);
  };

  const forgetChild = (tracked: TTrackedChild, outcome: TReapOutcome): void => {
    if (outcome === "reap_unconfirmed") {
      logWarn(
        "child-supervisor",
        safeDiagnosticMessage`Process group not reaped after TERM and KILL.`,
        {
          pid: tracked.handle.pid,
          pgid: tracked.handle.pgid,
        },
      );
      void watchUnconfirmedExit(tracked).catch((error) =>
        logError("child-supervisor", error, {
          pid: tracked.handle.pid,
          pgid: tracked.handle.pgid,
        }),
      );
      return;
    }
    releaseChild(tracked, outcome);
  };

  const waitGroupCheck = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const schedule =
        deps.unconfirmedWatchScheduler ?? defaultUnconfirmedWatchScheduler;
      const timer = schedule(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  const maybeReleaseIfGroupGone = (tracked: TTrackedChild): boolean => {
    if (!childIsTracked(tracked.handle.pid)) return true;
    if (groupStillPresent(tracked.handle.pgid)) return false;
    releaseChild(tracked, "terminated");
    return true;
  };

  const watchUnconfirmedExit = async (
    tracked: TTrackedChild,
  ): Promise<void> => {
    const child = tracked.handle;
    const existing = unconfirmedWatchAbort.get(child.pid);
    if (existing !== undefined && !existing.signal.aborted) return;
    const ac = new AbortController();
    unconfirmedWatchAbort.set(child.pid, ac);
    const aborted = (): boolean =>
      ac.signal.aborted || !trackedChildren.has(child.pid);
    try {
      if (maybeReleaseIfGroupGone(tracked) || aborted()) return;
      let rootPending: Promise<"root"> | null = waitChildExited(child).then(
        () => "root" as const,
        () => "root" as const,
      );
      const abortWait = new Promise<"abort">((resolve) => {
        ac.signal.addEventListener("abort", () => resolve("abort"), {
          once: true,
        });
      });
      let delayMs = UNCONFIRMED_GROUP_FALLBACK_INITIAL_MS;
      while (!aborted() && groupStillPresent(child.pgid)) {
        const tick = waitGroupCheck(delayMs, ac.signal).then(
          () => "tick" as const,
        );
        const winner = await Promise.race([
          ...(rootPending !== null ? [rootPending] : []),
          tick,
          abortWait,
        ]);
        if (maybeReleaseIfGroupGone(tracked)) return;
        if (ac.signal.aborted || !childIsTracked(child.pid)) return;
        if (winner === "root") rootPending = null;
        if (winner === "tick") delayMs = nextFallbackDelayMs(delayMs);
      }
    } finally {
      if (unconfirmedWatchAbort.get(child.pid) === ac) {
        unconfirmedWatchAbort.delete(child.pid);
      }
      maybeReleaseIfGroupGone(tracked);
    }
  };

  const finishTrackedChild = async (
    tracked: TTrackedChild,
  ): Promise<TReapOutcome> => {
    try {
      await waitChildExited(tracked.handle);
    } catch {
      // Natural-exit waiter; terminate() owns cleanup if it already started.
    }
    if (tracked.terminating !== null) {
      const outcome = await tracked.terminating;
      if (
        outcome === "reap_unconfirmed" &&
        trackedChildren.has(tracked.handle.pid)
      ) {
        return tracked.handle.whenReleased;
      }
      return outcome;
    }
    return terminateTrackedChild(tracked, {
      graceMs: 0,
      finalReapMs: DEFAULT_FINAL_REAP_MS,
    });
  };

  const terminateTrackedChild = (
    tracked: TTrackedChild,
    opts: TTerminateOptions,
  ): Promise<TReapOutcome> => {
    if (
      tracked.lastReap === "reap_unconfirmed" &&
      tracked.terminating !== null
    ) {
      tracked.terminating = null;
    }
    if (tracked.terminating !== null) return tracked.terminating;
    const graceMs = opts.graceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    const finalReapMs = opts.finalReapMs ?? DEFAULT_FINAL_REAP_MS;
    const stillOwned = (): boolean => groupStillPresent(tracked.handle.pgid);
    tracked.terminating = (async (): Promise<TReapOutcome> => {
      signalGroup(tracked.handle.pgid, "SIGTERM", deliver);
      const first = await raceExitOrBudget(
        tracked.handle,
        Math.max(0, graceMs),
      );
      let outcome: TReapOutcome;
      if (first === "exited") {
        outcome = await terminateProcessGroup(
          tracked.handle.pgid,
          0,
          stillOwned,
          0,
          deliver,
        );
      } else {
        outcome = await terminateProcessGroup(
          tracked.handle.pgid,
          0,
          stillOwned,
          Math.max(0, finalReapMs),
          deliver,
        );
        if (outcome === "exited") outcome = "terminated";
      }
      const reported =
        deps.mapReapOutcome !== undefined
          ? deps.mapReapOutcome(outcome)
          : outcome;
      tracked.lastReap = reported;
      forgetChild(tracked, reported);
      return reported;
    })();
    return tracked.terminating;
  };

  const activeTaskRelease = (tracked: TTrackedChild): (() => void) => {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      if (tracked.activeTasks > 0) tracked.activeTasks -= 1;
      else tracked.activeTasks = 0;
    };
  };

  /** Whether a pid is still in the in-memory tracked set. */
  const isChildTracked = (pid: number): boolean => childIsTracked(pid);

  /**
   * Spawn one disposable child in an independently killable group and track
   * its root record. This supervisor deliberately excludes durable session
   * hosts. macOS has no PDEATHSIG; launchd shutdown plus process-group
   * cleanup owns it.
   */
  const superviseSpawn = (
    argv: ReadonlyArray<string>,
    opts: TSuperviseSpawnOptions,
  ): TSupervisedChild => {
    if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0)
      throw new Error("superviseSpawn requires a command");
    // Linux hard-crash guarantee: re-exec through the PDEATHSIG wrapper so
    // the child dies if the daemon is SIGKILLed (no macOS equivalent —
    // Darwin relies on the process group + launchd cleanup + the boot
    // sweep). Darwin argv is left byte-identical.
    const spawnArgv =
      process.platform === "linux"
        ? linuxPdeathsigArgv(argv, daemonSelfInvocation(), process.pid)
        : argv;
    const subprocess = Bun.spawn([...spawnArgv], {
      ...opts,
      // POSIX: lead an independently killable process group (pgid === pid).
      detached: true,
    });
    const pid = subprocess.pid;
    const pgid = pid;
    let handle: TSupervisedChild;
    let tracked: TTrackedChild;
    let resolveReleased: (outcome: TReapOutcome) => void = () => {};
    const whenReleased = new Promise<TReapOutcome>((resolve) => {
      resolveReleased = resolve;
    });
    const beginTask = (): (() => void) => {
      tracked.activeTasks += 1;
      return activeTaskRelease(tracked);
    };
    handle = {
      subprocess,
      pid,
      pgid,
      terminate: (
        terminateOptions?: TTerminateOptions,
      ): Promise<TReapOutcome> => terminate(handle, terminateOptions),
      beginTask,
      whenReleased,
    };
    tracked = {
      handle,
      terminating: null,
      lastReap: null,
      activeTasks: 0,
      resolveReleased,
    };
    trackedChildren.set(pid, tracked);
    // Persist the cross-restart identity record OFF the spawn hot path.
    // Reading the start time is a `ps` subprocess; doing it synchronously
    // here blocked the event loop on every spawn (a status sweep fans out 5
    // `--version` probes at once), starving unrelated async work. Defer it:
    // resolve the identity via the non-blocking reader, then write the
    // record once it lands.
    //
    // A short probe (`--version`) can exit within milliseconds — before
    // `ps -o lstart=` can read its start time (null identity), or before
    // this deferred write runs (the child already reaped, dropped from
    // `trackedChildren`). Either way we skip the PERSISTENT registry
    // record: a boot sweep needs a verifiable identity, and an
    // already-exited process is never a cross-restart orphan. The
    // in-memory tracking above is unaffected, so terminate() /
    // terminateAllDisposable() can still group-kill a live descendant.
    //
    // ACCEPTED macOS window: between spawn and this deferred write landing
    // (the async `ps` read, ms–tens of ms), the child has no persistent
    // record. Linux is still covered — `linuxPdeathsigArgv` SIGKILLs the
    // child with the parent — but Darwin has no PDEATHSIG and the boot
    // sweep keys on the registry, so a HARD daemon death (SIGKILL/native
    // crash, no graceful drain) inside that window can orphan a
    // still-detached macOS child that the next boot's sweep won't see.
    // This is the deliberate trade for taking the synchronous `ps` off the
    // spawn hot path (it stalled the event loop on every spawn); the
    // window is orders of magnitude shorter than a child's lifetime,
    // graceful drain still reaps via in-memory tracking, and most probes
    // are sub-second regardless.
    void (async () => {
      const startTime = await readProcessStartTime(pid, startTimeHelperSpawn);
      // Re-check membership AFTER the await: if the child exited during the
      // read, `finishTrackedChild` has already deleted it (and removed any
      // record), so writing now would leave a stale one. No `await`
      // between this guard and the write, so single-threaded JS keeps
      // them atomic against that deletion.
      if (startTime === null || !trackedChildren.has(pid)) return;
      addChildRegistryRecord({
        instanceId: currentChildSupervisorInstanceId(),
        kind: opts.kind,
        pid,
        pgid,
        processStartTime: startTime,
        argvDigest: argvDigest(argv),
        startedAtMs: Date.now(),
      });
    })().catch((error) =>
      logError("child-supervisor", error, { pid, pgid, kind: opts.kind }),
    );
    void finishTrackedChild(tracked).catch((error) =>
      logError("child-supervisor", error, { pid, pgid, kind: opts.kind }),
    );
    return handle;
  };

  const isIdleTrackedChild = (tracked: TTrackedChild): boolean =>
    tracked.activeTasks === 0;

  /** Idempotently stop one disposable child and remove its registry record. */
  const terminate = async (
    handle: TSupervisedChild,
    opts: TTerminateOptions = {},
  ): Promise<TReapOutcome> => {
    const tracked = trackedChildren.get(handle.pid);
    if (tracked === undefined) {
      removeChildRegistryRecord(handle.pid);
      return "exited";
    }
    return terminateTrackedChild(tracked, opts);
  };

  /**
   * TERM → grace → KILL every IDLE disposable child owned by this daemon
   * instance. A child with an open task lease (`beginTask`) is deliberately
   * SPARED so a graceful reap (self-update / SIGTERM) never kills a child
   * serving live work; it self-exits when its task ends, and on a hard
   * daemon exit Linux PDEATHSIG / macOS launchd process-group cleanup stops
   * it. Explicit `terminate(handle)` and the boot sweep still stop a child
   * unconditionally.
   */
  const terminateAllDisposable = async (
    opts: TTerminateOptions = {},
  ): Promise<void> => {
    const trackedEntries = [...trackedChildren.values()];
    const idleChildren = trackedEntries.filter(isIdleTrackedChild);

    await Promise.all(
      idleChildren.map((tracked) => terminateTrackedChild(tracked, opts)),
    );
  };

  const terminateStaleRecord = async (
    record: TChildRegistryRecord,
    opts: TTerminateOptions,
  ): Promise<void> => {
    if (!childProcessMatchesRecord(record)) {
      removeChildRegistryRecord(record.pid);
      return;
    }
    const outcome = await terminateProcessGroup(
      record.pgid,
      Math.max(0, opts.graceMs ?? DEFAULT_TERMINATE_GRACE_MS),
      () => childProcessMatchesRecord(record),
      Math.max(0, opts.finalReapMs ?? DEFAULT_FINAL_REAP_MS),
      deliver,
    );
    if (outcome === "reap_unconfirmed") {
      logWarn(
        "child-supervisor",
        safeDiagnosticMessage`stale process group unreaped after boot sweep`,
        {
          pid: record.pid,
          pgid: record.pgid,
        },
      );
    }
    removeChildRegistryRecord(record.pid);
  };

  /**
   * Kill verified disposable roots left by a prior daemon process. PID
   * identity is checked before every signal, so a recycled PID is never
   * targeted.
   */
  const sweepStaleChildrenOnBoot = async (
    opts: TTerminateOptions = {},
  ): Promise<void> => {
    const instanceId = currentChildSupervisorInstanceId();
    await Promise.all(
      listChildRegistryRecords()
        .filter((record) => record.instanceId !== instanceId)
        .map((record) => terminateStaleRecord(record, opts)),
    );
  };

  return {
    superviseSpawn,
    terminate,
    terminateAllDisposable,
    sweepStaleChildrenOnBoot,
    notifySupervisedProcessExit,
    isChildTracked,
  };
};

// The production instance, built once from real defaults. Not replaceable.
const active: TChildSupervisor = createChildSupervisor();

export const superviseSpawn: TChildSupervisor["superviseSpawn"] = (...args) =>
  active.superviseSpawn(...args);
export const terminate: TChildSupervisor["terminate"] = (...args) =>
  active.terminate(...args);
export const terminateAllDisposable: TChildSupervisor["terminateAllDisposable"] =
  (...args) => active.terminateAllDisposable(...args);
export const sweepStaleChildrenOnBoot: TChildSupervisor["sweepStaleChildrenOnBoot"] =
  (...args) => active.sweepStaleChildrenOnBoot(...args);
export const notifySupervisedProcessExit: TChildSupervisor["notifySupervisedProcessExit"] =
  (...args) => active.notifySupervisedProcessExit(...args);
export const isChildTracked: TChildSupervisor["isChildTracked"] = (...args) =>
  active.isChildTracked(...args);
