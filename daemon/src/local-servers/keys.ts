/**
 * Per-port API keys for local model servers.
 *
 * Stored ONLY on this device in the daemon env file as
 * `OPENLLM_LOCAL_KEY_<PORT>`. Never logged, never pushed on status (status
 * carries `has_key` only). Empty value clears.
 */
import { envFilePath, envFileValue, loadEnvFile, writeEnvFileVars } from "../env";
import { logWarn, safeDiagnosticMessage } from "../logger";

const keyName = (port: number): string => `OPENLLM_LOCAL_KEY_${port}`;

/** Read the stored key for `port`, or null when absent/empty. Never log it. */
export const localKeyForPort = (port: number): string | null => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  loadEnvFile();
  const fromEnv = process.env[keyName(port)];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const fromFile = envFileValue(envFilePath(), keyName(port));
  if (fromFile !== null && fromFile.trim().length > 0) return fromFile.trim();
  return null;
};

/** True when a non-empty key is stored for `port`. */
export const hasLocalKey = (port: number): boolean =>
  localKeyForPort(port) !== null;

/**
 * Persist or clear the key for `port`. Empty / whitespace clears. Returns
 * false when the env-file write fails.
 */
export const setLocalKey = (port: number, key: string): boolean => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const trimmed = key.trim();
  const name = keyName(port);
  if (!writeEnvFileVars({ [name]: trimmed })) {
    logWarn(
      "local-servers",
      safeDiagnosticMessage`failed to persist local key for a port`,
    );
    return false;
  }
  if (trimmed.length === 0) {
    delete process.env[name];
  } else {
    process.env[name] = trimmed;
  }
  return true;
};
