import type { TCredentialGateMode } from "@openllmsh/sdk/protocol";
import { isUsableOpenllmApiKey } from "@openllmsh/sdk/protocol";
import {
  applyPersistedApiKey,
  daemonEnv,
  envFilePath,
  envFileValue,
  isDevMode,
  sharedEnvFilePath,
  writeEnvFileVars,
} from "./env";

export type { TCredentialGateMode } from "@openllmsh/sdk/protocol";

export type TCredentialGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

// A successful gate result is registered by identity, not by a forgeable boolean.
// Lifecycle internals use this boundary instead of a public skip flag.
const approvedGates = new WeakSet<object>();

export const hasCredentialProof = (result: TCredentialGateResult): boolean =>
  result.ok && approvedGates.has(result);

const approved = (): TCredentialGateResult => {
  const result: TCredentialGateResult = { ok: true };
  approvedGates.add(result);
  return result;
};

/** A local envelope check only; cloud authentication remains authoritative. */
export const isUsableApiKey = isUsableOpenllmApiKey;

const signInUrl = (): string => `${daemonEnv().cloudOrigin}/sign-in`;

export const missingKeyDiagnostic = (): string =>
  `[openllm] API key required.\nRun \`openllm login\` in a terminal to sign in through the browser (${signInUrl()}), or \`openllm login --api-key\` to paste a key.\n`;

/** Make an inherited key durable in the service's env file. The anchor line
 *  is left alone: anchors are written by `openllm login` / `openllm daemon
 *  anchor`, never by the service gate. */
const persistServiceKey = (key: string, targetPath: string): boolean => {
  if (!writeEnvFileVars({ OPENLLM_API_KEY: key }, targetPath)) return false;
  applyPersistedApiKey(key);
  return true;
};

const persistedUsableKey = (targetPath: string): string | null => {
  const value = envFileValue(targetPath, "OPENLLM_API_KEY");
  return value !== null && isUsableApiKey(value) ? value.trim() : null;
};

const configuredUsableKey = (): string | null => {
  const value = daemonEnv().apiKey;
  return value !== null && isUsableApiKey(value) ? value.trim() : null;
};

const isReadOnlyDevKey = (key: string): boolean => {
  if (!isDevMode()) return false;
  const devKey = persistedUsableKey(envFilePath());
  const sharedKey = persistedUsableKey(sharedEnvFilePath());
  return devKey === key || sharedKey === key;
};

/**
 * Resolve a usable service key. This gate never prompts: on a terminal the
 * CLI has already run the one shared credential gate before handing `start`
 * / `restart` here (`requireCliApiKey` — browser sign-in, or `--api-key` to
 * paste). A key the service inherited from its launching environment is made
 * durable in the file its supervisor reads; dev's read-only key never is.
 */
export const requireServiceApiKey = (
  mode: TCredentialGateMode,
  targetPath: string = envFilePath(),
): TCredentialGateResult => {
  // A durable valid key is already authoritative. Never rewrite it just because
  // the process inherited the same (or another) valid value.
  if (persistedUsableKey(targetPath) !== null) return approved();

  const configured = configuredUsableKey();
  // Headless service boots are presence-only: no secret write.
  if (mode === "machine") {
    return configured === null
      ? { ok: false, message: missingKeyDiagnostic() }
      : approved();
  }

  // A production service may inherit a key from its launching environment. Make
  // that transient value durable in the precise file its supervisor will read.
  // Do not copy dev's read-only shared-key fallback into any file.
  if (configured !== null && !isReadOnlyDevKey(configured)) {
    if (persistServiceKey(configured, targetPath)) return approved();
    return { ok: false, message: "[openllm] Could not save the API key.\n" };
  }
  return { ok: false, message: missingKeyDiagnostic() };
};
