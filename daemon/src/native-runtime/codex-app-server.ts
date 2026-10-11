/**
 * Codex native bridge — executes an eligible `chatgpt` hop through the
 * OFFICIAL `codex app-server` JSON-RPC runtime instead of the manual
 * `/backend-api/codex/responses` fetch (auth.json parse + endpoint capture +
 * identity-header backfill) the walker's manual path maintains.
 *
 * Protocol facts pinned against `codex-cli 0.144.0` (`codex app-server
 * generate-ts`): newline-delimited JSON-RPC over stdio WITHOUT the "jsonrpc"
 * field; `initialize` → `initialized` handshake; `thread/start`
 * (approvalPolicy "never", sandbox "read-only") + `turn/start`; text deltas as
 * `item/agentMessage/delta`; usage as `thread/tokenUsage/updated`, which
 * carries BOTH a `total` (cumulative since thread creation) and a `last`
 * (this-turn-only) breakdown — we report `last` (see `route`). The runtime
 * owns auth, refresh, identity headers, request shape, and cache affinity —
 * none of that is reproduced here.
 *
 * ONE app-server child serves the whole daemon (lazy spawn, respawn on exit).
 * Threads are PERSISTENT and resumed across turns (`thread/resume`) so only
 * the delta turn is fed to the runtime; the conversation→thread map lives in
 * the session store (`serve.ts`), and distinct conversations get distinct
 * threads so requests can't leak into each other. Server→client requests
 * (approvals — impossible under "never"+read-only, but fail safe) are answered
 * with a JSON-RPC error so the runtime never blocks on us.
 */

import { existsSync } from "node:fs";
import type {
  TChatCompletionChunk,
  TServerSearchCall,
  TUsage,
} from "@openllmsh/protocol";
import { codexServiceTier } from "@openllmsh/protocol";
import { spawnCwd } from "../delegation/util";
import { logError, logWarn, safeDiagnosticMessage } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { daemonTempDir } from "../sandbox/working-set";
import { DAEMON_VERSION } from "../version";
import type { TClientTool } from "./claude-tool-session";
import { CodexModelContextCatalog } from "./codex-model-context";
import {
  CODEX_HOSTED_WEB_SEARCH_CONFIG,
  suppressHostedSearchClientTool,
} from "./codex-web-search";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv, PRE_COMMIT_TIMEOUT_MS } from "./types";

/** Handshake / thread-start RPC budget. */
const RPC_TIMEOUT_MS = 30_000;

