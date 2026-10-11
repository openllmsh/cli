/**
 * Claude Code local sessions from ~/.claude/history.jsonl.
 *
 * Each line is a prompt event: { display, timestamp, project, sessionId }.
 * We group by sessionId, take the latest display as title and max timestamp
 * as updated_at, and use project as cwd. Avoids scanning the large
 * projects/<slug>/*.jsonl tree.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { parseUpdatedMs } from "./grok";
import { claudeHistoryPath } from "./paths";
import { truncate } from "./title";
import type { THistorySession } from "./types";

const CLAUDE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;

const readTailLines = (path: string, byteLimit: number): string => {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const size = Math.max(0, stat.size);
    const start = Math.max(0, size - byteLimit);
    const tailSize = size - start;
    if (tailSize === 0) return "";
    const buffer = Buffer.alloc(tailSize);
    let bytesRead = 0;
    let position = start;
    let remaining = tailSize;

    while (remaining > 0) {
      const read = readSync(fd, buffer, bytesRead, remaining, position);
      if (read === 0) break;
      bytesRead += read;
      position += read;
      remaining -= read;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
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

export const readClaudeHistory = (limit: number): THistorySession[] => {
  const path = claudeHistoryPath();
  if (!existsSync(path)) return [];

  let text: string;
  try {
    const stat = statSync(path);
    const fallback = stat.isFile() ? stat.mtimeMs : Date.now();
    text = readTailLines(path, Math.max(0, CLAUDE_HISTORY_TAIL_BYTES));
    const lines = text.split("\n");
    type TAgg = {
      title: string;
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
      const prev = byId.get(id);
      if (prev === undefined || ts >= prev.updated_at_ms) {
        byId.set(id, {
          title:
            display.length > 0
              ? truncate(display)
              : (prev?.title ?? "Untitled"),
          cwd: project ?? prev?.cwd ?? null,
          updated_at_ms: ts,
        });
      } else if (prev.cwd === null && project !== null) {
        byId.set(id, { ...prev, cwd: project });
      }
    }
    return [...byId.entries()]
      .map(([id, v]) => ({
        id,
        title: v.title,
        cwd: v.cwd,
        updated_at_ms: v.updated_at_ms,
        cli: "claude_code" as const,
      }))
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
      .slice(0, limit);
  } catch {
    return [];
  }
};
