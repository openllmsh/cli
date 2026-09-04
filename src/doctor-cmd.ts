/**
 * `openllm doctor [--fix] [--no-ai] [-c]` — leftover-install report plus
 * local daemon health. The daemon's live `state.json` is intentionally excluded
 * from leftover detection. `--fix` applies safe repairs (currently: remove
 * OpenLLM-owned leftovers and managed regions); the user's own settings survive.
 *
 * After the deterministic sections print, a default-on AI diagnosis (lite)
 * embeds a bounded `openllmd logs -n` tail. A TTY-only stderr spinner covers
 * that wait so the user can see what is still running.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPort } from "./clients/gateway";
import { removeRegion } from "./clients/merge";
import { padRight } from "./commands";
import { managedDaemonBinary } from "./daemon-delegation";
import {
  cliBinPath,
  cliConfig,
  openllmDir,
  sharedFileConfig,
  userHome,
} from "./env";

type TLegacyRegion = {
  readonly path: string;
  readonly begin: string;
  readonly end: string;
};

/** Local copy of the daemon `/status` body. The CLI cannot import
 *  `packages/daemon`; keep this in lockstep with `health.ts` and treat the
 *  newer fields as optional so an older daemon still renders. */
type TKeychainSpawns = {
  readonly attempts: number;
  readonly timeouts: number;
  readonly aborted: number;
  readonly skipped_expired: number;
  readonly skipped: number;
  readonly complete_ok: number;
  readonly complete_fail: number;
  readonly by_verb: Readonly<Record<string, number>>;
};

type TRefreshSpawnsEntry = {
  readonly attempts: number;
  readonly ok: number;
  readonly fail: number;
  readonly abandoned: number;
  readonly cooldown_skips: number;
  readonly backoff_skips: number;
  readonly fallbacks: number;
  readonly lost: number;
};

type TDaemonHealth = {
  readonly version: string;
  readonly port: number;
  readonly sandbox: string;
  readonly cloud_state: string;
  readonly key_configured: boolean;
  readonly pty_sessions: boolean;
  readonly cloud_origin: string;
  readonly uptime_s: number;
  readonly keychain_spawns?: TKeychainSpawns;
  readonly refresh_spawns?: Readonly<Record<string, TRefreshSpawnsEntry>>;
  readonly identity_conflict?: boolean;
};

/** OpenLLM-owned paths the old install model created. */
const legacyPaths = (): readonly string[] => [
  join(openllmDir(), "installed"),
  join(openllmDir(), "backups"),
  join(openllmDir(), "setup"),
  join(userHome(), ".claude", "plugins", "openllm"),
];

/**
 * Files the old installers wrote a managed region into, with the marker pair
 * used in each. Only the region is removed — everything else is the user's.
 */
const legacyRegions = (): readonly TLegacyRegion[] => {
  const home = userHome();
  return [
    {
      path: join(home, ".claude", "CLAUDE.md"),
      begin: "<!-- >>> openllm (managed) >>> -->",
      end: "<!-- <<< openllm (managed) <<< -->",
    },
    {
      path: join(home, ".codex", "config.toml"),
      begin: "# >>> openllm (managed) >>>",
      end: "# <<< openllm (managed) <<<",
    },
    {
      path: join(home, ".grok", "config.toml"),
      begin: "# >>> openllm-ext (managed) >>>",
      end: "# <<< openllm-ext (managed) <<<",
    },
  ];
};

/** Sibling backups the old installers left next to a user's config. */
const legacyBackups = (): readonly string[] => {
  const home = userHome();
  return [
    join(home, ".codex", "config.toml.openllm-bak"),
    join(home, ".config", "raycast", "ai", "providers.yaml.openllm-bak"),
    join(home, ".openllm", "cli.env"),
  ];
};

/** A transitional/legacy binary name that should no longer be primary. */
const legacyBinary = (): string => join(openllmDir(), "bin", "openllmc");

