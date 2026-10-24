/**
 * Scan `~/.openllm/run/<client>/<pid>/live.json` for process-live launches.
 *
 * A dir is live only when (1) the pid is still alive and (2) its command
 * still looks like openllm / a vendor CLI. Stale dirs are left for the CLI's
 * own reap (or cleaned best-effort when clearly dead).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isVendorSessionCommand } from "../vendor-commands";
import { runClientRoot } from "./paths";
import type { TLiveRun, TOpenllmClientId } from "./types";

// The live-index filename. Must match the CLI's `LIVE_JSON_NAME`
// (packages/cli/src/clients/live.ts) — kept as a local literal because the
// daemon package never imports the CLI package (layering).
const LIVE_JSON = "live.json";

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we cannot signal it — treat as alive so we
    // never reap another user's run dir.
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
};

/**
 * Batched `ps` for a set of pids — ONE process per scan instead of one per
 * candidate. Returns pid→command. `null` when `ps` is unavailable so callers
 * can distinguish "no process inspector" from "pid not found".
 */
const commandMap = (pids: ReadonlySet<number>): Map<number, string> | null => {
  if (pids.size === 0) return new Map();
  try {
    const out = Bun.spawnSync(
      ["ps", "-o", "pid=,command=", ...[...pids].map((p) => String(p))],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (!out.success && out.stdout.length === 0) return null;
    const map = new Map<number, string>();
    for (const line of out.stdout.toString().split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (match === null) continue;
      const pid = Number.parseInt(match[1] as string, 10);
      const command = (match[2] as string).trim();
      if (Number.isInteger(pid) && command.length > 0) map.set(pid, command);
    }
    return map;
  } catch {
    return null;
  }
};

const parseLiveJson = (
  raw: string,
  client: TOpenllmClientId,
  dirPid: number,
): TLiveRun | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (o.version !== 1) return null;
  const pid = typeof o.pid === "number" ? o.pid : dirPid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cwd = typeof o.cwd === "string" && o.cwd.length > 0 ? o.cwd : null;
  if (cwd === null) return null;
  const host = o.host === "device" || o.host === "local" ? o.host : "local";
  const started =
    typeof o.started_at_ms === "number" && Number.isFinite(o.started_at_ms)
      ? o.started_at_ms
      : 0;
  const openllmId =
    typeof o.openllm_session_id === "string" && o.openllm_session_id.length > 0
      ? o.openllm_session_id
      : null;
  const vendorId =
    typeof o.vendor_session_id === "string" && o.vendor_session_id.length > 0
      ? o.vendor_session_id
      : null;
  const title =
    typeof o.title === "string" && o.title.length > 0 ? o.title : null;
  return {
    client,
    pid,
    cwd,
    started_at_ms: started,
    host,
    openllm_session_id: openllmId,
    vendor_session_id: vendorId,
    title,
  };
};

/** Live runs for one openllm client id. */
export const readLiveRuns = (client: TOpenllmClientId): TLiveRun[] => {
  const root = runClientRoot(client);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  // Pass 1: parse + liveness-gate every candidate, collecting live pids.
  const candidates: Array<{ live: TLiveRun; dir: string; dirPid: number }> = [];
  for (const name of entries) {
    // Dir name must be purely decimal digits (the openllm wrapper pid).
    if (!/^\d+$/.test(name)) continue;
    const dirPid = Number.parseInt(name, 10);
    if (!Number.isInteger(dirPid) || dirPid <= 0) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const livePath = join(dir, LIVE_JSON);
    if (!existsSync(livePath)) continue;
    let raw: string;
    try {
      raw = readFileSync(livePath, "utf8");
    } catch {
      continue;
    }
    const live = parseLiveJson(raw, client, dirPid);
    if (live === null) continue;
    if (!pidAlive(live.pid)) {
      // Only reap when the directory's own pid is dead too — a wrong `pid`
      // in live.json must never delete a running run's metadata.
      if (pidAlive(dirPid)) continue;
      // Best-effort: drop clearly dead run dirs so the index stays small.
      // The CLI also reaps on next launch; never throw.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    candidates.push({ live, dir, dirPid });
  }

  // Pass 2: ONE batched `ps` for command recognition across all candidates.
  const commands = commandMap(new Set(candidates.map((c) => c.live.pid)));
  const out: TLiveRun[] = [];
  for (const { live, dir, dirPid } of candidates) {
    // `ps` unavailable → keep the candidate (liveness already passed); a
    // reused-pid false positive is preferable to dropping every live run.
    const cmd = commands?.get(live.pid);
    if (
      commands !== null &&
      (cmd === undefined || !isVendorSessionCommand(cmd))
    )
      continue;
    // Dir name should match pid; tolerate mismatch if live.json pid is live.
    if (basename(dir) !== String(live.pid) && !pidAlive(dirPid)) continue;
    out.push(live);
  }
  return out;
};
