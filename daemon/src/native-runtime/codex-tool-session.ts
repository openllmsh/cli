/**
 * Codex tool-passthrough — completion tool semantics for `chatgpt`, using the
 * app-server's NATIVE dynamic-tool protocol (no manual Responses path, unlike
 * what the removed manual transport did):
 *
 *   - `thread/start` registers the client's function tools as `dynamicTools`
 *     ({ type:"function", name, description, inputSchema }); `inputSchema` is
 *     raw JSON, so the client's JSON-Schema passes through directly.
 *   - When the model calls a dynamic tool the app-server sends the server→client
 *     request `item/tool/call` ({ callId, tool, arguments }) and PAUSES the turn
 *     awaiting our response — the daemon relays the call to the CLIENT as
 *     `tool_calls`, holds the live turn, and on the next request responds to the
 *     held `item/tool/call` with the client's result
 *     (`{ contentItems:[{type:"inputText",text}], success:true }`), continuing.
 *
 * A full agentic task is ONE held app-server turn. Shares the result shape +
 * canonical encoder with the Claude tool path (`claude-tool-session.ts`).
 *
 * A 2026-07-14 live probe settled the protocol facts this path relies on (audit
 * 2026-07-14-codex-upstream-wire §6): with `features.code_mode:false` on
 * `thread/start`, codex-cli 0.144.0 emits `item/tool/call` and the turn
 * completes after we answer with `{ callId, contentItems:[…], success }`.
 * Per-turn usage is folded from `thread/tokenUsage/updated`, and a drive()
 * timeout interrupts the still-running turn. Parallel tool calls pair by
 * protocol `callId` (not positional — unlike the Claude path's earlier bug).
 */

import type { TServerSearchCall } from "@openllmsh/protocol";
import type {
  TClientTool,
  TToolCallOut,
  TToolTurnResult,
} from "./claude-tool-session";
import {
  type CodexAppServerClient,
  clientFor,
  codexDynamicToolsFrom,
  codexToolStartParams,
  codexTurnStartParams,
  effortOf,
} from "./codex-app-server";
import type { TNativeTokens } from "./types";
import { tokensFromResponse } from "./types";

const HELD_TTL_MS = 10 * 60 * 1000;
const DRIVE_TIMEOUT_MS = 120_000;
const nowMs = (): number => Date.now();

type TEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      requestId: number;
      callId: string;
      tool: string;
      args: unknown;
    }
  | { kind: "search"; call: TServerSearchCall }
  | { kind: "done"; status: string; error: string | null };

type THeld = {
  readonly client: CodexAppServerClient;
  readonly threadId: string;
  /** The live turn id (from `turn/start`) — needed to `turn/interrupt` a
   *  stalled turn so it doesn't keep generating in the SHARED app-server
   *  process (Batch B). */
  turnId: string | null;
  /** callId → the JSON-RPC request id of the paused `item/tool/call`. */
  readonly pending: Map<string, number>;
  readonly queue: TEvent[];
  wake: (() => void) | null;
  /** THIS turn's usage (`thread/tokenUsage/updated.last`), folded to the daemon
   *  row shape so a tool turn is billed like the text path (Batch B). */
  usage: TNativeTokens | undefined;
  /** Whether any `item/agentMessage/delta` arrived for the CURRENT message.
   *  The runtime emits BOTH streamed deltas AND a terminal `item/completed`
   *  full message; without this guard both get appended and the text doubles
   *  (parity with runCodexNative's `sawDelta`). Reset when a tool call splits
   *  the turn into a new message. */
  sawDelta: boolean;
  lastUsed: number;
};

/** Held (paused) turns, indexed by EACH pending tool callId. */
const held = new Map<string, THeld>();

const dropIndex = (h: THeld): void => {
  for (const [id, entry] of held) if (entry === h) held.delete(id);
};

const evictStale = (): void => {
  const cutoff = nowMs() - HELD_TTL_MS;
  const stale = new Set<THeld>();
  for (const [, h] of held) if (h.lastUsed < cutoff) stale.add(h);
  for (const h of stale) {
    // Unblock the SHARED app-server before detaching: answer any paused
    // `item/tool/call` with a failure so the turn ends server-side instead of
    // hanging in the one process all codex traffic shares (a worse blast radius
    // than Claude's per-session subprocess).
    for (const [, requestId] of h.pending) {
      h.client.respondToServer(requestId, {
        contentItems: [{ type: "inputText", text: "(cancelled)" }],
        success: false,
      });
    }
    h.pending.clear();
    h.client.removeSink(h.threadId);
    dropIndex(h);
  }
};

