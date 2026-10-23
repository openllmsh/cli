/**
 * Per-account keying for daemon state that used to be keyed by provider slug
 * alone (login slots, pending auth, status memory, observation epochs, …).
 *
 * Keys are scoped with the ambient account ({@link currentAccountIndex}):
 * account 0 keeps the bare slug, so single-account state is byte-identical to
 * before; account n becomes `slug#n`. Scoping is idempotent — an already
 * scoped key passes through unchanged — so a key read back from iteration can
 * be fed into the same map again.
 */
import { stateDir } from "./env";
import { currentAccountIndex } from "./op-context";

export const ACCOUNT_KEY_SEPARATOR = "#";

export const scopedSlug = (slug: string, index?: number): string => {
  if (slug.includes(ACCOUNT_KEY_SEPARATOR)) return slug;
  const i = index ?? currentAccountIndex();
  return i === 0 ? slug : `${slug}${ACCOUNT_KEY_SEPARATOR}${i}`;
};

export type TParsedAccountKey = {
  readonly slug: string;
  readonly index: number;
};

/** Inverse of {@link scopedSlug}. */
export const parseAccountKey = (key: string): TParsedAccountKey => {
  const at = key.indexOf(ACCOUNT_KEY_SEPARATOR);
  if (at < 0) return { slug: key, index: 0 };
  const index = Number(key.slice(at + 1));
  return {
    slug: key.slice(0, at),
    index: Number.isSafeInteger(index) && index >= 0 ? index : 0,
  };
};

/** A slug-keyed Map whose keys are scoped to the ambient account. */
export class AccountKeyedMap<TValue> extends Map<string, TValue> {
  override get(slug: string): TValue | undefined {
    return super.get(scopedSlug(slug));
  }
  override set(slug: string, value: TValue): this {
    return super.set(scopedSlug(slug), value);
  }
  override has(slug: string): boolean {
    return super.has(scopedSlug(slug));
  }
  override delete(slug: string): boolean {
    return super.delete(scopedSlug(slug));
  }
}

/** A slug Set whose members are scoped to the ambient account. */
export class AccountKeyedSet extends Set<string> {
  override add(slug: string): this {
    return super.add(scopedSlug(slug));
  }
  override has(slug: string): boolean {
    return super.has(scopedSlug(slug));
  }
  override delete(slug: string): boolean {
    return super.delete(scopedSlug(slug));
  }
}

/** Like `stateScoped`, but one instance per (state dir, ambient account). */
export const accountScoped = <TState>(make: () => TState): (() => TState) => {
  const byKey = new Map<string, TState>();
  return (): TState => {
    const key = `${stateDir()}\0${currentAccountIndex()}`;
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const next = make();
    byKey.set(key, next);
    return next;
  };
};

/** A mutable cell with one value per ambient account (module `let` singletons
 *  that hold per-credential state, e.g. an in-flight status probe). */
export type TAccountCell<T> = {
  readonly get: () => T;
  readonly set: (value: T) => void;
};

export const accountCell = <T>(initial: () => T): TAccountCell<T> => {
  const values = new Map<number, T>();
  return {
    get: (): T => {
      const index = currentAccountIndex();
      if (values.has(index)) return values.get(index) as T;
      const value = initial();
      values.set(index, value);
      return value;
    },
    set: (value: T): void => {
      values.set(currentAccountIndex(), value);
    },
  };
};
