/**
 * Single daemon-owned doctor report engine: cursor, spool, upload, debounce.
 * CLI requests flush/preview only. Never mutates provider/cloudState.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type {
  TDaemonReportingPolicy,
  TDoctorLocalReportResult,
  TDoctorReport,
  TDoctorReportAck,
  TDoctorReportEvent,
  TDoctorReportingStatus,
  TDoctorUploadAttemptOutcome,
  TDoctorUploadBlocker,
} from "@openllmsh/protocol";
import {
  DAEMON_DOCTOR_REPORTS_PATH,
  DOCTOR_REPORT_DEBOUNCE_MS,
  DOCTOR_REPORT_MAX_BACKOFF_MS,
  DOCTOR_REPORT_MAX_BODY_BYTES,
  DOCTOR_REPORT_MAX_EVENTS,
  DOCTOR_REPORT_MAX_SPOOL_BYTES,
  DOCTOR_REPORT_PENDING_TTL_MS,
  DOCTOR_REPORT_SCHEMA_VERSION,
  doctorEventHasOutcomeLedger,
  doctorReportingScopeId,
  parseDoctorReport,
  parseDoctorReportAck,
  parseDoctorReportEvent,
  parseDoctorReportReject,
  reportingPolicyAllowsUpload,
  stripDoctorOutcomeLedger,
} from "@openllmsh/protocol";
import { InvalidApiKeyError, NoApiKeyError } from "../cloud-client";
import { getReportingPolicy, getReportingPolicyRevision } from "../config";
import { daemonApiKeyId, daemonEnv, hasApiKey } from "../env";
import { DAEMON_VERSION } from "../version";
import {
  atomicWriteText,
  doctorStatePath,
  readTextFile,
  removeFile,
} from "./files";
import { localDisableSticky, readLocalPreference } from "./preference";
import type { TDoctorObservationInput } from "./record";
import {
  diagnosticsLogPath,
  diagnosticsRotatedPath,
  recordDoctorObservation,
} from "./record";
import { resetDoctorRepeatForTests } from "./repeat";

type TFileId = {
  readonly dev: number;
  readonly ino: number;
};

type TCursor = {
  readonly origin_scope: string;
  readonly account_scope: string;
  readonly generation: string | null;
  readonly live_offset: number;
  readonly rotated_offset: number;
  readonly live_id: TFileId | null;
  readonly rotated_id: TFileId | null;
  readonly last_ack_report_id?: string;
};

type TPending = {
  readonly report: TDoctorReport;
  readonly created_at_ms: number;
  readonly origin_scope: string;
  readonly account_scope: string;
  readonly generation: string | null;
  readonly cursor_after: TCursor;
};

type TUploadResult =
  | { readonly kind: "ack"; readonly ack: TDoctorReportAck }
  | { readonly kind: "reject"; readonly status: number; readonly code: string }
  | { readonly kind: "retry"; readonly retryAfterMs?: number }
  | { readonly kind: "stop" };

type TFlushOpts = {
  readonly dryRun: boolean;
  readonly reporterCliVersion?: string;
  readonly trigger: "doctor_manual" | "proactive_flush";
};

let clock = (): number => Date.now();
let chain: Promise<void> = Promise.resolve();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1_000;
let inFlight = false;
let activeUploadId = 0;
let cloudSuspended = false;
let revokedAtPolicyRevision: number | null = null;
let transitionRevision = 0;
let scheduleTimer: (
  fn: () => void,
  ms: number,
) => ReturnType<typeof setTimeout> = setTimeout;
let clearTimer: (t: ReturnType<typeof setTimeout>) => void = clearTimeout;
let uploadImpl: ((report: TDoctorReport) => Promise<TUploadResult>) | null =
  null;
let notifyObservation: ((event: TDoctorReportEvent) => void) | null = null;
let lastAttemptAtMs: number | null = null;
let lastAttemptOutcome: TDoctorUploadAttemptOutcome | null = null;
let lastAttemptOriginScope: string | null = null;
let lastAttemptAccountScope: string | null = null;
let lastAttemptGeneration: string | null = null;

const cursorPath = (): string => doctorStatePath("doctor-report.cursor.json");
const pendingPath = (): string => doctorStatePath("doctor-report.pending.json");

export const setDoctorEngineClockForTests = (
  fn: (() => number) | null,
): void => {
  clock = fn ?? ((): number => Date.now());
};

export const setDoctorSchedulerForTests = (
  impl: {
    readonly schedule: (
      fn: () => void,
      ms: number,
    ) => ReturnType<typeof setTimeout>;
    readonly clear: (t: ReturnType<typeof setTimeout>) => void;
  } | null,
): void => {
  if (impl === null) {
    scheduleTimer = setTimeout;
    clearTimer = clearTimeout;
    return;
  }
  scheduleTimer = impl.schedule;
  clearTimer = impl.clear;
};

export const setDoctorUploadForTests = (
  fn: ((report: TDoctorReport) => Promise<TUploadResult>) | null,
): void => {
  uploadImpl = fn;
};

export const setDoctorObservationListenerForTests = (
  fn: ((event: TDoctorReportEvent) => void) | null,
): void => {
  notifyObservation = fn;
};

export const reportingScope = (): {
  originScope: string;
  accountScope: string;
  generation: string | null;
  policy: TDaemonReportingPolicy | null;
} => {
  const policy = getReportingPolicy();
  return {
    originScope: doctorReportingScopeId(
      "origin",
      daemonEnv().cloudOrigin.trim(),
    ),
    accountScope: doctorReportingScopeId(
      "account",
      daemonApiKeyId() ?? "keyless",
    ),
    generation: policy?.generation ?? null,
    policy,
  };
};

const readCursor = (): TCursor | null => {
  const raw = readTextFile(cursorPath());
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as TCursor;
    if (
      typeof parsed.origin_scope !== "string" ||
      typeof parsed.account_scope !== "string" ||
      typeof parsed.live_offset !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeCursor = (cursor: TCursor): boolean =>
  atomicWriteText(cursorPath(), `${JSON.stringify(cursor)}\n`);

const readPending = (): TPending | null => {
  const raw = readTextFile(pendingPath());
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as TPending;
    return { ...parsed, report: parseDoctorReport(parsed.report) };
  } catch {
    return null;
  }
};

const writePending = (pending: TPending): boolean => {
  const body = `${JSON.stringify(pending)}\n`;
  if (Buffer.byteLength(body) > DOCTOR_REPORT_MAX_SPOOL_BYTES) return false;
  return atomicWriteText(pendingPath(), body);
};

export const purgePendingReports = (): void => {
  removeFile(pendingPath());
};

const fileStat = (path: string): { size: number; id: TFileId } | null => {
  try {
    const s = statSync(path);
    return { size: s.size, id: { dev: s.dev, ino: s.ino } };
  } catch {
    return null;
  }
};

// Inode only: both journals live in one state directory, and st_dev is
// assigned at mount time (macOS renumbers volumes across reboots), so
// comparing it read an untouched journal as replaced and re-uploaded it whole.
const sameId = (a: TFileId | null, b: TFileId | null): boolean =>
  a !== null && b !== null && a.ino === b.ino;

const tailCursorForScope = (scope: {
  originScope: string;
  accountScope: string;
  generation: string | null;
}): TCursor => {
  const live = fileStat(diagnosticsLogPath());
  const rotated = fileStat(diagnosticsRotatedPath());
  return {
    origin_scope: scope.originScope,
    account_scope: scope.accountScope,
    generation: scope.generation,
    live_offset: live?.size ?? 0,
    rotated_offset: rotated?.size ?? 0,
    live_id: live?.id ?? null,
    rotated_id: rotated?.id ?? null,
  };
};

export const initDoctorCursorAtTail = (): void => {
  const scope = reportingScope();
  if (readCursor() === null) writeCursor(tailCursorForScope(scope));
};

const cursorMatchesScope = (
  cursor: TCursor,
  scope: {
    originScope: string;
    accountScope: string;
    generation: string | null;
  },
): boolean =>
  cursor.origin_scope === scope.originScope &&
  cursor.account_scope === scope.accountScope &&
  cursor.generation === scope.generation;

type TUploadEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly blocker: TDoctorUploadBlocker };

const resolveUploadEligibility = (): TUploadEligibility => {
  if (process.env.NODE_ENV === "development") {
    return { allowed: false, blocker: "development_environment" };
  }
  if (!hasApiKey()) return { allowed: false, blocker: "missing_key" };
  const scope = reportingScope();
  if (scope.policy === null || scope.policy.enabled === false) {
    return { allowed: false, blocker: "inactive_policy" };
  }
  if (!reportingPolicyAllowsUpload(scope.policy, clock())) {
    return { allowed: false, blocker: "expired_policy" };
  }
  if (localDisableSticky()) return { allowed: false, blocker: "local_opt_out" };
  if (revokedAtPolicyRevision !== null) {
    return { allowed: false, blocker: "cloud_revoked" };
  }
  if (cloudSuspended) return { allowed: false, blocker: "cloud_suspended" };
  return { allowed: true };
};

const uploadAllowed = (): boolean => resolveUploadEligibility().allowed;

const pendingMatchesScope = (
  pending: TPending,
  scope: {
    originScope: string;
    accountScope: string;
    generation: string | null;
  },
): boolean =>
  pending.origin_scope === scope.originScope &&
  pending.account_scope === scope.accountScope &&
  pending.generation === scope.generation;

const inScopePending = (): TPending | null => {
  const scope = reportingScope();
  const pending = readPending();
  if (pending === null || !pendingMatchesScope(pending, scope)) return null;
  return pending;
};

const hasEligibleUnconsumedWork = (): boolean => {
  if (!uploadAllowed()) return false;
  const scope = reportingScope();
  const pending = readPending();
  if (pending !== null && pendingMatchesScope(pending, scope)) return true;
  const cursor = readCursor();
  if (cursor === null || !cursorMatchesScope(cursor, scope)) return false;
  return collectWindow(cursor).events.length > 0;
};

const scheduleEligibleWorkIfNeeded = (): void => {
  if (debounceTimer !== null || backoffTimer !== null) return;
  if (!hasEligibleUnconsumedWork()) return;
  scheduleDoctorFlush();
};

const rememberAttempt = (outcome: TDoctorUploadAttemptOutcome): void => {
  const scope = reportingScope();
  lastAttemptAtMs = clock();
  lastAttemptOutcome = outcome;
  lastAttemptOriginScope = scope.originScope;
  lastAttemptAccountScope = scope.accountScope;
  lastAttemptGeneration = scope.generation;
};

const clearAttemptMemory = (): void => {
  lastAttemptAtMs = null;
  lastAttemptOutcome = null;
  lastAttemptOriginScope = null;
  lastAttemptAccountScope = null;
  lastAttemptGeneration = null;
};

const readSlice = (
  path: string,
  start: number,
  end: number,
): { text: string; truncated: boolean } => {
  if (end <= start || !existsSync(path)) return { text: "", truncated: false };
  const len = end - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) return { text: "", truncated: true };
  return {
    text: text.slice(0, lastNl + 1),
    truncated: lastNl + 1 < text.length,
  };
};

/**
 * Pre-consent backfill horizon. Reuses the pending-spool TTL (24h): records
 * older than this are already outside the engine's retention intent, so the
 * first allow after consent only rewinds within that same bound.
 */
