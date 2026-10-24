/**
 * Daemon-side device-grant verification.
 *
 * The browser signs grants with the account DEVICE-CONTROL key — Ed25519,
 * derived from the recovery phrase and never from the DEK, so a compromised
 * cloud that unwraps the DEK cannot sign. This module verifies with
 * node:crypto only — the daemon package must NEVER import `@openllm/vault`,
 * and the daemon never holds DEK material. The pin comes from bootstrap
 * (`device_access_pubkey`); when null, seedgate enforcement is off.
 *
 * Pin rules ({@link TDeviceAccessVerify.setDeviceAccessPubkey}). A pin is
 * ANCHORED (agent-eligible) only when it comes from a local trust root:
 * - the install-time anchor (`sk-llm-<id>.<secret>.<anchor>`, split off by
 *   install.sh / `openllm login` — `via: "anchor"`, see `device-anchor.ts`);
 * - a local confirmation of an exact key (the desktop app over loopback, tests
 *   — `{ force: true }`) — `via: "local"`;
 * - a v2 rotation chain signed by the CURRENTLY pinned control key, starting
 *   from an anchored pin (`via: "rotation"`; anchoring is inherited, never
 *   gained).
 *
 * The cloud can only ever produce an UNANCHORED pin: an unpinned daemon still
 * trust-on-first-use pins bootstrap's key (`via: "tofu"`), which serves `/v1`,
 * tunnel and realtime (RTC grant checks) and nothing else. Agent streams
 * (`requireDpk`) refuse an unanchored or legacy pin with `device_not_anchored`
 * and a disabled device-sessions switch with `device_sessions_disabled`. A
 * legacy (DEK-derived) pin is never upgraded by the cloud, and an established
 * pin never moves except along a signed rotation chain or a local root.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import {
  buildDeviceControlRotationMessage,
  buildDeviceGrantMessage,
  DEVICE_CONTROL_ROTATION_CHAIN_MAX,
  DEVICE_GRANT_TS_WINDOW_MS,
  decodeDeviceControlRotation,
  decodeDeviceGrant,
  formatKeyFingerprint,
} from "@openllmsh/tunnel";
import { daemonPublicKey } from "./keypair";
import { logWarn, safeDiagnosticMessage } from "./logger";
import type { TDeviceAccessPinVia } from "./state-file";
import { mutateState, readState } from "./state-file";

const DEFAULT_NONCE_LRU_CAP = 4096;

/** True when `value` is a base64 SPKI DER Ed25519 public key. */
export const isEd25519SpkiB64 = (value: string): boolean => {
  if (value.length === 0) return false;
  try {
    return (
      createPublicKey({
        key: Buffer.from(value, "base64"),
        format: "der",
        type: "spki",
      }).asymmetricKeyType === "ed25519"
    );
  } catch {
    return false;
  }
};

export type TSetDeviceAccessPubkeyResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly reason: "tofu_mismatch" | "bad_rotation";
    };

/** The pinned key plus how it got there. */
export type TDeviceAccessPin = {
  readonly pubkey: string;
  /** `control` = account device-control key; `legacy` = pre-control pin. */
  readonly kind: "control" | "legacy";
  readonly version: number | null;
  readonly via: TDeviceAccessPinVia | null;
  /**
   * Descends from a local trust root (install anchor / loopback), the only
   * kind of pin that authorises agent sessions — see {@link isAgentEligiblePin}.
   */
  readonly anchored: boolean;
};

/**
 * The one agent-eligibility rule for a pin: an ANCHORED device-control pin.
 * A cloud-chosen (first-use) or legacy (DEK-derived) pin never qualifies.
 */
export const isAgentEligiblePin = (pin: TDeviceAccessPin | null): boolean =>
  pin !== null && pin.kind === "control" && pin.anchored;

/** Reasons agent streams are refused before any grant is examined. */
export const AGENT_PIN_REFUSALS = [
  "device_not_anchored",
  "device_sessions_disabled",
] as const;

/** Parse `OPENLLM_DEVICE_GRANT_NONCE_CAP`; `null` when unset/invalid. */
export const parseDeviceGrantNonceCapEnv = (
  raw: string | undefined = process.env.OPENLLM_DEVICE_GRANT_NONCE_CAP,
): number | null => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
};

