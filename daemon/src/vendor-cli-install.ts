/**
 * Passive reader for OpenLLM-started vendor CLI installer progress.
 *
 * `packages/cli/install.sh` writes one bounded JSON file per provider under
 * `$OPENLLM_DIR/vendor-cli-install/<slug>.json`. This module never launches
 * installers, package managers, or provider auth — it only validates, ages, and
 * maps those records onto the wire `cli_install` shape.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { TVendorCliInstall } from "@openllmsh/protocol";
import {
  isOAuthProviderSlug,
  VENDOR_CLI_DETECTION_GRACE_MS,
  VENDOR_CLI_INSTALL_STALE_MS,
  VendorCliInstall,
} from "@openllmsh/protocol";
import { Result, Schema } from "effect";
import { processStartTime } from "./child-supervisor";
import { stateDir } from "./env";

const MAX_RECORD_BYTES = 4_096;

const decodeWire = Schema.decodeUnknownResult(VendorCliInstall);

type TLocalRecord = TVendorCliInstall & {
  readonly provider: string;
  readonly pid?: number;
  readonly process_start?: string;
};

export type TVendorCliInstallClock = () => number;

const defaultNowMs: TVendorCliInstallClock = (): number => Date.now();

const vendorCliInstallRoot = (): string =>
  join(stateDir(), "vendor-cli-install");

const isSafeSlugFile = (slug: string, filePath: string): boolean => {
  if (!isOAuthProviderSlug(slug)) return false;
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    return false;
  }
  if (basename(filePath) !== `${slug}.json`) return false;
  if (!isAbsolute(filePath)) return false;
  const root = resolve(vendorCliInstallRoot());
  let realFile: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(filePath);
  } catch {
    // Root or file may not resolve through realpath yet — fall back to
    // lexical containment under the expected absolute root.
    realRoot = root;
    realFile = resolve(filePath);
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return realFile.startsWith(prefix) && dirname(realFile) === realRoot;
};

const asFiniteInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
};

const parseLocalRecord = (raw: unknown): TLocalRecord | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.attempt_id !== "string" || obj.attempt_id.length < 1) {
    return null;
  }
  if (obj.attempt_id.length > 128) return null;
  if (typeof obj.provider !== "string") return null;
  if (!isOAuthProviderSlug(obj.provider)) return null;
  if (
    obj.stage !== "installing" &&
    obj.stage !== "awaiting_detection" &&
    obj.stage !== "failed" &&
    obj.stage !== "interrupted"
  ) {
    return null;
  }
  const started_at_ms = asFiniteInt(obj.started_at_ms);
  const updated_at_ms = asFiniteInt(obj.updated_at_ms);
  if (started_at_ms === null || updated_at_ms === null) return null;
  if (updated_at_ms < started_at_ms) return null;

  let reason: TVendorCliInstall["reason"];
  if (obj.reason !== undefined) {
    if (
      obj.reason !== "installer_failed" &&
      obj.reason !== "interrupted" &&
      obj.reason !== "detection_timeout"
    ) {
      return null;
    }
    reason = obj.reason;
  }

  let pid: number | undefined;
  if (obj.pid !== undefined) {
    const parsed = asFiniteInt(obj.pid);
    if (parsed === null || parsed < 1) return null;
    pid = parsed;
  }

  let process_start: string | undefined;
  if (obj.process_start !== undefined) {
    if (typeof obj.process_start !== "string") return null;
    if (obj.process_start.length > 128) return null;
    process_start = obj.process_start;
  }

  return {
    attempt_id: obj.attempt_id,
    provider: obj.provider,
    stage: obj.stage,
    started_at_ms,
    updated_at_ms,
    ...(reason !== undefined ? { reason } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(process_start !== undefined ? { process_start } : {}),
  };
};

const workerIsLive = (record: TLocalRecord): boolean => {
  if (record.pid === undefined) return false;
  const liveStart = processStartTime(record.pid);
  if (liveStart === null) return false;
  if (
    record.process_start !== undefined &&
    record.process_start.length > 0 &&
    liveStart !== record.process_start
  ) {
    // PID reused by an unrelated process.
    return false;
  }
  return true;
};

const toWire = (record: TVendorCliInstall): TVendorCliInstall | undefined => {
  const candidate: TVendorCliInstall = {
    attempt_id: record.attempt_id,
    stage: record.stage,
    started_at_ms: record.started_at_ms,
    updated_at_ms: record.updated_at_ms,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
  const decoded = decodeWire(candidate);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const readRawRecord = (slug: string): TLocalRecord | null => {
  if (!isOAuthProviderSlug(slug)) return null;
  const filePath = join(vendorCliInstallRoot(), `${slug}.json`);
  if (!isSafeSlugFile(slug, filePath)) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_RECORD_BYTES) return null;
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (text.length > MAX_RECORD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = parseLocalRecord(parsed);
  if (record === null) return null;
  if (record.provider !== slug) return null;
  return record;
};

export type TReadVendorCliInstallOptions = {
  /** When the host CLI is already present, installer progress is moot. */
  readonly cliInstalled?: boolean;
  /** Wall clock for grace/stale aging; defaults to `Date.now`. */
  readonly nowMs?: TVendorCliInstallClock;
};