const CONSENT_LOOKBACK_MS = DOCTOR_REPORT_PENDING_TTL_MS;

/** Byte offset of the first journal line with observed_at_ms >= cutoff. */
const firstLookbackOffset = (
  path: string,
  size: number,
  cutoffMs: number,
): number | null => {
  if (size <= 0) return null;
  const slice = readSlice(path, 0, size);
  let start = 0;
  let byteOffset = 0;
  while (start < slice.text.length) {
    const nl = slice.text.indexOf("\n", start);
    if (nl === -1) break;
    const line = slice.text.slice(start, nl);
    const chunk = slice.text.slice(start, nl + 1);
    const lineBytes = Buffer.byteLength(chunk);
    start = nl + 1;
    if (line.trim() !== "") {
      try {
        const parsed = parseDoctorReportEvent(JSON.parse(line) as unknown);
        if (parsed.observed_at_ms >= cutoffMs) return byteOffset;
      } catch {
        // Legacy / corrupt lines are skipped the same way collectWindow does.
      }
    }
    byteOffset += lineBytes;
  }
  return null;
};

/**
 * Cursor that rewinds into the diagnostics journal by CONSENT_LOOKBACK_MS so
 * first-consent / same-identity generation transitions can upload the
 * pre-consent window. Account/origin mismatches must not use this.
 */
