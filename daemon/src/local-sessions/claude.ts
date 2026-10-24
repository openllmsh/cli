/**
 * Claude Code local sessions from ~/.claude/history.jsonl, one row per
 * conversation.
 *
 * Each history line is a prompt event: { display, timestamp, project,
 * sessionId }. Lines are grouped by sessionId (max timestamp → updated_at,
 * project → cwd). Titles come from Claude's own transcript
 * (`projects/<slug>/<id>.jsonl`): its latest `ai-title` / `summary` when it
 * has one, else the first REAL prompt (slash commands such as `/new` and
 * `/resume`, command wrappers and interrupt markers never name a row; pasted
 * text placeholders only when nothing better exists).
 *
 * One conversation is one row:
 *   - a history session that is only slash commands and has no transcript is
 *     a phantom (`/resume` typed in a fresh Claude, which then switched to the
 *     resumed session) and is dropped;
 *   - a transcript that carries an earlier session's lines (a resume / continue
 *     that copied history into a new file) collapses that earlier session into
 *     itself: the later file is the row.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { parseUpdatedMs } from "./grok";
import { claudeConfigDir } from "./paths";
import { pickPromptTitle, truncate } from "./title";
import type { THistorySession } from "./types";

const CLAUDE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
/** Transcript bytes scanned (from each end) for titles and chain links. */
const TRANSCRIPT_SCAN_BYTES = 256 * 1024;

const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

/** Read `[start, start+length)` of a file as text (clamped to its size). */
const readSlice = (fd: number, start: number, length: number): string => {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const read = readSync(
      fd,
      buffer,
      bytesRead,
      length - bytesRead,
      start + bytesRead,
    );
    if (read === 0) break;
    bytesRead += read;
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
};

const readTailLines = (path: string, byteLimit: number): string => {
  const fd = openSync(path, "r");
  try {
    const size = Math.max(0, fstatSync(fd).size);
    const start = Math.max(0, size - byteLimit);
    if (size - start === 0) return "";
    let text = readSlice(fd, start, size - start);
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline === -1) return "";
      text = text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
};

/** Claude's project slug for a cwd (every non-alphanumeric → `-`). */
const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** Where a session's transcript lives: the cwd's slug first, then any slug. */
const transcriptPathOf = (
  projectsDir: string,
  sessionId: string,
  cwd: string | null,
  slugs: () => readonly string[],
): string | null => {
  if (!SESSION_ID.test(sessionId)) return null;
  if (cwd !== null) {
    const direct = join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  for (const slug of slugs()) {
    const path = join(projectsDir, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
};

type TTranscriptFacts = {
  /** Claude's latest generated title (`ai-title`) or `summary`. */
  readonly title: string | null;
  /** Other session ids whose lines this transcript carries (chain parents). */
  readonly parents: ReadonlySet<string>;
};

const jsonLines = (text: string): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || line[0] !== "{") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row !== null && typeof row === "object" && !Array.isArray(row))
        rows.push(row as Record<string, unknown>);
    } catch {
      // A torn head/tail line or a partial write.
    }
  }
  return rows;
};

const titleOfRow = (row: Record<string, unknown>): string | null => {
  if (row.type === "ai-title" && typeof row.aiTitle === "string")
    return row.aiTitle;
  if (row.type === "summary" && typeof row.summary === "string")
    return row.summary;
  return null;
};

/** Scan a transcript's head + tail for its title and chain parents. */
export const readTranscriptFacts = (
  path: string,
  sessionId: string,
): TTranscriptFacts => {
  let head = "";
  let tail = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      head = readSlice(fd, 0, Math.min(size, TRANSCRIPT_SCAN_BYTES));
      if (size > TRANSCRIPT_SCAN_BYTES) {
        const start = Math.max(
          TRANSCRIPT_SCAN_BYTES,
          size - TRANSCRIPT_SCAN_BYTES,
        );
        tail = readSlice(fd, start, size - start);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { title: null, parents: new Set() };
  }
  const headRows = jsonLines(head);
  const tailRows = jsonLines(tail);
  let title: string | null = null;
  for (const row of [...headRows, ...tailRows]) {
    const t = titleOfRow(row);
    if (t !== null && t.trim().length > 0) title = t;
  }
  const parents = new Set<string>();
  for (const row of headRows) {
    const id = row.sessionId;
    if (typeof id === "string" && id !== sessionId && SESSION_ID.test(id))
      parents.add(id);
  }
  return { title, parents };
};

