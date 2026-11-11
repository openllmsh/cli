/**
 * Process-local outcome of publishing the daemon's durable X25519 identity.
 *
 * Under the online-lock model a `409 identity_conflict` means another device
 * now holds this API key. The daemon records the flag for `openllm status` /
 * doctor, then stops via {@link stopForIdentityConflict} so the supervisor
 * does not relaunch into the same conflict.
 */
let identityConflict = false;

export const hasIdentityConflict = (): boolean => identityConflict;

export const setIdentityConflict = (value: boolean): void => {
  identityConflict = value;
};
