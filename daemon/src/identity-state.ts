/**
 * Process-local outcome of publishing the daemon's durable X25519 identity.
 *
 * The cloud pin is intentionally immutable to API-key callers. A regenerated
 * local key therefore needs an explicit browser-session reset before RTC can
 * work again; retain that conflict in status so the owning dashboard can act.
 */
let identityConflict = false;

export const hasIdentityConflict = (): boolean => identityConflict;

export const setIdentityConflict = (value: boolean): void => {
  identityConflict = value;
};
