/**
 * Claude subagents (Task / Agent tool calls) as nested agent items.
 *
 * Current Claude builds write each subagent's conversation to its own file
 * next to the session transcript:
 *
 *   <projects>/<slug>/<session>.jsonl                       (the session)
 *   <projects>/<slug>/<session>/subagents/agent-<id>.jsonl  (one subagent)
 *   <projects>/<slug>/<session>/subagents/agent-<id>.meta.json
 *     → { toolUseId, description, agentType, finished, … }
 *
 * `meta.toolUseId` is the Task call that spawned it, so every row of that file
 * becomes an item nested under the call (`parent_item_id`). Older builds wrote
 * the same rows inline (`isSidechain: true`); the transcript parser maps those
 * itself. A subagent that spawns its own Task nests one level deeper, through
 * the same lookup.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { TAgentEvent } from "@openllmsh/protocol";
import {
  createTranscriptParser,
  SUBAGENT_TOOL_NAMES,
} from "./claude-transcript";

/** Bytes of one subagent file read per poll at most. */
const READ_CHUNK_BYTES = 512 * 1024;
/** A subagent file is re-looked-up at most this often while missing. */
const SCAN_INTERVAL_MS = 2_000;
/** Subagents followed live at once (oldest dropped first). */
const MAX_FOLLOWED = 32;
/** Nested subagent depth read for a history page / replay. */
const MAX_DEPTH = 3;
/** Child events one subagent contributes to a replay or page (newest kept). */
export const SUBAGENT_REPLAY_MAX_EVENTS = 200;
/** Largest subagent file tail read in one shot (history / replay). */
const ONE_SHOT_MAX_BYTES = 4 * 1024 * 1024;

type TJson = Record<string, unknown>;
const isRecord = (value: unknown): value is TJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `<session>.jsonl` → `<session>/subagents`. */
export const subagentDirOf = (transcriptPath: string): string =>
  join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");

type TSubagentMeta = {
  readonly file: string;
  readonly finished: boolean;
  /** Launched in the background (`requestShape`): its result is its file's. */
  readonly background: boolean;
};

/** The Task / Agent call a subagent file belongs to. */
export type TSubagentCall = {
  readonly toolName: string;
  readonly input: unknown;
  readonly parentItemId?: string;
};

/** The subagent file spawned by `toolUseId`, from its meta, or null. */
export const findSubagent = (
  dir: string,
  toolUseId: string,
): TSubagentMeta | null => {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(meta) || meta.toolUseId !== toolUseId) continue;
    const file = join(dir, name.replace(/\.meta\.json$/, ".jsonl"));
    if (!existsSync(file)) return null;
    return {
      file,
      finished: meta.finished === true,
      background: meta.requestShape === "background",
    };
  }
  return null;
};

/** Read `[from, to)` of a file as text, ending on the last whole line. */
const readRange = (
  file: string,
  from: number,
  maxBytes: number,
): { readonly text: string; readonly next: number; readonly size: number } => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { text: "", next: from, size: from };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(from, size);
    const length = Math.min(size - start, maxBytes);
    if (length <= 0) return { text: "", next: start, size };
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
    const usable = lastNewline >= 0 ? lastNewline + 1 : 0;
    return {
      text: buffer.subarray(0, usable).toString("utf8"),
      next: start + usable,
      size,
    };
  } finally {
    closeSync(fd);
  }
};

/**
 * Every event of one subagent (and the subagents it spawned), nested under
 * `toolUseId`, newest {@link SUBAGENT_REPLAY_MAX_EVENTS} kept per subagent.
 * One-shot: a history page, or the replay of a finished subagent.
 */
export type TSubagentSnapshot = {
  readonly events: TAgentEvent[];
  /** The subagent file and the byte offset read up to (live follow resumes). */
  readonly file: string | null;
  readonly readTo: number;
  readonly finished: boolean;
};

export const subagentEvents = (args: {
  readonly dir: string;
  readonly toolUseId: string;
  readonly turnId: string | undefined;
  readonly toolOutputMax: number;
  /** The spawning call: a background one completes from the file's end. */
  readonly call?: TSubagentCall;
  readonly depth?: number;
}): TSubagentSnapshot => {
  const depth = args.depth ?? 1;
  const empty: TSubagentSnapshot = {
    events: [],
    file: null,
    readTo: 0,
    finished: false,
  };
  const found = findSubagent(args.dir, args.toolUseId);
  if (found === null) return empty;
  let size = 0;
  try {
    const fd = openSync(found.file, "r");
    size = fstatSync(fd).size;
    closeSync(fd);
  } catch {
    return empty;
  }
  const from = Math.max(0, size - ONE_SHOT_MAX_BYTES);
  const range = readRange(found.file, from, ONE_SHOT_MAX_BYTES);
  let text = range.text;
  // Cut into the middle of a line: drop the partial first row.
  if (from > 0) text = text.slice(text.indexOf("\n") + 1);
  const own: TAgentEvent[] = [];
  const nested: { id: string; call: TSubagentCall }[] = [];
  const parser = createTranscriptParser({
    emit: (event) => own.push(event),
    toolOutputMax: args.toolOutputMax,
    parentItemId: args.toolUseId,
    turnId: () => args.turnId,
    onToolUse: (id, name, input) => {
      if (SUBAGENT_TOOL_NAMES.has(name))
        nested.push({
          id,
          call: { toolName: name, input, parentItemId: args.toolUseId },
        });
    },
    ...(found.background && args.call !== undefined
      ? { backgroundCall: args.call }
      : {}),
  });
  parser.push(text);
  const out = own.slice(-SUBAGENT_REPLAY_MAX_EVENTS);
  if (depth < MAX_DEPTH) {
    for (const child of nested) {
      out.push(
        ...subagentEvents({
          ...args,
          toolUseId: child.id,
          call: child.call,
          depth: depth + 1,
        }).events,
      );
    }
  }
  return {
    events: out,
    file: found.file,
    readTo: range.next,
    finished: found.finished,
  };
};

