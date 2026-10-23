/**
 * Account-slot lifecycle for multi-account subscription providers:
 * `add_account`, `remove_account`, `pin_account`, plus the post-login
 * duplicate gate (`docs/plan/multi-account-subscriptions.md` §4).
 *
 * Account 0 always exists at today's `<root>/home` and is only logged out,
 * never removed. Indexes are reused after a removal finishes; while removal
 * is in flight the index stays reserved so a concurrent add cannot claim it.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TDaemonProviderConnection } from "@openllmsh/protocol";
import {
  allocateAccount,
  findDuplicateAccount,
  mutateRoster,
  mutateRosterSync,
  pendingDeletesOf,
  pinAccount,
  readRoster,
  releasePendingDelete,
  removeAccount,
  reservePendingDelete,
  setAccountHash,
  withRosterLock,
} from "./account-roster";
import type { TCliProvider } from "./cli-paths";
import {
  cliAccountsDir,
  cliEnv,
  cliHome,
  DEFAULT_ACCOUNT_INDEX,
} from "./cli-paths";
import { getDelegate } from "./delegation";
import { loginSlot } from "./delegation/login-flow";
import { clearAccountCooldowns } from "./hop-cooldown";
import { disposeAntigravityWarmPoolForGeminiHome } from "./native-runtime/antigravity-acp";
import { disposeCodexAppServerClientForHome } from "./native-runtime/codex-app-server";
import { runWithAccount } from "./op-context";
import { clearPendingAuth } from "./pending-auth";
import { invalidateUsage } from "./usage-cache";

/** Bound by `status.ts` (avoids a module cycle): forget the ambient
 *  account's status memory. */
let forgetProviderAccount: (slug: string) => void = () => undefined;
export const setForgetProviderAccount = (fn: (slug: string) => void): void => {
  forgetProviderAccount = fn;
};

export type TAccountCommandResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly account_index?: number;
  readonly duplicate_of?: number;
};

const isProvider = (slug: string): slug is TCliProvider =>
  getDelegate(slug) !== null;

const disposeAccountRuntimes = async (
  slug: TCliProvider,
  index: number,
): Promise<void> => {
  await runWithAccount(index, async () => {
    const env = cliEnv(slug, index);
    await disposeCodexAppServerClientForHome(env.CODEX_HOME ?? "");
    const geminiHome = env.GEMINI_HOME;
    if (geminiHome !== undefined && geminiHome.length > 0) {
      disposeAntigravityWarmPoolForGeminiHome(geminiHome);
    }
  });
};

export const addAccount = async (
  slug: string,
  label?: string,
  nowMs: number = Date.now(),
): Promise<TAccountCommandResult> => {
  if (!isProvider(slug)) return { ok: false, error: "unknown provider" };
  return withRosterLock(slug, () => {
    let index = DEFAULT_ACCOUNT_INDEX;
    mutateRosterSync(slug, (roster) => {
      const next = allocateAccount(
        roster,
        nowMs,
        label ?? null,
        pendingDeletesOf(slug),
      );
      index = next.index;
      return next.roster;
    });
    mkdirSync(cliHome(slug, undefined, index), {
      recursive: true,
      mode: 0o700,
    });
    return { ok: true, account_index: index };
  });
};