type TJsonRpcId = number;
type TInbound = {
  readonly id?: TJsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

/** `thread/tokenUsage/updated` → the canonical usage the daemon reports. Fed
 *  the `last` (THIS-turn) breakdown, NOT the thread's cumulative `total` —
 *  threads resume across turns, so `total` grows every turn and would
 *  over-report on turn 2+. Cached input is a SUBSET of inputTokens (never
 *  re-added — cache-usage invariant), so this mirrors the manual chatgpt
 *  path's non-folding convention exactly. */
const usageFromBreakdown = (breakdown: {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}): TUsage => ({
  prompt_tokens: breakdown.inputTokens ?? 0,
  completion_tokens: breakdown.outputTokens ?? 0,
  total_tokens: breakdown.totalTokens ?? 0,
  prompt_tokens_details: { cached_tokens: breakdown.cachedInputTokens ?? 0 },
});

/** Per-request listener the app-server client routes thread events to. */
type TThreadSink = {
  readonly threadId: string;
  onDelta: (text: string) => void;
  onAgentMessage: (text: string) => void;
  onUsage: (usage: TUsage) => void;
  onCompleted: (status: string, errorMessage: string | null) => void;
  /** A dynamic-tool call the model made (`item/tool/call` server request) —
   *  `requestId` is the JSON-RPC id to respond to with the client's result. */
  onToolCall?: (
    requestId: number,
    callId: string,
    tool: string,
    args: unknown,
  ) => void;
  /** A HOSTED web search completed inside the turn (`item/completed` with
   *  `item.type: "webSearch"`) — the provider ran it; we only report it so
   *  client wires can re-encode the lifecycle (Claude Code counts these). */
  onWebSearch?: (call: TServerSearchCall) => void;
  /**
   * Non-terminal stream/retry error (`error` notification with
   * `willRetry: true`). `openai/codex` (`rust-v0.156.0`
   * `app-server/.../bespoke_event_handling.rs`) emits these for
   * `EventMsg::StreamError` ("Reconnecting... N/M") WITHOUT ending the turn;
   * only `willRetry: false` / `turn/completed` are terminals. Optional — sinks
   * that only care about terminals can omit this.
   */
  onRetryError?: (
    message: string,
    info: {
      readonly willRetry: true;
      readonly codexErrorInfo: unknown;
      readonly additionalDetails: string | null;
    },
  ) => void;
};

export type TCodexAppServerClientOptions = {
  /**
   * Extra argv inserted after `app-server` (e.g. `-c chatgpt_base_url=…`).
   * Used by the bridge-request-capture path; the shared warm client passes none.
   */
  readonly spawnArgvExtra?: readonly string[];
  /**
   * When true, this client is NOT registered in the process-wide warm map and
   * callers are expected to {@link CodexAppServerClient.dispose} it. Capture
   * builders must be isolated from the shared app-server.
   */
  readonly isolated?: boolean;
  /** Capture children read native model metadata from the durable home. */
  readonly modelMetadataHome?: string;
};

class CodexAppServerClient {
  private nextId: TJsonRpcId = 1;
  private readonly pending = new Map<
    TJsonRpcId,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly sinks = new Map<string, TThreadSink>();
  private initialized: Promise<void> | null = null;
  private stdin: { write: (s: string) => void; flush?: () => void } | null =
    null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  /**
   * The CURRENT/most-recent child's `proc.exited` promise, retained here
   * (not read off `this.proc`) so it survives a `dispose()` call — `dispose()`
   * nulls `this.proc` immediately, but this field is untouched by it and is
   * only reassigned by {@link start} on the NEXT spawn. This is what makes
   * {@link disposeAndWaitForExit} idempotent: a synchronous `dispose()`
   * followed by `disposeAndWaitForExit()`, or two concurrent
   * `disposeAndWaitForExit()` calls, all resolve `this.exited` off the SAME
   * promise for the SAME child, so none of them can resolve early just
   * because an earlier call already cleared `this.proc`.
   */
  private exited: Promise<number> | null = null;
  private readonly spawnArgvExtra: readonly string[];
  private readonly modelMetadataHome: string | undefined;
  private modelContextCatalog: CodexModelContextCatalog | null = null;
  private readonly threadContextKeys = new Map<string, string>();
  /** True when created via {@link createIsolatedCodexAppServerClient}. */
  readonly isolated: boolean;

  constructor(
    private readonly bin: string,
    private readonly env: Record<string, string>,
    options: TCodexAppServerClientOptions = {},
  ) {
    this.spawnArgvExtra = options.spawnArgvExtra ?? [];
    this.isolated = options.isolated === true;
    this.modelMetadataHome = options.modelMetadataHome ?? env.CODEX_HOME;
  }

  /** Spawn + handshake exactly once per child; respawn after an exit. */
  ensureStarted(): Promise<void> {
    if (this.initialized !== null) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  /**
   * Kill the child and reject in-flight RPCs. Required for isolated capture
   * builders; safe but unusual for the shared warm client. Signals the kill
   * and returns immediately — it does NOT wait for the process to actually
   * exit (that's {@link disposeAndWaitForExit}). Unchanged: kept exactly as
   * the shared warm client's fire-and-forget teardown always worked.
   */
  dispose(): void {
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.kill();
    } catch {
      // already exited
    }
    this.teardown("codex app-server disposed");
  }

  /**
   * Same signal + teardown as {@link dispose} (calls it verbatim, so the
   * shared warm client's immediate/fire-and-forget behavior is untouched),
   * but resolves only once the child has ACTUALLY exited — awaits
   * {@link exited}, the persistent per-spawn promise, rather than returning
   * as soon as the kill signal is sent. `kill()` only requests termination;
   * the process can still be running — and, in the capture path, still
   * holding/reading its ephemeral `CODEX_HOME` — for a window after
   * `dispose()` returns. Callers that must delete that directory (isolated
   * capture builders) need this, not `dispose()`, to avoid deleting out from
   * under a still-live child.
   *
   * IDEMPOTENT and safe to call concurrently or after a prior synchronous
   * `dispose()`: reads {@link exited} (a field, not derived from `this.proc`)
   * BEFORE calling `dispose()`, so every caller — however many, in whatever
   * order relative to a plain `dispose()` — awaits the SAME promise for the
   * SAME child and none can resolve early just because an earlier call
   * already cleared `this.proc`.
   *
   * Does NOT swallow an unexpected rejection from `exited` as a confirmed
   * exit — `Bun.Subprocess.exited` does not reject in normal operation, but
   * if it ever did, treating that as "the child is gone" would be unsafe
   * (the caller could delete a directory a still-running child is using).
   * The rejection propagates; callers that chain cleanup after this MUST
   * NOT run that cleanup from a `.catch()` on this call.
   */
  async disposeAndWaitForExit(): Promise<void> {
    const exited = this.exited;
    const catalog = this.modelContextCatalog;
    this.dispose();
    if (exited !== null) {
      await exited;
      await catalog?.cleanup();
    }
  }

  /** Config overrides alone cannot replace ModelInfo's 95% reserve/max clamp. */
  async prepareThreadParams(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config = params.config as Record<string, unknown> | undefined;
    const window = config?.model_context_window;
    if (typeof window !== "number" || typeof params.model !== "string")
      return params;
    try {
      const catalog = this.modelContextCatalog;
      if (catalog === null)
        throw new Error("codex app-server is not initialized");
      let path: string;
      try {
        path = await catalog.pathFor(params.model, window);
      } catch {
        // Demand-driven refresh only: this method runs while opening an inference
        // thread. Never start login/auth work or replace the vendor cache ourselves.
        await this.request("model/list", { limit: 1 });
        path = await catalog.pathFor(params.model, window);
      }
      return { ...params, config: { ...config, model_catalog_json: path } };
    } catch {
      logWarn(
        "native-runtime",
        safeDiagnosticMessage`codex context catalog unavailable; using native context defaults`,
      );
      const {
        model_context_window: _window,
        model_auto_compact_token_limit: _compactLimit,
        model_catalog_json: _catalog,
        ...nativeConfig
      } = config ?? {};
      return { ...params, config: nativeConfig };
    }
  }

  /** A loaded resume ignores config. Fork history when its input budget changes. */
  async openThread(
    params: Record<string, unknown>,
    resumeThreadId: string | null,
  ): Promise<string> {
    const prepared = await this.prepareThreadParams(params);
    const config = prepared.config as Record<string, unknown> | undefined;
    const contextKey = JSON.stringify([
      config?.model_context_window ?? null,
      config?.model_catalog_json ?? null,
    ]);
    const previous =
      resumeThreadId !== null
        ? this.threadContextKeys.get(resumeThreadId)
        : undefined;
    const changed = previous !== undefined && previous !== contextKey;
    if (changed && resumeThreadId !== null && this.sinks.has(resumeThreadId)) {
      throw new Error(
        "cannot change context budget during an active Codex turn",
      );
    }
    // A resume/fork failure must decline to the full-request transport. A
    // fresh thread would receive only the delta turn and silently lose history.
    const opened = (await (resumeThreadId === null
      ? this.request("thread/start", prepared)
      : changed
        ? this.request("thread/fork", { threadId: resumeThreadId, ...prepared })
        : this.request("thread/resume", {
            threadId: resumeThreadId,
            ...prepared,
          }))) as {
      thread?: { id?: string };
    };
    const threadId = opened.thread?.id;
    if (typeof threadId !== "string")
      throw new Error("thread/start returned no thread id");
    this.threadContextKeys.set(threadId, contextKey);
    if (changed && resumeThreadId !== null) {
      this.threadContextKeys.delete(resumeThreadId);
      // Stop receiving old-thread events; do not archive/delete its persisted
      // history or terminate a shared child serving unrelated conversations.
      await this.request("thread/unsubscribe", {
        threadId: resumeThreadId,
      }).catch(() => {});
    }
    return threadId;
  }

  private async start(): Promise<void> {
    const proc = Bun.spawn(
      sandboxSpawnArgs([this.bin, "app-server", ...this.spawnArgvExtra]),
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        cwd: spawnCwd(this.env),
        env: cleanNativeSpawnEnv(this.env),
      },
    );
    this.proc = proc;
    const contextCatalog = new CodexModelContextCatalog(
      this.modelMetadataHome,
      daemonTempDir(),
      this.env.CODEX_HOME,
    );
    this.modelContextCatalog = contextCatalog;
    // Reset for THIS spawn — a respawn (shared warm client only) must not
    // let a stale `disposeAndWaitForExit()` caller from the PREVIOUS child
    // keep awaiting an already-settled promise for a process that's gone.
    this.exited = proc.exited;
    this.stdin = proc.stdin as unknown as {
      write: (s: string) => void;
      flush?: () => void;
    };
    void this.pump(proc.stdout as ReadableStream<Uint8Array>).catch(() => {
      // reader ends on child exit; teardown below handles state
    });
    // Always settle local state on exit, whichever way `exited` settles —
    // an unexpected rejection must still null `this.proc`/tear down pending
    // RPCs locally, even though `disposeAndWaitForExit` itself does not
    // treat that rejection as a confirmed clean exit (see its doc comment).
    void proc.exited.then(
      () => {
        if (this.proc === proc) this.proc = null;
        this.teardown("codex app-server exited");
        void contextCatalog.cleanup().catch(() => {});
      },
      () => {
        if (this.proc === proc) this.proc = null;
        this.teardown("codex app-server exited (unexpectedly)");
      },
    );
    await this.request("initialize", {
      clientInfo: {
        name: "openllmd",
        title: "OpenLLM Daemon",
        version: DAEMON_VERSION,
      },
      // experimentalApi enables `thread/start.dynamicTools` (the completion
      // tool-passthrough via `item/tool/call`).
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  private teardown(reason: string): void {
    for (const [, entry] of this.pending) entry.reject(new Error(reason));
    this.pending.clear();
    // Active turns die as "failed" completions — surface WHY server-side; the
    // sink's terminal event only carries the reason to the client stream.
    if (this.sinks.size > 0) {
      logError(
        "native-runtime",
        safeDiagnosticMessage`codex app-server teardown failed live turns`,
        {
          reason,
          turns: this.sinks.size,
        },
      );
    }
    for (const [, sink] of this.sinks) sink.onCompleted("failed", reason);
    this.sinks.clear();
    this.threadContextKeys.clear();
    this.stdin = null;
    this.initialized = null; // next request respawns (shared warm client only)
  }

  private send(message: Record<string, unknown>): void {
    if (this.stdin === null) throw new Error("codex app-server not running");
    this.stdin.write(`${JSON.stringify(message)}\n`);
    this.stdin.flush?.();
  }

  private notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`codex app-server ${method} timed out`));
        }
      }, RPC_TIMEOUT_MS);
      // Wrap both settle paths so the timeout can't outlive the response (a
      // settled RPC's timer would otherwise stay armed for the full budget).
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      // A synchronous send failure (child gone) must reject THIS promise and
      // drop its pending entry now — thrown, it would leave the entry to time
      // out and reject a promise nobody holds (unhandled rejection).
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Respond to a held server→client request (a dynamic-tool call) with the
   *  client's result, letting the paused turn continue. */
  respondToServer(id: number, result: unknown): void {
    try {
      this.send({ id, result });
    } catch {
      // child gone — the sink's terminal event ends the turn
    }
  }

  addSink(sink: TThreadSink): void {
    this.sinks.set(sink.threadId, sink);
  }

  removeSink(threadId: string): void {
    this.sinks.delete(threadId);
  }

  private async pump(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          this.route(JSON.parse(line) as TInbound);
        } catch {
          // non-JSON stdout noise — skip
        }
      }
    }
  }

  private route(message: TInbound): void {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(
          new Error(message.error.message ?? "codex app-server error"),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    // Server→client REQUEST.
    if (message.id !== undefined && message.method !== undefined) {
      // A dynamic-tool call → hand to the thread's sink to relay to the CLIENT
      // (completion tool semantics); we respond later via `respondToServer`.
      if (message.method === "item/tool/call") {
        const p = message.params as
          | {
              threadId?: string;
              callId?: string;
              tool?: string;
              arguments?: unknown;
            }
          | undefined;
        const sink =
          p?.threadId !== undefined ? this.sinks.get(p.threadId) : undefined;
        if (sink?.onToolCall !== undefined && typeof p?.callId === "string") {
          sink.onToolCall(
            message.id,
            p.callId,
            String(p.tool ?? ""),
            p.arguments,
          );
          return;
        }
      }
      // Everything else (approvals etc.) — refuse; never executes under
      // approvalPolicy "never" + read-only sandbox, but must not block.
      this.send({
        id: message.id,
        error: { code: -32601, message: "not supported by openllmd" },
      });
      return;
    }
    // Notification.
    const params = message.params as
      | {
          readonly threadId?: string;
          readonly delta?: unknown;
          readonly item?: {
            readonly type?: string;
            readonly text?: unknown;
            /** hosted webSearch items (`type: "webSearch"`) */
            readonly id?: unknown;
            readonly query?: unknown;
            readonly action?: {
              readonly type?: unknown;
              readonly query?: unknown;
              readonly queries?: unknown;
            };
          };
          readonly tokenUsage?: {
            readonly total?: unknown;
            readonly last?: unknown;
          };
          readonly turn?: {
            readonly status?: string;
            readonly error?: { readonly message?: string } | null;
          };
          readonly error?: {
            readonly message?: string;
            readonly codexErrorInfo?: unknown;
            readonly additionalDetails?: string | null;
          };
          readonly willRetry?: boolean;
        }
      | undefined;
    const threadId = params?.threadId;
    if (threadId === undefined) return;
    const sink = this.sinks.get(threadId);
    if (sink === undefined) return;
    switch (message.method) {
      case "item/agentMessage/delta":
        if (typeof params?.delta === "string") sink.onDelta(params.delta);
        return;
      case "item/completed":
        if (
          params?.item?.type === "agentMessage" &&
          typeof params.item.text === "string"
        ) {
          sink.onAgentMessage(params.item.text);
        }
        // HOSTED web search completed (config-enabled; see codex-web-search.ts).
        // Only the COMPLETED item carries the real query (`item/started` has an
        // empty one). Report it so the serve layer re-encodes the lifecycle on
        // the client's wire; a query-less item is noise, not a search.
        if (params?.item?.type === "webSearch") {
          const item = params.item;
          const queries = Array.isArray(item.action?.queries)
            ? item.action.queries.filter(
                (q): q is string => typeof q === "string" && q.length > 0,
              )
            : [];
          // Model families report the query differently: 5.4 puts it on BOTH
          // `item.query` and `action.query`; 5.6 (sol) fills `item.query` but
          // nulls `action.query` and reports the fan-out only in
          // `action.queries`. Fall through all three so no family's search
          // silently drops.
          const query =
            typeof item.query === "string" && item.query.length > 0
              ? item.query
              : typeof item.action?.query === "string" &&
                  item.action.query.length > 0
                ? item.action.query
                : (queries[0] ?? "");
          if (typeof item.id === "string" && query.length > 0) {
            sink.onWebSearch?.({
              id: item.id,
              query,
              ...(queries.length > 0 ? { queries } : {}),
            });
          }
        }
        return;
      case "thread/tokenUsage/updated": {
        // Report THIS turn's usage (`last`), never the thread's cumulative
        // `total` — a resumed thread's `total` sums every prior turn, which
        // would over-report tokens/cache on turn 2+ (the manual, stateless
        // path always reports per-request). Fall back to `total` only when the
        // runtime omits `last` (a fresh thread's first update).
        const breakdown = params?.tokenUsage?.last ?? params?.tokenUsage?.total;
        if (breakdown !== undefined) {
          sink.onUsage(
            usageFromBreakdown(
              breakdown as Parameters<typeof usageFromBreakdown>[0],
            ),
          );
        }
        return;
      }
      case "turn/completed":
        sink.onCompleted(
          params?.turn?.status ?? "completed",
          params?.turn?.error?.message ?? null,
        );
        return;
      case "error": {
        // Preserve retry-vs-terminal. StreamError → ErrorNotification with
        // willRetry:true ("Reconnecting... N/M") is NOT a turn terminal
        // (bespoke_event_handling.rs EventMsg::StreamError). Treating it as
        // onCompleted("failed") races capture and swallows the real cause.
        const message = params?.error?.message ?? "codex error";
        if (params?.willRetry === true) {
          sink.onRetryError?.(message, {
            willRetry: true,
            codexErrorInfo: params.error?.codexErrorInfo ?? null,
            additionalDetails:
              typeof params.error?.additionalDetails === "string"
                ? params.error.additionalDetails
                : null,
          });
          return;
        }
        sink.onCompleted("failed", message);
        return;
      }
      default:
        return;
    }
  }
}

