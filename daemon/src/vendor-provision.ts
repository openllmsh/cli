/**
 * Vendor provisioning after an update — Routeboxes only.
 *
 * A Routebox runs `install.sh` once (order / Reset) and after that only
 * self-updates the `openllm` binary; its owner has no SSH or device session
 * to re-run the installer. So when a release adds a vendor (a new provider's
 * CLI, a component a provider now prefers — e.g. Google's `agy` CLI for
 * Antigravity), the updated daemon converges the box on boot.
 *
 * There is ONE vendor list: `install.sh`'s `provision_clis` (with the presence
 * list `PROVISIONED_VENDOR_CLIS` in `packages/cli/src/vendor-provision.ts`).
 * This module only decides WHEN to run it on a box and runs the same trusted
 * path `openllm start` uses (`provisionMissingVendorClis`: the gateway's
 * `/install` in `OPENLLM_INSTALL_MODE=vendors`). Adding a vendor to the
 * installer and the presence list is all it takes for boxes to pick it up.
 *
 * Bounded: background, a minute after boot; at most once per daemon version,
 * and a failed run is retried only after {@link VENDOR_PROVISION_RETRY_MS}.
 * On people's own machines nothing here runs.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  allProvisionedVendorClisPresent,
  provisionMissingVendorClis,
} from "../../src/vendor-provision";
import { stateDir } from "./env";
import { logError, logInfo, safeDiagnosticMessage } from "./logger";
import { isRoutebox } from "./routebox";
import { DAEMON_VERSION } from "./version";

/** Delay after boot, so provisioning never competes with startup. */
export const VENDOR_PROVISION_BOOT_DELAY_MS = 60_000;
/** A failed run is retried no sooner than this (within one version). */
export const VENDOR_PROVISION_RETRY_MS = 6 * 60 * 60 * 1000;

type TAttempt = {
  readonly version: string;
  readonly at_ms: number;
  readonly ok: boolean;
};

export const vendorProvisionStatePath = (): string =>
  join(stateDir(), "vendor-provision.json");

const readAttempt = (path: string): TAttempt | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TAttempt>;
    return typeof parsed.version === "string" &&
      typeof parsed.at_ms === "number" &&
      typeof parsed.ok === "boolean"
      ? (parsed as TAttempt)
      : undefined;
  } catch {
    return undefined;
  }
};

const writeAttempt = (path: string, attempt: TAttempt): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(attempt), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A lost record only means one extra run later.
  }
};

/** Pure: is a run due now, given the last one? */
export const vendorProvisionDue = (
  last: TAttempt | undefined,
  version: string,
  nowMs: number,
): boolean => {
  if (last === undefined || last.version !== version) return true;
  if (last.ok) return false;
  return nowMs - last.at_ms >= VENDOR_PROVISION_RETRY_MS;
};

export type TVendorProvisionResult =
  | "not_routebox"
  | "all_present"
  | "not_due"
  | "provisioned"
  | "failed";

/** Converge the box's vendors through the installer when anything is missing. */
export const runVendorProvisioning = async (
  opts: {
    readonly onRoutebox?: () => boolean;
    readonly allPresent?: () => boolean;
    readonly provision?: () => Promise<number>;
    readonly statePath?: string;
    readonly version?: string;
    readonly now?: () => number;
  } = {},
): Promise<TVendorProvisionResult> => {
  if (!(opts.onRoutebox ?? isRoutebox)()) return "not_routebox";
  const allPresent =
    opts.allPresent ?? (() => allProvisionedVendorClisPresent());
  if (allPresent()) return "all_present";
  const statePath = opts.statePath ?? vendorProvisionStatePath();
  const version = opts.version ?? DAEMON_VERSION;
  const now = opts.now ?? Date.now;
  if (!vendorProvisionDue(readAttempt(statePath), version, now())) {
    return "not_due";
  }
  // Record the attempt BEFORE running, so a crash mid-install still counts.
  writeAttempt(statePath, { version, at_ms: now(), ok: false });
  let code = 1;
  try {
    code = await (opts.provision ?? (() => provisionMissingVendorClis()))();
  } catch (error) {
    logError("vendor-provision", error);
  }
  const ok = code === 0 && allPresent();
  writeAttempt(statePath, { version, at_ms: now(), ok });
  logInfo(
    "vendor-provision",
    ok
      ? safeDiagnosticMessage`missing vendors installed after update`
      : safeDiagnosticMessage`vendor install after update incomplete`,
    { exit_code: code },
  );
  return ok ? "provisioned" : "failed";
};

/**
 * Boot hook: converge vendors once the daemon has settled (Routebox only).
 * A failed attempt tries again after the retry cooldown while the daemon
 * keeps running (a box whose network was down at boot still converges);
 * `runVendorProvisioning`'s own guards decide every attempt.
 */
export const scheduleVendorProvisioning = (): void => {
  if (!isRoutebox()) return;
  const attempt = (delayMs: number): void => {
    setTimeout(() => {
      void runVendorProvisioning()
        .catch((error: unknown): "failed" => {
          logError("vendor-provision", error);
          return "failed";
        })
        .then((outcome) => {
          if (outcome === "failed") attempt(VENDOR_PROVISION_RETRY_MS);
        });
    }, delayMs).unref?.();
  };
  attempt(VENDOR_PROVISION_BOOT_DELAY_MS);
};
