/**
 * Claude Code's own session transcript (`~/.claude/projects/<slug>/<id>.jsonl`)
 * as agent events — the history a resumed session replays to its consumer.
 *
 * Attach to a session the daemon still runs replays the in-memory log. Once
 * the engine has exited (daemon restart, idle reap), `attach` resumes with
 * `--resume <id>`, and Claude's transcript is the only record of the earlier
 * turns: this turns its prompts and assistant text into the same
 * `turn.started{prompt}` / `item.completed` / `turn.completed` events a live
 * turn produces, so the web timeline is rebuilt before new turns stream in.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { TAgentEvent } from "@openllmsh/protocol";
import { claudeConfigDir } from "../local-sessions/paths";

/** Transcript bytes read from the end of the file. */
export const CLAUDE_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

/** `<projects>/<slug>/<id>.jsonl` for the session, or null. */
export const findClaudeTranscript = (
  sessionId: string,
  projectsDir: string = join(claudeConfigDir(), "projects"),
): string | null => {
  if (!SESSION_ID.test(sessionId) || !existsSync(projectsDir)) return null;
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const path = join(projectsDir, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
};

const readTail = (path: string, limit: number): string => {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
};

type TBlock = { readonly type?: unknown; readonly text?: unknown };

const textOf = (content: unknown): string | null => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // A user line made only of tool_result blocks is not a prompt.
  const texts = (content as TBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
  return texts.length === 0 ? null : texts.join("\n");
};

/** Agent events for the transcript's prompts and assistant text, in order. */
export const claudeTranscriptEvents = (raw: string): TAgentEvent[] => {
  const events: TAgentEvent[] = [];
  let turn = 0;
  let open: string | null = null;
  let item = 0;
  const closeTurn = (): void => {
    if (open === null) return;
    events.push({ type: "turn.completed", turn_id: open });
    open = null;
  };
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let row: {
      type?: unknown;
      isSidechain?: unknown;
      isMeta?: unknown;
      message?: { content?: unknown };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain === true || row.isMeta === true) continue;
    const text = textOf(row.message?.content);
    if (text === null || text.trim() === "") continue;
    if (row.type === "user") {
      // Slash-command / hook wrappers are bookkeeping, not prompts.
      if (text.startsWith("<")) continue;
      closeTurn();
      turn += 1;
      open = `h${turn}`;
      events.push({ type: "turn.started", turn_id: open, prompt: text });
    } else if (row.type === "assistant" && open !== null) {
      item += 1;
      events.push({
        type: "item.completed",
        item_id: `h${turn}-i${item}`,
        turn_id: open,
        item: { kind: "assistant_message", text },
      });
    }
  }
  closeTurn();
  return events;
};

/** History events of a persisted Claude session; empty when unreadable. */
export const readClaudeTranscriptEvents = (
  sessionId: string,
): TAgentEvent[] => {
  try {
    const path = findClaudeTranscript(sessionId);
    if (path === null) return [];
    return claudeTranscriptEvents(readTail(path, CLAUDE_TRANSCRIPT_TAIL_BYTES));
  } catch {
    return [];
  }
};
