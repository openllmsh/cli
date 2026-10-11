/**
 * Claude tool-passthrough — the held-open `query()` orchestrator for
 * TOOL-bearing `claude_code` requests, so a stateless `/v1/*` completion
 * client (which runs its OWN tools) can use the Claude subscription: the
 * model's tool call is returned to the CLIENT to execute, and the client's
 * result is fed back on the next request. Native runtimes execute tools
 * internally, so this drives the SDK in a completion-passthrough shape:
 *
 *   1. The client's function tools are registered as in-process SDK MCP tools
 *      (`alwaysLoad` — no ToolSearch deferral). `canUseTool` grants them
 *      (headless auto-denies un-permitted MCP tools). The tool HANDLER pauses
 *      awaiting the client's result.
 *   2. On the model's tool call, the `query()` is left PAUSED inside the
 *      handler; we return the `tool_use` to the client and hold the live query
 *      (indexed by its pending tool-call ids). Verified live: the model uses an
 *      externally-supplied result correctly.
 *   3. The client executes and sends `tool_result`(s) next request; we resolve
 *      the paused handler(s) and drive the query to its next pause (another
 *      tool call) or final text — which ends the turn.
 *
 * `claude_code` only. The Codex `app-server` completion-tool path is its own
 * sibling (`codex-tool-session.ts`), routed by `tryServeNativeToolTurn`.
 */

import { randomUUID } from "node:crypto";
import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  TChatCompletionResponse,
  TServerSearchCall,
} from "@openllmsh/protocol";
import { z } from "zod";
import { CLAUDE_TOOL_PASSTHROUGH_SCOPE } from "../execution-identity";
import type {
  TToolContinuationIdentity,
  TValidatedToolContinuation,
} from "./claude-tool-continuation";
import {
  mintToolContinuation,
  validateToolContinuation,
} from "./claude-tool-continuation";
import {
  buildClaudeToolSdkOptionsBase,
  claudeToolResumeAndSystemPromptOptions,
} from "./claude-tool-sdk-options";
import type { TNativeTokens } from "./types";
import { cleanNativeSpawnEnv, normalizeNativeTerminalResult } from "./types";

/** Idle TTL for a held (paused) query before it's force-closed. */
const HELD_TTL_MS = 10 * 60 * 1000;
/** How long to wait for the model's first output / next pause. */
const DRIVE_TIMEOUT_MS = 120_000;
/** Mutable so `setDriveTimeoutMsForTest` can shrink it for deterministic,
 *  bounded coverage of the deadline race in `drive()` — production never
 *  calls the setter, so this is always {@link DRIVE_TIMEOUT_MS}. */
let driveTimeoutMs = DRIVE_TIMEOUT_MS;
/** Test-only timeout override for deterministic drive()-deadline coverage
 *  (mirrors `setMuxAckTimeoutForTest` in `mux-host.ts`). Pass `null` to
 *  restore the production value. */
export const setDriveTimeoutMsForTest = (timeoutMs: number | null): void => {
  driveTimeoutMs = timeoutMs ?? DRIVE_TIMEOUT_MS;
};
/** After the FIRST tool handler fires, how long to keep collecting the rest of
 *  a parallel tool_use burst before returning. Parallel handlers fire within
 *  milliseconds; this only bounds a pathological unpaired block so it can't
 *  wait out the whole drive deadline. */
const FIRE_SETTLE_MS = 2_000;
/** MCP server name prefix the Agent SDK applies to in-process tools. */
export const CLAUDE_MCP_TOOL_PREFIX = "mcp__openllm__";
/** @deprecated Prefer {@link CLAUDE_MCP_TOOL_PREFIX}. */
const MCP_PREFIX = CLAUDE_MCP_TOOL_PREFIX;
const DEFAULT_CONTINUATION_IDENTITY: TToolContinuationIdentity = {
  subject: "local",
  ownerDaemonKey: "local",
  ownerDaemonEpoch: randomUUID(),
  secret: randomUUID(),
};

/** Sanitize a caller tool name for MCP registration (Agent SDK constraint). */
export const sanitizeClaudeMcpToolName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_-]/g, "_");
const sanitize = sanitizeClaudeMcpToolName;
const nowMs = (): number => Date.now();

/** SDK assistant-message usage (Anthropic `BetaUsage`) → the daemon token row,
 *  using the SAME additive fold as every other Anthropic path (prompt_tokens =
 *  input + cache_read + cache_creation; the two cache fields ride the details),
 *  so a tool completion's usage aligns with a plain-text native completion and
 *  the cloud prices both identically. */
export const betaUsageToTokens = (
  usage:
    | {
        readonly input_tokens?: number;
        readonly output_tokens?: number;
        readonly cache_read_input_tokens?: number | null;
        readonly cache_creation_input_tokens?: number | null;
      }
    | null
    | undefined,
): TNativeTokens => {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  return {
    tokens_in: (usage?.input_tokens ?? 0) + cacheRead + cacheCreation,
    tokens_out: usage?.output_tokens ?? 0,
    cached_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
  };
};

