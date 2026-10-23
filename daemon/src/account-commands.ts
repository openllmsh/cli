/**
 * Account-slot lifecycle for multi-account subscription providers:
 * `add_account`, `remove_account`, `pin_account`, plus the post-login
 * duplicate gate (`docs/plan/multi-account-subscriptions.md` §4).
 *
 * Account 0 always exists at today's `<root>/home` and is only logged out,
 * never removed. Indexes are never reused.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TDaemonProviderConnection } from "@openllmsh/protocol";
import {
  allocateAccount,
  findDuplicateAccount,
  mutateRoster,
  pinAccount,
  readRoster,
  removeAccount,
  setAccountHash,
} from "./account-roster";
import type { TCliProvider } from "./cli-paths";
import { cliAccountsDir, cliHome, DEFAULT_ACCOUNT_INDEX } from "./cli-paths";
import { getDelegate } from "./delegation";
import { loginSlot } from "./delegation/login-flow";
import { runWithAccount } from "./op-context";
import { clearPendingAuth } from "./pending-auth";
import { invalidateUsage } from "./usage-cache";

export type TAccountCommandResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly account_index?: number;
  readonly duplicate_of?: number;
};

const isProvider = (slug: string): slug is TCliProvider =>
  getDelegate(slug) !== null;

export const addAccount = (
  slug: string,
  label?: string,
  nowMs: number = Date.now(),
): TAccountCommandResult => {
  if (!isProvider(slug)) return { ok: false, error: "unknown provider" };
  let index = DEFAULT_ACCOUNT_INDEX;
  mutateRoster(slug, (roster) => {
    const next = allocateAccount(roster, nowMs, label ?? null);
    index = next.index;
    return next.roster;
  });
  mkdirSync(cliHome(slug, undefined, index), { recursive: true, mode: 0o700 });
  return { ok: true, account_index: index };
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
  if (!readRoster(slug).accounts.some((a) => a.index === index)) {
    return { ok: false, error: "unknown account" };
  }
  const delegate = getDelegate(slug);
  const blocked = runWithAccount(index, () => loginSlot(slug).inFlight());
  if (blocked) {
    return { ok: false, error: "login in progress — cancel it first" };
  }
  if (delegate !== null) {
    // Best-effort vendor sign-out so the CLI revokes the session; the home
    // is deleted either way.
    await runWithAccount(index, () => delegate.logout()).catch(() => undefined);
  }
  runWithAccount(index, () => clearPendingAuth(slug));
  const hash = readRoster(slug).accounts.find(
    (a) => a.index === index,
  )?.account_hash;
  if (hash !== null && hash !== undefined) invalidateUsage(slug, hash);
  mutateRoster(slug, (roster) => removeAccount(roster, index));
  // The whole slot dir: its home AND its per-account config.json.
  rmSync(join(cliAccountsDir(slug), String(index)), {
    recursive: true,
    force: true,
  });
  return { ok: true, account_index: index };
};

export const pinAccountSlot = (
  slug: string,
  index: number | null,
): TAccountCommandResult => {
  if (!isProvider(slug)) return { ok: false, error: "unknown provider" };
  if (
    index !== null &&
    !readRoster(slug).accounts.some((a) => a.index === index)
  ) {
    return { ok: false, error: "unknown account" };
  }
  mutateRoster(slug, (roster) => pinAccount(roster, index));
  return { ok: true, ...(index !== null ? { account_index: index } : {}) };
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
    mutateRoster(slug, (r) => setAccountHash(r, index, hash));
  }
  return { ok: true, account_index: index };
};

/**
 * Delete `accounts/<n>/` dirs whose slot is not in the roster (left by an
 * older build that removed only `home/`, or by a crash mid-removal). Never
 * touches account 0 (`<root>/home`), `bin/`, or a slot still listed.
 */
export const pruneOrphanAccountDirs = (slug: TCliProvider): number => {
  let names: string[];
  try {
    names = readdirSync(cliAccountsDir(slug));
  } catch {
    return 0;
  }
  const live = new Set(readRoster(slug).accounts.map((a) => String(a.index)));
  let pruned = 0;
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name) || live.has(name)) continue;
    rmSync(join(cliAccountsDir(slug), name), { recursive: true, force: true });
    pruned += 1;
  }
  return pruned;
};
