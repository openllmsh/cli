/**
 * Version-stamped typed diagnostic observations. Closed fields only —
 * never raw message/meta/stack/argv. Stamp daemon_version at write time.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import type {
  TDoctorEventTimings,
  TDoctorOutcomeLedger,
  TDoctorReportEvent,
  TDoctorSeverity,
} from "@openllmsh/protocol";
import {
  isReplaySessionId,
  parseDoctorReportEvent,
  projectDoctorOutcomeLedger,
  projectDoctorTimings,
  sanitizeDoctorScope,
} from "@openllmsh/protocol";
import { DAEMON_VERSION } from "../version";
import { opaqueDoctorCorrelation } from "./correlation";
import { doctorStateDir, doctorStatePath } from "./files";
import { diagnosticMessageText } from "./message";
import { doctorArchitecture, doctorOsStamp, doctorPlatform } from "./platform";

export { opaqueDoctorCorrelation } from "./correlation";

const DIAGNOSTICS_BASENAME = "openllmd.diagnostics.jsonl";
const MAX_DIAGNOSTICS_BYTES = 5 * 1024 * 1024;

export type TDoctorObservationInput = {
  readonly severity: TDoctorSeverity;
  readonly scope: unknown;
  readonly message: unknown;
  readonly correlation_id?: string;
  readonly replay_session_id?: string;
  readonly timings?: TDoctorEventTimings;
  readonly observed_at_ms?: number;
} & TDoctorOutcomeLedger;

let nowMs = (): number => Date.now();
let approxBytes = 0;
let seededFor: string | null = null;

export const setDoctorRecordClockForTests = (
  fn: (() => number) | null,
): void => {
  nowMs = fn ?? ((): number => Date.now());
};

export const diagnosticsLogPath = (): string =>
  doctorStatePath(DIAGNOSTICS_BASENAME);

export const diagnosticsRotatedPath = (): string => `${diagnosticsLogPath()}.1`;

const rotateIfBig = (file: string): void => {
  if (seededFor !== file) {
    try {
      approxBytes = statSync(file).size;
    } catch {
      approxBytes = 0;
    }
    seededFor = file;
  }
  if (approxBytes <= MAX_DIAGNOSTICS_BYTES) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // keep appending
  }
  approxBytes = 0;
};

export const resetDoctorRecordForTests = (): void => {
  approxBytes = 0;
  seededFor = null;
};

export const recordDoctorObservation = (
  input: TDoctorObservationInput,
): TDoctorReportEvent | null => {
  const platform = doctorPlatform();
  const architecture = doctorArchitecture();
  if (platform === null || architecture === null) return null;
  const event: TDoctorReportEvent = {
    event_id: randomUUID(),
    observed_at_ms: input.observed_at_ms ?? nowMs(),
    daemon_version: DAEMON_VERSION,
    platform,
    architecture,
    severity: input.severity,
    scope: sanitizeDoctorScope(input.scope),
    message: diagnosticMessageText(input.message, input.severity),
    ...(opaqueDoctorCorrelation(input.correlation_id) !== undefined
      ? { correlation_id: input.correlation_id }
      : {}),
    ...(isReplaySessionId(input.replay_session_id)
      ? { replay_session_id: input.replay_session_id }
      : {}),
    ...(input.timings !== undefined
      ? { timings: projectDoctorTimings(input.timings) }
      : {}),
    ...projectDoctorOutcomeLedger({ ...input, ...doctorOsStamp() }),
  };
  let parsed: TDoctorReportEvent;
  try {
    parsed = parseDoctorReportEvent(event);
  } catch {
    return null;
  }
  const line = `${JSON.stringify(parsed)}\n`;
  try {
    mkdirSync(doctorStateDir(), { recursive: true, mode: 0o700 });
    const file = diagnosticsLogPath();
    rotateIfBig(file);
    appendFileSync(file, line, { mode: 0o600 });
    approxBytes += Buffer.byteLength(line);
  } catch {
    return parsed;
  }
  return parsed;
};