/** The allow/deny decision the SDK's `canUseTool` returns. */
type TPermission =
  | {
      readonly behavior: "allow";
      readonly updatedInput: Record<string, unknown>;
    }
  | { readonly behavior: "deny"; readonly message: string };

/** Permit ONLY the client's registered tools (by full MCP name); deny anything
 *  else. Built-in tools are already stripped via `tools: []` on the query, so
 *  this is defense-in-depth — even if a built-in (Bash/Edit/…) were somehow
 *  surfaced, it can never execute on the user's machine on this passthrough
 *  path, whose whole contract is that the CLIENT runs its own tools. */
export const buildPermit =
  (allowed: ReadonlySet<string>) =>
  async (name: string, input: Record<string, unknown>): Promise<TPermission> =>
    allowed.has(name)
      ? { behavior: "allow", updatedInput: input }
      : {
          behavior: "deny",
          message: `tool ${name} is not permitted on the gateway tool-passthrough path`,
        };

/** A client-supplied function tool (canonical `tools[].function`). */
export type TClientTool = {
  readonly name: string;
  readonly description?: string;
  /** The client's JSON-Schema `parameters` — converted to a Zod shape so the
   *  model sees the real parameter names and produces matching arguments. */
  readonly parameters?: Record<string, unknown>;
};

type TZodShape = Record<string, z.ZodTypeAny>;

/** Shallow JSON-Schema → Zod-raw-shape: enough for the model to see the tool's
 *  top-level parameter names/types. Nested shapes stay loose (`z.unknown()`) —
 *  we forward the raw args to the client, which does the real validation. */
