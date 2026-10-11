/**
 * Shared update plumbing for the single-binary updater (`updater.ts`):
 * in-flight `/v1` request tracking (the restart waits for idle), this host's
 * release target, verified binary + digest fetches, and the exclusive apply
 * lease a restart holds so it never races a login flow.
 */

import { gunzipSync } from "node:zlib";
import type { TCliTarget } from "../../release-types";
import { CLI_TARGETS } from "../../release-types";
import { endDaemonApply, tryBeginDaemonApply } from "./delegation/login-flow";

// Cap on how long we hold the restart waiting for `/v1` requests to drain.
const DRAIN_MAX_MS = 30_000;
const DRAIN_POLL_MS = 250;
// Abort a stalled binary/checksum download — without this a hung connection
// would leave `updating = true` for the rest of the process lifetime, blocking
// every later update attempt.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ─── In-flight `/v1` request tracking (for wait-until-idle restart) ──────────
let inFlightCount = 0;
export const beginRequest = (): void => {
  inFlightCount += 1;
};
export const endRequest = (): void => {
  if (inFlightCount > 0) inFlightCount -= 1;
};
export const inFlight = (): number => inFlightCount;

/**
 * Wrap a streaming response body so `onDone` fires EXACTLY once when the stream
 * finishes — normal end, error, or client cancel. A `/v1` response body keeps
 * flowing after the fetch handler returns, so this is how the in-flight count
 * stays accurate for long streams (and the wait-until-idle restart actually
 * waits for them).
 */
export const trackBodyDone = (
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let settled = false;
  const finish = (): void => {
    if (!settled) {
      settled = true;
      onDone();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
};

/**
 * This host's release target (`darwin-arm64` / `darwin-x64-baseline` /
 * `linux-x64-baseline` / `linux-arm64`), or null if it isn't one we publish.
 * `process.arch` reports `arm64` / `x64`; x64 maps to the `-baseline` variant
 * (the single x64 release target).
 */
export const currentTarget = (): TCliTarget | null => {
  const arch =
    process.arch === "x64"
      ? "x64-baseline"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${process.platform}-${arch}`;
  return (CLI_TARGETS as readonly string[]).includes(t)
    ? (t as TCliTarget)
    : null;
};

/** Fetch a published binary, decompressing the gzipped release asset. */
export const fetchBinary = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`binary download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // The published asset is gzipped (`openllm-<target>.gz`); decompress when the
  // gzip magic bytes (0x1f 0x8b) are present, tolerating a raw binary too. The
  // sha256 is checked against the DECOMPRESSED bytes (what runs), so the gate is
  // gzip-determinism-independent.
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return Buffer.from(gunzipSync(buf));
  }
  return buf;
};

// The `.sha256` endpoint returns `"<hex>  openllm-<target>\n"` — take the hex.
export const fetchDigest = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`checksum download failed: ${res.status}`);
  const text = (await res.text()).trim();
  const hex = text.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("checksum response was not a sha-256 digest");
  }
  return hex.toLowerCase();
};

/** Wait (bounded) for in-flight `/v1` requests to finish. Returns whether the
 *  daemon actually went idle — a caller restarting the daemon defers on false
 *  rather than cut a request off. */
export const waitUntilIdle = async (): Promise<boolean> => {
  const deadline = Date.now() + DRAIN_MAX_MS;
  while (inFlight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
  return inFlight() === 0;
};

/**
 * Exclusive apply lease for a daemon swap. `alreadyHeld` is the explicit
 * `update` command (scheduler apply lane). Passive/catch-up acquire here or
 * skip when auth/apply already owns the process. Successful `process.exit`
 * never reaches the release.
 */
export const withSelfUpdateApply = async (
  alreadyHeld: boolean,
  work: () => Promise<void>,
): Promise<void> => {
  const acquired = alreadyHeld ? false : tryBeginDaemonApply();
  if (!alreadyHeld && !acquired) return;
  try {
    await work();
  } finally {
    if (acquired) endDaemonApply();
  }
};
