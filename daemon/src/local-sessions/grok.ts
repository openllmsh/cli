/**
 * Grok local sessions from ~/.grok/sessions/<cwd-encoded>/<id>/summary.json.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { grokSessionsDir } from "./paths";
import { truncate } from "./title";
import type { THistorySession } from "./types";

type TSummaryFile = {
  readonly path: string;
  readonly mtime: number;
};

const MAX_WALK_DEPTH = 6;
const MAX_WALK_BURST = 8;
const MAX_PARSE_BURST = 8;

export const parseUpdatedMs = (raw: unknown, fallback: number): number => {
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return fallback;
};

const walkSummaryCandidates = async (
  root: string,
  candidates: TSummaryFile[],
): Promise<void> => {
  const work: Array<{ readonly dir: string; readonly depth: number }> = [
    { dir: root, depth: 0 },
  ];

  const visit = async ({
    dir,
    depth,
  }: {
    readonly dir: string;
    readonly depth: number;
  }): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (
        entry.name === "session_search.sqlite" ||
        entry.name.endsWith(".lock")
      ) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        work.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.name !== "summary.json") continue;
      const file = await stat(path).catch(() => null);
      if (file?.isFile()) {
        candidates.push({ path, mtime: file.mtimeMs });
      }
    }
  };

  while (work.length > 0) {
    const batch = work.splice(0, MAX_WALK_BURST);
    await Promise.all(batch.map(visit));
  }
};

const forEachLimit = async <T>(
  values: readonly T[],
  limit: number,
  visit: (value: T) => Promise<void>,
): Promise<void> => {
  const maxConcurrency = Math.max(1, Math.floor(limit));
  let cursor = 0;
  const workers: Array<Promise<void>> = [];

  const run = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await visit(values[index] as T);
    }
  };

  for (let i = 0; i < maxConcurrency && i < values.length; i += 1) {
    workers.push(run());
  }

  await Promise.all(workers);
};

export const readGrokHistory = async (
  limit: number,
): Promise<THistorySession[]> => {
  if (limit <= 0) return [];

  const root = grokSessionsDir();
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) return [];

  const parseBudget = Math.max(1, Math.min(Math.floor(limit), 400));
  const candidates: TSummaryFile[] = [];
  await walkSummaryCandidates(root, candidates);

  const toParse = [...candidates]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, parseBudget * 2);

  const sessions: THistorySession[] = [];
  await forEachLimit(toParse, MAX_PARSE_BURST, async ({ path, mtime }) => {
    try {
      const text = await readFile(path, "utf8");
      const raw = JSON.parse(text) as {
        info?: { id?: string; cwd?: string };
        session_summary?: string;
        updated_at?: string;
        created_at?: string;
      };
      const id = raw.info?.id;
      if (typeof id !== "string" || id.length === 0) return;
      const summary =
        typeof raw.session_summary === "string" ? raw.session_summary : "";
      sessions.push({
        id,
        title: summary.length > 0 ? truncate(summary) : "Untitled",
        cwd: typeof raw.info?.cwd === "string" ? raw.info.cwd : null,
        updated_at_ms: parseUpdatedMs(
          raw.updated_at,
          parseUpdatedMs(raw.created_at, mtime),
        ),
        cli: "grok",
      });
    } catch {
      /* skip */
    }
  });

  return sessions
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
    .slice(0, limit);
};
