/**
 * Obscured vendor-account identity (`account_hash` on the status frame).
 *
 * Each vendor CLI stores a STABLE account identifier in the local state the
 * daemon already owns (the isolated run-view under `~/.openllm/cli/…`) —
 * Anthropic's `oauthAccount.accountUuid`, ChatGPT's `tokens.account_id`,
 * Kimi's `user_id` JWT claim, Grok's session `user_id`. The cloud needs
 * EQUALITY on that identity (to key usage-meter series per account, so two
 * devices on the same account merge and a second account on the same
 * provider doesn't — see docs/proposals/
 * inferred-subscription-usage-calibration.md §10) but never the id itself,
 * so delegates report only this hash. The version-tagged domain prefix keeps
 * the digest non-comparable to anything else that might hash the same uuid.
 *
 * Per-DEVICE ids (claude's `machineID`/`userID`, kimi's `device_id`, grok's
 * `agent_id`) must never be used here — they'd split one account into
 * per-device series and defeat the merge.
 */
import { createHash } from "node:crypto";

/** `sha256("openllm-account-v1:<provider>:<raw-id>")`, hex. */
export const accountHash = (provider: string, rawId: string): string =>
  createHash("sha256")
    .update(`openllm-account-v1:${provider}:${rawId}`)
    .digest("hex");

/**
 * Decode the payload claims of a locally-stored JWT (NO signature
 * verification — it's our own CLI's stored token, read for a single claim,
 * never trusted for auth). Returns null on any shape surprise.
 */
export const jwtClaims = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** A non-empty string claim/field, or null. */
export const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Optional `account_hash` status field from a raw vendor id — `{}` when the
 * id is missing/empty, so it composes into a status spread without emitting
 * an empty hash.
 */
export const accountHashField = (
  provider: string,
  rawId: unknown,
): { account_hash?: string } => {
  const id = nonEmpty(rawId);
  return id === null ? {} : { account_hash: accountHash(provider, id) };
};

/**
 * After a manual native usage refresh, reject a store that rotated onto a
 * different account. A known prior that becomes missing is also a change
 * (do not treat unverifiable identity as the previous account).
 */
export const usageAccountChanged = (
  prior: string | null,
  next: string | null,
): boolean => {
  if (prior === null) return false;
  if (next === null) return true;
  return prior !== next;
};
