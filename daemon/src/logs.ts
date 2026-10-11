/**
 * `openllmd logs [-f] [-n N]` — show or follow daemon logs.
 *
 * launchd writes daemon stdout/stderr to state-dir files, not journald. Linux
 * prefers the user systemd journal when its unit is registered, then falls back
 * to the same state-dir files for from-source and non-systemd installations.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  daemonStderrLogFilePath,
  daemonStdoutLogFilePath,
  logFilePath,
} from "./env";

/** Initial tail length when `-n`/`--lines` isn't given. */
export const DEFAULT_LOG_LINES = 200;
const UNIT = "openllmd.service";

export type TLogsOpts = { readonly follow: boolean; readonly lines: number };

export type TLogSource =
  | { readonly kind: "journal" }
  | { readonly kind: "files"; readonly paths: readonly string[] }
  | { readonly kind: "missing"; readonly paths: readonly string[] };

/**
 * Parse `logs` args: `-f`/`--follow`, and `-n N` / `--lines N` / `-n10` for the
 * initial line count. Returns null on a malformed/unknown token so the caller
 * prints usage and exits non-zero. Pure — unit-testable without spawning.
 */
export const parseLogsArgs = (args: readonly string[]): TLogsOpts | null => {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--follow") {
      follow = true;
      continue;
    }
    let raw: string | undefined;
    if (a === "-n" || a === "--lines") {
      raw = args[++i];
    } else if (a.startsWith("-n")) {
      raw = a.slice(2);
    } else {
      return null;
    }
    if (raw === undefined) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== raw.trim()) return null;
    lines = n;
  }
  return { follow, lines };
};

/** Resolve the concrete log source without spawning, for tests and diagnostics. */
export const resolveLogSource = (
  platform: NodeJS.Platform,
  journalIsAvailable: boolean,
  exists: (path: string) => boolean = existsSync,
): TLogSource => {
  if (platform !== "darwin" && journalIsAvailable) return { kind: "journal" };
  // stdout/stderr are the supervisor-owned logs. The structured app log remains
  // a useful fallback for foreground/from-source runs that have not created them.
  const candidates = [
    daemonStdoutLogFilePath(),
    daemonStderrLogFilePath(),
    logFilePath(),
  ];
  const paths = candidates.filter(exists);
  return paths.length > 0
    ? { kind: "files", paths }
    : { kind: "missing", paths: candidates };
};

/** journalctl present AND the unit known to the user manager (exit 0). */
const journalAvailable = (): boolean => {
  try {
    const unitRegistered =
      spawnSync(
        "systemctl",
        ["--user", "show", "--property", "LoadState", UNIT],
        {
          stdio: "ignore",
        },
      ).status === 0;
    if (!unitRegistered) return false;
    return (
      spawnSync("journalctl", ["--user", "--unit", UNIT, "-n", "0"], {
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
};

const padRight = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

const formatTs = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
};

/** Keep a formatted row on one line: visible escapes for controls and `\`. */
const escapeLogField = (value: string): string => {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
};

const formatMeta = (meta: unknown): string => {
  if (meta === undefined || meta === null) return "";
  if (typeof meta !== "object") return escapeLogField(String(meta));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const raw =
      typeof value === "string"
        ? escapeLogField(value)
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
    const clipped = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
    parts.push(`${key}=${clipped}`);
    if (parts.length >= 6) break;
  }
  return parts.join(" ");
};

/**
 * Turn one daemon log line into a scannable row. Structured JSON becomes
 * `MM-DD HH:MM:SS  level  scope  message  k=v`; anything else (supervisor
 * stdout, journald text, tail file headers) is left readable.
 */
export const formatLogLine = (line: string): string => {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return "";
  const header = trimmed.match(/^==>\s+(.+?)\s+<==$/);
  if (header !== null) return `\n── ${header[1]} ──`;
  if (!trimmed.startsWith("{")) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed === null || typeof parsed !== "object") return trimmed;
  const rec = parsed as Record<string, unknown>;
  const ts = typeof rec.ts === "string" ? formatTs(rec.ts) : "";
  const level = typeof rec.level === "string" ? rec.level.toLowerCase() : "";
  const scope = typeof rec.scope === "string" ? escapeLogField(rec.scope) : "";
  const message =
    typeof rec.message === "string" ? escapeLogField(rec.message) : "";
  if (ts.length === 0 && level.length === 0 && message.length === 0) {
    return trimmed;
  }
  const metaText = formatMeta(rec.meta);
  const row = [ts, padRight(level, 5), padRight(scope, 16), message]
    .filter((part) => part.length > 0)
    .join("  ");
  return metaText.length === 0 ? row : `${row}  ${metaText}`;
};

const writeFormatted = (text: string): void => {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    process.stdout.write(`${formatLogLine(line)}\n`);
  }
};

