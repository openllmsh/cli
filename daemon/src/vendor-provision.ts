/**
 * Vendor provisioning after an update — Routeboxes only.
 *
 * A Routebox runs `install.sh` once (order / Reset) and after that only
 * self-updates the `openllm` binary; its owner has no SSH or device session
 * to re-run the installer. So when a release needs a vendor the box does not
 * have yet (a new provider's CLI, a vendor component a provider now prefers),
 * the updated daemon converges it here, on boot, in the background.
 *
 * Extending: append a {@link TVendorStep} to {@link VENDOR_STEPS}. Each step
 * says whether it is WANTED (its provider is enabled), whether the vendor is
 * PRESENT, and how to INSTALL it with the vendor's official installer. Steps
 * mirror `install.sh` (same URLs, same destinations) so a box ends up as a
 * fresh install would; parity tests keep the URLs in step.
 *
 * Bounded: a step runs at most once per daemon version, and a failed attempt
 * is retried only after {@link VENDOR_PROVISION_RETRY_MS} — never a loop. On
 * people's own machines nothing here runs: they install vendors with the
 * installer themselves.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { antigravityEnabled } from "./antigravity-feature";
import { stateDir } from "./env";
import { logError, logInfo, safeDiagnosticMessage } from "./logger";
import { resolveAntigravityCli } from "./native-runtime/antigravity-headless";
import { isRoutebox } from "./routebox";
import { DAEMON_VERSION } from "./version";

/** Google's official `agy` installer — the same URL `install.sh` runs
 *  (`ANTIGRAVITY_CLI_INSTALLER_URL`; a parity test keeps them equal). */
export const AGY_CLI_INSTALLER_URL =
  "https://antigravity.google/cli/install.sh";

/** Delay after boot, so provisioning never competes with startup. */
export const VENDOR_PROVISION_BOOT_DELAY_MS = 60_000;
/** A failed step is retried no sooner than this (within one version). */
export const VENDOR_PROVISION_RETRY_MS = 6 * 60 * 60 * 1000;
/** One installer run may take at most this long. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type TVendorStep = {
  /** Stable id, also the state key. */
  readonly id: string;
  /** Should this vendor be on the box at all (its provider enabled)? */
  readonly wanted: () => boolean;
  /** Is it already installed? */
  readonly present: () => boolean;
  /** Install it; resolves true on success. */
  readonly install: (run: TShellRun) => Promise<boolean>;
};

export type TShellRun = (
  script: string,
  timeoutMs: number,
) => Promise<{ readonly code: number | null }>;

/** Run `bash -c <script>` with the standard system PATH first (like
 *  `install.sh`'s vendor runs) and the daemon's real HOME. */
const defaultShellRun: TShellRun = async (script, timeoutMs) => {
  const proc = Bun.spawn(["/bin/bash", "-c", script], {
    env: {
      ...process.env,
      HOME: homedir(),
      PATH: `/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    return { code: await proc.exited };
  } finally {
    clearTimeout(timer);
  }
};

/** Pipe an official vendor installer to bash (HTTPS only, retried). */
const officialInstaller = (url: string): string =>
  `set -o pipefail; curl -fsSL --proto '=https' --retry 2 '${url}' | bash`;

export const VENDOR_STEPS: ReadonlyArray<TVendorStep> = [
  {
    // Google's agy CLI: Antigravity inference prefers it (headless
    // stream-json streams; the ACP agent stays the fallback).
    id: "antigravity-cli",
    wanted: antigravityEnabled,
    present: () => resolveAntigravityCli() !== null,
    install: async (run) => {
      const result = await run(
        officialInstaller(AGY_CLI_INSTALLER_URL),
        INSTALL_TIMEOUT_MS,
      );
      return result.code === 0 && resolveAntigravityCli() !== null;
    },
  },
];

// ─── Attempt bookkeeping ───────────────────────────────────────────────────

type TAttempt = {
  readonly version: string;
  readonly at_ms: number;
  readonly ok: boolean;
};

type TAttempts = Record<string, TAttempt>;

export const vendorProvisionStatePath = (): string =>
  join(stateDir(), "vendor-provision.json");

const readAttempts = (path: string): TAttempts => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as TAttempts)
      : {};
  } catch {
    return {};
  }
};

const writeAttempts = (path: string, attempts: TAttempts): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(attempts), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A lost record only means one extra attempt later.
  }
};

/** Pure: should `step` be attempted now, given its last attempt? */
export const vendorStepDue = (
  last: TAttempt | undefined,
  version: string,
  nowMs: number,
): boolean => {
  if (last === undefined || last.version !== version) return true;
  if (last.ok) return false;
  return nowMs - last.at_ms >= VENDOR_PROVISION_RETRY_MS;
};

export type TVendorProvisionOutcome = {
  readonly id: string;
  readonly result: "skipped" | "present" | "not_due" | "installed" | "failed";
};

/**
 * Converge every wanted, missing vendor (Routebox only). Sequential — vendor
 * installers are heavy and a small box should run one at a time.
 */
export const runVendorProvisioning = async (
  opts: {
    readonly steps?: ReadonlyArray<TVendorStep>;
    readonly onRoutebox?: () => boolean;
    readonly run?: TShellRun;
    readonly statePath?: string;
    readonly version?: string;
    readonly now?: () => number;
  } = {},
): Promise<ReadonlyArray<TVendorProvisionOutcome>> => {
  if (!(opts.onRoutebox ?? isRoutebox)()) return [];
  const statePath = opts.statePath ?? vendorProvisionStatePath();
  const version = opts.version ?? DAEMON_VERSION;
  const now = opts.now ?? Date.now;
  const outcomes: TVendorProvisionOutcome[] = [];
  for (const step of opts.steps ?? VENDOR_STEPS) {
    if (!step.wanted()) {
      outcomes.push({ id: step.id, result: "skipped" });
      continue;
    }
    if (step.present()) {
      outcomes.push({ id: step.id, result: "present" });
      continue;
    }
    const attempts = readAttempts(statePath);
    if (!vendorStepDue(attempts[step.id], version, now())) {
      outcomes.push({ id: step.id, result: "not_due" });
      continue;
    }
    // Record the attempt BEFORE running, so a crash mid-install still counts.
    writeAttempts(statePath, {
      ...attempts,
      [step.id]: { version, at_ms: now(), ok: false },
    });
    let ok = false;
    try {
      ok = await step.install(opts.run ?? defaultShellRun);
    } catch (error) {
      logError("vendor-provision", error);
    }
    writeAttempts(statePath, {
      ...readAttempts(statePath),
      [step.id]: { version, at_ms: now(), ok },
    });
    logInfo(
      "vendor-provision",
      ok
        ? safeDiagnosticMessage`vendor installed after update`
        : safeDiagnosticMessage`vendor install after update failed`,
      { step: step.id },
    );
    outcomes.push({ id: step.id, result: ok ? "installed" : "failed" });
  }
  return outcomes;
};

/** Boot hook: converge vendors once the daemon has settled (Routebox only). */
export const scheduleVendorProvisioning = (): void => {
  if (!isRoutebox()) return;
  setTimeout(() => {
    void runVendorProvisioning().catch((error: unknown) =>
      logError("vendor-provision", error),
    );
  }, VENDOR_PROVISION_BOOT_DELAY_MS).unref?.();
};