export type TSetDeviceAccessPubkeyOptions = {
  /** Persist to state.json (default true). */
  readonly persist?: boolean;
  /** Emit change warn log (default true). */
  readonly log?: boolean;
  /**
   * Local confirmation of exactly `pubkey` (the install anchor, the desktop
   * app over loopback, tests). Pins an ANCHORED control pin. Never set on a
   * cloud-delivered value.
   */
  readonly force?: boolean;
  /** Recorded `via` for a forced pin; default `"local"`. */
  readonly localVia?: "anchor" | "local";
  /**
   * `"control"` when the cloud says `pubkey` is the account device-control key
   * (`bootstrap.device_access_kind`). Only labels a first-use (unanchored)
   * pin; it never upgrades an existing legacy pin and never anchors.
   */
  readonly kind?: "control";
  /** `bootstrap.device_access_version` — the control key's generation. */
  readonly version?: number | null;
  /**
   * `bootstrap.device_access_rotations` — base64 statements, oldest first,
   * each signed by the key it replaces. Walked from the current control pin;
   * the move is accepted only if the chain ends exactly at `pubkey`.
   */
  readonly rotations?: readonly string[];
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
  /**
   * Refuse a grant that carries no `dpk` (`dpk_missing`). Set for agent
   * streams over the relay mux, where `dpk` is the Noise_IK responder key.
   * A grant that DOES carry `dpk` is always checked against this daemon's
   * own key, whether or not this is set.
   */
  readonly requireDpk?: boolean;
};

export type TCheckDeviceGrantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type TEnforceSeedGateResult =
  | { readonly mode: "reject"; readonly reason: string }
  | { readonly mode: "ok" };

export type TEnforceSeedGateExpect = {
  readonly keyId: string | null;
  readonly cid: string;
  readonly aud: string;
  /** See {@link TCheckDeviceGrantExpect.requireDpk}. */
  readonly requireDpk?: boolean;
};

export type TDeviceAccessVerifyDeps = {
  /** Hard upper bound on nonces retained for the ts window. Sized for a busy
   *  multi-surface open rate (~30 grants/s × 120s window ≈ 3600) with
   *  headroom; expiry pruning is the primary retention control. */
  readonly nonceLruCap?: number;
  /**
   * This daemon's own X25519 pubkey (SPKI DER, base64) — the
   * `DaemonStatus.pubkey` a grant's `dpk` must equal. Defaults to
   * {@link daemonPublicKey}; read only when a grant carries `dpk`.
   */
  readonly ownPublicKey?: () => string;
  /**
   * Whether remote device (agent) sessions are switched on. Defaults to the
   * persisted switch (`state.json` `deviceSessions`, read fresh so a local
   * `openllm device enable|disable` reaches a running daemon).
   */
  readonly deviceSessionsEnabled?: () => boolean;
};

export type TDeviceAccessVerify = {
  readonly getDeviceAccessPubkey: () => string | null;
  readonly getDeviceAccessPin: () => TDeviceAccessPin | null;
  readonly setDeviceAccessPubkey: (
    pubkey: string | null,
    options?: TSetDeviceAccessPubkeyOptions,
  ) => TSetDeviceAccessPubkeyResult;
  readonly checkDeviceGrant: (
    envelopeB64: string,
    expect: TCheckDeviceGrantExpect,
  ) => TCheckDeviceGrantResult;
  readonly enforceSeedGate: (
    grant: string | undefined,
    expect: TEnforceSeedGateExpect,
  ) => TEnforceSeedGateResult;
  readonly enforceRtcSeedGate: (
    grant: string | undefined,
    expect: TEnforceSeedGateExpect & { readonly offerVersion: number },
  ) => TEnforceSeedGateResult;
  /** Null when agent sessions may run now, else the refusal reason. */
  readonly agentRefusal: () => (typeof AGENT_PIN_REFUSALS)[number] | null;
  /** Drop the in-memory pin so the next read re-hydrates from disk. */
  readonly invalidatePin: () => void;
};

/** The persisted remote device-sessions switch (default disabled). */
export const persistedDeviceSessionsEnabled = (): boolean =>
  readState().deviceSessions?.enabled === true;

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
 * Walk `rotations` (oldest first) from the pinned control key towards
 * `target`. A step applies only when its `old` equals the current key, its
 * signature verifies under that key, and its `cv` exceeds the current version
 * (when known); anything else is skipped — an injected junk statement cannot
 * move the pin, only fail to. Returns the final generation when the chain
 * lands exactly on `target`, else null. Never throws.
 */
export const walkDeviceControlRotations = (
  pinned: { readonly pubkey: string; readonly version: number | null },
  rotations: readonly string[],
  target: string,
): { readonly version: number } | null => {
  let current = pinned.pubkey;
  let version = pinned.version;
  for (const encoded of rotations.slice(0, DEVICE_CONTROL_ROTATION_CHAIN_MAX)) {
    const statement = decodeDeviceControlRotation(encoded);
    if (statement === null || statement.old !== current) continue;
    if (version !== null && statement.cv <= version) continue;
    const msg = buildDeviceControlRotationMessage(statement);
    if (!verifyDeviceGrantNode(current, msg, statement.sig)) continue;
    current = statement.new;
    version = statement.cv;
    if (current === target) return { version };
  }
  return null;
};

