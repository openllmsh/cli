/**
 * Parse a non-negative integer millisecond env override. Shared by launcher
 * resolution, manager resolution, cli-install, and the version cache.
 */
export const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallbackWhenInvalid;
};
