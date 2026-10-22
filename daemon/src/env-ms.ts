/**
 * Parse a non-negative integer millisecond env override. Shared by launcher
 * resolution, manager resolution, cli-install, and the version cache.
 */

/** Hard ceiling — 7 days. Larger values are almost certainly a misconfig. */
const ENV_MS_MAX = 7 * 24 * 60 * 60 * 1000;

const parseEnvMs = (raw: string): number | undefined => {
  // Full-string digits only — `Number.parseInt("1e3")` is 1, which would
  // silently shrink a timeout to 1 ms instead of falling back.
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > ENV_MS_MAX) return undefined;
  return n;
};

export const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return parseEnvMs(raw) ?? fallback;
};

/**
 * Like {@link envMs}, but returns `undefined` when the env var is unset so
 * callers can keep a different default (e.g. spawn's built-in timeout).
 */
export const envMsOptional = (
  name: string,
  fallbackWhenInvalid: number,
): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return parseEnvMs(raw) ?? fallbackWhenInvalid;
};