const lookbackCursorForScope = (scope: {
  originScope: string;
  accountScope: string;
  generation: string | null;
}): TCursor => {
  const cutoffMs = clock() - CONSENT_LOOKBACK_MS;
  const livePath = diagnosticsLogPath();
  const rotatedPath = diagnosticsRotatedPath();
  const live = fileStat(livePath);
  const rotated = fileStat(rotatedPath);
  let liveOffset = live?.size ?? 0;
  let rotatedOffset = rotated?.size ?? 0;
  if (rotated !== null) {
    const rotatedStart = firstLookbackOffset(
      rotatedPath,
      rotated.size,
      cutoffMs,
    );
    if (rotatedStart !== null) {
      rotatedOffset = rotatedStart;
      liveOffset = 0;
    } else if (live !== null) {
      liveOffset =
        firstLookbackOffset(livePath, live.size, cutoffMs) ?? live.size;
    }
  } else if (live !== null) {
    liveOffset =
      firstLookbackOffset(livePath, live.size, cutoffMs) ?? live.size;
  }
  return {
    origin_scope: scope.originScope,
    account_scope: scope.accountScope,
    generation: scope.generation,
    live_offset: liveOffset,
    rotated_offset: rotatedOffset,
    live_id: live?.id ?? null,
    rotated_id: rotated?.id ?? null,
  };
};

