/**
 * Daemon-side device-grant verification.
 *
 * The browser signs grants with a vault-derived Ed25519 key (noble); this
 * module verifies them with node:crypto only — the daemon package must
 * NEVER import `@openllm/vault`. Pin comes from bootstrap
 * (`device_access_pubkey`); when null, seedgate enforcement is off.
 */
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import {
  buildDeviceGrantMessage,
  DEVICE_GRANT_TS_WINDOW_MS,
  decodeDeviceGrant,
} from "@openllmsh/tunnel";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { mutateState, readState } from "./state-file";

/**
 * Hard upper bound on nonces retained for the ts window. Sized for a busy
 * multi-surface open rate (~30 grants/s × 120s window ≈ 3600) with headroom;
 * expiry pruning is the primary retention control. When the map is full of
 * still-valid nonces, new grants are rejected (`nonce_overload`) rather than
 * silently dropping replay protection.
 */
let nonceLruCap = 4096;

/** Module-level nonce LRU — expire after the grant ts window; hard-cap above. */
const nonceOrder: string[] = [];
const nonceSeen = new Map<string, number>();

/** In-memory pin; hydrated from state.json on first read. */
let pinnedPubkey: string | null | undefined;

const hydratePin = (): string | null => {
  if (pinnedPubkey !== undefined) return pinnedPubkey;
  const fromDisk = readState().deviceAccessPubkey;
  pinnedPubkey = fromDisk === undefined ? null : fromDisk;
  return pinnedPubkey;
};

/**
 * Currently pinned device-access SPKI (base64), or null when un-provisioned.
 * Reads through state.json so a restart re-enforces without waiting on poll.
 */
export const getDeviceAccessPubkey = (): string | null => hydratePin();

/**
 * Pin (or clear) the device-access public key. Latest wins. Persists to
 * state.json. Logs a warn when the pinned value actually changes.
 */
export const setDeviceAccessPubkey = (pubkey: string | null): void => {
  const prev = hydratePin();
  if (prev === pubkey) return;
  pinnedPubkey = pubkey;
  mutateState((s) => ({ ...s, deviceAccessPubkey: pubkey }));
  logWarn(
    "device-access",
    safeDiagnosticMessage`device_access_pubkey pin changed`,
    {
      previous: prev === null ? "null" : "set",
      next: pubkey === null ? "null" : "set",
    },
  );
};

/** Test-only: set the pin without state-file I/O or log noise. */
export const setDeviceAccessPubkeyForTest = (pubkey: string | null): void => {
  pinnedPubkey = pubkey;
};

/** Test-only: clear the nonce LRU between cases. */
export const clearDeviceGrantNoncesForTest = (): void => {
  nonceOrder.length = 0;
  nonceSeen.clear();
};

/** Test-only: override the nonce map capacity (null restores default 4096). */
export const setNonceLruCapForTest = (cap: number | null): void => {
  nonceLruCap = cap ?? 4096;
};

/**
 * Verify an Ed25519 signature over `message` with a base64(SPKI) public key.
 * Never throws — any failure (bad b64, bad key, bad sig) returns false.
 */
