/**
 * Status publication coalescer: one active compute + at most one dirty
 * follow-up. Extra push requests collapse into the follow-up; awaiting a
 * collapsed request waits for that follow-up (fresh compute), not the
 * in-flight snapshot. Commands are not coalesced here.
 */

export type TStatusPublishTrigger =
  | "watcher"
  | "command"
  | "welcome"
  | "auth-sink"
  | "presence"
  | "bootstrap"
  | "late-probe";

export type TStatusPublishQueueSnapshot = {
  readonly queued_publish_depth: number;
  readonly collapsed_count: number;
  readonly oldest_queued_publish_age_ms: number;
  readonly status_trigger: TStatusPublishTrigger | undefined;
};

export type TStatusPublishRequest = {
  readonly skipUnchanged: boolean;
  readonly active?: boolean;
  readonly trigger: TStatusPublishTrigger;
};

type TWaiter = {
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
};

type TJob = {
  skipUnchanged: boolean;
  active: boolean | undefined;
  trigger: TStatusPublishTrigger;
  startedAtMs: number;
  collapsedCount: number;
  waiters: TWaiter[];
  epoch: number;
};

export type TStatusPublishCoalescerHost = {
  readonly now: () => number;
  readonly epoch: () => number;
  readonly computeFresh: (trigger: TStatusPublishTrigger) => Promise<{
    status: { connections: ReadonlyArray<unknown> } & Record<string, unknown>;
    fingerprint: string;
  }>;
  readonly canSend: (jobEpoch: number) => boolean;
  readonly lastFingerprint: () => string;
  readonly setLastFingerprint: (fingerprint: string) => void;
  readonly observe: (connections: ReadonlyArray<unknown>) => void;
  readonly send: (
    status: unknown,
    active: boolean | undefined,
    trigger: TStatusPublishTrigger,
  ) => void;
  readonly onCollapsed?: (snapshot: TStatusPublishQueueSnapshot) => void;
};

const resolveWaiters = (waiters: readonly TWaiter[]): void => {
  for (const waiter of waiters) waiter.resolve();
};

const rejectWaiters = (waiters: readonly TWaiter[], err: unknown): void => {
  for (const waiter of waiters) waiter.reject(err);
};

/** Higher rank must not inherit late-probe reuse; command/auth always win. */
const triggerFreshnessRank = (trigger: TStatusPublishTrigger): number => {
  if (trigger === "command" || trigger === "auth-sink") return 3;
  if (trigger === "welcome" || trigger === "bootstrap") return 2;
  if (trigger === "watcher" || trigger === "presence") return 1;
  return 0;
};

export const createStatusPublishCoalescer = (
  host: TStatusPublishCoalescerHost,
): {
  request: (req: TStatusPublishRequest) => Promise<void>;
  abandon: () => void;
  snapshot: () => TStatusPublishQueueSnapshot;
} => {
  let active: TJob | null = null;
  let followUp: TJob | null = null;
  let pumpRunning = false;

  const snapshot = (): TStatusPublishQueueSnapshot => {
    const now = host.now();
    const oldest = active ?? followUp;
    return {
      queued_publish_depth:
        (active !== null ? 1 : 0) + (followUp !== null ? 1 : 0),
      collapsed_count: followUp?.collapsedCount ?? 0,
      oldest_queued_publish_age_ms:
        oldest === null ? 0 : Math.max(0, now - oldest.startedAtMs),
      status_trigger: followUp?.trigger ?? active?.trigger,
    };
  };

  const enqueueWaiter = (job: TJob): Promise<void> =>
    new Promise((resolve, reject) => {
      job.waiters.push({ resolve, reject });
    });

  const mergeFollowUp = (req: TStatusPublishRequest): Promise<void> => {
    if (followUp === null) {
      followUp = {
        skipUnchanged: req.skipUnchanged,
        active: req.active,
        trigger: req.trigger,
        startedAtMs: host.now(),
        collapsedCount: 0,
        waiters: [],
        epoch: host.epoch(),
      };
    } else {
      followUp.collapsedCount += 1;
      followUp.skipUnchanged = followUp.skipUnchanged && req.skipUnchanged;
      if (req.active !== undefined) followUp.active = req.active;
      if (
        triggerFreshnessRank(req.trigger) >
        triggerFreshnessRank(followUp.trigger)
      ) {
        followUp.trigger = req.trigger;
      }
      host.onCollapsed?.(snapshot());
    }
    return enqueueWaiter(followUp);
  };

  const runJob = async (job: TJob, serial: number): Promise<void> => {
    try {
      const computed = await host.computeFresh(job.trigger);
      if (serial !== pumpSerial) return;
      if (!host.canSend(job.epoch)) {
        resolveWaiters(job.waiters);
        return;
      }
      if (
        job.skipUnchanged &&
        host.lastFingerprint() !== "" &&
        computed.fingerprint === host.lastFingerprint()
      ) {
        resolveWaiters(job.waiters);
        return;
      }
      host.observe(computed.status.connections);
      host.send(computed.status, job.active, job.trigger);
      host.setLastFingerprint(computed.fingerprint);
      resolveWaiters(job.waiters);
    } catch (err) {
      if (serial !== pumpSerial) return;
      rejectWaiters(job.waiters, err);
    }
  };

  let pumpSerial = 0;

  const pump = async (): Promise<void> => {
    if (pumpRunning) return;
    pumpRunning = true;
    const myPump = pumpSerial;
    try {
      while (active !== null && myPump === pumpSerial) {
        const job = active;
        await runJob(job, myPump);
        if (myPump !== pumpSerial) return;
        if (active === job) {
          active = followUp;
          followUp = null;
        }
      }
    } finally {
      if (myPump === pumpSerial) {
        pumpRunning = false;
        if (active !== null) void pump();
      }
    }
  };

  const request = (req: TStatusPublishRequest): Promise<void> => {
    if (active !== null && active.epoch === host.epoch()) {
      return mergeFollowUp(req);
    }
    const job: TJob = {
      skipUnchanged: req.skipUnchanged,
      active: req.active,
      trigger: req.trigger,
      startedAtMs: host.now(),
      collapsedCount: 0,
      waiters: [],
      epoch: host.epoch(),
    };
    active = job;
    const waiter = enqueueWaiter(job);
    void pump();
    return waiter;
  };

  /**
   * Drop queued follow-up and the current job so a new connection generation
   * can compute immediately. An in-flight compute is left as a zombie: its
   * result is generation-fenced by `canSend`, and this pump serial is
   * invalidated so it cannot occupy the coalescer behind dead work.
   */
  const abandon = (): void => {
    resolveWaiters(followUp?.waiters ?? []);
    followUp = null;
    if (active !== null) {
      resolveWaiters(active.waiters);
      active = null;
    }
    pumpSerial += 1;
    pumpRunning = false;
  };

  return { request, abandon, snapshot };
};
