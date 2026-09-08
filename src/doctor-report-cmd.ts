/**
 * Thin CLI caller for daemon-owned doctor reporting. Never collects logs,
 * never uploads to the cloud doctor-reports path, never runs AI diagnosis.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { daemonPort } from "./clients/gateway";
import { CLI_VERSION, cliConfig, daemonStateDir } from "./env";
import {
  DOCTOR_OPAQUE_ID_PATTERN,
  DOCTOR_REPORT_CLI_CONSTANTS,
  opaqueDoctorScope,
  parseDoctorLocalReportResult,
  parseDoctorReportingStatus,
} from "./generated/doctor-report-cli";
import { callOperation } from "./sdk/client";
import { API_OPERATIONS } from "./sdk/generated/operations";

const LOCAL_TIMEOUT_MS = 4_000;
const OFFLINE_ACCOUNT_PENDING =
  "Disabled on this machine; account-wide update pending.";

const C = DOCTOR_REPORT_CLI_CONSTANTS;

const tryParse = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export const DOCTOR_REPORTING_VERBS = [
  "report",
  "opt-out",
  "opt-in",
  "reporting-status",
] as const;

export type TDoctorReportingVerb = (typeof DOCTOR_REPORTING_VERBS)[number];

export const isDoctorReportingVerb = (
  value: string,
): value is TDoctorReportingVerb =>
  (DOCTOR_REPORTING_VERBS as readonly string[]).includes(value);

export const DOCTOR_REPORT_USAGE = `openllm doctor report [--dry-run]
openllm doctor opt-out
openllm doctor opt-in --yes
openllm doctor reporting-status

Request a sanitized diagnostic flush from the running daemon.
Does not run AI diagnosis and does not read raw daemon logs.

  openllm doctor report            flush new observations through the daemon
  openllm doctor report --dry-run  preview the sanitized export; no upload
  openllm doctor opt-out           disable locally at once; then update the account
  openllm doctor opt-in --yes      enable from the current tail after explicit consent
  openllm doctor reporting-status  local, account, pending sync, last ack, daemon version
`;

type TUnavailableReason =
  | "daemon_stopped"
  | "upgrade_required"
  | "capability_missing";

type TLocalPreference = {
  readonly enabled: boolean;
  readonly pending_account_sync: boolean;
  readonly origin_scope?: string;
  readonly account_scope?: string;
  readonly generation?: string;
};

const capabilityPath = (): string =>
  join(daemonStateDir(), C.capabilityFilename);

const localPreferencePath = (): string =>
  join(daemonStateDir(), C.localOptOutFilename);

const loopbackUrl = (path: string): string =>
  `http://127.0.0.1:${daemonPort()}${path}`;

const asOpaqueId = (value: string | undefined): string | undefined =>
  value !== undefined && DOCTOR_OPAQUE_ID_PATTERN.test(value)
    ? value
    : undefined;

const originScopeOf = (): string | undefined => {
  const origin = cliConfig().gatewayUrl.replace(/\/+$/, "");
  return origin.length > 0 ? opaqueDoctorScope("origin", origin) : undefined;
};

const accountScopeOf = (): string => {
  const key = cliConfig().apiKey.trim();
  if (!key.startsWith("sk-llm-"))
    return opaqueDoctorScope("account", "keyless");
  const rest = key.slice("sk-llm-".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) {
    return opaqueDoctorScope("account", "keyless");
  }
  const id = rest.slice(0, dot);
  return opaqueDoctorScope("account", id.length > 0 ? id : "keyless");
};

const readCapability = (): string | null => {
  const path = capabilityPath();
  if (!existsSync(path)) return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) return null;
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
};

const parseLocalPreference = (input: unknown): TLocalPreference | null => {
  if (input === null || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (
    typeof rec.enabled !== "boolean" ||
    typeof rec.pending_account_sync !== "boolean"
  ) {
    return null;
  }
  return {
    enabled: rec.enabled,
    pending_account_sync: rec.pending_account_sync,
    origin_scope: asOpaqueId(
      typeof rec.origin_scope === "string" ? rec.origin_scope : undefined,
    ),
    account_scope: asOpaqueId(
      typeof rec.account_scope === "string" ? rec.account_scope : undefined,
    ),
    generation: asOpaqueId(
      typeof rec.generation === "string" ? rec.generation : undefined,
    ),
  };
};

const readLocalPreferenceFile = (): TLocalPreference | null => {
  const path = localPreferencePath();
  if (!existsSync(path)) return null;
  try {
    return parseLocalPreference(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
};

const localKillSwitchOn = (): boolean => {
  const pref = readLocalPreferenceFile();
  return pref !== null && pref.enabled === false;
};

const writeLocalPreferenceFile = (record: TLocalPreference): boolean => {
  const target = localPreferencePath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(
    dirname(target),
    `.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    chmodSync(target, 0o600);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // renamed or never created
    }
    return false;
  }
};

const unavailableMessage = (reason: TUnavailableReason): string => {
  if (reason === "daemon_stopped") {
    return "Doctor reporting is unavailable: the local daemon is not running. Start it with `openllm start`, then retry. Legacy `openllm doctor --no-ai` remains the manual support fallback.";
  }
  if (reason === "capability_missing") {
    return "Doctor reporting is unavailable: the local capability file is missing. Upgrade the daemon, then retry.";
  }
  return "Doctor reporting is unavailable: this daemon is too old. Upgrade OpenLLM, then retry.";
};

type TLocalHttpResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly reason: TUnavailableReason };

const localFetch = async (
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
): Promise<TLocalHttpResult> => {
  const token = readCapability();
  if (token === null) {
    try {
      const probe = await fetch(loopbackUrl("/status"), {
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
        headers: { Host: "127.0.0.1" },
      });
      return {
        ok: false,
        reason: probe.ok ? "upgrade_required" : "daemon_stopped",
      };
    } catch {
      return { ok: false, reason: "daemon_stopped" };
    }
  }
  try {
    const res = await fetch(loopbackUrl(path), {
      method,
      headers: {
        Host: "127.0.0.1",
        [C.capabilityHeader]: token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { ok: false, reason: "upgrade_required" };
    }
    const ct = res.headers.get("content-type") ?? "";
    const parsed: unknown = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text();
    return { ok: true, status: res.status, body: parsed };
  } catch {
    return { ok: false, reason: "daemon_stopped" };
  }
};

const diagnosticsPreferenceOp = API_OPERATIONS.find(
  (op) => op.path === "/user/daemon-diagnostics" && op.method === "patch",
);

const patchCloudPreference = async (enabled: boolean): Promise<boolean> => {
  const { gatewayUrl, apiKey } = cliConfig();
  if (apiKey.length === 0 || diagnosticsPreferenceOp === undefined)
    return false;
  try {
    const res = await callOperation(
      { baseUrl: gatewayUrl, apiKey },
      diagnosticsPreferenceOp,
      { body: { [C.extraKey]: enabled } },
    );
    if (!res.ok) return false;
    if (res.body === null || typeof res.body !== "object") return res.ok;
    const rec = res.body as Record<string, unknown>;
    return rec[C.extraKey] === enabled;
  } catch {
    return false;
  }
};

const printUnavailable = (reason: TUnavailableReason): number => {
  process.stderr.write(`${unavailableMessage(reason)}\n`);
  return 1;
};

const runReport = async (args: readonly string[]): Promise<number> => {
  const dryRun = args.includes("--dry-run");
  if (!dryRun && localKillSwitchOn()) {
    process.stdout.write("Reporting is disabled on this machine.\n");
    return 0;
  }
  const result = await localFetch("POST", C.localReportPath, {
    dry_run: dryRun,
    reporter_cli_version: CLI_VERSION,
  });
  if (!result.ok) return printUnavailable(result.reason);
  const parsed = tryParse(() => parseDoctorLocalReportResult(result.body));
  if (parsed === null) {
    if (result.status === 403) {
      process.stdout.write("Reporting is disabled.\n");
      return 0;
    }
    process.stderr.write("Doctor report: unexpected daemon response.\n");
    return 1;
  }
  if (parsed.unavailable_reason !== undefined) {
    return printUnavailable(parsed.unavailable_reason);
  }
  if (parsed.nothing_new) {
    process.stdout.write("Nothing new to report.\n");
    return 0;
  }
  const versions =
    parsed.daemon_versions.length > 0
      ? parsed.daemon_versions.join(", ")
      : "unknown";
  process.stdout.write(
    `${[
      parsed.dry_run ? "Dry run (not uploaded, cursor unchanged)." : null,
      parsed.report_id !== undefined ? `report ${parsed.report_id}` : null,
      `accepted ${parsed.accepted_count}`,
      `skipped ${parsed.skipped_count}`,
      `gaps ${parsed.gap_count}`,
      `legacy skipped ${parsed.legacy_records_skipped}`,
      `daemon versions ${versions}`,
      parsed.pending ? "pending remains" : "nothing pending",
    ]
      .filter((line): line is string => line !== null)
      .join("\n")}\n`,
  );
  return 0;
};

const stickyDisable = (): TLocalPreference | null => {
  const prior = readLocalPreferenceFile();
  const origin = originScopeOf();
  const originChanged =
    origin !== undefined &&
    prior?.origin_scope !== undefined &&
    prior.origin_scope !== origin;
  const record: TLocalPreference = {
    enabled: false,
    pending_account_sync: true,
    origin_scope: origin ?? asOpaqueId(prior?.origin_scope),
    generation: originChanged ? undefined : asOpaqueId(prior?.generation),
  };
  if (!writeLocalPreferenceFile(record)) return null;
  return record;
};

const runOptOut = async (): Promise<number> => {
  const record = stickyDisable();
  if (record === null) {
    process.stderr.write("Could not write the local disable file.\n");
    return 1;
  }
  await localFetch("POST", C.localPreferencePath, record);
  if (!localKillSwitchOn()) {
    process.stderr.write("Could not persist local disable.\n");
    return 1;
  }
  const accountOk = await patchCloudPreference(false);
  if (accountOk) {
    if (!writeLocalPreferenceFile({ ...record, pending_account_sync: false })) {
      process.stdout.write(`${OFFLINE_ACCOUNT_PENDING}\n`);
      return 0;
    }
    process.stdout.write(
      "Diagnostic reporting disabled on this machine and for the account.\n",
    );
    return 0;
  }
  process.stdout.write(`${OFFLINE_ACCOUNT_PENDING}\n`);
  return 0;
};

const OPT_IN_DISCLOSURE = `Share limited technical diagnostics to help fix local daemon problems.
Reports include daemon version, platform, error codes and timing.
They do not include prompts, responses, credentials or raw log files.
Re-enabling starts from the current tail and does not replay prior history.
Pass --yes to confirm.`;

const runOptIn = async (args: readonly string[]): Promise<number> => {
  if (!args.includes("--yes")) {
    process.stderr.write(`${OPT_IN_DISCLOSURE}\n`);
    return 2;
  }
  const record: TLocalPreference = {
    enabled: true,
    pending_account_sync: true,
    origin_scope: originScopeOf(),
    account_scope: accountScopeOf(),
  };
  if (!writeLocalPreferenceFile(record)) {
    process.stderr.write("Could not write the local preference file.\n");
    return 1;
  }
  await localFetch("POST", C.localPreferencePath, record);
  const accountOk = await patchCloudPreference(true);
  if (accountOk) {
    if (!writeLocalPreferenceFile({ ...record, pending_account_sync: false })) {
      process.stdout.write(
        "Enabled on this machine; account-wide update pending.\n",
      );
      return 0;
    }
    process.stdout.write(
      "Diagnostic reporting enabled. New observations start from the current tail.\n",
    );
    return 0;
  }
  process.stdout.write(
    "Enabled on this machine; account-wide update pending.\n",
  );
  return 0;
};

const runStatus = async (): Promise<number> => {
  const file = readLocalPreferenceFile();
  const result = await localFetch("GET", C.localStatusPath, undefined);
  if (!result.ok) {
    process.stdout.write(
      `${[
        `local enabled: ${file?.enabled === true ? "yes" : "no"}`,
        "account enabled: unknown",
        `pending account sync: ${file?.pending_account_sync === true ? "yes" : "no"}`,
        "last acknowledged report: none",
        "daemon version: unknown",
        unavailableMessage(result.reason),
      ].join("\n")}\n`,
    );
    return 0;
  }
  const parsed = tryParse(() => parseDoctorReportingStatus(result.body));
  if (parsed === null) {
    process.stderr.write("Reporting status: unexpected daemon response.\n");
    return 1;
  }
  process.stdout.write(
    `${[
      `local enabled: ${localKillSwitchOn() ? "no" : parsed.local_enabled ? "yes" : "no"}`,
      `account enabled: ${parsed.account_enabled ? "yes" : "no"}`,
      `pending account sync: ${parsed.pending_account_sync ? "yes" : "no"}`,
      `last acknowledged report: ${parsed.last_acknowledged_report_id ?? "none"}`,
      `daemon version: ${parsed.daemon_version ?? "unknown"}`,
    ].join("\n")}\n`,
  );
  return 0;
};

export const runDoctorReportCommand = async (
  args: readonly string[],
): Promise<number> => {
  const verb = args[0];
  if (verb === undefined || !isDoctorReportingVerb(verb)) {
    process.stderr.write(DOCTOR_REPORT_USAGE);
    return 2;
  }
  const rest = args.slice(1);
  if (rest.includes("-h") || rest.includes("--help") || args.includes("-h")) {
    process.stdout.write(DOCTOR_REPORT_USAGE);
    return 0;
  }
  if (verb === "report") return runReport(rest);
  if (verb === "opt-out") {
    if (rest.length > 0 && rest.some((a) => a !== "-h" && a !== "--help")) {
      process.stderr.write(DOCTOR_REPORT_USAGE);
      return 2;
    }
    return runOptOut();
  }
  if (verb === "opt-in") return runOptIn(rest);
  return runStatus();
};
