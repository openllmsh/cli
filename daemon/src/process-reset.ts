/**
 * Identity-scoped cache reset after the API key changes.
 * Wired from the composition root ({@link main}) into env via
 * {@link installCredentialReset} so env never imports these modules
 * (avoids cycles with status/usage/keypair).
 */
import { clearSessionLostTracker } from "./auth-session-lost";
import { clearCliInstallDoctorStreak } from "./cli-install";
import { clearCliVersionCache } from "./cli-version-cache";
import { clearStoreIdentityEpochs } from "./delegation/observation-cache";
import { clearIdentityKeyCache } from "./keypair";
import { clearQuotaStatusTracker } from "./quota-status-notify";
import { clearLastKnownConnections } from "./status";
import { clearUsageCache } from "./usage-cache";

const run = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // Credential swap must not fail because a cache clear threw.
  }
};

/**
 * Drop identity-scoped in-process caches after the API key changes. Never
 * touches live login/logout ownership — a vendor login is not key-scoped.
 */
export const resetDaemonCredentialState = (): void => {
  run(() => clearUsageCache());
  run(() => clearLastKnownConnections());
  run(() => clearQuotaStatusTracker());
  run(() => clearSessionLostTracker());
  run(() => clearStoreIdentityEpochs());
  run(() => clearCliInstallDoctorStreak());
  run(() => clearCliVersionCache());
  run(() => clearIdentityKeyCache());
};
