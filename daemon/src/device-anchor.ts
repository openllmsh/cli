/**
 * Daemon side of the install-time device trust anchor
 * (`@openllmsh/tunnel` `device-anchor.ts` owns the wire formats).
 *
 * - {@link installDeviceAnchor} — split `sk-llm-<id>.<secret>.<anchor>` on
 *   the last dot and write `OPENLLM_API_KEY=<bare>` plus
 *   `OPENLLM_DEVICE_ANCHOR=<anchor>` to the runtime's env file (0600; `.env`,
 *   or `.dev.env` in dev). Called by `openllm daemon anchor` (install.sh,
 *   `openllm login`). Nothing about the anchor goes to `state.json`: the pin
 *   (`via: "anchor"`) is DERIVED from the env file at every hydrate — see
 *   `device-access-verify.ts`. The anchor never enters `process.env`, a child
 *   env, a vendor config, a log, or the network. Re-running install/update
 *   with a new anchor is the rotation path.
 * - {@link removeDeviceAnchor} — blank `OPENLLM_DEVICE_ANCHOR` (sessions off).
 *   Used by `openllm daemon device disable`, the desktop loopback remove, and
 *   the control-signed remote disable.
 * - {@link deviceDpkProof} — `HMAC-SHA256(pair_secret, label || key_id ||
 *   dpk)`, published in `DaemonStatus.device_sessions.dpk_proof` so any
 *   browser holding the control seed can trust this daemon's X25519 key.
 * - {@link applyDeviceSessionsDisable} — the control-signed remote disable
 *   (`set_device_sessions`), verified against the anchored pin, then
 *   {@link removeDeviceAnchor}.
 *
 * Sessions on == the anchor is present. There is no separate enabled flag and
 * no remote enable — re-enable writes the anchor again.
 *
 * node:crypto only — the daemon never imports `@openllm/vault`.
 */
import { createHmac } from "node:crypto";
import type { TDeviceSessionsReport } from "@openllmsh/protocol";
import { splitAnchoredApiKey } from "@openllmsh/protocol";
import {
  buildDeviceSessionsDisableMessage,
  buildDpkProofMessage,
  DEVICE_SESSIONS_DISABLE_TS_WINDOW_MS,
  decodeDeviceAnchor,
  decodeDeviceSessionsDisable,
  toB64UrlBytes,
} from "@openllmsh/tunnel";
import {
  deviceKeyFingerprint,
  getDeviceAccessPin,
  invalidateDeviceAccessPin,
  isAgentEligiblePin,
  verifyDeviceGrantNode,
} from "./device-access-verify";
import {
  applyPersistedApiKey,
  DEVICE_ANCHOR_ENV,
  daemonApiKeyId,
  deviceAnchorFromEnvFile,
  envFilePath,
  envFileValue,
  parseApiKeyId,
  writeEnvFileVars,
} from "./env";
import { daemonPublicKey } from "./keypair";

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

/**
 * Accept an anchored key: write the bare key and the anchor as two lines of
 * the runtime env file, then re-read the pin (derived from that file) to
 * confirm it is the anchor's control key. Returns the bare key.
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
  const controlPubkey = anchor.controlPubkey;
  anchor.pairSecret.fill(0);
  if (
    !writeEnvFileVars(
      { OPENLLM_API_KEY: split.key, [DEVICE_ANCHOR_ENV]: split.anchor },
      envFilePath(),
    )
  ) {
    return { ok: false, reason: "persist_failed" };
  }
  applyPersistedApiKey(split.key);
  invalidateDeviceAccessPin();
  const pin = getDeviceAccessPin();
  if (pin?.pubkey !== controlPubkey || pin.via !== "anchor") {
    return { ok: false, reason: "persist_failed" };
  }
  return {
    ok: true,
    key: split.key,
    keyId,
    controlFingerprint: deviceKeyFingerprint(controlPubkey) ?? "",
  };
};

export type TRemoveDeviceAnchorResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "persist_failed" };

/**
 * Blank `OPENLLM_DEVICE_ANCHOR` in the runtime env file and drop the derived
 * pin. Idempotent when already absent. Sessions off == no anchor.
 */
