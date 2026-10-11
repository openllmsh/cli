/**
 * Bounded command admission: per-provider mutation lanes, a usage worker
 * cap, and bounded control/continuation paths. Replaces the global auth FIFO.
 *
 * Overflow, reserved duplicate Connect, login-owned logout, apply-busy,
 * idle continuation, and cancel flow mismatch NEVER invoke `job`. The host
 * maps {@link TScheduleResult} to an ack.
 */
import type { TDaemonCommand } from "@openllmsh/protocol";
import { DELEGATES } from "./delegation";
import {
  endDaemonApply,
  loginSlot,
  providerAuthOperationActive,
  tryBeginDaemonApply,
} from "./delegation/login-flow";

export type TCommandLane =
  | "control"
  | "observe"
  | "continuation"
  | "mutation"
  | "usage"
  | "global"
  | "apply";

export type TAdmissionReason =
  | "resurface"
  | "login_conflict"
  | "apply_busy"
  | "overflow"
  | "continuation_idle"
  | "flow_mismatch";

export type TScheduleResult =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly retryable: true;
      readonly reason: TAdmissionReason;
      readonly slug?: string;
    };

export type TProviderUsageRunResult = {
  readonly deferred?: boolean;
};

export type TProviderUsageBatchResult = {
  readonly deferred: readonly string[];
};

const ADMITTED: TScheduleResult = { admitted: true };

const reject = (reason: TAdmissionReason, slug?: string): TScheduleResult => ({
  admitted: false,
  retryable: true,
  reason,
  ...(slug !== undefined ? { slug } : {}),
});

const CONTROL_QUEUE_MAX = 1;
const CONTINUATION_QUEUE_MAX = 1;
const MUTATION_QUEUE_MAX = 2;
const GLOBAL_QUEUE_MAX = 1;
const USAGE_CAP = Math.max(1, Object.keys(DELEGATES).length - 1);

export const schedulerProviderSlugs = (): readonly string[] =>
  Object.keys(DELEGATES);

export const commandLaneOf = (cmd: TDaemonCommand): TCommandLane => {
  switch (cmd.kind) {
    case "cancel_connect":
      return "control";
    case "submit_login_code":
      return "continuation";
    case "connect":
    case "connect_device_code":
    case "logout":
      return "mutation";
    case "refresh":
      return "usage";
    case "status":
    case "list_local_sessions":
      return "observe";
    case "update":
      return "apply";
    case "bust_plan_cache":
    case "refresh_models":
    case "refresh_models_due":
    case "set_auto_update":
      return "global";
  }
};

export const commandProviderOf = (cmd: TDaemonCommand): string | undefined => {
  const payload = "payload" in cmd ? cmd.payload : undefined;
  if (
    payload !== null &&
    payload !== undefined &&
    typeof payload === "object" &&
    "slug" in payload &&
    typeof payload.slug === "string"
  ) {
    return payload.slug;
  }
  return undefined;
};

const chain = (tail: Promise<void>, job: () => Promise<void>): Promise<void> =>
  tail.catch(() => undefined).then(job);

const cancelFlowIdOf = (cmd: TDaemonCommand): string | undefined => {
  if (cmd.kind !== "cancel_connect") return undefined;
  const payload = cmd.payload;
  if (
    payload !== null &&
    payload !== undefined &&
    typeof payload === "object" &&
    "flow_id" in payload &&
    typeof payload.flow_id === "string"
  ) {
    return payload.flow_id;
  }
  return undefined;
};

const loginOwned = (slug: string, reserved: ReadonlySet<string>): boolean => {
  const slot = loginSlot(slug);
  return reserved.has(slug) || slot.inFlight() || slot.cleanupUnknown();
};

const authBusy = (slug: string, reserved: ReadonlySet<string>): boolean =>
  loginOwned(slug, reserved) || providerAuthOperationActive(slug);

const runAdmitted = async (
  job: () => Promise<void>,
): Promise<TScheduleResult> => {
  await job();
  return ADMITTED;
};

export type TCommandScheduler = {
  readonly schedule: (
    cmd: TDaemonCommand,
    job: () => Promise<void>,
  ) => Promise<TScheduleResult>;
  readonly schedulePerProviderUsage: (
    runOne: (slug: string) => Promise<TProviderUsageRunResult | undefined>,
  ) => Promise<TProviderUsageBatchResult>;
};

