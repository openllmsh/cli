/**
 * Antigravity native-model observation cache (the Cursor pattern).
 *
 * The agent's `session/new` result carries the model selector the signed-in
 * Google account may actually use — the ONLY authoritative source: plan
 * gating is decided by the agent per auth method (a Claude id the account
 * lacks is refused with -32602), not by the quota endpoints. Every
 * `session/new` the daemon already issues (each inference turn, and the
 * sign-in flow's own spawn) records it here; automatic model discovery reads
 * it and never spawns the agent, so no extra probe ever fires.
 *
 * Keyed by a hash of the token file's refresh token, so a sign-in to another
 * account never inherits the previous account's list.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TProviderModelEntry } from "@openllmsh/protocol";
import { antigravityTokenPath } from "./antigravity-acp";

type TObservation = {
  readonly identity: string;
  readonly entries: ReadonlyArray<TProviderModelEntry>;
};

let observation: TObservation | null = null;

/** Stable identity of the current sign-in, or null when not signed in. */
export const antigravitySignInIdentity = (
  geminiHome: string,
): string | null => {
  try {
    const raw = JSON.parse(
      readFileSync(antigravityTokenPath(geminiHome), "utf8"),
    ) as { readonly refresh_token?: unknown };
    if (typeof raw.refresh_token !== "string" || raw.refresh_token === "") {
      return null;
    }
    return createHash("sha256").update(raw.refresh_token).digest("hex");
  } catch {
    return null;
  }
};

/** Record the selector rows from a `session/new` result. */
export const recordAntigravityModels = (
  geminiHome: string,
  rows: ReadonlyArray<{ readonly value: string; readonly name: string | null }>,
): void => {
  const identity = antigravitySignInIdentity(geminiHome);
  if (identity === null || rows.length === 0) return;
  observation = {
    identity,
    entries: rows.map((row) => ({
      provider_model_id: row.value,
      ...(row.name !== null ? { display_name: row.name } : {}),
    })),
  };
};

/** The observed list for the CURRENT sign-in, or null (never observed). */
export const readAntigravityModels = (
  geminiHome: string,
): ReadonlyArray<TProviderModelEntry> | null => {
  if (observation === null) return null;
  const identity = antigravitySignInIdentity(geminiHome);
  return identity === observation.identity ? observation.entries : null;
};

/** Test-only reset. */
export const resetAntigravityModelsForTest = (): void => {
  observation = null;
};