const daemonLogPaths = (): readonly string[] => [
  join(openllmDir(), "openllmd.log"),
  join(openllmDir(), "openllmd.dev.log"),
  join(openllmDir(), "openllmd.out.log"),
  join(openllmDir(), "openllmd.err.log"),
];

const DAEMON_STATUS_TIMEOUT_MS = 1_500;
const DAEMON_STATUS_COMMAND_TIMEOUT_MS = 2_000;
const LOG_WARNING_TAIL_LINES = 400;
const LOG_WARNING_OUTPUT_LIMIT = 8;
const AI_TIMEOUT_MS = 90_000;
const DAEMON_LOG_TIMEOUT_MS = 8_000;
const DAEMON_LOG_LINES = 200;
const DAEMON_LOG_CHAR_LIMIT = 24_000;
const DAEMON_STATUS_COMMAND_CHAR_LIMIT = 12_000;
const LOG_TAIL_MAX_BYTES = 256_000;

const resolveDaemonPort = (): {
  readonly port: number;
  readonly source: string | null;
} => {
  if (process.env.OPENLLM_DAEMON_PORT !== undefined) {
    return { port: daemonPort(), source: "OPENLLM_DAEMON_PORT env" };
  }

  if (sharedFileConfig().OPENLLM_DAEMON_PORT !== undefined) {
    return {
      port: daemonPort(),
      source: "~/.openllm/.env OPENLLM_DAEMON_PORT",
    };
  }

  return { port: daemonPort(), source: null };
};

const daemonStatusLinePrefix = (line: string): string => `  ${line}`;

const collectRecentLogCommand = "logs";
const collectRecentLogLinesCommand = `${DAEMON_LOG_LINES}`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const SPINNER_INTERVAL_MS = 80;
const spinnerLabel = (model: string): string =>
  `AI diagnosis (${model}) — reading logs…`;

/** The model the AI diagnosis runs on when `--model` is not passed. `plus` is
 *  the mid default-chain tier — a stronger read than the old `lite` default,
 *  while `--model` lets a heavier (`ultra`) or cheaper (`lite`) tier, or any
 *  explicit model id, be chosen per run. */
const DEFAULT_DOCTOR_MODEL = "plus";

/** Parse `--model <alias>`; default `plus`. Returns null (caller rejects) when
 *  `--model` is given without a following value (a flag or nothing), or given
 *  more than once — an ambiguous request should error, not silently pick one. */
export const parseDoctorModel = (args: readonly string[]): string | null => {
  const occurrences: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--model") occurrences.push(i);
  }
  if (occurrences.length === 0) return DEFAULT_DOCTOR_MODEL;
  if (occurrences.length > 1) return null;
  const value = args[occurrences[0] + 1];
  if (value === undefined || value.startsWith("-")) return null;
  return value;
};

const DOCTOR_USAGE = `openllm doctor [--fix] [--no-ai] [--model <alias>] [-c]

Diagnose the local daemon and leftover install state.
Default AI diagnosis sends the redacted report and recent daemon logs
for processing; --no-ai keeps them on this machine.

  openllm doctor            report only — changes nothing
  openllm doctor --fix      apply safe fixes (remove leftover install artifacts)
  openllm doctor --no-ai    skip the AI diagnosis
  openllm doctor --model ultra   run the AI diagnosis on a specific model
  openllm doctor -c         copy the full report to the clipboard

  --fix            apply safe fixes
  --no-ai          disable the default AI diagnosis
  --model <alias>  model for the AI diagnosis (default ${DEFAULT_DOCTOR_MODEL})
  -c, --copy       copy the printed report to the clipboard

--fix removes only OpenLLM-owned paths and managed regions; your own settings
in those files are kept.
`;

const WARNING_LEVEL = /^(warn|error|fatal)$/i;
const WARNING_LOOSE = /(warn|error|fatal)/i;

const isWarningLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const level = (parsed as Record<string, unknown>).level;
        return typeof level === "string" && WARNING_LEVEL.test(level);
      }
    } catch {
      // not JSON — fall through to the loose match
    }
  }
  return WARNING_LOOSE.test(line);
};

