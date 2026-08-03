/**
 * `openllm sessions` manages durable local session-host processes directly.
 *
 * Their registry is filesystem-owned (`~/.openllm/sessions/<id>/meta.json` +
 * `ctl.sock`), so these commands remain usable while the daemon is stopped.
 */

import { attachBrokerSession } from "./clients/attach";
import type { TDaemonCli } from "./clients/registry";
import {
  discoverLiveSessionHosts,
  sessionHostProcessAlive,
} from "./session-host";

export type TBrokerSessionRow = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly updated_at_ms: number;
  readonly cli: TDaemonCli;
  readonly live: boolean;
  readonly attachable: boolean;
  readonly socket_path?: string;
  readonly pid?: number;
};

const SESSIONS_USAGE = `usage: openllm sessions [list]
       openllm sessions attach <id> [--pipe] [--cols N] [--rows N]
       openllm sessions kill <id>

List, attach to, or kill live local durable sessions.
  --pipe  fd-agnostic attach for a parent process (daemon) that pipes
          stdio; skips TTY raw mode and accepts RS-framed resize/close
          controls on stdin (see packages/cli/src/clients/attach.ts).
`;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const relativeAge = (updatedAtMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

const compactCwd = (cwd: string): string => {
  const home = process.env.HOME;
  return home !== undefined && cwd.startsWith(`${home}/`)
    ? `~/${cwd.slice(home.length + 1)}`
    : cwd;
};

/** Render the compact table used by `openllm sessions list`. */
export const formatSessionRows = (
  sessions: readonly TBrokerSessionRow[],
  nowMs = Date.now(),
): string => {
  if (sessions.length === 0) return "No local durable sessions.\n";
  const rows = sessions.map((session) => [
    truncate(session.id, 12),
    session.cli,
    session.live ? "live●" : "dead",
    session.attachable ? "yes" : "no",
    truncate(session.title || "-", 24),
    truncate(compactCwd(session.cwd || "-"), 32),
    relativeAge(session.updated_at_ms, nowMs),
  ]);
  const headers = ["ID", "CLI", "STATE", "ATTACH", "TITLE", "CWD", "UPDATED"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  return `${format(headers)}\n${rows.map(format).join("\n")}\n`;
};

/** Resolve an exact id or a unique non-empty prefix. */
export const resolveSessionId = (
  sessions: readonly TBrokerSessionRow[],
  supplied: string,
): TBrokerSessionRow | "missing" | "ambiguous" => {
  const exact = sessions.find((session) => session.id === supplied);
  if (exact !== undefined) return exact;
  const matches = sessions.filter((session) => session.id.startsWith(supplied));
  if (matches.length === 1) return matches[0] as TBrokerSessionRow;
  return matches.length === 0 ? "missing" : "ambiguous";
};

/** Read and validate live process-owned directories, reaping stale entries. */
export const listSessionHosts = (): readonly TBrokerSessionRow[] =>
  discoverLiveSessionHosts().map((session) => ({
    id: session.id,
    cli: session.cli,
    title: session.title ?? "",
    cwd: session.cwd,
    updated_at_ms: session.startedAtMs,
    live: true,
    attachable: true,
    socket_path: session.socketPath,
    pid: session.pid,
  }));

const requireSession = (
  sessions: readonly TBrokerSessionRow[],
  id: string | undefined,
): TBrokerSessionRow | null => {
  if (id === undefined || id.length === 0) {
    process.stderr.write("[openllm] session id is required\n");
    return null;
  }
  const resolved = resolveSessionId(sessions, id);
  if (resolved === "missing") {
    process.stderr.write(`[openllm] no session matches ${id}\n`);
    return null;
  }
  if (resolved === "ambiguous") {
    process.stderr.write(`[openllm] session id prefix ${id} is ambiguous\n`);
    return null;
  }
  return resolved;
};

type TAttachOpts = {
  readonly pipe: boolean;
  readonly cols: number;
  readonly rows: number;
};

const attach = async (
  session: TBrokerSessionRow,
  opts: TAttachOpts,
): Promise<number> => {
  if (
    !session.live ||
    !session.attachable ||
    session.socket_path === undefined ||
    session.pid === undefined
  ) {
    process.stderr.write("[openllm] session is not attachable\n");
    return 1;
  }
  if (
    !opts.pipe &&
    (!process.stdin.isTTY ||
      !process.stdout.isTTY ||
      process.platform === "win32")
  ) {
    process.stderr.write(
      "[openllm] attaching requires an interactive non-Windows terminal\n",
    );
    return 1;
  }
  const result = await attachBrokerSession({
    target: session.socket_path,
    open: {
      session_id: session.id,
      cli: session.cli,
      cols: opts.cols,
      rows: opts.rows,
      mode: "attach",
    },
    announce: !opts.pipe,
    pipe: opts.pipe,
  });
  if (result.kind === "completed") return result.code;
  process.stderr.write("[openllm] session host is unavailable\n");
  return 1;
};

const parseAttachOpts = (args: readonly string[]): TAttachOpts | null => {
  let pipe = false;
  let cols = process.stdout.columns ?? 80;
  let rows = process.stdout.rows ?? 24;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--pipe") {
      pipe = true;
      continue;
    }
    if (arg === "--cols" || arg === "--rows") {
      const raw = args[i + 1];
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 999) {
        process.stderr.write(`[openllm] ${arg} expects a positive integer\n`);
        return null;
      }
      if (arg === "--cols") cols = n;
      else rows = n;
      i += 1;
      continue;
    }
    process.stderr.write(`[openllm] unknown attach flag: ${arg}\n`);
    return null;
  }
  return { pipe, cols, rows };
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Stop the standalone host; its SIGTERM handler closes the owned PTY cleanly. */
export const killSessionHost = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
    await sleep(50);
    if (!sessionHostProcessAlive(pid)) return true;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
};

const kill = async (session: TBrokerSessionRow): Promise<number> => {
  if (session.pid === undefined || !(await killSessionHost(session.pid))) {
    process.stderr.write(`[openllm] could not kill session ${session.id}\n`);
    return 1;
  }
  process.stdout.write(`[openllm] killed session ${session.id}\n`);
  return 0;
};

/** Dispatch `openllm sessions [list|attach|kill]`. */
export const runSessionsCommand = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(SESSIONS_USAGE);
    return 0;
  }
  const verb = args[0] ?? "list";
  if (verb !== "list" && verb !== "attach" && verb !== "kill") {
    process.stderr.write(SESSIONS_USAGE);
    return 2;
  }
  const sessions = listSessionHosts();
  if (verb === "list") {
    process.stdout.write(formatSessionRows(sessions));
    return 0;
  }
  const session = requireSession(sessions, args[1]);
  if (session === null) return 1;
  if (verb === "kill") return kill(session);
  const opts = parseAttachOpts(args.slice(2));
  if (opts === null) return 2;
  return attach(session, opts);
};