export const removeDeviceAnchor = (): TRemoveDeviceAnchorResult => {
  const had = deviceAnchorFromEnvFile() !== null;
  if (!had) {
    invalidateDeviceAccessPin();
    return { ok: true, changed: false };
  }
  if (!writeEnvFileVars({ [DEVICE_ANCHOR_ENV]: "" }, envFilePath())) {
    return { ok: false, reason: "persist_failed" };
  }
  invalidateDeviceAccessPin();
  if (deviceAnchorFromEnvFile() !== null) {
    return { ok: false, reason: "persist_failed" };
  }
  return { ok: true, changed: true };
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
 * This daemon's dpk proof from the env file's anchor, or null when there is
 * none. The pair secret is bound to the key id it was minted for, so a key
 * swap without a fresh anchor yields a proof the browser rejects; install,
 * login and the credential gate drop the anchor line when the key changes.
 */
export const deviceDpkProof = (
  keyId: string | null = daemonApiKeyId(),
  dpk: string = daemonPublicKey(),
): string | null => {
  const raw = deviceAnchorFromEnvFile();
  if (raw === null || keyId === null) return null;
  // The anchor is paired with the key on the line next to it.
  const fileKey = envFileValue(envFilePath(), "OPENLLM_API_KEY");
  if (fileKey === null || parseApiKeyId(fileKey.trim()) !== keyId) return null;
  const anchor = decodeDeviceAnchor(raw);
  if (anchor === null) return null;
  try {
    return computeDpkProofNode(anchor.pairSecret, keyId, dpk);
  } finally {
    anchor.pairSecret.fill(0);
  }
};

/** `DaemonStatus.device_sessions` — sessions on == env-file anchor present. */
export const deviceSessionsReport = (): TDeviceSessionsReport => {
  const proof = deviceDpkProof();
  return {
    anchored:
      deviceAnchorFromEnvFile() !== null &&
      isAgentEligiblePin(getDeviceAccessPin()),
    ...(proof === null ? {} : { dpk_proof: proof }),
  };
};

export type TDeviceSessionsDisableRefusal =
  | "malformed"
  | "key_id_mismatch"
  | "device_not_anchored"
  | "stale_ts"
  | "bad_sig"
  | "persist_failed";

export type TApplyDeviceSessionsDisableResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: TDeviceSessionsDisableRefusal };

/**
 * Verify one signed `{ v, key_id, ts, nonce }` disable and blank the anchor.
 * Requires an ANCHORED control pin (a cloud-chosen pin could be the cloud's
 * own key), this daemon's key id, a fresh `ts`, and a signature by the pinned
 * key. Idempotent when already unanchored after a successful verify would have
 * applied — unanchored without a valid statement is `device_not_anchored`.
 */
export const applyDeviceSessionsDisable = (
  encoded: string,
  now: number = Date.now(),
): TApplyDeviceSessionsDisableResult => {
  const command = decodeDeviceSessionsDisable(encoded);
  if (command === null) return { ok: false, reason: "malformed" };
  const keyId = daemonApiKeyId();
  if (keyId === null || command.key_id !== keyId) {
    return { ok: false, reason: "key_id_mismatch" };
  }
  if (deviceAnchorFromEnvFile() === null) {
    return { ok: false, reason: "device_not_anchored" };
  }
  const pin = getDeviceAccessPin();
  if (pin === null || !isAgentEligiblePin(pin)) {
    return { ok: false, reason: "device_not_anchored" };
  }
  if (Math.abs(now - command.ts) > DEVICE_SESSIONS_DISABLE_TS_WINDOW_MS) {
    return { ok: false, reason: "stale_ts" };
  }
  if (
    !verifyDeviceGrantNode(
      pin.pubkey,
      buildDeviceSessionsDisableMessage(command),
      command.sig,
    )
  ) {
    return { ok: false, reason: "bad_sig" };
  }
  const removed = removeDeviceAnchor();
  if (!removed.ok) return { ok: false, reason: "persist_failed" };
  return { ok: true, changed: removed.changed };
};
