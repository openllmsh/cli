/**
 * CLI-local runtime contracts.
 *
 * Keep these small wire-compatible primitives in the compiled CLI rather than
 * importing a workspace package: published CLI binaries must remain standalone.
 */

/** The public syntax of OpenLLM keys minted by the vault. */
export const OPENLLM_API_KEY_PREFIX = "sk-llm-";
export const OPENLLM_API_KEY_ID_LENGTH = 14;
export const OPENLLM_API_KEY_SECRET_LENGTH = 43;

export type TCredentialGateMode = "human" | "machine";

export type TCredentialGateTerminal = {
  readonly isInteractive: () => boolean;
  readonly promptForKey: () => string | null;
  readonly write: (message: string) => void;
};

const BASE64URL = "[A-Za-z0-9_-]";

export const openllmApiKeyPattern = new RegExp(
  `^${OPENLLM_API_KEY_PREFIX}${BASE64URL}{${OPENLLM_API_KEY_ID_LENGTH}}\\.${BASE64URL}{${OPENLLM_API_KEY_SECRET_LENGTH}}$`,
);

/** Returns whether a value has the exact syntax of a minted OpenLLM API key. */
export const isOpenllmApiKeySyntax = (value: string): boolean =>
  openllmApiKeyPattern.test(value);

/** Normalize nullable configuration input before applying the public syntax. */
export const isUsableOpenllmApiKey = (
  value: string | null | undefined,
): boolean =>
  value !== null && value !== undefined && isOpenllmApiKeySyntax(value.trim());

/** Parse a daemon port from an env-file compatible scalar. */
export const parseOpenllmDaemonPort = (
  raw: string,
  fallback: number,
): number => {
  const trimmed = raw.trim();
  // Strip an inline `# comment` suffix BEFORE outer quotes so a quoted value
  // followed by a comment (`"59321" # local`) unwraps to its number rather than
  // failing on the trailing quote. Must match packages/protocol/daemon-port.ts.
  const decommented = trimmed.replace(/^(.*)\s#.*$/, "$1").trim();
  const unquoted =
    decommented.startsWith('"') &&
    decommented.endsWith('"') &&
    decommented.length >= 2
      ? decommented.slice(1, -1)
      : decommented.startsWith("'") &&
          decommented.endsWith("'") &&
          decommented.length >= 2
        ? decommented.slice(1, -1)
        : decommented;
  const stripped = unquoted.trim();
  if (!/^\d+$/.test(stripped)) return fallback;
  const parsed = Number.parseInt(stripped, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : fallback;
};
