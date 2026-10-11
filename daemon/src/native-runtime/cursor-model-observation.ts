/**
 * Single Cursor native-model observation cache.
 *
 * Inference ACP sessions record available-model metadata here from
 * `session/new` `availableModels` on an already-authorized client.
 * Automatic `discoverModels` reads this cache only — it never constructs
 * an ACP client or issues extra RPC. Manual `listModels` may still probe
 * ACP. Observation age is the real capture time and is never re-aged on
 * read. A ticket (generation at request entry + trusted store fingerprint
 * after authenticate) is required to admit a late session/new result.
 */
import { platform } from "node:os";
import { join } from "node:path";
import type { TProviderModelEntry } from "@openllmsh/protocol";
import { cliConfigDir, cliHome } from "../cli-paths";
import type { TFileStoreIdentity } from "../delegation/observation-cache";
import {
  fileStoreIdentity,
  fingerprintStoreIdentity,
} from "../delegation/observation-cache";
import { keychainStoreIdentity } from "../delegation/util";

/** Same TTL as the previous in-delegate Cursor model cache. */
export const CURSOR_NATIVE_MODEL_TTL_MS = 5 * 60_000;

export type TCursorModelRow = {
  readonly value: string;
  readonly name: string | null;
};

export type TCursorModelObservationProvenance = {
  readonly fingerprint: string;
  readonly accountHint: string | null;
};

export type TCursorNativeModelObservationTicket = {
  readonly generation: number;
  readonly provenance: TCursorModelObservationProvenance;
};

type TCursorNativeModelObservation = {
  readonly observedAt: number;
  readonly generation: number;
  readonly provenance: TCursorModelObservationProvenance;
  readonly entries: ReadonlyArray<TProviderModelEntry>;
};

let generation = 0;
let observation: TCursorNativeModelObservation | null = null;

export const cursorNativeModelGeneration = (): number => generation;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const trustedFingerprintOf = (id: TFileStoreIdentity): string | null => {
  if (!id.statOk || !id.present) return null;
  if (id.mtimeMs === null || id.size === null || id.ino === null) return null;
  return fingerprintStoreIdentity(id);
};

const isTrustedFingerprint = (fingerprint: string): boolean =>
  fingerprint.length > 0 &&
  !fingerprint.includes("\0unreadable") &&
  !fingerprint.includes("\0absent");

/** Present, readable store identity only. Unreadable/absent stores skip. */
export const cursorNativeModelFingerprint = (home: string): string | null => {
  const identity =
    platform() === "darwin"
      ? keychainStoreIdentity(home)
      : fileStoreIdentity(join(cliConfigDir("cursor"), "auth.json"));
  return trustedFingerprintOf(identity);
};

export const cursorNativeHomeFromEnv = (
  env: Readonly<Record<string, string>>,
): string => {
  const home = env.HOME;
  return typeof home === "string" && home.length > 0 ? home : cliHome("cursor");
};

export const parseCursorListAvailableModels = (
  listed: unknown,
): ReadonlyArray<TCursorModelRow> | null => {
  if (!isRecord(listed)) return null;
  const models = listed.models;
  if (!Array.isArray(models)) return null;
  const rows: TCursorModelRow[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!isRecord(m)) continue;
    const value = m.value;
    const name = m.name;
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    rows.push({
      value,
      name: typeof name === "string" ? name : null,
    });
  }
  return rows.length > 0 ? rows : null;
};

export const parseCursorSessionAvailableModels = (
  sessionResult: unknown,
): ReadonlyArray<TCursorModelRow> | null => {
  if (!isRecord(sessionResult)) return null;
  const modelsField = sessionResult.models;
  if (!isRecord(modelsField)) return null;
  const models = modelsField.availableModels;
  if (!Array.isArray(models)) return null;
  const rows: TCursorModelRow[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!isRecord(m)) continue;
    const modelId = m.modelId;
    if (typeof modelId !== "string" || modelId.length === 0) continue;
    const value = modelId.split("[")[0]?.trim() ?? "";
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    const name = m.name;
    rows.push({
      value,
      name: typeof name === "string" ? name : null,
    });
  }
  return rows.length > 0 ? rows : null;
};

