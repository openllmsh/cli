/**
 * Daemon side of the install-time device trust anchor
 * (`@openllmsh/sdk/tunnel` `device-anchor.ts` owns the wire formats).
 *
 * - {@link installDeviceAnchor} — split `sk-llm-<id>.<secret>.<anchor>` on
 *   the last dot and write `OPENLLM_API_KEY=<bare>` plus
 *   `OPENLLM_DEVICE_ANCHOR=<anchor>` to the runtime's env file (0600; `.env`,
 *   or `.dev.env` in dev). Called by `openllm daemon anchor` (install.sh,
 *   `openllm login`). Nothing about the anchor goes to `state.json`: the pin
 *   (`via: "anchor"`) is DERIVED from the env file at every hydrate — see
 *   `device-access-verify.ts`. The anchor never enters `process.env`, a child
 *   env, a vendor config, a log, or the network. Re-running install/update
 *   with a new anchor is the rotation path. Installing also turns device
 *   sessions on ({@link setDeviceSessionsEnabled}).
 * - {@link setDeviceSessionsEnabled} — write `OPENLLM_DEVICE_SESSIONS`
 *   (`1`/`0`) next to the anchor (see `device-sessions-pref.ts`). Disable is
 *   reachable from the CLI, the desktop loopback control, and the
 *   control-signed remote disable; enable is local/install only (no remote
 *   enable). A routing box always refuses enable — sessions stay off there,
 *   like auto-update stays on.
 * - {@link deviceDpkProof} — `HMAC-SHA256(pair_secret, label || key_id ||
 *   dpk)`, published in `DaemonStatus.device_sessions.dpk_proof` so any
 *   browser holding the control seed can trust this daemon's X25519 key.
 * - {@link applyDeviceSessionsDisable} — the control-signed remote disable
 *   (`set_device_sessions`), verified against the anchored pin, then
 *   {@link setDeviceSessionsEnabled}(false). The anchor is never removed.
 *
 * Sessions on == the anchor is present (agent-eligible pin) AND the sessions
 * flag is not off. The flag defaults ON when absent. WebRTC/pin eligibility
 * follows the anchor alone and is unaffected by the flag.
 *
 * Dpk proof + grant verify thin-wrap `@openllmsh/sdk/vault`; pin/env I/O stay here.
 */
import type { TDeviceSessionsReport } from "@openllmsh/sdk/protocol";
import { splitAnchoredApiKey } from "@openllmsh/sdk/protocol";
import {
  buildDeviceSessionsDisableMessage,
  DEVICE_SESSIONS_DISABLE_TS_WINDOW_MS,
  decodeDeviceAnchor,
  decodeDeviceSessionsDisable,
} from "@openllmsh/sdk/tunnel";
import { computeDpkProof } from "@openllmsh/sdk/vault";
import {
  deviceKeyFingerprint,
  getDeviceAccessPin,
  invalidateDeviceAccessPin,
  isAgentEligiblePin,
  verifyDeviceGrantNode,
} from "./device-access-verify";
import {
  DEVICE_SESSIONS_ENV,
  deviceSessionsPrefEnabled,
  setDeviceSessionsEnabled,
} from "./device-sessions-pref";
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
import { isRoutingBox } from "./routing-box";
import { mutateState, pruneDisableNonces, readState } from "./state-file";

