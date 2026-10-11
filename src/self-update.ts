/**
 * Self-update — converge the installed binary to the gateway's pinned CLI
 * release, the `openllm` twin of the daemon's converge policy:
 *
 *   - `openllm self-update` fetches `GET /api/cli/version` (the committed
 *     manifest tag the gateway serves), compares with the baked
 *     `CLI_VERSION`, and on ANY difference (upgrade or rollback) downloads
 *     `GET /api/cli/binary/<target>` (302 → gzipped release asset), verifies
 *     the DECOMPRESSED bytes against `<target>.sha256`, and atomically
 *     swaps itself via same-directory rename.
 *   - `0.0.0-dev` source builds never self-update (dev guard).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CLI_RELEASE } from "../manifest";
import { CLI_TARGETS } from "../release-types";
import { CLI_VERSION, cliConfig } from "./env";

const FETCH_TIMEOUT_MS = 30_000;

/** This host's release target suffix (`<os>-<arch>`), or null when the
 *  platform/arch isn't one we publish. `process.arch` reports `arm64` / `x64`;
 *  x64 maps to the `-baseline` variant (the single x64 release target). The
 *  result is checked against `CLI_TARGETS` so an unsupported OS (e.g. win32)
 *  returns null too — matching `hostTarget()` in `scripts/verify.ts` and the
 *  daemon's `currentTarget()` — letting the caller fail with a clear message
 *  instead of 404ing on a bogus target. */
const targetSuffix = (): string | null => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch =
    process.arch === "x64"
      ? "x64-baseline"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${os}-${arch}`;
  return (CLI_TARGETS as readonly string[]).includes(t) ? t : null;
};

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Self-update downloads + swaps the running binary — the origin must be
 *  HTTPS (plain HTTP only for loopback dev gateways), or a network MITM
 *  could serve both the binary AND the checksum it's verified against. */
export const isSecureOrigin = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

/** Outcome of one convergence: `updated`/`current` succeed; `skipped` is a
 *  benign no-op (dev build, nothing published); `failed` is an error. */
export type TSelfUpdateResult = "updated" | "current" | "skipped" | "failed";

/**
 * Converge the running binary to the gateway's pinned release. `quiet` (the
 * background launch check) prints nothing; the explicit `openllm self-update`
 * reports each step. Never exits the process — the caller decides.
 */
export const convergeSelf = async (
  opts: { readonly quiet?: boolean } = {},
): Promise<TSelfUpdateResult> => {
  const say = (line: string): void => {
    if (opts.quiet !== true) process.stderr.write(`${line}\n`);
  };
  if (CLI_VERSION === "0.0.0-dev") {
    say("[self-update] dev build (0.0.0-dev) never self-updates");
    return "skipped";
  }
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    say(
      `[self-update] refusing to update over an insecure origin (${gatewayUrl}) — use https:// (http:// is allowed only for localhost)`,
    );
    return "failed";
  }
  try {
    const vRes = await fetch(`${gatewayUrl}/api/cli/version`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!vRes.ok) {
      say(`[self-update] version check failed: HTTP ${vRes.status}`);
      return "failed";
    }
    const payload = (await vRes.json().catch(() => null)) as {
      latest_version?: unknown;
    } | null;
    if (payload === null || typeof payload.latest_version !== "string") {
      say(
        "[self-update] malformed version response (no latest_version string)",
      );
      return "failed";
    }
    const latest = payload.latest_version.replace(/^v/, "");
    if (latest.length === 0) {
      say("[self-update] no CLI release published yet");
      return "skipped";
    }
    if (latest === CLI_VERSION) return "current";

    const target = targetSuffix();
    if (target === null) {
      // No prebuilt binary for this arch — point at the source repo, whose
      // README documents building the host binary (`bun run compile:host`).
      say(
        `[self-update] unsupported host ${process.platform}/${process.arch} — no prebuilt openllm for this arch.\n` +
          `  Build from source: https://github.com/${CLI_RELEASE.repo}#build-from-source`,
      );
      return "failed";
    }
    say(`[self-update] v${CLI_VERSION} → v${latest} (${target})`);

    const shaRes = await fetch(
      `${gatewayUrl}/api/cli/binary/${target}.sha256`,
      {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!shaRes.ok) {
      say(`[self-update] checksum fetch failed: ${shaRes.status}`);
      return "failed";
    }
    const expected = (await shaRes.text()).trim().split(/\s+/)[0];

    const binRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!binRes.ok) {
      say(`[self-update] download failed: ${binRes.status}`);
      return "failed";
    }
    let bytes = Buffer.from(await binRes.arrayBuffer());
    if (bytes.subarray(0, 2).equals(GZIP_MAGIC)) bytes = gunzipSync(bytes);

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      say(
        `[self-update] checksum mismatch (expected ${expected?.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — aborting`,
      );
      return "failed";
    }

    // Atomic same-directory swap: write next to the running binary, chmod,
    // rename over. The running process keeps its inode; the next invocation
    // picks up the new binary. A running daemon notices the new file and
    // restarts only if its own half changed (`daemon/src/updater.ts`).
    const self = process.execPath;
    const staging = join(dirname(self), `.openllm.next-${process.pid}`);
    fs.writeFileSync(staging, bytes, { mode: 0o755 });
    fs.renameSync(staging, self);
    return "updated";
  } catch (err) {
    say(
      `[self-update] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
};

/** `openllm self-update` — the explicit, reporting form. */
export const runSelfUpdate = async (): Promise<void> => {
  const result = await convergeSelf();
  if (result === "updated") process.stdout.write("openllm updated\n");
  if (result === "current")
    process.stdout.write(`openllm v${CLI_VERSION} is up to date\n`);
  process.exit(result === "failed" ? 1 : 0);
};
