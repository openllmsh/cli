/**
 * Live-process registry for `openllm <client>` launches.
 *
 * Every session-mode launch materializes an ephemeral overlay under
 * `~/.openllm/run/<client>/<pid>/`. Alongside the overlay we write a small
 * `live.json` the daemon can scan to learn which vendor sessions are
 * process-live and whether they are attachable device PTYs (`host:"device"`)
 * or ordinary local terminals (`host:"local"`).
 *
 * The daemon never steals a local TTY — it only attaches to PTYs it already
 * hosts. `live.json` is the index that makes that distinction cheap.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TClientId } from "./registry";

export const LIVE_JSON_NAME = "live.json";

/** Env the device session-host sets so this process records host=device. */
export const DEVICE_SESSION_ID_ENV = "OPENLLM_DEVICE_SESSION_ID";
export const DEVICE_SESSION_TITLE_ENV = "OPENLLM_DEVICE_TITLE";

export type TLiveHost = "local" | "device";

export type TLiveJson = {
  readonly version: 1;
  readonly client: TClientId;
  readonly pid: number;
  readonly child_pid?: number;
  readonly cwd: string;
  readonly started_at_ms: number;
  readonly host: TLiveHost;
  readonly openllm_session_id?: string;
  readonly vendor_session_id?: string;
  readonly title?: string;
  readonly dangerous?: boolean;
};

/**
 * Best-effort extract of a vendor session id the user already passed on the
 * client argv. Never rewrites args — only reads known resume patterns so
 * `live.json` can key the process to a vendor session without probing stores.
 */
export const parseVendorSessionIdFromArgs = (
  clientId: TClientId,
  args: readonly string[],
): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    // claude / grok: --resume <id> | --resume=<id> | -r <id>
    if (clientId === "claude" || clientId === "grok") {
      if (arg === "--resume" || arg === "-r") {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) return next;
      }
      if (arg.startsWith("--resume=")) {
        const id = arg.slice("--resume=".length);
        if (id.length > 0) return id;
      }
    }
    // codex: `resume <id>` subcommand (first non-flag token after resume)
    if (clientId === "codex" && arg === "resume") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) return next;
    }
    // opencode: --session <id> | --session=<id> | -s <id>
    if (clientId === "opencode") {
      if (arg === "--session" || arg === "-s") {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) return next;
      }
      if (arg.startsWith("--session=")) {
        const id = arg.slice("--session=".length);
        if (id.length > 0) return id;
      }
    }
  }
  return undefined;
};

/** Build the live.json body for this process. */
export const buildLiveJson = (args: {
  readonly clientId: TClientId;
  readonly cwd: string;
  readonly dangerous: boolean;
  readonly userArgs: readonly string[];
  readonly nowMs?: number;
}): TLiveJson => {
  const deviceSessionId = process.env[DEVICE_SESSION_ID_ENV]?.trim();
  const host: TLiveHost =
    deviceSessionId !== undefined && deviceSessionId.length > 0
      ? "device"
      : "local";
  const vendorFromArgs = parseVendorSessionIdFromArgs(
    args.clientId,
    args.userArgs,
  );
  const title = process.env[DEVICE_SESSION_TITLE_ENV]?.trim();
  return {
    version: 1,
    client: args.clientId,
    pid: process.pid,
    cwd: args.cwd,
    started_at_ms: args.nowMs ?? Date.now(),
    host,
    ...(host === "device" && deviceSessionId !== undefined
      ? { openllm_session_id: deviceSessionId }
      : {}),
    ...(vendorFromArgs !== undefined
      ? { vendor_session_id: vendorFromArgs }
      : {}),
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    ...(args.dangerous ? { dangerous: true } : {}),
  };
};

/** Write `live.json` into the run dir (best-effort; never throws). */
export const writeLiveJson = (
  runDir: string,
  live: TLiveJson,
): void => {
  try {
    writeFileSync(join(runDir, LIVE_JSON_NAME), `${JSON.stringify(live)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Overlay still works without the index; the daemon just won't see this
    // process as live until the next successful write.
  }
};
