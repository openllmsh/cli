/**
 * Multi-account expansion of a subscription hop, shared by every walker
 * (`docs/plan/multi-account-subscriptions.md` §6).
 *
 * A subscription hop names a provider, not an account: on this device it
 * expands into the provider's roster. Signed-in, non-cooling accounts are
 * ranked (pinned → least remaining quota → unknown by index) and dialled in
 * order, each inside `runWithAccount` so the delegate's credential, usage and
 * cooldown state are that account's. Chat (`walker.ts`) layers its fleet
 * tunnel, conversation affinity and hop trail on top of
 * {@link planSubscriptionAccounts}; the media walkers (audio, image, video)
 * use {@link serveAcrossAccounts} directly.
 *
 * Only an ACCOUNT-level failure (cool-and-advance reasons from the shared
 * classifier — quota/auth/rate/payment, including credits wording on any
 * 4xx — or no credential for that account) moves on to the next account.
 * Anything else — an input the model rejects, a 5xx — is the hop's answer
 * and stays with the plan walk.
 */

import type {
  TCooldownReason,
  TProviderUsageSnapshot,
} from "@openllmsh/sdk/protocol";
import type { TRankableAccount } from "@openllmsh/sdk/wire/features/account-rank";
import {
  pickFinalFallback,
  rankProviderAccounts,
} from "@openllmsh/sdk/wire/features/account-rank";
import { GATE_STALE_CAP_MS } from "@openllmsh/sdk/wire/features/quota-gate";
import { readRoster } from "./account-roster";
import { AccountKeyedMap } from "./account-scope";
import { requestStatusPush } from "./auth-events";
import type { TCliProvider } from "./cli-paths";
import { lookupCatalogEntry } from "./config";
import { getDelegate, isOAuthSlug } from "./delegation";
import { isHopCoolingDown, markHopCooldown } from "./hop-cooldown";
import { accountCoolReasonForHttp } from "./media-retry";
import { runWithAccount } from "./op-context";
import { peekUsageForQuotaGate, sampleUsageOnExhaustion } from "./usage-cache";

type THopRef = { readonly provider: string; readonly modelId: string };

/**
 * Local subscription readiness for one provider — shared by the auth gate
 * and the quota-account lookup so a hop pays `status()` at most once.
 * `connected: false` means install-only / not signed in / status failed;
 * the walker must not spawn a bridge or attempt handrolled on that box.
 */
export type TLocalSubscriptionAuth = {
  readonly connected: boolean;
  readonly detail: string | null;
};

/** Per-request caches, keyed per provider account (ambient `runWithAccount`). */
export type TAccountCaches = {
  readonly connectedByProvider: Map<string, TLocalSubscriptionAuth>;
  readonly accountHashByProvider: Map<string, string | null>;
};

export const ensureLocalSubscription = async (
  provider: string,
  connectedByProvider: Map<string, TLocalSubscriptionAuth>,
  accountHashByProvider: Map<string, string | null>,
): Promise<TLocalSubscriptionAuth> => {
  const cached = connectedByProvider.get(provider);
  if (cached !== undefined) return cached;

  const { readProviderStatus } = await import("./status");
  const { normalizeProviderConnection } = await import(
    "@openllmsh/sdk/protocol"
  );
  // Always probe through `readProviderStatus` — a process-wide last-known
  // connected row must not mask a later unknown/timeout (serviceable:false).
  // Per-walk dedupe is `connectedByProvider` above; status owns its own
  // in-flight coalescing so hops in one tick still share one CLI spawn.
  const status = await readProviderStatus(provider);
  if (status === null) {
    const miss: TLocalSubscriptionAuth = {
      connected: false,
      detail: `${provider} is not a local subscription provider`,
    };
    connectedByProvider.set(provider, miss);
    accountHashByProvider.set(provider, null);
    return miss;
  }
  const normalized = normalizeProviderConnection(status);
  const result: TLocalSubscriptionAuth = {
    connected: normalized.serviceable,
    detail: normalized.serviceable
      ? null
      : (status.detail ?? `${provider} not signed in on this device`),
  };
  connectedByProvider.set(provider, result);
  accountHashByProvider.set(
    provider,
    normalized.serviceable ? (status.account_hash ?? null) : null,
  );
  return result;
};

