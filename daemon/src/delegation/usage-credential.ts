/**
 * Shared usage-credential policy: stored token unless the manual ALS is set.
 */
import {
  expectedUsageAccountHash,
  usageNativeRefreshAllowed,
} from "../op-context";
import { accountHash, usageAccountChanged } from "./account-id";

export type TUsageStored<T> =
  | { readonly kind: "live"; readonly value: T }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

export type TUsageResolved<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string };

const hashAccount = (provider: string, rawId: string | null): string | null =>
  rawId === null ? null : accountHash(provider, rawId);

/**
 * Resolve the credential usage() may send. Default is the live stored token.
 * Manual Refresh-usage (`usageNativeRefreshAllowed`) may call `readNative`
 * (typically the existing `readToken`).
 *
 * Identity: a known prior/expected account must still be present after
 * renewal. A missing next id is a change (do not seed a known cache bucket
 * with unverifiable data). When the status snapshot supplied an expected
 * `account_hash`, the native result must hash to that value.
 */
export const resolveUsageCredential = async <T>(opts: {
  readonly provider: string;
  readonly stored: TUsageStored<T>;
  readonly missingReason: string;
  readonly readNative: () => Promise<T | null>;
  readonly accountIdOf: (value: T) => string | null | Promise<string | null>;
  readonly priorAccountIdWhenExpired?: () => Promise<string | null>;
}): Promise<TUsageResolved<T>> => {
  const nativeAllowed = usageNativeRefreshAllowed();
  if (opts.stored.kind === "missing") {
    return { kind: "unavailable", reason: opts.missingReason };
  }
  if (opts.stored.kind === "expired" && !nativeAllowed) {
    return { kind: "unavailable", reason: "credential_expired" };
  }
  if (opts.stored.kind === "live" && !nativeAllowed) {
    return { kind: "ok", value: opts.stored.value };
  }
  const priorId =
    opts.stored.kind === "live"
      ? await opts.accountIdOf(opts.stored.value)
      : opts.priorAccountIdWhenExpired === undefined
        ? null
        : await opts.priorAccountIdWhenExpired();
  const native = await opts.readNative();
  if (native === null) {
    return {
      kind: "unavailable",
      reason:
        opts.stored.kind === "expired"
          ? "credential_expired"
          : opts.missingReason,
    };
  }
  const nextId = await opts.accountIdOf(native);
  const expectedHash = expectedUsageAccountHash();
  const nextHash = hashAccount(opts.provider, nextId);
  if (expectedHash !== undefined && expectedHash.length > 0) {
    if (nextHash === null || nextHash !== expectedHash) {
      return { kind: "unavailable", reason: "account_changed" };
    }
  } else if (usageAccountChanged(priorId, nextId)) {
    return { kind: "unavailable", reason: "account_changed" };
  }
  return { kind: "ok", value: native };
};