// ONE client per daemon process; keyed by binary path so tests can run a
// fixture server side-by-side with a real install.
const clients = new Map<string, CodexAppServerClient>();

export type { TThreadSink };
export { CodexAppServerClient };
export const clientFor = (
  bin: string,
  env: Record<string, string>,
): CodexAppServerClient => {
  const existing = clients.get(bin);
  if (existing !== undefined) return existing;
  const created = new CodexAppServerClient(bin, env);
  clients.set(bin, created);
  return created;
};

/**
 * Dispose the shared warm client for `bin` IF ONE EXISTS — never creates one.
 * GET-ONLY by design: `clientFor` would spawn a fresh child on a miss, which
 * is exactly wrong for a cleanup call (nothing to clean up must mean nothing
 * happens, never "make one so we can kill it"). Deletes the captured
 * instance from the shared map BEFORE disposing it, so a concurrent
 * `clientFor(bin, env)` racing this call cannot receive (and then have
 * unexpectedly killed out from under it) the exact instance being torn
 * down — it will see the map miss and create its own fresh replacement
 * instead. Awaits the real child exit via
 * {@link CodexAppServerClient.disposeAndWaitForExit} (kill() alone only
 * requests termination); resolves `false` when no shared client for `bin`
 * was registered (nothing to dispose), `true` once the child has actually
 * exited.
 *
 * Intended for a standalone short-lived caller process (e.g. a benchmark
 * harness) that itself invoked `tryServeNativeRuntime` for a chatgpt
 * "bridge" (non-capture) hop and thereby caused this module to create the
 * shared client — never for use inside the daemon's own long-lived runtime,
 * which must keep serving warm requests across calls.
 */
