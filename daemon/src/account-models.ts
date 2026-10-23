/**
 * The model list a multi-account provider reports to the cloud is the UNION of
 * its signed-in accounts' lists (`docs/plan/multi-account-subscriptions.md`
 * §5): the catalog stays one `model_cache` row per (user, provider), and the
 * device walker picks whichever account can serve a model. A single-account
 * provider calls the delegate exactly as before.
 */
import type { TProviderModelEntry } from "@openllmsh/protocol";
import { readRoster } from "./account-roster";
import type { TCliProvider } from "./cli-paths";
import type { TProviderDelegate } from "./delegation";
import type {
  TListModelsOptions,
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
} from "./delegation/types";
import { runWithAccount } from "./op-context";

const accountIndexes = (slug: string): readonly number[] =>
  readRoster(slug as TCliProvider).accounts.map((a) => a.index);

/** First entry wins per `provider_model_id`, in account-index order. */
export const unionModelEntries = (
  lists: ReadonlyArray<ReadonlyArray<TProviderModelEntry>>,
): TProviderModelEntry[] => {
  const seen = new Map<string, TProviderModelEntry>();
  for (const list of lists) {
    for (const entry of list) {
      if (!seen.has(entry.provider_model_id)) {
        seen.set(entry.provider_model_id, entry);
      }
    }
  }
  return [...seen.values()];
};

export const listModelsAcrossAccounts = async (
  delegate: TProviderDelegate,
  opts?: TListModelsOptions,
): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
  const list = delegate.listModels;
  if (list === undefined) return null;
  const indexes = accountIndexes(delegate.slug);
  if (indexes.length <= 1) return list(opts);
  const results = await Promise.all(
    indexes.map((index) =>
      runWithAccount(index, () => list(opts).catch(() => null)),
    ),
  );
  const lists = results.filter(
    (r): r is ReadonlyArray<TProviderModelEntry> => r !== null,
  );
  return lists.length === 0 ? null : unionModelEntries(lists);
};

export const discoverModelsAcrossAccounts = async (
  delegate: TProviderDelegate,
  options: TModelDiscoveryOptions,
): Promise<TModelDiscoveryResult> => {
  const discover = delegate.discoverModels;
  if (discover === undefined) return { kind: "skipped" };
  const indexes = accountIndexes(delegate.slug);
  if (indexes.length <= 1) return discover(options);
  const results = await Promise.all(
    indexes.map((index) =>
      runWithAccount(index, () =>
        discover(options).catch(
          (): TModelDiscoveryResult => ({ kind: "failed" }),
        ),
      ),
    ),
  );
  const lists = results.flatMap((r) =>
    r.kind === "success" ? [r.models] : [],
  );
  if (lists.length > 0) {
    return { kind: "success", models: unionModelEntries(lists) };
  }
  return results.some((r) => r.kind === "failed")
    ? { kind: "failed" }
    : { kind: "skipped" };
};