const formatUptime = (seconds: number): string => {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

const formatHealthValue = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === undefined || value === null) return "unknown";
  return String(value);
};

const alignRows = (
  rows: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): readonly string[] => {
  const width = Math.max(1, ...rows.map((row) => row.label.length));
  return rows.map((row) => `  ${padRight(row.label, width)}  ${row.value}`);
};

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const formatByVerb = (byVerb: unknown): string | null => {
  if (byVerb === undefined || byVerb === null || typeof byVerb !== "object") {
    return null;
  }
  const parts: string[] = [];
  for (const [verb, count] of Object.entries(
    byVerb as Record<string, unknown>,
  )) {
    const n = asFiniteNumber(count);
    if (n === null) continue;
    parts.push(`${verb} ${n}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
};

const formatKeychainSpawns = (value: unknown): string | null => {
  if (value === undefined || value === null || typeof value !== "object") {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const attempts = asFiniteNumber(rec.attempts);
  const timeouts = asFiniteNumber(rec.timeouts);
  const skipped = asFiniteNumber(rec.skipped);
  if (attempts === null && timeouts === null && skipped === null) return null;
  const parts = [
    `attempts ${attempts ?? 0}`,
    `timeouts ${timeouts ?? 0}`,
    `skipped ${skipped ?? 0}`,
  ];
  const byVerb = formatByVerb(rec.by_verb);
  if (byVerb !== null) parts.push(`by verb ${byVerb}`);
  return parts.join(" · ");
};

const formatRefreshSpawnsEntry = (value: unknown): string | null => {
  if (value === undefined || value === null || typeof value !== "object") {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const attempts = asFiniteNumber(rec.attempts);
  const fail = asFiniteNumber(rec.fail);
  const fallbacks = asFiniteNumber(rec.fallbacks);
  if (attempts === null && fail === null && fallbacks === null) return null;
  return [
    `attempts ${attempts ?? 0}`,
    `fail ${fail ?? 0}`,
    `fallbacks ${fallbacks ?? 0}`,
  ].join(" · ");
};

/** Pure `/status` → aligned doctor rows. `listenPort` is the resolved local
 *  port (`resolveDaemonPort()`), never `raw.port`. */
export const renderDaemonHealthRows = (
  raw: Partial<TDaemonHealth>,
  listenPort: number,
): readonly string[] => {
  const version = typeof raw.version === "string" ? raw.version : "unknown";
  const cloudState =
    typeof raw.cloud_state === "string" ? raw.cloud_state : "unknown";
  const cloudOrigin =
    typeof raw.cloud_origin === "string" ? raw.cloud_origin : "unknown";
  const sandbox =
    raw.sandbox === undefined ? "unknown" : formatHealthValue(raw.sandbox);
  const keyConfigured =
    raw.key_configured === undefined
      ? "unknown"
      : raw.key_configured
        ? "yes"
        : "no";
  const uptime =
    typeof raw.uptime_s === "number" ? formatUptime(raw.uptime_s) : "unknown";

  const rows: Array<{ readonly label: string; readonly value: string }> = [
    { label: "version", value: version },
    { label: "listening", value: `yes on 127.0.0.1:${listenPort}` },
    { label: "cloud", value: cloudState },
    { label: "cloud origin", value: cloudOrigin },
    { label: "sandbox", value: sandbox },
    { label: "key", value: keyConfigured },
    { label: "uptime", value: uptime },
  ];

  if (typeof raw.identity_conflict === "boolean") {
    rows.push({
      label: "identity conflict",
      value: raw.identity_conflict
        ? "yes — on the dashboard open Keys and press Reset daemon identity"
        : "no",
    });
  }

  const keychain = formatKeychainSpawns(raw.keychain_spawns);
  if (keychain !== null) {
    rows.push({ label: "keychain spawns", value: keychain });
  }

  const refresh = raw.refresh_spawns;
  if (
    refresh !== undefined &&
    refresh !== null &&
    typeof refresh === "object"
  ) {
    for (const [slug, entry] of Object.entries(refresh)) {
      const line = formatRefreshSpawnsEntry(entry);
      if (line === null) continue;
      rows.push({ label: `refresh spawns (${slug})`, value: line });
    }
  }

  return alignRows(rows);
};

const formatLogTs = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const formatLogMeta = (meta: unknown): string => {
  if (meta === undefined || meta === null || typeof meta !== "object") {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const raw =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
    const clipped = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
    parts.push(`${key}=${clipped}`);
    if (parts.length >= 6) break;
  }
  return parts.join(" ");
};

/** Structured JSON log line → one scannable row; anything else is left as-is. */
const formatDoctorLogLine = (line: string): string => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed === null || typeof parsed !== "object") return trimmed;
  const rec = parsed as Record<string, unknown>;
  const ts = typeof rec.ts === "string" ? formatLogTs(rec.ts) : "";
  const level = typeof rec.level === "string" ? rec.level.toLowerCase() : "";
  const scope = typeof rec.scope === "string" ? rec.scope : "";
  const message = typeof rec.message === "string" ? rec.message : "";
  if (ts.length === 0 && level.length === 0 && message.length === 0) {
    return trimmed;
  }
  const metaText = formatLogMeta(rec.meta);
  const row = [ts, padRight(level, 5), padRight(scope, 16), message]
    .filter((part) => part.length > 0)
    .join("  ");
  return metaText.length === 0 ? row : `${row}  ${metaText}`;
};

const wrapParagraph = (text: string, width: number, indent: string): string => {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return `${indent}${text}`;
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > width && current.length > 0) {
      lines.push(`${indent}${current}`);
      current = word;
    } else {
      current = next;
    }
  }
  if (current.length > 0) lines.push(`${indent}${current}`);
  return lines.join("\n");
};

const hideHome = (text: string): string => {
  const home = userHome();
  return home.length === 0 ? text : text.split(home).join("~");
};

/** Last `maxBytes` of a file, dropping a leading partial line when we seek in. */
const readFileTail = (path: string, maxBytes: number): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buf.length) {
      const bytesRead = readSync(
        fd,
        buf,
        filled,
        buf.length - filled,
        start + filled,
      );
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    const text = buf.subarray(0, filled).toString("utf-8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
};

const redact = (text: string): string => {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/sk-llm-[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/sk-[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/xai-[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/AIza[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/eyJ[A-Za-z0-9._-]+/g, "***");
  out = out.replace(/\bBearer\s+[^\s]+/gi, "Bearer ***");
  out = out.replace(/[?&](?:token|key|api_key|sig)=[^&\s]+/gi, (match) => {
    const eq = match.indexOf("=");
    return `${match.slice(0, eq + 1)}***`;
  });
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+/g, "***");
  return out;
};

const tailLogLines = (maxLines: number): readonly string[] => {
  const lines: string[] = [];
  for (const path of daemonLogPaths()) {
    const text = readFileTail(path, LOG_TAIL_MAX_BYTES);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    }
  }
  return lines;
};

const daemonLogFilesReadable = (): boolean => {
  for (const path of daemonLogPaths()) {
    if (readFileTail(path, 1) !== null) return true;
  }
  return false;
};

const readRecentDaemonWarnings = (): readonly string[] => {
  const warnings = tailLogLines(LOG_WARNING_TAIL_LINES)
    .filter(isWarningLine)
    .slice(-LOG_WARNING_OUTPUT_LIMIT);
  return warnings.map(redact);
};

const runWithTimeout = async (
  argv: readonly string[],
  timeoutMs: number,
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    proc = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;
    if (
      stdoutStream === undefined ||
      stderrStream === undefined ||
      typeof stdoutStream === "number" ||
      typeof stderrStream === "number"
    ) {
      killProcess(proc);
      return {
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
      };
    }

    const done = Promise.all([
      readBoundedStream(stdoutStream, DAEMON_STATUS_COMMAND_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      readBoundedStream(stderrStream, DAEMON_STATUS_COMMAND_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      proc.exited,
    ]);
    const timeoutResult = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        killProcess(proc);
        resolve(null);
      }, timeoutMs);
    });

    const result = await Promise.race([done, timeoutResult]);
    if (result === null) {
      return {
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
      };
    }

    const [stdout, stderr, code] = result;
    return {
      stdout,
      stderr,
      code,
      timedOut: false,
    };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const collectOpenllmdStatus = async (): Promise<readonly string[]> => {
  const openllmdBin = managedDaemonBinary();
  if (!existsSync(openllmdBin)) {
    return [
      daemonStatusLinePrefix(
        `openllmd binary not found at ${openllmdBin} — daemon was never installed`,
      ),
    ];
  }

  try {
    const result = await runWithTimeout(
      [openllmdBin, "status"],
      DAEMON_STATUS_COMMAND_TIMEOUT_MS,
    );

    if (result.timedOut) {
      return [
        daemonStatusLinePrefix(
          `openllmd status check timed out after ${DAEMON_STATUS_COMMAND_TIMEOUT_MS}ms`,
        ),
      ];
    }

    const rawOutput = [result.stdout, result.stderr]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (rawOutput.length === 0) {
      return [
        daemonStatusLinePrefix(
          `openllmd status failed with exit ${result.code}`,
        ),
      ];
    }

    return rawOutput.map(daemonStatusLinePrefix);
  } catch {
    return [daemonStatusLinePrefix("openllmd status check failed")];
  }
};

const gatherDaemonHealth = async (): Promise<readonly string[]> => {
  const portInfo = resolveDaemonPort();
  const port = portInfo.port;
  const endpoint = `http://127.0.0.1:${port}/status`;
  const portResolution =
    portInfo.source === null
      ? []
      : [`  resolved daemon port: ${port} (from ${portInfo.source})`];

  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(DAEMON_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const statusRows = await collectOpenllmdStatus();
      return [
        `  daemon not responding on ${endpoint} (is openllmd running?)`,
        ...portResolution,
        ...statusRows,
      ];
    }
    const raw = (await res.json()) as Partial<TDaemonHealth>;
    return renderDaemonHealthRows(raw, port);
  } catch {
    const statusRows = await collectOpenllmdStatus();
    return [
      `  daemon not responding on ${endpoint} (is openllmd running?)`,
      ...portResolution,
      ...statusRows,
    ];
  }
};

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit?: () => void,
): Promise<string> => {
  let text = "";
  let limited = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > limit) {
        text = text.slice(-limit);
        if (!limited) {
          limited = true;
          onLimit?.();
        }
      }
    }
    const rest = decoder.decode();
    if (rest.length > 0) {
      text += rest;
      if (text.length > limit) text = text.slice(-limit);
    }
  } catch {
    // best effort (includes the stream closing after we kill the child)
  }
  return text;
};

