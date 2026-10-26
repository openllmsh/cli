/**
 * Contributor-daemon team grant checks (defence in depth after relay
 * admission). A team request carries the origin-signed grant on the tunnel
 * OPEN as `headers.team_grant` (mapped to `x-openllm-team-grant` on the
 * in-process Request). Same-user traffic omits the grant and is untouched.
 *
 * Checks: HMAC signature + expiry (bootstrap `team_grant_key`), device_key_id
 * matches this daemon, device_user_id matches bootstrap `user_id` when known,
 * model matches the request, local monthly cap when `cap_tokens` is set,
 * `teamShareable(provider)`, and the local kill switch.
 *
 * Cross-user safety: a new relay stamps `peer_user_id` on every
 * `channel_open`. When that id differs from this daemon's bootstrap
 * `user_id`, a valid team_grant is REQUIRED. An older relay omits
 * `peer_user_id`; grant-less opens then rely on the trusted-relay
 * assumption (the relay never forwards a grant-less cross-user open).
 */

import type { TTeamGrant } from "@openllmsh/tunnel";
import { verifyTeamGrant } from "@openllmsh/tunnel";
import { daemonUserId, teamGrantKey } from "./config";
import { daemonApiKeyId } from "./env";
import { teamShareable } from "./team-shareable";
import { teamUsageCanCharge } from "./team-usage";

export type TTeamGrantAdmitDeps = {
  readonly now?: () => number;
  readonly hmacKey?: () => string | null;
  readonly keyId?: () => string | null;
  readonly userId?: () => string | null;
  readonly teamServeEnabled?: () => boolean;
  readonly shareable?: (provider: string) => boolean;
  /** Soft capacity check — must not permanently increment. */
  readonly canCharge?: (
    shareId: string,
    tokens: number,
    capTokens: number,
  ) => boolean;
  readonly verify?: (
    token: string,
    hmacKey: string,
    nowMs: number,
  ) => Promise<TTeamGrant | null>;
};

export type TTeamGrantAdmitReason =
  | "ok"
  | "kill_switch"
  | "no_key"
  | "invalid_grant"
  | "wrong_device"
  | "wrong_user"
  | "wrong_model"
  | "not_shareable"
  | "over_cap";

export type TTeamGrantAdmitResult =
  | { readonly ok: true; readonly grant: TTeamGrant }
  | { readonly ok: false; readonly reason: TTeamGrantAdmitReason };

/**
 * Local kill switch. `OPENLLM_TEAM_SERVE=0` / `false` / `off` refuses all
 * team traffic; absent or any other value leaves serving on.
 */
export const teamServeEnabled = (): boolean => {
  const raw = process.env.OPENLLM_TEAM_SERVE;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
};

/** Best-effort provider slug from a model id (`provider/model` or bare). */
export const providerOfModel = (model: string): string => {
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  return model.slice(0, slash);
};

/** Estimate tokens to reserve locally when the grant carries `cap_tokens`. */
export const estimateTeamReserveTokens = (body: Uint8Array): number => {
  // Cheap stand-in until origin echoes a reservation: ~4 chars/token on the
  // UTF-8 body, floor 256 so a tiny probe still counts.
  const approx = Math.ceil(body.byteLength / 4);
  return Math.max(256, approx);
};

/** Pull `model` from a JSON request body; null when absent / not JSON. */
export const modelFromRequestBody = (body: Uint8Array): string | null => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { model?: unknown }).model === "string"
    ) {
      const model = (parsed as { model: string }).model;
      return model.length > 0 ? model : null;
    }
  } catch {
    // not JSON
  }
  return null;
};

export const createTeamGrantAdmit = (
  deps: TTeamGrantAdmitDeps = {},
): {
  readonly admit: (
    token: string,
    /**
     * `undefined` = skip model check (channel_open). A string must equal
     * `grant.model`. Pass `null` when the request body had no model.
     */
    requestModel: string | null | undefined,
    reserveTokens: number,
  ) => Promise<TTeamGrantAdmitResult>;
} => {
  const now = deps.now ?? (() => Date.now());
  const hmacKey = deps.hmacKey ?? teamGrantKey;
  const keyId = deps.keyId ?? daemonApiKeyId;
  const userId = deps.userId ?? daemonUserId;
  const enabled = deps.teamServeEnabled ?? teamServeEnabled;
  const shareable = deps.shareable ?? teamShareable;
  const canCharge = deps.canCharge ?? teamUsageCanCharge;
  const verify = deps.verify ?? verifyTeamGrant;

  return {
    async admit(
      token: string,
      requestModel: string | null | undefined,
      reserveTokens: number,
    ): Promise<TTeamGrantAdmitResult> {
      if (!enabled()) return { ok: false, reason: "kill_switch" };
      const key = hmacKey();
      if (key === null) return { ok: false, reason: "no_key" };
      const grant = await verify(token, key, now());
      if (grant === null) return { ok: false, reason: "invalid_grant" };
      const selfKey = keyId();
      if (selfKey === null || grant.device_key_id !== selfKey) {
        return { ok: false, reason: "wrong_device" };
      }
      const selfUser = userId();
      if (selfUser !== null && grant.device_user_id !== selfUser) {
        return { ok: false, reason: "wrong_user" };
      }
      if (requestModel !== undefined && requestModel !== grant.model) {
        return { ok: false, reason: "wrong_model" };
      }
      if (!shareable(providerOfModel(grant.model))) {
        return { ok: false, reason: "not_shareable" };
      }
      // Soft check only — charge actual tokens on successful completion.
      if (grant.cap_tokens !== undefined && reserveTokens > 0) {
        if (!canCharge(grant.share_id, reserveTokens, grant.cap_tokens)) {
          return { ok: false, reason: "over_cap" };
        }
      }
      return { ok: true, grant };
    },
  };
};

const defaultAdmit = createTeamGrantAdmit();

/** Production admit entry — used by the mux tunnel server. */
export const admitTeamGrant = (
  token: string,
  requestModel: string | null | undefined,
  reserveTokens: number,
): Promise<TTeamGrantAdmitResult> =>
  defaultAdmit.admit(token, requestModel, reserveTokens);

/**
 * Channel-open check: verify the grant binds this device and is not expired.
 * Model / cap are enforced per request (`headers.team_grant` on tunnel OPEN).
 */
export const admitTeamGrantOnChannel = async (
  token: string,
  deps: TTeamGrantAdmitDeps = {},
): Promise<TTeamGrantAdmitResult> => {
  const admit = createTeamGrantAdmit(deps);
  return admit.admit(token, undefined, 0);
};
