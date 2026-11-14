/**
 * `openllm update` — manual full-product update.
 *
 * This is deliberately NOT `openllm self-update` under a friendlier name (see
 * docs/proposals/native-api-key-onboarding.md §13.2). `self-update` swaps only
 * THIS CLI binary; `update` reruns the trusted installer from the effective
 * origin so the daemon AND CLI binaries converge together and installation
 * invariants are re-enforced. The daemon's background auto-update (the
 * `auto-update on|off` preference) is a separate mechanism and is unchanged.
 *
 * The installer is invoked as a real two-process pipeline —
 * `curl -fsSL <origin>/install | bash -s --` — with BOTH children spawned from
 * argv arrays (never an interpolated shell string), and with
 * `OPENLLM_INSTALL_MODE=update` set so the installer skips its first-install
 * side effects (vendor CLI provisioning, shell wiring) and preserves the full
 * env file. The origin is validated with the SAME rule self-update uses, so
 * there is exactly one origin-security contract.
 */

import { pinOmitsHostTarget } from "../release-types";
import { CLI_VERSION, cliConfig } from "./env";
import { awaitPipeCodes, bunSubprocessPeer } from "./process-pipe";
import { cliHostTarget, isSecureOrigin } from "./self-update";

/** Bound on the best-effort pinned-version probe so `update` never hangs on it. */
const VERSION_FETCH_TIMEOUT_MS = 5_000;

type TPinnedCliVersion = {
  readonly latest: string;
  readonly targets: unknown;
};

/**
 * The gateway's pinned CLI version (`GET /api/cli/version`) plus its targets
 * list. Best-effort and never throws — a slow or broken gateway must not block
 * the actual update when the pin is unreachable; when the pin IS readable and
 * omits this host, we refuse the installer (same honesty as self-update).
 */
const fetchPinnedCliVersion = async (
  gatewayUrl: string,
): Promise<TPinnedCliVersion | null> => {
  try {
    const res = await fetch(`${gatewayUrl}/api/cli/version`, {
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      latest_version?: unknown;
      targets?: unknown;
    } | null;
    if (payload === null || typeof payload.latest_version !== "string") {
      return null;
    }
    const latest = payload.latest_version.replace(/^v/, "");
    if (latest.length === 0) return null;
    return { latest, targets: payload.targets };
  } catch {
    return null;
  }
};

/**
 * Run the full-product update. Returns the process exit code: 0 on success, or
 * the failing child's status. Never throws for an expected failure (insecure
 * origin, installer error) — the caller passes the return straight to
 * `process.exit`.
 */
export const runUpdate = async (): Promise<number> => {
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    process.stderr.write(
      `[update] refusing to update over an insecure origin (${gatewayUrl}) — use https:// (http:// is allowed only for localhost)\n`,
    );
    return 1;
  }

  const pin = await fetchPinnedCliVersion(gatewayUrl);
  const host = cliHostTarget();
  if (pin !== null && host !== null && pinOmitsHostTarget(pin.targets, host)) {
    process.stderr.write(
      `[update] pinned v${pin.latest} has no binary for ${host} — staying on v${CLI_VERSION}\n`,
    );
    return 0;
  }

  process.stderr.write(
    pin === null
      ? `[update] current v${CLI_VERSION}\n`
      : pin.latest === CLI_VERSION
        ? `[update] current v${CLI_VERSION} (already the pinned release; reconverging)\n`
        : `[update] current v${CLI_VERSION} → incoming v${pin.latest}\n`,
  );

  const url = `${gatewayUrl}/install`;
  process.stderr.write(`[update] running the installer from ${url}\n`);

  // curl streams the installer script to bash's stdin. Both are argv arrays, so
  // the origin can never be evaluated as shell.
  const curl = Bun.spawn(["curl", "-fsSL", url], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const bash = Bun.spawn(["bash", "-s", "--"], {
    stdin: curl.stdout,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Preserve HOME, proxy vars, and OPENLLM_DAEMON_* selectors by inheriting
      // process.env; pin only the validated origin and the update mode.
      OPENLLM_CLOUD_ORIGIN: gatewayUrl,
      OPENLLM_INSTALL_MODE: "update",
    },
  });

  // Propagate BOTH sides: a failure in either child kills the other so a broken
  // pipeline can't hang, and a curl failure can't be masked by bash exiting 0 on
  // empty input.
  const [curlCode, bashCode] = await awaitPipeCodes(
    bunSubprocessPeer(curl),
    bunSubprocessPeer(bash),
  );
  if (curlCode !== 0) {
    process.stderr.write(`[update] download failed (curl exit ${curlCode})\n`);
    return curlCode;
  }
  return bashCode;
};