export const disposeSharedCodexAppServerClientAndWaitForExit = async (
  bin: string,
): Promise<boolean> => {
  const existing = clients.get(bin);
  if (existing === undefined) return false;
  clients.delete(bin);
  await existing.disposeAndWaitForExit();
  return true;
};

/**
 * Fresh app-server child that is NOT shared with {@link clientFor}. Capture
 * builders must use this so `turn/interrupt` cannot disturb unrelated warm
 * threads, and so `-c chatgpt_base_url` / `-c openai_base_url` redirects apply
 * only to the experimental child.
 */
export const createIsolatedCodexAppServerClient = (
  bin: string,
  env: Record<string, string>,
  options: Omit<TCodexAppServerClientOptions, "isolated"> = {},
): CodexAppServerClient =>
  new CodexAppServerClient(bin, env, { ...options, isolated: true });

export type TCodexNativeParams = {
  /** Absolute path to the isolated codex binary (`cliBin("chatgpt")`). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("chatgpt")`), merged onto process.env. */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  /** System prompt — applied ONLY on a fresh `thread/start` (a resumed thread
   *  already carries it). Null when the client sent none. */
  readonly systemText: string | null;
  /** The turn text to feed: the delta user turn on resume, or the seed prompt
   *  on a fresh start. */
  readonly userText: string;
  /** Resume this app-server thread id (feed only `userText`), or null → a
   *  fresh persistent thread. */
  readonly resumeThreadId: string | null;
  /** Canonical `reasoning_effort`, forwarded when the runtime supports it. */
  readonly reasoningEffort: string | null;
  readonly serviceTier?: unknown;
  /**
   * Effective gateway input budget for this hop (user pin → report →
   * authored). Applied as `thread/start|resume.config.model_context_window`
   * (Codex v0.144.1 Config / ModelsManager override) — not an inference-wire
   * field. Omitted when unknown so Codex keeps its catalog/built-in window.
   */
  readonly modelContextWindow?: number | null;
  readonly signal: AbortSignal;
  /** Override the pre-commit deadline (default 60s). Tests use a small value to
   *  exercise the timeout→interrupt path without a real 60s wait. */
  readonly precommitMs?: number;
  /**
   * When true (serve selected sub-method `bridge-capture` + readiness), run the
   * isolated capture text path instead of the warm shared app-server bridge.
   */
  readonly bridgeCapture?: boolean;
};