export const usageForActiveAccount = async (
  provider: string,
  accountHashByProvider: Map<string, string | null>,
  connectedByProvider: Map<string, TLocalSubscriptionAuth> = new Map(),
): Promise<TProviderUsageSnapshot | null> => {
  // Single resolution path:
  //   1. If the auth cache already says not-connected → null (walker auth gate
  //      already paid for status()).
  //   2. If the account hash is not yet known → ensureLocalSubscription fills
  //      both maps (same probe the hop auth gate uses).
  //   3. Peek the usage cache for that account. A pre-seeded account hash
  //      (unit tests) is honored without a live status() re-probe.
  const known = connectedByProvider.get(provider);
  if (known !== undefined && !known.connected) return null;

  if (!accountHashByProvider.has(provider)) {
    const auth = await ensureLocalSubscription(
      provider,
      connectedByProvider,
      accountHashByProvider,
    );
    if (!auth.connected) return null;
  }

  const accountHash = accountHashByProvider.get(provider) ?? null;
  if (accountHash === null) return null;
  const delegate = getDelegate(provider);
  if (delegate === null) return null;
  // `usage()` is a stored-credential read — it must not native-refresh.
  return peekUsageForQuotaGate(provider, accountHash, () => delegate.usage());
};

export type TSubscriptionAccountPlan = {
  /** Signed-in accounts on this device, with their usage and cooldown. */
  readonly signedIn: ReadonlyArray<TRankableAccount>;
  /** Usable accounts in dial order (cooling and exhausted ones left out). */
  readonly ranked: ReadonlyArray<number>;
  /** The least-bad signed-in account, for never-drop-all on a final dial. */
  readonly fallbackIndex: number | undefined;
};

/**
 * Rank the provider's accounts for one hop. `null` for a single-account
 * provider, which keeps its original single-dial path.
 */
export const planSubscriptionAccounts = async (
  hop: THopRef,
  caches: TAccountCaches,
): Promise<TSubscriptionAccountPlan | null> => {
  const roster = readRoster(hop.provider as TCliProvider);
  if (roster.accounts.length <= 1) return null;
  const now = Date.now();
  const meter = lookupCatalogEntry(hop.modelId)?.subscription_meter;
  const signedIn: TRankableAccount[] = [];
  for (const { index } of roster.accounts) {
    const rankable = await runWithAccount(index, async () => {
      const auth = await ensureLocalSubscription(
        hop.provider,
        caches.connectedByProvider,
        caches.accountHashByProvider,
      );
      if (!auth.connected) return null;
      return {
        index,
        snapshot: await usageForActiveAccount(
          hop.provider,
          caches.accountHashByProvider,
          caches.connectedByProvider,
        ),
        cooling: isHopCoolingDown(hop.provider, hop.modelId, now),
      };
    });
    if (rankable !== null) signedIn.push(rankable);
  }
  const rankInput = {
    accounts: signedIn,
    meter,
    pinnedIndex: roster.pinned_index,
    staleCapMs: GATE_STALE_CAP_MS,
    now,
  };
  return {
    signedIn,
    ranked: rankProviderAccounts(rankInput).map((a) => a.index),
    fallbackIndex: pickFinalFallback(rankInput),
  };
};

/**
 * The cooldown an upstream HTTP status (+ body) puts on the ACCOUNT that
 * answered it, or `undefined` when the status is not about the account
 * (input rejected, model missing, server error) and another account would
 * answer the same. Uses the shared hop classifier so credits wording on any
 * 4xx cools like chat.
 */
export const accountCooldownReasonFor = (
  status: number,
  raw = "",
  provider?: string,
): TCooldownReason | undefined =>
  accountCoolReasonForHttp(status, raw, provider);

/**
 * Cool the ambient account for this hop and, on `quota_exhausted`, sample its
 * usage at once so the quota gate has a rejected snapshot to rank on — an
 * exhausted account emits no successful request, so nothing else would
 * re-sample it. A changed `auth` mark pushes status. Returns whether the
 * cooldown mark changed.
 */
export const noteAccountFailure = (
  hop: THopRef,
  reason: TCooldownReason,
  opts: {
    readonly accountHash: string | null | undefined;
    readonly sessionKey?: string;
    readonly recoverAtMs?: number;
  },
): boolean => {
  const changed = markHopCooldown(
    hop.provider,
    hop.modelId,
    reason,
    opts.sessionKey,
    opts.recoverAtMs,
  );
  if (reason === "quota_exhausted") {
    const delegate = getDelegate(hop.provider);
    if (delegate !== null) {
      sampleUsageOnExhaustion(
        hop.provider,
        () => delegate.usage(),
        opts.accountHash ?? undefined,
      );
    }
  }
  // A NEW/changed `auth` mark on a subscription hop: push status now so the
  // dashboard overlay does not wait for the 15s watcher. Repeated identical
  // marks do not re-arm. Never refresh.
  if (changed && reason === "auth" && isOAuthSlug(hop.provider)) {
    getDelegate(hop.provider)?.invalidateStatusObservation?.();
    requestStatusPush();
  }
  return changed;
};

/**
 * The account-level failure of one media dial, or `undefined` when the
 * response is the hop's own answer (success, or a failure another account
 * would repeat). `null` is a transport failure — never account-level.
 * Clones the body so the walker's later `resp.text()` still works.
 */