const killProcess = (proc: ReturnType<typeof Bun.spawn> | null): void => {
  if (proc?.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
    return;
  } catch {
    // no-op; fall back to child-only kill
  }
  try {
    process.kill(proc.pid, "SIGKILL");
  } catch {
    // best effort
  }
};

const boundLogChunk = (text: string): string => {
  const redacted = redact(text);
  return redacted.length > DAEMON_LOG_CHAR_LIMIT
    ? redacted.slice(-DAEMON_LOG_CHAR_LIMIT)
    : redacted;
};

const collectRecentDaemonLogsFromFiles = (): string =>
  boundLogChunk(tailLogLines(DAEMON_LOG_LINES).join("\n"));

const collectRecentDaemonLogs = async (): Promise<string> => {
  const openllmdBin = managedDaemonBinary();
  if (!existsSync(openllmdBin)) {
    return collectRecentDaemonLogsFromFiles();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(
      [
        openllmdBin,
        collectRecentLogCommand,
        "-n",
        collectRecentLogLinesCommand,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    );

    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;
    if (
      stdoutStream === undefined ||
      stderrStream === undefined ||
      typeof stdoutStream === "number" ||
      typeof stderrStream === "number"
    ) {
      killProcess(proc);
      return collectRecentDaemonLogsFromFiles();
    }

    const done = Promise.all([
      readBoundedStream(stdoutStream, DAEMON_LOG_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      readBoundedStream(stderrStream, DAEMON_LOG_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      proc.exited,
    ]);
    const timeoutResult = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        killProcess(proc);
        resolve("timeout");
      }, DAEMON_LOG_TIMEOUT_MS);
    });

    const raced = await Promise.race([done, timeoutResult]);
    if (raced === "timeout") {
      return collectRecentDaemonLogsFromFiles();
    }

    const [stdout, , code] = raced;
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return collectRecentDaemonLogsFromFiles();
    }
    if (code !== 0 && trimmed.length < DAEMON_LOG_CHAR_LIMIT) {
      return collectRecentDaemonLogsFromFiles();
    }

    return boundLogChunk(stdout);
  } catch {
    return collectRecentDaemonLogsFromFiles();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

/** TTY-only stderr spinner. Piped/non-TTY stderr is a no-op so captures stay clean. */
const startStderrSpinner = (label: string): (() => void) => {
  if (process.stderr.isTTY !== true) return () => {};
  let frame = 0;
  const draw = (): void => {
    process.stderr.write(
      `\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label}`,
    );
    frame += 1;
  };
  draw();
  const id = setInterval(draw, SPINNER_INTERVAL_MS);
  return (): void => {
    clearInterval(id);
    process.stderr.write("\r\x1b[2K");
  };
};

export const DIAGNOSIS_SENTINEL = "Diagnosis:";

/** Defense in depth: retain only a prompt-mandated diagnosis, never exposed reasoning. */
export const extractDiagnosisParagraph = (raw: string): string | null => {
  // LAST occurrence on purpose: the failure this guards against is a provider
  // dumping its reasoning BEFORE the answer, and that reasoning routinely
  // quotes the prompt's own `Diagnosis:` instruction. A `startsWith` check
  // would reject exactly the leaked output we need to salvage.
  const lastSentinel = raw.lastIndexOf(DIAGNOSIS_SENTINEL);
  if (lastSentinel < 0) return null;
  const after = raw.slice(lastSentinel + DIAGNOSIS_SENTINEL.length);
  // The contract is ONE paragraph. Split BEFORE trimming so a sentinel that is
  // followed by a blank line yields an EMPTY diagnosis (→ null upstream)
  // instead of promoting unmarked trailing output into the answer.
  const firstParagraph = after.split(/\r?\n\s*\r?\n/, 1)[0] ?? "";
  return firstParagraph.trim();
};

const formatAiSection = (
  diagnosis: string | null,
  model: string,
  reason?: string,
): string => {
  if (diagnosis !== null) {
    const wrapped = diagnosis
      .split(/\r?\n/)
      .map((line) =>
        line.trim().length === 0 ? "" : wrapParagraph(line.trim(), 88, "  "),
      )
      .join("\n");
    return `\nAI diagnosis (${model})\n${wrapped}\n`;
  }
  const detail = reason ?? "AI diagnosis failed";
  return `\nAI diagnosis\n  unavailable (${detail})\n`;
};

export const aiDiagnosis = async (
  report: string,
  model: string,
): Promise<string | null> => {
  const bin = cliBinPath();
  const { apiKey } = cliConfig();
  if (!existsSync(bin) || apiKey.length === 0) return null;

  const daemonLogs = await collectRecentDaemonLogs();
  const prompt = `You are diagnosing a local OpenLLM daemon ("openllmd") for a support ticket.\n\nDoctor report:\n${hideHome(redact(report))}\n\nRecent daemon logs (already redacted, newest last):\n${hideHome(redact(daemonLogs))}\n\nWrite exactly one information-dense paragraph suitable to paste into an OpenLLM support ticket. Start the paragraph with "${DIAGNOSIS_SENTINEL}" and output nothing else: no preamble, markdown headings, bullet points, or code fences. If the logs include daemon version lines and span more than one version, attribute each problem to the specific version it occurred under and keep the diagnosis segmented per version.`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  // Created inside the guarded region so a failed mcp.json write (or any
  // later throw) still reaches the `finally` that removes the directory.
  let diagnosisDir: string | null = null;

  try {
    diagnosisDir = mkdtempSync(join(tmpdir(), "openllm-doctor-"));
    const mcpConfig = join(diagnosisDir, "mcp.json");
    writeFileSync(mcpConfig, '{"mcpServers":{}}\n', { mode: 0o600 });
    proc = Bun.spawn(
      [
        bin,
        "--bare",
        "claude",
        "-p",
        prompt,
        "--model",
        model,
        // Vendor flag: must follow the client name so OpenLLM forwards it intact.
        "--bare",
        // `--bare` skips hooks; retain explicit controls below because they do not
        // conflict with it and constrain MCP, tools, instructions, and persistence.
        "--setting-sources",
        "",
        // No tools means neither local tools nor any loaded MCP tool can run.
        "--tools",
        "",
        // This config and strict mode admit no MCP servers, including OpenLLM's overlay.
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfig,
        // Avoid retaining a diagnosis session in the user's Claude Code history.
        "--no-session-persistence",
        // Replace Claude Code's default prompt with the single-purpose summarizer role.
        "--system-prompt",
        "You are a log summarizer; output only the paragraph.",
      ],
      {
        cwd: diagnosisDir,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    );

    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;
    if (
      stdoutStream === undefined ||
      stderrStream === undefined ||
      typeof stdoutStream === "number" ||
      typeof stderrStream === "number"
    ) {
      killProcess(proc);
      return null;
    }
    const done = Promise.all([
      readBoundedStream(stdoutStream, DAEMON_LOG_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      readBoundedStream(stderrStream, DAEMON_LOG_CHAR_LIMIT, () =>
        killProcess(proc),
      ),
      proc.exited,
    ]);
    const timeoutResult = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        killProcess(proc);
        resolve("timeout");
      }, AI_TIMEOUT_MS);
    });
    const raced = await Promise.race([done, timeoutResult]);
    if (raced === "timeout") {
      return null;
    }
    const [stdout, , code] = raced;
    if (timedOut || code !== 0) return null;
    const text = redact(stdout).trim();
    const diagnosis = extractDiagnosisParagraph(text);
    return diagnosis !== null && diagnosis.length > 0 ? diagnosis : null;
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (diagnosisDir !== null) {
      // Best effort: a stuck temp dir must not turn a finished (or already
      // failed) diagnosis into a thrown error out of `openllm doctor`.
      try {
        rmSync(diagnosisDir, { recursive: true, force: true });
      } catch {
        // leave it for the OS temp cleaner
      }
    }
  }
};

