/**
 * `openllm doctor launchers` — per installed provider, print the L1 resolution
 * chain (candidate → resolved path → kind/adapter → interpreter) and whether
 * the isolated runtime env (L2) would apply. Runs in the CLI process with the
 * user's PATH (not the daemon service PATH) so the report matches what a
 * login shell would resolve.
 */
import { existsSync } from "node:fs";
import { CLI_PROVIDERS, cliCommand, hostCliCandidates } from "../daemon/src/cli-paths";
import type { TCliProvider } from "../daemon/src/cli-paths";
import {
  createLauncherResolver,
  launcherProfileOf,
} from "../daemon/src/launcher-resolution";
import { createManagerRegistry } from "../daemon/src/manager-resolution";

export type TLauncherDoctorRow = {
  readonly provider: TCliProvider;
  readonly installed: boolean;
  readonly candidate: string | null;
  readonly resolvedPath: string | null;
  readonly kind: string | null;
  readonly adapterId: string | null;
  readonly interpreter: string | null;
  readonly underManagerRoot: boolean;
  readonly isolatedEnvApplies: boolean;
};

export const DOCTOR_LAUNCHERS_USAGE = `openllm doctor launchers

For each subscription provider, print the launcher resolution chain
(candidate → realpath → kind/adapter → interpreter) and whether the
isolated HOME/XDG/TMPDIR env would apply on the next delegated spawn.
`;

export const formatLauncherDoctorReport = (
  rows: readonly TLauncherDoctorRow[],
): string => {
  const lines: string[] = ["Launcher resolution", ""];
  for (const row of rows) {
    if (!row.installed) {
      lines.push(`${row.provider}: not installed`);
      continue;
    }
    const profile =
      row.kind === null
        ? null
        : launcherProfileOf({
            kind: row.kind as "binary" | "script" | "wrapper" | `shim:${string}`,
            path: row.resolvedPath ?? row.candidate ?? "",
            fingerprint: "doctor",
            underManagerRoot: row.underManagerRoot,
            ...(row.adapterId !== null ? { adapterId: row.adapterId } : {}),
            ...(row.interpreter !== null
              ? { interpreter: row.interpreter }
              : {}),
          });
    const kind = profile?.kind ?? row.kind ?? "?";
    const adapter =
      profile?.adapter_id !== undefined && profile.adapter_id !== null
        ? ` adapter=${profile.adapter_id}`
        : row.adapterId !== null
          ? ` adapter=${row.adapterId}`
          : "";
    lines.push(
      `${row.provider}:`,
      `  candidate=${row.candidate ?? "?"}`,
      `  resolved=${row.resolvedPath ?? "?"}`,
      `  kind=${kind}${adapter}`,
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
  const rows: TLauncherDoctorRow[] = [];
  for (const provider of CLI_PROVIDERS) {
    const candidate = firstExistingCandidate(provider);
    if (candidate === null) {
      // Try a login-shell probe on the bare command name.
      const probed = await resolver.resolveLauncher(cliCommand(provider), {
        demand: true,
        enableShellProbe: true,
      });
      if (probed === null) {
        rows.push({
          provider,
          installed: false,
          candidate: null,
          resolvedPath: null,
          kind: null,
          adapterId: null,
          interpreter: null,
          underManagerRoot: false,
          isolatedEnvApplies: false,
        });
        continue;
      }
      rows.push({
        provider,
        installed: true,
        candidate: cliCommand(provider),
        resolvedPath: probed.path,
        kind: probed.kind,
        adapterId: probed.adapterId ?? null,
        interpreter: probed.interpreter ?? null,
        underManagerRoot: probed.underManagerRoot,
        isolatedEnvApplies: true,
      });
      continue;
    }
    const resolved = await resolver.resolveLauncher(candidate, {
      demand: true,
      enableShellProbe: false,
    });
    if (resolved === null) {
      rows.push({
        provider,
        installed: true,
        candidate,
        resolvedPath: null,
        kind: null,
        adapterId: null,
        interpreter: null,
        underManagerRoot: false,
        isolatedEnvApplies: true,
      });
      continue;
    }
    rows.push({
      provider,
      installed: true,
      candidate,
      resolvedPath: resolved.path,
      kind: resolved.kind,
      adapterId: resolved.adapterId ?? null,
      interpreter: resolved.interpreter ?? null,
      underManagerRoot: resolved.underManagerRoot,
      isolatedEnvApplies: true,
    });
  }
  return rows;
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
