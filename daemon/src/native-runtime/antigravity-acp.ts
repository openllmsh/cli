/**
 * Google Antigravity over the official `agy` CLI's built-in ACP server
 * (`agy acp`, Agent Client Protocol over stdio) — the transport for what
 * headless stream-json (`antigravity-headless.ts`) cannot serve: image input
 * and caller (client) tools via our loopback MCP server. (Structured
 * output is declined before any Antigravity hop runs.) It is also the fallback when a headless run fails unexpectedly
 * (spawn / start-up / write failures carry `ANTIGRAVITY_HEADLESS_FALLBACK`).
 * The JSON-RPC client is the shared {@link AcpClient} (`cursor-acp.ts`).
 *
 * `agy` is the single source of truth for Antigravity sign-in: `agy acp`
 * shares the CLI's app data dir, so under the same isolated HOME (the account
 * slot's `cliEnv("antigravity")`) it uses the one Google sign-in that
 * `delegation/antigravity-cli-login.ts` created. There is no token file this
 * module reads; a sign-in miss is an `auth` cooldown decline.
 *
 * Protocol facts (agy 1.5.x):
 *
 *   initialize          -> agentInfo.name === "Antigravity ACP Server",
 *                         protocol 1|2, authMethods includes "oauth-personal",
 *                         promptCapabilities.image
 *   authenticate        -> { methodId: "oauth-personal" }. Signed in: resolves
 *                         at once. Inference only spawns after the sign-in
 *                         gate, and waits a short budget before declining.
 *   session/new         -> { cwd, mcpServers } -> { sessionId, configOptions |
 *                         models }. `-32000` = sign-in required;
 *                         `SUBSCRIPTION_REQUIRED` = no eligible plan.
 *   session/set_config_option { configId: "model", value } - exact pin
 *                         (falls back to `session/set_model` on ACP v1 shapes)
 *   session/prompt / session/update / session/cancel - as Cursor.
 *
 * Isolation: the spawn env is the isolated `cliEnv` overlay behind
 * `antigravitySpawnEnv` (drops every Google API-key / project override), so an
 * exported GEMINI_API_KEY can never turn a subscription hop into a metered
 * one. On macOS `agy` reaches the isolated login keychain through
 * `/usr/bin/security`, so the spawn is not sandbox-wrapped and nothing starts
 * unless `ensureKeychainReady(home)` is `present` (as headless does).
 *
 * Native tools never run: the daemon's `agy` settings deny them
 * (`antigravity-cli-settings.ts`), permission requests are rejected, fs/terminal
 * client capabilities are off, the cwd is an empty daemon temp dir, and any
 * native `tool_call` update that is not our loopback MCP tool cancels the turn.
 *
 * One FRESH session per request (the conversation is flattened by
 * `cursorRequestOf`), each in its own empty temp cwd with its own loopback
 * MCP server. The agent PROCESS may be warm: a process whose last turn ended
 * on a clean ACP terminal is parked in a small idle pool (see "Warm process
 * reuse" below) so the next request skips spawn + initialize + authenticate.
 * The agent reports real per-call token totals via ACP `usage_update`
 * (`createAcpTurnState` sums them; output share estimated).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/sdk/protocol";
import { agyCliSignedIn } from "../delegation/antigravity-cli";
import type { TStoreRead } from "../delegation/util";
import { ensureKeychainReady } from "../delegation/util";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import { DAEMON_VERSION } from "../version";
import { ensureAntigravityCliSettings } from "./antigravity-cli-settings";
import { antigravitySpawnEnv } from "./antigravity-env";
import { AcpClient, AcpRpcError, createAcpTurnState } from "./cursor-acp";
import type { TCursorMcpServer } from "./cursor-mcp-server";
import { startCursorMcpServer } from "./cursor-mcp-server";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { acpPromptBlocks } from "./cursor-request";
import type { TNativeRunResult } from "./types";
import { PRE_COMMIT_TIMEOUT_MS } from "./types";

const ANTIGRAVITY_AGENT_NAME = "Antigravity ACP Server";
const ANTIGRAVITY_AUTH_METHOD = "oauth-personal";

/** Handshake RPC budget (initialize / session/new / set_config_option). */
const RPC_TIMEOUT_MS = 30_000;
/** A signed-in `authenticate` answers at once. Inference waits only this long
 *  before declining as `auth`. */
const INFERENCE_AUTH_TIMEOUT_MS = 10_000;
export const ANTIGRAVITY_TURN_TIMEOUT_MS = 180_000;
export const ANTIGRAVITY_IDLE_TIMEOUT_MS = 60_000;

/** Read-only view of an `initialize` result the bridge validates. */
type TInitializeResult = {
  readonly protocolVersion?: unknown;
  readonly agentInfo?: { readonly name?: unknown };
  readonly authMethods?: ReadonlyArray<{ readonly id?: unknown }>;
};

/** The agent identity check (decline on any mismatch). */
const isAntigravityAgent = (result: unknown): boolean => {
  const init = result as TInitializeResult | null;
  if (init === null || typeof init !== "object") return false;
  return (
    init.agentInfo?.name === ANTIGRAVITY_AGENT_NAME &&
    (init.protocolVersion === 1 || init.protocolVersion === 2) &&
    Array.isArray(init.authMethods) &&
    init.authMethods.some((m) => m.id === ANTIGRAVITY_AUTH_METHOD)
  );
};