export type TSubagentFollower = {
  /**
   * A Task / Agent call started: follow its subagent file (from `from` when
   * a snapshot already delivered the start of it).
   */
  readonly track: (
    toolUseId: string,
    turnId: string | undefined,
    from?: { readonly file: string; readonly offset: number },
    call?: TSubagentCall,
  ) => void;
  /** Stop following calls not in `keep` (a replay cut them away). */
  readonly retain: (keep: ReadonlySet<string>) => void;
  /** Read what every followed subagent appended since the last pump. */
  readonly pump: () => void;
};

type TFollowed = {
  readonly toolUseId: string;
  readonly turnId: string | undefined;
  file: string | null;
  offset: number;
  lastScan: number;
  readonly call: TSubagentCall | undefined;
  parser: ReturnType<typeof createTranscriptParser> | null;
};

/** Live view of the session's subagents, tailing each subagent file. */
export const createSubagentFollower = (args: {
  /** The session transcript path, once known. */
  readonly transcriptPath: () => string | null;
  readonly emit: (event: TAgentEvent) => void;
  readonly toolOutputMax: number;
  readonly now?: () => number;
  readonly scanIntervalMs?: number;
}): TSubagentFollower => {
  const now = args.now ?? Date.now;
  const scanMs = args.scanIntervalMs ?? SCAN_INTERVAL_MS;
  const followed = new Map<string, TFollowed>();

  const track = (
    toolUseId: string,
    turnId: string | undefined,
    from?: { readonly file: string; readonly offset: number },
    call?: TSubagentCall,
  ): void => {
    if (followed.has(toolUseId)) return;
    if (followed.size >= MAX_FOLLOWED) {
      const oldest = followed.keys().next().value;
      if (oldest !== undefined) followed.delete(oldest);
    }
    const entry: TFollowed = {
      toolUseId,
      turnId,
      file: from?.file ?? null,
      offset: from?.offset ?? 0,
      lastScan: Number.NEGATIVE_INFINITY,
      call,
      parser: null,
    };
    followed.set(toolUseId, entry);
  };

  /** The parser, built once the file (and so its meta) is known. */
  const parserOf = (
    entry: TFollowed,
    background: boolean,
  ): ReturnType<typeof createTranscriptParser> => {
    if (entry.parser !== null) return entry.parser;
    entry.parser = createTranscriptParser({
      emit: args.emit,
      toolOutputMax: args.toolOutputMax,
      parentItemId: entry.toolUseId,
      turnId: () => entry.turnId,
      onToolUse: (id, name, input) => {
        if (SUBAGENT_TOOL_NAMES.has(name))
          track(id, entry.turnId, undefined, {
            toolName: name,
            input,
            parentItemId: entry.toolUseId,
          });
      },
      ...(background && entry.call !== undefined
        ? { backgroundCall: entry.call }
        : {}),
    });
    return entry.parser;
  };

  const pumpOne = (entry: TFollowed): void => {
    const transcript = args.transcriptPath();
    if (transcript === null) return;
    let finished = false;
    if (entry.file === null || entry.parser === null) {
      if (now() - entry.lastScan < scanMs) return;
      entry.lastScan = now();
      const found = findSubagent(subagentDirOf(transcript), entry.toolUseId);
      if (found === null) return;
      entry.file = found.file;
      finished = found.finished;
      parserOf(entry, found.background);
    }
    const parser = entry.parser;
    if (parser === null) return;
    for (let chunk = 0; chunk < 64; chunk += 1) {
      const range = readRange(entry.file, entry.offset, READ_CHUNK_BYTES);
      if (range.size < entry.offset) {
        entry.offset = 0;
        continue;
      }
      if (range.text === "") break;
      entry.offset = range.next;
      parser.push(range.text);
    }
    if (!finished && now() - entry.lastScan >= scanMs) {
      entry.lastScan = now();
      finished =
        findSubagent(subagentDirOf(transcript), entry.toolUseId)?.finished ===
        true;
    }
    if (finished) followed.delete(entry.toolUseId);
  };

  return {
    track,
    retain: (keep) => {
      for (const id of [...followed.keys()])
        if (!keep.has(id)) followed.delete(id);
    },
    pump: () => {
      for (const entry of [...followed.values()]) pumpOne(entry);
    },
  };
};
