/**
 * Per-provider account roster (`<stateDir>/cli/<provider>/accounts.json`).
 *
 * Lists the device-local account slots of one subscription provider. Index 0
 * (today's single account at `<root>/home`) always exists, even when the file
 * is missing. A new account takes the LOWEST free index (1, 2, … — no gaps
 * after a removal). Indexes ARE reused after a removal finishes; while a
 * removal is in flight the index stays reserved via an in-memory tombstone
 * so a concurrent allocate cannot claim it and then have its fresh home
 * deleted. Removal clears that index's in-memory state first
 * (`account-commands.ts`), and usage is keyed by `account_hash`, so nothing
 * carries over to the account that reuses it.
 * See `docs/plan/multi-account-subscriptions.md` §1.
 */
import { existsSync, statSync } from "node:fs";
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

/**
 * On-disk roster state. A missing file is the cold start (account 0 only). An
 * existing but unreadable / oversize / wrong-version file must NOT be treated
 * as empty — prune would delete every `accounts/<n>/` and a write would
 * clobber the corrupt file with account 0 only.
 */
export type TRosterFileStatus =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly roster: TAccountRoster }
  | { readonly status: "invalid"; readonly reason: string };

export const inspectRosterFile = (
  provider: TCliProvider,
  home?: string,
): TRosterFileStatus => {
  const path = accountRosterPath(provider, home);
  if (!existsSync(path)) return { status: "missing" };
  try {
    if (statSync(path).size > MAX_ROSTER_BYTES) {
      return { status: "invalid", reason: "oversize" };
    }
  } catch {
    return { status: "invalid", reason: "unreadable" };
  }
  const raw = readJsonStateFile(path, MAX_ROSTER_BYTES);
  if (raw === null) {
    return { status: "invalid", reason: "unreadable_or_parse" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { status: "invalid", reason: "not_object" };
  }
  if ((raw as { version?: unknown }).version !== ACCOUNT_ROSTER_VERSION) {
    return { status: "invalid", reason: "unknown_version" };
  }
  return { status: "valid", roster: parseRoster(raw) };
};

/** Non-null when `accounts.json` exists but cannot be trusted. */
export const rosterCorruptionReason = (
  provider: TCliProvider,
  home?: string,
): string | null => {
  const inspected = inspectRosterFile(provider, home);
  return inspected.status === "invalid" ? inspected.reason : null;
};

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

// ─── per-provider mutation lock + pending-delete tombstones ─────────

const rosterChains = new Map<string, Promise<unknown>>();
const pendingDeletes = new Map<string, Set<TAccountIndex>>();

const rosterLockKey = (provider: TCliProvider, home?: string): string =>
  home === undefined ? provider : `${provider}\0${home}`;

/**
 * Serialize roster-touching work per provider. Nested calls from the same
 * async chain still queue (not reentrant) — keep critical sections short and
 * call sync helpers inside one lock acquisition.
 */
export const withRosterLock = async <T>(
  provider: TCliProvider,
  fn: () => T | Promise<T>,
  home?: string,
): Promise<T> => {
  const key = rosterLockKey(provider, home);
  const prev = rosterChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  rosterChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

const pendingSetOf = (provider: TCliProvider): Set<TAccountIndex> => {
  const existing = pendingDeletes.get(provider);
  if (existing !== undefined) return existing;
  const created = new Set<TAccountIndex>();
  pendingDeletes.set(provider, created);
  return created;
};

/** Indexes reserved while a removal is mid-flight (dir not gone yet). */
export const pendingDeletesOf = (
  provider: TCliProvider,
): ReadonlySet<TAccountIndex> => pendingSetOf(provider);

export const reservePendingDelete = (
  provider: TCliProvider,
  index: TAccountIndex,
): void => {
  pendingSetOf(provider).add(index);
};

export const releasePendingDelete = (
  provider: TCliProvider,
  index: TAccountIndex,
): void => {
  const set = pendingDeletes.get(provider);
  if (set === undefined) return;
  set.delete(index);
  if (set.size === 0) pendingDeletes.delete(provider);
};

/** Sync read→transform→write. Call only under {@link withRosterLock}. */
export const mutateRosterSync = (
  provider: TCliProvider,
  fn: (roster: TAccountRoster) => TAccountRoster,
  home?: string,
): TAccountRoster => {
  const inspected = inspectRosterFile(provider, home);
  if (inspected.status === "invalid") {
    throw new Error(`account roster corrupt (${inspected.reason})`);
  }
  const current =
    inspected.status === "missing" ? emptyRoster() : inspected.roster;
  const next = parseRoster(fn(current));
  writeRoster(provider, next, home);
  return next;
};

/** Read, transform and atomically write back; returns the written roster. */
export const mutateRoster = (
  provider: TCliProvider,
  fn: (roster: TAccountRoster) => TAccountRoster,
  home?: string,
): Promise<TAccountRoster> =>
  withRosterLock(provider, () => mutateRosterSync(provider, fn, home), home);

// ─── pure transforms ────────────────────────────────────────────────

export type TAllocateAccountReturnType = {
  readonly roster: TAccountRoster;
  readonly index: TAccountIndex;
};

/** The lowest index >= 1 not held by a listed slot or a pending delete. */
export const lowestFreeIndex = (
  roster: TAccountRoster,
  reserved: ReadonlySet<TAccountIndex> = new Set(),
): TAccountIndex => {
  const taken = new Set(roster.accounts.map((a) => a.index));
  for (const index of reserved) taken.add(index);
  let index = DEFAULT_ACCOUNT_INDEX + 1;
  while (taken.has(index)) index += 1;
  return index;
};

/** Add a fresh slot at the lowest free index. */
export const allocateAccount = (
  roster: TAccountRoster,
  nowMs: number,
  label: string | null = null,
  reserved: ReadonlySet<TAccountIndex> = new Set(),
): TAllocateAccountReturnType => {
  const index = lowestFreeIndex(roster, reserved);
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
 *  Clears the pin when it pointed there; the index becomes free for reuse
 *  once any matching pending-delete tombstone is also released. */
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
