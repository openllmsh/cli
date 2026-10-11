/**
 * Bounded buffer for `auth.*` events emitted while the control WebSocket is
 * not ready (closed, reconnecting, or hello not yet sent).
 *
 * Login FSM on the wire: one `started`, ≥0 `prompt`s, exactly one terminal.
 * Across a gap we keep, per `flow_id`: the first `started`, the latest
 * `prompt`, and the first terminal. Non-login events (session.lost /
 * liveness.degraded) keep the latest per slug. Each retained event keeps
 * (or, on prompt/slug replace, takes) a global enqueue sequence; peek
 * restores that order. A live socket never enqueues, so a never-dropped
 * channel re-delivers nothing.
 */
import type { TAuthEvent } from "@openllmsh/protocol";

const MAX_FLOWS = 8;

type TRetained = {
  readonly token: number;
  seq: number;
  event: TAuthEvent;
};

type TLoginGap = {
  started: TRetained | null;
  prompt: TRetained | null;
  terminal: TRetained | null;
};

type TFlowKey =
  | { readonly kind: "login"; readonly flowId: string }
  | { readonly kind: "slug"; readonly key: string };

let nextSeq = 1;
let nextToken = 1;
let flushing = false;

const loginGaps = new Map<string, TLoginGap>();
const slugGaps = new Map<string, TRetained>();
const flowOrder: TFlowKey[] = [];

export type TAuthGapBatchEntry = {
  readonly token: number;
  readonly event: TAuthEvent;
};

const flowIdOf = (event: TAuthEvent): string | null => {
  if (
    event.event === "auth.login.started" ||
    event.event === "auth.login.prompt" ||
    event.event === "auth.login.succeeded" ||
    event.event === "auth.login.failed"
  ) {
    return event.flow_id;
  }
  return null;
};

const retain = (event: TAuthEvent): TRetained => ({
  token: nextToken,
  seq: nextSeq,
  event,
});

const stamp = (event: TAuthEvent): TRetained => {
  const entry = retain(event);
  nextToken += 1;
  nextSeq += 1;
  return entry;
};

const restamp = (event: TAuthEvent): TRetained => stamp(event);

const flowCount = (): number => loginGaps.size + slugGaps.size;

const sameFlow = (a: TFlowKey, b: TFlowKey): boolean =>
  a.kind === "login" && b.kind === "login"
    ? a.flowId === b.flowId
    : a.kind === "slug" && b.kind === "slug"
      ? a.key === b.key
      : false;

const dropFlowKey = (key: TFlowKey): void => {
  const idx = flowOrder.findIndex((item) => sameFlow(item, key));
  if (idx >= 0) flowOrder.splice(idx, 1);
};

const evictOldestFlow = (): void => {
  const oldest = flowOrder.shift();
  if (oldest === undefined) return;
  if (oldest.kind === "login") loginGaps.delete(oldest.flowId);
  else slugGaps.delete(oldest.key);
};

const ensureFlow = (key: TFlowKey): void => {
  const exists =
    key.kind === "login" ? loginGaps.has(key.flowId) : slugGaps.has(key.key);
  if (exists) return;
  if (flowCount() >= MAX_FLOWS) evictOldestFlow();
  flowOrder.push(key);
};

const touchLogin = (flowId: string): TLoginGap => {
  let gap = loginGaps.get(flowId);
  if (gap === undefined) {
    ensureFlow({ kind: "login", flowId });
    gap = { started: null, prompt: null, terminal: null };
    loginGaps.set(flowId, gap);
  }
  return gap;
};

const loginEmpty = (gap: TLoginGap): boolean =>
  gap.started === null && gap.prompt === null && gap.terminal === null;

const dropLoginIfEmpty = (flowId: string, gap: TLoginGap): void => {
  if (!loginEmpty(gap)) return;
  loginGaps.delete(flowId);
  dropFlowKey({ kind: "login", flowId });
};