/** Canonical `reasoning_effort` → app-server effort (same narrowing as the
 *  manual chatgpt encoder: minimal/low→low, medium→medium, rest→high). */
export const effortOf = (raw: string | null): string | null => {
  if (raw === null || raw === "none") return null;
  if (raw === "minimal" || raw === "low") return "low";
  if (raw === "medium") return "medium";
  return "high";
};

/**
 * The `thread/start` fields shared by the text bridge ({@link runCodexNative})
 * and the tool bridge (`codex-tool-session.ts`). We serve inference for an
 * external client that asked for a plain model, so: read-only sandbox +
 * `approvalPolicy:"never"` (never touch the filesystem / never block on an
 * approval), and `personality:"none"` to suppress the runtime's built-in "Codex
 * the coding agent" persona (mirrors the Codex CLI when a developer prompt is
 * supplied). The client's system prompt rides in `developerInstructions` on a
 * fresh start (a resumed thread already carries it). Each caller layers its own
 * unique fields (effort/tools/features) on top.
 *
 * Hosted web search rides `config` here so BOTH callers get it: search is
 * provider-owned on Codex native hops (always-on), and Codex resolves the
 * requested `live` mode against its own permission profile.
 */
/**
 * Merge hosted-search defaults with an optional per-thread context override.
 * Keys are snake_case ConfigToml / ModelsManager fields (see
 * `ref/codex-rust-v0.144.1` `Config.model_context_window`).
 */