const ANTIGRAVITY_INIT_PARAMS = {
  protocolVersion: 2,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "openllm-daemon", version: DAEMON_VERSION },
} as const;

/** Classified agent failure → bridge decline reason + cooldown class. */
export type TAntigravityFailure = {
  readonly reason: string;
  readonly cooldown?: "auth" | "payment" | "quota_exhausted" | "rate_limit";
};

const QUOTA_RE =
  /RESOURCE_EXHAUSTED|quota (?:exceeded|exhausted)|usage limit|out of (?:credits|quota)/i;
const RATE_RE = /rate[\s_-]?limit|too many requests|\b429\b/i;

export const classifyAntigravityFailure = (
  error: unknown,
): TAntigravityFailure => {
  if (error instanceof AcpRpcError) {
    // Google's onboarding refused the signed-in account (e.g. "User is
    // ineligible for free-tier … Verify your account", VALIDATION_REQUIRED).
    // The agent wipes its own token afterwards, so without this branch the
    // -32000 below would misreport it as a plain missing sign-in.
    if (
      /Onboarding failed|not eligible for Antigravity|ineligible/i.test(
        error.message,
      )
    ) {
      return {
        reason: /verify your account|VALIDATION_REQUIRED/i.test(error.message)
          ? "antigravity: Google account not eligible — verify the account with Google, then sign in again"
          : "antigravity: Google account not eligible for Antigravity",
        cooldown: "payment",
      };
    }
    if (/SUBSCRIPTION_REQUIRED/.test(error.message)) {
      return {
        reason: "antigravity: Google account has no eligible Antigravity plan",
        cooldown: "payment",
      };
    }
    // Plan-gated model: our pre-submit pin check, or the agent's own -32602
    // ("Model 'x' is not available for the current authentication method").
    // Keep the model id so the client sees WHY, not "request rejected".
    if (
      /is not available (on this Google account|for the current authentication method)/i.test(
        error.message,
      )
    ) {
      const model = /model '?([\w.-]+)'?/i.exec(error.message)?.[1];
      return {
        reason: `antigravity: model ${model ?? "requested"} is not available on this Google account's plan`,
        cooldown: "payment",
      };
    }
    if (QUOTA_RE.test(error.message)) {
      return {
        reason: "antigravity: quota exhausted",
        cooldown: "quota_exhausted",
      };
    }
    if (RATE_RE.test(error.message)) {
      return { reason: "antigravity: rate limited", cooldown: "rate_limit" };
    }
    if (
      (error.kind === "rpc" && error.rpcCode === -32000) ||
      (error.method === "authenticate" && error.kind === "timeout")
    ) {
      return {
        reason: "antigravity: Google sign-in required",
        cooldown: "auth",
      };
    }
    return {
      reason: `antigravity ACP ${error.method} ${
        error.kind === "timeout"
          ? "timed out"
          : error.kind === "transport"
            ? "transport failed"
            : "request rejected"
      }`,
    };
  }
  return { reason: "antigravity ACP setup failed" };
};

/** A setup failure → decline. `sameAccount` false (the sign-in changed
 *  since the request was planned): an `auth` miss belongs to the old
 *  account, so it never cools the hop the new account now serves. */
const declineFrom = (
  error: unknown,
  signal: AbortSignal,
  sameAccount = true,
): TNativeRunResult => {
  if (signal.aborted) return { kind: "declined", reason: "client aborted" };
  const failure = classifyAntigravityFailure(error);
  // Any cooldown (auth, quota, payment) after an account change belongs to
  // the old account.
  const cooldown = sameAccount ? failure.cooldown : undefined;
  return {
    kind: "declined",
    reason: failure.reason,
    ...(cooldown !== undefined ? { cooldownReason: cooldown } : {}),
  };
};

/**
 * Server→client requests. Native tools never run, so a permission ask is
 * REJECTED (prefer `reject_once`, else `reject_always`, else cancel) — with
 * one exception: the agent's pre-tool hook also asks before dispatching to
 * OUR loopback MCP server, and rejecting that is what made every caller tool
 * call fail. Such an ask is allowed ONCE when its structured `_meta` names our
 * server AND a tool registered for this turn (`allowedMcpTools`); the
 * model-controlled title/rawInput are never consulted. Everything else is
 * refused (fs/terminal capabilities are advertised off).
 */
