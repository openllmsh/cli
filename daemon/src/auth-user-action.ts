/**
 * Credential-store identity notifier (LEAF module).
 *
 * Deliberately a LEAF — no `./delegation/login-flow` (or barrel `./delegation`).
 * `login-flow` records identity here; importing login-flow would put `loginSlot`
 * in the temporal dead zone. `observation-cache` is a sibling leaf.
 *
 * Identity changes notify via {@link noteAuthStoreIdentityChange} which bumps
 * the single epoch observers poll. No hook callback.
 */

import { bumpStoreIdentityEpoch } from "./delegation/observation-cache";

/** Credential store identity changed (login/logout/refresh/invalidate). */
export const noteAuthStoreIdentityChange = (slug: string): void => {
  bumpStoreIdentityEpoch(slug);
};