const jsonSchemaToZodShape = (
  parameters: Record<string, unknown> | undefined,
): TZodShape => {
  const props = (parameters?.properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  const required = new Set(
    Array.isArray(parameters?.required)
      ? (parameters?.required as string[])
      : [],
  );
  const shape: TZodShape = {};
  for (const [key, spec] of Object.entries(props)) {
    let base: z.ZodTypeAny;
    switch (spec?.type) {
      case "string":
        base = z.string();
        break;
      case "number":
      case "integer":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = z.array(z.unknown());
        break;
      case "object":
        base = z.record(z.string(), z.unknown());
        break;
      default:
        base = z.unknown();
    }
    shape[key] = required.has(key) ? base : base.optional();
  }
  return shape;
};

/** One tool call the model made, returned to the client to execute. */
export type TToolCallOut = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

/** The outcome of driving the query to its next boundary. `usage` is THIS
 *  turn's token counts (from the assistant message driven in this call — never
 *  cumulative across rounds); optional because the gated Codex tool path does
 *  not surface usage yet. `serverSearchCalls` reports HOSTED web searches the
 *  provider ran inside the turn (Codex path only) so the serve layer can
 *  re-encode the lifecycle on the client wire. */
export type TToolTurnResult =
  | {
      readonly kind: "tool_calls";
      readonly text: string;
      readonly toolCalls: ReadonlyArray<TToolCallOut>;
      /** Returned as x-openllm-tool-session; clients send it on continuation. */
      readonly continuationToken?: string;
      /** This result came from an idempotent continuation retry. */
      readonly replayed?: true;
      readonly usage?: TNativeTokens;
      readonly serverSearchCalls?: ReadonlyArray<TServerSearchCall>;
    }
  | {
      readonly kind: "final";
      readonly text: string;
      /** This result came from an idempotent continuation retry. */
      readonly replayed?: true;
      readonly usage?: TNativeTokens;
      readonly serverSearchCalls?: ReadonlyArray<TServerSearchCall>;
    }
  | {
      readonly kind: "declined";
      readonly reason: string;
      /**
       * Mirrors `TNativeRunResult`'s capture-ownership field (same name, same
       * walker check — `walker.ts` reads `native.captureOwnership` on ANY
       * declined native outcome, not only capture ones) so an indeterminate
       * `streamInput` failure is protected the identical way a capture upstream
       * send is: `"uncertain"` when a send to the live SDK Query may have
       * partially gone out (its `streamInput` call threw) — the walker must
       * treat the hop as terminal (502) rather than retrying via handrolled or
       * fleet transport, which would resend this turn (tool result + context)
       * a second time over a different transport. Closing an already-started
       * held query on a missing capability is also terminal (`"accepted"`),
       * because closeHeld resolves its pending handlers. `"none"` (or omitted)
       * is reserved for declines before taking ownership of a live query.
       */
      readonly captureOwnership?: "none" | "accepted" | "uncertain";
    };

/** Shared channel between the paused tool handlers and the driver: fired
 *  handler resolvers, plus a one-shot wake for the driver. Exported so tests
 *  can inject a scripted fake iterator (see `TIteratorFactory`) that drives it
 *  without the real `claude` SDK. */
export type TChannel = {
  readonly fired: Array<(result: string) => void>;
  wake: (() => void) | null;
};

type TStep = { done?: boolean; value?: unknown };

/** An `AsyncIterator<unknown>` carrying a duck-typed `streamInput` — attached
 *  by the real SDK Query path ({@link buildIterator}) unconditionally, so a
 *  held session missing it is a genuine failure, not a supported variant to
 *  gracefully degrade from (see {@link continueToolTurn}'s fail-closed
 *  handling). Typed as optional only because `AsyncIterator<unknown>`
 *  (the `TIteratorFactory` contract) can't statically guarantee it — every
 *  test fake must attach a real one. */
type TClaudeToolIterator = AsyncIterator<unknown> & {
  streamInput?: (text: string) => Promise<void>;
  /** Tears down the never-completing queue backing `streamInput` (see
   *  {@link makeUserMessageQueue}); called from {@link closeHeld}. */
  closeStreamInput?: (reason: unknown) => void;
};

type THeld = {
  readonly it: AsyncIterator<unknown>;
  /** See {@link TClaudeToolIterator} — reaches the same object as `it`.
   *  `undefined` here is a construction defect, not a supported fallback
   *  path; {@link continueToolTurn} fails closed rather than folding
   *  context into a tool's own output when this is missing. */
  readonly streamInput?: (text: string) => Promise<void>;
  /** See {@link TClaudeToolIterator.closeStreamInput}. */
  readonly closeStreamInput?: (reason: unknown) => void;
  readonly chan: TChannel;
  /** client tool-call id → the paused handler's resolver. */
  readonly pending: Map<string, (result: string) => void>;
  /** A `next()` left IN-FLIGHT when a pause (`fired`) won the race — retained so
   *  the next `drive()` reuses it instead of calling `next()` again, which would
   *  let the abandoned promise eat the first message after the resume (the final
   *  assistant text would silently vanish). */
  nextP: Promise<TStep> | null;
  /** Serializes `drive()` for this session — two continuation requests that
   *  reference the same held query (e.g. parallel tool results split across
   *  concurrent HTTP calls) must not race the single iterator + its mutable
   *  `nextP`/`chan`/`pending` state. */
  lock: Promise<void>;
  sessionId: string | null;
  lastUsed: number;
  readonly continuationIdentity: TToolContinuationIdentity;
};

type TCompletedContinuation = {
  readonly expiresAt: number;
  readonly result: TToolTurnResult;
};

type TContinuationIdentityEntry = {
  readonly expiresAt: number;
  readonly identity: TToolContinuationIdentity;
};

/** Finished continuations are retained only for retry idempotency. */
const completedContinuations = new Map<string, TCompletedContinuation>();
/** Mint-time identities let retries validate and address a completed turn after a signing-key refresh. */
const continuationIdentities = new Map<string, TContinuationIdentityEntry>();
/** Accepted ids detect conflicting payloads after the live index is removed. */
const consumedToolIds = new Map<string, number>();
/** Concurrent byte-identical retries await the original drive, never re-drive it. */
const inFlightContinuations = new Map<string, Promise<TToolTurnResult>>();

const sameContinuationScope = (
  left: TToolContinuationIdentity,
  right: TToolContinuationIdentity,
): boolean =>
  left.subject === right.subject &&
  left.ownerDaemonKey === right.ownerDaemonKey &&
  left.ownerDaemonEpoch === right.ownerDaemonEpoch &&
  (left.executionScope ?? CLAUDE_TOOL_PASSTHROUGH_SCOPE) ===
    (right.executionScope ?? CLAUDE_TOOL_PASSTHROUGH_SCOPE);

const fingerprintOf = (
  continuationIdentity: TToolContinuationIdentity,
  validatedToken: TValidatedToolContinuation,
  toolResults: ReadonlyArray<{ readonly id: string; readonly content: string }>,
  injectedContext: string | null,
): string =>
  JSON.stringify({
    identity: {
      subject: continuationIdentity.subject,
      ownerDaemonKey: continuationIdentity.ownerDaemonKey,
      ownerDaemonEpoch: continuationIdentity.ownerDaemonEpoch,
      executionScope:
        continuationIdentity.executionScope ?? CLAUDE_TOOL_PASSTHROUGH_SCOPE,
    },
    tokenId: validatedToken.tokenId,
    results: toolResults
      .map((result) => ({ id: result.id, content: result.content }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    injectedContext,
  });

/** Stamp `captureOwnership: "accepted"` onto an unmarked `declined` result —
 *  used once a send is definitely committed, so a later failure never reads
 *  as safe to retry. Never downgrades an existing marker. */
const markAcceptedIfDeclined = (result: TToolTurnResult): TToolTurnResult =>
  result.kind === "declined" && result.captureOwnership === undefined
    ? { ...result, captureOwnership: "accepted" }
    : result;

const replayedResultOf = (result: TToolTurnResult): TToolTurnResult => {
  if (result.kind === "declined") return result;
  return { ...result, replayed: true };
};

const cleanupCompletedContinuations = (now: number): void => {
  for (const [fingerprint, completed] of completedContinuations) {
    if (completed.expiresAt <= now) completedContinuations.delete(fingerprint);
  }
  for (const [token, entry] of continuationIdentities) {
    if (entry.expiresAt <= now) continuationIdentities.delete(token);
  }
  for (const [id, expiresAt] of consumedToolIds) {
    if (expiresAt <= now) consumedToolIds.delete(id);
  }
};

const refreshHeld = (h: THeld): void => {
  h.lastUsed = nowMs();
};

const continuationExpiryOf = (h: THeld): number => h.lastUsed + HELD_TTL_MS;

const immutableResultOf = (result: TToolTurnResult): TToolTurnResult => {
  if (result.kind !== "tool_calls") return Object.freeze({ ...result });
  return Object.freeze({
    ...result,
    toolCalls: Object.freeze(
      result.toolCalls.map((call) => Object.freeze({ ...call })),
    ),
  });
};

/** Run `fn` after any in-flight `drive()` for this session completes, chaining
 *  the next waiter behind it. Callers MUST resolve any tool-result handlers
 *  BEFORE awaiting the lock, so a sibling continuation can unblock the SDK while
 *  this one waits (else a split parallel-result submission would deadlock). */
const withSessionLock = async <T>(
  h: THeld,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = h.lock;
  let release!: () => void;
  h.lock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};

/** Held (paused) queries, indexed by EACH pending tool-call id so a
 *  continuation request (which references those ids) finds the live query. */
const held = new Map<string, THeld>();

const dropIndex = (h: THeld): void => {
  for (const [id, entry] of held) if (entry === h) held.delete(id);
};

const closeHeld = (h: THeld): void => {
  for (const r of h.chan.fired.splice(0)) r("(cancelled)");
  for (const [, resolve] of h.pending) resolve("(cancelled)");
  h.pending.clear();
  // Settle any retained in-flight next() so it can't surface as an unhandled
  // rejection once we stop draining the iterator.
  h.nextP?.catch(() => undefined);
  h.nextP = null;
  // Release the persistent streamInput queue (see `makeUserMessageQueue`) —
  // it deliberately never completes on its own, so it must be torn down
  // explicitly or it leaks a dangling `wake` promise past session close.
  h.closeStreamInput?.(new Error("held tool session closed"));
  void h.it.return?.(undefined).catch(() => undefined);
  dropIndex(h);
};

const evictStale = (): void => {
  const now = nowMs();
  cleanupCompletedContinuations(now);
  const cutoff = now - HELD_TTL_MS;
  const stale = new Set<THeld>();
  for (const [, h] of held) if (h.lastUsed < cutoff) stale.add(h);
  for (const h of stale) closeHeld(h);
};

// Sweep abandoned held queries even when no further tool request arrives — a
// client that never returns its tool_result would otherwise leak the live
// `claude` subprocess until daemon restart (eviction was previously only
// opportunistic, on the next start/continue call). `.unref()` so the timer
// never keeps the daemon process alive on its own.
const sweep = setInterval(evictStale, HELD_TTL_MS);
sweep.unref?.();

/** One pending user-role message awaiting delivery confirmation. */
type TQueuedUserMessage = {
  readonly text: string;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
};

type TSdkUserMessage = {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
};

/**
 * A queue-backed `AsyncIterable<SDKUserMessage>` feeding the real SDK's
 * `Query.streamInput`, plus the `push`/`close` handles the daemon drives it
 * with.
 *
 * Invariant: the generator backing this iterable must NEVER return on its
 * own. The installed `@anthropic-ai/claude-agent-sdk`'s `Query.streamInput`
 * calls `transport.endInput()` — irreversibly closing the CLI subprocess's
 * stdin — the instant its input iterable completes normally, and that same
 * transport carries every later write back to the CLI (including the
 * tool_result that unblocks a paused model). A one-shot generator per
 * `injectedContext` delivery (the prior implementation) closed stdin on the
 * FIRST delivery, silently breaking every write after it. One persistent,
 * never-completing generator per held session keeps stdin open for the
 * session's life. Full source-level diagnosis + a real-CLI construction
 * proof: `tmp/bridge-capture-benchmark/streaminput-stall-diagnosis.md`.
 *
 * `push` resolves once the SDK asks for the NEXT item (proof the previous
 * item's write did not throw); a write failure closes the queue so every
 * pending/future `push` fails fast instead of hanging.
 */
const makeUserMessageQueue = (): {
  readonly iterable: AsyncIterable<TSdkUserMessage>;
  readonly push: (text: string) => Promise<void>;
  readonly close: (reason: unknown) => void;
} => {
  const queue: TQueuedUserMessage[] = [];
  let lastYielded: TQueuedUserMessage | null = null;
  let wake: (() => void) | null = null;
  let closed = false;
  let closeReason: unknown = new Error(
    "held session's user-message queue was closed",
  );

  const confirmLastYielded = (): void => {
    const item = lastYielded;
    lastYielded = null;
    item?.resolve();
  };
  const failAll = (reason: unknown): void => {
    const pending = lastYielded;
    lastYielded = null;
    pending?.reject(reason);
    for (const item of queue.splice(0)) item.reject(reason);
  };

  const iterable: AsyncIterable<TSdkUserMessage> = {
    [Symbol.asyncIterator](): AsyncIterator<TSdkUserMessage> {
      return {
        async next(): Promise<IteratorResult<TSdkUserMessage>> {
          // Being asked for the NEXT value proves the SDK's own await on the
          // previous item's transport.write() settled without throwing.
          confirmLastYielded();
          for (;;) {
            const item = queue.shift();
            if (item !== undefined) {
              lastYielded = item;
              return {
                done: false,
                value: {
                  type: "user",
                  message: { role: "user", content: item.text },
                  parent_tool_use_id: null,
                },
              };
            }
            if (closed) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  };

  return {
    iterable,
    push: (text: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          reject(closeReason);
          return;
        }
        queue.push({ text, resolve, reject });
        const w = wake;
        wake = null;
        w?.();
      }),
    close: (reason: unknown): void => {
      if (closed) return;
      closed = true;
      closeReason = reason;
      failAll(reason);
      const w = wake;
      wake = null;
      w?.();
    },
  };
};

const buildIterator = (
  params: TStartToolTurnParams,
  chan: TChannel,
): AsyncIterator<unknown> => {
  const onFire = (resolve: (result: string) => void): void => {
    chan.fired.push(resolve);
    const w = chan.wake;
    chan.wake = null;
    w?.();
  };
  const sdkTools = params.tools.map((t) =>
    tool(
      sanitize(t.name),
      t.description ?? t.name,
      // The client's JSON-Schema params → a Zod shape so the model produces
      // arguments matching the client's tool (we forward them raw).
      jsonSchemaToZodShape(t.parameters),
      // Pause here until the CLIENT's tool_result arrives (next request), then
      // hand it back as the tool's output so the model continues.
      async () => {
        const result = await new Promise<string>((resolve) => onFire(resolve));
        return { content: [{ type: "text", text: result }] };
      },
      { alwaysLoad: true },
    ),
  );
  // The full MCP names the SDK presents to `canUseTool` — the ONLY tools
  // permitted to run. Everything else (every built-in) is denied.
  const allowed = new Set(
    params.tools.map((t) => `${MCP_PREFIX}${sanitize(t.name)}`),
  );
  const q = query({
    prompt: params.userText,
    options: {
      ...buildClaudeToolSdkOptionsBase({
        bin: params.bin,
        env: cleanNativeSpawnEnv(params.env),
        providerModelId: params.providerModelId,
        tools: sdkTools,
      }),
      // Passthrough contract: tool_use PAUSES for the client's own execution
      // (unlike capture's deny-all, which never reaches a real handler).
      canUseTool: buildPermit(allowed) as never,
      ...claudeToolResumeAndSystemPromptOptions({
        systemText: params.systemText,
        resumeSessionId: params.resumeSessionId,
      }),
    } as never,
  });
  const it = (q as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  // Duck-typed: deliver client context as a genuine `user`-role message
  // (never folded into a tool's resolved output) via ONE persistent queue
  // (`makeUserMessageQueue` — see its doc for the invariant this preserves).
  // `push` is exposed as `streamInput`; a write failure poisons the queue so
  // every later push also fails fast, matching `continueToolTurn`'s
  // fail-closed handling.
  const userMessages = makeUserMessageQueue();
  const streamInputDone = q.streamInput(userMessages.iterable);
  streamInputDone.catch((err: unknown) => userMessages.close(err));
  (it as TClaudeToolIterator).streamInput = userMessages.push;
  (it as TClaudeToolIterator).closeStreamInput = userMessages.close;
  return it;
};

export type TStartToolTurnParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly tools: ReadonlyArray<TClientTool>;
  readonly systemText: string | null;
  readonly resumeSessionId: string | null;
  readonly userText: string;
};

/** Builds the message-iterator for a tool turn. The production default is
 *  `buildIterator` (the real `@anthropic-ai/claude-agent-sdk` `query()`);
 *  tests inject a scripted fake to drive the orchestration deterministically. */
export type TIteratorFactory = (
  params: TStartToolTurnParams,
  chan: TChannel,
) => AsyncIterator<unknown>;

/** Start a NEW tool-bearing turn: run to the first tool call or final text. */
export const startToolTurn = async (
  params: TStartToolTurnParams,
  makeIterator: TIteratorFactory = buildIterator,
  continuationIdentity: TToolContinuationIdentity = DEFAULT_CONTINUATION_IDENTITY,
): Promise<TToolTurnResult> => {
  evictStale();
  const chan: TChannel = { fired: [], wake: null };
  let it: AsyncIterator<unknown>;
  try {
    it = makeIterator(params, chan);
  } catch (error) {
    return {
      kind: "declined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const h: THeld = {
    it,
    streamInput: (it as TClaudeToolIterator).streamInput,
    closeStreamInput: (it as TClaudeToolIterator).closeStreamInput,
    chan,
    pending: new Map(),
    nextP: null,
    lock: Promise.resolve(),
    sessionId: params.resumeSessionId,
    lastUsed: nowMs(),
    continuationIdentity,
  };
  return drive(h);
};

/** Continue a HELD turn: resolve the paused handlers with the client's tool
 *  results, then drive to the next tool call or final text. `injectedContext`
 *  is conversation context the client added alongside the results (e.g.
 *  loaded Skill instructions, or the client's own next question) — delivered
 *  to the model as a genuine `role: "user"` message via the held session's
 *  `streamInput`, BEFORE any pending tool handler is resolved. It must never
 *  ride a tool handler's own resolved output: the model can tell the
 *  difference and will (correctly) report an instruction folded into a
 *  tool_result as untrusted/injected content rather than a real user turn.
 *  If `streamInput` is unavailable or its call fails, this fails closed — the
 *  held session is torn down and the continuation declines with
 *  `captureOwnership: "uncertain"` on a failed (possibly partial) send, so
 *  the caller (claude-tool-serve.ts → serve.ts → walker.ts) treats the hop
 *  as terminal instead of retrying it over a different transport. */
export const continueToolTurn = async (
  toolResults: ReadonlyArray<{ readonly id: string; readonly content: string }>,
  injectedContext: string | null = null,
  continuationToken: string | null = null,
  continuationIdentity: TToolContinuationIdentity = DEFAULT_CONTINUATION_IDENTITY,
): Promise<TToolTurnResult> => {
  evictStale();
  const resultIds = new Set<string>();
  for (const { id } of toolResults) {
    if (resultIds.has(id)) {
      return {
        kind: "declined",
        reason: "tool-session continuation contains duplicate tool result ids",
      };
    }
    resultIds.add(id);
  }
  const now = nowMs();
  // The held query owns the identity captured when its capability was minted.
  // Bootstrap refreshes can rotate the live signing key while a tool is paused,
  // so validating against the request-time identity would reject its own token.
  const h = toolResults.map((r) => held.get(r.id)).find((x) => x !== undefined);
  const storedIdentity =
    h?.continuationIdentity ??
    (continuationToken === null
      ? undefined
      : continuationIdentities.get(continuationToken)?.identity);
  const validatedIdentity =
    storedIdentity !== undefined &&
    sameContinuationScope(storedIdentity, continuationIdentity)
      ? storedIdentity
      : continuationIdentity;
  let validated: TValidatedToolContinuation | null = null;
  if (continuationToken !== null) {
    const validation = validateToolContinuation(
      continuationToken,
      validatedIdentity,
      toolResults.map((result) => result.id),
      now,
    );
    if (validation.kind === "invalid") {
      return { kind: "declined", reason: validation.reason };
    }
    validated = validation.value;
  }
  // Only a validated capability may address an idempotency entry. Legacy
  // no-token continuations still resolve a live same-daemon hold below, but
  // cannot read or create retry state after that hold has been consumed.
  const cacheIdentity = validatedIdentity;
  const fingerprint =
    validated === null
      ? null
      : fingerprintOf(cacheIdentity, validated, toolResults, injectedContext);
  // A live pending id always wins over a stale completion cache. This preserves
  // the legacy no-token path even for deterministic test/model ids that recur
  // in a later, entirely new held query.
  if (
    continuationToken === null &&
    h !== undefined &&
    !sameContinuationScope(h.continuationIdentity, continuationIdentity)
  ) {
    return { kind: "declined", reason: "invalid tool-session continuation" };
  }
  if (h === undefined) {
    if (fingerprint !== null) {
      const completed = completedContinuations.get(fingerprint);
      if (completed !== undefined && completed.expiresAt > now) {
        return replayedResultOf(completed.result);
      }
      const inFlight = inFlightContinuations.get(fingerprint);
      if (inFlight !== undefined) return replayedResultOf(await inFlight);
    }
    if (toolResults.some((result) => consumedToolIds.has(result.id))) {
      return {
        kind: "declined",
        reason:
          "tool-session continuation conflicts with an already-consumed tool result",
      };
    }
    return { kind: "declined", reason: "no held tool session for these ids" };
  }
  if (fingerprint !== null) {
    const inFlight = inFlightContinuations.get(fingerprint);
    if (inFlight !== undefined) return replayedResultOf(await inFlight);
  }
  // Resolve the provided handlers IMMEDIATELY (concurrent-safe: distinct ids),
  // BEFORE awaiting the drive lock — so a sibling continuation can unblock the SDK.
  const matched = toolResults.filter((r) => h.pending.has(r.id));
  if (matched.length !== toolResults.length) {
    return {
      kind: "declined",
      reason:
        "tool-session continuation conflicts with an already-consumed tool result",
    };
  }
  refreshHeld(h);
  const outcome = (async (): Promise<TToolTurnResult> => {
    // Deliver client-added context as a genuine `role: "user"` message via
    // streamInput, BEFORE resolving any paused handler — it must never be
    // folded into a tool's own resolved output (the model can tell, and
    // reports it as untrusted injected content rather than a real turn).
    // `streamInput` is always attached in production (buildIterator); a
    // missing/throwing one fails closed: the held session is closed and the
    // continuation declines. `captureOwnership` below is what stops the
    // walker from retrying this same turn over a different transport.
    if (injectedContext !== null) {
      if (h.streamInput === undefined) {
        // Closing an already-started query resolves its pending handlers.
        // Even without a context send, it must not become a retryable decline
        // that lets the walker start this turn again through another transport.
        closeHeld(h);
        return {
          kind: "declined",
          reason:
            "tool-session continuation cannot deliver client context: held session has no streamInput capability",
          captureOwnership: "accepted",
        };
      }
      let inputTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          h.streamInput(injectedContext),
          new Promise<never>((_, reject) => {
            inputTimer = setTimeout(
              () => reject(new Error("client context delivery timed out")),
              driveTimeoutMs,
            );
          }),
        ]);
      } catch (err) {
        // May have partially sent — "uncertain" stops the walker from
        // retrying this hop over a different transport.
        closeHeld(h);
        return {
          kind: "declined",
          reason: `tool-session continuation failed to deliver client context: ${
            err instanceof Error ? err.message : String(err)
          }`,
          captureOwnership: "uncertain",
        };
      } finally {
        clearTimeout(inputTimer);
      }
    }
    for (const r of matched) {
      const resolve = h.pending.get(r.id);
      if (resolve === undefined) continue;
      h.pending.delete(r.id);
      held.delete(r.id);
      consumedToolIds.set(r.id, continuationExpiryOf(h));
      resolve(r.content);
    }
    // From here the tool result(s) are DEFINITELY handed to the live query
    // (an in-process resolve — cannot partially fail), so any decline
    // `drive()` returns from now on (including its own deadline timeout)
    // must not read as safe-to-retry — stamp `captureOwnership: "accepted"`
    // unless drive() already set something more specific.
    const result = immutableResultOf(
      markAcceptedIfDeclined(await withSessionLock(h, () => drive(h))),
    );
    if (fingerprint !== null) {
      completedContinuations.set(fingerprint, {
        expiresAt: continuationExpiryOf(h),
        result,
      });
    }
    return result;
  })();
  if (fingerprint === null) return outcome;
  inFlightContinuations.set(fingerprint, outcome);
  try {
    return await outcome;
  } finally {
    inFlightContinuations.delete(fingerprint);
  }
};

/**
 * Drive the held query to its next boundary. Collects assistant text + any
 * tool_use blocks; a handler pause (fired) returns `tool_calls`; a terminal
 * result returns `final`.
 */
const drive = async (h: THeld): Promise<TToolTurnResult> => {
  let text = "";
  let toolUse: Array<{ id: string; name: string; input: unknown }> = [];
  let usage: TNativeTokens | undefined;
  const deadline = nowMs() + driveTimeoutMs;

  for (;;) {
    const remaining = deadline - nowMs();
    if (remaining <= 0) {
      closeHeld(h);
      return { kind: "declined", reason: "tool turn drive timed out" };
    }
    const firePromise = new Promise<"fired">((resolve) => {
      h.chan.wake = () => resolve("fired");
    });
    // Reuse a next() retained by a prior pause (see THeld.nextP) so the message
    // after a resume isn't lost to an abandoned promise; otherwise fetch one.
    const nextP = h.nextP ?? h.it.next().then((r) => r as TStep);
    h.nextP = null;
    // Race against the REMAINING drive deadline too, not just re-checked
    // between completed iterations: without this, a `next()` that never
    // settles (e.g. the underlying child process hangs before producing its
    // first message) blocks this `await` forever — `nowMs() > deadline`
    // above is never reached again once we're stuck inside this race.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let step: TStep | "fired" | "drive-timeout";
    try {
      step = await Promise.race([
        nextP,
        firePromise,
        new Promise<"drive-timeout">((resolve) => {
          deadlineTimer = setTimeout(() => resolve("drive-timeout"), remaining);
        }),
      ]);
    } catch (error) {
      clearTimeout(deadlineTimer);
      closeHeld(h);
      return {
        kind: "declined",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    clearTimeout(deadlineTimer);
    if (step === "drive-timeout") {
      // Nothing usable remains once we've given up on the session. The race
      // above still observes nextP's eventual rejection, even after timeout
      // wins; dropping our local reference does not remove that handler.
      closeHeld(h);
      return { kind: "declined", reason: "tool turn drive timed out" };
    }

    // A handler paused → the model called tool(s). Parallel tool_use emits N
    // handlers that the SDK invokes in a burst; wait until every block has a
    // fired resolver before returning, so none is dropped — a dropped block
    // would leave the model awaiting a tool_result the client was never asked
    // to produce, hanging the turn to the drive deadline. Bounded by a short
    // settle window (the 10ms poll re-checks even if a wake is missed).
    if (step === "fired") {
      // The next() we started is still in flight (the resume message hasn't
      // arrived); retain it so the continuation's drive() consumes it.
      h.nextP = nextP;
      const settleBy = nowMs() + FIRE_SETTLE_MS;
      while (h.chan.fired.length < toolUse.length && nowMs() < settleBy) {
        await Promise.race([
          new Promise<void>((resolve) => {
            h.chan.wake = () => resolve();
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 10)),
        ]);
      }
      return pauseAndReturn(h, text, toolUse, usage);
    }

    const msg = step.value as
      | (Record<string, unknown> & {
          type?: string;
          session_id?: string;
          message?: {
            content?: ReadonlyArray<Record<string, unknown>>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            };
          };
        })
      | undefined;
    if (step.done === true || msg === undefined) {
      closeHeld(h);
      return {
        kind: "declined",
        reason: "native runtime ended without a successful terminal result",
      };
    }
    if (typeof msg.session_id === "string") h.sessionId = msg.session_id;
    if (msg.type === "assistant") {
      // Fresh tool_use set per assistant message; capture THIS turn's usage
      // (the SDK carries it on each assistant message — it is not cumulative,
      // so recording per drive() call can't double-count across tool rounds).
      toolUse = [];
      if (msg.message?.usage !== undefined) {
        usage = betaUsageToTokens(msg.message.usage);
      }
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolUse.push({
            id: String(block.id ?? ""),
            name: String(block.name ?? "").replace(MCP_PREFIX, ""),
            input: block.input ?? {},
          });
        }
      }
      continue;
    }
    if (msg.type === "result") {
      const terminal = normalizeNativeTerminalResult(msg);
      if (terminal.kind === "failure") {
        closeHeld(h);
        return { kind: "declined", reason: terminal.reason };
      }
      dropIndex(h);
      return { kind: "final", text, usage };
    }
    // system / partial / other frames — ignore.
  }
};

const pauseAndReturn = (
  h: THeld,
  text: string,
  toolUse: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  usage: TNativeTokens | undefined,
): TToolTurnResult => {
  const toolCalls: TToolCallOut[] = [];
  for (const b of toolUse) {
    const resolve = h.chan.fired.shift();
    if (resolve === undefined) break; // fewer resolvers than blocks — unexpected
    h.pending.set(b.id, resolve);
    held.set(b.id, h);
    toolCalls.push({
      id: b.id,
      name: b.name,
      argumentsJson: JSON.stringify(b.input ?? {}),
    });
  }
  refreshHeld(h);
  if (toolCalls.length === 0) {
    closeHeld(h);
    return { kind: "declined", reason: "tool pause produced no tool calls" };
  }
  const expiresAt = continuationExpiryOf(h);
  const continuationToken = mintToolContinuation(
    h.continuationIdentity,
    toolCalls.map((call) => call.id),
    expiresAt,
  );
  continuationIdentities.set(continuationToken, {
    expiresAt,
    identity: h.continuationIdentity,
  });
  return {
    kind: "tool_calls",
    text,
    toolCalls,
    continuationToken,
    usage,
  };
};

/** Build a canonical response envelope from a completed tool turn. */
export const toolTurnToResponse = (
  result: Extract<TToolTurnResult, { kind: "tool_calls" | "final" }>,
  model: string,
): TChatCompletionResponse => {
  const toolCalls =
    result.kind === "tool_calls"
      ? result.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.argumentsJson },
        }))
      : undefined;
  const u = result.usage;
  return {
    id: `chatcmpl-${nowMs()}`,
    object: "chat.completion",
    created: Math.floor(nowMs() / 1000),
    model,
    usage: {
      prompt_tokens: u?.tokens_in ?? 0,
      completion_tokens: u?.tokens_out ?? 0,
      total_tokens: (u?.tokens_in ?? 0) + (u?.tokens_out ?? 0),
      prompt_tokens_details: {
        cached_tokens: u?.cached_tokens ?? 0,
        cache_creation_tokens: u?.cache_creation_tokens ?? 0,
      },
    },
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text.length > 0 ? result.text : null,
          ...(toolCalls !== undefined && toolCalls.length > 0
            ? { tool_calls: toolCalls }
            : {}),
          ...(result.serverSearchCalls !== undefined &&
          result.serverSearchCalls.length > 0
            ? { server_search_calls: result.serverSearchCalls }
            : {}),
        },
        finish_reason: result.kind === "tool_calls" ? "tool_calls" : "stop",
      },
    ],
  } as TChatCompletionResponse;
};

/** Test/introspection: count of held (paused) queries. */
export const heldToolSessionCount = (): number => {
  const seen = new Set<THeld>();
  for (const [, h] of held) seen.add(h);
  return seen.size;
};

/** Test-only teardown: force-close every currently held session (its live
 *  iterator + spawned subprocess, if any, and its streamInput queue) so a
 *  test that fails or times out before reaching a terminal drive() outcome
 *  doesn't leak a real spawned CLI process past the test. Mirrors
 *  `resetSessionsForTest` (session-core.ts) / `setMuxAckTimeoutForTest`
 *  (mux-host.ts)'s `*ForTest` convention. */
export const closeAllHeldToolSessionsForTest = (): void => {
  const seen = new Set<THeld>();
  for (const [, h] of held) seen.add(h);
  for (const h of seen) closeHeld(h);
};