export const createCommandScheduler = (): TCommandScheduler => {
  const mutationTails = new Map<string, Promise<void>>();
  const mutationQueued = new Map<string, number>();
  const loginReserved = new Set<string>();
  const controlTails = new Map<string, Promise<void>>();
  const controlQueued = new Map<string, number>();
  const continuationTails = new Map<string, Promise<void>>();
  const continuationQueued = new Map<string, number>();
  let globalTail: Promise<void> = Promise.resolve();
  let globalQueued = 0;
  let usageActive = 0;
  const usageWait: Array<() => void> = [];

  const acquireUsage = async (): Promise<void> => {
    if (usageActive < USAGE_CAP) {
      usageActive += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      usageWait.push(resolve);
    });
  };

  const releaseUsage = (): void => {
    const next = usageWait.shift();
    if (next !== undefined) {
      next();
      return;
    }
    usageActive = Math.max(0, usageActive - 1);
  };

  const enqueueCounted = (
    tails: Map<string, Promise<void>>,
    queued: Map<string, number>,
    max: number,
    slug: string,
    job: () => Promise<void>,
  ): Promise<TScheduleResult> => {
    const occupancy = queued.get(slug) ?? 0;
    if (occupancy >= max) {
      return Promise.resolve(reject("overflow", slug));
    }
    queued.set(slug, occupancy + 1);
    const next = chain(tails.get(slug) ?? Promise.resolve(), async () => {
      try {
        await job();
      } finally {
        queued.set(slug, Math.max(0, (queued.get(slug) ?? 1) - 1));
      }
    });
    tails.set(slug, next);
    return next.then(() => ADMITTED);
  };

  const enqueueMutation = (
    slug: string,
    job: () => Promise<void>,
  ): Promise<TScheduleResult> =>
    enqueueCounted(
      mutationTails,
      mutationQueued,
      MUTATION_QUEUE_MAX,
      slug,
      job,
    );

  const runUsageOnSlug = (
    slug: string,
    job: () => Promise<void>,
  ): Promise<TScheduleResult> => {
    if (authBusy(slug, loginReserved)) {
      return Promise.resolve(reject("login_conflict", slug));
    }
    let inner: TScheduleResult = ADMITTED;
    return enqueueMutation(slug, async () => {
      if (authBusy(slug, loginReserved)) {
        inner = reject("login_conflict", slug);
        return;
      }
      await acquireUsage();
      try {
        await job();
      } finally {
        releaseUsage();
      }
    }).then((queued) => (queued.admitted ? inner : queued));
  };

  const schedulePerProviderUsage = async (
    runOne: (slug: string) => Promise<TProviderUsageRunResult | undefined>,
  ): Promise<TProviderUsageBatchResult> => {
    const deferred: string[] = [];
    await Promise.all(
      schedulerProviderSlugs().map(async (slug) => {
        if (authBusy(slug, loginReserved)) {
          deferred.push(slug);
          return;
        }
        let runDeferred = false;
        const admitted = await runUsageOnSlug(slug, async () => {
          try {
            const outcome = await runOne(slug);
            if (outcome?.deferred === true) runDeferred = true;
          } catch {
            // one provider failure does not discard the others
          }
        });
        if (!admitted.admitted || runDeferred) deferred.push(slug);
      }),
    );
    return { deferred };
  };

  return {
    schedulePerProviderUsage,
    schedule: (cmd, job): Promise<TScheduleResult> => {
      const lane = commandLaneOf(cmd);
      const slug = commandProviderOf(cmd);

      if (lane === "observe") {
        return runAdmitted(job);
      }

      if (lane === "control") {
        if (slug === undefined) return runAdmitted(job);
        const wantFlow = cancelFlowIdOf(cmd);
        const live = loginSlot(slug).flow();
        if (
          wantFlow !== undefined &&
          live !== null &&
          live.flowId !== wantFlow
        ) {
          return Promise.resolve(reject("flow_mismatch", slug));
        }
        return enqueueCounted(
          controlTails,
          controlQueued,
          CONTROL_QUEUE_MAX,
          slug,
          job,
        );
      }

      if (lane === "continuation") {
        if (slug === undefined) return runAdmitted(job);
        if (!loginSlot(slug).inFlight()) {
          return Promise.resolve(reject("continuation_idle", slug));
        }
        return enqueueCounted(
          continuationTails,
          continuationQueued,
          CONTINUATION_QUEUE_MAX,
          slug,
          job,
        );
      }

      if (lane === "apply") {
        const began = tryBeginDaemonApply();
        if (!began) {
          return Promise.resolve(reject("apply_busy"));
        }
        return (async () => {
          try {
            await job();
            return ADMITTED;
          } finally {
            endDaemonApply();
          }
        })();
      }

      if (lane === "global") {
        if (globalQueued >= GLOBAL_QUEUE_MAX) {
          return Promise.resolve(reject("overflow"));
        }
        globalQueued += 1;
        globalTail = chain(globalTail, async () => {
          globalQueued = Math.max(0, globalQueued - 1);
          await job();
        });
        return globalTail.then(() => ADMITTED);
      }

      if (lane === "mutation") {
        if (slug === undefined) return runAdmitted(job);
        if (loginOwned(slug, loginReserved)) {
          const reason = cmd.kind === "logout" ? "login_conflict" : "resurface";
          return Promise.resolve(reject(reason, slug));
        }
        if ((mutationQueued.get(slug) ?? 0) >= MUTATION_QUEUE_MAX) {
          return Promise.resolve(reject("overflow", slug));
        }
        const reserveLogin =
          cmd.kind === "connect" || cmd.kind === "connect_device_code";
        if (reserveLogin) {
          loginReserved.add(slug);
        }
        try {
          return enqueueMutation(slug, async () => {
            try {
              await job();
            } finally {
              if (reserveLogin) {
                loginReserved.delete(slug);
              }
            }
          });
        } catch (error) {
          if (reserveLogin) {
            loginReserved.delete(slug);
          }
          throw error;
        }
      }

      if (lane === "usage") {
        if (slug === undefined) {
          return runAdmitted(job);
        }
        return runUsageOnSlug(slug, job);
      }

      return runAdmitted(job);
    },
  };
};

/** Shared with control-channel and runCommandInner so unscoped refresh uses the same lanes. */
export const daemonCommandScheduler = createCommandScheduler();
