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

import { CLI_VERSION, cliConfig } from "./env";
import { isSecureOrigin } from "./self-update";

/** Bound on the best-effort pinned-version probe so `update` never hangs on it. */
const VERSION_FETCH_TIMEOUT_MS = 5_000;

/**
 * The gateway's pinned CLI version (`GET /api/cli/version`), normalized without
 * a leading `v`, or null when it can't be read. Best-effort and never throws —
 * it only feeds an informational "current → incoming" line, so a slow or broken
 * gateway must not block or fail the actual update.
 */
const fetchPinnedCliVersion = async (
  gatewayUrl: string,
): Promise<string | null> => {
  try {
    const res = await fetch(`${gatewayUrl}/api/cli/version`, {
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      latest_version?: unknown;
    } | null;
    if (payload === null || typeof payload.latest_version !== "string") {
      return null;
    }
    const latest = payload.latest_version.replace(/^v/, "");
    return latest.length > 0 ? latest : null;
  } catch {
    return null;
  }
};

/** Kill the peer process if THIS one exits nonzero, then yield its code. */
const guardExit = (
  proc: Bun.Subprocess,
  peer: Bun.Subprocess,
  killed: { done: boolean },
): Promise<number> =>
  proc.exited.then((code) => {
    if (code !== 0 && !killed.done) {
      killed.done = true;
      try {
        peer.kill();
      } catch {
        // already exited — nothing to signal
      }
    }
    return code;
  });

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

  // Informational current → incoming line before we hand off to the installer.
  // Best-effort: the pinned version covers the CLI binary; the installer also
  // converges the daemon, which may pin its own version.
  const incoming = await fetchPinnedCliVersion(gatewayUrl);
  process.stderr.write(
    incoming === null
      ? `[update] current v${CLI_VERSION}\n`
      : incoming === CLI_VERSION
        ? `[update] current v${CLI_VERSION} (already the pinned release; reconverging)\n`
        : `[update] current v${CLI_VERSION} → incoming v${incoming}\n`,
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
  const killed = { done: false };
  const [curlCode, bashCode] = await Promise.all([
    guardExit(curl, bash, killed),
    guardExit(bash, curl, killed),
  ]);
  if (curlCode !== 0) {
    process.stderr.write(`[update] download failed (curl exit ${curlCode})\n`);
    return curlCode;
  }
  return bashCode;
};
