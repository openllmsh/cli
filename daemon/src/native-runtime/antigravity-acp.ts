/**
 * Google Antigravity over the official `agy` CLI's built-in ACP server
 * (`agy acp`, Agent Client Protocol over stdio) — Antigravity's main method
 * (`acp` in the execution registry): every turn, the caller's tools (over the
 * daemon's loopback MCP server) and images. The headless CLI
 * (`antigravity-headless.ts`) is the `stream-json` method, selected only by
 * `antigravity:stream-json`.
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
 * A request carrying a `conversation` continues that conversation's ACP
 * session (see "Persistent sessions" below): only the new turn is prompted.
 * Without one (or when the conversation is new, edited or lost) a FRESH
 * session is opened in its own empty temp cwd with the whole transcript. The
 * agent PROCESS may be warm: one whose last turn ended on a clean ACP terminal
 * is parked in a small idle pool (see "Warm process reuse" below) so the next
 * request skips spawn + initialize + authenticate.
 * Token usage is the `session/prompt` result's exact split (cache reads
 * included); mid-turn `usage_update` is only the fallback (it carries the
 * session's cumulative context size, not a per-call delta).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/sdk/protocol";
import { AGY_MIN_VERSION, versionAtLeast } from "../agy-version";
import { agyCliSignedIn } from "../delegation/antigravity-cli";
import type { TStoreRead } from "../delegation/util";
import { ensureKeychainReady } from "../delegation/util";
import { logWarn, safeDiagnosticMessage } from "../logger";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { agyTempRoot, daemonTempDir } from "../sandbox/working-set/base";
import { DAEMON_VERSION } from "../version";
import { ensureAntigravityCliSettings } from "./antigravity-cli-settings";
import type { TAntigravityFailure } from "./antigravity-common";
import { classifyAgyMessage, prepareAgySpawn } from "./antigravity-common";
import type { TAntigravityReply } from "./antigravity-conversation";
import { antigravitySpawnEnv } from "./antigravity-env";
import { confineAgyArgv } from "./antigravity-seatbelt";
import {
  classifyTurnOutcome,
  readLastStepAfter,
  readStepWatermark,
} from "./antigravity-turn-outcome";
import { AcpClient, AcpRpcError, createAcpTurnState } from "./cursor-acp";
import type { TCursorMcpServer } from "./cursor-mcp-server";
import { startCursorMcpServer } from "./cursor-mcp-server";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { acpPromptBlocks } from "./cursor-request";
import type { TSessionLease } from "./session-store";
import { NativeSessionStore } from "./session-store";
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

/** `initialize`'s own version, judged by the one rule the binary gate uses
 *  ({@link AGY_MIN_VERSION}); an agent that reports none is not judged. */
