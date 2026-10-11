/** Safe, local-only JWT payload helpers for official CLI credential stores. */

export type TJwtPayload = {
  readonly exp?: unknown;
  readonly sub?: unknown;
};

/** Decode the unverified payload segment. Callers use this only for local
 * expiry/account metadata; authorization always remains the vendor's job. */
export const decodeJwtPayload = (jwt: string): TJwtPayload | null => {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return decoded !== null && typeof decoded === "object"
      ? (decoded as TJwtPayload)
      : null;
  } catch {
    return null;
  }
};

/** JWT `exp` (seconds) as epoch milliseconds, or null when absent/malformed. */
export const jwtExpiryMs = (jwt: string): number | null => {
  const exp = decodeJwtPayload(jwt)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const expiryMs = exp * 1000;
  return Number.isFinite(expiryMs) ? expiryMs : null;
};

/** JWT `sub` claim when it is a non-empty string. */
export const jwtSubject = (jwt: string): string | null => {
  const sub = decodeJwtPayload(jwt)?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
};
