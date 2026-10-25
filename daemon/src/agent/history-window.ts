/**
 * Windowed history for agent sessions (after t3code's windowed thread detail
 * with an opaque keyset cursor, translated to turn ids): an attach replays
 * the LATEST whole turns that fit a turn / event / byte budget, and names the
 * cursor before them; `history_get` returns the adjacent, strictly older page.
 * Turn ids are the keyset: they are minted by the engine's transcript parser,
 * so a cursor survives a re-attach, a daemon restart and a resume.
 */
import type { TAgentEvent, TAgentItem } from "@openllmsh/protocol";
import {
  AGENT_HISTORY_MAX_PAGE_EVENTS,
  encodeAgentLine,
} from "@openllmsh/protocol";

/** Attach replays at most this many of the latest turns… */
export const AGENT_REPLAY_WINDOW_TURNS = 30;
/** …and this many events… */
export const AGENT_REPLAY_WINDOW_EVENTS = 1_000;
/** …and this many encoded bytes, whichever comes first (turn boundary). */
export const AGENT_REPLAY_WINDOW_BYTES = 512 * 1024;
/** Turns per `history_get` page when the consumer names no limit. */
export const AGENT_HISTORY_DEFAULT_TURNS = 20;
/** Encoded bytes one `history.page` carries at most (whole turns). */
export const HISTORY_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const encodedBytes = (event: TAgentEvent): number =>
  encodeAgentLine(event)?.byteLength ?? 64 * 1024;

/** The history cursor naming "the turns before `turnId`" (opaque on the wire). */
export const historyCursorOf = (turnId: string): string => `h1:${turnId}`;
/** The turn id a cursor names, or null for a foreign / malformed cursor. */
export const turnIdOfCursor = (cursor: string): string | null =>
  cursor.startsWith("h1:") && cursor.length > 3 ? cursor.slice(3) : null;

const laterThanFirstTurn = (turnId: string): boolean => {
  const match = /^t(\d{1,9})$/.exec(turnId);
  return match?.[1] !== undefined && Number(match[1]) > 1;
};

export type TReplayWindow = {
  readonly events: TAgentEvent[];
  /** The first turn the window holds (its history cursor), or null. */
  readonly firstTurnId: string | null;
  /** Older turns exist before the window. */
  readonly hasMore: boolean;
};

/**
 * The latest window of a session log for an attach replay: the newest whole
 * turns within {@link AGENT_REPLAY_WINDOW_TURNS} / `_EVENTS` / `_BYTES`,
 * cut at a `turn.started`. Session-level events before the cut that still
 * matter (the session's start, its latest title / model) are carried.
 */
export const latestReplayWindow = (
  log: readonly TAgentEvent[],
  limits: {
    readonly turns?: number;
    readonly events?: number;
    readonly bytes?: number;
  } = {},
): TReplayWindow => {
  const maxTurns = limits.turns ?? AGENT_REPLAY_WINDOW_TURNS;
  const maxEvents = limits.events ?? AGENT_REPLAY_WINDOW_EVENTS;
  const maxBytes = limits.bytes ?? AGENT_REPLAY_WINDOW_BYTES;
  let start = 0;
  let turns = 0;
  let bytes = 0;
  let cut = false;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (event === undefined) continue;
    bytes += encodedBytes(event);
    if (event.type !== "turn.started") continue;
    const count = log.length - i;
    // Always keep the newest turn, however large; stop before a turn that
    // would cross a bound.
    if (turns > 0 && (count > maxEvents || bytes > maxBytes)) {
      cut = true;
      break;
    }
    turns += 1;
    start = i;
    if (turns >= maxTurns) {
      cut = log.slice(0, i).some((e) => e.type === "turn.started");
      break;
    }
  }
  if (turns === 0)
    return { events: [...log], firstTurnId: null, hasMore: false };
  const first = log[start];
  const firstTurnId = first?.type === "turn.started" ? first.turn_id : null;
  const carried: TAgentEvent[] = [];
  let started: TAgentEvent | null = null;
  let title: TAgentEvent | null = null;
  let model: TAgentEvent | null = null;
  for (const event of log.slice(0, start)) {
    if (event.type === "session.started") started = event;
    if (event.type !== "session.configured") continue;
    if (event.title !== undefined) title = event;
    if (event.model !== undefined) model = event;
  }
  if (started !== null) carried.push(started);
  if (title !== null) carried.push(title);
  if (model !== null && model !== title) carried.push(model);
  return {
    events: [...carried, ...log.slice(start)],
    firstTurnId,
    // An engine-numbered turn after the first has history before it even
    // when the log no longer holds it (trimmed, or a resumed transcript).
    hasMore: cut || (firstTurnId !== null && laterThanFirstTurn(firstTurnId)),
  };
};

/**
 * A history page from the in-memory log (engines without their own record):
 * the whole turns strictly before `beforeTurnId`, newest `limit` of them.
 */