/**
 * Map a local installer record to wire metadata. Missing / malformed / stale
 * abandoned work yields `undefined` — never a fabricated `installing` state.
 */
export const readVendorCliInstall = (
  slug: string,
  options?: TReadVendorCliInstallOptions,
): TVendorCliInstall | undefined => {
  try {
    if (options?.cliInstalled === true) return undefined;
    const record = readRawRecord(slug);
    if (record === null) return undefined;

    const now = (options?.nowMs ?? defaultNowMs)();
    const age = Math.max(0, now - record.updated_at_ms);

    if (record.stage === "installing") {
      // Pre-handoff reservation (no pid yet): not evidence of a live installer
      // and not a failure — omit wire metadata until the parent publishes a
      // pid-bearing installing snapshot (or the attempt ends).
      if (record.pid === undefined) {
        return undefined;
      }
      if (workerIsLive(record)) {
        return toWire(record);
      }
      // Dead worker after handoff: surface interruption. Extremely old dead
      // records are dropped. Age alone never invents a still-running installer.
      if (age > VENDOR_CLI_INSTALL_STALE_MS) return undefined;
      return toWire({
        attempt_id: record.attempt_id,
        stage: "interrupted",
        started_at_ms: record.started_at_ms,
        updated_at_ms: record.updated_at_ms,
        reason: "interrupted",
      });
    }

    if (record.stage === "awaiting_detection") {
      if (age > VENDOR_CLI_DETECTION_GRACE_MS) {
        return toWire({
          attempt_id: record.attempt_id,
          stage: "failed",
          started_at_ms: record.started_at_ms,
          updated_at_ms: record.updated_at_ms,
          reason: "detection_timeout",
        });
      }
      return toWire(record);
    }

    if (record.stage === "failed" || record.stage === "interrupted") {
      if (age > VENDOR_CLI_INSTALL_STALE_MS) return undefined;
      return toWire(record);
    }

    return undefined;
  } catch {
    // Passive status must never throw into the snapshot path.
    return undefined;
  }
};

type TCliInstallCarrier = {
  readonly provider: string;
  readonly cli_installed?: boolean;
  readonly cli_install?: TVendorCliInstall;
};

/**
 * Attach installer metadata for the status snapshot. Strips any accidental
 * prior `cli_install` when absent so last-known spreads cannot leak stale
 * progress into a later tick.
 */
export const attachVendorCliInstall = <T extends TCliInstallCarrier>(
  conn: T,
  options?: Pick<TReadVendorCliInstallOptions, "nowMs">,
): T => {
  const meta = readVendorCliInstall(conn.provider, {
    cliInstalled: conn.cli_installed === true,
    ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  if (meta === undefined) {
    if (conn.cli_install === undefined) return conn;
    const { cli_install: _drop, ...rest } = conn;
    return rest as T;
  }
  return { ...conn, cli_install: meta };
};