/** Queue an event that did not leave the socket. Collapses per flow / slug. */
export const enqueueAuthGap = (event: TAuthEvent): void => {
  const flowId = flowIdOf(event);
  if (flowId !== null) {
    const gap = touchLogin(flowId);
    if (event.event === "auth.login.started") {
      if (gap.started === null) gap.started = stamp(event);
      return;
    }
    if (event.event === "auth.login.prompt") {
      gap.prompt = restamp(event);
      return;
    }
    if (gap.terminal === null) gap.terminal = stamp(event);
    return;
  }
  const key = `${event.event}:${event.slug}`;
  ensureFlow({ kind: "slug", key });
  slugGaps.set(key, restamp(event));
};

const retainedEntries = (): TRetained[] => {
  const out: TRetained[] = [];
  for (const gap of loginGaps.values()) {
    if (gap.started !== null) out.push(gap.started);
    if (gap.prompt !== null) out.push(gap.prompt);
    if (gap.terminal !== null) out.push(gap.terminal);
  }
  for (const entry of slugGaps.values()) out.push(entry);
  out.sort((a, b) => a.seq - b.seq);
  return out;
};

/** Snapshot in global enqueue order without mutating the buffer. */
export const peekAuthGap = (): TAuthEvent[] =>
  retainedEntries().map((entry) => entry.event);

/** Opaque tokens for the current snapshot — commit these, never a prefix length. */
export const peekAuthGapBatch = (): TAuthGapBatchEntry[] =>
  retainedEntries().map((entry) => ({
    token: entry.token,
    event: entry.event,
  }));

const dropToken = (token: number): void => {
  for (const [flowId, gap] of loginGaps) {
    if (gap.started?.token === token) {
      gap.started = null;
      dropLoginIfEmpty(flowId, gap);
      return;
    }
    if (gap.prompt?.token === token) {
      gap.prompt = null;
      dropLoginIfEmpty(flowId, gap);
      return;
    }
    if (gap.terminal?.token === token) {
      gap.terminal = null;
      dropLoginIfEmpty(flowId, gap);
      return;
    }
  }
  for (const [key, entry] of slugGaps) {
    if (entry.token === token) {
      slugGaps.delete(key);
      dropFlowKey({ kind: "slug", key });
      return;
    }
  }
};

/**
 * Drop the exact retained events identified by `tokens`. Replacing a prompt
 * (or slug) during flush mints a new token; committing the sent token cannot
 * drop the replacement.
 */
export const commitAuthGap = (tokens: ReadonlyArray<number>): void => {
  if (tokens.length === 0) return;
  for (const token of tokens) dropToken(token);
};

/**
 * Attempt to send buffered events. Does not remove anything until `trySend`
 * returns true. Stops (and retains the current event plus the tail) on the
 * first false or throw — typically a missing key id, a closed socket, or
 * hello not yet sent. Reentrant calls are no-ops so a nested flush cannot
 * duplicate sends.
 */
export const flushAuthGap = (
  keyId: string | null,
  trySend: (event: TAuthEvent) => boolean,
): number => {
  if (keyId === null) return 0;
  if (flushing) return 0;
  flushing = true;
  const committed: number[] = [];
  try {
    const pending = peekAuthGapBatch();
    for (const entry of pending) {
      let ok = false;
      try {
        ok = trySend(entry.event);
      } catch {
        ok = false;
      }
      if (!ok) break;
      committed.push(entry.token);
    }
    commitAuthGap(committed);
    return committed.length;
  } finally {
    flushing = false;
  }
};

/** Drain in global enqueue order of the retained (collapsed) events. */
export const drainAuthGap = (): TAuthEvent[] => {
  const out = peekAuthGap();
  clearAuthGap();
  return out;
};

export const clearAuthGap = (): void => {
  loginGaps.clear();
  slugGaps.clear();
  flowOrder.length = 0;
};

export const authGapSize = (): number => {
  let n = 0;
  for (const gap of loginGaps.values()) {
    if (gap.started !== null) n += 1;
    if (gap.prompt !== null) n += 1;
    if (gap.terminal !== null) n += 1;
  }
  n += slugGaps.size;
  return n;
};

export const AUTH_GAP_MAX_FLOWS = MAX_FLOWS;