/**
 * Fingerprint of a base64 SPKI key in the shared `keyFingerprint` format
 * (`@openllmsh/tunnel`), computed synchronously. Null when not base64.
 */
export const deviceKeyFingerprint = (spkiB64: string): string | null => {
  const der = Buffer.from(spkiB64, "base64");
  if (der.length === 0) return null;
  return formatKeyFingerprint(
    new Uint8Array(createHash("sha256").update(der).digest()),
  );
};

/** Build a device-access verifier (pin + replay-nonce state own instance). */
export const createDeviceAccessVerify = (
  deps: TDeviceAccessVerifyDeps = {},
): TDeviceAccessVerify => {
  const nonceLruCap = deps.nonceLruCap ?? DEFAULT_NONCE_LRU_CAP;
  // Deferred reference: this module sits inside an import cycle with
  // keypair/env, so the binding may not be initialised at module load.
  const ownPublicKey = deps.ownPublicKey ?? ((): string => daemonPublicKey());
  const sessionsEnabled =
    deps.deviceSessionsEnabled ?? persistedDeviceSessionsEnabled;
  /** Nonce LRU — expire after the grant ts window; hard-cap above. */
  const nonceOrder: string[] = [];
  const nonceSeen = new Map<string, number>();
  /** In-memory pin; hydrated from state.json on first read. */
  let pinned: TDeviceAccessPin | null | undefined;
  /** The on-disk pubkey this instance last read or wrote (CAS for persist). */
  let diskPubkey: string | null | undefined;

  const hydrate = (): TDeviceAccessPin | null => {
    if (pinned !== undefined) return pinned;
    const state = readState();
    const pubkey = state.deviceAccessPubkey;
    diskPubkey = pubkey ?? null;
    pinned =
      typeof pubkey === "string"
        ? {
            pubkey,
            kind:
              state.deviceAccessPinKind === "control" ? "control" : "legacy",
            version: state.deviceAccessPinVersion ?? null,
            via: state.deviceAccessPinVia ?? null,
            anchored:
              state.deviceAccessPinAnchored === true &&
              state.deviceAccessPinKind === "control",
          }
        : null;
    return pinned;
  };

  const invalidatePin = (): void => {
    pinned = undefined;
    diskPubkey = undefined;
  };

  const hydratePin = (): string | null => hydrate()?.pubkey ?? null;

  const getDeviceAccessPin = (): TDeviceAccessPin | null => hydrate();

  /**
   * Persist `next`. Compare-and-swap against the on-disk pin this instance
   * last saw: when another process (install.sh / `openllm login` writing the
   * anchor) replaced an anchored pin underneath a running daemon, a stale
   * in-memory decision must not overwrite it — the write is skipped and the
   * next read re-hydrates. A forced (local) pin always writes.
   */
  const persistPin = (next: TDeviceAccessPin | null, force: boolean): void => {
    let raced = false;
    mutateState((s) => {
      const onDisk = s.deviceAccessPubkey ?? null;
      if (
        !force &&
        diskPubkey !== undefined &&
        onDisk !== diskPubkey &&
        s.deviceAccessPinAnchored === true
      ) {
        raced = true;
        return s;
      }
      const {
        deviceAccessPubkey: _p,
        deviceAccessPinKind: _k,
        deviceAccessPinVersion: _v,
        deviceAccessPinVia: _via,
        deviceAccessPinAnchored: _a,
        ...rest
      } = s;
      if (next === null) return { ...rest, deviceAccessPubkey: null };
      return {
        ...rest,
        deviceAccessPubkey: next.pubkey,
        ...(next.kind === "control"
          ? { deviceAccessPinKind: "control" as const }
          : {}),
        ...(next.version === null
          ? {}
          : { deviceAccessPinVersion: next.version }),
        ...(next.via === null ? {} : { deviceAccessPinVia: next.via }),
        ...(next.anchored && next.kind === "control"
          ? { deviceAccessPinAnchored: true as const }
          : {}),
      };
    });
    if (raced) invalidatePin();
    else diskPubkey = next?.pubkey ?? null;
  };

  const getDeviceAccessPubkey = (): string | null => hydratePin();

  const clearDeviceGrantNonces = (): void => {
    nonceOrder.length = 0;
    nonceSeen.clear();
  };

  const validVersion = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;

  const setDeviceAccessPubkey = (
    pubkey: string | null,
    options?: TSetDeviceAccessPubkeyOptions,
  ): TSetDeviceAccessPubkeyResult => {
    const persist = options?.persist !== false;
    const log = options?.log !== false;
    const prevPin = hydrate();
    const prev = prevPin?.pubkey ?? null;
    // A LOCAL confirmation names the key: `force` (the install anchor, the
    // desktop app over loopback, tests).
    const local = options?.force === true;
    const localVia: TDeviceAccessPinVia = options?.localVia ?? "local";

    if (prev === pubkey) {
      // A local confirmation of the key already pinned anchors it. The cloud
      // alone can never relabel or anchor a pin.
      if (
        local &&
        prevPin !== null &&
        (prevPin.kind !== "control" || !prevPin.anchored)
      ) {
        const next: TDeviceAccessPin = {
          pubkey: prevPin.pubkey,
          kind: "control",
          version: validVersion(options?.version) ?? prevPin.version,
          via: localVia,
          anchored: true,
        };
        pinned = next;
        if (persist) persistPin(next, true);
        return { ok: true, changed: true };
      }
      return { ok: true, changed: false };
    }

    const incomingControl = options?.kind === "control";
    let next: TDeviceAccessPin | null | undefined;
    let rotationAttempted = false;
    if (local) {
      next =
        pubkey === null
          ? null
          : {
              pubkey,
              kind: "control",
              version: validVersion(options?.version),
              via: localVia,
              anchored: true,
            };
    } else if (pubkey === null) {
      // Never clears a pin: a cloud-sent null would silently drop enforcement.
      next = undefined;
    } else if (prevPin === null) {
      // First use: pin the cloud's key, but UNANCHORED — it authorises the RTC
      // tunnel rung only, never agent sessions.
      next = {
        pubkey,
        kind: incomingControl ? "control" : "legacy",
        version: incomingControl ? validVersion(options?.version) : null,
        via: "tofu",
        anchored: false,
      };
    } else if (prevPin.kind === "control" && options?.rotations !== undefined) {
      rotationAttempted = options.rotations.length > 0;
      const walked = walkDeviceControlRotations(
        { pubkey: prevPin.pubkey, version: prevPin.version },
        options.rotations,
        pubkey,
      );
      next =
        walked === null
          ? undefined
          : {
              pubkey,
              kind: "control",
              version: walked.version,
              via: "rotation",
              // Inherited: a chain from a first-use pin stays unanchored.
              anchored: prevPin.anchored,
            };
    }

    if (next === undefined) {
      const reason = rotationAttempted ? "bad_rotation" : "tofu_mismatch";
      if (log) {
        logWarn(
          "device-access",
          safeDiagnosticMessage`device_access_pubkey pin rejected`,
          {
            previous: prevPin === null ? "null" : prevPin.kind,
            next:
              pubkey === null ? "null" : incomingControl ? "control" : "set",
            reason,
          },
        );
      }
      return { ok: false, reason };
    }

    pinned = next;
    // Prior-pin grants must not replay against the new pin.
    clearDeviceGrantNonces();
    if (persist) persistPin(next, local);
    if (log) {
      logWarn(
        "device-access",
        safeDiagnosticMessage`device_access_pubkey pin changed`,
        {
          previous: prevPin === null ? "null" : prevPin.kind,
          next: next === null ? "null" : next.kind,
          via: next === null ? "local" : (next.via ?? "local"),
        },
      );
    }
    return { ok: true, changed: true };
  };

  const agentRefusal = (): (typeof AGENT_PIN_REFUSALS)[number] | null => {
    if (!isAgentEligiblePin(hydrate())) return "device_not_anchored";
    return sessionsEnabled() ? null : "device_sessions_disabled";
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
  const rememberNonce = (n: string, envelopeTs: number): boolean => {
    if (nonceSeen.has(n)) return false;
    if (nonceOrder.length >= nonceLruCap) {
      logWarn(
        "device-access",
        safeDiagnosticMessage`nonce map full; rejecting new grant`,
        { cap: nonceLruCap },
      );
      return false;
    }
    nonceSeen.set(n, envelopeTs + DEVICE_GRANT_TS_WINDOW_MS);
    nonceOrder.push(n);
    return true;
  };

  /**
   * Full grant check: decode → rebuild message → ts window → nonce →
   * key_id/cid/aud/dpk → signature against the pinned pubkey.
   */
  const checkDeviceGrant = (
    envelopeB64: string,
    expect: TCheckDeviceGrantExpect,
  ): TCheckDeviceGrantResult => {
    const pin = hydrate();
    if (pin === null) {
      return { ok: false, reason: "unprovisioned" };
    }
    // Agent streams trust `dpk` end to end. A pin the cloud chose (first use)
    // or could sign with (legacy) never authorises them, nor does a switched
    // off device. Both checks run BEFORE the nonce is spent, so an RTC offer
    // can still retry the same grant as a tunnel-only session.
    if (expect.requireDpk === true) {
      const refused = agentRefusal();
      if (refused !== null) return { ok: false, reason: refused };
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
    // `dpk` is the key the signer trusts for this daemon (control-signed
    // attestation) and the Noise_IK responder key on the relay mux. A grant meant
    // for another daemon key must never be admitted, even when signed.
    if (envelope.dpk === undefined) {
      if (expect.requireDpk === true) {
        return { ok: false, reason: "dpk_missing" };
      }
    } else if (envelope.dpk !== ownPublicKey()) {
      return { ok: false, reason: "dpk_mismatch" };
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
      ...(envelope.dpk === undefined ? {} : { dpk: envelope.dpk }),
    });
    if (!verifyDeviceGrantNode(pin.pubkey, msg, envelope.sig)) {
      return { ok: false, reason: "bad_sig" };
    }
    // Signature verified — only then admit the nonce. Full map of still-valid
    // nonces rejects rather than evicting (replay protection must not degrade).
    if (!rememberNonce(envelope.n, envelope.ts)) {
      return { ok: false, reason: "nonce_overload" };
    }
    return { ok: true };
  };

  /**
   * Single seed-gate decision tree for browser mux / tunnel / RTC.
   * - pin null → reject "unprovisioned"
   * - missing keyId → reject "no_api_key_id"
   * - missing/empty grant → reject "missing_grant"
   * - checkDeviceGrant fail → reject with checked.reason (incl.
   *   `device_not_anchored` / `device_sessions_disabled` under `requireDpk`)
   * - else ok
   *
   * Fleet daemon-to-daemon mux hops deliberately bypass this browser gate in
   * mux-host: they do not hold the device-control key with which to mint a
   * grant.
   */
  const enforceSeedGate = (
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
      ...(expect.requireDpk === undefined
        ? {}
        : { requireDpk: expect.requireDpk }),
    });
    if (!checked.ok) {
      return { mode: "reject", reason: checked.reason };
    }
    return { mode: "ok" };
  };

  /**
   * RTC offer seed-gate: require a provisioned pin, offerVersion 2, and a
   * valid nested grant. Unprovisioned daemons fail closed rather than
   * accepting legacy v1 offers.
   */
  const enforceRtcSeedGate = (
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

  return {
    getDeviceAccessPubkey,
    getDeviceAccessPin,
    setDeviceAccessPubkey,
    checkDeviceGrant,
    enforceSeedGate,
    enforceRtcSeedGate,
    agentRefusal,
    invalidatePin,
  };
};