export const codexThreadConfig = (
  modelContextWindow?: number | null,
): Record<string, unknown> => {
  if (
    modelContextWindow === undefined ||
    modelContextWindow === null ||
    !Number.isInteger(modelContextWindow) ||
    modelContextWindow <= 0
  ) {
    return { ...CODEX_HOSTED_WEB_SEARCH_CONFIG };
  }
  // Match Codex's default auto-compact floor (90% of the resolved window).
  const autoCompact = Math.floor((modelContextWindow * 9) / 10);
  return {
    ...CODEX_HOSTED_WEB_SEARCH_CONFIG,
    model_context_window: modelContextWindow,
    model_auto_compact_token_limit: autoCompact,
  };
};

export const codexBaseStartParams = (
  providerModelId: string,
  systemText: string | null,
  serviceTier?: unknown,
  modelContextWindow?: number | null,
): Record<string, unknown> => ({
  model: providerModelId,
  ...(serviceTier !== undefined
    ? { serviceTier: codexServiceTier(serviceTier) }
    : {}),
  approvalPolicy: "never",
  sandbox: "read-only",
  personality: "none",
  config: codexThreadConfig(modelContextWindow),
  ...(systemText !== null ? { developerInstructions: systemText } : {}),
});

/** One dynamic (client function) tool as the app-server's `thread/start.dynamicTools`
 *  entry shape (`inputSchema` is raw JSON — the client's JSON-Schema passes through). */