export type TClaudeHistoryOptions = {
  /** `~/.claude` (tests point it at a fixture tree). */
  readonly configDir?: string;
  /** Skip transcript title/chain scans when callers only need history metadata. */
  readonly skipTranscripts?: boolean;
};

export const readClaudeHistory = (
  limit: number,
  options: TClaudeHistoryOptions = {},
): THistorySession[] => {
  const configDir = options.configDir ?? claudeConfigDir();
  const path = join(configDir, "history.jsonl");
  if (!existsSync(path)) return [];
  const projectsDir = join(configDir, "projects");
  let slugCache: readonly string[] | null = null;
  const slugs = (): readonly string[] => {
    if (slugCache === null) {
      try {
        slugCache = readdirSync(projectsDir);
      } catch {
        slugCache = [];
      }
    }
    return slugCache;
  };

  try {
    const stat = statSync(path);
    const fallback = stat.isFile() ? stat.mtimeMs : Date.now();
    const lines = readTailLines(path, CLAUDE_HISTORY_TAIL_BYTES).split("\n");
    type TAgg = {
      prompts: string[];
      cwd: string | null;
      updated_at_ms: number;
    };
    const byId = new Map<string, TAgg>();
    for (const line of lines) {
      if (line.length === 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const id = typeof o.sessionId === "string" ? o.sessionId : null;
      if (id === null || id.length === 0) continue;
      const ts = parseUpdatedMs(o.timestamp, fallback);
      const display = typeof o.display === "string" ? o.display : "";
      const project = typeof o.project === "string" ? o.project : null;
      const agg = byId.get(id) ?? { prompts: [], cwd: null, updated_at_ms: 0 };
      if (display.length > 0) agg.prompts.push(display);
      if (ts >= agg.updated_at_ms) {
        agg.updated_at_ms = ts;
        agg.cwd = project ?? agg.cwd;
      } else if (agg.cwd === null) agg.cwd = project;
      byId.set(id, agg);
    }

    // Newest first, so only the rows that can make the list pay for a
    // transcript scan (with headroom for phantoms and collapsed chains).
    const ordered = [...byId.entries()].sort(
      (a, b) => b[1].updated_at_ms - a[1].updated_at_ms,
    );
    const rows = new Map<string, THistorySession>();
    const collapsedInto = new Map<string, string>();
    for (const [id, agg] of ordered) {
      if (rows.size >= limit * 2 + 16) break;
      const transcript =
        options.skipTranscripts === true
          ? null
          : transcriptPathOf(projectsDir, id, agg.cwd, slugs);
      const facts =
        transcript === null ? null : readTranscriptFacts(transcript, id);
      const promptTitle = pickPromptTitle(agg.prompts);
      // Only slash commands and nothing on disk: not a conversation.
      if (facts === null && promptTitle === null) continue;
      const title =
        facts?.title !== null && facts?.title !== undefined
          ? truncate(facts.title)
          : (promptTitle ?? "Untitled");
      rows.set(id, {
        id,
        title,
        cwd: agg.cwd,
        updated_at_ms: agg.updated_at_ms,
        cli: "claude_code",
      });
      for (const parent of facts?.parents ?? []) collapsedInto.set(parent, id);
    }

    // A chain: the later file is the row; earlier sessions fold into it.
    // Resolve through collapsedInto to the terminal descendant so a→b→c
    // still merges when Map order processes b→c before a→b (rows.get(b)
    // would otherwise be undefined after b was already folded away).
    const terminalOf = (start: string): string => {
      const seen = new Set<string>();
      let current = start;
      for (;;) {
        const next = collapsedInto.get(current);
        if (next === undefined || seen.has(current)) return current;
        seen.add(current);
        current = next;
      }
    };
    for (const parent of collapsedInto.keys()) {
      const earlier = rows.get(parent);
      if (earlier === undefined) continue;
      const terminal = terminalOf(parent);
      if (terminal === parent) continue;
      const later = rows.get(terminal);
      if (later === undefined) continue;
      rows.delete(parent);
      rows.set(terminal, {
        ...later,
        updated_at_ms: Math.max(later.updated_at_ms, earlier.updated_at_ms),
        title: later.title === "Untitled" ? earlier.title : later.title,
      });
    }

    return [...rows.values()]
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
      .slice(0, limit);
  } catch {
    return [];
  }
};

/**
 * Live Claude processes' REAL session ids, keyed by the parent pid (the
 * `openllm claude` wrapper whose `~/.openllm/run/claude/<pid>/live.json`
 * indexes the run). Claude records each running TUI in
 * `~/.claude/sessions/<pid>.json` with its current `sessionId`, which also
 * follows a `/resume` inside the TUI. Without this, a run whose live.json has
 * no vendor id (a terminal `openllm claude`, or a host spawned before the
 * session id was pinned) lists as a second row next to its own history.
 */
export const readClaudeLiveSessionIds = (
  options: {
    readonly configDir?: string;
    /** pid → parent pid (tests); defaults to one batched `ps`. */
    readonly parentsOf?: (pids: readonly number[]) => Map<number, number>;
  } = {},
): Map<number, string> => {
  const dir = join(options.configDir ?? claudeConfigDir(), "sessions");
  const byPid = new Map<number, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Map();
  }
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (match === null) continue;
    try {
      const row: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (row === null || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const pid = typeof o.pid === "number" ? o.pid : Number(match[1]);
      if (typeof o.sessionId === "string" && SESSION_ID.test(o.sessionId))
        byPid.set(pid, o.sessionId);
    } catch {
      // Being rewritten; the next scan reads it.
    }
  }
  if (byPid.size === 0) return new Map();
  const parents = (options.parentsOf ?? psParents)([...byPid.keys()]);
  const out = new Map<number, string>();
  for (const [pid, sessionId] of byPid) {
    const parent = parents.get(pid);
    if (parent !== undefined) out.set(parent, sessionId);
    // The run dir can also be keyed by Claude's own pid (a direct launch).
    out.set(pid, sessionId);
  }
  return out;
};

