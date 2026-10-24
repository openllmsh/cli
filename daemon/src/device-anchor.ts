/**
 * Daemon side of the install-time device trust anchor
 * (`@openllmsh/tunnel` `device-anchor.ts` owns the wire formats).
 *
 * - {@link installDeviceAnchor} — split `sk-llm-<id>.<secret>.<anchor>` on
 *   the last dot, pin the anchor's control key as an ANCHORED pin
 *   (`via: "anchor"`) and keep the anchor in `state.json` (0600). Called by
 *   `openllm daemon anchor` (install.sh, `openllm login`). The anchor is never
 *   written to `.env`, logged, or sent anywhere.
 * - {@link deviceDpkProof} — `HMAC-SHA256(pair_secret, label || key_id ||
 *   dpk)`, published in `DaemonStatus.device_sessions.dpk_proof` so any
 *   browser holding the control seed can trust this daemon's X25519 key.
 * - {@link applyDeviceSessionsCommand} — the control-signed remote
 *   enable / disable (`set_device_sessions`), verified against the anchored
 *   pin; a locked device (`--lock-device-sessions`) refuses a remote enable.
 * - {@link setDeviceSessionsLocal} — `openllm device enable|disable|lock|
 *   unlock`, the local switch that always wins.
 *
 * node:crypto only — the daemon never imports `@openllm/vault`.
 */
import { createHmac } from "node:crypto";
import type { TDeviceSessionsReport } from "@openllmsh/protocol";
import { splitAnchoredApiKey } from "@openllmsh/protocol";
import {
  buildDeviceSessionsCommandMessage,
  buildDpkProofMessage,
  DEVICE_SESSIONS_COMMAND_TS_WINDOW_MS,
  decodeDeviceAnchor,
  decodeDeviceSessionsCommand,
  toB64UrlBytes,
} from "@openllmsh/tunnel";
import {
  deviceKeyFingerprint,
  getDeviceAccessPin,
  isAgentEligiblePin,
  setDeviceAccessPubkey,
  verifyDeviceGrantNode,
} from "./device-access-verify";
import { daemonApiKeyId, parseApiKeyId } from "./env";
import { daemonPublicKey } from "./keypair";
import type { TDeviceSessionsState } from "./state-file";
import { mutateState, readState } from "./state-file";

export type TInstallDeviceAnchorResult =
  | {
      readonly ok: true;
      /** The bare `sk-llm-<id>.<secret>` — the only part a caller may store. */
      readonly key: string;
      readonly keyId: string;
      /** Fingerprint of the pinned control key. */
      readonly controlFingerprint: string;
    }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "no_anchor" | "persist_failed";
    };

const DEFAULT_SESSIONS: TDeviceSessionsState = {
  enabled: false,
  locked: false,
};

/** The persisted remote device-sessions switch (absent = disabled, unlocked). */
export const deviceSessionsState = (): TDeviceSessionsState =>
  readState().deviceSessions ?? DEFAULT_SESSIONS;

/**
 * Accept an anchored key. Pins the anchor's control key as a LOCAL root (it
 * replaces any pin — the user just pasted it) and stores the anchor bound to
 * its key id. Returns the bare key for the caller to save in `.env`.
 */
export const installDeviceAnchor = (
  anchoredKey: string,
): TInstallDeviceAnchorResult => {
  const split = splitAnchoredApiKey(anchoredKey);
  if (split === null) return { ok: false, reason: "malformed" };
  if (split.anchor === null) return { ok: false, reason: "no_anchor" };
  const anchor = decodeDeviceAnchor(split.anchor);
  const keyId = parseApiKeyId(split.key);
  if (anchor === null || keyId === null) {
    return { ok: false, reason: "malformed" };
  }
  const pinned = setDeviceAccessPubkey(anchor.controlPubkey, {
    force: true,
    localVia: "anchor",
    kind: "control",
    log: false,
  });
  anchor.pairSecret.fill(0);
  if (!pinned.ok) return { ok: false, reason: "persist_failed" };
  const anchorText = split.anchor;
  mutateState((s) => ({ ...s, deviceAnchor: { anchor: anchorText, keyId } }));
  const back = readState();
  if (
    back.deviceAnchor?.anchor !== anchorText ||
    back.deviceAccessPubkey !== anchor.controlPubkey ||
    back.deviceAccessPinAnchored !== true
  ) {
    return { ok: false, reason: "persist_failed" };
  }
  return {
    ok: true,
    key: split.key,
    keyId,
    controlFingerprint: deviceKeyFingerprint(anchor.controlPubkey) ?? "",
  };
};

/** HMAC-SHA256 dpk proof under `pairSecret`, base64url (43 chars). */
export const computeDpkProofNode = (
  pairSecret: Uint8Array,
  keyId: string,
  dpk: string,
): string =>
  toB64UrlBytes(
    new Uint8Array(
      createHmac("sha256", Buffer.from(pairSecret))
        .update(buildDpkProofMessage(keyId, dpk))
        .digest(),
    ),
  );

