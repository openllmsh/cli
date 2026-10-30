/**
 * Device-local key slots for `local_key` providers (OpenCode Go, Z.AI GLM
 * Coding Plan, MiniMax Coding Plan).
 *
 * One file per provider at `<stateDir>/local-keys/<slug>.json` (0600, atomic
 * tmp + rename). Each slot is one pasted API key; a provider can hold several
 * (multi-account, like oauth). The key is written only by `set_provider_key`
 * after opening the browser's sealed box, and is never logged or pushed —
 * status carries `key_hint` (last four characters) only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TLocalKeyProviderSlug } from "@openllmsh/protocol";
import {
  isLocalKeyProviderSlug,
  LOCAL_KEY_PROVIDER_PRESETS,
} from "@openllmsh/protocol";
import { stateDir } from "../env";
import { readJsonStateFile, writeJsonStateAtomic } from "../json-state-cache";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 256 * 1024;
/** Vendor keys are well under this; bounds the store size. */
const MAX_KEY_LENGTH = 512;
/** Keys per provider; with MAX_KEY_LENGTH and labels this fits MAX_STORE_BYTES. */
const MAX_SLOTS = 64;
const MAX_LABEL_LENGTH = 64;
/** Same ceiling as `AccountIndex` on the wire. */
const MAX_INDEX = 1023;
const PERSIST_ERROR = "failed to persist provider key";

export type TLocalKeySlot = {
  readonly index: number;
  readonly key: string;
  readonly label: string | null;
  readonly created_at_ms: number;
};

type TLocalKeyStore = {
  readonly version: number;
  readonly slots: readonly TLocalKeySlot[];
};

const storeDir = (home?: string): string => join(stateDir(home), "local-keys");

export const localKeyStorePath = (
  slug: TLocalKeyProviderSlug,
  home?: string,
): string => {
  if (!isLocalKeyProviderSlug(slug)) throw new Error("invalid provider slug");
  return join(storeDir(home), `${slug}.json`);
};

const parseSlot = (raw: unknown): TLocalKeySlot | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.index !== "number" ||
    !Number.isInteger(r.index) ||
    r.index < 0 ||
    r.index > MAX_INDEX
  ) {
    return null;
  }
  if (typeof r.key !== "string" || r.key.trim().length === 0) return null;
  const label =
    typeof r.label === "string" && r.label.length > 0
      ? r.label.slice(0, MAX_LABEL_LENGTH)
      : null;
  const created =
    typeof r.created_at_ms === "number" && Number.isFinite(r.created_at_ms)
      ? r.created_at_ms
      : 0;
  return { index: r.index, key: r.key.trim(), label, created_at_ms: created };
};

/** Untrusted file → slots, deduped by index (first wins), ascending. */
const parseStore = (raw: unknown): readonly TLocalKeySlot[] => {
  if (typeof raw !== "object" || raw === null) return [];
  const slots = (raw as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return [];
  const seen = new Set<number>();
  const out: TLocalKeySlot[] = [];
  for (const entry of slots) {
    const slot = parseSlot(entry);
    if (slot === null || seen.has(slot.index)) continue;
    seen.add(slot.index);
    out.push(slot);
  }
  return out.sort((a, b) => a.index - b.index);
};

/** A store we can safely rewrite: current version and an array of slots. */
const isWellFormedStore = (raw: unknown): boolean =>
  typeof raw === "object" &&
  raw !== null &&
  (raw as { version?: unknown }).version === STORE_VERSION &&
  Array.isArray((raw as { slots?: unknown }).slots);

/** Every stored key slot for `slug`, ascending by index. Never log the keys. */
export const readLocalKeySlots = (
  slug: TLocalKeyProviderSlug,
  home?: string,
): readonly TLocalKeySlot[] =>
  parseStore(readJsonStateFile(localKeyStorePath(slug, home), MAX_STORE_BYTES));

const writeSlots = (
  slug: TLocalKeyProviderSlug,
  slots: readonly TLocalKeySlot[],
  home?: string,
): boolean => {
  const body: TLocalKeyStore = { version: STORE_VERSION, slots };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_STORE_BYTES) return false;
  return writeJsonStateAtomic(
    storeDir(home),
    localKeyStorePath(slug, home),
    body,
  );
};