const consumeLines = (
  text: string,
  maxEvents: number,
): {
  events: TDoctorReportEvent[];
  consumedBytes: number;
  legacySkipped: number;
} => {
  const events: TDoctorReportEvent[] = [];
  let legacySkipped = 0;
  let consumedBytes = 0;
  let start = 0;
  while (start < text.length && events.length < maxEvents) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    const line = text.slice(start, nl);
    const chunk = text.slice(start, nl + 1);
    const lineBytes = Buffer.byteLength(chunk);
    start = nl + 1;
    consumedBytes += lineBytes;
    if (line.trim() === "") continue;
    try {
      events.push(parseDoctorReportEvent(JSON.parse(line) as unknown));
    } catch {
      legacySkipped += 1;
    }
  }
  return { events, consumedBytes, legacySkipped };
};

const collectWindow = (
  cursor: TCursor,
): {
  events: TDoctorReportEvent[];
  next: TCursor;
  gapCount: number;
  legacySkipped: number;
  suppressed: number;
} => {
  const livePath = diagnosticsLogPath();
  const rotatedPath = diagnosticsRotatedPath();
  const live = fileStat(livePath);
  const rotated = fileStat(rotatedPath);
  let gapCount = 0;
  let rotatedStart = 0;
  let liveStart = 0;
  let readRotated = false;

  if (sameId(cursor.live_id, live?.id ?? null)) {
    liveStart = cursor.live_offset;
    if (live !== null && live.size < liveStart) {
      gapCount += 1;
      liveStart = 0;
    }
    if (sameId(cursor.rotated_id, rotated?.id ?? null)) {
      rotatedStart = cursor.rotated_offset;
      readRotated = rotated !== null && rotated.size > rotatedStart;
      if (rotated !== null && rotated.size < rotatedStart) {
        gapCount += 1;
        rotatedStart = 0;
        readRotated = rotated.size > 0;
      }
    }
  } else if (sameId(cursor.live_id, rotated?.id ?? null)) {
    rotatedStart = cursor.live_offset;
    readRotated = true;
    liveStart = 0;
    if (rotated !== null && rotated.size < rotatedStart) {
      gapCount += 1;
      rotatedStart = 0;
    }
  } else if (cursor.live_id === null && cursor.rotated_id === null) {
    liveStart = cursor.live_offset;
    rotatedStart = cursor.rotated_offset;
    readRotated = rotated !== null && rotated.size > rotatedStart;
    if (live !== null && live.size < liveStart) {
      gapCount += 1;
      liveStart = 0;
    }
    if (rotated !== null && rotated.size < rotatedStart) {
      gapCount += 1;
      rotatedStart = 0;
      readRotated = rotated.size > 0;
    }
  } else {
    if (cursor.live_id !== null) gapCount += 1;
    liveStart = 0;
    readRotated = false;
    rotatedStart = rotated?.size ?? 0;
  }

  const rotatedSlice = readRotated
    ? readSlice(rotatedPath, rotatedStart, rotated?.size ?? 0)
    : { text: "", truncated: false };
  const liveSlice = readSlice(livePath, liveStart, live?.size ?? 0);
  const taken = consumeLines(
    rotatedSlice.text + liveSlice.text,
    DOCTOR_REPORT_MAX_EVENTS,
  );
  const rotatedBytes = Buffer.byteLength(rotatedSlice.text);
  const fromRotated = Math.min(taken.consumedBytes, rotatedBytes);
  const fromLive = taken.consumedBytes - fromRotated;
  const next: TCursor = {
    ...cursor,
    live_offset: liveStart + fromLive,
    rotated_offset: readRotated
      ? rotatedStart + fromRotated
      : (rotated?.size ?? cursor.rotated_offset),
    live_id: live?.id ?? cursor.live_id,
    rotated_id: rotated?.id ?? cursor.rotated_id,
  };
  return {
    events: taken.events,
    next,
    gapCount,
    legacySkipped: taken.legacySkipped,
    suppressed: 0,
  };
};