/**
 * This daemon's dpk proof, or null when there is no anchor for the key it
 * runs on (a key swap without a fresh anchor leaves the device unproven).
 */
export const deviceDpkProof = (
  keyId: string | null = daemonApiKeyId(),
  dpk: string = daemonPublicKey(),
): string | null => {
  const record = readState().deviceAnchor;
  if (record === undefined || keyId === null || record.keyId !== keyId) {
    return null;
  }
  const anchor = decodeDeviceAnchor(record.anchor);
  if (anchor === null) return null;
  try {
    return computeDpkProofNode(anchor.pairSecret, keyId, dpk);
  } finally {
    anchor.pairSecret.fill(0);
  }
};

/** `DaemonStatus.device_sessions`. */
export const deviceSessionsReport = (): TDeviceSessionsReport => {
  const sessions = deviceSessionsState();
  const proof = deviceDpkProof();
  return {
    anchored: isAgentEligiblePin(getDeviceAccessPin()),
    enabled: sessions.enabled,
    locked: sessions.locked,
    ...(proof === null ? {} : { dpk_proof: proof }),
  };
};

export type TDeviceSessionsCommandRefusal =
  | "malformed"
  | "key_id_mismatch"
  | "device_not_anchored"
  | "stale_ts"
  | "replayed"
  | "bad_sig"
  | "device_sessions_locked"
  | "persist_failed";

export type TApplyDeviceSessionsCommandResult =
  | { readonly ok: true; readonly enabled: boolean; readonly changed: boolean }
  | { readonly ok: false; readonly reason: TDeviceSessionsCommandRefusal };

/**
 * Verify and apply one signed `{ v, key_id, enable, ts, nonce }` statement.
 * Requires an ANCHORED control pin (a cloud-chosen pin could be the cloud's
 * own key), this daemon's key id, a fresh `ts` greater than the last accepted
 * one (replay), and a signature by the pinned key. A locked device refuses a
 * remote enable; a remote DISABLE is always honoured.
 */
export const applyDeviceSessionsCommand = (
  encoded: string,
  now: number = Date.now(),
): TApplyDeviceSessionsCommandResult => {
  const command = decodeDeviceSessionsCommand(encoded);
  if (command === null) return { ok: false, reason: "malformed" };
  const keyId = daemonApiKeyId();
  if (keyId === null || command.key_id !== keyId) {
    return { ok: false, reason: "key_id_mismatch" };
  }
  const pin = getDeviceAccessPin();
  if (pin === null || !isAgentEligiblePin(pin)) {
    return { ok: false, reason: "device_not_anchored" };
  }
  if (Math.abs(now - command.ts) > DEVICE_SESSIONS_COMMAND_TS_WINDOW_MS) {
    return { ok: false, reason: "stale_ts" };
  }
  const current = deviceSessionsState();
  if (
    current.lastCommandTs !== undefined &&
    command.ts <= current.lastCommandTs
  ) {
    return { ok: false, reason: "replayed" };
  }
  if (
    !verifyDeviceGrantNode(
      pin.pubkey,
      buildDeviceSessionsCommandMessage(command),
      command.sig,
    )
  ) {
    return { ok: false, reason: "bad_sig" };
  }
  if (command.enable && current.locked) {
    return { ok: false, reason: "device_sessions_locked" };
  }
  const next: TDeviceSessionsState = {
    enabled: command.enable,
    locked: current.locked,
    lastCommandTs: command.ts,
  };
  mutateState((s) => ({ ...s, deviceSessions: next }));
  const back = deviceSessionsState();
  if (back.enabled !== next.enabled || back.lastCommandTs !== command.ts) {
    return { ok: false, reason: "persist_failed" };
  }
  return {
    ok: true,
    enabled: next.enabled,
    changed: current.enabled !== next.enabled,
  };
};

/**
 * The local switch (`openllm device enable|disable|lock|unlock`). Local
 * always wins: it may enable a locked device. Returns the persisted state, or
 * null when the write did not stick.
 */
export const setDeviceSessionsLocal = (change: {
  readonly enabled?: boolean;
  readonly locked?: boolean;
}): TDeviceSessionsState | null => {
  const current = deviceSessionsState();
  const next: TDeviceSessionsState = {
    enabled: change.enabled ?? current.enabled,
    locked: change.locked ?? current.locked,
    ...(current.lastCommandTs === undefined
      ? {}
      : { lastCommandTs: current.lastCommandTs }),
  };
  mutateState((s) => ({ ...s, deviceSessions: next }));
  const back = deviceSessionsState();
  return back.enabled === next.enabled && back.locked === next.locked
    ? back
    : null;
};
