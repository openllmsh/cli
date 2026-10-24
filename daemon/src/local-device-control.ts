/**
 * Loopback device-control routes (`@openllmsh/protocol` `local-device-control`).
 *
 * - `GET /local/identity` — this daemon's X25519 key + fingerprint + its
 *   device-control pin, so a local browser / the desktop app can attest the
 *   key without trusting the cloud's copy.
 * - `POST /local/device-control` — pin the account device-control public key
 *   as a LOCAL confirmation (`via: "local"`, an anchored pin, never TOFU).
 * - `POST /local/device-anchor` — accept the install-time trust anchor for the
 *   key this daemon runs on (the desktop app's Device sessions toggle). Written
 *   by the same writer as `openllm daemon anchor` ({@link installDeviceAnchor}).
 *   The anchor is the sessions opt-in; the endpoint also persists `enabled:
 *   true` so a prior explicit disable is cleared by the toggle. The anchor is
 *   never logged.
 *
 * Both use the `/local/agent` admission: loopback peer + loopback Host, an
 * allowed Origin (Tauri / OpenLLM deployment / none), and this boot's local
 * control capability. A remote page can neither read nor pin.
 */
import type {
  TDeviceAccessPinReport,
  TLocalDeviceAnchorRefusal,
  TLocalDeviceAnchorResponse,
  TLocalDeviceControlRequest,
  TLocalIdentityResponse,
} from "@openllmsh/protocol";
import {
  DEVICE_ANCHOR_LOCAL_MAX_BODY_BYTES,
  DEVICE_ANCHOR_LOCAL_PATH,
  DEVICE_CONTROL_LOCAL_MAX_BODY_BYTES,
  DEVICE_CONTROL_LOCAL_PATH,
  IDENTITY_LOCAL_PATH,
  isOpenllmDeviceAnchorSyntax,
  LocalDeviceAnchorRequest,
  LocalDeviceControlRequest,
} from "@openllmsh/protocol";
import { Schema } from "effect";
import { localAgentRefusal, localAgentRefusalResponse } from "./agent/loopback";
import {
  deviceKeyFingerprint,
  getDeviceAccessPin,
  isEd25519SpkiB64,
  setDeviceAccessPubkey,
} from "./device-access-verify";
import { deviceSessionsReport, installDeviceAnchor } from "./device-anchor";
import { daemonEnv, parseApiKeyId } from "./env";
import { daemonPublicKey } from "./keypair";

const decodeRequest = Schema.decodeUnknownEither(LocalDeviceControlRequest);
const decodeAnchorRequest = Schema.decodeUnknownEither(
  LocalDeviceAnchorRequest,
);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

/** The pin as `DaemonStatus.device_access_pin` reports it; null when unpinned. */
export const deviceAccessPinReport = (): TDeviceAccessPinReport | null => {
  const pin = getDeviceAccessPin();
  if (pin === null) return null;
  const fp = deviceKeyFingerprint(pin.pubkey);
  if (fp === null) return null;
  return {
    fp,
    kind: pin.kind,
    ...(pin.via === null ? {} : { via: pin.via }),
  };
};

export const isLocalDeviceControlPath = (pathname: string): boolean =>
  pathname === IDENTITY_LOCAL_PATH ||
  pathname === DEVICE_CONTROL_LOCAL_PATH ||
  pathname === DEVICE_ANCHOR_LOCAL_PATH;

const identityResponse = (): Response => {
  const pubkey = daemonPublicKey();
  const body: TLocalIdentityResponse = {
    pubkey,
    fingerprint: deviceKeyFingerprint(pubkey) ?? "",
    device_access_pin: deviceAccessPinReport(),
    device_sessions: deviceSessionsReport(),
  };
  return json(200, body);
};

const pinResponse = async (req: Request): Promise<Response> => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > DEVICE_CONTROL_LOCAL_MAX_BODY_BYTES) {
    return json(413, { error: "body_too_large" });
  }
  const text = await req.text();
  if (text.length > DEVICE_CONTROL_LOCAL_MAX_BODY_BYTES) {
    return json(413, { error: "body_too_large" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_body" });
  }
  const decoded = decodeRequest(raw);
  if (decoded._tag === "Left") return json(400, { error: "invalid_body" });
  const input: TLocalDeviceControlRequest = decoded.right;
  if (!isEd25519SpkiB64(input.device_control_pubkey)) {
    return json(400, { error: "invalid_pubkey" });
  }
  const result = setDeviceAccessPubkey(input.device_control_pubkey, {
    force: true,
    kind: "control",
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  if (!result.ok) return json(409, { error: result.reason });
  return json(200, {
    ok: true,
    changed: result.changed,
    device_access_pin: deviceAccessPinReport(),
  });
};

const anchorRefusal = (
  status: number,
  error: TLocalDeviceAnchorRefusal,
): Response => {
  const body: TLocalDeviceAnchorResponse = { ok: false, error };
  return json(status, body);
};

/**
 * `POST /local/device-anchor`. Binds the anchor to the key this daemon runs
 * on: the caller names the key id it derived the anchor for, and anything
 * else is refused (a pair secret for another key would yield a dpk proof the
 * browser rejects). Nothing here logs — the body holds the pair secret.
 */
const anchorResponse = async (req: Request): Promise<Response> => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > DEVICE_ANCHOR_LOCAL_MAX_BODY_BYTES) {
    return anchorRefusal(413, "body_too_large");
  }
  const text = await req.text();
  if (text.length > DEVICE_ANCHOR_LOCAL_MAX_BODY_BYTES) {
    return anchorRefusal(413, "body_too_large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return anchorRefusal(400, "invalid_body");
  }
  const decoded = decodeAnchorRequest(raw);
  if (decoded._tag === "Left") return anchorRefusal(400, "invalid_body");
  const { key_id: keyId, anchor } = decoded.right;
  if (!isOpenllmDeviceAnchorSyntax(anchor)) {
    return anchorRefusal(400, "malformed_anchor");
  }
  const key = daemonEnv().apiKey;
  if (key === null || parseApiKeyId(key) !== keyId) {
    return anchorRefusal(409, "key_id_mismatch");
  }
  // The same writer as `openllm daemon anchor`: env file + derived pin.
  const result = installDeviceAnchor(`${key}.${anchor}`);
  if (!result.ok) {
    return anchorRefusal(
      result.reason === "persist_failed" ? 500 : 400,
      result.reason === "persist_failed"
        ? "persist_failed"
        : "malformed_anchor",
    );
  }
  // `installDeviceAnchor` already clears a persisted disable.
  const body: TLocalDeviceAnchorResponse = {
    ok: true,
    device_sessions: deviceSessionsReport(),
  };
  return json(200, body);
};

/**
 * Serve one loopback device-control request. `remoteAddress` is the TCP peer
 * (`server.requestIP(req)?.address`).
 */
export const handleLocalDeviceControl = async (
  req: Request,
  remoteAddress: string | null | undefined,
): Promise<Response> => {
  const refusal = localAgentRefusal(req, remoteAddress);
  if (refusal !== null) return localAgentRefusalResponse(refusal);
  const { pathname } = new URL(req.url);
  if (pathname === IDENTITY_LOCAL_PATH) {
    return req.method === "GET"
      ? identityResponse()
      : json(405, { error: "method_not_allowed" });
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  return pathname === DEVICE_ANCHOR_LOCAL_PATH
    ? anchorResponse(req)
    : pinResponse(req);
};