export const entriesFromCursorModelRows = (
  rows: ReadonlyArray<TCursorModelRow>,
): ReadonlyArray<TProviderModelEntry> | null => {
  const entries: TProviderModelEntry[] = rows.map((row) => ({
    provider_model_id: row.value,
    ...(row.name !== null ? { display_name: row.name } : {}),
  }));
  return entries.length > 0 ? entries : null;
};

const provenanceMatches = (
  stored: TCursorModelObservationProvenance,
  current: TCursorModelObservationProvenance,
): boolean => {
  if (stored.fingerprint !== current.fingerprint) return false;
  if (stored.accountHint === null) return true;
  return current.accountHint === stored.accountHint;
};

export const rememberCursorNativeModels = (
  provenance: TCursorModelObservationProvenance,
  rows: ReadonlyArray<TCursorModelRow>,
  observedAt: number = Date.now(),
  observedGeneration: number = generation,
): void => {
  if (observedGeneration !== generation) return;
  if (!isTrustedFingerprint(provenance.fingerprint)) return;
  if (observation !== null && observedAt < observation.observedAt) return;
  const entries = entriesFromCursorModelRows(rows);
  if (entries === null) return;
  observation = {
    observedAt,
    generation: observedGeneration,
    provenance,
    entries,
  };
};

export const readCursorNativeModels = (
  provenance: TCursorModelObservationProvenance,
  now: number = Date.now(),
): ReadonlyArray<TProviderModelEntry> | null => {
  if (!isTrustedFingerprint(provenance.fingerprint)) return null;
  if (observation === null) return null;
  if (now - observation.observedAt >= CURSOR_NATIVE_MODEL_TTL_MS) return null;
  if (!provenanceMatches(observation.provenance, provenance)) return null;
  return observation.entries;
};

export const clearCursorNativeModels = (): void => {
  generation += 1;
  observation = null;
};

export const peekCursorNativeObservationForTests = (): {
  readonly observedAt: number;
  readonly provenance: TCursorModelObservationProvenance;
  readonly entries: ReadonlyArray<TProviderModelEntry>;
} | null => observation;

export const resetCursorNativeModelObservationForTests = (): void => {
  clearCursorNativeModels();
};

/**
 * Capture generation (request entry) plus trusted store fingerprint after
 * authenticate. Null when the store is unreadable/absent.
 */
export const takeCursorNativeModelObservationTicket = (
  env: Readonly<Record<string, string>>,
  observedGeneration: number = generation,
): TCursorNativeModelObservationTicket | null => {
  const fingerprint = cursorNativeModelFingerprint(
    cursorNativeHomeFromEnv(env),
  );
  if (fingerprint === null) return null;
  return {
    generation: observedGeneration,
    provenance: { fingerprint, accountHint: null },
  };
};

/**
 * Admit advertised `session/new` models only if the caller's ticket still
 * matches the live generation and store fingerprint. Never starts extra RPC.
 */
export const observeCursorNativeModelsFromSession = (params: {
  readonly ticket: TCursorNativeModelObservationTicket;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionResult: unknown;
}): void => {
  if (params.ticket.generation !== generation) return;
  const live = cursorNativeModelFingerprint(
    cursorNativeHomeFromEnv(params.env),
  );
  if (live === null || live !== params.ticket.provenance.fingerprint) {
    return;
  }
  const sessionRows = parseCursorSessionAvailableModels(params.sessionResult);
  if (sessionRows === null) return;
  rememberCursorNativeModels(
    params.ticket.provenance,
    sessionRows,
    Date.now(),
    params.ticket.generation,
  );
};
