/**
 * `openllm sessions` manages the local daemon's brokered PTYs.
 *
 * This deliberately talks to the loopback daemon rather than the cloud API: the
 * PTY and its single-consumer lifecycle exist only on this machine.
 */

import { attachBrokerSession } from "./clients/attach";
import { daemonPort } from "./clients/gateway";
import { cliConfig } from "./env";

export type TBrokerSessionRow = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updated_at_ms: number;
  readonly cli: "claude_code" | "chatgpt" | "grok" | "opencode";
  readonly live: boolean;
  readonly host?: string;
  readonly openllm_session_id?: string;
  readonly attachable: boolean;
};

const SESSIONS_USAGE = `usage: openllm sessions [list]
       openllm sessions attach <id>
       openllm sessions kill <id>

List local daemon sessions, attach to a live brokered session, or kill one.
`;

const origin = (): string => `http://127.0.0.1:${daemonPort()}`;

const authHeaders = (apiKey: string): HeadersInit => ({
  Authorization: `Bearer ${apiKey}`,
});

const unavailable = (): number => {
  process.stderr.write("[openllm] local daemon is unavailable\n");
  return 1;
};

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
  if (sessions.length === 0) return "No local daemon sessions.\n";
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

const listSessions = async (
  apiKey: string,
): Promise<readonly TBrokerSessionRow[] | null> => {
  try {
    const response = await fetch(`${origin()}/broker/sessions`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isSessionsResponse(body)) return null;
    return body.sessions;
  } catch {
    return null;
  }
};

const isSessionsResponse = (
  value: unknown,
): value is { readonly sessions: readonly TBrokerSessionRow[] } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { sessions?: unknown }).sessions);

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

/** Vendor resume invocation for a dead session — flags differ per CLI. */
const resumeHint = (cli: TBrokerSessionRow["cli"], id: string): string =>
  ({
    claude_code: `openllm claude --resume ${id}`,
    chatgpt: `openllm codex resume ${id}`,
    grok: `openllm grok --resume ${id}`,
    opencode: `openllm opencode --session ${id}`,
  })[cli];

const attach = async (
  session: TBrokerSessionRow,
  apiKey: string,
): Promise<number> => {
  if (!session.live) {
    process.stderr.write(
      `[openllm] session is not running — resume it with:\n  ${resumeHint(session.cli, session.id)}\n`,
    );
    return 1;
  }
  if (!session.attachable || session.openllm_session_id === undefined) {
    process.stderr.write("[openllm] session is not attachable\n");
    return 1;
  }
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.platform === "win32"
  ) {
    process.stderr.write(
      "[openllm] attaching requires an interactive non-Windows terminal\n",
    );
    return 1;
  }
  const result = await attachBrokerSession({
    origin: origin(),
    apiKey,
    open: {
      // mirrors SESSION_ID_PATTERN in packages/protocol/session.ts
      session_id: session.openllm_session_id,
      cli: session.cli,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      mode: "attach",
    },
    announce: true,
  });
  return result.kind === "completed" ? result.code : unavailable();
};

const kill = async (
  session: TBrokerSessionRow,
  apiKey: string,
): Promise<number> => {
  try {
    const response = await fetch(
      `${origin()}/broker/sessions/${encodeURIComponent(session.id)}/kill`,
      {
        method: "POST",
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(1_000),
      },
    );
    if (!response.ok) return unavailable();
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { ok?: unknown }).ok !== "boolean"
    ) {
      return unavailable();
    }
    if ((body as { ok: boolean }).ok) {
      process.stdout.write(`[openllm] killed session ${session.id}\n`);
      return 0;
    }
    process.stderr.write(`[openllm] could not kill session ${session.id}\n`);
    return 1;
  } catch {
    return unavailable();
  }
};

/** Dispatch `openllm sessions [list|attach|kill]`. */
export const runSessionsCommand = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(SESSIONS_USAGE);
    return 0;
  }
  const { apiKey } = cliConfig();
  if (apiKey.length === 0) {
    process.stderr.write(
      "[openllm] No API key configured — set OPENLLM_API_KEY\n",
    );
    return 1;
  }
  const verb = args[0] ?? "list";
  if (verb !== "list" && verb !== "attach" && verb !== "kill") {
    process.stderr.write(SESSIONS_USAGE);
    return 2;
  }
  const sessions = await listSessions(apiKey);
  if (sessions === null) return unavailable();
  if (verb === "list") {
    process.stdout.write(formatSessionRows(sessions));
    return 0;
  }
  const session = requireSession(sessions, args[1]);
  if (session === null) return 1;
  return verb === "attach" ? attach(session, apiKey) : kill(session, apiKey);
};