const copyToClipboard = (text: string): boolean => {
  const tools: ReadonlyArray<readonly string[]> =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : [
          ["wl-copy"],
          ["xclip", "-selection", "clipboard"],
          ["xsel", "--clipboard", "--input"],
        ];
  for (const argv of tools) {
    try {
      const result = spawnSync(argv[0], argv.slice(1), {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (result.status === 0) return true;
    } catch {
      // try the next clipboard tool
    }
  }
  return false;
};

export const runDoctor = async (args: readonly string[]): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(DOCTOR_USAGE);
    return 0;
  }

  const fix = args.includes("--fix");
  const includeAi = !args.includes("--no-ai");
  const copy = args.includes("-c") || args.includes("--copy");
  const model = parseDoctorModel(args);
  if (model === null) {
    process.stderr.write(DOCTOR_USAGE);
    return 2;
  }
  const chunks: string[] = [];
  const emit = (text: string): void => {
    chunks.push(text);
    process.stdout.write(text);
  };
  const found: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];

  const noteRetained = (item: string, detail: string): void => {
    retained.push(item);
    emit(`  ! ${detail}\n`);
  };

  const tryRemove = (item: string, fn: () => void): void => {
    try {
      fn();
      removed.push(item);
    } catch {
      noteRetained(item, `${item} could not be removed — left untouched`);
    }
  };

  for (const path of legacyPaths()) {
    if (!existsSync(path)) continue;
    if (fix) {
      tryRemove(path, () => rmSync(path, { recursive: true, force: true }));
    } else {
      found.push(path);
    }
  }

  for (const backup of legacyBackups()) {
    if (!existsSync(backup)) continue;
    const item = `${backup} (may contain an API key)`;
    if (fix) {
      tryRemove(item, () => rmSync(backup, { force: true }));
    } else {
      found.push(item);
    }
  }

  for (const { path, begin, end } of legacyRegions()) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes(begin)) continue;
    const item = `${path} (OpenLLM managed region)`;
    if (!fix) {
      found.push(item);
      continue;
    }
    const next = removeRegion(text, begin, end);
    if (next === null) {
      noteRetained(
        item,
        `${path} has an unbalanced region — left untouched, remove it by hand`,
      );
      continue;
    }
    tryRemove(item, () => writeFileSync(path, next));
  }

  const legacyBin = legacyBinary();
  if (existsSync(legacyBin)) {
    const item = `${legacyBin} (legacy openllmc name)`;
    if (fix) {
      tryRemove(item, () => rmSync(legacyBin, { force: true }));
    } else {
      found.push(item);
    }
  }

  const output: string[] = [];
  output.push("Leftovers");
  if (fix) {
    if (removed.length === 0 && retained.length === 0) {
      output.push("  ✓ Nothing left over from the old install model.");
    } else {
      if (removed.length > 0) {
        output.push(`  Removed ${removed.length} leftover item(s):`);
        for (const item of removed) output.push(`    - ${item}`);
      }
      if (retained.length > 0) {
        if (removed.length > 0) output.push("");
        output.push(`  Retained ${retained.length} leftover item(s):`);
        for (const item of retained) output.push(`    - ${item}`);
      }
    }
  } else if (found.length === 0) {
    output.push("  ✓ Nothing left over from the old install model.");
  } else {
    output.push(
      `  Found ${found.length} leftover item(s) from the old install model:`,
    );
    for (const item of found) output.push(`    - ${item}`);
    output.push(
      "",
      "  OpenLLM no longer edits client configs — run a client with",
      "  `openllm claude` (or codex / grok / opencode) instead.",
      "  Apply fixes with: openllm doctor --fix",
    );
  }

  const daemonHealth = await gatherDaemonHealth();
  output.push("", "Daemon health", ...daemonHealth);

  const warningLines = readRecentDaemonWarnings();
  const hasReadableLogFiles = daemonLogFilesReadable();
  output.push("", "Recent warnings");
  if (!hasReadableLogFiles) {
    output.push("  no daemon logs found (daemon may never have started)");
  } else if (warningLines.length === 0) {
    output.push("  none found");
  } else {
    for (const line of warningLines) {
      output.push(`  ${formatDoctorLogLine(line)}`);
    }
  }

  const reportText = redact(output.join("\n"));
  emit(`${reportText}\n`);

  if (!includeAi) {
    emit(formatAiSection(null, model, "disabled by --no-ai"));
  } else if (!existsSync(cliBinPath())) {
    emit(formatAiSection(null, model, "openllm CLI not found"));
  } else if (cliConfig().apiKey.length === 0) {
    emit(formatAiSection(null, model, "no API key configured"));
  } else {
    process.stderr.write(
      `AI diagnosis sends the report and recent daemon logs through your gateway (model: ${model}) — use --no-ai to keep them local.\n`,
    );
    const stopSpinner = startStderrSpinner(spinnerLabel(model));
    let diagnosis: string | null = null;
    try {
      diagnosis = await aiDiagnosis(reportText, model);
    } finally {
      stopSpinner();
    }
    emit(
      diagnosis === null
        ? formatAiSection(null, model)
        : formatAiSection(redact(diagnosis), model),
    );
  }

  if (copy) {
    const ok = copyToClipboard(chunks.join(""));
    process.stderr.write(
      ok
        ? "copied to clipboard\n"
        : "could not copy to clipboard (no pbcopy/wl-copy/xclip)\n",
    );
  }

  return 0;
};
