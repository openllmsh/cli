/**
 * Memory hook settings come from `MEMORY_<NAME>` env vars. The plugin was
 * called supermemory before the rename, so `SUPERMEMORY_<NAME>` is still
 * honoured as a fallback for configs written by released clients.
 */
export const memoryEnv = (name: string): string | undefined =>
  process.env[`MEMORY_${name}`] ?? process.env[`SUPERMEMORY_${name}`];

/** The marker that opens an auto-recall block injected into a prompt. */
export const RECALL_MARKER = "[memory]";

/** Pre-rename marker; transcripts written by released clients still carry it. */
export const LEGACY_RECALL_MARKER = "[supermemory]";