export type { TSetDeviceSessionsResult } from "./device-sessions-pref";
export {
  DEVICE_SESSIONS_ENV,
  deviceSessionsPrefEnabled,
  setDeviceSessionsEnabled,
} from "./device-sessions-pref";

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
 * the runtime env file, turn device sessions on, then re-read the pin
 * (derived from that file) to confirm it is the anchor's control key.
 * Returns the bare key.
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
  // A NEW anchor (a first pairing, a new key, a vault rotation) turns
  // sessions on: pairing with one is the opt-in. Handing over the anchor this
  // device already holds (it is derived from the seed and key id, so a
  // re-pair of the same key repeats it exactly) keeps the user's choice, so a
  // deliberate Turn off is never undone by a re-pair. Install turns sessions
  // on explicitly (`device enable`). A routing box takes the anchor (WebRTC
  // needs the pin) but keeps sessions locked off.
  const sessionsOn =
    !isRoutingBox() && deviceAnchorFromEnvFile() !== split.anchor;
  if (
    !writeEnvFileVars(
      {
        OPENLLM_API_KEY: split.key,
        [DEVICE_ANCHOR_ENV]: split.anchor,
        ...(sessionsOn ? { [DEVICE_SESSIONS_ENV]: "1" } : {}),
      },
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

/**
 * This daemon's dpk proof from the env file's anchor, or null when there is
 * none. The pair secret is bound to the key id it was minted for, so a key
 * swap without a fresh anchor yields a proof the browser rejects; install,
 * login and the credential gate drop the anchor line when the key changes.
 */
export const deviceDpkProof = async (
  keyId: string | null = daemonApiKeyId(),
  dpk: string = daemonPublicKey(),
): Promise<string | null> => {
  const raw = deviceAnchorFromEnvFile();
  if (raw === null || keyId === null) return null;
  // The anchor is paired with the key on the line next to it.
  const fileKey = envFileValue(envFilePath(), "OPENLLM_API_KEY");
  if (fileKey === null || parseApiKeyId(fileKey.trim()) !== keyId) return null;
  const anchor = decodeDeviceAnchor(raw);
  if (anchor === null) return null;
  try {
    return await computeDpkProof(anchor.pairSecret, keyId, dpk);
  } finally {
    anchor.pairSecret.fill(0);
  }
};

/**
 * `DaemonStatus.device_sessions` — sessions on == env-file anchor present,
 * agent-eligible pin, sessions flag not off, and not a routing box.
 */
export const deviceSessionsReport =
  async (): Promise<TDeviceSessionsReport> => {
    const proof = await deviceDpkProof();
    return {
      enabled:
        !isRoutingBox() &&
        deviceSessionsPrefEnabled() &&
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
  | "replayed_nonce"
  | "persist_failed";

export type TApplyDeviceSessionsDisableResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: TDeviceSessionsDisableRefusal };

/**
 * Verify one signed `{ v, key_id, ts, nonce }` disable and turn sessions off.
 * Requires an ANCHORED control pin (a cloud-chosen pin could be the cloud's
 * own key), this daemon's key id, a fresh `ts`, and a signature by the pinned
 * key, used once (`replayed_nonce` after). The anchor is kept; unanchored
 * is `device_not_anchored`.
 *
 * Order: verify → durably burn the nonce → set the flag off. A later local
 * enable is a legitimate later user action, not a race to defend against. If
 * the flag write fails after a successful burn, the nonce stays burned and the
 * caller must sign a fresh statement to retry (the browser/cloud path always
 * does — `signDeviceSessionsDisable` mints a new nonce per attempt).
 */
/**
 * Burn a disable nonce into `state.json` (0600), pruned of expired entries
 * with the caller's `now`. Confirms from the {@link mutateState} result
 * itself (no second `readState` with a different clock). Returns false when
 * the write did not stick — nothing else has changed yet.
 */
const burnDisableNonce = (
  nonce: string,
  until: number,
  now: number,
): boolean => {
  const next = mutateState((s) => {
    const kept = pruneDisableNonces(s.deviceSessionsDisableNonces, now);
    kept[nonce] = until;
    return { ...s, deviceSessionsDisableNonces: kept };
  });
  return next?.deviceSessionsDisableNonces?.[nonce] === until;
};

export const applyDeviceSessionsDisable = async (
  encoded: string,
  now: number = Date.now(),
): Promise<TApplyDeviceSessionsDisableResult> => {
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
    !(await verifyDeviceGrantNode(
      pin.pubkey,
      buildDeviceSessionsDisableMessage(command),
      command.sig,
    ))
  ) {
    return { ok: false, reason: "bad_sig" };
  }
  // Durable set: survives a restart inside the ts window so a replay after a
  // local re-enable is still refused. Prune expired entries with this `now`.
  const burned = pruneDisableNonces(
    readState().deviceSessionsDisableNonces,
    now,
  );
  if (burned[command.nonce] !== undefined) {
    return { ok: false, reason: "replayed_nonce" };
  }
  const until = command.ts + DEVICE_SESSIONS_DISABLE_TS_WINDOW_MS;
  // Burn FIRST. A failed burn leaves the flag untouched so a reported
  // failure never claims the statement was consumed.
  if (!burnDisableNonce(command.nonce, until, now)) {
    return { ok: false, reason: "persist_failed" };
  }
  const set = setDeviceSessionsEnabled(false);
  // Disable never returns `routing_box` (only enable does). A failed flag
  // persist keeps the nonce burned — retry signs a fresh statement.
  if (!set.ok) return { ok: false, reason: "persist_failed" };
  return { ok: true, changed: set.changed };
};