export type TCodexDynamicToolSpec = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

/**
 * Map caller function tools → app-server `dynamicTools`, after dropping the
 * hosted-search collision (Codex owns `web_search` on native hops — see
 * `codex-web-search.ts`). Identical mapping was previously duplicated between
 * the bridge tool path (`codex-tool-session.ts`) and the bridge-capture tool
 * path (`codex-capture-tools.ts`); both now call this one definition.
 */
export const codexDynamicToolsFrom = (
  tools: ReadonlyArray<TClientTool>,
): ReadonlyArray<TCodexDynamicToolSpec> =>
  suppressHostedSearchClientTool(tools).map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: t.parameters ?? { type: "object", properties: {} },
  }));

/**
 * The `thread/start` fields shared by BOTH codex tool bridges — the bridge
 * tool path (`codex-tool-session.ts`) and the bridge-capture tool path
 * (`codex-capture-tools.ts`) — layered on top of {@link codexBaseStartParams}.
 * Routes dynamic-tool calls to US via `item/tool/call` instead of the
 * `codex-code-mode-host` sidecar (which the isolated install doesn't ship).
 * Verified live 2026-07-14: with code-mode ON the call never reaches the
 * client (once misread as "0.144.0 doesn't emit item/tool/call"); with it
 * OFF the call fires and the turn completes. `experimentalRawEvents` matches
 * openclaw's `thread/start`.
 */
export const codexToolStartParams = (
  providerModelId: string,
  systemText: string | null,
  dynamicTools: ReadonlyArray<TCodexDynamicToolSpec>,
  serviceTier?: unknown,
  modelContextWindow?: number | null,
): Record<string, unknown> => ({
  ...codexBaseStartParams(
    providerModelId,
    systemText,
    serviceTier,
    modelContextWindow,
  ),
  features: { code_mode: false, code_mode_only: false },
  experimentalRawEvents: true,
  dynamicTools,
});

/**
 * The `turn/start` input shared by EVERY codex call site — bridge text
 * (`runCodexNative`), bridge tool (`codex-tool-session.ts`), bridge-capture
 * text (`codex-capture.ts`), and bridge-capture tool (`codex-capture-tools.ts`):
 * one text element (no `text_elements` payload of our own) plus the optional
 * canonical `effort`.
 */
export const codexTurnStartParams = (
  threadId: string,
  text: string,
  effort: string | null,
  serviceTier?: unknown,
): Record<string, unknown> => ({
  threadId,
  // Standard/null clears a previous tier; absence leaves native config alone.
  ...(serviceTier !== undefined
    ? { serviceTier: codexServiceTier(serviceTier) }
    : {}),
  input: [{ type: "text", text, text_elements: [] }],
  ...(effort !== null ? { effort } : {}),
});

