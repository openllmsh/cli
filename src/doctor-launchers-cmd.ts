/**
 * `openllm doctor launchers` — per installed provider, print the L1 resolution
 * chain (candidate → resolved path → kind/adapter → interpreter) and whether
 * the isolated runtime env (L2) would apply. Runs in the CLI process with the
 * user's PATH (not the daemon service PATH) so the report matches what a
 * login shell would resolve.
 */
import { existsSync } from "node:fs";
import {
  isResolvedLauncherRunnable,
  pickFirstRunnableHostCandidate,
} from "../daemon/src/cli-install";
import type { TCliProvider } from "../daemon/src/cli-paths";
import {
  CLI_PROVIDERS,
  cliCommand,
  hostCliCandidates,
} from "../daemon/src/cli-paths";
import type { TLauncherKind } from "../daemon/src/launcher-resolution";
import { createLauncherResolver } from "../daemon/src/launcher-resolution";
import { createManagerRegistry } from "../daemon/src/manager-resolution";

export type TLauncherDoctorRow = {
  readonly provider: TCliProvider;
  readonly installed: boolean;
  readonly candidate: string | null;
  readonly resolvedPath: string | null;
  readonly kind: TLauncherKind | null;
  readonly adapterId: string | null;
  readonly interpreter: string | null;
  readonly underManagerRoot: boolean;
  readonly isolatedEnvApplies: boolean;
  /**
   * How the row was found when it is NOT a daemon-usable install. Login-shell
   * probe hits set `login-shell`; the daemon never enables that probe, so
   * those rows stay `installed: false` with `daemonWillNotUse: true`.
   */
  readonly foundVia: "login-shell" | null;
  readonly daemonWillNotUse: boolean;
};

export const DOCTOR_LAUNCHERS_USAGE = `openllm doctor launchers

For each subscription provider, print the launcher resolution chain
(candidate → realpath → kind/adapter → interpreter) and whether the
isolated HOME/XDG/TMPDIR env would apply on the next delegated spawn.
`;

const collapsedKind = (
  kind: TLauncherKind | null,
): "binary" | "script" | "shim" | "wrapper" | "?" => {
  if (kind === null) return "?";
  if (kind.startsWith("shim:")) return "shim";
  return kind as "binary" | "script" | "wrapper";
};

const adapterLabel = (row: TLauncherDoctorRow): string => {
  if (row.adapterId !== null) return ` adapter=${row.adapterId}`;
  if (row.kind?.startsWith("shim:")) {
    return ` adapter=${row.kind.slice("shim:".length)}`;
  }
  return "";
};

export const formatLauncherDoctorReport = (
  rows: readonly TLauncherDoctorRow[],
): string => {
  const lines: string[] = ["Launcher resolution", ""];
  for (const row of rows) {
    if (!row.installed) {
      if (row.foundVia === "login-shell") {
        // Visible to a login shell, but the daemon never enables that probe —
        // keep installed=false so the report matches the dashboard.
        lines.push(
          `${row.provider}: not installed`,
          `  candidate=${row.candidate ?? "?"}`,
          `  resolved=${row.resolvedPath ?? "?"}`,
          `  found_via=login-shell`,
          `  daemon_will_not_use=yes`,
        );
      } else if (row.candidate !== null) {
        // Candidate exists on disk but demand resolution returned null
        // (e.g. recognized manager shim whose query failed).
        lines.push(
          `${row.provider}: not installed`,
          `  candidate=${row.candidate}`,
          `  resolved=unresolved`,
        );
      } else {
        lines.push(`${row.provider}: not installed`);
      }
      continue;
    }
    lines.push(
      `${row.provider}:`,
      `  candidate=${row.candidate ?? "?"}`,
      `  resolved=${row.resolvedPath ?? "?"}`,
      `  kind=${collapsedKind(row.kind)}${adapterLabel(row)}`,
      `  interpreter=${row.interpreter ?? "(none)"}`,
      `  under_manager_root=${row.underManagerRoot ? "yes" : "no"}`,
      `  isolated_env=${row.isolatedEnvApplies ? "yes" : "no"}`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

const firstExistingCandidate = (provider: TCliProvider): string | null => {
  for (const c of hostCliCandidates(provider)) {
    if (existsSync(c)) return c;
  }
  // Fall back to bare command name so the shell probe can still find it.
  return null;
};

export const collectLauncherDoctorRows = async (): Promise<
  readonly TLauncherDoctorRow[]
> => {
  const resolver = createLauncherResolver({
    managers: createManagerRegistry(),
    persist: false,
  });
  // Probe providers concurrently; map over CLI_PROVIDERS so output order is
  // stable regardless of which resolve finishes first.
  return Promise.all(
    CLI_PROVIDERS.map(async (provider): Promise<TLauncherDoctorRow> => {
      // Same walk as daemon resolveHostBinary demand: skip null /
      // non-runnable resolutions and accept a later candidate.
      const pick = await pickFirstRunnableHostCandidate(
        hostCliCandidates(provider),
        (candidate) =>
          resolver.resolveLauncher(candidate, {
            demand: true,
            enableShellProbe: false,
          }),
      );
      if (pick !== null) {
        const { candidate, resolution } = pick;
        return {
          provider,
          installed: true,
          candidate,
          resolvedPath: resolution.path,
          kind: resolution.kind,
          adapterId: resolution.adapterId ?? null,
          interpreter: resolution.interpreter ?? null,
          underManagerRoot: resolution.underManagerRoot,
          // L2 isolatedRuntimeEnv applies to every installed provider on spawn.
          isolatedEnvApplies: true,
          foundVia: null,
          daemonWillNotUse: false,
        };
      }

      const existing = firstExistingCandidate(provider);
      if (existing !== null) {
        // Something was on disk but every candidate was null / not runnable
        // (e.g. shim query failed, or script with no proven interpreter).
        return {
          provider,
          installed: false,
          candidate: existing,
          resolvedPath: null,
          kind: null,
          adapterId: null,
          interpreter: null,
          underManagerRoot: false,
          isolatedEnvApplies: false,
          foundVia: null,
          daemonWillNotUse: false,
        };
      }

      // Try a login-shell probe on the bare command name. The daemon never
      // enables this probe — surface the hit as shell-only / not installed.
      const probed = await resolver.resolveLauncher(cliCommand(provider), {
        demand: true,
        enableShellProbe: true,
      });
      if (probed === null || !isResolvedLauncherRunnable(probed)) {
        return {
          provider,
          installed: false,
          candidate: null,
          resolvedPath: null,
          kind: null,
          adapterId: null,
          interpreter: null,
          underManagerRoot: false,
          isolatedEnvApplies: false,
          foundVia: null,
          daemonWillNotUse: false,
        };
      }
      return {
        provider,
        installed: false,
        candidate: cliCommand(provider),
        resolvedPath: probed.path,
        kind: probed.kind,
        adapterId: probed.adapterId ?? null,
        interpreter: probed.interpreter ?? null,
        underManagerRoot: probed.underManagerRoot,
        isolatedEnvApplies: false,
        foundVia: "login-shell",
        daemonWillNotUse: true,
      };
    }),
  );
};

export const runDoctorLaunchers = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${DOCTOR_LAUNCHERS_USAGE}\n`);
    return 0;
  }
  const rows = await collectLauncherDoctorRows();
  process.stdout.write(formatLauncherDoctorReport(rows));
  return 0;
};
