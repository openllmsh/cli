/**
 * Paged history of a Claude transcript (`history_get`).
 *
 * A turn index maps each turn the transcript parser opens (`t1`, `t2`, …) to
 * the byte offset of the line that opened it. It is built once per transcript
 * and extended incrementally — only bytes appended since the last page are
 * scanned — so paging a multi-MB transcript never re-reads it whole. A page
 * reads exactly the byte range of its turns and parses it with the turn
 * counter set to the page's first ordinal, so its ids match the live stream's.
 * Task / Agent calls in the page bring their subagent's items with them.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { TAgentEvent } from "@openllmsh/protocol";
import { subagentDirOf, subagentEvents } from "./claude-subagents";
import {
  createTranscriptParser,
  SUBAGENT_TOOL_NAMES,
} from "./claude-transcript";

/** Bytes scanned per index read. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

export type TClaudeHistoryPage = {
  /** Oldest first. */
  readonly events: TAgentEvent[];
  /** The first turn in the page (`t<n>`), or null when it holds none. */
  readonly firstTurnId: string | null;
  readonly hasMore: boolean;
};

export type TClaudeHistory = {
  /** The turns strictly before `beforeTurnId`, newest `limit` of them. */
  readonly page: (
    beforeTurnId: string,
    limit: number,
  ) => TClaudeHistoryPage | null;
  /** Turns indexed so far (tests, diagnostics). */
  readonly turnCount: () => number;
};

/** `t<n>` → n, or null. */
export const turnOrdinal = (turnId: string): number | null => {
  const match = /^t(\d{1,9})$/.exec(turnId);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const readBytes = (path: string, from: number, to: number): Buffer | null => {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const length = Math.max(0, to - from);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
};

const sizeOf = (path: string): number | null => {
  try {
    const fd = openSync(path, "r");
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
};

/**
 * History over one transcript file. `path` is re-read on every page so a
 * `/clear` that moves the session to another file starts a fresh index.
 */
export const createClaudeHistory = (args: {
  readonly path: () => string | null;
  readonly toolOutputMax: number;
}): TClaudeHistory => {
  let indexedPath: string | null = null;
  /** Byte offset of the line opening turn n+1, at index n. */
  let starts: number[] = [];
  let scannedTo = 0;
  let offsetOfLine = 0;
  let parser = createTranscriptParser({
    emit: () => {},
    toolOutputMax: 0,
  });

  const reset = (path: string): void => {
    indexedPath = path;
    starts = [];
    scannedTo = 0;
    parser = createTranscriptParser({
      emit: (event) => {
        if (event.type === "turn.started") starts.push(offsetOfLine);
      },
      toolOutputMax: 0,
    });
  };

  /** Extend the index to the transcript's current end. */
  const scan = (path: string): number | null => {
    if (path !== indexedPath) reset(path);
    const size = sizeOf(path);
    if (size === null) return null;
    if (size < scannedTo) reset(path); // rewritten
    while (scannedTo < size) {
      const chunk = readBytes(
        path,
        scannedTo,
        Math.min(size, scannedTo + SCAN_CHUNK_BYTES),
      );
      if (chunk === null || chunk.byteLength === 0) break;
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // One line longer than a chunk: index it whole.
        if (scannedTo + chunk.byteLength >= size) break;
        const whole = readBytes(path, scannedTo, size);
        if (whole === null) break;
        const end = whole.indexOf(0x0a);
        if (end < 0) break;
        offsetOfLine = scannedTo;
        parser.push(whole.subarray(0, end + 1).toString("utf8"));
        scannedTo += end + 1;
        continue;
      }
      let lineStart = 0;
      while (lineStart <= lastNewline) {
        const end = chunk.indexOf(0x0a, lineStart);
        offsetOfLine = scannedTo + lineStart;
        parser.push(chunk.subarray(lineStart, end + 1).toString("utf8"));
        lineStart = end + 1;
      }
      scannedTo += lastNewline + 1;
    }
    return scannedTo;
  };

  return {
    turnCount: () => starts.length,
    page: (beforeTurnId, limit) => {
      const before = turnOrdinal(beforeTurnId);
      const path = args.path();
      if (before === null || path === null) return null;
      const end = scan(path);
      if (end === null) return null;
      // Turn n (1-based) starts at starts[n - 1]; the page ends where turn
      // `before` starts (or at the indexed end when the index is shorter).
      const lastTurn = Math.min(before - 1, starts.length);
      if (lastTurn < 1)
        return { events: [], firstTurnId: null, hasMore: false };
      const firstTurn = Math.max(1, lastTurn - limit + 1);
      const from = starts[firstTurn - 1] ?? 0;
      const to = lastTurn < starts.length ? (starts[lastTurn] ?? end) : end;
      const bytes = readBytes(path, from, to);
      if (bytes === null) return null;
      const events: TAgentEvent[] = [];
      const tasks: {
        id: string;
        turnId: string | undefined;
        toolName: string;
        input: unknown;
      }[] = [];
      const pageParser = createTranscriptParser({
        emit: (event) => {
          events.push(event);
          if (
            event.type === "item.started" &&
            event.item.kind === "tool_call" &&
            event.parent_item_id === undefined &&
            SUBAGENT_TOOL_NAMES.has(event.item.tool_name)
          )
            tasks.push({
              id: event.item_id,
              turnId: event.turn_id,
              toolName: event.item.tool_name,
              input: event.item.input,
            });
        },
        toolOutputMax: args.toolOutputMax,
        firstTurn: firstTurn - 1,
      });
      pageParser.push(bytes.toString("utf8"));
      // The page's last turn is over (a later turn exists): close it.
      pageParser.completeTurn();
      // A background subagent launched here may finish in a later turn: its
      // notification lies past the page, and the page would show it running.
      if (pageParser.openBackground() > 0 && to < end) {
        const later = readBytes(path, to, end);
        if (later !== null) pageParser.settleBackground(later.toString("utf8"));
      }
      const dir = subagentDirOf(path);
      for (const task of tasks) {
        events.push(
          ...subagentEvents({
            dir,
            toolUseId: task.id,
            turnId: task.turnId,
            toolOutputMax: args.toolOutputMax,
            call: { toolName: task.toolName, input: task.input },
          }).events,
        );
      }
      return {
        events,
        firstTurnId: `t${firstTurn}`,
        hasMore: firstTurn > 1,
      };
    },
  };
};