const psParents = (pids: readonly number[]): Map<number, number> => {
  const map = new Map<number, number>();
  try {
    const out = Bun.spawnSync(
      ["ps", "-o", "pid=,ppid=", "-p", pids.map(String).join(",")],
      { stdout: "pipe", stderr: "ignore" },
    );
    for (const line of out.stdout.toString().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (match === null) continue;
      map.set(Number(match[1]), Number(match[2]));
    }
  } catch {
    // No process inspector: live rows keep the ids live.json carries.
  }
  return map;
};

/** Every process's parent pid (one `ps -A`); empty when ps is unavailable. */
const psAllParents = (): Map<number, number> => {
  const map = new Map<number, number>();
  try {
    const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    for (const line of out.stdout.toString().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (match !== null) map.set(Number(match[1]), Number(match[2]));
    }
  } catch {
    // No process inspector: the caller falls back to the ids it has.
  }
  return map;
};

/** Ancestor hops walked from a Claude pid looking for the root. */
const MAX_ANCESTOR_HOPS = 16;

/**
 * The session id the Claude TUI running UNDER `rootPid` (a session-host
 * process, whose child is the `openllm claude` wrapper, whose child is Claude)
 * is on right now, from `~/.claude/sessions/<pid>.json`. That id follows a
 * `/clear` or `/resume` inside the TUI, and is the only link from a terminal
 * run's host id to its transcript. Null when no Claude descends from the root.
 */
export const readClaudeSessionIdUnderPid = (
  rootPid: number,
  options: {
    readonly configDir?: string;
    /** Every pid → parent pid (tests); defaults to one `ps -A`. */
    readonly allParents?: () => Map<number, number>;
  } = {},
): string | null => {
  const dir = join(options.configDir ?? claudeConfigDir(), "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const rows: { pid: number; sessionId: string; updatedAt: number }[] = [];
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (match === null) continue;
    try {
      const row: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (row === null || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      if (typeof o.sessionId !== "string" || !SESSION_ID.test(o.sessionId))
        continue;
      rows.push({
        pid: typeof o.pid === "number" ? o.pid : Number(match[1]),
        sessionId: o.sessionId,
        updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
      });
    } catch {
      // Being rewritten; the next scan reads it.
    }
  }
  if (rows.length === 0) return null;
  const parents = (options.allParents ?? psAllParents)();
  let best: { sessionId: string; updatedAt: number } | null = null;
  for (const row of rows) {
    let pid: number | undefined = row.pid;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && pid !== undefined; hop += 1) {
      if (pid === rootPid) {
        if (best === null || row.updatedAt > best.updatedAt) best = row;
        break;
      }
      const parent = parents.get(pid);
      pid = parent === undefined || parent === pid ? undefined : parent;
    }
  }
  return best?.sessionId ?? null;
};
