/**
 * OpenCode local sessions from `~/.local/share/opencode/opencode.db`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { opencodeDbPath } from "./paths";
import { truncate } from "./title";
import type { THistorySession } from "./types";

export const readOpencodeHistory = (limit: number): THistorySession[] => {
  const path = opencodeDbPath();
  if (!existsSync(path)) return [];
  try {
    const db = new Database(path, { readonly: true, create: false });
    try {
      const rows = db
        .query(
          `SELECT id, title, directory, time_updated, time_archived
           FROM session
           WHERE time_archived IS NULL
           ORDER BY time_updated DESC
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      const out: THistorySession[] = [];
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id : null;
        if (id === null) continue;
        const title =
          typeof row.title === "string" && row.title.trim().length > 0
            ? truncate(row.title)
            : "Untitled";
        const cwd = typeof row.directory === "string" ? row.directory : null;
        const updated =
          typeof row.time_updated === "number" ? row.time_updated : 0;
        out.push({
          id,
          title,
          cwd,
          updated_at_ms: updated,
          cli: "opencode",
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
};
