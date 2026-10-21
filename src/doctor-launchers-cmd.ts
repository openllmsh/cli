/**
 * `openllm doctor launchers` — per installed provider, print the L1 resolution
 * chain (candidate → resolved path → kind/adapter → interpreter) and whether
 * the isolated runtime env (L2) would apply. Runs in the CLI process with the
 * user's PATH (not the daemon service PATH) so the report matches what a
 * login shell would resolve.
 */
import { existsSync } from "node:fs";
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
      lines.push(`${row.provider}: not installed`);
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
      const candidate = firstExistingCandidate(provider);
      if (candidate === null) {
        // Try a login-shell probe on the bare command name.
        const probed = await resolver.resolveLauncher(cliCommand(provider), {
          demand: true,
          enableShellProbe: true,
        });
        if (probed === null) {
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
          };
        }
        return {
          provider,
          installed: true,
          candidate: cliCommand(provider),
          resolvedPath: probed.path,
          kind: probed.kind,
          adapterId: probed.adapterId ?? null,
          interpreter: probed.interpreter ?? null,
          underManagerRoot: probed.underManagerRoot,
          // L2 isolatedRuntimeEnv applies to every provider on the next spawn.
          isolatedEnvApplies: true,
        };
      }
      const resolved = await resolver.resolveLauncher(candidate, {
        demand: true,
        enableShellProbe: false,
      });
      // Truthful: isolation applies iff the provider is installed (every
      // provider gets shared L2 XDG/HOME/TMPDIR via cliEnv). Unresolved
      // content still installs the link path — still isolated on spawn.
      const installed = true;
      if (resolved === null) {
        return {
          provider,
          installed,
          candidate,
          resolvedPath: null,
          kind: null,
          adapterId: null,
          interpreter: null,
          underManagerRoot: false,
          isolatedEnvApplies: installed,
        };
      }
      return {
        provider,
        installed,
        candidate,
        resolvedPath: resolved.path,
        kind: resolved.kind,
        adapterId: resolved.adapterId ?? null,
        interpreter: resolved.interpreter ?? null,
        underManagerRoot: resolved.underManagerRoot,
        isolatedEnvApplies: installed,
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