const mediaAccountFailureOf = async (
  resp: Response | null,
  accountHash: string | null,
  provider?: string,
): Promise<TAccountFailure | undefined> => {
  if (resp === null || resp.ok) return undefined;
  const raw = await resp
    .clone()
    .text()
    .catch(() => "");
  const reason = accountCooldownReasonFor(resp.status, raw, provider);
  if (reason === undefined) return undefined;
  return { kind: "upstream", status: resp.status, accountHash, reason };
};

/**
 * The attempt for one media dial (credential + upstream response): an
 * account-level failure lets the next account try, and the skipped
 * response's body is drained.
 */
export const mediaDialAttempt = async <
  TDial extends {
    readonly acquired: { readonly accountHash: string | null };
    readonly resp: Response | null;
  },
>(
  dial: TDial,
  provider?: string,
): Promise<TAccountAttempt<TDial>> => {
  const failure = await mediaAccountFailureOf(
    dial.resp,
    dial.acquired.accountHash,
    provider,
  );
  return {
    result: dial,
    ...(failure !== undefined ? { failure } : {}),
    release: async () => {
      await dial.resp?.body?.cancel().catch(() => {});
    },
  };
};

/** Why one account could not serve; the next account may. */
export type TAccountFailure =
  | {
      readonly kind: "upstream";
      readonly status: number;
      readonly accountHash: string | null;
      readonly reason: TCooldownReason;
      readonly recoverAtMs?: number;
    }
  | { readonly kind: "no_credential" };

export type TAccountAttempt<TResult> = {
  readonly result: TResult;
  /** Set when the dial failed for a reason another account could avoid. */
  readonly failure?: TAccountFailure;
  /**
   * Release a skipped result (drain its body). A skipped attempt is not
   * recorded: the cloud would read the error row as a model cooldown, and a
   * sibling account is about to serve the model.
   */
  readonly release?: () => Promise<void> | void;
};

export type TServeAcrossAccountsOptions<TResult> = {
  /** The plan's last hop: never-drop-all dials the least-bad account. */
  readonly finalHop: boolean;
  /** Stop trying further accounts once the client has gone. */
  readonly signal: AbortSignal;
  /**
   * The result when every signed-in account is cooling or exhausted on a
   * non-final hop — no dial; the caller advances the plan with it.
   */
  readonly exhausted: () => TResult;
};

/**
 * Dial a media hop across the provider's signed-in accounts. Each attempt runs
 * in its account; an account-level failure cools that account and, while
 * another account remains, moves on to it. The last attempt's result is the
 * hop's answer, so the caller's plan-walk logic is unchanged.
 *
 * A single-account provider, or one with no signed-in account, is dialled once
 * on the ambient account, as before. When every signed-in account is cooling
 * or exhausted, a non-final hop is skipped (`exhausted`) and the final hop
 * still dials the least-bad account for a real upstream answer — as chat.
 */
export const serveAcrossAccounts = async <TResult>(
  hop: THopRef,
  attempt: () => Promise<TAccountAttempt<TResult>>,
  options: TServeAcrossAccountsOptions<TResult>,
): Promise<TResult> => {
  const { finalHop, signal } = options;
  // Keyed per account (ambient `runWithAccount`): a plain Map would hand every
  // account the first one's auth and usage.
  const plan = await planSubscriptionAccounts(hop, {
    connectedByProvider: new AccountKeyedMap(),
    accountHashByProvider: new AccountKeyedMap(),
  });
  if (plan !== null && plan.signedIn.length > 0 && plan.ranked.length === 0) {
    if (!finalHop) return options.exhausted();
  }
  const order =
    plan === null || plan.signedIn.length === 0
      ? null
      : plan.ranked.length > 0
        ? plan.ranked
        : plan.fallbackIndex !== undefined
          ? [plan.fallbackIndex]
          : null;
  if (order === null) {
    const only = await attempt();
    coolOnFailure(hop, only.failure);
    return only.result;
  }
  for (let i = 0; ; i += 1) {
    const index = order[i];
    if (index === undefined) throw new Error("account order exhausted");
    const siblingsRemaining = order.length - 1 - i;
    const dialed = await runWithAccount(index, async () => {
      const outcome = await attempt();
      coolOnFailure(hop, outcome.failure);
      return outcome;
    });
    if (
      siblingsRemaining === 0 ||
      dialed.failure === undefined ||
      signal.aborted
    ) {
      return dialed.result;
    }
    await dialed.release?.();
  }
};

const coolOnFailure = (
  hop: THopRef,
  failure: TAccountFailure | undefined,
): void => {
  if (failure?.kind !== "upstream") return;
  noteAccountFailure(hop, failure.reason, {
    accountHash: failure.accountHash,
    ...(failure.recoverAtMs !== undefined
      ? { recoverAtMs: failure.recoverAtMs }
      : {}),
  });
};
