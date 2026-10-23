/**
 * Per-provider account roster (`<stateDir>/cli/<provider>/accounts.json`).
 *
 * Lists the device-local account slots of one subscription provider. Index 0
 * (today's single account at `<root>/home`) always exists, even when the file
 * is missing. A new account takes the LOWEST free index (1, 2, … — no gaps
 * after a removal); removal clears that index's in-memory state first
 * (`account-commands.ts`), and usage is keyed by `account_hash`, so nothing
 * carries over to the account that reuses it.
 * See `docs/plan/multi-account-subscriptions.md` §1.
 */
import { join } from "node:path";
import type { TAccountIndex, TCliProvider } from "./cli-paths";
import { cliRoot, DEFAULT_ACCOUNT_INDEX, isAccountIndex } from "./cli-paths";
import { readJsonStateFile, writeJsonStateAtomic } from "./json-state-cache";

export const ACCOUNT_ROSTER_VERSION = 1;

/** A roster file is a handful of short rows; anything larger is not ours. */
const MAX_ROSTER_BYTES = 64 * 1024;

const MAX_LABEL_LENGTH = 64;

export type TRosterAccount = {
  readonly index: TAccountIndex;
  readonly account_hash: string | null;
  readonly label: string | null;
  readonly created_at_ms: number;
};

export type TAccountRoster = {
  readonly version: number;
  readonly accounts: readonly TRosterAccount[];
  readonly pinned_index: TAccountIndex | null;
};

const defaultAccount = (): TRosterAccount => ({
  index: DEFAULT_ACCOUNT_INDEX,
  account_hash: null,
  label: null,
  created_at_ms: 0,
});

export const emptyRoster = (): TAccountRoster => ({
  version: ACCOUNT_ROSTER_VERSION,
  accounts: [defaultAccount()],
  pinned_index: null,
});

export const accountRosterPath = (
  provider: TCliProvider,
  home?: string,
): string => join(cliRoot(provider, home), "accounts.json");

const parseAccount = (raw: unknown): TRosterAccount | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isAccountIndex(r.index)) return null;
  const hash =
    typeof r.account_hash === "string" && r.account_hash.length > 0
      ? r.account_hash
      : null;
  const label =
    typeof r.label === "string" && r.label.length > 0
      ? r.label.slice(0, MAX_LABEL_LENGTH)
      : null;
  const created =
    typeof r.created_at_ms === "number" && Number.isFinite(r.created_at_ms)
      ? r.created_at_ms
      : 0;
  return { index: r.index, account_hash: hash, label, created_at_ms: created };
};

/**
 * Normalise an untrusted roster: dedupe indexes (first wins), sort ascending,
 * guarantee index 0, and drop a pin that
 * points at no account. Unknown versions fall back to the empty roster rather
 * than guessing at a newer layout.
 */
export const parseRoster = (raw: unknown): TAccountRoster => {
  if (typeof raw !== "object" || raw === null) return emptyRoster();
  const r = raw as Record<string, unknown>;
  if (r.version !== ACCOUNT_ROSTER_VERSION) return emptyRoster();
  const byIndex = new Map<TAccountIndex, TRosterAccount>();
  for (const entry of Array.isArray(r.accounts) ? r.accounts : []) {
    const account = parseAccount(entry);
    if (account !== null && !byIndex.has(account.index)) {
      byIndex.set(account.index, account);
    }
  }
  if (!byIndex.has(DEFAULT_ACCOUNT_INDEX)) {
    byIndex.set(DEFAULT_ACCOUNT_INDEX, defaultAccount());
  }
  const accounts = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const pinned =
    isAccountIndex(r.pinned_index) && byIndex.has(r.pinned_index)
      ? r.pinned_index
      : null;
  return {
    version: ACCOUNT_ROSTER_VERSION,
    accounts,
    pinned_index: pinned,
  };
};

export const readRoster = (
  provider: TCliProvider,
  home?: string,
): TAccountRoster =>
  parseRoster(
    readJsonStateFile(accountRosterPath(provider, home), MAX_ROSTER_BYTES),
  );

export const writeRoster = (
  provider: TCliProvider,
  roster: TAccountRoster,
  home?: string,
): void => {
  writeJsonStateAtomic(
    cliRoot(provider, home),
    accountRosterPath(provider, home),
    roster,
  );
};

/** Read, transform and atomically write back; returns the written roster. */
export const mutateRoster = (
  provider: TCliProvider,
  fn: (roster: TAccountRoster) => TAccountRoster,
  home?: string,
): TAccountRoster => {
  const next = parseRoster(fn(readRoster(provider, home)));
  writeRoster(provider, next, home);
  return next;
};

// ─── pure transforms ────────────────────────────────────────────────

export type TAllocateAccountReturnType = {
  readonly roster: TAccountRoster;
  readonly index: TAccountIndex;
};

/** The lowest index >= 1 not held by a listed slot. */
export const lowestFreeIndex = (roster: TAccountRoster): TAccountIndex => {
  const taken = new Set(roster.accounts.map((a) => a.index));
  let index = DEFAULT_ACCOUNT_INDEX + 1;
  while (taken.has(index)) index += 1;
  return index;
};

/** Add a fresh slot at the lowest free index. */
export const allocateAccount = (
  roster: TAccountRoster,
  nowMs: number,
  label: string | null = null,
): TAllocateAccountReturnType => {
  const index = lowestFreeIndex(roster);
  const account: TRosterAccount = {
    index,
    account_hash: null,
    label: label === null ? null : label.slice(0, MAX_LABEL_LENGTH) || null,
    created_at_ms: nowMs,
  };
  return {
    index,
    roster: {
      ...roster,
      accounts: [...roster.accounts, account].sort((a, b) => a.index - b.index),
    },
  };
};

/** Drop slot `index` (n >= 1 only — account 0 is logged out, never removed).
 *  Clears the pin when it pointed there; the index becomes free for reuse. */
export const removeAccount = (
  roster: TAccountRoster,
  index: TAccountIndex,
): TAccountRoster => {
  if (index === DEFAULT_ACCOUNT_INDEX) return roster;
  return {
    ...roster,
    accounts: roster.accounts.filter((a) => a.index !== index),
    pinned_index: roster.pinned_index === index ? null : roster.pinned_index,
  };
};

/** Pin `index` (or clear with `null`); a pin to an unknown slot is ignored. */
export const pinAccount = (
  roster: TAccountRoster,
  index: TAccountIndex | null,
): TAccountRoster => {
  if (index !== null && !roster.accounts.some((a) => a.index === index)) {
    return roster;
  }
  return { ...roster, pinned_index: index };
};

/** Record the observed vendor identity of a slot. */
export const setAccountHash = (
  roster: TAccountRoster,
  index: TAccountIndex,
  accountHash: string | null,
): TAccountRoster => ({
  ...roster,
  accounts: roster.accounts.map((a) =>
    a.index === index ? { ...a, account_hash: accountHash } : a,
  ),
});

/** Another slot already signed into `accountHash`, if any (duplicate gate). */
export const findDuplicateAccount = (
  roster: TAccountRoster,
  index: TAccountIndex,
  accountHash: string,
): TRosterAccount | undefined =>
  roster.accounts.find(
    (a) => a.index !== index && a.account_hash === accountHash,
  );