export const logHistoryPage = (
  log: readonly TAgentEvent[],
  beforeTurnId: string,
  limit: number,
): TReplayWindow | null => {
  const end = log.findIndex(
    (event) => event.type === "turn.started" && event.turn_id === beforeTurnId,
  );
  if (end < 0) return null;
  let start = end;
  let turns = 0;
  for (let i = end - 1; i >= 0 && turns < limit; i -= 1) {
    if (log[i]?.type !== "turn.started") continue;
    turns += 1;
    start = i;
  }
  if (turns === 0) return { events: [], firstTurnId: null, hasMore: false };
  const first = log[start];
  return {
    events: log.slice(start, end),
    firstTurnId: first?.type === "turn.started" ? first.turn_id : null,
    hasMore: log.slice(0, start).some((e) => e.type === "turn.started"),
  };
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Caps for an item's bulky fields when an event has to shrink. */
export type TItemShrinkLimits = {
  /** Assistant / reasoning / notice text. */
  readonly text: number;
  /** Tool output. */
  readonly output: number;
  /** A tool input whose JSON is longer than this is dropped. */
  readonly input: number;
};

/** The item with its bulky fields cut to `limits`. */
export const shrinkAgentItem = (
  item: TAgentItem,
  limits: TItemShrinkLimits,
): TAgentItem => {
  if (item.kind === "notice")
    return item.text === undefined
      ? item
      : { ...item, text: clip(item.text, limits.text) };
  if (item.kind !== "tool_call")
    return { ...item, text: clip(item.text, limits.text) };
  const { input, ...rest } = item;
  let inputChars = Number.POSITIVE_INFINITY;
  try {
    inputChars = JSON.stringify(input)?.length ?? 0;
  } catch {
    // Unserializable: dropped.
  }
  return {
    ...rest,
    ...(input === undefined || inputChars > limits.input ? {} : { input }),
    ...(rest.output === undefined
      ? {}
      : { output: clip(rest.output, limits.output) }),
  };
};

/** The event with its item / delta cut to `limits` (others unchanged). */
const shrinkPageEvent = (
  event: TAgentEvent,
  limits: TItemShrinkLimits,
): TAgentEvent => {
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  )
    return { ...event, item: shrinkAgentItem(event.item, limits) };
  if (event.type === "content.delta")
    return { ...event, delta: clip(event.delta, limits.text) };
  return event;
};

/**
 * Ever smaller caps a page's items are cut to until the page fits its byte
 * bound: the newest turn is always kept whole as turns go, so one turn with
 * large tool outputs would otherwise not fit the frame at all.
 */
const PAGE_SHRINK_LEVELS: readonly TItemShrinkLimits[] = [
  { text: 512 * 1024, output: 16 * 1024, input: 64 * 1024 },
  { text: 64 * 1024, output: 2 * 1024, input: 4 * 1024 },
  { text: 8 * 1024, output: 256, input: 0 },
];

const pageBytes = (events: readonly TAgentEvent[]): number => {
  let bytes = 0;
  for (const event of events) bytes += encodedBytes(event);
  return bytes;
};

/**
 * The page's events within {@link HISTORY_PAGE_MAX_BYTES}: as they are, or
 * with item outputs / texts truncated. The last attempt when nothing fits
 * (the caller answers with an error rather than an undeliverable page).
 */
const fitPageBytes = (events: TAgentEvent[]): TAgentEvent[] => {
  if (pageBytes(events) <= HISTORY_PAGE_MAX_BYTES) return events;
  let shrunk = events;
  for (const limits of PAGE_SHRINK_LEVELS) {
    shrunk = events.map((event) => shrinkPageEvent(event, limits));
    if (pageBytes(shrunk) <= HISTORY_PAGE_MAX_BYTES) return shrunk;
  }
  return shrunk;
};

/**
 * Trim a history page (oldest first) to the page bounds, dropping whole
 * OLDEST turns so the page stays adjacent to the cursor it answers, then
 * truncating item outputs / texts when the newest turn alone is too large.
 */
export const boundHistoryPage = (page: TReplayWindow): TReplayWindow => {
  let bytes = 0;
  for (const event of page.events) bytes += encodedBytes(event);
  if (
    page.events.length <= AGENT_HISTORY_MAX_PAGE_EVENTS &&
    bytes <= HISTORY_PAGE_MAX_BYTES
  )
    return page;
  // Walk back from the newest turn while it fits.
  const events = page.events;
  let start = events.length;
  let total = 0;
  let firstTurnId: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    total += encodedBytes(event);
    if (event.type !== "turn.started") continue;
    if (
      firstTurnId !== null &&
      (events.length - i > AGENT_HISTORY_MAX_PAGE_EVENTS ||
        total > HISTORY_PAGE_MAX_BYTES)
    )
      break;
    start = i;
    firstTurnId = event.turn_id;
  }
  const kept = events.slice(start).slice(-AGENT_HISTORY_MAX_PAGE_EVENTS);
  return {
    events: fitPageBytes(kept),
    firstTurnId,
    hasMore: page.hasMore || start > 0,
  };
};