export const runCodexNative = async (
  params: TCodexNativeParams,
): Promise<TNativeRunResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "codex CLI not installed" };
  }
  // bridge-capture sub-method (W4). Dynamic import keeps the warm path free of
  // a hard cycle with `codex-capture.ts`.
  if (params.bridgeCapture === true) {
    const { runCodexCapturedTextTurn } = await import("./codex-capture");
    return await runCodexCapturedTextTurn(params);
  }
  const client = clientFor(params.bin, params.env);
  let threadId: string;
  let turnId: string | null = null;
  try {
    await client.ensureStarted();
    // Resume the persisted thread when we have its id (it already holds prior
    // turns + instructions); otherwise start a fresh NON-ephemeral thread so
    // it survives on disk to be resumed next turn. A failed resume/fork declines
    // before output so the walker can replay the full canonical request safely.
    const startParams = codexBaseStartParams(
      params.providerModelId,
      params.systemText,
      params.serviceTier,
      params.modelContextWindow,
    );
    threadId = await client.openThread(startParams, params.resumeThreadId);
  } catch (error) {
    return {
      kind: "declined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-${threadId}`;
  const baseChunk = (
    delta: Record<string, unknown>,
    finish: "stop" | "length" | null,
    usage?: TUsage,
  ): TChatCompletionChunk =>
    ({
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: params.providerModelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    }) as TChatCompletionChunk;

  // Event plumbing: the sink feeds a queue the ReadableStream drains.
  const queue: Array<TChatCompletionChunk | "end"> = [];
  let wake: (() => void) | null = null;
  let sawDelta = false;
  let usage: TUsage | undefined;
  let terminal: { status: string; error: string | null } | null = null;
  const push = (item: TChatCompletionChunk | "end"): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  const sink: TThreadSink = {
    threadId,
    onDelta: (text) => {
      if (!sawDelta) {
        sawDelta = true;
        push(baseChunk({ role: "assistant", content: "" }, null));
      }
      push(baseChunk({ content: text }, null));
    },
    onAgentMessage: (text) => {
      // Full-message completion without deltas (small responses).
      if (sawDelta) return;
      sawDelta = true;
      push(baseChunk({ role: "assistant", content: text }, null));
    },
    onUsage: (u) => {
      usage = u;
    },
    // A hosted web search completed inside the turn — ride it on the canonical
    // chunk stream so the client-wire encoders re-emit the lifecycle
    // (Anthropic: server_tool_use + web_search_tool_result blocks + usage).
    onWebSearch: (call) => {
      push(baseChunk({ server_search_calls: [call] }, null));
    },
    onCompleted: (status, errorMessage) => {
      terminal = { status, error: errorMessage };
      push(baseChunk({}, status === "interrupted" ? "length" : "stop", usage));
      push("end");
    },
  };
  client.addSink(sink);

  let aborted = false;
  const abort = (): void => {
    aborted = true;
    if (turnId !== null) {
      void client.request("turn/interrupt", { threadId, turnId }).catch(() => {
        // interrupt is best-effort; the sink terminal event still ends us
      });
    }
    push("end");
  };
  if (params.signal.aborted) {
    client.removeSink(threadId);
    return { kind: "declined", reason: "client aborted" };
  }
  params.signal.addEventListener("abort", abort, { once: true });

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
    turnId = typeof turn.turn?.id === "string" ? turn.turn.id : null;
  } catch (error) {
    client.removeSink(threadId);
    return {
      kind: "declined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // If the client aborted WHILE turn/start was in flight, the abort closure saw
  // a null turnId and couldn't interrupt — do it now that the id has arrived, or
  // the vendor keeps generating an answer nobody reads (silent quota burn).
  if (aborted) {
    if (turnId !== null) {
      void client
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
    }
    client.removeSink(threadId);
    return { kind: "declined", reason: "client aborted" };
  }

  const nextItem = async (): Promise<TChatCompletionChunk | "end"> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  // ── Pre-commit: first output, terminal, or deadline ─────────────────
  let precommitTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    nextItem(),
    new Promise<"timeout">((resolve) => {
      precommitTimer = setTimeout(
        () => resolve("timeout"),
        params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(precommitTimer);
  const failedBeforeOutput =
    first === "timeout" ||
    (first === "end" && !sawDelta) ||
    (terminal !== null &&
      (terminal as { status: string }).status === "failed" &&
      !sawDelta);
  if (failedBeforeOutput) {
    // A pre-commit TIMEOUT means the turn is still running server-side (no
    // terminal event arrived) — interrupt it before we fall back to the manual
    // transport, or the vendor keeps generating an answer we've abandoned
    // (duplicate subscription-quota burn, never recorded). The `end`/`failed`
    // sub-cases already saw `turn/completed`, so they need no interrupt.
    if (first === "timeout" && turnId !== null) {
      void client.request("turn/interrupt", { threadId, turnId }).catch(() => {
        // best-effort; we're declining regardless
      });
    }
    client.removeSink(threadId);
    const reason =
      first === "timeout"
        ? "codex app-server produced no output before the pre-commit deadline"
        : ((terminal as { error: string | null } | null)?.error ??
          "codex turn ended before producing output");
    logError(
      "native-runtime",
      safeDiagnosticMessage`codex hop declined pre-commit`,
      { reason },
    );
    return { kind: "declined", reason };
  }

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      if (typeof first === "object") controller.enqueue(first);
      else controller.close();
    },
    async pull(controller) {
      const next = await nextItem();
      if (next === "end") {
        controller.close();
        client.removeSink(threadId);
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      client.removeSink(threadId);
      abort();
    },
  });
  return { kind: "committed", chunks, sessionId: () => threadId };
};
