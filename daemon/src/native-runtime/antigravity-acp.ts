/**
 * Google Antigravity ACP bridge — executes an `antigravity` hop through
 * Google's OFFICIAL `agy_acp_server` agent (Agent Client Protocol). Like
 * Cursor, Antigravity has no manual HTTP inference path, so this bridge is the
 * provider's ONLY transport. The JSON-RPC client is the shared
 * {@link AcpClient} (`cursor-acp.ts`), spawned with Antigravity's argv.
 *
 * Protocol facts (agent 1.3.0, cross-checked against pingdotgg/t3code
 * `AntigravityInstallation.ts` / `AntigravityAuth.ts` / `antigravityAuthSupport.ts`):
 *
 *   initialize          → agentInfo.name === "antigravity-acp", protocol 1|2,
 *                         authMethods ∋ "oauth-personal", auth.logout advertised
 *   authenticate        → { methodId: "oauth-personal" }. Signed in: resolves
 *                         immediately. Signed out: the agent starts Google's
 *                         loopback OAuth and BLOCKS until the browser flow
 *                         completes — so inference sends it with a short budget
 *                         and declines; only the explicit login waits.
 *   session/new         → { cwd, mcpServers } → { sessionId, configOptions |
 *                         models }. `-32000` = sign-in required;
 *                         `SUBSCRIPTION_REQUIRED` = no eligible plan;
 *                         `-32603` = authed but models failed.
 *   session/set_config_option { configId: "model", value } — exact pin
 *                         (falls back to `session/set_model` on ACP v1 shapes)
 *   session/prompt / session/update / session/cancel — as Cursor.
 *   logout              → clears the agent's own stored sign-in.
 *
 * Isolation: GEMINI_HOME lives in the daemon's isolated home with file storage
 * forced (`cli-paths.ts`), and the spawn env drops every Google API-key /
 * project override (`ANTIGRAVITY_POISON_KEYS`) so an exported GEMINI_API_KEY can
 * never turn a subscription hop into a metered one. Inference never reads the
 * agent's token file (only the usage probe does — `delegation/antigravity-usage.ts`).
 *
 * Native tools never run: permission requests are rejected, fs/terminal client
 * capabilities are off, the cwd is an empty daemon temp dir, and any native
 * `tool_call` update that is not our loopback MCP tool cancels the turn.
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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { daemonTempDir } from "../sandbox/working-set";
import { DAEMON_VERSION } from "../version";
import {
  antigravitySignInIdentity,
  readAntigravityModels,
  recordAntigravityModels,
} from "./antigravity-model-observation";
import { AcpClient, AcpRpcError, createAcpTurnState } from "./cursor-acp";
import type { TCursorMcpServer } from "./cursor-mcp-server";
import { startCursorMcpServer } from "./cursor-mcp-server";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { acpPromptBlocks } from "./cursor-request";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv, PRE_COMMIT_TIMEOUT_MS } from "./types";

export const ANTIGRAVITY_AGENT_NAME = "antigravity-acp";
export const ANTIGRAVITY_AUTH_METHOD = "oauth-personal";
/** Line the agent prints when it starts Google sign-in (native ≤1.1.1). */
export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";

/** Handshake RPC budget (initialize / session/new / set_config_option). */
const RPC_TIMEOUT_MS = 30_000;
/** A signed-in `authenticate` answers at once; a signed-out one blocks on the
 *  browser. Inference waits only this long before declining as `auth`. */
const INFERENCE_AUTH_TIMEOUT_MS = 10_000;
export const ANTIGRAVITY_TURN_TIMEOUT_MS = 180_000;
export const ANTIGRAVITY_IDLE_TIMEOUT_MS = 60_000;

/**
 * Env keys that would make the agent use a metered key / another project or
 * override the daemon-owned profile. Dropped from every spawn BEFORE the
 * isolated `cliEnv` overlay re-adds GEMINI_HOME / AGY_ACP_FORCE_FILE_STORAGE /
 * ANTIGRAVITY_HARNESS_PATH. List from t3code `removedEnvironmentKeys`.
 */
