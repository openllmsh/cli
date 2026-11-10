/**
 * Provision missing vendor CLIs via the trusted installer in
 * `OPENLLM_INSTALL_MODE=vendors` — the same code path as first-run Full
 * install, without downloading the binary or starting the daemon.
 *
 * Used by `openllm start` in Full setup mode AFTER the daemon is already
 * serving, so the keyless → login → start path ends in the same state as an
 * install that already had a key without delaying the listen port.
 */

import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { cliConfig, userHome } from "./env";
import { awaitPipeCodes, bunSubprocessPeer } from "./process-pipe";
import { isSecureOrigin } from "./self-update";

/** True when `path` is a regular file this process can execute (`install.sh -x`). */
const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

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
  /** Override home for dest checks (tests). */
  readonly home?: string;
  /** Override PATH lookup (tests). */
  readonly which?: (command: string) => string | null;
};

/**
 * Vendor CLIs the Full installer provisions — mirrors
 * `build_vendor_status_line` in `packages/cli/install.sh`.
 */
type TVendorPlatformDeps = {
  readonly which: (command: string) => string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
};

/**
 * Antigravity ships only for these platforms (install.sh
 * `antigravity_platform_key`), and the installer needs `unzip` to unpack it;
 * otherwise it reports `antigravity=skipped` and never installs it.
 */
const antigravityInstallable = (deps: TVendorPlatformDeps): boolean => {
  const supported =
    (deps.platform === "darwin" &&
      (deps.arch === "arm64" || deps.arch === "x64")) ||
    (deps.platform === "linux" &&
      (deps.arch === "x64" || deps.arch === "arm64"));
  return supported && deps.which("unzip") !== null;
};

export const PROVISIONED_VENDOR_CLIS: readonly {
  readonly command: string;
  readonly dest: (home: string) => string;
  /** False when the installer would skip it here, so it can't be missing. */
  readonly installable?: (deps: TVendorPlatformDeps) => boolean;
}[] = [
  {
    command: "claude",
    dest: (home) => join(home, ".local", "bin", "claude"),
  },
  {
    command: "codex",
    dest: (home) => join(home, ".local", "bin", "codex"),
  },
  {
    command: "kimi",
    dest: (home) => join(home, ".kimi-code", "bin", "kimi"),
  },
  {
    command: "grok",
    dest: (home) => join(home, ".grok", "bin", "grok"),
  },
  {
    command: "cursor-agent",
    dest: (home) => join(home, ".local", "bin", "cursor-agent"),
  },
  {
    command: "muse",
    dest: (home) => join(home, ".local", "bin", "muse"),
  },
  {
    command: "agy_acp_server.par",
    dest: (home) =>
      join(
        home,
        ".openllm",
        "vendor",
        "antigravity",
        "current",
        "agy_acp_server.par",
      ),
    installable: antigravityInstallable,
  },
];

/** True when every Full-installer vendor CLI is already on PATH or at its dest. */
export const allProvisionedVendorClisPresent = (
  deps: {
    readonly home?: string;
    readonly which?: (command: string) => string | null;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  } = {},
): boolean => {
  const home = deps.home ?? userHome();
  const which =
    deps.which ??
    ((command: string): string | null => Bun.which(command) ?? null);
  const platformDeps: TVendorPlatformDeps = {
    which,
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
  };
  for (const vendor of PROVISIONED_VENDOR_CLIS) {
    if (vendor.installable !== undefined && !vendor.installable(platformDeps))
      continue;
    const onPath = which(vendor.command);
    if (onPath !== null && onPath.length > 0) continue;
    const dest = vendor.dest(home);
    if (isExecutableFile(dest)) continue;
    const localBin = join(home, ".local", "bin", vendor.command);
    if (isExecutableFile(localBin)) continue;
    return false;
  }
  return true;
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

  if (
    allProvisionedVendorClisPresent({
      home: deps?.home,
      which: deps?.which,
    })
  ) {
    process.stderr.write(
      `[start] all vendor CLIs already present — skipping /install fetch\n`,
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