export const agyAcpVersionUsable = (init: unknown): boolean => {
  const version = (
    init as { readonly agentInfo?: { readonly version?: unknown } } | null
  )?.agentInfo?.version;
  return (
    typeof version !== "string" || versionAtLeast(version, AGY_MIN_VERSION)
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

export type { TAntigravityFailure };

export const classifyAntigravityFailure = (
  error: unknown,
): TAntigravityFailure => {
  if (error instanceof AcpRpcError) {
    if (/update agy/.test(error.message)) {
      return { reason: `antigravity: ${error.message}` };
    }
    // Account eligibility, plans, quota, rate (`antigravity-common.ts`) —
    // the same classes the CLI's failures get. Sign-in TEXT is left to the
    // RPC shape below (-32000, an authenticate timeout).
    const byMessage = classifyAgyMessage(error.message);
    if (byMessage !== null && byMessage.cooldown !== "auth") return byMessage;
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
 * call fail. Such an ask is allowed ONCE when the agent's own tool id
 * (`toolCall.name`, `mcp_<server>_<tool>` — the same id its transcript records)
 * is EXACTLY one of this turn's registered tools (`allowedMcpTools`, the
 * qualified names); the model-controlled title/rawInput are never consulted. Everything else is
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
    const ours = isOurMcpToolName(
      (p?.toolCall as { readonly name?: unknown } | null)?.name,
      allowedMcpTools,
    );
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
  const models = (r?.models?.availableModels ?? []).flatMap((m) =>
    typeof m.modelId === "string" ? [m.modelId] : [],
  );
  const config = r?.configOptions?.find(
    (o) => o.id === "model" || o.category === "model",
  );
  // agy 1.5.14 lists the effort-suffixed ids (`gemini-3.8-flash-low`, the
  // ids we pin) only in the `models` block; its `configOptions` model select
  // carries the stem with thinking level as a separate option. Prefer the
  // block that names exact ids (`session/set_model` accepts them, verified
  // live 2026-11-22).
  const configValues =
    config !== undefined && config.type === "select"
      ? selectValues(config.options)
      : [];
  const preferModels =
    models.length > 0 && !models.every((id) => configValues.includes(id));
  if (config !== undefined && config.type === "select" && !preferModels) {
    return {
      current:
        typeof config.currentValue === "string" ? config.currentValue : null,
      available: configValues,
      via: "config",
      configId: typeof config.id === "string" ? config.id : "model",
    };
  }
  return {
    current:
      typeof r?.models?.currentModelId === "string"
        ? r.models.currentModelId
        : null,
    available: models,
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
  /** A reattached session already runs the model its conversation key names;
   *  a result that does not say which is not a reason to re-pin. */
  unreportedIsCurrent = false,
): Promise<void> => {
  const requested = providerModelId.trim();
  const state = antigravityModelState(sessionResult);
  if (state.current === requested) return;
  if (unreportedIsCurrent && state.current === null) return;
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

/** How a process reattaches a session it does not hold, from `initialize`'s
 *  capabilities: `session/resume` (no history replay) is preferred over
 *  `session/load` (replays the history as updates). */
const reattachModeOf = (init: unknown): "resume" | "load" | null => {
  const caps = (
    init as {
      readonly agentCapabilities?: {
        readonly loadSession?: unknown;
        readonly sessionCapabilities?: { readonly resume?: unknown };
      };
    } | null
  )?.agentCapabilities;
  if (
    typeof caps?.sessionCapabilities?.resume === "object" &&
    caps.sessionCapabilities.resume !== null
  ) {
    return "resume";
  }
  return caps?.loadSession === true ? "load" : null;
};

const tokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;

/** The exact usage `session/prompt` resolves with (`usage.inputTokens` EXCLUDES
 *  cache reads) as the OpenAI usage row, or null when the agent gave none. */
const exactUsageOf = (
  result: unknown,
): NonNullable<TChatCompletionChunk["usage"]> | null => {
  const u = (result as { readonly usage?: Record<string, unknown> } | null)
    ?.usage;
  if (typeof u !== "object" || u === null) return null;
  const cacheRead = tokenCount(u.cachedReadTokens);
  const prompt =
    tokenCount(u.inputTokens) + cacheRead + tokenCount(u.cachedWriteTokens);
  // `outputTokens` already includes thinking.
  const completion = tokenCount(u.outputTokens);
  if (prompt + completion === 0) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
};

/** `session/update` kinds that are the agent's own (native) tool activity. */
const isNativeToolUpdate = (update: unknown): boolean => {
  const kind = (update as { readonly sessionUpdate?: unknown } | null)
    ?.sessionUpdate;
  return kind === "tool_call" || kind === "tool_call_update";
};

/**
 * `session/new` metadata: an EMPTY built-in tool allowlist
 * (`_meta.agy.enabledTools`). NOT relied on: `agy` 1.5.14's ACP server ignores
 * it (and the CLI `settings.json` deny rules) and still offers `run_command`
 * and friends, asking the client for permission instead. The real guards are
 * {@link ANTIGRAVITY_ACP_NO_BUILTIN_TOOLS} (so the model doesn't reach for
 * them) and the turn's native-tool check (so one never runs).
 */
export const ANTIGRAVITY_SESSION_META = {
  agy: { enabledTools: [] },
} as const;

/**
 * Leads every ACP prompt. Under ACP `agy` still offers its built-in tools, and
 * with an image attached the model tends to inspect it with `run_command`
 * (python + PIL) instead of looking at it. The daemon must refuse that, and
 * `agy` then ends the turn with no answer — so the chat failed ("antigravity
 * attempted a native tool"). Told plainly that those tools are unavailable and
 * that images are already in its context, it answers directly (3 of 3 live
 * runs, against 3 of 3 tool attempts without it). The conversation's own
 * tools (the loopback MCP server) stay available.
 */
/** ACP's closed `ToolKind` vocabulary — the only tool detail ever logged. */
const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export const ANTIGRAVITY_ACP_NO_BUILTIN_TOOLS =
  "You cannot run commands, read or write files, or browse the web here: any such attempt fails and ends your answer. Attached images are already in your context: look at them directly. Only the tools provided for this conversation, if any, may be called.";

/** MCP server name we register for client tools (session/new). */
const CLIENT_TOOLS_MCP_SERVER = "openllm-client-tools";

/** The id `agy` gives an MCP tool: `mcp_<server>_<tool>` (agy 1.5.14 carries
 *  no `_meta` tag on these updates; the id is what its transcript records). */
export const antigravityMcpToolName = (tool: string): string =>
  `mcp_${CLIENT_TOOLS_MCP_SERVER}_${tool}`;

/** The qualified ids of a turn's registered caller tools. */
export const antigravityMcpToolNames = (
  tools: ReadonlyArray<{ readonly name: string }>,
): ReadonlySet<string> =>
  new Set(tools.map((tool) => antigravityMcpToolName(tool.name)));

/** Exact membership only — never a prefix or substring match, so a built-in
 *  (`run_command`, `read_file`, …) can never pass for a caller tool. */
const isOurMcpToolName = (
  name: unknown,
  allowed: ReadonlySet<string>,
): boolean => typeof name === "string" && allowed.has(name);

/** Tool-call ids proven to be OUR MCP dispatch: a `tool_call` /
 *  `tool_call_update` whose `name` is exactly a registered qualified tool.
 *  Later frames of the same call mostly repeat the name but are admitted by
 *  the proven id too — never by title or input. */
export const createMcpCallTracker = (
  allowed: ReadonlySet<string>,
): {
  readonly admits: (update: unknown) => boolean;
} => {
  const ours = new Set<string>();
  return {
    admits: (update) => {
      const u = update as {
        readonly sessionUpdate?: unknown;
        readonly toolCallId?: unknown;
        readonly name?: unknown;
      } | null;
      const id = typeof u?.toolCallId === "string" ? u.toolCallId : null;
      if (isOurMcpToolName(u?.name, allowed)) {
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
//   - Only a successful `session/prompt` terminal parks (and the client-tool
//     early settlement, once the cancelled prompt has settled: the session
//     stays valid). Setup failures, aborts, idle/turn timeouts and native-tool
//     cancels all dispose the process.
//   - Bounded: at most ANTIGRAVITY_WARM_POOL_MAX idle processes, each retired
//     after ANTIGRAVITY_WARM_IDLE_TTL_MS idle or ANTIGRAVITY_WARM_MAX_TURNS
//     turns, and all killed on daemon exit.
//
// Persistent sessions: a process that parks after a CONVERSATION turn keeps
// that conversation's ACP session (`TWarmAgent.conv`) and serves only it —
// the next request of the same conversation takes it back and prompts the
// new turn on the same session. When the process is gone (idle TTL, pool
// eviction, crash) the conversation record outlives it and the next request
// reattaches on a fresh process with `session/resume` / `session/load`.

/** Idle processes kept across all keys (oldest evicted first). */
export const ANTIGRAVITY_WARM_POOL_MAX = 4;
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

/** One conversation's persistent ACP session. */
type TConversation = {
  readonly id: string;
  /** The ACP session id on the (current or a past) agent process. */
  sessionId: string;
  /** The session's own empty daemon-owned cwd, kept for `session/load`. */
  readonly cwd: string;
  /** Loopback MCP server for the caller's tools, alive as long as the
   *  conversation; its callback is the leasing turn's (`handler`). */
  readonly mcp: TCursorMcpServer | null;
  readonly handler: { current: ((name: string, args: unknown) => void) | null };
  /** Process identity the session was opened on (argv + env + epoch). */
  readonly warmKey: string;
  readonly home: string;
  readonly homeGeneration: number;
  readonly epoch: number;
  /** The idle process holding the session, when one is parked. */
  agent: TWarmAgent | null;
  /** A turn is running on it. */
  busy: boolean;
  /** Set while a caller-tool handoff's cancelled prompt is still settling:
   *  the follow-up awaits it instead of reseeding a fresh session. */
  settled: Promise<void> | null;
  lastUsed: number;
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
  /** The conversation whose session this process holds (parked or leased). */
  conv: TConversation | null;
  /** How the agent reattaches a session it does not hold: `session/resume`
   *  (no history replay) or `session/load`; null → it cannot. */
  reattach: "resume" | "load" | null;
};

const idlePool: TWarmAgent[] = [];
/** True once the process is exiting: nothing async can finish then, so
 *  directories are removed synchronously. */
let exiting = false;
const removeDir = (path: string): void => {
  if (exiting) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return;
  }
  void rm(path, { recursive: true, force: true }).catch(() => undefined);
};
/** Persistent sessions by id. The lease store below maps a conversation's
 *  content key to this id. */
const conversations = new Map<string, TConversation>();
/** Conversation key → session id, with the per-conversation lock: a second
 *  concurrent request for the same conversation waits for the first. */
export const antigravityConversations = new NativeSessionStore();
/** A conversation not advanced within this window is forgotten. */
export const ANTIGRAVITY_CONVERSATION_TTL_MS = 60 * 60 * 1000;
/** Most conversations kept (oldest idle dropped first). */
export const ANTIGRAVITY_CONVERSATION_MAX = 32;
let warmEpoch = 0;
let exitHookInstalled = false;
/** Per-HOME generation; dispose bumps it so stale agents retire. */
const homeGenerations = new Map<string, number>();

const homeGenerationOf = (home: string): number =>
  homeGenerations.get(home) ?? 0;

const homeGenerationStale = (owner: {
  readonly home: string;
  readonly homeGeneration: number;
}): boolean => owner.homeGeneration !== homeGenerationOf(owner.home);

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
  // The conversation outlives its process (it is reattached on a new one).
  if (agent.conv !== null && agent.conv.agent === agent) {
    agent.conv.agent = null;
  }
  agent.conv = null;
  agent.route.onUpdate = null;
  agent.route.allowedMcpTools = new Set();
  if (sessionId !== null) agent.client.cancelAndDispose(sessionId);
  else agent.client.dispose();
  if (exiting) {
    removeDir(agent.procCwd);
    return;
  }
  void agent.client
    .whenExited()
    .then(() => removeDir(agent.procCwd))
    .catch(() => undefined);
};

const removeFromIdlePool = (agent: TWarmAgent): void => {
  const index = idlePool.indexOf(agent);
  if (index >= 0) idlePool.splice(index, 1);
};

/** Forget a conversation: its process, loopback MCP server and cwd go. */
const dropConversation = (conv: TConversation): void => {
  conversations.delete(conv.id);
  const agent = conv.agent;
  conv.agent = null;
  if (agent !== null) {
    removeFromIdlePool(agent);
    retireWarmAgent(agent, null);
  }
  conv.mcp?.stop();
  removeDir(conv.cwd);
};

let sweepTimer: ReturnType<typeof setInterval> | undefined;
const ANTIGRAVITY_CONVERSATION_SWEEP_MS = 60_000;

const installExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    exiting = true;
    disposeAntigravityWarmPool();
    for (const conv of [...conversations.values()]) dropConversation(conv);
  });
};

/** Register a conversation and keep an unref'd sweep running while any
 *  exists, so an idle one's MCP port and cwd never outlive the TTL waiting
 *  for another request. */
const trackConversation = (conv: TConversation): void => {
  conversations.set(conv.id, conv);
  installExitHook();
  if (sweepTimer === undefined) {
    sweepTimer = setInterval(() => {
      sweepConversations();
      if (conversations.size === 0 && sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    }, ANTIGRAVITY_CONVERSATION_SWEEP_MS);
    (sweepTimer as { unref?: () => void }).unref?.();
  }
};

/** Drop conversations idle past the TTL, then the oldest beyond the cap. */
const sweepConversations = (): void => {
  const idle = [...conversations.values()]
    .filter((conv) => !conv.busy)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  const cutoff = Date.now() - ANTIGRAVITY_CONVERSATION_TTL_MS;
  let excess = conversations.size - ANTIGRAVITY_CONVERSATION_MAX;
  for (const conv of idle) {
    if (conv.lastUsed < cutoff || excess > 0) {
      dropConversation(conv);
      excess -= 1;
    }
  }
};

/** Lease an idle process for `key` (exclusive), or null → cold spawn. */
const acquireWarmAgent = (key: string): TWarmAgent | null => {
  for (let i = idlePool.length - 1; i >= 0; i--) {
    const agent = idlePool[i];
    // A process holding a conversation serves only that conversation.
    if (agent === undefined || agent.key !== key || agent.conv !== null) {
      continue;
    }
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

/** Take back the idle process holding `conv`'s session (exclusive), or null
 *  when it is gone, dead or stale. */
const takeConversationAgent = (conv: TConversation): TWarmAgent | null => {
  const agent = conv.agent;
  if (agent === null) return null;
  removeFromIdlePool(agent);
  clearTimeout(agent.idleTimer);
  agent.idleTimer = undefined;
  conv.agent = null;
  if (
    !agent.client.isAlive() ||
    agent.epoch !== warmEpoch ||
    homeGenerationStale(agent)
  ) {
    retireWarmAgent(agent, null);
    return null;
  }
  return agent;
};

/** Park a process after a clean turn, or retire it when it may not stay. */
const releaseWarmAgent = (agent: TWarmAgent, idleTtlMs: number): void => {
  agent.turns += 1;
  agent.route.onUpdate = null;
  agent.route.allowedMcpTools = new Set();
  if (
    !agent.client.isAlive() ||
    agent.epoch !== warmEpoch ||
    // A conversation's process is one session, not an accumulating pool.
    (agent.conv === null && agent.turns >= ANTIGRAVITY_WARM_MAX_TURNS) ||
    homeGenerationStale(agent)
  ) {
    retireWarmAgent(agent, null);
    return;
  }
  installExitHook();
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
  // Running turns drop theirs when they end (the epoch moved).
  for (const conv of [...conversations.values()]) {
    if (!conv.busy) dropConversation(conv);
  }
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
  for (const conv of [...conversations.values()]) {
    if (conv.home === home && !conv.busy) dropConversation(conv);
  }
};

/** Number of parked processes (diagnostics + tests). */
export const antigravityWarmPoolSize = (): number => idlePool.length;

/**
 * The conversation a request belongs to (`antigravity-conversation.ts`). The
 * caller leases it from {@link antigravityConversations} by the plan's
 * `continueKey` and hands the lease over: the run settles it under
 * `nextKey(reply)` once the turn ends (or drops/restores it on failure).
 */
export type TAntigravityConversation = {
  readonly lease: TSessionLease;
  /** What a CONTINUED session is prompted with: only the new turn(s). */
  readonly delta: {
    readonly promptText: string;
    readonly images: ReadonlyArray<TCursorImage>;
  };
  readonly nextKey: (reply: TAntigravityReply) => string;
};

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
  /** How long a caller-tool handoff waits for the cancelled prompt to settle
   *  before the session is given up (default 10s). */
  readonly cancelSettleMs?: number;
  /** Continue this conversation's ACP session (see {@link TAntigravityConversation}). */
  readonly conversation?: TAntigravityConversation;
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
  const home = params.env.HOME;
  if (home === undefined || home.length === 0 || home === homedir()) {
    return { kind: "declined", reason: "antigravity: no isolated HOME" };
  }
  // The account this request was checked for: its sign-in epoch AND its
  // HOME's generation (removing the slot bumps only the latter), taken
  // BEFORE any readiness check. Every later gate — spawn, authenticate,
  // prompt, a decline's cooldown — compares against these.
  const startGeneration = homeGenerationOf(home);
  const sameAccount = (): boolean =>
    params.currentSignInEpoch() === params.signInEpoch &&
    homeGenerationOf(home) === startGeneration;
  // Shared spawn gates (`antigravity-common.ts`): isolated HOME, slot
  // keychain, the deny rules, abort.
  const gate = await prepareAgySpawn({
    env: params.env,
    signal: params.signal,
    ...(params.ensureKeychain !== undefined
      ? { ensureKeychain: params.ensureKeychain }
      : {}),
    ensureSettings: params.ensureSettings ?? ensureAntigravityCliSettings,
  });
  if (!gate.ok) {
    return {
      kind: "declined",
      reason: gate.aborted ? gate.reason : `antigravity: ${gate.reason}`,
    };
  }
  // `agy acp` shares the CLI's sign-in. Gate on its metadata so a signed-out
  // account declines as `auth` instead of starting a browser sign-in.
  if (!(await (params.signedIn ?? agyCliSignedIn)(home))) {
    // Only a miss under the account this request was planned for cools the
    // hop: one read across a sign-in must not put the new account on an
    // auth cooldown.
    return {
      kind: "declined",
      reason: "antigravity: Google sign-in required",
      ...(sameAccount() ? { cooldownReason: "auth" as const } : {}),
    };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }

  const cv = params.conversation;
  type TQueueItem =
    | TChatCompletionChunk
    | "end"
    | {
        readonly error: Error;
        readonly cooldown?: TAntigravityFailure["cooldown"];
        readonly recoverAtMs?: number;
      };
  const queue: TQueueItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: TQueueItem): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  // A FRESH session is led by the no-built-in-tools note: what is sent is
  // what usage estimates count. A continued session already holds it (it
  // belongs to the session's first prompt), so only the new turn goes.
  const fullPrompt = `${ANTIGRAVITY_ACP_NO_BUILTIN_TOOLS}\n\n${
    params.systemText !== null
      ? `${params.systemText}\n\n${params.userText}`
      : params.userText
  }`;
  let promptText = fullPrompt;
  let turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
  });

  const spawnEnv = antigravitySpawnEnv(params.env);
  // Caller tools ride a client-configured HTTP MCP server, which `agy acp`
  // serves in worker mode (one isolated worker per session). Plain turns
  // keep the single-process server. The argv is part of the warm key, so a
  // worker-mode process only ever serves tool turns and vice versa.
  // Confined by the inference `agy` profile (`antigravity-seatbelt.ts`:
  // Seatbelt on macOS, Landlock on Linux). A test's `probe` override runs
  // the fake agent bare.
  const bareArgv = antigravityAcpArgv(
    params.bin,
    (params.tools?.length ?? 0) > 0,
  );
  const confined = params.probe === undefined;
  const argv = confined ? confineAgyArgv(bareArgv, home) : bareArgv;
  const warmKey = antigravityWarmKey(
    argv.join("\u0000"),
    spawnEnv,
    params.signInEpoch,
  );

  // The conversation to continue, when its session is still usable here.
  sweepConversations();
  const leasedId = cv?.lease.sessionId ?? null;
  let prior: TConversation | null =
    leasedId !== null ? (conversations.get(leasedId) ?? null) : null;
  // A caller-tool handoff commits its key at once, so this follow-up can
  // arrive while the cancelled prompt is still settling: wait for it (the
  // session is valid then) instead of reseeding a fresh one.
  if (prior !== null && prior.busy && prior.settled !== null) {
    await prior.settled;
    prior = leasedId !== null ? (conversations.get(leasedId) ?? null) : null;
  }
  if (
    prior !== null &&
    (prior.busy ||
      prior.warmKey !== warmKey ||
      prior.epoch !== warmEpoch ||
      homeGenerationStale(prior))
  ) {
    if (!prior.busy) dropConversation(prior);
    prior = null;
  }

  // Empty, daemon-owned cwd: bounds anything the agent could see natively.
  // A conversation's lives as long as the conversation (`session/load` needs
  // it); a plain request's is fresh per request.
  let cwd: string;
  try {
    cwd =
      prior !== null
        ? prior.cwd
        : await mkdtemp(
            join(agyTempRoot(), cv !== undefined ? "conv-" : "turn-"),
          );
  } catch (error) {
    return declineFrom(error, params.signal, sameAccount());
  }
  /** Set (never cleared) once a conversation of this request exists. */
  let conv: TConversation | null = prior;
  if (prior !== null) prior.busy = true;
  const handler: TConversation["handler"] = prior?.handler ?? {
    current: null,
  };
  /** The loopback MCP server a plain request owns (a conversation's belongs
   *  to the conversation). */
  let ownMcp: TCursorMcpServer | null = null;
  let agent: TWarmAgent | null = null;
  /** Read through a function: `agent` is assigned inside closures, which
   *  TypeScript's flow narrowing does not see. */
  const currentAgent = (): TWarmAgent | null => agent;
  let sessionId: string | null = null;
  let ended = false;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rearmIdleWatchdog: (() => void) | null = null;
  const allowedMcpTools = antigravityMcpToolNames(params.tools ?? []);
  const ourMcpCalls = createMcpCallTracker(allowedMcpTools);
  /** The prompt reached the agent: the session now holds this turn. */
  let promptSent = false;
  /** A fresh session replaced the conversation's one (it could not be
   *  reattached): the old entry no longer describes anything. */
  let replacedSession = false;
  /** How the prompt ended: `settled` is a clean return (the session is idle),
   *  `result` what it returned (exact usage rides there). */
  let promptOutcome: Promise<{
    readonly settled: boolean;
    readonly result: unknown;
  }> | null = null;
  /** A tool-call terminal held back until the cancelled prompt settles, so it
   *  can carry the prompt's exact usage instead of the context estimate. */
  let handoff: ReadonlyArray<TChatCompletionChunk> | null = null;
  const deliverHandoff = (result: unknown): void => {
    const chunks = handoff;
    if (chunks === null) return;
    handoff = null;
    const exact = exactUsageOf(result);
    for (const chunk of chunks) {
      push(
        exact !== null && chunk.usage !== undefined
          ? ({ ...chunk, usage: exact } as TChatCompletionChunk)
          : chunk,
      );
    }
    push("end");
  };
  let contextUsed = 0;
  let replyText = "";
  const replyCalls: Array<{ name: string; arguments: string }> = [];

  /** How the turn leaves the agent process. `keep` is the caller-tool
   *  handoff: the in-flight prompt is cancelled, and the session stays. */
  type TSettle = "park" | "keep" | "cancel" | "dispose";

  const finish = (settle: "park" | "cancel" | "dispose"): void => {
    const owned = agent;
    if (conv === null) {
      // Settle the process FIRST: `mcp.stop()` force-closes connections and,
      // called from inside the MCP tool handler, can run other JS before it
      // returns — the process's fate must already be decided by then.
      if (owned !== null) {
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
      ownMcp?.stop();
      ownMcp = null;
      removeDir(cwd);
      return;
    }
    const held = conv;
    held.busy = false;
    held.lastUsed = Date.now();
    const reusable =
      settle === "park" &&
      promptSent &&
      owned !== null &&
      params.currentSignInEpoch() === params.signInEpoch &&
      held.epoch === warmEpoch &&
      !homeGenerationStale(held);
    if (reusable && owned !== null && cv !== undefined) {
      owned.conv = held;
      held.agent = owned;
      held.sessionId = sessionId ?? held.sessionId;
      releaseWarmAgent(
        owned,
        params.warmIdleTtlMs ?? ANTIGRAVITY_WARM_IDLE_TTL_MS,
      );
      // A process that could not park (died) leaves the session to be
      // reattached; the conversation continues under its next key.
      cv.lease.commit(
        cv.nextKey({ text: replyText, toolCalls: replyCalls }),
        held.id,
      );
      return;
    }
    if (owned !== null) {
      retireWarmAgent(owned, settle === "cancel" ? sessionId : null);
    }
    const consumed = promptSent || replacedSession;
    if (consumed || prior === null) dropConversation(held);
    if (consumed) cv?.lease.commit("", null);
    else cv?.lease.abandon();
  };

  const cleanup = (settle: TSettle): void => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(idleTimer);
    rearmIdleWatchdog = null;
    params.signal.removeEventListener("abort", abort);
    handler.current = null;
    const owned = agent;
    if (owned !== null) {
      owned.route.onUpdate = null;
      owned.route.allowedMcpTools = new Set();
    }
    if (settle === "keep" && owned !== null && sessionId !== null) {
      // The caller's tool call ended the turn mid-flight. Cancel the prompt
      // and wait for the agent to settle it: only then is the session idle
      // and ready for the tool result.
      owned.client.notify("session/cancel", { sessionId });
      const held = conv;
      let markSettled: () => void = () => undefined;
      if (held !== null && cv !== undefined) {
        // Calls the agent is still holding on our MCP server end now.
        held.mcp?.releaseHeld();
        // The client's tool-result follow-up can arrive before the cancelled
        // prompt settles: publish the next key NOW (and let that request
        // wait on `settled`) rather than after the settle.
        held.sessionId = sessionId;
        held.settled = new Promise<void>((resolve) => {
          markSettled = resolve;
        });
        cv.lease.commit(
          cv.nextKey({ text: replyText, toolCalls: replyCalls }),
          held.id,
        );
      }
      const budget = params.cancelSettleMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        promptOutcome ?? Promise.resolve({ settled: false, result: null }),
        new Promise<{ readonly settled: boolean; readonly result: unknown }>(
          (resolve) => {
            timer = setTimeout(
              () => resolve({ settled: false, result: null }),
              budget,
            );
          },
        ),
      ]).then((outcome) => {
        clearTimeout(timer);
        try {
          deliverHandoff(outcome.result);
          finish(outcome.settled ? "park" : "cancel");
        } finally {
          if (held !== null) held.settled = null;
          markSettled();
        }
      });
      return;
    }
    finish(settle === "keep" ? "cancel" : settle);
    deliverHandoff(null);
  };
  const endWith = (
    chunks: ReadonlyArray<TChatCompletionChunk>,
    settle: "park" | "keep" | "cancel",
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
    recoverAtMs?: number,
  ): void => {
    if (ended) return;
    ended = true;
    push(
      cooldown !== undefined
        ? {
            error,
            cooldown,
            ...(recoverAtMs !== undefined ? { recoverAtMs } : {}),
          }
        : { error },
    );
    cleanup("cancel");
  };
  const abort = (): void => {
    failStream(new DOMException("client aborted", "AbortError"));
  };

  /** The agent's `usage_update` carries the session's CUMULATIVE context size
   *  (not a per-call delta): the latest one is the fallback when a turn ends
   *  without the prompt's own exact usage. */
  const feedContextUsage = (): void => {
    if (contextUsed > 0) {
      turn.handleUpdate({ sessionUpdate: "usage_update", used: contextUsed });
      contextUsed = 0;
    }
  };

  /** The leasing turn's view of agent notifications (installed per turn on
   *  the process route — the client's own callback outlives every turn). */
  const onUpdate = (p: unknown): void => {
    if (ended) return;
    const notif = p as
      | { readonly sessionId?: unknown; readonly update?: unknown }
      | undefined;
    // Nothing before the session is attached counts: a `session/load`
    // replays the whole history here, and none of it is this turn's output.
    if (!promptSent || sessionId === null || notif?.sessionId !== sessionId) {
      return;
    }
    rearmIdleWatchdog?.();
    const update = notif.update as {
      readonly sessionUpdate?: unknown;
      readonly used?: unknown;
    } | null;
    if (update?.sessionUpdate === "usage_update") {
      if (typeof update.used === "number" && update.used > 0) {
        contextUsed = update.used;
      }
      return;
    }
    if (isNativeToolUpdate(notif.update) && !ourMcpCalls.admits(notif.update)) {
      // The agent tried one of ITS tools — never let it run. The tool's ACP
      // kind (execute / read / fetch …) is a closed vocabulary; its title or
      // input (a command line) never leaves the machine.
      const kind = (notif.update as { readonly kind?: unknown }).kind;
      logWarn(
        "antigravity-acp",
        safeDiagnosticMessage`Antigravity attempted a built-in tool; the turn was stopped.`,
        { tool_kind: ACP_TOOL_KINDS.has(kind as string) ? kind : "other" },
      );
      failStream(new Error("antigravity attempted a native tool"));
      return;
    }
    const chunk = turn.handleUpdate(notif.update);
    if (chunk !== null) {
      push(chunk);
      const content = chunk.choices[0]?.delta.content;
      if (typeof content === "string") replyText += content;
    }
  };

  /** The caller's tool call ends the turn with OpenAI `tool_calls`. */
  const onToolCall = (name: string, args: unknown): void => {
    if (ended) return;
    replyCalls.push({
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
    feedContextUsage();
    // A conversation keeps its session (the cancelled prompt is settled
    // first); a plain request is cut off mid-flight and never parks.
    const chunks = turn.emitToolCall(name, args);
    if (conv === null) {
      endWith(chunks, "cancel");
      return;
    }
    // Hold the terminal until the cancelled prompt settles (bounded): its
    // exact usage replaces the context estimate. The follow-up already waits
    // on `settled`, so nothing is lost by the wait.
    ended = true;
    handoff = chunks;
    cleanup("keep");
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
    // Nothing starts for an account that changed or was removed since the
    // readiness checks.
    if (!sameAccount()) {
      throw new AcpRpcError({
        method: "initialize",
        kind: "rpc",
        message: "antigravity account changed during setup",
      });
    }
    const procCwd = await mkdtemp(join(agyTempRoot(), "proc-"));
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
          // Already confined above (final argv): never wrap it again.
          probe: confined
            ? true
            : (params.probe ?? unwrapAntigravityCliSpawn()),
          exactEnv: true,
          cwd: procCwd,
          ...(params.cancelDisposeGraceMs !== undefined
            ? { cancelDisposeGraceMs: params.cancelDisposeGraceMs }
            : {}),
        },
      );
    } catch (error) {
      removeDir(procCwd);
      throw error;
    }
    const created: TWarmAgent = {
      key: warmKey,
      client,
      procCwd,
      route,
      epoch: warmEpoch,
      home,
      // The generation the request was checked under: a slot removed in
      // between already makes this process stale.
      homeGeneration: startGeneration,
      turns: 0,
      idleTimer: undefined,
      conv: null,
      reattach: null,
    };
    adopt(created);
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
    if (!agyAcpVersionUsable(init)) {
      throw new AcpRpcError({
        method: "initialize",
        kind: "rpc",
        message: "agy is too old for Antigravity ACP — update agy",
      });
    }
    created.reattach = reattachModeOf(init);
    // Signed out (or in) since the gate: never let `authenticate` start a
    // browser sign-in on this host for an account that is gone.
    if (!sameAccount()) {
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

  const mcpServers = (): ReadonlyArray<Record<string, unknown>> => {
    const server = conv?.mcp ?? ownMcp;
    return server !== null
      ? [
          {
            type: "http",
            name: CLIENT_TOOLS_MCP_SERVER,
            url: server.url,
            headers: server.headers,
          },
        ]
      : [];
  };

  const openSession = (owned: TWarmAgent): Promise<unknown> =>
    owned.client.request(
      "session/new",
      { cwd, mcpServers: mcpServers(), _meta: ANTIGRAVITY_SESSION_META },
      RPC_TIMEOUT_MS,
    );

  params.signal.addEventListener("abort", abort, { once: true });

  const failSetup = (error: unknown): TNativeRunResult => {
    ended = true;
    cleanup("dispose");
    return declineFrom(error, params.signal, sameAccount());
  };

  /** Bring the conversation's existing session live: the idle process that
   *  still holds it, else `session/resume` / `session/load` on a (new)
   *  process. False → it cannot be reattached; a fresh session is opened. */
  const attachExisting = async (existing: TConversation): Promise<boolean> => {
    const idle = takeConversationAgent(existing);
    if (idle !== null) {
      adopt(idle);
      return true;
    }
    const reused = acquireWarmAgent(warmKey);
    if (reused !== null) adopt(reused);
    else await startCold();
    const owned = currentAgent();
    if (owned === null) throw new DOMException("client aborted", "AbortError");
    if (owned.reattach === null) return false;
    try {
      const result = await owned.client.request(
        owned.reattach === "resume" ? "session/resume" : "session/load",
        { sessionId: existing.sessionId, cwd, mcpServers: mcpServers() },
        RPC_TIMEOUT_MS,
      );
      await ensureAntigravityModel(
        owned.client,
        existing.sessionId,
        params.providerModelId,
        result,
        true,
      );
      return true;
    } catch (error) {
      if (params.signal.aborted || cleaned) throw error;
      if (!owned.client.isAlive()) {
        retireWarmAgent(owned, null);
        agent = null;
      }
      return false;
    }
  };

  /** Open a fresh session on a process (leased, or cold). */
  const openFresh = async (): Promise<unknown> => {
    const alive = currentAgent();
    if (alive !== null && !alive.client.isAlive()) {
      retireWarmAgent(alive, null);
      agent = null;
    }
    const held = currentAgent();
    if (held !== null) return openSession(held);
    const leased = acquireWarmAgent(warmKey);
    if (leased === null) {
      await startCold();
      const fresh = currentAgent();
      if (fresh === null) {
        throw new DOMException("client aborted", "AbortError");
      }
      return openSession(fresh);
    }
    adopt(leased);
    try {
      return await openSession(leased);
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
      return openSession(fresh);
    }
  };

  let attached = false;
  try {
    if ((params.tools?.length ?? 0) > 0 && conv?.mcp == null) {
      const server = startCursorMcpServer({
        tools: params.tools ?? [],
        onToolCall: (name, args) => handler.current?.(name, args),
        // A persistent session must never record a fake tool success.
        holdToolCalls: cv !== undefined,
      });
      if (cv !== undefined) {
        conv = {
          id: randomUUID(),
          sessionId: "",
          cwd,
          mcp: server,
          handler,
          warmKey,
          home,
          homeGeneration: startGeneration,
          epoch: warmEpoch,
          agent: null,
          busy: true,
          settled: null,
          lastUsed: Date.now(),
        };
        trackConversation(conv);
      } else {
        ownMcp = server;
      }
    }
    if (conv === null && cv !== undefined) {
      conv = {
        id: randomUUID(),
        sessionId: "",
        cwd,
        mcp: null,
        handler,
        warmKey,
        home,
        homeGeneration: startGeneration,
        epoch: warmEpoch,
        agent: null,
        busy: true,
        settled: null,
        lastUsed: Date.now(),
      };
      trackConversation(conv);
    }
    if (prior !== null) attached = await attachExisting(prior);
    let opened: unknown = null;
    if (!attached) {
      opened = await openFresh();
      // Only once the replacement exists is the old entry spent: a failed
      // setup leaves the prior conversation to be tried again.
      if (prior !== null) replacedSession = true;
    }
    const owned = currentAgent();
    if (owned === null || cleaned) {
      throw new DOMException("client aborted", "AbortError");
    }
    if (attached) {
      sessionId = prior?.sessionId ?? null;
    } else {
      const sid = (opened as { readonly sessionId?: unknown } | null)
        ?.sessionId;
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
    }
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
  if (!sameAccount() || homeGenerationStale(owned)) {
    return failSetup(
      new AcpRpcError({
        method: "session/prompt",
        kind: "rpc",
        message: "antigravity account changed during setup",
      }),
    );
  }
  if (conv !== null) conv.sessionId = sessionId;
  const promptImages =
    attached && cv !== undefined ? cv.delta.images : (params.images ?? []);
  if (attached && cv !== undefined) promptText = cv.delta.promptText;
  turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
  });
  handler.current = onToolCall;
  promptSent = true;
  // Only steps this prompt adds are judged (agy's own per-session log).
  const turnSessionId = sessionId;
  const stepWatermark = readStepWatermark(home, turnSessionId);
  const prompt = owned.client.request(
    "session/prompt",
    { sessionId, prompt: acpPromptBlocks(promptText, promptImages) },
    params.turnTimeoutMs ?? ANTIGRAVITY_TURN_TIMEOUT_MS,
  );
  promptOutcome = prompt.then(
    (result) => ({ settled: true, result }),
    () => ({ settled: false, result: null }),
  );
  void prompt
    .then((result) => {
      if (ended) return;
      const stop = (result as { readonly stopReason?: unknown } | null)
        ?.stopReason;
      if (stop === "cancelled") {
        failStream(new Error("antigravity turn cancelled"));
        return;
      }
      if (
        stop !== "end_turn" &&
        stop !== "max_tokens" &&
        stop !== "max_turn_requests" &&
        stop !== "refusal"
      ) {
        failStream(new Error("antigravity turn returned an invalid terminal"));
        return;
      }
      // agy reports an upstream failure as chat text + `end_turn`, and quota
      // as `refusal`: its own session log says which. Best effort.
      const failure = classifyTurnOutcome(
        stop,
        stepWatermark === undefined
          ? null
          : readLastStepAfter(home, turnSessionId, stepWatermark),
      );
      if (
        failure !== undefined &&
        (failure.broken === true || stop === "refusal" || !turn.sawOutput())
      ) {
        // Failing the stream drops the conversation (never parked), so a
        // broken session is never reattached: the next request starts a
        // fresh, fully seeded one.
        failStream(
          new Error(failure.reason),
          failure.cooldown,
          failure.recoverAtMs,
        );
      } else if (!turn.sawOutput()) {
        failStream(new Error("antigravity turn ended before producing output"));
      } else {
        // The ONLY path that may park the process: a clean ACP terminal.
        const exact = exactUsageOf(result);
        if (exact === null) feedContextUsage();
        const terminal = turn.finish(stop);
        for (const chunk of terminal) {
          const content = chunk.choices[0]?.delta.content;
          if (typeof content === "string") replyText += content;
        }
        endWith(
          exact === null
            ? terminal
            : terminal.map((chunk) =>
                chunk.usage !== undefined
                  ? ({ ...chunk, usage: exact } as TChatCompletionChunk)
                  : chunk,
              ),
          "park",
        );
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
        : classifyAgyMessage(reason)?.cooldown === "quota_exhausted"
          ? ("quota_exhausted" as const)
          : undefined;
    // A sign-in change since the request was planned: the cooldown is the
    // old account's (the same rule as `declineFrom`).
    return {
      kind: "declined",
      reason,
      ...(failure !== undefined && sameAccount()
        ? {
            cooldownReason: failure,
            ...(first !== "end" && "recoverAtMs" in first
              ? { recoverAtMs: first.recoverAtMs }
              : {}),
          }
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