const ANTIGRAVITY_POISON_KEYS: ReadonlySet<string> = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GEMINI_HOME",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
]);
const ANTIGRAVITY_POISON_PREFIX = /^(GOOGLE_CLOUD_|AGY_ACP_)/;

/**
 * The agent spawn env: the shared native clean env (drops ANTHROPIC_/OPENAI_
 * poison) minus the Google poison, then the isolated overlay on top so the
 * profile pins always win. `extra` (the BROWSER helper on login) lands last.
 */
export const antigravitySpawnEnv = (
  isolated: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> => {
  const base = cleanNativeSpawnEnv({});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (ANTIGRAVITY_POISON_KEYS.has(upper)) continue;
    if (ANTIGRAVITY_POISON_PREFIX.test(upper)) continue;
    out[key] = value;
  }
  return { ...out, ...isolated, PYTHONUNBUFFERED: "1", ...(extra ?? {}) };
};

/** The agent's argv. Linux builds need an explicit empty `--uid=`. */
export const antigravityArgv = (bin: string): string[] =>
  process.platform === "linux" ? [bin, "--uid="] : [bin];

/** Where the agent keeps its sign-in token under GEMINI_HOME (read only by
 *  the usage probe). */
export const antigravityTokenPath = (geminiHome: string): string =>
  join(geminiHome, "antigravity-acp", "acp_token.json");