const active: TDeviceAccessVerify = createDeviceAccessVerify({
  nonceLruCap: parseDeviceGrantNonceCapEnv() ?? DEFAULT_NONCE_LRU_CAP,
});

export const getDeviceAccessPubkey = (): string | null =>
  active.getDeviceAccessPubkey();

export const getDeviceAccessPin = (): TDeviceAccessPin | null =>
  active.getDeviceAccessPin();

export const setDeviceAccessPubkey = (
  pubkey: string | null,
  options?: TSetDeviceAccessPubkeyOptions,
): TSetDeviceAccessPubkeyResult =>
  active.setDeviceAccessPubkey(pubkey, options);

/** Null when agent sessions may run now, else the refusal reason. */
export const agentSessionRefusal = ():
  | (typeof AGENT_PIN_REFUSALS)[number]
  | null => active.agentRefusal();

/** Re-read the pin from disk on next use (after another process wrote it). */
export const invalidateDeviceAccessPin = (): void => active.invalidatePin();

export const checkDeviceGrant = (
  envelopeB64: string,
  expect: TCheckDeviceGrantExpect,
): TCheckDeviceGrantResult => active.checkDeviceGrant(envelopeB64, expect);

export const enforceSeedGate = (
  grant: string | undefined,
  expect: TEnforceSeedGateExpect,
): TEnforceSeedGateResult => active.enforceSeedGate(grant, expect);

export const enforceRtcSeedGate = (
  grant: string | undefined,
  expect: TEnforceSeedGateExpect & { readonly offerVersion: number },
): TEnforceSeedGateResult => active.enforceRtcSeedGate(grant, expect);
