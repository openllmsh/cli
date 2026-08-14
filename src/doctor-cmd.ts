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
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { daemonPort } from "./clients/gateway";
import { removeRegion } from "./clients/merge";
import { cliBinPath, cliConfig, openllmDir, userHome } from "./env";

type TLegacyRegion = {
  readonly path: string;
  readonly begin: string;
  readonly end: string;
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
const LOG_WARNING_TAIL_LINES = 400;
const LOG_WARNING_OUTPUT_LIMIT = 8;
const AI_TIMEOUT_MS = 90_000;
const DAEMON_LOG_TIMEOUT_MS = 8_000;
const DAEMON_LOG_LINES = 200;
const DAEMON_LOG_CHAR_LIMIT = 24_000;
const LOG_TAIL_MAX_BYTES = 256_000;

const collectRecentLogCommand = "logs";
const collectRecentLogLinesCommand = `${DAEMON_LOG_LINES}`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const SPINNER_INTERVAL_MS = 80;
const SPINNER_LABEL = "AI diagnosis (lite) — reading logs…";

const DOCTOR_USAGE = `openllm doctor [--fix] [--no-ai] [-c]

Diagnose the local daemon and leftover install state.

  openllm doctor          report only — changes nothing
  openllm doctor --fix    apply safe fixes (remove leftover install artifacts)
  openllm doctor --no-ai  skip the AI diagnosis
  openllm doctor -c       copy the full report to the clipboard

  --fix           apply safe fixes
  --no-ai         disable the default AI diagnosis
  -c, --copy      copy the printed report to the clipboard

--fix removes only OpenLLM-owned paths and managed regions; your own settings
in those files are kept.
`;

const isWarningLine = (line: string): boolean => {
  return (
    /(warn|error|fatal)/i.test(line) ||
    /"level"\s*:\s*"(warn|error|fatal)"/i.test(line)
  );
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

const padRight = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

const alignRows = (
  rows: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): readonly string[] => {
  const width = Math.max(1, ...rows.map((row) => row.label.length));
  return rows.map((row) => `  ${padRight(row.label, width)}  ${row.value}`);
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

const readRecentDaemonWarnings = (): readonly string[] => {
  const recentLines: string[] = [];
  for (const path of daemonLogPaths()) {
    const text = readFileTail(path, LOG_TAIL_MAX_BYTES);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      recentLines.push(line);
      if (recentLines.length > LOG_WARNING_TAIL_LINES) {
        recentLines.shift();
      }
    }
  }

  const warnings = recentLines
    .filter(isWarningLine)
    .slice(-LOG_WARNING_OUTPUT_LIMIT);
  return warnings.map(redact);
};

const gatherDaemonHealth = async (): Promise<readonly string[]> => {
  const port = daemonPort();
  const endpoint = `http://127.0.0.1:${port}/status`;

  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(DAEMON_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      return [`  daemon not responding on ${endpoint} (is openllmd running?)`];
    }
    const raw = (await res.json()) as Partial<TDaemonHealth>;
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

    return alignRows([
      { label: "version", value: version },
      { label: "listening", value: `yes on 127.0.0.1:${port}` },
      { label: "cloud", value: cloudState },
      { label: "cloud origin", value: cloudOrigin },
      { label: "sandbox", value: sandbox },
      { label: "key", value: keyConfigured },
      { label: "uptime", value: uptime },
    ]);
  } catch {
    return [`  daemon not responding on ${endpoint} (is openllmd running?)`];
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

const collectRecentDaemonLogsFromFiles = (): string => {
  const lines: string[] = [];
  for (const path of daemonLogPaths()) {
    const text = readFileTail(path, LOG_TAIL_MAX_BYTES);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      lines.push(line);
      if (lines.length > DAEMON_LOG_LINES) {
        lines.shift();
      }
    }
  }

  return boundLogChunk(lines.join("\n"));
};

const collectRecentDaemonLogs = async (): Promise<string> => {
  const openllmdBin = join(openllmDir(), "bin", "openllmd");
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

const formatAiSection = (diagnosis: string | null, reason?: string): string => {
  if (diagnosis !== null) {
    const wrapped = diagnosis
      .split(/\r?\n/)
      .map((line) =>
        line.trim().length === 0 ? "" : wrapParagraph(line.trim(), 88, "  "),
      )
      .join("\n");
    return `\nAI diagnosis (lite)\n${wrapped}\n`;
  }
  const detail = reason ?? "AI diagnosis failed";
  return `\nAI diagnosis\n  unavailable (${detail})\n`;
};

export const aiDiagnosis = async (report: string): Promise<string | null> => {
  const bin = cliBinPath();
  const { apiKey } = cliConfig();
  if (!existsSync(bin) || apiKey.length === 0) return null;

  const daemonLogs = await collectRecentDaemonLogs();
  const prompt = `You are diagnosing a local OpenLLM daemon ("openllmd") for a support ticket.\n\nDoctor report:\n${hideHome(report)}\n\nRecent daemon logs (already redacted, newest last):\n${hideHome(daemonLogs)}\n\nWrite exactly one information-dense paragraph — no preamble, no markdown headings, no bullet points, no code fences — suitable to paste into an OpenLLM support ticket. If the logs include daemon version lines and span more than one version, attribute each problem to the specific version it occurred under and keep the diagnosis segmented per version.`;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    proc = Bun.spawn([bin, "claude", "-p", prompt, "--model", "lite"], {
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
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
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
  output.push("", "Recent warnings");
  if (warningLines.length === 0) {
    output.push("  none found");
  } else {
    for (const line of warningLines) {
      output.push(`  ${formatDoctorLogLine(line)}`);
    }
  }

  const reportText = redact(output.join("\n"));
  emit(`${reportText}\n`);

  if (!includeAi) {
    emit(formatAiSection(null, "disabled by --no-ai"));
  } else if (!existsSync(cliBinPath())) {
    emit(formatAiSection(null, "openllm CLI not found"));
  } else if (cliConfig().apiKey.length === 0) {
    emit(formatAiSection(null, "no API key configured"));
  } else {
    const stopSpinner = startStderrSpinner(SPINNER_LABEL);
    let diagnosis: string | null = null;
    try {
      diagnosis = await aiDiagnosis(reportText);
    } finally {
      stopSpinner();
    }
    emit(
      diagnosis === null
        ? formatAiSection(null)
        : formatAiSection(redact(diagnosis)),
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