/** Lowest index not taken by `slots` (0, 1, … — no gaps after a removal). */
const lowestFreeIndex = (slots: readonly TLocalKeySlot[]): number | null => {
  const taken = new Set(slots.map((s) => s.index));
  for (let i = 0; i <= MAX_INDEX; i++) if (!taken.has(i)) return i;
  return null;
};

export type TSetLocalKeySlotResult =
  | { readonly ok: true; readonly index: number | null }
  | { readonly ok: false; readonly error: string };

/**
 * Apply one `set_provider_key`:
 *  - no `index` + key → allocate the lowest free slot,
 *  - `index` + key → replace that slot's key (creating it if missing),
 *  - `index` + empty key → remove that slot.
 * Returns the affected index (null after a removal).
 */
export const setLocalKeySlot = (
  slug: TLocalKeyProviderSlug,
  args: {
    readonly index?: number;
    readonly key: string;
    readonly label?: string;
  },
  home?: string,
): TSetLocalKeySlotResult => {
  if (!isLocalKeyProviderSlug(slug)) {
    return { ok: false, error: "invalid provider slug" };
  }
  if (
    args.index !== undefined &&
    (!Number.isInteger(args.index) || args.index < 0 || args.index > MAX_INDEX)
  ) {
    return { ok: false, error: "invalid account index" };
  }
  const key = args.key.trim();
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "key is too long" };
  }
  // An existing file we cannot load must not be silently replaced.
  const path = localKeyStorePath(slug, home);
  if (
    existsSync(path) &&
    !isWellFormedStore(readJsonStateFile(path, MAX_STORE_BYTES))
  ) {
    return { ok: false, error: "provider key store is unreadable" };
  }
  const slots = readLocalKeySlots(slug, home);
  if (key.length === 0) {
    if (args.index === undefined) {
      return { ok: false, error: "an empty key needs an account_index" };
    }
    if (
      !writeSlots(
        slug,
        slots.filter((s) => s.index !== args.index),
        home,
      )
    ) {
      return { ok: false, error: PERSIST_ERROR };
    }
    return { ok: true, index: null };
  }
  const existing =
    args.index === undefined
      ? undefined
      : slots.find((s) => s.index === args.index);
  if (existing === undefined && slots.length >= MAX_SLOTS) {
    return { ok: false, error: "no free key slot" };
  }
  const index = args.index ?? lowestFreeIndex(slots);
  if (index === null) return { ok: false, error: "no free key slot" };
  const label =
    args.label !== undefined && args.label.trim().length > 0
      ? args.label.trim().slice(0, MAX_LABEL_LENGTH)
      : (existing?.label ?? null);
  const slot: TLocalKeySlot = {
    index,
    key,
    label,
    created_at_ms: existing?.created_at_ms ?? Date.now(),
  };
  if (
    !writeSlots(
      slug,
      [...slots.filter((s) => s.index !== index), slot].sort(
        (a, b) => a.index - b.index,
      ),
      home,
    )
  ) {
    return { ok: false, error: PERSIST_ERROR };
  }
  return { ok: true, index };
};

/** Last four characters of a key — the only part status ever carries.
 *  Empty for keys too short to hide anything (never the whole secret). */
export const keyHintOf = (key: string): string =>
  key.length >= 12 ? key.slice(-4) : "";

/** Every `local_key` provider with at least one stored key slot. */
export const configuredLocalKeyProviders = (
  home?: string,
): readonly TLocalKeyProviderSlug[] =>
  LOCAL_KEY_PROVIDER_PRESETS.map((p) => p.slug).filter(
    (slug) => readLocalKeySlots(slug, home).length > 0,
  );
