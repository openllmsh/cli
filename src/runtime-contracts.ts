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

/**
 * Extract the public id half of a `sk-llm-{id}.{secret}` key. Shape-only
 * parse (the secret is ignored); returns null on any mismatch.
 */
export const parseApiKeyId = (raw: string): string | null => {
  if (!raw.startsWith(OPENLLM_API_KEY_PREFIX)) return null;
  const rest = raw.slice(OPENLLM_API_KEY_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return rest.slice(0, dot);
};

/** Must match `packages/protocol/api-key-syntax.ts` (parity-tested). */
export const OPENLLM_DEVICE_ANCHOR_LENGTH = 86;

const deviceAnchorPattern = new RegExp(
  `^${BASE64URL}{${OPENLLM_DEVICE_ANCHOR_LENGTH}}$`,
);

/**
 * Split `sk-llm-<id>.<secret>[.<anchor>]` on the LAST dot. Only `key` may
 * ever be stored, logged, or sent; `anchor` goes to `openllm daemon anchor`.
 * Null unless a bare key or a key plus a well-formed device anchor.
 */
export const splitAnchoredApiKey = (
  raw: string,
): { readonly key: string; readonly anchor: string | null } | null => {
  const value = raw.trim();
  if (isOpenllmApiKeySyntax(value)) return { key: value, anchor: null };
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const key = value.slice(0, dot);
  const anchor = value.slice(dot + 1);
  if (!isOpenllmApiKeySyntax(key) || !deviceAnchorPattern.test(anchor)) {
    return null;
  }
  return { key, anchor };
};

/**
 * True when `raw` starts like an OpenLLM key but carries anything after the
 * secret (`sk-llm-<id>.<secret>.<…>`). Must match
 * `packages/protocol/api-key-syntax.ts` (parity-tested).
 */
export const hasOpenllmApiKeySuffix = (raw: string): boolean => {
  const value = raw.trim();
  if (!value.startsWith(OPENLLM_API_KEY_PREFIX)) return false;
  const rest = value.slice(OPENLLM_API_KEY_PREFIX.length);
  const first = rest.indexOf(".");
  return first >= 0 && rest.indexOf(".", first + 1) >= 0;
};

/**
 * The bearer a configured key value may be sent as, or `null` when it must
 * not be sent at all. A well-formed anchored key yields its bare key; a key
 * with a MALFORMED suffix (truncated / wrong-charset anchor, extra dots) is
 * refused outright rather than passed through — it would leak whatever the
 * suffix holds to the cloud as part of the bearer. Anything else is returned
 * as-is for the caller's own syntax check.
 */
export const bearerApiKeyOf = (raw: string): string | null => {
  const split = splitAnchoredApiKey(raw);
  if (split !== null) return split.key;
  return hasOpenllmApiKeySuffix(raw) ? null : raw;
};

/** Parse a daemon port from an env-file compatible scalar. */
/** The default loopback port for the daemon's `/v1/*` + `/whoami` surface. */
export const DEFAULT_DAEMON_PORT = 8787;

/** Dev-mode default port — distinct from prod so a source-run dev daemon can
 *  coexist with the installed daemon on `8787`. */
export const DEV_DEFAULT_DAEMON_PORT = 8788;

/** Dev-mode cloud origin fallback — the local Next server. */
export const DEV_CLOUD_ORIGIN = "http://127.0.0.1:3000";

/** Dev mode (`OPENLLM_DAEMON_DEV=1`): `~/.openllm/.dev.env`, port 8788 and the
 *  local Next origin, for the daemon and every CLI client alike. */
export const isOpenllmDevMode = (): boolean =>
  process.env.OPENLLM_DAEMON_DEV === "1";

export const parseOpenllmDaemonPort = (
  raw: string,
  fallback: number,
): number => {
  const trimmed = raw.trim();
  // Must match packages/protocol/daemon-port.ts. Order depends on WHERE the
  // comment sits relative to the quotes:
  //   "59321 # local"  → comment INSIDE quotes → unwrap first, then de-comment
  //   "59321" # local  → comment OUTSIDE quotes → de-comment first, then unwrap
  //   59321 # local    → bare value with a trailing comment
  const wrapped = (s: string, q: string): boolean =>
    s.length >= 2 && s.startsWith(q) && s.endsWith(q);
  const deComment = (s: string): string =>
    s.replace(/^(.*)\s#.*$/, "$1").trim();
  let value: string;
  if (wrapped(trimmed, '"') || wrapped(trimmed, "'")) {
    value = deComment(trimmed.slice(1, -1));
  } else {
    const decommented = deComment(trimmed);
    value =
      wrapped(decommented, '"') || wrapped(decommented, "'")
        ? decommented.slice(1, -1)
        : decommented;
  }
  const stripped = value.trim();
  if (!/^\d+$/.test(stripped)) return fallback;
  const parsed = Number.parseInt(stripped, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : fallback;
};