export const verifyDeviceGrantNode = (
  pubSpkiB64: string,
  message: Uint8Array,
  sigB64: string,
): boolean => {
  try {
    const key = createPublicKey({
      key: Buffer.from(pubSpkiB64, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const sig = Buffer.from(sigB64, "base64");
    return nodeVerify(null, Buffer.from(message), key, sig);
  } catch {
    return false;
  }
};

/**
 * Drop expired nonces. Scans the full order because retention is based on
 * envelope.ts (which may be future-dated within the acceptance window), so
 * expiry is no longer insertion-order monotonic.
 */
const pruneExpiredNonces = (now: number): void => {
  if (nonceOrder.length === 0) return;
  const kept: string[] = [];
  for (const n of nonceOrder) {
    const exp = nonceSeen.get(n);
    if (exp !== undefined && exp >= now) {
      kept.push(n);
      continue;
    }
    nonceSeen.delete(n);
  }
  nonceOrder.length = 0;
  nonceOrder.push(...kept);
};

/**
 * Remember a verified nonce until its envelope can no longer be accepted.
 * Retention is `envelopeTs + WINDOW` so a future-dated grant (still inside
 * the acceptance window) cannot be replayed after a premature prune.
 *
 * Callers MUST `pruneExpiredNonces(now)` before invoking this so capacity
 * checks see a fresh map. Returns false when the map is already full of
 * still-valid nonces — callers must reject with a distinct overload reason
 * rather than silently drop replay protection by evicting unexpired entries.
 */
const rememberNonce = (
  n: string,
  envelopeTs: number,
  _now: number,
): boolean => {
  if (nonceSeen.has(n)) return false;
  if (nonceOrder.length >= nonceLruCap) {
    logWarn(
      "device-access",
      safeDiagnosticMessage`nonce map full; rejecting new grant`,
      {
        cap: nonceLruCap,
      },
    );
    return false;
  }
  nonceSeen.set(n, envelopeTs + DEVICE_GRANT_TS_WINDOW_MS);
  nonceOrder.push(n);
  return true;
};

export type TCheckDeviceGrantExpect = {
  readonly keyId: string;
  readonly cid: string;
  /**
   * When non-empty, envelope.aud must equal this value. An empty envelope.aud
   * is rejected as `aud_unbound` (provisioned mux/tunnel/RTC must bind the
   * grant to the daemon pubkey).
   */
  readonly aud?: string;
};

export type TCheckDeviceGrantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Full grant check: decode → rebuild message → ts window → nonce →
 * key_id/cid/aud → signature against the pinned pubkey.
 */
export const checkDeviceGrant = (
  envelopeB64: string,
  expect: TCheckDeviceGrantExpect,
): TCheckDeviceGrantResult => {
  const pinned = getDeviceAccessPubkey();
  if (pinned === null) {
    return { ok: false, reason: "unprovisioned" };
  }
  const envelope = decodeDeviceGrant(envelopeB64);
  if (envelope === null) {
    return { ok: false, reason: "malformed" };
  }
  const now = Date.now();
  if (Math.abs(now - envelope.ts) > DEVICE_GRANT_TS_WINDOW_MS) {
    return { ok: false, reason: "stale_ts" };
  }
  if (envelope.key_id !== expect.keyId) {
    return { ok: false, reason: "key_id_mismatch" };
  }
  if (envelope.cid !== expect.cid) {
    return { ok: false, reason: "cid_mismatch" };
  }
  // When expect.aud is non-empty, envelope.aud must match. Empty expect.aud
  // is the unit-test / low-level opt-out; production callers go through
  // enforceSeedGate which rejects empty expect.aud before reaching here.
  const expectAud = expect.aud ?? "";
  if (expectAud.length > 0) {
    if (envelope.aud.length === 0) {
      return { ok: false, reason: "aud_unbound" };
    }
    if (envelope.aud !== expectAud) {
      return { ok: false, reason: "aud_mismatch" };
    }
  }
  // Nonce check AFTER identity checks so a wrong-key/cid grant cannot
  // burn a legitimate nonce the browser may still retry with. Only
  // remember the nonce once the signature also verifies.
  pruneExpiredNonces(now);
  if (nonceSeen.has(envelope.n)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  const msg = buildDeviceGrantMessage({
    v: envelope.v,
    n: envelope.n,
    ts: envelope.ts,
    key_id: envelope.key_id,
    cid: envelope.cid,
    aud: envelope.aud,
  });
  if (!verifyDeviceGrantNode(pinned, msg, envelope.sig)) {
    return { ok: false, reason: "bad_sig" };
  }
  // Signature verified — only then admit the nonce. Full map of still-valid
  // nonces rejects rather than evicting (replay protection must not degrade).
  if (!rememberNonce(envelope.n, envelope.ts, now)) {
    return { ok: false, reason: "nonce_overload" };
  }
  return { ok: true };
};

export type TEnforceSeedGateResult =
  | { readonly mode: "reject"; readonly reason: string }
  | { readonly mode: "ok" };

export type TEnforceSeedGateExpect = {
  readonly keyId: string | null;
  readonly cid: string;
  readonly aud: string;
};

/**
 * Single seed-gate decision tree for browser mux / tunnel / RTC.
 * - pin null → reject "unprovisioned"
 * - missing keyId → reject "no_api_key_id"
 * - missing/empty grant → reject "missing_grant"
 * - checkDeviceGrant fail → reject with checked.reason
 * - else ok
 *
 * Fleet daemon-to-daemon mux hops deliberately bypass this browser gate in
 * mux-host: they do not have a browser vault DEK with which to mint a grant.
 *
 * Callers pass `daemonApiKeyId()` / `daemonPublicKey()` so this module stays
 * free of env/keypair imports (no circular deps).
 */
export const enforceSeedGate = (
  grant: string | undefined,
  expect: TEnforceSeedGateExpect,
): TEnforceSeedGateResult => {
  if (getDeviceAccessPubkey() === null) {
    return { mode: "reject", reason: "unprovisioned" };
  }
  if (expect.keyId === null) {
    return { mode: "reject", reason: "no_api_key_id" };
  }
  // Fail closed: an empty expected aud would skip audience binding inside
  // checkDeviceGrant. Production always binds to the daemon pubkey.
  if (expect.aud.length === 0) {
    return { mode: "reject", reason: "aud_unbound" };
  }
  if (grant === undefined || grant.length === 0) {
    return { mode: "reject", reason: "missing_grant" };
  }
  const checked = checkDeviceGrant(grant, {
    keyId: expect.keyId,
    cid: expect.cid,
    aud: expect.aud,
  });
  if (!checked.ok) {
    return { mode: "reject", reason: checked.reason };
  }
  return { mode: "ok" };
};

/**
 * RTC offer seed-gate: require a provisioned pin, offerVersion 2, and a valid
 * nested grant. Unprovisioned daemons fail closed rather than accepting legacy
 * v1 offers. Single entry for the outer pin + v1 branch that previously lived
 * inline in rtc-host.
 */
export const enforceRtcSeedGate = (
  grant: string | undefined,
  expect: TEnforceSeedGateExpect & { readonly offerVersion: number },
): TEnforceSeedGateResult => {
  if (getDeviceAccessPubkey() === null) {
    return { mode: "reject", reason: "unprovisioned" };
  }
  if (expect.offerVersion !== 2) {
    return { mode: "reject", reason: "v1_offer" };
  }
  return enforceSeedGate(grant, expect);
};