const runFormattedSync = (command: string, args: readonly string[]): number => {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  writeFormatted(typeof result.stdout === "string" ? result.stdout : "");
  if (result.error !== undefined || result.status === null) return 1;
  return result.status;
};

/** Incremental UTF-8 line splitter so multi-byte chars survive chunk boundaries. */
export const createUtf8LineBuffer = (): {
  readonly push: (chunk: Buffer) => readonly string[];
  readonly flush: () => string;
} => {
  const decoder = new StringDecoder("utf8");
  let leftover = "";
  return {
    push: (chunk: Buffer): readonly string[] => {
      leftover += decoder.write(chunk);
      const parts = leftover.split("\n");
      leftover = parts.pop() ?? "";
      return parts;
    },
    flush: (): string => {
      leftover += decoder.end();
      const rest = leftover;
      leftover = "";
      return rest;
    },
  };
};

const runFormattedFollow = (
  command: string,
  args: readonly string[],
): Promise<number> =>
  new Promise<number>((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines = createUtf8LineBuffer();
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      const leftover = lines.flush();
      if (leftover.length > 0) {
        process.stdout.write(`${formatLogLine(leftover)}\n`);
      }
      resolve(code);
    };
    const onSignal = (): void => {
      child.kill("SIGTERM");
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const part of lines.push(chunk)) {
        process.stdout.write(`${formatLogLine(part)}\n`);
      }
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    child.on("error", () => {
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });

const tailArgs = (
  opts: TLogsOpts,
  paths: readonly string[],
): readonly string[] => {
  const args = ["-n", String(opts.lines)];
  if (opts.follow) args.push("-F");
  args.push(...paths);
  return args;
};

const journalArgs = (opts: TLogsOpts): readonly string[] => {
  const args = ["--user", "--unit", UNIT, "-n", String(opts.lines)];
  if (opts.follow) args.push("-f");
  return args;
};

/** Read the tail of locally available daemon log files for non-interactive diagnostics. */
export const readRecentLogLines = (maxLines = 300): readonly string[] => {
  const source = resolveLogSource(process.platform, false);
  if (source.kind !== "files") return [];
  const output = spawnSync("tail", ["-n", String(maxLines), ...source.paths], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return typeof output.stdout === "string"
    ? output.stdout.split("\n").filter((line) => line.length > 0)
    : [];
};

/** Run the `logs` subcommand. `args` is everything after `logs`. Exits. */
export const runLogs = (args: readonly string[]): void => {
  const opts = parseLogsArgs(args);
  if (opts === null) {
    process.stderr.write("usage: openllmd logs [-f] [-n N]\n");
    process.exit(2);
  }
  const source = resolveLogSource(process.platform, journalAvailable());
  if (source.kind === "missing") {
    process.stderr.write(
      `no daemon logs found; looked in:\n${source.paths.map((path) => `  ${path}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  const command = source.kind === "journal" ? "journalctl" : "tail";
  const commandArgs =
    source.kind === "journal"
      ? journalArgs(opts)
      : tailArgs(opts, source.paths);
  if (!opts.follow) {
    process.exit(runFormattedSync(command, commandArgs));
  }
  void runFormattedFollow(command, commandArgs)
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
};