export const handleAntigravityServerRequest = (
  method: string,
  params: unknown,
  allowedMcpTools: ReadonlySet<string> = new Set(),
): unknown => {
  if (method === "session/request_permission") {
    const p = params as {
      readonly toolCall?: unknown;
      readonly options?: ReadonlyArray<{
        readonly optionId?: unknown;
        readonly kind?: unknown;
      }>;
    } | null;
    const options = Array.isArray(p?.options) ? p.options : [];
    const meta = (p?.toolCall as { readonly _meta?: unknown } | null)?._meta as
      | {
          readonly is_mcp_tool_call?: unknown;
          readonly mcp?: {
            readonly server?: unknown;
            readonly tool?: unknown;
          } | null;
        }
      | null
      | undefined;
    const ours =
      meta?.is_mcp_tool_call === true &&
      meta.mcp?.server === CLIENT_TOOLS_MCP_SERVER &&
      typeof meta.mcp.tool === "string" &&
      allowedMcpTools.has(meta.mcp.tool);
    const pick = ours
      ? options.find((o) => o.kind === "allow_once")
      : (options.find((o) => o.kind === "reject_once") ??
        options.find((o) => o.kind === "reject_always"));
    return typeof pick?.optionId === "string"
      ? { outcome: { outcome: "selected", optionId: pick.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  return null;
};

type TSelectOption = {
  readonly value?: unknown;
  readonly name?: unknown;
  readonly options?: unknown;
};

/** Flatten a `select` config option (grouped or flat) into its values. */
const selectValues = (options: unknown): string[] => {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const entry of options as ReadonlyArray<TSelectOption>) {
    if (typeof entry?.value === "string") out.push(entry.value);
    else out.push(...selectValues(entry?.options));
  }
  return out;
};

export type TAntigravityModelState = {
  readonly current: string | null;
  readonly available: ReadonlyArray<string>;
  /** `config` = ACP v2 configOptions; `models` = legacy models block. */
  readonly via: "config" | "models";
  readonly configId: string;
};

/** Read the model selector out of a `session/new` result. */
export const antigravityModelState = (
  sessionResult: unknown,
): TAntigravityModelState => {
  const r = sessionResult as {
    readonly configOptions?: ReadonlyArray<{
      readonly id?: unknown;
      readonly category?: unknown;
      readonly type?: unknown;
      readonly currentValue?: unknown;
      readonly options?: unknown;
    }>;
    readonly models?: {
      readonly currentModelId?: unknown;
      readonly availableModels?: ReadonlyArray<{ readonly modelId?: unknown }>;
    };
  } | null;
  const config = r?.configOptions?.find(
    (o) => o.id === "model" || o.category === "model",
  );
  if (config !== undefined && config.type === "select") {
    return {
      current:
        typeof config.currentValue === "string" ? config.currentValue : null,
      available: selectValues(config.options),
      via: "config",
      configId: typeof config.id === "string" ? config.id : "model",
    };
  }
  return {
    current:
      typeof r?.models?.currentModelId === "string"
        ? r.models.currentModelId
        : null,
    available: (r?.models?.availableModels ?? []).flatMap((m) =>
      typeof m.modelId === "string" ? [m.modelId] : [],
    ),
    via: "models",
    configId: "model",
  };
};

/** Exact pin. Unknown id → reject BEFORE submission (never runs on a default). */
const ensureAntigravityModel = async (
  client: AcpClient,
  sessionId: string,
  providerModelId: string,
  sessionResult: unknown,
): Promise<void> => {
  const requested = providerModelId.trim();
  const state = antigravityModelState(sessionResult);
  if (state.current === requested) return;
  if (state.available.length > 0 && !state.available.includes(requested)) {
    throw new AcpRpcError({
      method: "session/set_config_option",
      kind: "rpc",
      message: `model ${requested} is not available on this Google account`,
    });
  }
  if (state.via === "config") {
    await client.request(
      "session/set_config_option",
      { sessionId, configId: state.configId, value: requested },
      RPC_TIMEOUT_MS,
    );
  } else {
    await client.request(
      "session/set_model",
      { sessionId, modelId: requested },
      RPC_TIMEOUT_MS,
    );
  }
};

/** `session/update` kinds that are the agent's own (native) tool activity. */
const isNativeToolUpdate = (update: unknown): boolean => {
  const kind = (update as { readonly sessionUpdate?: unknown } | null)
    ?.sessionUpdate;
  return kind === "tool_call" || kind === "tool_call_update";
};

/**
 * `session/new` metadata: an EMPTY built-in tool allowlist. `agy acp`
 * reads `_meta.agy.enabledTools` (its `ToolFilterConfig`); `[]` disables every
 * built-in tool (shell, file, web search, subagents…) so the model only sees
 * our loopback MCP tools. Native tools were already refused at permission
 * time, but advertised they let the model plan around them (e.g. `search_web`
 * on a follow-up), costing seconds and failing turns.
 */
export const ANTIGRAVITY_SESSION_META = {
  agy: { enabledTools: [] },
} as const;

/** MCP server name we register for client tools (session/new). */
const CLIENT_TOOLS_MCP_SERVER = "openllm-client-tools";

/** Our loopback MCP tool calls surface as tool_call updates too. The agent
 *  tags MCP dispatches with a structured `_meta` bag
 *  (`{ is_mcp_tool_call: true, mcp: { server } }`, `agy acp`
 *  `unwrap_mcp_tool_call`); match that exactly and fail closed otherwise, so
 *  a model-controlled title/rawInput can never pass the native-tool guard. */
export const isOurMcpToolUpdate = (update: unknown): boolean => {
  const meta = (update as { readonly _meta?: unknown } | null)?._meta as
    | {
        readonly is_mcp_tool_call?: unknown;
        readonly mcp?: { readonly server?: unknown } | null;
      }
    | null
    | undefined;
  return (
    meta?.is_mcp_tool_call === true &&
    meta.mcp?.server === CLIENT_TOOLS_MCP_SERVER
  );
};

/** Tool-call ids the agent tagged as OUR MCP dispatch on their `tool_call`
 *  start. Later `tool_call_update` frames mostly omit `_meta`, so they are
 *  admitted only by an id already proven ours — never by content. */
export const createMcpCallTracker = (): {
  readonly admits: (update: unknown) => boolean;
} => {
  const ours = new Set<string>();
  return {
    admits: (update) => {
      const u = update as {
        readonly sessionUpdate?: unknown;
        readonly toolCallId?: unknown;
      } | null;
      const id = typeof u?.toolCallId === "string" ? u.toolCallId : null;
      if (isOurMcpToolUpdate(update)) {
        if (id !== null) ours.add(id);
        return true;
      }
      return (
        u?.sessionUpdate === "tool_call_update" && id !== null && ours.has(id)
      );
    },
  };
};

// ─── Warm process reuse ─────────────────────────────────────────────────────
//
// Spawn + initialize + authenticate is most of a short turn's latency, so a
// process whose turn ended on a CLEAN ACP terminal may be parked and leased
// to the next request. Rules (each one is load-bearing):
//
//   - On demand only. Nothing is spawned, authenticated or pre-opened in the
//     background; the pool only ever holds processes a real request started.
//   - Keyed by the binary + the COMPLETE final spawn env (sha256 — the raw
//     env, which may carry secrets, is never stored as a key or logged) + the
//     account epoch (`antigravityHeadlessEpoch`, bumped by every sign-in and
//     sign-out), so a different profile, account home, override or sign-in
//     never shares a process. There is no token to read: `agy` owns the
//     sign-in, the daemon only knows when it changed.
//   - Sign-in / sign-out also dispose the whole pool and make leased
//     processes un-parkable (`disposeAntigravityWarmPool`).
//   - Exclusive leases: a parked process is removed from the pool for the
//     whole turn. A concurrent request finds no idle match and cold-spawns its
//     own process — two turns never share one agent.
//   - Every request still gets a fresh empty cwd, a fresh session/new and a
//     fresh loopback MCP server; only the process is reused. The process has
//     its own daemon-owned cwd that lives until the process is disposed.
//   - Only a successful `session/prompt` terminal parks. Setup failures,
//     aborts, idle/turn timeouts, native-tool cancels and the client-tool
//     early settlement (a cancelled turn) all dispose the process.
//   - Bounded: at most ANTIGRAVITY_WARM_POOL_MAX idle processes, each retired
//     after ANTIGRAVITY_WARM_IDLE_TTL_MS idle or ANTIGRAVITY_WARM_MAX_TURNS
//     turns, and all killed on daemon exit.

/** Idle processes kept across all keys (oldest evicted first). */
export const ANTIGRAVITY_WARM_POOL_MAX = 2;
/** How long a parked process may sit idle before it is killed. */
export const ANTIGRAVITY_WARM_IDLE_TTL_MS = 180_000;
/** Turns one process serves before it is retired (bounds agent-side session
 *  accumulation — ACP has no portable session close). */
export const ANTIGRAVITY_WARM_MAX_TURNS = 20;

type TWarmRoute = {
  /** The leasing turn's `session/update` handler; null while parked. */
  onUpdate: ((params: unknown) => void) | null;
  /** Caller tools the leasing turn registered on its MCP server; empty while
   *  parked, so a parked process can never get a permission approved. */
  allowedMcpTools: ReadonlySet<string>;
};

type TWarmAgent = {
  readonly key: string;
  readonly client: AcpClient;
  /** Process cwd (daemon-owned temp dir) — removed only after exit. */
  readonly procCwd: string;
  readonly route: TWarmRoute;
  /** Pool epoch the process was spawned in; a bump makes it un-parkable. */
  readonly epoch: number;
  /** Isolated HOME this process was spawned under (account slot). */
  readonly home: string;
  /**
   * `homeGenerations` value observed at spawn. A dispose for that home
   * bumps the counter so leased agents refuse to re-park, while a later reuse
   * of the same path can park again under the new generation.
   */
  readonly homeGeneration: number;
  turns: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

const idlePool: TWarmAgent[] = [];
let warmEpoch = 0;
let exitHookInstalled = false;
/** Per-HOME generation; dispose bumps it so stale agents retire. */
const homeGenerations = new Map<string, number>();

const homeGenerationOf = (home: string): number =>
  homeGenerations.get(home) ?? 0;

const homeGenerationStale = (agent: TWarmAgent): boolean =>
  agent.homeGeneration !== homeGenerationOf(agent.home);

/** `agy acp`, in worker mode (`--process-per-session`) when the session
 *  carries caller tools over an HTTP MCP server. */
export const antigravityAcpArgv = (
  bin: string,
  callerTools: boolean,
): string[] =>
  callerTools ? [bin, "acp", "--process-per-session"] : [bin, "acp"];

/** Stable, non-reversible identity of a spawn (argv + final env + the
 *  account epoch the request was planned under). */
export const antigravityWarmKey = (
  bin: string,
  env: Record<string, string>,
  signInEpoch: number,
): string => {
  const entries = Object.entries(env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify([bin, entries, signInEpoch]))
    .digest("hex");
};

const retireWarmAgent = (agent: TWarmAgent, sessionId: string | null): void => {
  clearTimeout(agent.idleTimer);
  agent.idleTimer = undefined;
  agent.route.onUpdate = null;
  agent.route.allowedMcpTools = new Set();
  if (sessionId !== null) agent.client.cancelAndDispose(sessionId);
  else agent.client.dispose();
  void agent.client
    .whenExited()
    .then(() => rm(agent.procCwd, { recursive: true, force: true }))
    .catch(() => undefined);
};

const removeFromIdlePool = (agent: TWarmAgent): void => {
  const index = idlePool.indexOf(agent);
  if (index >= 0) idlePool.splice(index, 1);
};

/** Lease an idle process for `key` (exclusive), or null → cold spawn. */
const acquireWarmAgent = (key: string): TWarmAgent | null => {
  for (let i = idlePool.length - 1; i >= 0; i--) {
    const agent = idlePool[i];
    if (agent === undefined || agent.key !== key) continue;
    idlePool.splice(i, 1);
    clearTimeout(agent.idleTimer);
    agent.idleTimer = undefined;
    if (
      !agent.client.isAlive() ||
      agent.epoch !== warmEpoch ||
      homeGenerationStale(agent)
    ) {
      retireWarmAgent(agent, null);
      continue;
    }
    return agent;
  }
  return null;
};

/** Park a process after a clean turn, or retire it when it may not stay. */
const releaseWarmAgent = (agent: TWarmAgent, idleTtlMs: number): void => {
  agent.turns += 1;
  agent.route.onUpdate = null;
  agent.route.allowedMcpTools = new Set();
  if (
    !agent.client.isAlive() ||
    agent.epoch !== warmEpoch ||
    agent.turns >= ANTIGRAVITY_WARM_MAX_TURNS ||
    homeGenerationStale(agent)
  ) {
    retireWarmAgent(agent, null);
    return;
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => disposeAntigravityWarmPool());
  }
  idlePool.push(agent);
  agent.idleTimer = setTimeout(() => {
    removeFromIdlePool(agent);
    retireWarmAgent(agent, null);
  }, idleTtlMs);
  (agent.idleTimer as { unref?: () => void }).unref?.();
  while (idlePool.length > ANTIGRAVITY_WARM_POOL_MAX) {
    const oldest = idlePool.shift();
    if (oldest !== undefined) retireWarmAgent(oldest, null);
  }
};

/**
 * Kill every parked process and make every leased one un-parkable. Called on
 * sign-in / sign-out (the account behind the agent changed) and daemon exit.
 */
export const disposeAntigravityWarmPool = (): void => {
  warmEpoch += 1;
  for (const agent of idlePool.splice(0)) retireWarmAgent(agent, null);
};

/**
 * Retire parked (and block re-parking of leased) warm agents bound to one
 * account's isolated HOME. Used when that account slot is removed.
 */
export const disposeAntigravityWarmPoolForHome = (home: string): void => {
  if (home.length === 0) return;
  homeGenerations.set(home, homeGenerationOf(home) + 1);
  for (let i = idlePool.length - 1; i >= 0; i--) {
    const agent = idlePool[i];
    if (agent === undefined || agent.home !== home) continue;
    idlePool.splice(i, 1);
    retireWarmAgent(agent, null);
  }
};

/** Number of parked processes (diagnostics + tests). */
export const antigravityWarmPoolSize = (): number => idlePool.length;

export type TAntigravityNativeParams = {
  /** The `agy` CLI (`resolveAntigravityCli()`); it is spawned as `agy acp`. */
  readonly bin: string;
  /** Isolated run env (`cliEnv("antigravity")`): HOME is the account slot. */
  readonly env: Record<string, string>;
  /** The account epoch the request was planned under
   *  (`antigravityHeadlessEpoch()`): a sign-in or sign-out changes it, so a
   *  warm process never serves across one. */
  readonly signInEpoch: number;
  /** The live account epoch, re-read before the prompt and before parking:
   *  an account change during setup or the turn retires the process. */
  readonly currentSignInEpoch: () => number;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly userText: string;
  readonly images?: ReadonlyArray<TCursorImage>;
  readonly tools?: ReadonlyArray<TCursorTool>;
  readonly signal: AbortSignal;
  /** Test overrides. */
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  readonly authTimeoutMs?: number;
  readonly warmIdleTtlMs?: number;
  /** Cancel→SIGTERM grace override for {@link AcpClient.cancelAndDispose}. */
  readonly cancelDisposeGraceMs?: number;
  /** Sign-in gate (default {@link agyCliSignedIn}: metadata only). */
  readonly signedIn?: (home: string) => Promise<boolean>;
  /** Keychain readiness gate (default {@link ensureKeychainReady}). */
  readonly ensureKeychain?: (home: string) => Promise<TStoreRead<void>>;
  /** Profile prep: tool deny rules (default
   *  {@link ensureAntigravityCliSettings} — the tool-deny settings only; the
   *  headless custom agent is not ACP's to need). */
  readonly ensureSettings?: (home: string) => boolean;
  /** Spawn unconfined (default {@link unwrapAntigravityCliSpawn}: macOS, where
   *  `agy` must reach the isolated keychain through `/usr/bin/security`). */
  readonly probe?: boolean;
};

/**
 * One turn: lease a warm agent process (or spawn → initialize (identity
 * check) → authenticate (short budget)) → session/new in a fresh empty temp
 * cwd (+ fresh loopback MCP for client tools) → exact model pin →
 * session/prompt. Commit-on-first-output; every pre-commit failure declines
 * with a classified cooldown so the walker advances the plan. A clean
 * terminal parks the process; anything else disposes it.
 */
export const runAntigravityNative = async (
  params: TAntigravityNativeParams,
): Promise<TNativeRunResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "antigravity: agy CLI not installed" };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  // Never run against the user's real HOME: the isolated home is what keeps
  // the daemon's Google sign-in separate from the user's own `agy`.
  const home = params.env.HOME;
  if (home === undefined || home.length === 0 || home === homedir()) {
    return { kind: "declined", reason: "antigravity: no isolated HOME" };
  }
  // macOS: `agy` reaches the isolated login keychain through
  // `/usr/bin/security`; nothing spawns unless the readiness gate created or
  // unlocked it on THIS call. Linux: no-op.
  const keychain = await (params.ensureKeychain ?? ensureKeychainReady)(home);
  if (keychain.kind !== "present") {
    return {
      kind: "declined",
      reason: `antigravity: isolated keychain not ready (${keychain.kind})`,
    };
  }
  // `agy acp` shares the CLI's sign-in. Gate on its metadata so a signed-out
  // account declines as `auth` instead of starting a browser sign-in.
  if (!(await (params.signedIn ?? agyCliSignedIn)(home))) {
    // Only a miss under the account this request was planned for cools the
    // hop: one read across a sign-in must not put the new account on an
    // auth cooldown.
    const sameAccount = params.currentSignInEpoch() === params.signInEpoch;
    return {
      kind: "declined",
      reason: "antigravity: Google sign-in required",
      ...(sameAccount ? { cooldownReason: "auth" as const } : {}),
    };
  }
  // The tool deny rules must be in place before the agent starts.
  if (!(params.ensureSettings ?? ensureAntigravityCliSettings)(home)) {
    return {
      kind: "declined",
      reason: "antigravity: agy settings could not be locked down",
    };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }

  type TQueueItem =
    | TChatCompletionChunk
    | "end"
    | {
        readonly error: Error;
        readonly cooldown?: TAntigravityFailure["cooldown"];
      };
  const queue: TQueueItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: TQueueItem): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  const promptText =
    params.systemText !== null
      ? `${params.systemText}\n\n${params.userText}`
      : params.userText;
  const turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
  });

  const spawnEnv = antigravitySpawnEnv(params.env);
  // Caller tools ride a client-configured HTTP MCP server, which `agy acp`
  // serves in worker mode (one isolated worker per session). Plain turns
  // keep the single-process server. The argv is part of the warm key, so a
  // worker-mode process only ever serves tool turns and vice versa.
  const argv = antigravityAcpArgv(params.bin, (params.tools?.length ?? 0) > 0);
  const warmKey = antigravityWarmKey(
    argv.join("\u0000"),
    spawnEnv,
    params.signInEpoch,
  );

  // Empty, daemon-owned TURN cwd: bounds anything the agent could see
  // natively. Fresh per request, independent of the process cwd.
  let cwd: string;
  try {
    cwd = await mkdtemp(join(daemonTempDir(), "agy-"));
  } catch (error) {
    return declineFrom(
      error,
      params.signal,
      params.currentSignInEpoch() === params.signInEpoch,
    );
  }
  let agent: TWarmAgent | null = null;
  /** Read through a function: `agent` is assigned inside closures, which
   *  TypeScript's flow narrowing does not see. */
  const currentAgent = (): TWarmAgent | null => agent;
  let sessionId: string | null = null;
  let ended = false;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rearmIdleWatchdog: (() => void) | null = null;
  let mcp: TCursorMcpServer | null = null;
  const ourMcpCalls = createMcpCallTracker();
  const allowedMcpTools: ReadonlySet<string> = new Set(
    (params.tools ?? []).map((tool) => tool.name),
  );

  /** How the turn leaves the agent process. */
  type TSettle = "park" | "cancel" | "dispose";
  const cleanup = (settle: TSettle): void => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(idleTimer);
    rearmIdleWatchdog = null;
    params.signal.removeEventListener("abort", abort);
    // Settle the process FIRST: `mcp.stop()` force-closes connections and,
    // called from inside the MCP tool handler, can run other JS before it
    // returns — the process's fate must already be decided by then.
    const owned = agent;
    if (owned !== null) {
      owned.route.onUpdate = null;
      owned.route.allowedMcpTools = new Set();
      if (
        settle === "park" &&
        params.currentSignInEpoch() === params.signInEpoch
      ) {
        releaseWarmAgent(
          owned,
          params.warmIdleTtlMs ?? ANTIGRAVITY_WARM_IDLE_TTL_MS,
        );
      } else {
        retireWarmAgent(owned, settle === "cancel" ? sessionId : null);
      }
    }
    mcp?.stop();
    mcp = null;
    void rm(cwd, { recursive: true, force: true });
  };
  const endWith = (
    chunks: ReadonlyArray<TChatCompletionChunk>,
    settle: "park" | "cancel",
  ): void => {
    if (ended) return;
    ended = true;
    for (const chunk of chunks) push(chunk);
    push("end");
    cleanup(settle);
  };
  const failStream = (
    error: Error,
    cooldown?: TAntigravityFailure["cooldown"],
  ): void => {
    if (ended) return;
    ended = true;
    push(cooldown !== undefined ? { error, cooldown } : { error });
    cleanup("cancel");
  };
  const abort = (): void => {
    failStream(new DOMException("client aborted", "AbortError"));
  };

  /** The leasing turn's view of agent notifications (installed per turn on
   *  the process route — the client's own callback outlives every turn). */
  const onUpdate = (p: unknown): void => {
    if (ended) return;
    const notif = p as
      | { readonly sessionId?: unknown; readonly update?: unknown }
      | undefined;
    if (sessionId === null || notif?.sessionId !== sessionId) return;
    rearmIdleWatchdog?.();
    if (isNativeToolUpdate(notif.update) && !ourMcpCalls.admits(notif.update)) {
      // The agent tried one of ITS tools — never let it run.
      failStream(new Error("antigravity attempted a native tool"));
      return;
    }
    const chunk = turn.handleUpdate(notif.update);
    if (chunk !== null) push(chunk);
  };

  /** Take ownership of a process for this turn. If the turn already ended
   *  (client abort mid-setup) the process is retired immediately. */
  const adopt = (next: TWarmAgent): void => {
    agent = next;
    if (cleaned) {
      retireWarmAgent(next, null);
      return;
    }
    next.route.onUpdate = onUpdate;
    next.route.allowedMcpTools = allowedMcpTools;
  };

  /** Spawn a cold process and run the handshake on it. */
  const startCold = async (): Promise<void> => {
    const procCwd = await mkdtemp(join(daemonTempDir(), "agy-proc-"));
    const route: TWarmRoute = { onUpdate: null, allowedMcpTools: new Set() };
    let client: AcpClient;
    try {
      client = new AcpClient(
        params.bin,
        spawnEnv,
        (method, p) => {
          if (method === "session/update") route.onUpdate?.(p);
        },
        (method, p) =>
          handleAntigravityServerRequest(method, p, route.allowedMcpTools),
        {
          argv,
          label: "agy acp",
          probe: params.probe ?? unwrapAntigravityCliSpawn(),
          exactEnv: true,
          cwd: procCwd,
          ...(params.cancelDisposeGraceMs !== undefined
            ? { cancelDisposeGraceMs: params.cancelDisposeGraceMs }
            : {}),
        },
      );
    } catch (error) {
      void rm(procCwd, { recursive: true, force: true });
      throw error;
    }
    adopt({
      key: warmKey,
      client,
      procCwd,
      route,
      epoch: warmEpoch,
      home,
      homeGeneration: homeGenerationOf(home),
      turns: 0,
      idleTimer: undefined,
    });
    const init = await client.request(
      "initialize",
      ANTIGRAVITY_INIT_PARAMS,
      RPC_TIMEOUT_MS,
    );
    if (!isAntigravityAgent(init)) {
      throw new AcpRpcError({
        method: "initialize",
        kind: "rpc",
        message: "agent is not the expected Google Antigravity release",
      });
    }
    // Signed out (or in) since the gate: never let `authenticate` start a
    // browser sign-in on this host for an account that is gone.
    if (params.currentSignInEpoch() !== params.signInEpoch) {
      throw new AcpRpcError({
        method: "authenticate",
        kind: "rpc",
        message: "antigravity account changed during setup",
      });
    }
    await client.request(
      "authenticate",
      { methodId: ANTIGRAVITY_AUTH_METHOD },
      params.authTimeoutMs ?? INFERENCE_AUTH_TIMEOUT_MS,
    );
  };

  const openSession = (owned: TWarmAgent): Promise<unknown> =>
    owned.client.request(
      "session/new",
      {
        cwd,
        mcpServers:
          mcp !== null
            ? [
                {
                  type: "http",
                  name: CLIENT_TOOLS_MCP_SERVER,
                  url: mcp.url,
                  headers: mcp.headers,
                },
              ]
            : [],
        _meta: ANTIGRAVITY_SESSION_META,
      },
      RPC_TIMEOUT_MS,
    );

  params.signal.addEventListener("abort", abort, { once: true });

  const failSetup = (error: unknown): TNativeRunResult => {
    ended = true;
    cleanup("dispose");
    return declineFrom(
      error,
      params.signal,
      params.currentSignInEpoch() === params.signInEpoch,
    );
  };

  let opened: unknown;
  try {
    if ((params.tools?.length ?? 0) > 0) {
      mcp = startCursorMcpServer({
        tools: params.tools ?? [],
        onToolCall: (name, args) => {
          if (ended) return;
          // Early settlement: the turn is cut off mid-flight — never park.
          endWith(turn.emitToolCall(name, args), "cancel");
        },
      });
    }
    const leased = acquireWarmAgent(warmKey);
    if (leased !== null) {
      adopt(leased);
      try {
        opened = await openSession(leased);
      } catch (error) {
        // A parked process that died after its liveness check fails at the
        // transport; replace it with a cold one once. Anything else (an RPC
        // answer, an abort) is a real outcome and declines as usual.
        const stale =
          error instanceof AcpRpcError &&
          error.kind === "transport" &&
          !params.signal.aborted &&
          !cleaned;
        if (!stale) throw error;
        retireWarmAgent(leased, null);
        agent = null;
        await startCold();
        const fresh = currentAgent();
        if (fresh === null) throw error;
        opened = await openSession(fresh);
      }
    } else {
      await startCold();
      const fresh = currentAgent();
      if (fresh === null) {
        throw new DOMException("client aborted", "AbortError");
      }
      opened = await openSession(fresh);
    }
    const owned = currentAgent();
    if (owned === null || cleaned) {
      throw new DOMException("client aborted", "AbortError");
    }
    const sid = (opened as { readonly sessionId?: unknown } | null)?.sessionId;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new AcpRpcError({
        method: "session/new",
        kind: "rpc",
        message: "missing sessionId",
      });
    }
    sessionId = sid;
    await ensureAntigravityModel(
      owned.client,
      sid,
      params.providerModelId,
      opened,
    );
    if (params.signal.aborted) {
      throw new DOMException("client aborted", "AbortError");
    }
  } catch (error) {
    return failSetup(error);
  }

  const owned = currentAgent();
  if (owned === null || sessionId === null) {
    return failSetup(new DOMException("client aborted", "AbortError"));
  }
  // Signed in or out while this process started — or its account slot was
  // removed (that bumps the HOME's generation, not the epoch): it may hold
  // the old account. Never prompt on it.
  if (
    params.currentSignInEpoch() !== params.signInEpoch ||
    homeGenerationStale(owned)
  ) {
    return failSetup(
      new AcpRpcError({
        method: "session/prompt",
        kind: "rpc",
        message: "antigravity account changed during setup",
      }),
    );
  }
  void owned.client
    .request(
      "session/prompt",
      {
        sessionId,
        prompt: acpPromptBlocks(promptText, params.images ?? []),
      },
      params.turnTimeoutMs ?? ANTIGRAVITY_TURN_TIMEOUT_MS,
    )
    .then((result) => {
      if (ended) return;
      const stop = (result as { readonly stopReason?: unknown } | null)
        ?.stopReason;
      if (stop === "cancelled") {
        failStream(new Error("antigravity turn cancelled"));
      } else if (
        stop !== "end_turn" &&
        stop !== "max_tokens" &&
        stop !== "max_turn_requests" &&
        stop !== "refusal"
      ) {
        failStream(new Error("antigravity turn returned an invalid terminal"));
      } else if (!turn.sawOutput()) {
        failStream(new Error("antigravity turn ended before producing output"));
      } else {
        // The ONLY path that may park the process: a clean ACP terminal.
        endWith(turn.finish(stop), "park");
      }
    })
    .catch((error: unknown) => {
      const failure = classifyAntigravityFailure(error);
      failStream(new Error(failure.reason), failure.cooldown);
    });

  // Deadline timer (reset on activity) — short test `idleMs` fires exactly
  // instead of waiting out a 1s poll cadence. Production 60s budget unchanged.
  const idleBudget = params.idleMs ?? ANTIGRAVITY_IDLE_TIMEOUT_MS;
  const armIdleWatchdog = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      failStream(new Error("antigravity turn idle timeout"));
    }, idleBudget);
  };
  rearmIdleWatchdog = armIdleWatchdog;
  armIdleWatchdog();

  const nextItem = async (): Promise<TQueueItem> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

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
  if (first === "timeout") {
    failStream(new Error("antigravity produced no output in time"));
    return {
      kind: "declined",
      reason:
        "antigravity ACP produced no output before the pre-commit deadline",
    };
  }
  if (first === "end" || "error" in first) {
    // Already settled by endWith/failStream; this is a no-op safety net.
    cleanup("cancel");
    const reason =
      first === "end"
        ? "antigravity turn ended before producing output"
        : first.error.message;
    const failure =
      first !== "end" && first.cooldown !== undefined
        ? first.cooldown
        : QUOTA_RE.test(reason)
          ? ("quota_exhausted" as const)
          : undefined;
    // A sign-in change since the request was planned: the cooldown is the
    // old account's (the same rule as `declineFrom`).
    const sameAccount = params.currentSignInEpoch() === params.signInEpoch;
    return {
      kind: "declined",
      reason,
      ...(failure !== undefined && sameAccount
        ? { cooldownReason: failure }
        : {}),
    };
  }

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const next = await nextItem();
      if (next === "end") controller.close();
      else if ("error" in next) controller.error(next.error);
      else controller.enqueue(next);
    },
    cancel() {
      abort();
    },
  });
  return { kind: "committed", chunks, sessionId: () => null };
};
