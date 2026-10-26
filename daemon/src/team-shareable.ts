/**
 * Vendor-terms hook for team sharing. Every device provider (subscription and
 * local alike) goes through this one gate at grant verify time. Returns true
 * for everything in v1; terms rules plug in later without a protocol change.
 * See `docs/plan/2026-10-26-teams.md` §8.
 */

/**
 * Whether `provider` may be shared with teammates on this device.
 * v1: always true.
 */
export const teamShareable = (_provider: string): boolean => true;