/** Ensure the private profile dirs exist with owner-only permissions. */
export const prepareAntigravityProfile = (geminiHome: string): void => {
  for (const dir of [geminiHome, join(geminiHome, "antigravity-acp")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
};

/** Read-only view of an `initialize` result the bridge validates. */
type TInitializeResult = {
  readonly protocolVersion?: unknown;
  readonly agentInfo?: { readonly name?: unknown };
  readonly authMethods?: ReadonlyArray<{ readonly id?: unknown }>;
  readonly agentCapabilities?: {
    readonly auth?: { readonly logout?: unknown };
  };
};

/** The agent identity check (decline on any mismatch). */
export const isAntigravityAgent = (result: unknown): boolean => {
  const init = result as TInitializeResult | null;
  if (init === null || typeof init !== "object") return false;
  return (
    init.agentInfo?.name === ANTIGRAVITY_AGENT_NAME &&
    (init.protocolVersion === 1 || init.protocolVersion === 2) &&
    Array.isArray(init.authMethods) &&
    init.authMethods.some((m) => m.id === ANTIGRAVITY_AUTH_METHOD)
  );
};

export const ANTIGRAVITY_INIT_PARAMS = {
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

const declineFrom = (error: unknown, signal: AbortSignal): TNativeRunResult => {
  if (signal.aborted) return { kind: "declined", reason: "client aborted" };
  const failure = classifyAntigravityFailure(error);
  return {
    kind: "declined",
    reason: failure.reason,
    ...(failure.cooldown !== undefined
      ? { cooldownReason: failure.cooldown }
      : {}),
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

/** Flatten a `select` config option into `{ value, name }` rows. */
const selectRows = (
  options: unknown,
): Array<{ readonly value: string; readonly name: string | null }> => {
  if (!Array.isArray(options)) return [];
  const out: Array<{ readonly value: string; readonly name: string | null }> =
    [];
  for (const entry of options as ReadonlyArray<TSelectOption>) {
    if (typeof entry?.value === "string") {
      out.push({
        value: entry.value,
        name: typeof entry.name === "string" ? entry.name : null,
      });
    } else out.push(...selectRows(entry?.options));
  }
  return out;
};

/**
 * The account's selectable model rows from a `session/new` result (ACP v2
 * configOptions, else the legacy models block). Empty when absent.
 */
export const antigravityModelRows = (
  sessionResult: unknown,
): ReadonlyArray<{ readonly value: string; readonly name: string | null }> => {
  const r = sessionResult as {
    readonly configOptions?: ReadonlyArray<{
      readonly id?: unknown;
      readonly category?: unknown;
      readonly type?: unknown;
      readonly options?: unknown;
    }>;
    readonly models?: {
      readonly availableModels?: ReadonlyArray<{
        readonly modelId?: unknown;
        readonly name?: unknown;
      }>;
    };
  } | null;
  const config = r?.configOptions?.find(
    (o) => o.id === "model" || o.category === "model",
  );
  if (config !== undefined && config.type === "select") {
    return selectRows(config.options);
  }
  return (r?.models?.availableModels ?? []).flatMap((m) =>
    typeof m.modelId === "string"
      ? [{ value: m.modelId, name: typeof m.name === "string" ? m.name : null }]
      : [],
  );
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
 * `session/new` metadata: an EMPTY built-in tool allowlist. agy_acp_server
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
 *  (`{ is_mcp_tool_call: true, mcp: { server } }`, agy_acp_server
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
//     env, which may carry secrets, is never stored as a key or logged), so a
//     different profile, account home or override never shares a process.
//   - Bound to the sign-in identity (refresh-token hash) observed when parked;
//     a different or missing identity at lease time retires the process, and
//     sign-in / sign-out bumps an epoch that retires every process.
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
  turns: number;
  /** Sign-in identity recorded when the process authenticated; never
   *  overwritten, so a token swap mid-life retires the process. */
  identity: string | null;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

const idlePool: TWarmAgent[] = [];
let warmEpoch = 0;
let exitHookInstalled = false;

/** Stable, non-reversible identity of a spawn (binary + final env). */
export const antigravityWarmKey = (
  bin: string,
  env: Record<string, string>,
): string => {
  const entries = Object.entries(env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify([bin, entries]))
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
const acquireWarmAgent = (
  key: string,
  geminiHome: string | undefined,
): TWarmAgent | null => {
  const identity =
    geminiHome === undefined ? null : antigravitySignInIdentity(geminiHome);
  for (let i = idlePool.length - 1; i >= 0; i--) {
    const agent = idlePool[i];
    if (agent === undefined || agent.key !== key) continue;
    idlePool.splice(i, 1);
    clearTimeout(agent.idleTimer);
    agent.idleTimer = undefined;
    if (
      !agent.client.isAlive() ||
      agent.epoch !== warmEpoch ||
      identity === null ||
      agent.identity !== identity
    ) {
      retireWarmAgent(agent, null);
      continue;
    }
    return agent;
  }
  return null;
};

/** Park a process after a clean turn, or retire it when it may not stay. */
const releaseWarmAgent = (
  agent: TWarmAgent,
  geminiHome: string | undefined,
  idleTtlMs: number,
): void => {
  agent.turns += 1;
  agent.route.onUpdate = null;
  agent.route.allowedMcpTools = new Set();
  const identity =
    geminiHome === undefined ? null : antigravitySignInIdentity(geminiHome);
  if (
    !agent.client.isAlive() ||
    agent.epoch !== warmEpoch ||
    agent.turns >= ANTIGRAVITY_WARM_MAX_TURNS ||
    identity === null ||
    agent.identity === null ||
    agent.identity !== identity
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

/** Number of parked processes (diagnostics + tests). */
export const antigravityWarmPoolSize = (): number => idlePool.length;

export type TAntigravityNativeParams = {
  /** Isolated agent binary (`cliBin("antigravity")`). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("antigravity")`). */
  readonly env: Record<string, string>;
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
    return { kind: "declined", reason: "antigravity agent not installed" };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  // Pre-flight from the selector this sign-in already showed us: a model the
  // account lacks declines instantly instead of after a cold agent spawn.
  const geminiHome = params.env.GEMINI_HOME;
  const observed =
    geminiHome === undefined ? null : readAntigravityModels(geminiHome);
  const requestedModel = params.providerModelId.trim();
  if (
    observed !== null &&
    !observed.some((m) => m.provider_model_id === requestedModel)
  ) {
    return {
      kind: "declined",
      reason: `antigravity: model ${requestedModel} is not available on this Google account's plan`,
      cooldownReason: "payment",
    };
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
  const warmKey = antigravityWarmKey(params.bin, spawnEnv);

  // Empty, daemon-owned TURN cwd: bounds anything the agent could see
  // natively. Fresh per request, independent of the process cwd.
  let cwd: string;
  try {
    cwd = await mkdtemp(join(daemonTempDir(), "agy-"));
  } catch (error) {
    return declineFrom(error, params.signal);
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
      if (settle === "park") {
        releaseWarmAgent(
          owned,
          geminiHome,
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
          argv: antigravityArgv(params.bin),
          label: "agy_acp_server",
          // File-backed store under the isolated home — stays confined.
          probe: false,
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
      turns: 0,
      identity: null,
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
    await client.request(
      "authenticate",
      { methodId: ANTIGRAVITY_AUTH_METHOD },
      params.authTimeoutMs ?? INFERENCE_AUTH_TIMEOUT_MS,
    );
    const owned = currentAgent();
    if (owned !== null && owned.client === client) {
      owned.identity =
        geminiHome === undefined ? null : antigravitySignInIdentity(geminiHome);
    }
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
    return declineFrom(error, params.signal);
  };

  let opened: unknown;
  try {
    prepareAntigravityProfile(geminiHome ?? cwd);
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
    const leased = acquireWarmAgent(warmKey, geminiHome);
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
    // Free model discovery: this session/new already carries the account's
    // selectable models — record them so planning skips ids it lacks.
    if (geminiHome !== undefined) {
      recordAntigravityModels(geminiHome, antigravityModelRows(opened));
    }
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
    return {
      kind: "declined",
      reason,
      ...(failure !== undefined ? { cooldownReason: failure } : {}),
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

/**
 * Write the BROWSER helper the agent invokes instead of opening a browser on
 * the daemon box. Python's `webbrowser` runs `$BROWSER <url>`; the helper
 * appends the URL to `urlFile`. Returns the helper path (colon-free, since
 * BROWSER is a colon-separated list).
 */
export const writeAntigravityBrowserHelper = (
  dir: string,
  urlFile: string,
): string => {
  const helper = join(dir, "browser.sh");
  writeFileSync(
    helper,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${urlFile.replaceAll("'", "'\\''")}'\nexit 0\n`,
    { mode: 0o700 },
  );
  return helper;
};

export type TAntigravityAuthUrl = {
  readonly url: string;
  readonly redirectUri: string;
  readonly state: string;
};

/** Accept only Google's OAuth endpoint with a high-port loopback redirect. */
export const parseAntigravityAuthUrl = (
  raw: string,
): TAntigravityAuthUrl | null => {
  const candidate = raw.trim().startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
    ? raw.trim().slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length)
    : raw.trim();
  if (candidate.length > 16_384 || /\s/.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    state === null ||
    state.length === 0 ||
    state.length > 512 ||
    redirectUri === null ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) {
    return null;
  }
  if (Number(new URL(redirectUri).port) < 1_024) return null;
  return { url: candidate, redirectUri, state };
};

/**
 * Validate a pasted callback URL against the live sign-in: loopback origin +
 * path of the advertised redirect, the same `state`, exactly one `code` or
 * `error`, and (when present) Google as issuer. Returns the URL or a reason.
 */
export const validateAntigravityCallback = (
  pending: Pick<TAntigravityAuthUrl, "redirectUri" | "state">,
  pasted: string,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string } => {
  if (pasted.length > 16_384) {
    return { ok: false, reason: "The sign-in response URL is too long." };
  }
  let callback: URL;
  try {
    callback = new URL(pasted.trim());
  } catch {
    return {
      ok: false,
      reason:
        "Paste the complete 127.0.0.1 address your browser showed after Google sign-in.",
    };
  }
  const expected = new URL(pending.redirectUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    return {
      ok: false,
      reason: "This address does not belong to the current sign-in.",
    };
  }
  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    return {
      ok: false,
      reason: "This address does not belong to the current sign-in.",
    };
  }
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const oneCode = codes.length === 1 && codes[0] !== "" && errors.length === 0;
  const oneError =
    errors.length === 1 && errors[0] !== "" && codes.length === 0;
  if (!oneCode && !oneError) {
    return {
      ok: false,
      reason: "The address must contain one Google sign-in response.",
    };
  }
  const issuers = callback.searchParams.getAll("iss");
  if (
    issuers.length > 1 ||
    (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) {
    return {
      ok: false,
      reason: "The address is not a Google sign-in response.",
    };
  }
  return { ok: true, url: callback };
};
