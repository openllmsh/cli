/**
 * What the headless CLI (`antigravity-headless.ts`) and `agy acp`
 * (`antigravity-acp.ts`) share, kept in one place so the two never drift:
 *   - {@link classifyAgyMessage}: an `agy` failure message → decline reason
 *     and cooldown class;
 *   - {@link prepareAgySpawn}: the gates every inference `agy` spawn passes
 *     first (isolated HOME, keychain, locked-down profile, abort).
 */

import { homedir } from "node:os";
import type { TStoreRead } from "../delegation/util";
import { ensureKeychainReady } from "../delegation/util";

/** Classified `agy` failure → decline reason + cooldown class. */
export type TAntigravityFailure = {
  readonly reason: string;
  readonly cooldown?: "auth" | "payment" | "quota_exhausted" | "rate_limit";
};

const QUOTA_RE =
  /RESOURCE_EXHAUSTED|quota|exhausted|usage limit|out of (?:credits|quota)/i;
const RATE_RE = /rate[\s_-]?limit|too many requests|\b429\b/i;
/** Includes print mode's own refusal, "Run 'agy' to log in". */
const SIGN_IN_RE =
  /not logged in|to log in|sign in|signed out|authentication failed/i;
const PLAN_RE = /SUBSCRIPTION_REQUIRED|subscription|tier|upgrade|license/i;

/**
 * An `agy` failure message (a headless `result.error`, an ACP RPC error's
 * message) → its class, or null when it names none. Account eligibility
 * and plan-gated models come first: their text can also mention sign-in.
 */
export const classifyAgyMessage = (
  message: string,
): TAntigravityFailure | null => {
  // Google's onboarding refused the signed-in account (e.g. "User is
  // ineligible for free-tier … Verify your account", VALIDATION_REQUIRED).
  if (
    /Onboarding failed|not eligible for Antigravity|ineligible/i.test(message)
  ) {
    return {
      reason: /verify your account|VALIDATION_REQUIRED/i.test(message)
        ? "antigravity: Google account not eligible — verify the account with Google, then sign in again"
        : "antigravity: Google account not eligible for Antigravity",
      cooldown: "payment",
    };
  }
  if (/SUBSCRIPTION_REQUIRED/.test(message)) {
    return {
      reason: "antigravity: Google account has no eligible Antigravity plan",
      cooldown: "payment",
    };
  }
  // Plan-gated model: our pre-submit pin check, or the agent's own
  // ("Model 'x' is not available for the current authentication method").
  // Keep the model id so the client sees WHY.
  if (
    /is not available (on this Google account|for the current authentication method)/i.test(
      message,
    )
  ) {
    const model = /model '?([\w.-]+)'?/i.exec(message)?.[1];
    return {
      reason: `antigravity: model ${model ?? "requested"} is not available on this Google account's plan`,
      cooldown: "payment",
    };
  }
  // Quota before rate: Google reports quota as `429 RESOURCE_EXHAUSTED`.
  if (QUOTA_RE.test(message)) {
    return {
      reason: "antigravity: quota exhausted",
      cooldown: "quota_exhausted",
    };
  }
  if (RATE_RE.test(message)) {
    return { reason: "antigravity: rate limited", cooldown: "rate_limit" };
  }
  if (SIGN_IN_RE.test(message)) {
    return { reason: "antigravity: Google sign-in required", cooldown: "auth" };
  }
  if (PLAN_RE.test(message)) {
    return { reason: `antigravity: ${message}`, cooldown: "payment" };
  }
  return null;
};

export type TAgySpawnGates = {
  readonly env: Record<string, string>;
  readonly signal: AbortSignal;
  /** Keychain readiness gate (default {@link ensureKeychainReady}). */
  readonly ensureKeychain?: (home: string) => Promise<TStoreRead<void>>;
  /** Profile prep: the deny rules (and, for the CLI, its agent). False →
   *  `agy`'s tools might be live, so nothing spawns. */
  readonly ensureSettings: (home: string) => boolean;
};

/**
 * The gates before any inference `agy` spawn: never the user's real HOME
 * (the isolated home keeps the daemon's Google sign-in separate from the
 * user's own `agy`); on macOS the slot keychain created / unlocked on THIS
 * call (a missing one raises "Keychain Not Found", a locked one asks for its
 * password; Linux: no-op); the profile locked down; the client still there.
 * A failure is a reason without the `antigravity:` prefix — each transport
 * words its own decline.
 */
export const prepareAgySpawn = async (
  gates: TAgySpawnGates,
): Promise<
  | { readonly ok: true; readonly home: string }
  | { readonly ok: false; readonly reason: string; readonly aborted: boolean }
> => {
  const no = (reason: string, aborted = false) =>
    ({ ok: false, reason, aborted }) as const;
  if (gates.signal.aborted) return no("client aborted", true);
  const home = gates.env.HOME;
  if (home === undefined || home.length === 0 || home === homedir()) {
    return no("no isolated HOME");
  }
  const keychain = await (gates.ensureKeychain ?? ensureKeychainReady)(home);
  if (keychain.kind !== "present") {
    return no(`isolated keychain not ready (${keychain.kind})`);
  }
  if (!gates.ensureSettings(home)) {
    return no("agy settings could not be locked down");
  }
  if (gates.signal.aborted) return no("client aborted", true);
  return { ok: true, home };
};
