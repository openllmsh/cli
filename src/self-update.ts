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

export const runSelfUpdate = async (): Promise<void> => {
  if (CLI_VERSION === "0.0.0-dev") {
    process.stderr.write(
      "[self-update] dev build (0.0.0-dev) never self-updates\n",
    );
    process.exit(0);
  }
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    process.stderr.write(
      `[self-update] refusing to update over an insecure origin (${gatewayUrl}) — use https:// (http:// is allowed only for localhost)\n`,
    );
    process.exit(1);
  }

  const vRes = await fetch(`${gatewayUrl}/api/cli/version`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!vRes.ok) {
    process.stderr.write(
      `[self-update] version check failed: HTTP ${vRes.status}\n`,
    );
    process.exit(1);
  }
  const payload = (await vRes.json().catch(() => null)) as {
    latest_version?: unknown;
  } | null;
  if (payload === null || typeof payload.latest_version !== "string") {
    process.stderr.write(
      "[self-update] malformed version response (no latest_version string)\n",
    );
    process.exit(1);
  }
  const latest = payload.latest_version.replace(/^v/, "");
  if (latest.length === 0) {
    process.stderr.write("[self-update] no CLI release published yet\n");
    process.exit(1);
  }
  if (latest === CLI_VERSION) {
    process.stdout.write(`openllm v${CLI_VERSION} is up to date\n`);
    process.exit(0);
  }

  const target = targetSuffix();
  if (target === null) {
    // No prebuilt binary for this arch — point at the source repo, whose
    // README documents building the host binary (`bun run compile:host`).
    process.stderr.write(
      `[self-update] unsupported host ${process.platform}/${process.arch} — no prebuilt openllm for this arch.\n` +
        `  Build from source: https://github.com/${CLI_RELEASE.repo}#build-from-source\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[self-update] v${CLI_VERSION} → v${latest} (${target})\n`,
  );

  const shaRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}.sha256`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!shaRes.ok) {
    process.stderr.write(
      `[self-update] checksum fetch failed: ${shaRes.status}\n`,
    );
    process.exit(1);
  }
  const expected = (await shaRes.text()).trim().split(/\s+/)[0];

  const binRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!binRes.ok) {
    process.stderr.write(`[self-update] download failed: ${binRes.status}\n`);
    process.exit(1);
  }
  let bytes = Buffer.from(await binRes.arrayBuffer());
  if (bytes.subarray(0, 2).equals(GZIP_MAGIC)) bytes = gunzipSync(bytes);

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    process.stderr.write(
      `[self-update] checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — aborting\n`,
    );
    process.exit(1);
  }

  // Atomic same-directory swap: write next to the running binary, chmod,
  // rename over. The running process keeps its inode; the next invocation
  // picks up the new binary.
  const self = process.execPath;
  const staging = join(dirname(self), `.openllm.next-${process.pid}`);
  fs.writeFileSync(staging, bytes, { mode: 0o755 });
  fs.renameSync(staging, self);
  process.stdout.write(`openllm updated to v${latest}\n`);
};
