/**
 * CLI-only localhost doctor routes. Loopback + capability required.
 * CORS/Origin is not a grant — browser Origin is rejected.
 */

import type {
  TDoctorLocalPreference,
  TDoctorLocalReportRequest,
} from "@openllmsh/protocol";
import {
  DOCTOR_LOCAL_PREFERENCE_PATH,
  DOCTOR_LOCAL_REPORT_PATH,
  DOCTOR_LOCAL_STATUS_PATH,
  DOCTOR_REPORT_MAX_BODY_BYTES,
  parseDoctorLocalPreference,
  parseDoctorLocalReportRequest,
} from "@openllmsh/protocol";
import {
  isLoopbackLocalHost,
  localJson as json,
  localAccessFailure,
  readBoundedLocalJson,
} from "../local-http";

export const isLoopbackDoctorHost = isLoopbackLocalHost;

import {
  applyLocalPreferenceAndMaybePurge,
  flushDoctorReport,
  reportingScope,
  reportingStatus,
} from "./engine";
import { writeLocalPreference } from "./preference";

const capabilityDeniedBody = (pathname: string): Record<string, unknown> => {
  if (pathname === DOCTOR_LOCAL_STATUS_PATH) {
    return {
      local_enabled: false,
      account_enabled: false,
      pending_account_sync: false,
      unavailable_reason: "capability_missing",
    };
  }
  return {
    nothing_new: true,
    dry_run: false,
    accepted_count: 0,
    skipped_count: 0,
    gap_count: 0,
    legacy_records_skipped: 0,
    daemon_versions: [],
    pending: false,
    unavailable_reason: "capability_missing",
  };
};

const authorizeLocalDoctor = (
  req: Request,
  pathname: string,
): Response | null => {
  const failure = localAccessFailure(req);
  return failure === null
    ? null
    : json(
        403,
        failure === "capability_missing"
          ? capabilityDeniedBody(pathname)
          : { error: failure },
      );
};

const readJsonBody = (req: Request): Promise<unknown | Response> =>
  readBoundedLocalJson(req, DOCTOR_REPORT_MAX_BODY_BYTES);

export const isDoctorLocalPath = (pathname: string): boolean =>
  pathname === DOCTOR_LOCAL_REPORT_PATH ||
  pathname === DOCTOR_LOCAL_STATUS_PATH ||
  pathname === DOCTOR_LOCAL_PREFERENCE_PATH;

export const handleDoctorLocal = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const denied = authorizeLocalDoctor(req, url.pathname);
  if (denied !== null) return denied;
  if (url.pathname === DOCTOR_LOCAL_STATUS_PATH) {
    if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, reportingStatus());
  }
  if (url.pathname === DOCTOR_LOCAL_REPORT_PATH) {
    if (req.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    let parsed: TDoctorLocalReportRequest;
    try {
      parsed = parseDoctorLocalReportRequest(body);
    } catch {
      return json(400, { error: "invalid" });
    }
    const result = await flushDoctorReport({
      dryRun: parsed.dry_run,
      ...(parsed.reporter_cli_version !== undefined
        ? { reporterCliVersion: parsed.reporter_cli_version }
        : {}),
      trigger: "doctor_manual",
    });
    return json(200, result);
  }
  if (url.pathname === DOCTOR_LOCAL_PREFERENCE_PATH) {
    if (req.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    let parsed: TDoctorLocalPreference;
    try {
      parsed = parseDoctorLocalPreference(body);
    } catch {
      return json(400, { error: "invalid" });
    }
    const scope = reportingScope();
    const scoped = {
      ...parsed,
      origin_scope: scope.originScope,
      account_scope: scope.accountScope,
      ...(parsed.generation !== undefined
        ? { generation: parsed.generation }
        : scope.generation !== null
          ? { generation: scope.generation }
          : {}),
    };
    if (!writeLocalPreference(scoped)) {
      return json(500, { error: "persist_failed" });
    }
    applyLocalPreferenceAndMaybePurge(scoped.enabled);
    return json(200, scoped);
  }
  return json(404, { error: "not found" });
};
