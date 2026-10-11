/**
 * The daemon's ONE AsyncLocalStorage module. Refresh spawn metadata and the
 * status-tick correlation bag and bounded command replay lease live here so
 * a later reader never has to hunt a second ALS module. Login-command flow
 * identity also lives here so keychain/store diagnostics can read opaque
 * correlation without importing login-flow.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isReplaySessionId } from "@openllmsh/protocol";
import { opaqueDoctorCorrelation } from "./doctor-report/correlation";

type TCommandReplayContext = {
  active: boolean;
  readonly replaySessionId: string | undefined;
};
const commandReplayContext = new AsyncLocalStorage<
  TCommandReplayContext | undefined
>();

export const currentCommandReplaySessionId = (): string | undefined => {
  const context = commandReplayContext.getStore();
  return context?.active ? context.replaySessionId : undefined;
};

/** Close the shared lease: inherited detached callbacks cannot retain attribution. */
export const withCommandReplayContext = async <TResult>(
  replaySessionId: string | undefined,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  const context: TCommandReplayContext = {
    active: true,
    replaySessionId: isReplaySessionId(replaySessionId)
      ? replaySessionId
      : undefined,
  };
  return commandReplayContext.run(context, async () => {
    try {
      return await work();
    } finally {
      context.active = false;
    }
  });
};

/** Shared workers and event subscribers inherit neither replay nor login ownership. */
export const withoutCommandReplayContext = <TResult>(
  work: () => TResult,
): TResult =>
  commandReplayContext.run(undefined, () =>
    loginCommandContext.run(undefined, work),
  );

export type TRefreshSpawnBag = {
  meta:
    | {
        readonly spawned_at_ms: number | null;
        readonly child_pid: number | null;
      }
    | undefined;
  timeoutMs: number | undefined;
};

export const refreshSpawnBag = new AsyncLocalStorage<TRefreshSpawnBag>();

/** Who kicked `makeRefresher` — demand-path tag for `refresh_spawns.last`. */
export type TRefreshCaller = "upstream" | "usage" | "models" | "login";

export const refreshCallerBag = new AsyncLocalStorage<TRefreshCaller>();

export const currentRefreshCaller = (): TRefreshCaller | null =>
  refreshCallerBag.getStore() ?? null;

/**
 * Manual "Refresh usage" may call the existing native `readToken` path.
 * Default usage reads stay stored-only. The bag is scoped per provider
 * fetch so a sibling/later usage() cannot inherit permission, and so the
 * quota write can be tied to the status snapshot's `account_hash`.
 */
export type TUsageNativeRefreshBag = {
  readonly expectedAccountHash?: string;
};

const usageNativeRefreshBag = new AsyncLocalStorage<TUsageNativeRefreshBag>();

export const usageNativeRefreshAllowed = (): boolean =>
  usageNativeRefreshBag.getStore() !== undefined;

export const expectedUsageAccountHash = (): string | undefined =>
  usageNativeRefreshBag.getStore()?.expectedAccountHash;

export const withUsageNativeRefresh = <T>(
  fn: () => Promise<T>,
  expectedAccountHash?: string,
): Promise<T> =>
  usageNativeRefreshBag.run(
    expectedAccountHash === undefined ? {} : { expectedAccountHash },
    fn,
  );

export type TOpTick = {
  readonly tick_id: number;
  readonly slug?: string;
};

export const opTickContext = new AsyncLocalStorage<TOpTick>();

let nextTickId = 0;

export const nextStatusTickId = (): number => {
  nextTickId += 1;
  return nextTickId;
};

/** `null` off a status tick (e.g. a request-path refresh). */
export const currentTickId = (): number | null =>
  opTickContext.getStore()?.tick_id ?? null;

// ─── Login-command flow identity (control-relay → login adaptors / keychain) ─

export type TLoginCommandContext = {
  readonly flowId: string;
  readonly keyId: string;
  readonly localOnly?: boolean;
};

const loginCommandContext = new AsyncLocalStorage<
  TLoginCommandContext | undefined
>();

/**
 * Bind the current control-command's id as `flow_id` for the duration of
 * `run()`. Background work must capture the resolved flow — this binding is
 * restored when `run()` returns.
 */
export const runWithLoginCommand = async <T>(
  ctx: TLoginCommandContext,
  run: () => Promise<T>,
): Promise<T> => loginCommandContext.run(ctx, run);

export const currentLoginCommandContext = ():
  | TLoginCommandContext
  | undefined => loginCommandContext.getStore();

/** Opaque doctor correlation for the bound login command; omit when unbound. */
export const currentLoginCommandCorrelation = (): string | undefined =>
  opaqueDoctorCorrelation(loginCommandContext.getStore()?.flowId);