const ackMatchesBatch = (
  report: TDoctorReport,
  ack: TDoctorReportAck,
): boolean => {
  if (ack.report_id !== report.report_id) return false;
  const expected = report.events.map((e) => e.event_id);
  const got = ack.accepted_event_ids;
  if (got.length !== expected.length) return false;
  if (new Set(got).size !== got.length) return false;
  const want = new Set(expected);
  return got.every((id) => want.has(id));
};

const defaultUpload = async (report: TDoctorReport): Promise<TUploadResult> => {
  const { apiKey, cloudOrigin } = daemonEnv();
  if (apiKey === null) throw new NoApiKeyError();
  const body = JSON.stringify(report);
  if (Buffer.byteLength(body) > DOCTOR_REPORT_MAX_BODY_BYTES) {
    return { kind: "reject", status: 413, code: "oversize" };
  }
  try {
    const resp = await fetch(`${cloudOrigin}${DAEMON_DOCTOR_REPORTS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 200) {
      const ack = parseDoctorReportAck((await resp.json()) as unknown);
      if (!ackMatchesBatch(report, ack)) return { kind: "retry" };
      return { kind: "ack", ack };
    }
    if (resp.status === 401) return { kind: "stop" };
    if (resp.status === 403) {
      let code = "diagnostics_disabled";
      try {
        code = parseDoctorReportReject((await resp.json()) as unknown).code;
      } catch {
        // keep default
      }
      return { kind: "reject", status: 403, code };
    }
    if (resp.status === 413 || resp.status === 422) {
      return {
        kind: "reject",
        status: resp.status,
        code: resp.status === 413 ? "oversize" : "invalid",
      };
    }
    if (resp.status === 429) {
      const ra = resp.headers.get("retry-after");
      const retryAfterMs =
        ra !== null && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
      return { kind: "retry", retryAfterMs };
    }
    return { kind: "retry" };
  } catch (err) {
    if (err instanceof InvalidApiKeyError) return { kind: "stop" };
    return { kind: "retry" };
  }
};

const emptyResult = (
  extras: Partial<TDoctorLocalReportResult> & {
    dry_run: boolean;
  },
): TDoctorLocalReportResult => ({
  nothing_new: extras.nothing_new ?? true,
  dry_run: extras.dry_run,
  accepted_count: extras.accepted_count ?? 0,
  skipped_count: extras.skipped_count ?? 0,
  gap_count: extras.gap_count ?? 0,
  legacy_records_skipped: extras.legacy_records_skipped ?? 0,
  daemon_versions: extras.daemon_versions ?? [],
  pending: extras.pending ?? false,
  ...(extras.report_id !== undefined ? { report_id: extras.report_id } : {}),
  ...(extras.unavailable_reason !== undefined
    ? { unavailable_reason: extras.unavailable_reason }
    : {}),
});

const versionsOf = (events: ReadonlyArray<TDoctorReportEvent>): string[] => {
  const set = new Set<string>();
  for (const e of events) set.add(e.daemon_version);
  return [...set].slice(0, 16);
};

const flushLocked = async (
  opts: TFlushOpts,
): Promise<TDoctorLocalReportResult> => {
  const scope = reportingScope();
  if (localDisableSticky() && !opts.dryRun) {
    purgePendingReports();
    return emptyResult({ dry_run: false, nothing_new: true });
  }

  let cursor = readCursor();
  if (cursor === null) {
    cursor = tailCursorForScope(scope);
    writeCursor(cursor);
  } else if (!cursorMatchesScope(cursor, scope)) {
    purgePendingReports();
    cursor = tailCursorForScope(scope);
    writeCursor(cursor);
  }

  const pending = readPending();
  if (
    pending !== null &&
    (pending.origin_scope !== scope.originScope ||
      pending.account_scope !== scope.accountScope ||
      pending.generation !== scope.generation)
  ) {
    purgePendingReports();
  }

  const aged = readPending();
  if (
    aged !== null &&
    clock() - aged.created_at_ms > DOCTOR_REPORT_PENDING_TTL_MS
  ) {
    purgePendingReports();
  }

  const working = readPending();
  let collected = collectWindow(cursor);
  let report: TDoctorReport;
  let cursorAfter: TCursor;

  if (working !== null) {
    report = working.report;
    if (opts.reporterCliVersion !== undefined) {
      report = {
        ...report,
        reporter_cli_version: opts.reporterCliVersion,
      };
    }
    cursorAfter = working.cursor_after;
    collected = {
      events: [...report.events],
      next: cursorAfter,
      gapCount: report.cursor_gap_count,
      legacySkipped: 0,
      suppressed: report.suppressed_event_count,
    };
  } else {
    if (collected.events.length === 0) {
      writeCursor(collected.next);
      return emptyResult({
        dry_run: opts.dryRun,
        nothing_new: true,
        skipped_count: collected.suppressed,
        gap_count: collected.gapCount,
        legacy_records_skipped: collected.legacySkipped,
      });
    }
    report = parseDoctorReport({
      schema_version: DOCTOR_REPORT_SCHEMA_VERSION,
      report_id: randomUUID(),
      emitted_at_ms: clock(),
      ...(opts.reporterCliVersion !== undefined
        ? { reporter_cli_version: opts.reporterCliVersion }
        : {}),
      cursor_gap_count: collected.gapCount,
      suppressed_event_count: collected.suppressed,
      events: collected.events,
    });
    cursorAfter = collected.next;
  }

  if (opts.dryRun) {
    return {
      nothing_new: false,
      dry_run: true,
      report_id: report.report_id,
      accepted_count: 0,
      skipped_count: collected.suppressed,
      gap_count: collected.gapCount,
      legacy_records_skipped: collected.legacySkipped,
      daemon_versions: versionsOf(report.events),
      pending: readPending() !== null,
    };
  }

  if (!uploadAllowed()) {
    return emptyResult({
      dry_run: false,
      nothing_new: report.events.length === 0,
      skipped_count: collected.suppressed,
      gap_count: collected.gapCount,
      legacy_records_skipped: collected.legacySkipped,
      daemon_versions: versionsOf(report.events),
      pending: false,
    });
  }

  const pendingWritten = writePending({
    report,
    created_at_ms: clock(),
    origin_scope: scope.originScope,
    account_scope: scope.accountScope,
    generation: scope.generation,
    cursor_after: cursorAfter,
  });

  if (inFlight) {
    scheduleEligibleWorkIfNeeded();
    return {
      nothing_new: false,
      dry_run: false,
      report_id: report.report_id,
      accepted_count: 0,
      skipped_count: collected.suppressed,
      gap_count: collected.gapCount,
      legacy_records_skipped: collected.legacySkipped,
      daemon_versions: versionsOf(report.events),
      pending: pendingWritten,
    };
  }

  const uploadId = activeUploadId + 1;
  activeUploadId = uploadId;
  inFlight = true;
  const uploadRevision = transitionRevision;
  try {
    const upload = uploadImpl ?? defaultUpload;
    let result = await upload(report);
    if (
      result.kind === "reject" &&
      result.status === 422 &&
      report.events.some(doctorEventHasOutcomeLedger)
    ) {
      result = await upload(stripDoctorOutcomeLedger(report));
    }
    if (
      uploadRevision !== transitionRevision ||
      !cursorMatchesScope(cursorAfter, reportingScope()) ||
      !uploadAllowed()
    ) {
      if (uploadRevision === transitionRevision) discardReportingWindow();
      return emptyResult({ dry_run: false, report_id: report.report_id });
    }
    if (result.kind === "ack" && !ackMatchesBatch(report, result.ack)) {
      rememberAttempt("retry");
      scheduleRetry(backoffMs);
      return {
        nothing_new: false,
        dry_run: false,
        report_id: report.report_id,
        accepted_count: 0,
        skipped_count: collected.suppressed,
        gap_count: collected.gapCount,
        legacy_records_skipped: collected.legacySkipped,
        daemon_versions: versionsOf(report.events),
        pending: pendingWritten,
      };
    }
    if (result.kind === "ack") {
      rememberAttempt("uploaded");
      writeCursor({
        ...cursorAfter,
        last_ack_report_id: result.ack.report_id,
      });
      purgePendingReports();
      backoffMs = 1_000;
      return {
        nothing_new: false,
        dry_run: false,
        report_id: report.report_id,
        accepted_count: result.ack.accepted_event_ids.length,
        skipped_count: collected.suppressed,
        gap_count: collected.gapCount,
        legacy_records_skipped: collected.legacySkipped,
        daemon_versions: versionsOf(report.events),
        pending: false,
      };
    }
    if (
      result.kind === "stop" ||
      (result.kind === "reject" && result.status === 403)
    ) {
      revokedAtPolicyRevision = getReportingPolicyRevision();
      discardReportingWindow();
      rememberAttempt("stopped");
      return emptyResult({
        dry_run: false,
        report_id: report.report_id,
        pending: false,
        daemon_versions: versionsOf(report.events),
      });
    }
    if (result.kind === "reject") {
      rememberAttempt("rejected");
      purgePendingReports();
      writeCursor(cursorAfter);
      return emptyResult({
        dry_run: false,
        report_id: report.report_id,
        skipped_count: collected.suppressed + report.events.length,
        gap_count: collected.gapCount,
        legacy_records_skipped: collected.legacySkipped,
        daemon_versions: versionsOf(report.events),
        pending: false,
      });
    }
    const wait = Math.min(
      result.retryAfterMs ?? backoffMs,
      DOCTOR_REPORT_MAX_BACKOFF_MS,
    );
    rememberAttempt("retry");
    backoffMs = Math.min(backoffMs * 2, DOCTOR_REPORT_MAX_BACKOFF_MS);
    scheduleRetry(wait);
    return {
      nothing_new: false,
      dry_run: false,
      report_id: report.report_id,
      accepted_count: 0,
      skipped_count: collected.suppressed,
      gap_count: collected.gapCount,
      legacy_records_skipped: collected.legacySkipped,
      daemon_versions: versionsOf(report.events),
      pending: pendingWritten,
    };
  } catch (error) {
    const sameWindow =
      uploadRevision === transitionRevision &&
      cursorMatchesScope(cursorAfter, reportingScope());
    if (sameWindow) {
      rememberAttempt("error");
      if (uploadAllowed()) {
        scheduleRetry(backoffMs);
        backoffMs = Math.min(backoffMs * 2, DOCTOR_REPORT_MAX_BACKOFF_MS);
      }
    }
    throw error;
  } finally {
    if (activeUploadId === uploadId) inFlight = false;
    scheduleEligibleWorkIfNeeded();
  }
};

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

export const flushDoctorReport = (
  opts: TFlushOpts,
): Promise<TDoctorLocalReportResult> => withLock(() => flushLocked(opts));

const scheduleRetry = (delayMs: number): void => {
  if (debounceTimer !== null) {
    clearTimer(debounceTimer);
    debounceTimer = null;
  }
  if (backoffTimer !== null) return;
  backoffTimer = scheduleTimer(() => {
    backoffTimer = null;
    void flushDoctorReport({ dryRun: false, trigger: "proactive_flush" }).catch(
      () => {},
    );
  }, delayMs);
};

export const scheduleDoctorFlush = (): void => {
  if (!uploadAllowed()) return;
  if (backoffTimer !== null) return;
  if (debounceTimer !== null) return;
  debounceTimer = scheduleTimer(() => {
    debounceTimer = null;
    void flushDoctorReport({ dryRun: false, trigger: "proactive_flush" }).catch(
      () => {},
    );
  }, DOCTOR_REPORT_DEBOUNCE_MS);
};

export const observeDoctorEvent = (
  input: TDoctorObservationInput,
): TDoctorReportEvent | null => {
  try {
    const event = recordDoctorObservation(input);
    if (event === null) return null;
    try {
      notifyObservation?.(event);
    } catch {
      // listeners must not break recording
    }
    try {
      if (uploadAllowed()) scheduleDoctorFlush();
    } catch {
      // reporter never recursively reports its own failures
    }
    return event;
  } catch {
    return null;
  }
};

export const reportingStatus = (): TDoctorReportingStatus => {
  const scope = reportingScope();
  const pref = readLocalPreference();
  const cursor = readCursor();
  const policyOn = reportingPolicyAllowsUpload(scope.policy, clock());
  const eligibility = resolveUploadEligibility();
  const cursorInScope =
    cursor !== null && cursorMatchesScope(cursor, scope) ? cursor : null;
  const attemptInScope =
    lastAttemptOutcome !== null &&
    lastAttemptOriginScope === scope.originScope &&
    lastAttemptAccountScope === scope.accountScope &&
    lastAttemptGeneration === scope.generation;
  return {
    local_enabled: !localDisableSticky(),
    account_enabled:
      policyOn && !cloudSuspended && revokedAtPolicyRevision === null,
    pending_account_sync: pref?.pending_account_sync === true,
    ...(cursorInScope?.last_ack_report_id !== undefined
      ? { last_acknowledged_report_id: cursorInScope.last_ack_report_id }
      : {}),
    daemon_version: DAEMON_VERSION,
    upload_eligible: eligibility.allowed,
    ...(eligibility.allowed ? {} : { upload_blocker: eligibility.blocker }),
    pending_report_upload: inScopePending() !== null,
    ...(attemptInScope &&
    lastAttemptAtMs !== null &&
    lastAttemptOutcome !== null
      ? {
          last_attempt_at_ms: lastAttemptAtMs,
          last_attempt_outcome: lastAttemptOutcome,
        }
      : {}),
  };
};

const resetReportingTimers = (): void => {
  transitionRevision += 1;
  purgePendingReports();
  if (debounceTimer !== null) clearTimer(debounceTimer);
  if (backoffTimer !== null) clearTimer(backoffTimer);
  debounceTimer = null;
  backoffTimer = null;
  backoffMs = 1_000;
  clearAttemptMemory();
};

const discardReportingWindow = (): void => {
  resetReportingTimers();
  writeCursor(tailCursorForScope(reportingScope()));
};

/**
 * Arm uploads from a bounded pre-consent lookback instead of the log tip.
 * Used only for first allow / same-identity generation transitions — never
 * after an explicit opt-out, and never across account/origin changes.
 */
const openReportingWindowWithLookback = (): void => {
  resetReportingTimers();
  writeCursor(lookbackCursorForScope(reportingScope()));
  if (hasEligibleUnconsumedWork()) scheduleDoctorFlush();
};

export const applyLocalPreferenceAndMaybePurge = (_enabled: boolean): void => {
  // A local choice starts a new tail window and cannot lift a cloud
  // suspension. Opt-out and opt-in both discard so records written while
  // explicitly disabled are never backfilled; pre-consent backfill is only
  // armed from onBootstrapReportingPolicy.
  discardReportingWindow();
};

export const onBootstrapReportingPolicy = (
  revision: number = getReportingPolicyRevision(),
): void => {
  // An older dynamic-import callback is not evidence of credential recovery.
  if (revision !== getReportingPolicyRevision()) return;
  const scope = reportingScope();
  if (scope.policy === null || scope.policy.enabled === false) {
    cloudSuspended = true;
    discardReportingWindow();
    return;
  }
  if (!reportingPolicyAllowsUpload(scope.policy, clock())) return;
  if (revokedAtPolicyRevision !== null && revision <= revokedAtPolicyRevision) {
    return;
  }
  const recovering = cloudSuspended || revokedAtPolicyRevision !== null;
  cloudSuspended = false;
  revokedAtPolicyRevision = null;
  // Recovery from an explicit cloud disable/revoke must not backfill the
  // opted-out period (discard-on-disable left those records after the old
  // cursor; jumping to the current tip drops them).
  if (recovering) {
    discardReportingWindow();
    return;
  }
  const cursor = readCursor();
  if (cursor === null) {
    openReportingWindowWithLookback();
    return;
  }
  if (!cursorMatchesScope(cursor, scope)) {
    const sameIdentity =
      cursor.origin_scope === scope.originScope &&
      cursor.account_scope === scope.accountScope &&
      cursor.generation === null;
    // Same account/origin with a new generation is the typical first-consent
    // transition (cursor was stamped with generation null before policy
    // arrived). Look back so onboarding failures recorded pre-consent upload.
    // A replaced (non-null) generation or a different account/origin discards — the journal is shared
    // on the machine and must not leak another identity's records.
    if (sameIdentity) openReportingWindowWithLookback();
    else discardReportingWindow();
    return;
  }
  if (hasEligibleUnconsumedWork()) scheduleDoctorFlush();
};

export const resetDoctorEngineForTests = (): void => {
  if (debounceTimer !== null) clearTimer(debounceTimer);
  if (backoffTimer !== null) clearTimer(backoffTimer);
  debounceTimer = null;
  backoffTimer = null;
  backoffMs = 1_000;
  inFlight = false;
  activeUploadId = 0;
  cloudSuspended = false;
  revokedAtPolicyRevision = null;
  transitionRevision = 0;
  scheduleTimer = setTimeout;
  clearTimer = clearTimeout;
  chain = Promise.resolve();
  uploadImpl = null;
  notifyObservation = null;
  clock = (): number => Date.now();
  clearAttemptMemory();
  resetDoctorRepeatForTests();
};