// Background sweep (parity with the Claude tool path): reclaim abandoned held
// turns even when no further codex tool request arrives. `.unref()` so the
// timer never keeps the daemon alive on its own (harmless while `held` is
// empty).
const sweep = setInterval(evictStale, HELD_TTL_MS);
sweep.unref?.();

const push = (h: THeld, e: TEvent): void => {
  h.queue.push(e);
  const w = h.wake;
  h.wake = null;
  w?.();
};

const attachSink = (h: THeld): void => {
  h.client.addSink({
    threadId: h.threadId,
    onDelta: (t) => {
      h.sawDelta = true;
      push(h, { kind: "text", text: t });
    },
    // Full-message completion — skip if deltas already streamed it, or the
    // text doubles.
    onAgentMessage: (t) => {
      if (h.sawDelta) return;
      push(h, { kind: "text", text: t });
    },
    // Fold the app-server's per-turn usage to the daemon row shape (Batch B —
    // was a no-op, so tool turns recorded ZERO tokens).
    onUsage: (u) => {
      h.usage = tokensFromResponse({ usage: u });
    },
    onCompleted: (status, error) => push(h, { kind: "done", status, error }),
    onToolCall: (requestId, callId, tool, args) =>
      push(h, { kind: "tool", requestId, callId, tool, args }),
    // Hosted web search completed inside the held turn — surfaced on the
    // result so the serve layer re-encodes the lifecycle on the client wire.
    onWebSearch: (call) => push(h, { kind: "search", call }),
  });
};

export type TStartCodexToolTurnParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly tools: ReadonlyArray<TClientTool>;
  readonly systemText: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier?: unknown;
  readonly modelContextWindow?: number | null;
  readonly userText: string;
  /**
   * When true (serve selected `bridge-capture`), use the isolated capture
   * tool path instead of the shared warm app-server tool loop. Capture
   * returns daemon-owned chunks via {@link runCodexCapturedToolTurn}; this
   * helper declines with an explicit reason so the serve integrator can
   * switch to the capture entry point (or map chunks → tool_calls) without
   * accidentally executing `item/tool/call` on the builder.
   */
  readonly bridgeCapture?: boolean;
};

