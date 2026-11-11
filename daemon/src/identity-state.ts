/**
 * Process-local outcome of publishing the daemon's durable X25519 identity.
 *
 * Under the online-lock model a `409 identity_conflict` means another device
 * now holds this API key. The daemon records the flag for `openllm status` /
 * doctor, then stops via {@link stopForIdentityConflict} so the supervisor
 * does not relaunch into the same conflict.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";
import { readJsonStateFile, writeJsonStateAtomic } from "./json-state-cache";

const conflictPath = (): string => join(stateDir(), "identity-conflict.json");
const fingerprint = (key: string, origin: string): string =>
  createHash("sha256")
    .update(JSON.stringify([key, origin]))
    .digest("hex");

/** Persist only a digest, never the credential or the server response. */
export const recordIdentityConflict = (key: string, origin: string): void => {
  writeJsonStateAtomic(stateDir(), conflictPath(), {
    fingerprint: fingerprint(key, origin),
  });
};

export const clearIdentityConflictRecord = (): void => {
  try {
    rmSync(conflictPath(), { force: true });
  } catch {
    // Best-effort, like other daemon state.
  }
};

/** A record for another key or origin is stale and must not be displayed. */
export const hasRecordedIdentityConflict = (
  key: string | null,
  origin: string,
): boolean => {
  const raw = readJsonStateFile(conflictPath(), 1024);
  if (raw === null || typeof raw !== "object" || !("fingerprint" in raw)) {
    return false;
  }
  // No key in scope (e.g. env not loaded): don't judge, don't delete.
  if (key === null) return false;
  if (raw.fingerprint === fingerprint(key, origin)) return true;
  clearIdentityConflictRecord();
  return false;
};

let identityConflict = false;

export const hasIdentityConflict = (): boolean => identityConflict;

export const setIdentityConflict = (value: boolean): void => {
  identityConflict = value;
};