export const removeAccountSlot = async (
  slug: string,
  index: number,
): Promise<TAccountCommandResult> => {
  if (!isProvider(slug)) return { ok: false, error: "unknown provider" };
  if (index === DEFAULT_ACCOUNT_INDEX) {
    return {
      ok: false,
      error: "account 0 cannot be removed; sign out instead",
    };
  }

  const prepared = await withRosterLock(slug, () => {
    const roster = readRoster(slug);
    const account = roster.accounts.find((a) => a.index === index);
    if (account === undefined) {
      return { ok: false as const, error: "unknown account" };
    }
    const blocked = runWithAccount(index, () => loginSlot(slug).inFlight());
    if (blocked) {
      return {
        ok: false as const,
        error: "login in progress — cancel it first",
      };
    }
    const hash = account.account_hash;
    // Drop the roster row but keep the index reserved until the home is gone.
    reservePendingDelete(slug, index);
    mutateRosterSync(slug, (r) => removeAccount(r, index));
    return { ok: true as const, hash };
  });
  if (!prepared.ok) return prepared;

  const delegate = getDelegate(slug);
  try {
    if (delegate !== null) {
      // Best-effort vendor sign-out so the CLI revokes the session; the home
      // is deleted either way.
      await runWithAccount(index, () => delegate.logout()).catch(
        () => undefined,
      );
    }
    runWithAccount(index, () => {
      clearPendingAuth(slug);
      clearAccountCooldowns(slug);
      forgetProviderAccount(slug);
      delegate?.invalidateStatusObservation?.();
    });
    if (prepared.hash !== null && prepared.hash !== undefined) {
      invalidateUsage(slug, prepared.hash);
    }
    await disposeAccountRuntimes(slug, index);
    // The whole slot dir: its home AND its per-account config.json.
    rmSync(join(cliAccountsDir(slug), String(index)), {
      recursive: true,
      force: true,
    });
    return { ok: true, account_index: index };
  } finally {
    await withRosterLock(slug, () => {
      releasePendingDelete(slug, index);
    });
  }
};

export const pinAccountSlot = async (
  slug: string,
  index: number | null,
): Promise<TAccountCommandResult> => {
  if (!isProvider(slug)) return { ok: false, error: "unknown provider" };
  return withRosterLock(slug, () => {
    if (
      index !== null &&
      !readRoster(slug).accounts.some((a) => a.index === index)
    ) {
      return { ok: false, error: "unknown account" };
    }
    mutateRosterSync(slug, (roster) => pinAccount(roster, index));
    return { ok: true, ...(index !== null ? { account_index: index } : {}) };
  });
};

/**
 * Non-destructive hash stamp for status probes. Never removes a slot.
 */
export const stampAccountHash = (
  slug: string,
  index: number,
  accountHash: string,
): void => {
  if (!isProvider(slug)) return;
  void withRosterLock(slug, () => {
    const current = readRoster(slug).accounts.find((a) => a.index === index);
    if (current === undefined || current.account_hash === accountHash) return;
    mutateRosterSync(slug, (r) => setAccountHash(r, index, accountHash));
  }).catch(() => undefined);
};

/**
 * Record a connected slot's observed identity. When another slot of the same
 * provider is already signed into that account, the newer slot (n >= 1) is
 * signed out and removed, and the existing index is returned as
 * `duplicate_of`. Account 0 is never removed by this gate.
 */
export const reconcileAccountIdentity = async (
  conn: TDaemonProviderConnection,
  index: number,
): Promise<TAccountCommandResult> => {
  const slug = conn.provider;
  if (!isProvider(slug)) return { ok: true };
  const hash = conn.status === "connected" ? conn.account_hash : undefined;
  if (hash === undefined) return { ok: true, account_index: index };
  const roster = readRoster(slug);
  const duplicate = findDuplicateAccount(roster, index, hash);
  if (duplicate !== undefined && index !== DEFAULT_ACCOUNT_INDEX) {
    await removeAccountSlot(slug, index);
    return {
      ok: false,
      error: "duplicate_account",
      duplicate_of: duplicate.index,
    };
  }
  const current = roster.accounts.find((a) => a.index === index);
  if (current !== undefined && current.account_hash !== hash) {
    await mutateRoster(slug, (r) => setAccountHash(r, index, hash));
  }
  return { ok: true, account_index: index };
};

/**
 * Delete `accounts/<n>/` dirs whose slot is not in the roster (left by an
 * older build that removed only `home/`, or by a crash mid-removal). Never
 * touches account 0 (`<root>/home`), `bin/`, a slot still listed, or an
 * index reserved by an in-flight removal.
 */
export const pruneOrphanAccountDirs = (slug: TCliProvider): number => {
  let names: string[];
  try {
    names = readdirSync(cliAccountsDir(slug));
  } catch {
    return 0;
  }
  const live = new Set(readRoster(slug).accounts.map((a) => String(a.index)));
  for (const index of pendingDeletesOf(slug)) live.add(String(index));
  let pruned = 0;
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name) || live.has(name)) continue;
    rmSync(join(cliAccountsDir(slug), name), { recursive: true, force: true });
    pruned += 1;
  }
  return pruned;
};
