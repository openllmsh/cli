import { AsyncLocalStorage } from "node:async_hooks";
import { lowerPresentOutputLimitFields } from "@openllmsh/sdk/wire/features/output-limit-clamp";

/**
 * A Fusion plan's per-hop output ceilings (signed `hop_output_limits`),
 * aligned with the plan's hops. The walk runs inside this context so every
 * signature check sees the same limits and each hop's body is lowered to its
 * own ceiling — a step that hands off stops near its cutoff, and the client's
 * next request starts on the next step.
 */
type THopOutputLimits = {
  readonly limits: ReadonlyArray<number | null>;
  readonly byModel: ReadonlyMap<string, number>;
};

const hopOutputLimitsContext = new AsyncLocalStorage<THopOutputLimits>();

export const withHopOutputLimits = <T>(
  plan: ReadonlyArray<string>,
  limits: ReadonlyArray<number | null> | null,
  run: () => T,
): T => {
  if (limits === null || limits.length === 0) return run();
  const byModel = new Map<string, number>();
  plan.forEach((model, index) => {
    const limit = limits[index];
    if (limit != null) byModel.set(model, limit);
  });
  return hopOutputLimitsContext.run({ limits, byModel }, run);
};

/** The signed limits of the plan being walked; null outside a Fusion plan. */
export const currentHopOutputLimits = (): ReadonlyArray<number | null> | null =>
  hopOutputLimitsContext.getStore()?.limits ?? null;

/** This hop's output ceiling; null when it never hands off. */
export const hopOutputLimitOf = (modelId: string): number | null =>
  hopOutputLimitsContext.getStore()?.byModel.get(modelId) ?? null;

/**
 * Lower a built upstream body back to its hop's ceiling: the alias output
 * backfill runs after the walker's clamp and may raise it to the catalog cap.
 */
export const lowerToHopOutputLimit = (
  modelId: string,
  body: unknown,
): unknown => {
  const limit = hopOutputLimitOf(modelId);
  return limit === null ? body : lowerPresentOutputLimitFields(body, limit);
};