/** Start a NEW tool-bearing Codex turn. */
export const startCodexToolTurn = async (
  params: TStartCodexToolTurnParams,
): Promise<TToolTurnResult> => {
  evictStale();
  if (params.bridgeCapture === true) {
    // Capture tool turns are not the held `item/tool/call` loop — serve must
    // call `runCodexCapturedToolTurn` and decode daemon-owned chunks. Refuse
    // here so a half-wired bridgeCapture flag cannot silently fall through
    // to the warm execution boundary.
    return {
      kind: "declined",
      reason:
        "codex bridge-capture tool turns require runCodexCapturedToolTurn (not the held item/tool/call loop)",
    };
  }
  // Hosted search (thread config, always-on) and a client-executed
  // `web_search` function are mutually exclusive on one turn — dropped by
  // `codexDynamicToolsFrom` so the client copy can't shadow the
  // provider-owned tool. An empty remainder still starts the turn: the model
  // answers via hosted search.
  const client = clientFor(params.bin, params.env);
  let threadId: string;
  try {
    await client.ensureStarted();
    const started = (await client.request(
      "thread/start",
      await client.prepareThreadParams(
        codexToolStartParams(
          params.providerModelId,
          params.systemText,
          codexDynamicToolsFrom(params.tools),
          params.serviceTier,
          params.modelContextWindow,
        ),
      ),
    )) as { thread?: { id?: string } };
    if (typeof started.thread?.id !== "string") {
      return { kind: "declined", reason: "thread/start returned no thread id" };
    }
    threadId = started.thread.id;
  } catch (error) {
    return {
      kind: "declined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const h: THeld = {
    client,
    threadId,
    turnId: null,
    pending: new Map(),
    queue: [],
    wake: null,
    usage: undefined,
    sawDelta: false,
    lastUsed: nowMs(),
  };
  attachSink(h);

  const effort = effortOf(params.reasoningEffort);
  try {
    const turn = (await client.request(
      "turn/start",
      codexTurnStartParams(
        threadId,
        params.userText,
        effort,
        params.serviceTier,
      ),
    )) as { turn?: { id?: string } };
    h.turnId = typeof turn.turn?.id === "string" ? turn.turn.id : null;
  } catch (error) {
    client.removeSink(threadId);
    return {
      kind: "declined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return drive(h);
};

/** Continue a HELD Codex turn: answer the paused dynamic-tool calls with the
 *  client's results, then drive to the next tool call or final text.
 *  `injectedContext` is conversation context the client added alongside the
 *  results (e.g. loaded Skill instructions) — the paused `item/tool/call` is
 *  the only channel back into the live turn, so it rides the LAST answer as
 *  an extra `inputText` content item instead of being dropped. */
export const continueCodexToolTurn = async (
  toolResults: ReadonlyArray<{ readonly id: string; readonly content: string }>,
  injectedContext: string | null = null,
): Promise<TToolTurnResult> => {
  evictStale();
  const h = toolResults.map((r) => held.get(r.id)).find((x) => x !== undefined);
  if (h === undefined) {
    return { kind: "declined", reason: "no held codex tool session" };
  }
  const matched = toolResults.filter((r) => h.pending.has(r.id));
  for (const [index, r] of matched.entries()) {
    const requestId = h.pending.get(r.id);
    if (requestId === undefined) continue;
    h.pending.delete(r.id);
    held.delete(r.id);
    const last = index === matched.length - 1;
    h.client.respondToServer(requestId, {
      contentItems: [
        { type: "inputText", text: r.content },
        ...(last && injectedContext !== null
          ? [{ type: "inputText" as const, text: injectedContext }]
          : []),
      ],
      success: true,
    });
  }
  h.lastUsed = nowMs();
  return drive(h);
};

/** Drain events until the model calls tool(s) (→ tool_calls) or the turn
 *  completes (→ final text). */
const drive = async (h: THeld): Promise<TToolTurnResult> => {
  let text = "";
  const toolCalls: TToolCallOut[] = [];
  const serverSearchCalls: TServerSearchCall[] = [];
  const deadline = nowMs() + DRIVE_TIMEOUT_MS;
  for (;;) {
    const e = h.queue.shift();
    if (e === undefined) {
      // No pending event: if we've already collected tool calls, return them;
      // otherwise wait for the next event (bounded).
      if (toolCalls.length > 0) {
        return pauseReturn(h, text, toolCalls, serverSearchCalls);
      }
      if (nowMs() > deadline) {
        // Interrupt the still-running turn before detaching, or the vendor keeps
        // generating in the shared app-server process (Batch B — parity with
        // runCodexNative's abort). Best-effort.
        if (h.turnId !== null) {
          void h.client
            .request("turn/interrupt", {
              threadId: h.threadId,
              turnId: h.turnId,
            })
            .catch(() => undefined);
        }
        h.client.removeSink(h.threadId);
        dropIndex(h);
        return { kind: "declined", reason: "codex tool turn timed out" };
      }
      await Promise.race([
        new Promise<void>((r) => {
          h.wake = r;
        }),
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
      continue;
    }
    if (e.kind === "text") {
      text += e.text;
      continue;
    }
    if (e.kind === "search") {
      serverSearchCalls.push(e.call);
      continue;
    }
    if (e.kind === "tool") {
      h.pending.set(e.callId, e.requestId);
      held.set(e.callId, h);
      // A tool call ends the current assistant message; the post-tool-result
      // message is fresh, so re-arm the delta/full-message dedup guard.
      h.sawDelta = false;
      toolCalls.push({
        id: e.callId,
        name: e.tool,
        argumentsJson:
          typeof e.args === "string" ? e.args : JSON.stringify(e.args ?? {}),
      });
      continue; // batch any back-to-back tool calls before returning
    }
    // done
    h.client.removeSink(h.threadId);
    dropIndex(h);
    if (toolCalls.length > 0) {
      return pauseReturn(h, text, toolCalls, serverSearchCalls);
    }
    return {
      kind: "final",
      text,
      ...(h.usage ? { usage: h.usage } : {}),
      ...(serverSearchCalls.length > 0 ? { serverSearchCalls } : {}),
    };
  }
};

const pauseReturn = (
  h: THeld,
  text: string,
  toolCalls: ReadonlyArray<TToolCallOut>,
  serverSearchCalls: ReadonlyArray<TServerSearchCall>,
): TToolTurnResult => {
  h.lastUsed = nowMs();
  return {
    kind: "tool_calls",
    text,
    toolCalls,
    ...(h.usage ? { usage: h.usage } : {}),
    ...(serverSearchCalls.length > 0 ? { serverSearchCalls } : {}),
  };
};
