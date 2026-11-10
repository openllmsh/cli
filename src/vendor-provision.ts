/**
 * Provision missing vendor CLIs via the trusted installer in
 * `OPENLLM_INSTALL_MODE=vendors` — the same code path as first-run Full
 * install, without downloading the binary or starting the daemon.
 *
 * Used by `openllm start` in Full setup mode AFTER the daemon is already
 * serving, so the keyless → login → start path ends in the same state as an
 * install that already had a key without delaying the listen port.
 */

import { cliConfig } from "./env";
import { awaitPipeCodes, bunSubprocessPeer } from "./process-pipe";
import { isSecureOrigin } from "./self-update";

/** Bound the headless vendor wait inside the installer for start-time runs. */
const VENDOR_WAIT_SECS = "120";

/** Mirror the desktop installer's curl connect budget (`daemon.rs`). */
const CURL_CONNECT_TIMEOUT_SECS = "15";
/** Mirror the desktop installer's curl download budget (`daemon.rs`). */
const CURL_MAX_TIME_SECS = "60";
/**
 * Overall ceiling for the curl|bash pipe (download + vendor wait). Fail soft
 * past this so a hung child never blocks `openllm start`.
 */
const PIPE_TIMEOUT_MS =
  (Number(CURL_MAX_TIME_SECS) + Number(VENDOR_WAIT_SECS) + 30) * 1_000;

/** Spawn seam for tests — mirrors `Bun.spawn`'s call shape. */
export type TVendorProvisionSpawn = (
  ...args: Parameters<typeof Bun.spawn>
) => ReturnType<typeof Bun.spawn>;

export type TProvisionMissingVendorClisDeps = {
  readonly spawn?: TVendorProvisionSpawn;
};

/**
 * Best-effort vendor CLI provisioning. Returns the installer exit code.
 * Callers run this AFTER the daemon is serving — failures are reported and
 * are non-fatal for `openllm start`. Synchronous spawn failures return 1
 * instead of rejecting; if bash fails to start after curl started, curl is
 * killed before returning.
 */
export const provisionMissingVendorClis = async (
  deps?: TProvisionMissingVendorClisDeps,
): Promise<number> => {
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    process.stderr.write(
      `[start] skipping vendor provisioning over an insecure origin (${gatewayUrl})\n`,
    );
    return 0;
  }

  const url = `${gatewayUrl}/install`;
  process.stderr.write(`[start] provisioning missing vendor CLIs via ${url}\n`);

  const spawn: TVendorProvisionSpawn = deps?.spawn ?? Bun.spawn.bind(Bun);

  let curl: ReturnType<typeof Bun.spawn>;
  try {
    curl = spawn(
      [
        "curl",
        "-fsSL",
        "--connect-timeout",
        CURL_CONNECT_TIMEOUT_SECS,
        "--max-time",
        CURL_MAX_TIME_SECS,
        url,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        env: process.env,
      },
    );
  } catch {
    process.stderr.write(
      `[start] vendor provisioning failed to start curl — daemon already running\n`,
    );
    return 1;
  }

  let bash: ReturnType<typeof Bun.spawn>;
  try {
    bash = spawn(["bash", "-s", "--", "--no-start", "--no-shell-setup"], {
      stdin: curl.stdout,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        OPENLLM_CLOUD_ORIGIN: gatewayUrl,
        OPENLLM_INSTALL_MODE: "vendors",
        OPENLLM_INTERACTIVE: "0",
        OPENLLM_START_DAEMON: "0",
        OPENLLM_VENDOR_WAIT_SECS: VENDOR_WAIT_SECS,
      },
    });
  } catch {
    try {
      curl.kill();
    } catch {
      // already exited
    }
    process.stderr.write(
      `[start] vendor provisioning failed to start bash — daemon already running\n`,
    );
    return 1;
  }

  const curlPeer = bunSubprocessPeer(curl);
  const bashPeer = bunSubprocessPeer(bash);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [curlCode, bashCode] = await Promise.race([
      awaitPipeCodes(curlPeer, bashPeer),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("vendor provisioning timed out"));
        }, PIPE_TIMEOUT_MS);
      }),
    ]);
    if (curlCode !== 0) {
      process.stderr.write(
        `[start] vendor provisioning download failed (curl exit ${curlCode}) — daemon already running\n`,
      );
      return curlCode;
    }
    if (bashCode !== 0) {
      process.stderr.write(
        `[start] vendor provisioning exited ${bashCode} — daemon already running\n`,
      );
    }
    return bashCode;
  } catch {
    try {
      curlPeer.kill();
    } catch {
      // already exited
    }
    try {
      bashPeer.kill();
    } catch {
      // already exited
    }
    if (timedOut) {
      process.stderr.write(
        `[start] vendor provisioning timed out after ${PIPE_TIMEOUT_MS}ms — daemon already running\n`,
      );
    } else {
      process.stderr.write(
        `[start] vendor provisioning failed — daemon already running\n`,
      );
    }
    return 1;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
