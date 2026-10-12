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
 * never turn a subscription hop into a metered one. The daemon never reads the
 * agent's token file — status only checks that it EXISTS.
 *
 * Native tools never run: permission requests are rejected, fs/terminal client
 * capabilities are off, the cwd is an empty daemon temp dir, and any native
 * `tool_call` update that is not our loopback MCP tool cancels the turn.
 *
 * v1 = one cold session per request (the conversation is flattened by
 * `cursorRequestOf`). The agent reports real per-call token totals via ACP
 * `usage_update` (`createAcpTurnState` sums them; output share estimated).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { daemonTempDir } from "../sandbox/working-set";
import { DAEMON_VERSION } from "../version";
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

/** Where the agent keeps its sign-in token under GEMINI_HOME (never read). */
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
 * Server→client requests: native tools never run, so every permission ask is
 * REJECTED (prefer `reject_once`, else `reject_always`, else cancel). All
 * other requests are refused (fs/terminal capabilities are advertised off).
 */
export const handleAntigravityServerRequest = (
  method: string,
  params: unknown,
): unknown => {
  if (method === "session/request_permission") {
    const options = (
      params as {
        readonly options?: ReadonlyArray<{
          readonly optionId?: unknown;
          readonly kind?: unknown;
        }>;
      } | null
    )?.options;
    const pick = Array.isArray(options)
      ? (options.find((o) => o.kind === "reject_once") ??
        options.find((o) => o.kind === "reject_always"))
      : undefined;
    return typeof pick?.optionId === "string"
      ? { outcome: { outcome: "selected", optionId: pick.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  return null;
};

type TSelectOption = { readonly value?: unknown; readonly options?: unknown };

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

/** Our loopback MCP tool calls surface as tool_call updates too; their
 *  title/name carries the MCP server name. */
const isOurMcpToolUpdate = (update: unknown): boolean =>
  JSON.stringify(update ?? null).includes("openllm-client-tools");

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
};

/**
 * One COLD turn: spawn → initialize (identity check) → authenticate (short
 * budget) → session/new in an empty temp cwd (+ loopback MCP for client tools)
 * → exact model pin → session/prompt. Commit-on-first-output; every pre-commit
 * failure declines with a classified cooldown so the walker advances the plan.
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

  type TQueueItem = TChatCompletionChunk | "end" | { readonly error: Error };
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

  // Empty, daemon-owned cwd: bounds anything the agent could see natively.
  const cwd = await mkdtemp(join(daemonTempDir(), "agy-"));
  let sessionId: string | null = null;
  let ended = false;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let lastActivityAt = Date.now();
  let mcp: TCursorMcpServer | null = null;

  let client: AcpClient;
  const cleanup = (cancel: boolean): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(idleTimer);
    params.signal.removeEventListener("abort", abort);
    if (cancel && sessionId !== null) client.cancelAndDispose(sessionId);
    else client.dispose();
    mcp?.stop();
    mcp = null;
    void rm(cwd, { recursive: true, force: true });
  };
  const endWith = (chunks: ReadonlyArray<TChatCompletionChunk>): void => {
    if (ended) return;
    ended = true;
    for (const chunk of chunks) push(chunk);
    push("end");
    cleanup(true);
  };
  const failStream = (error: Error): void => {
    if (ended) return;
    ended = true;
    push({ error });
    cleanup(true);
  };
  const abort = (): void => {
    failStream(new DOMException("client aborted", "AbortError"));
  };

  try {
    prepareAntigravityProfile(params.env.GEMINI_HOME ?? cwd);
    client = new AcpClient(
      params.bin,
      antigravitySpawnEnv(params.env),
      (method, p) => {
        if (method !== "session/update" || ended) return;
        const notif = p as
          | { readonly sessionId?: unknown; readonly update?: unknown }
          | undefined;
        if (sessionId === null || notif?.sessionId !== sessionId) return;
        lastActivityAt = Date.now();
        if (
          isNativeToolUpdate(notif.update) &&
          !isOurMcpToolUpdate(notif.update)
        ) {
          // The agent tried one of ITS tools — never let it run.
          failStream(new Error("antigravity attempted a native tool"));
          return;
        }
        const chunk = turn.handleUpdate(notif.update);
        if (chunk !== null) push(chunk);
      },
      handleAntigravityServerRequest,
      {
        argv: antigravityArgv(params.bin),
        label: "agy_acp_server",
        // File-backed store under the isolated home — stays confined.
        probe: false,
        exactEnv: true,
        cwd,
      },
    );
  } catch (error) {
    void rm(cwd, { recursive: true, force: true });
    return declineFrom(error, params.signal);
  }
  params.signal.addEventListener("abort", abort, { once: true });

  const failSetup = (error: unknown): TNativeRunResult => {
    ended = true;
    cleanup(false);
    return declineFrom(error, params.signal);
  };

  let opened: unknown;
  try {
    if ((params.tools?.length ?? 0) > 0) {
      mcp = startCursorMcpServer({
        tools: params.tools ?? [],
        onToolCall: (name, args) => {
          if (ended) return;
          endWith(turn.emitToolCall(name, args));
        },
      });
    }
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
    opened = await client.request(
      "session/new",
      {
        cwd,
        mcpServers:
          mcp !== null
            ? [
                {
                  type: "http",
                  name: "openllm-client-tools",
                  url: mcp.url,
                  headers: mcp.headers,
                },
              ]
            : [],
      },
      RPC_TIMEOUT_MS,
    );
    const sid = (opened as { readonly sessionId?: unknown } | null)?.sessionId;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new AcpRpcError({
        method: "session/new",
        kind: "rpc",
        message: "missing sessionId",
      });
    }
    sessionId = sid;
    await ensureAntigravityModel(client, sid, params.providerModelId, opened);
    if (params.signal.aborted) {
      throw new DOMException("client aborted", "AbortError");
    }
  } catch (error) {
    return failSetup(error);
  }

  lastActivityAt = Date.now();
  void client
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
        endWith(turn.finish(stop));
      }
    })
    .catch((error: unknown) => {
      failStream(new Error(classifyAntigravityFailure(error).reason));
    });

  const idleBudget = params.idleMs ?? ANTIGRAVITY_IDLE_TIMEOUT_MS;
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt > idleBudget) {
      failStream(new Error("antigravity turn idle timeout"));
    }
  }, 1_000);

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
    cleanup(true);
    const reason =
      first === "end"
        ? "antigravity turn ended before producing output"
        : first.error.message;
    const failure = QUOTA_RE.test(reason)
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
