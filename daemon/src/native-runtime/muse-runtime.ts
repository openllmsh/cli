/**
 * Muse native runtime — one cold official-SDK session per request.
 *
 * The official `@muse-code/sdk@1.3.0` spawn (`spawnMspConnection`) has no
 * custom-process hook: it calls `node:child_process.spawn(command, args)`.
 * Confinement is therefore the SAME argv wrap Cursor uses: `sandboxSpawnArgs`
 * turns `[museBin, "serve", --disable-write, --disable-shell]` into the
 * daemon's `--sandbox-exec` shim so the SDK-owned child is the confined shim,
 * which then execs `muse serve`. An SDK that spawned outside this path would
 * be a blocker; this file does not invent a parallel MSP.
 *
 * Caller tools ride an ephemeral loopback MCP server injected via an isolated
 * XDG overlay (auth.json symlinked from the provider home; no ambient
 * settings/hooks/skills). The first tools/call ends the turn with OpenAI
 * `tool_calls` and cancels the native turn — never a fabricated success.
 *
 * Safety floor (what we can enforce without inventing host rules):
 *   - `--disable-write` + `--disable-shell` (spawn argv)
 *   - `onRequest` approval mode (host policy select-never-create; no
 *     client-authored allowlist exists on MSP)
 *   - `onApproval` allows ONLY exact host-native `web_search` once when the
 *     host asks; known-safe auto-exec under `onRequest` still bypasses the
 *     callback (official probe: known-safe `pwd` runs without asking)
 *   - auth overlay HOME is a SIBLING of `workspaceRoot`, not inside it, so
 *     workspace-scoped reads cannot reach the auth symlink by relative path
 *   - daemon `--sandbox-exec` wrap of the SDK-owned `muse serve` child
 *   - exact model+policy confirmation before any turn; setup RPC + pre-commit
 *     first-output budgets only (no absolute post-submit turn cutoff —
 *     Claude/Codex native contract; Cursor keeps its own turn/idle budgets)
 *
 * Residual (explicit, not claimed fixed): MSP cannot install a "web_search
 * only" rule. Live OS-sandboxed probes (same 1.2 / Meta synthetic-2 marker)
 * showed `onRequest` completing in ~10s vs `denyUnmatched` ~71s, and BOTH
 * modes read synthetic HOME outside the workspace with ZERO `onApproval`
 * callbacks — so `denyUnmatched` caused pathological delayed completion
 * without providing the claimed absolute-read protection. Do not equate
 * callback denial or mode selection with "all other native tools are denied".
 * This candidate is for local testing; it is not a proven full containment
 * solution.
 *
 * Completed provider-executed searches ride `server_search_calls`; they are
 * never re-emitted as caller `tool_calls`. Exact model+policy confirmation is
 * required before a turn starts: `session/read` first, `session/setModel` only
 * on mismatch, then re-`read` fail-closed.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnOutcome as TOfficialMuseTurnOutcome } from "@muse-code/sdk";
import {
  isLaunchFailure,
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
} from "@muse-code/sdk";
import type {
  TChatCompletionChunk,
  TProviderModelEntry,
} from "@openllmsh/protocol";
import { cliBin, cliEnv, MUSE_CREDENTIAL_BACKEND } from "../cli-paths";
import {
  clearMuseStatusObservationCache,
  museNativeModelFingerprint,
  museNativeModelGeneration,
  noteMuseAuthenticatedSession,
  readMuseNativeModels,
  rememberMuseNativeModels,
} from "../delegation/muse";
import { spawnCwd } from "../delegation/util";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { DAEMON_VERSION } from "../version";
import type {
  TMuseFoldedItem,
  TMuseItemDelta,
  TMuseSessionUsage,
} from "./muse-events";
import { createMuseTurnState } from "./muse-events";
import type { TMuseMcpServer, TMuseToolNameMap } from "./muse-mcp-server";
import { buildMuseToolNameMap, startMuseMcpServer } from "./muse-mcp-server";
import type { TMuseOverlay, TMuseWebSearchMode } from "./muse-overlay";
import { createMuseExecutionOverlay } from "./muse-overlay";
import type { TMuseCallerTool, TMuseInputPart } from "./muse-request";
import type { TMuseApprovalRequest } from "./muse-web-search";
import { decideMuseNativeApproval } from "./muse-web-search";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv, PRE_COMMIT_TIMEOUT_MS } from "./types";

/** Official `muse serve` flags verified in the pinned reference
 *  (`safety-settings.ts` `safetyArgs`). There is no verified disable-all
 *  built-ins switch; write + shell are the documented restrictions. */
export const MUSE_SERVE_SAFETY_ARGS = [
  "--disable-write",
  "--disable-shell",
] as const;

export const MUSE_RPC_TIMEOUT_MS = 30_000;

/**
 * Selected host approval mode (official closed `ApprovalMode` enum).
 *
 * `onRequest` is the product candidate after live probes showed
 * `denyUnmatched` delaying completion without blocking known-safe absolute
 * HOME reads (both modes: zero callbacks). The callback still approves only
 * exact host-native `web_search` once when the host asks. This is NOT a
 * custom allowlist — MSP forbids client-authored rules (select-never-create)
 * — and known-safe tools still auto-run without `onApproval`. Exact session
 * verification fails closed on any other reported mode.
 */
export const MUSE_APPROVAL_MODE = "onRequest" as const;

/**
 * MSP treats absent userInputDialogs as capable. This headless client cannot
 * render dialogs, so explicitly withhold userInput/request (D-047).
 */
export const MUSE_CLIENT_CAPABILITIES = {
  userInputDialogs: false,
} as const;

const AUTH_REJECTION_RE =
  /not logged in|not signed in|unauthorized|unauthenticated|authentication (?:failed|rejected)|auth(?:entication)? rejected|please (?:log|sign)[\s-]?in/i;

const API_KEY_OVERRIDE_RE = /^(META_|MUSE_).*(API_KEY|TOKEN|SECRET|ACCESS)/i;

const OPENLLM_RECURSION_KEYS = new Set([
  "OPENLLM_API_KEY",
  "OPENLLM_CLOUD_ORIGIN",
  "OPENLLM_BASE_URL",
  "OPENLLM_ENDPOINT",
]);

const EXPLICIT_METERED_KEYS = new Set([
  "META_API_KEY",
  "MUSE_API_KEY",
  "META_ACCESS_TOKEN",
  "MUSE_ACCESS_TOKEN",
]);

/** Ambient Muse settings/MCP/data overlays, Codex home, and ACP-only yolo
 *  flags must not leak into gateway execution. Per-turn isolated HOME /
 *  XDG_* / CODEX_HOME are re-applied after this cleaner. */
const SETTINGS_LEAK_KEYS = new Set([
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CODEX_HOME",
  "MUSE_CODE_ACP_ALLOW_YOLO",
]);

type TNodeEnv = "development" | "production" | "test";

/** Absent → production. Present but invalid → throw (never silently coerce). */
const nodeEnvOf = (value: string | undefined): TNodeEnv => {
  if (value === undefined) return "production";
  if (value === "development" || value === "production" || value === "test") {
    return value;
  }
  throw new Error(
    "muse spawn env requires NODE_ENV to be development, production, or test",
  );
};

export type TMuseSpawnTarget = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

/** Wrap official `muse serve` argv with the daemon sandbox shim. Pure. */
export const wrapMuseServeSpawn = (museBin: string): TMuseSpawnTarget => {
  const wrapped = sandboxSpawnArgs([
    museBin,
    "serve",
    ...MUSE_SERVE_SAFETY_ARGS,
  ]);
  const command = wrapped[0];
  if (command === undefined) {
    throw new Error("sandboxSpawnArgs returned an empty argv");
  }
  return { command, args: wrapped.slice(1) };
};

/** Drop documented metered-key overrides, OpenLLM recursion knobs, and user
 *  Muse settings/MCP overlay after the shared native poison filter. Returns a
 *  genuine ProcessEnv so NODE_ENV stays the Next-required literal. */
export const cleanMuseSpawnEnv = (
  cliEnv: Record<string, string>,
): NodeJS.ProcessEnv => {
  const cleaned = cleanNativeSpawnEnv(cliEnv);
  // Prefer the cleaned env, then process.env; default production only when
  // both are absent. A present invalid value still rejects.
  const rawNodeEnv =
    cleaned.NODE_ENV !== undefined
      ? cleaned.NODE_ENV
      : process.env.NODE_ENV !== undefined
        ? process.env.NODE_ENV
        : undefined;
  const nodeEnv = nodeEnvOf(rawNodeEnv);
  const next: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
  for (const [key, value] of Object.entries(cleaned)) {
    if (key === "NODE_ENV") continue;
    if (EXPLICIT_METERED_KEYS.has(key)) continue;
    if (OPENLLM_RECURSION_KEYS.has(key)) continue;
    if (SETTINGS_LEAK_KEYS.has(key)) continue;
    if (API_KEY_OVERRIDE_RE.test(key)) continue;
    next[key] = value;
  }
  // Always pin the vendor file credential backend (overrides ambient
  // `keychain` / unset). Same invariant as `cliEnv("muse")` so login,
  // logout, serve, model/list, and inference never open macOS Keychain.
  next.TBH_CREDENTIAL_BACKEND = MUSE_CREDENTIAL_BACKEND;
  return next;
};

export type TMuseHostSpawnOptions = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onStderr?: (chunk: string) => void;
  /** Abort in-flight spawn/initialize (closes MSP handshake / child). */
  readonly signal?: AbortSignal;
};

export type TMuseSessionRead = {
  readonly sessionId: string;
  readonly modelId: string | null;
  readonly providerId?: string | null;
  /** Effective approval mode from session/read, when the host reported one. */
  readonly approvalMode?: string | null;
};

export type TMuseTurnError = {
  /** Official `TurnError.kind` (open enum) — branch/diagnostic code only. */
  readonly kind: string;
  /** Bounded human text from the host; never a prompt or credential. */
  readonly message: string;
  readonly retryable?: boolean;
};

export type TMuseTurnOutcome = {
  readonly kind:
    | "completed"
    | "failed"
    | "cancelled"
    | "unqueued"
    | "terminalUnknown";
  readonly terminal?: string;
  /**
   * Present when the host authored `turn/completed.error` (required for
   * `terminal: "failed"`). Dropping this is what collapses live failures into
   * the generic "before producing output" decline.
   */
  readonly error?: TMuseTurnError;
  /** Wire launch-failure marker (`terminal: failed` + `error.kind: launchError`). */
  readonly launchFailure?: boolean;
  readonly usage?: TMuseSessionUsage;
};

/** Cap host error text retained on the decline path (privacy + log size). */
const MUSE_TURN_ERROR_MESSAGE_MAX = 200;

/**
 * Privacy-safe stderr classifier — codes only, never the raw chunk (may hold
 * paths, tokens, or prompt fragments).
 */
export const classifyMuseStderr = (
  chunk: string,
): {
  readonly code:
    | "muse_stderr_invalid_initialize"
    | "muse_stderr_auth"
    | "muse_stderr_network"
    | "muse_stderr_other";
  readonly bytes: number;
} => {
  const trimmed = chunk.trim();
  const bytes = trimmed.length;
  if (/invalid initialize|clientInfo\.name|SS1\.4\.1/i.test(trimmed)) {
    return { code: "muse_stderr_invalid_initialize", bytes };
  }
  if (
    /unauthorized|unauthenticated|auth(?:entication)? failed|not signed in|credential/i.test(
      trimmed,
    )
  ) {
    return { code: "muse_stderr_auth", bytes };
  }
  if (/ECONN|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(trimmed)) {
    return { code: "muse_stderr_network", bytes };
  }
  return { code: "muse_stderr_other", bytes };
};

/**
 * Decline reason for a settled Muse turn that produced no output. Prefer the
 * host's `error.kind` / terminal over the generic empty-output string.
 */
export const museTurnDeclineReason = (outcome: TMuseTurnOutcome): string => {
  if (outcome.kind === "unqueued") {
    return "muse turn unqueued before start";
  }
  if (outcome.kind === "terminalUnknown") {
    return "muse turn ended (terminalUnknown)";
  }
  if (outcome.kind === "cancelled" || outcome.terminal === "cancelled") {
    return "muse turn cancelled before producing output";
  }
  const terminal = outcome.terminal;
  const errorKind =
    outcome.error?.kind ??
    (outcome.launchFailure === true ? "launchError" : undefined);
  const detail = outcome.error?.message?.trim();
  if (errorKind !== undefined) {
    const label =
      terminal !== undefined ? `${errorKind}/${terminal}` : errorKind;
    if (detail !== undefined && detail.length > 0) {
      return `muse turn failed (${label}): ${detail}`;
    }
    return `muse turn failed (${label})`;
  }
  if (terminal === "failed") {
    return "muse turn failed before producing output";
  }
  if (terminal !== undefined) {
    return `muse turn ended before producing output (${outcome.kind}/${terminal})`;
  }
  return `muse turn ended before producing output (${outcome.kind})`;
};

const mapOfficialTurnOutcome = (
  outcome: TOfficialMuseTurnOutcome,
  usage: TMuseSessionUsage | undefined,
): TMuseTurnOutcome => {
  if (outcome.kind === "unqueued") {
    return {
      kind: "unqueued",
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (outcome.kind === "terminalUnknown") {
    return {
      kind: "terminalUnknown",
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  // kind === "completed" — mid-turn and launch failures stay on this arm with
  // terminal "failed" + error (official SDK contract; never a thrown RPC).
  const params = asRecord(outcome.params);
  const terminal = asString(params?.terminal);
  const errorRec = asRecord(params?.error);
  const errorKind = asString(errorRec?.kind);
  const rawMessage = asString(errorRec?.message);
  const error =
    errorKind !== null
      ? {
          kind: errorKind,
          message: (rawMessage ?? "").slice(0, MUSE_TURN_ERROR_MESSAGE_MAX),
          ...(typeof errorRec?.retryable === "boolean"
            ? { retryable: errorRec.retryable }
            : {}),
        }
      : undefined;
  const launchFailure = isLaunchFailure(outcome);
  return {
    kind: "completed",
    ...(terminal !== null ? { terminal } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(launchFailure ? { launchFailure: true } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
};

export type TMuseTurn = {
  readonly turnId: string;
  readonly completed: Promise<TMuseTurnOutcome>;
  items(): AsyncIterable<TMuseFoldedItem>;
  deltas(): AsyncIterable<TMuseItemDelta>;
  cancel(): Promise<void>;
};

export type TMuseSession = {
  readonly sessionId: string;
  setModel(model: {
    readonly modelId: string;
    readonly providerId?: string;
  }): Promise<void>;
  read(): Promise<TMuseSessionRead>;
  /** Best-effort last `session/tokenUsage` folded for this session. */
  lastUsage(): TMuseSessionUsage | undefined;
  /**
   * Demand-driven `model/list` against the live host. Returns mapped provider
   * entries (may be empty). Does not invent catalog facts.
   */
  listModels(): Promise<ReadonlyArray<TProviderModelEntry>>;
  sendUserTurn(input: ReadonlyArray<TMuseInputPart>): Promise<TMuseTurn>;
  onApproval(
    handler: (
      request: TMuseApprovalRequest,
    ) => Promise<{ readonly choiceId: string }> | { readonly choiceId: string },
  ): void;
};

export type TMuseHost = {
  startSession(options: {
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly modelId: string;
    readonly providerId?: string;
    readonly approvalMode: typeof MUSE_APPROVAL_MODE;
  }): Promise<TMuseSession>;
  /** Demand-driven `model/list` (sessionId optional on the wire). */
  listModels(sessionId?: string): Promise<ReadonlyArray<TProviderModelEntry>>;
  close(): Promise<void>;
};

export type TMuseHostFactory = (
  options: TMuseHostSpawnOptions,
) => Promise<TMuseHost>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Narrow host-native policy — allow web_search once; deny everything else. */
const decideNativeApproval = (
  request: TMuseApprovalRequest,
): { readonly choiceId: string } => decideMuseNativeApproval(request);

const usageFromFold = (session: {
  readonly fold: {
    readonly sessionState: {
      get: (family: "session/tokenUsage") => unknown;
    };
  };
}): TMuseSessionUsage | undefined => {
  const reported = session.fold.sessionState.get("session/tokenUsage");
  const rec = asRecord(reported);
  if (rec === null) return undefined;
  return rec as TMuseSessionUsage;
};

const mapFoldedItem = (item: unknown): TMuseFoldedItem | null => {
  const rec = asRecord(item);
  if (rec === null) return null;
  const itemId = asString(rec.itemId);
  const kind = asString(rec.kind);
  const revision =
    typeof rec.revision === "number" && Number.isSafeInteger(rec.revision)
      ? rec.revision
      : null;
  if (itemId === null || kind === null || revision === null) return null;
  return {
    itemId,
    kind,
    revision,
    ...(typeof rec.status === "string" ? { status: rec.status } : {}),
    ...(typeof rec.text === "string" ? { text: rec.text } : {}),
    ...(Array.isArray(rec.summary)
      ? {
          summary: rec.summary.filter(
            (part): part is string => typeof part === "string",
          ),
        }
      : {}),
    ...(typeof rec.truncated === "boolean" ? { truncated: rec.truncated } : {}),
    ...(typeof rec.callId === "string" ? { callId: rec.callId } : {}),
    ...(typeof rec.tool === "string" ? { tool: rec.tool } : {}),
    ...(typeof rec.args === "string" ? { args: rec.args } : {}),
    ...(typeof rec.visibleOutput === "string"
      ? { visibleOutput: rec.visibleOutput }
      : {}),
  };
};

const mapApprovalRequest = (request: {
  readonly approvalId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly rawArgs: string;
  readonly protectedWrite: boolean;
  readonly availableChoices: ReadonlyArray<{
    readonly choiceId: string;
    readonly decision: string;
    readonly scope: string;
  }>;
  readonly subject: {
    readonly kind: string;
    readonly toolName?: string;
    readonly path?: string;
    readonly command?: string;
  };
}): TMuseApprovalRequest => ({
  approvalId: request.approvalId,
  toolName: request.toolName,
  toolCallId: request.toolCallId,
  rawArgs: request.rawArgs,
  protectedWrite: request.protectedWrite,
  availableChoices: request.availableChoices.map((choice) => ({
    choiceId: choice.choiceId,
    decision: choice.decision,
    scope: choice.scope,
  })),
  subject: {
    kind: request.subject.kind,
    ...(request.subject.toolName !== undefined
      ? { toolName: request.subject.toolName }
      : {}),
    ...(request.subject.path !== undefined
      ? { path: request.subject.path }
      : {}),
    ...(request.subject.command !== undefined
      ? { command: request.subject.command }
      : {}),
  },
});

const mapItemDelta = (delta: unknown): TMuseItemDelta | null => {
  const rec = asRecord(delta);
  if (rec === null) return null;
  const itemId = asString(rec.itemId);
  const text = typeof rec.delta === "string" ? rec.delta : null;
  if (itemId === null || text === null) return null;
  return {
    itemId,
    delta: text,
    ...(typeof rec.field === "string" ? { field: rec.field } : {}),
  };
};

/** Mutable MSP turn parts — SDK `TurnInputPart[]` is not readonly. */
const toTurnInput = (
  input: ReadonlyArray<TMuseInputPart>,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; base64Data: string; mediaType: string }
> =>
  input.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "image" as const,
          base64Data: part.base64Data,
          mediaType: part.mediaType,
        },
  );

/** Map authentic MSP `model/list` rows — no daemon-side name policy. Catalog
 *  ownership and cloud live-merge decide which ids are routable. */
const mapModelList = (raw: unknown): ReadonlyArray<TProviderModelEntry> => {
  const rec = asRecord(raw);
  const models = Array.isArray(rec?.models) ? rec.models : [];
  const out: TProviderModelEntry[] = [];
  for (const row of models) {
    const entry = asRecord(row);
    const modelId = asString(entry?.modelId);
    if (modelId === null) continue;
    const display = asString(entry?.displayLabel);
    const context =
      typeof entry?.contextLimit === "number" &&
      Number.isSafeInteger(entry.contextLimit) &&
      entry.contextLimit > 0
        ? entry.contextLimit
        : undefined;
    const maxOut =
      typeof entry?.outputLimit === "number" &&
      Number.isSafeInteger(entry.outputLimit) &&
      entry.outputLimit > 0
        ? entry.outputLimit
        : undefined;
    out.push({
      provider_model_id: modelId,
      ...(display !== null ? { display_name: display } : {}),
      ...(context !== undefined ? { context_window: context } : {}),
      ...(maxOut !== undefined ? { max_output_tokens: maxOut } : {}),
    });
  }
  return out;
};

const approvalModeOf = (
  sessionRec: Record<string, unknown> | null,
): string | null => {
  if (sessionRec === null) return null;
  const modeBlock = asRecord(sessionRec.approvalMode);
  return asString(modeBlock?.mode) ?? asString(sessionRec.approvalMode);
};

const wrapOfficialHost = async (
  options: TMuseHostSpawnOptions,
): Promise<TMuseHost> => {
  const handshake = spawnMspConnection({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: options.env,
    ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
    shutdownTimeoutMs: 1_000,
  });
  const onAbort = (): void => {
    void handshake.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    options.signal.removeEventListener("abort", onAbort);
    await handshake.close().catch(() => {});
    throw new Error("muse SDK spawn aborted");
  }
  let spawned: Awaited<ReturnType<typeof handshake.initialize>>;
  try {
    spawned = await handshake.initialize({
      clientInfo: { name: "openllm_daemon", version: DAEMON_VERSION },
      capabilities: MUSE_CLIENT_CAPABILITIES,
    });
  } catch (error) {
    // initialize failure / abort must not leave the owned muse serve child.
    await handshake.close().catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  const durability = readSessionDurability(spawned.initializeResult);
  const client = new MuseClient(spawned.connection, { durability });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => {});
    await handshake.close().catch(() => {});
  };
  return {
    close,
    listModels: async (sessionId) => {
      const listed = await spawned.connection.request(
        "model/list",
        sessionId !== undefined ? { sessionId } : {},
      );
      return mapModelList(listed);
    },
    startSession: async (start) => {
      const session = await client.startSession({
        sessionId: start.sessionId,
        workspaceRoot: start.workspaceRoot,
        modelId: start.modelId,
        ...(start.providerId !== undefined
          ? { providerId: start.providerId }
          : {}),
        approvalMode: start.approvalMode,
      });
      // Per-session mutable approval delegate. The real MSP SDK exposes
      // exactly ONE `onApproval` registration slot per session (a second
      // `session.onApproval(...)` call replaces, not adds, the callback —
      // see `MuseClient`/`session` from `@muse-code/sdk`), so we install our
      // OWN single real callback here, once, for the lifetime of the
      // session, and have it always invoke whichever handler is currently
      // assigned to `approvalHandler`. `TMuseSession.onApproval(handler)`
      // (below) then just reassigns `approvalHandler` — it does NOT attempt
      // a second real SDK registration, so callers (e.g. `runMuseNative`)
      // can safely upgrade the policy after `startSession` resolves without
      // silently landing on a no-op and without ever having two live SDK
      // callbacks racing each other.
      let approvalHandler: (
        request: TMuseApprovalRequest,
      ) =>
        | Promise<{ readonly choiceId: string }>
        | { readonly choiceId: string } = decideNativeApproval;
      session.onApproval((request) =>
        approvalHandler(mapApprovalRequest(request)),
      );
      return {
        sessionId: session.sessionId,
        setModel: async (model) => {
          await spawned.connection.command("session/setModel", {
            sessionId: session.sessionId,
            model: {
              modelId: model.modelId,
              ...(model.providerId !== undefined
                ? { providerId: model.providerId }
                : {}),
            },
          });
        },
        read: async () => {
          const observed = await spawned.connection.request("session/read", {
            sessionId: session.sessionId,
            excludeItems: true,
          });
          const saved = asRecord(asRecord(observed)?.session);
          const sessionId = asString(saved?.sessionId);
          if (sessionId === null) {
            throw new Error("Muse session/read returned no sessionId");
          }
          return {
            sessionId,
            modelId: asString(saved?.modelId),
            providerId:
              saved !== null && "providerId" in saved
                ? asString(saved.providerId)
                : undefined,
            approvalMode: approvalModeOf(saved),
          };
        },
        lastUsage: () => usageFromFold(session),
        listModels: async () => {
          const listed = await spawned.connection.request("model/list", {
            sessionId: session.sessionId,
          });
          return mapModelList(listed);
        },
        sendUserTurn: async (input) => {
          const turn = await session.sendUserTurn({
            input: toTurnInput(input),
          });
          return {
            turnId: turn.turnId,
            completed: turn.completed.then((outcome) =>
              mapOfficialTurnOutcome(outcome, usageFromFold(session)),
            ),
            items: async function* () {
              for await (const item of turn.items()) {
                const mapped = mapFoldedItem(item);
                if (mapped !== null) yield mapped;
              }
            },
            deltas: async function* () {
              for await (const delta of turn.deltas()) {
                const mapped = mapItemDelta(delta);
                if (mapped !== null) yield mapped;
              }
            },
            cancel: async () => {
              await spawned.connection
                .command(
                  "turn/cancel",
                  { sessionId: session.sessionId, turnId: turn.turnId },
                  { maxAttempts: 1 },
                )
                .catch(() => {});
            },
          };
        },
        onApproval: (handler) => {
          // Reassigns the per-session delegate the ONE real SDK callback
          // (registered once, above, at `startSession` time) invokes —
          // never a second real `session.onApproval` registration. Replaces
          // whatever handler is currently active (including the
          // `decideNativeApproval` default), so exactly one handler is ever
          // live for this session at a time.
          approvalHandler = handler;
        },
      };
    },
  };
};

export const defaultMuseHostFactory: TMuseHostFactory = wrapOfficialHost;

export type TMuseNativeParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly providerId?: string;
  readonly parts: ReadonlyArray<TMuseInputPart>;
  readonly promptText: string;
  /** Caller function tools exposed via the per-request loopback MCP server. */
  readonly tools?: ReadonlyArray<TMuseCallerTool>;
  readonly signal: AbortSignal;
  readonly precommitMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly hostFactory?: TMuseHostFactory;
  readonly cwd?: string;
  /**
   * Optional Meta endpoint redirect written into the per-turn overlay as
   * nested `settings.endpoint_transport`. Used by bridge-capture — never by
   * the default MSP bridge path.
   */
  readonly endpointTransport?: {
    readonly base_url: string;
    readonly auth: "bearer";
  };
};

const setupDecline = (
  error: unknown,
  signal: AbortSignal,
): TNativeRunResult => {
  if (signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "declined",
    reason: `muse SDK handshake failed: ${message}`,
    ...(AUTH_REJECTION_RE.test(message)
      ? { cooldownReason: "auth" as const }
      : {}),
  };
};

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Open a Muse host under a deadline. On timeout OR outer abort: abort the
 * spawn signal (so official handshake can close the child), promptly reject
 * the waiter, and still close any host that resolves late — including when
 * `open` ignores AbortSignal. Preserves the original timeout/abort error.
 */
export const openMuseHostWithTimeout = async (
  open: (signal: AbortSignal) => Promise<TMuseHost>,
  ms: number,
  label: string,
  outerSignal?: AbortSignal,
): Promise<TMuseHost> => {
  // Fail closed before allocating abortWait — abandoning a never-raced
  // rejected promise would be an unhandled rejection.
  if (outerSignal?.aborted) {
    throw new Error(`${label} aborted`);
  }
  const ac = new AbortController();
  /** True once this waiter has abandoned the open (timeout or outer abort). */
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abortWait = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Always observe abortWait: abandon may reject it after the race has
  // already settled (or if open() throws before race).
  void abortWait.catch(() => {});
  const abandon = (error: Error): void => {
    if (abandoned) return;
    abandoned = true;
    ac.abort();
    rejectAbort?.(error);
  };
  const onOuterAbort = (): void => {
    abandon(new Error(`${label} aborted`));
  };
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let pending: Promise<TMuseHost>;
    try {
      pending = open(ac.signal);
    } catch (error) {
      abandoned = true;
      throw error;
    }
    void pending.then(
      (host) => {
        if (abandoned) void host.close().catch(() => {});
      },
      () => {},
    );
    // Timeout and outer abort both settle `abortWait` via `abandon` — one
    // rejection channel, no double-reject after the race has finished.
    timer = setTimeout(() => {
      abandon(new Error(`${label} timed out`));
    }, ms);
    return await Promise.race([pending, abortWait]);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
};

const assertMuseSessionPolicy = (observed: TMuseSessionRead): void => {
  // Fail closed when the host reports an approval mode that is not our
  // requested onRequest policy. Absent mode (older hosts / fakes) is
  // tolerated only when the startSession call already requested it.
  if (
    observed.approvalMode !== undefined &&
    observed.approvalMode !== null &&
    observed.approvalMode !== MUSE_APPROVAL_MODE
  ) {
    throw new Error(
      `Muse effective approval mode is ${observed.approvalMode}, expected ${MUSE_APPROVAL_MODE}`,
    );
  }
};

const assertMuseSessionModel = (
  session: TMuseSession,
  observed: TMuseSessionRead,
  modelId: string,
  providerId: string | undefined,
): void => {
  if (observed.sessionId !== session.sessionId) {
    throw new Error(
      "Muse did not confirm the requested session; no turn was started",
    );
  }
  if (observed.modelId !== modelId) {
    throw new Error(
      "Muse did not confirm the requested model/provider; no turn was started",
    );
  }
  if (providerId !== undefined && observed.providerId !== providerId) {
    throw new Error(
      "Muse did not confirm the requested model/provider; no turn was started",
    );
  }
};

const sessionAlreadyExact = (
  session: TMuseSession,
  observed: TMuseSessionRead,
  modelId: string,
  providerId: string | undefined,
): boolean => {
  if (observed.sessionId !== session.sessionId) return false;
  if (observed.modelId !== modelId) return false;
  if (providerId !== undefined && observed.providerId !== providerId) {
    return false;
  }
  return true;
};

type TMuseFirstOutputOutcome =
  | "success"
  | "failure"
  | "timeout"
  | "aborted"
  | "declined";

type TMusePhaseMarks = {
  readonly startedAt: number;
  spawnStartedAt: number | null;
  hostReadyAt: number | null;
  sessionReadyAt: number | null;
  modelVerifiedAt: number | null;
  turnSubmittedAt: number | null;
  firstOutputAt: number | null;
  emitted: boolean;
};

let musePhaseNowImpl: () => number = (): number => performance.now();

/** Test-only: replace the phase clock. Production always uses performance.now. */
export const setMusePhaseClockForTests = (fn: (() => number) | null): void => {
  musePhaseNowImpl = fn ?? ((): number => performance.now());
};

const musePhaseNow = (): number => musePhaseNowImpl();

const musePhaseMs = (from: number, to: number): number =>
  Math.max(0, Math.round((to - from) * 1000) / 1000);

const createMusePhaseMarks = (): TMusePhaseMarks => ({
  startedAt: musePhaseNow(),
  spawnStartedAt: null,
  hostReadyAt: null,
  sessionReadyAt: null,
  modelVerifiedAt: null,
  turnSubmittedAt: null,
  firstOutputAt: null,
  emitted: false,
});

/**
 * Metadata-only phase timings. Numbers + closed outcome only — never prompt,
 * tokens, credentials, or model ids.
 *
 * Semantics (performance.now deltas):
 *   - setup_ms: entry → immediately before host factory (MCP/overlay prep)
 *   - spawn_init_ms: host factory start → host ready (SDK spawn/init only)
 *   - session_ms: host ready → session/start settled
 *   - model_verify_ms: session ready → model+policy confirm settled
 *   - turn_submit_ms: model verified → turn/start ACK
 *   - generation_wait_ms: turn ACK → first actual output (optional)
 *   - first_output_ms / ttft_ms: entry → first actual output (request TTFT)
 *   - elapsed_ms: entry → first output or terminal non-output end
 */
const emitMusePhaseTimings = (
  marks: TMusePhaseMarks,
  firstOutputOutcome: TMuseFirstOutputOutcome,
): void => {
  if (marks.emitted) return;
  marks.emitted = true;
  const endedAt = marks.firstOutputAt ?? musePhaseNow();
  const setupMs =
    marks.spawnStartedAt === null
      ? undefined
      : musePhaseMs(marks.startedAt, marks.spawnStartedAt);
  const spawnInitMs =
    marks.spawnStartedAt === null || marks.hostReadyAt === null
      ? undefined
      : musePhaseMs(marks.spawnStartedAt, marks.hostReadyAt);
  const sessionMs =
    marks.hostReadyAt === null || marks.sessionReadyAt === null
      ? undefined
      : musePhaseMs(marks.hostReadyAt, marks.sessionReadyAt);
  const modelVerifyMs =
    marks.sessionReadyAt === null || marks.modelVerifiedAt === null
      ? undefined
      : musePhaseMs(marks.sessionReadyAt, marks.modelVerifiedAt);
  const turnSubmitMs =
    marks.modelVerifiedAt === null || marks.turnSubmittedAt === null
      ? undefined
      : musePhaseMs(marks.modelVerifiedAt, marks.turnSubmittedAt);
  const generationWaitMs =
    marks.turnSubmittedAt === null || marks.firstOutputAt === null
      ? undefined
      : musePhaseMs(marks.turnSubmittedAt, marks.firstOutputAt);
  const ttftMs =
    marks.firstOutputAt === null
      ? undefined
      : musePhaseMs(marks.startedAt, marks.firstOutputAt);
  const elapsedMs = musePhaseMs(marks.startedAt, endedAt);
  logInfo(
    "native-runtime",
    safeDiagnosticMessage`muse native turn phase timings`,
    {
      provider: "muse",
      clock: "performance.now",
      first_output_outcome: firstOutputOutcome,
      ...(setupMs !== undefined ? { setup_ms: setupMs } : {}),
      ...(spawnInitMs !== undefined ? { spawn_init_ms: spawnInitMs } : {}),
      ...(sessionMs !== undefined ? { session_ms: sessionMs } : {}),
      ...(modelVerifyMs !== undefined
        ? { model_verify_ms: modelVerifyMs }
        : {}),
      ...(turnSubmitMs !== undefined ? { turn_submit_ms: turnSubmitMs } : {}),
      ...(generationWaitMs !== undefined
        ? { generation_wait_ms: generationWaitMs }
        : {}),
      ...(ttftMs !== undefined
        ? { first_output_ms: ttftMs, ttft_ms: ttftMs }
        : {}),
      elapsed_ms: elapsedMs,
    },
    {
      provider: "muse",
      timings: {
        elapsed_ms: elapsedMs,
        ...(spawnInitMs !== undefined ? { spawn_elapsed_ms: spawnInitMs } : {}),
      },
    },
  );
};

/**
 * Read-first exact model+policy gate. Calls `setModel` only when the live
 * session read disagrees, then re-reads and fails closed. Never starts a turn
 * on mismatch.
 */
const confirmExactModelAndPolicy = async (
  session: TMuseSession,
  modelId: string,
  providerId: string | undefined,
): Promise<void> => {
  const first = await session.read();
  assertMuseSessionPolicy(first);
  if (sessionAlreadyExact(session, first, modelId, providerId)) {
    return;
  }
  // Session-id mismatch cannot be repaired via setModel — fail closed.
  if (first.sessionId !== session.sessionId) {
    throw new Error(
      "Muse did not confirm the requested session; no turn was started",
    );
  }
  await session.setModel({
    modelId,
    ...(providerId !== undefined ? { providerId } : {}),
  });
  const observed = await session.read();
  assertMuseSessionModel(session, observed, modelId, providerId);
  assertMuseSessionPolicy(observed);
};

/** Feed the auth-owned passive cache from authentic native model ids. */
const rememberObservedMuseModels = (
  models: ReadonlyArray<TProviderModelEntry>,
  generation: number,
  noteAuthenticated = true,
): ReadonlyArray<TProviderModelEntry> => {
  if (models.length === 0) return models;
  // Cache/auth-note require a live store fingerprint; still return the native
  // rows to the demand caller when the store is absent (tests / pre-login).
  const fingerprint = museNativeModelFingerprint();
  if (fingerprint !== null) {
    rememberMuseNativeModels({
      fingerprint,
      accountHint: null,
      generation,
      models,
    });
    // Connect verification may suppress this so the owner can note only
    // AFTER epoch/signal fencing (see listMuseModelsDemand.noteAuthenticated).
    if (noteAuthenticated) {
      noteMuseAuthenticatedSession({ fingerprint });
    }
  }
  return models;
};

/**
 * Feed the auth-owned passive cache from a live MSP model/list snapshot.
 * Skips `session.listModels` when the existing fingerprint+generation-scoped
 * cache from {@link readMuseNativeModels} is still valid (TTL + auth
 * invalidation already enforced there). Never invents a second cache or
 * performs background auth work.
 */
export const rememberMuseModelsFromSession = async (
  session: TMuseSession,
  generation: number,
): Promise<ReadonlyArray<TProviderModelEntry>> => {
  const fingerprint = museNativeModelFingerprint();
  if (fingerprint !== null) {
    const cached = readMuseNativeModels({
      fingerprint,
      accountHint: null,
    });
    // Generation + TTL + live fingerprint are enforced inside
    // readMuseNativeModels; a hit means no session.model/list spawn.
    if (cached !== null && cached.length > 0) return cached;
  }
  let models: ReadonlyArray<TProviderModelEntry> = [];
  try {
    models = await session.listModels();
  } catch (error) {
    logWarn(
      "native-runtime",
      safeDiagnosticMessage`muse model/list failed; skipping observation`,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }
  return rememberObservedMuseModels(models, generation);
};

export type TListMuseModelsDemandParams = {
  readonly bin?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly hostFactory?: TMuseHostFactory;
  readonly cwd?: string;
  /**
   * When true (default), a successful list also calls
   * {@link noteMuseAuthenticatedSession}. Connect / login-exit verification
   * should pass `false` and commit the auth note itself only after its
   * epoch/signal fence — otherwise a late list can race logout/rotate.
   */
  readonly noteAuthenticated?: boolean;
};

export type TMuseTurnDirs = {
  readonly turnRoot: string;
  readonly workspaceRoot: string;
  readonly runtimeParent: string;
};

export type TAllocateMuseTurnDirsOptions = {
  /** Test seam for synthetic mkdir failures — production omits this. */
  readonly mkdir?: typeof mkdir;
};

/**
 * Unique turn root with `workspace/` + `runtime/` leaves. Mirrors
 * {@link createMuseExecutionOverlay}: any failure after `mkdtemp` removes the
 * partial turn root. Never deletes `parent` (caller-owned cwd).
 */
export const allocateMuseTurnDirs = async (
  parent: string,
  prefix: string,
  options: TAllocateMuseTurnDirsOptions = {},
): Promise<TMuseTurnDirs> => {
  const doMkdir = options.mkdir ?? mkdir;
  const turnRoot = await mkdtemp(join(parent, prefix));
  try {
    const workspaceRoot = join(turnRoot, "workspace");
    const runtimeParent = join(turnRoot, "runtime");
    await doMkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await doMkdir(runtimeParent, { recursive: true, mode: 0o700 });
    return { turnRoot, workspaceRoot, runtimeParent };
  } catch (error) {
    await rm(turnRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Demand-driven MSP `model/list` for the Muse delegate. Strips metered-key
 * overrides, uses a fresh HOME overlay with auth-only symlink, never claims
 * entitlement/quota. Returns admitted catalog-exact rows, or `null` when the
 * binary/auth/host path cannot produce a list.
 */
export const listMuseModelsDemand = async (
  params: TListMuseModelsDemandParams = {},
): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
  if (params.signal?.aborted) return null;
  const bin = params.bin ?? cliBin("muse");
  if (!existsSync(bin)) return null;
  const generation = museNativeModelGeneration();
  const baseEnv = params.env ?? cliEnv("muse");
  // Auth overlay must stay OUTSIDE workspaceRoot (known-safe reads).
  // Always allocate a unique turn root — even under params.cwd — so parallel
  // tests sharing a parent directory cannot collide on workspace/runtime.
  let turnRoot: string | undefined;
  let overlay: TMuseOverlay | null = null;
  let host: TMuseHost | null = null;
  try {
    const dirs = await allocateMuseTurnDirs(
      params.cwd ?? (spawnCwd(baseEnv) || tmpdir()),
      "muse-models-",
    );
    turnRoot = dirs.turnRoot;
    overlay = await createMuseExecutionOverlay({
      baseEnv,
      mcp: null,
      parentDir: dirs.runtimeParent,
    });
    const env: NodeJS.ProcessEnv = {
      ...cleanMuseSpawnEnv(baseEnv),
      ...overlay.env,
    };
    const spawn = wrapMuseServeSpawn(bin);
    const hostFactory = params.hostFactory ?? defaultMuseHostFactory;
    host = await openMuseHostWithTimeout(
      (signal) =>
        hostFactory({
          command: spawn.command,
          args: spawn.args,
          cwd: dirs.workspaceRoot,
          env,
          signal,
        }),
      MUSE_RPC_TIMEOUT_MS,
      "muse model/list spawn",
      params.signal,
    );
    if (params.signal?.aborted) return null;
    const models = await withTimeout(
      host.listModels(),
      MUSE_RPC_TIMEOUT_MS,
      "muse model/list",
    );
    // Re-check after the await so a cancel during listModels cannot still
    // cache/note auth evidence for a stale connect verification.
    if (params.signal?.aborted) return null;
    const observed = rememberObservedMuseModels(
      models,
      generation,
      params.noteAuthenticated !== false,
    );
    return observed.length > 0 ? observed : [];
  } catch (error) {
    logWarn(
      "native-runtime",
      safeDiagnosticMessage`muse demand model/list failed`,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  } finally {
    if (host !== null) await host.close().catch(() => {});
    if (overlay !== null) await overlay.cleanup().catch(() => {});
    if (turnRoot !== undefined) {
      await rm(turnRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
};
/**
 * Lifecycle hooks a caller (bridge or capture) may attach to
 * {@link openMuseTurnSession}. All optional; a hook that is omitted is simply
 * never invoked. `onToolCall` args mirror the MCP server's own callback
 * signature — the caller decides what a tool call means for its turn.
 */
export type TMuseTurnSessionHooks = {
  readonly onToolCall?: (name: string, args: Record<string, unknown>) => void;
  readonly onStderr?: (chunk: string) => void;
  /** Fires immediately before the SDK host factory is invoked (setup done). */
  readonly onBeforeHostOpen?: () => void;
  /** Fires once the host handshake has settled. */
  readonly onHostReady?: () => void;
  /** Fires once `session/start` has settled. */
  readonly onSessionReady?: () => void;
};

export type TOpenMuseTurnSessionOptions = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly providerId?: string;
  /** Caller function tools exposed via the per-request loopback MCP server. */
  readonly tools?: ReadonlyArray<TMuseCallerTool>;
  readonly signal: AbortSignal;
  readonly rpcTimeoutMs?: number;
  readonly hostFactory?: TMuseHostFactory;
  readonly cwd?: string;
  /** `mkdtemp` prefix — distinguishes bridge (`muse-turn-`) from capture (`muse-capture-`) turn roots. */
  readonly dirPrefix: string;
  /**
   * Bridge-capture-only Meta endpoint redirect. Never set by the default
   * (non-capture) bridge path — see `createMuseExecutionOverlay`.
   */
  readonly endpointTransport?: {
    readonly base_url: string;
    readonly auth: "bearer";
  };
  /** Bridge-capture-only server-executed search folding. Never set by the default bridge path. */
  readonly webSearchMode?: TMuseWebSearchMode;
  /**
   * Extra env merged in AFTER the overlay env (e.g. capture's private
   * proxy-hop guard). Receives the per-turn MCP server URL, or `null` when no
   * caller tools were registered for this turn.
   */
  readonly extraEnv?: (mcpServerUrl: string | null) => Record<string, string>;
  /**
   * Post-composition env guard (e.g. capture's Keychain-safety assertion).
   * Throwing here fails setup exactly like any other setup step, via the
   * same partial-cleanup path.
   */
  readonly assertEnv?: (env: NodeJS.ProcessEnv) => void;
  readonly hooks?: TMuseTurnSessionHooks;
};

export type TMuseTurnSessionResult = {
  readonly dirs: TMuseTurnDirs;
  readonly host: TMuseHost;
  readonly session: TMuseSession;
  /** `null` when the turn registered no caller tools. */
  readonly mcp: TMuseMcpServer | null;
  readonly callerToolNameMap: TMuseToolNameMap;
  /**
   * Idempotent, deterministic-order teardown: `host.close` → `mcp.stop` →
   * `overlay.cleanup` → `rm(turnRoot)`. Every step is independently
   * null-guarded and swallows its own error, so an earlier failure never
   * blocks a later step. Safe to call more than once (a no-op after the
   * first call) and safe to call after a partial setup failure — this is the
   * SAME function `openMuseTurnSession` calls internally when a later setup
   * step throws.
   */
  cleanup(): Promise<void>;
};

/**
 * Provider-owned session/lifecycle opener shared by the default (non-capture)
 * bridge (`runMuseNative`) and bridge-capture (`runMuseNativeCapture`):
 * allocate the turn's temp dirs, optionally start the per-turn caller-tool MCP
 * server, build the isolated execution overlay, compose the spawn env, open
 * the SDK host under a deadline, and start the session with exact ids.
 *
 * Deliberately narrow and provider-owned, not a generic native-runtime
 * framework: callers still own everything AFTER a session exists — sending
 * the turn, model+policy confirmation, approval policy, item/delta pumping,
 * and turn cancellation/settlement all differ between the bridge and capture
 * transports and stay in their own files.
 *
 * On any setup failure (dir alloc, MCP start, overlay build, env assertion,
 * host spawn/handshake, or `session/start`), whatever was already allocated
 * is torn down via {@link TMuseTurnSessionResult.cleanup} — in the same
 * deterministic order a normal caller-driven close uses — before the error is
 * rethrown. Callers therefore never need to hand-manage host/mcp/overlay/dir
 * cleanup for a setup failure; they only still own cancelling their own
 * in-flight turn once one exists.
 */
/**
 * Race `work` against a deadline AND the given abort signal. Unlike
 * {@link withTimeout}, an outer abort rejects immediately — it does not wait
 * out `work` on its own, since a pending RPC (e.g. `session/start`) may never
 * settle by itself once its connection is torn down from under it. `work` is
 * always observed (a `.catch` is attached up front) so an abandoned
 * rejection can never surface as an unhandled rejection once this race has
 * already settled via timeout or abort.
 */
const withAbortableSetupTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  label: string,
  signal: AbortSignal,
): Promise<T> => {
  void work.catch(() => {});
  if (signal.aborted) {
    throw new Error(`${label} aborted`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        onAbort = () => reject(new Error(`${label} aborted`));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

export const openMuseTurnSession = async (
  options: TOpenMuseTurnSessionOptions,
): Promise<TMuseTurnSessionResult> => {
  const rpcTimeoutMs = options.rpcTimeoutMs ?? MUSE_RPC_TIMEOUT_MS;
  const hostFactory = options.hostFactory ?? defaultMuseHostFactory;

  let turnRoot: string | undefined;
  let mcp: TMuseMcpServer | null = null;
  let overlay: TMuseOverlay | null = null;
  let host: TMuseHost | null = null;

  // A CHAIN, not a cached single promise: every call to `cleanup()` appends
  // a fresh drain pass that re-reads whatever is CURRENTLY assigned to
  // host/mcp/overlay/turnRoot at the time it actually runs, serialized after
  // any prior pass. This is what makes cleanup both idempotent (each pass
  // finds already-nulled fields and is a no-op) AND correct under a "late
  // completion race" — a resource that finishes allocating (overlay build,
  // host open) strictly AFTER an earlier cleanup() call already returned is
  // still picked up by the NEXT drain pass, rather than being silently
  // stranded because cleanup had already been "used up" once.
  let cleanupChain: Promise<void> = Promise.resolve();
  const cleanup = (): Promise<void> => {
    cleanupChain = cleanupChain.then(async () => {
      if (host !== null) {
        const closing = host;
        host = null;
        await closing.close().catch(() => {});
      }
      if (mcp !== null) {
        const stopping = mcp;
        mcp = null;
        try {
          stopping.stop();
        } catch {
          // already stopped
        }
      }
      if (overlay !== null) {
        const disposing = overlay;
        overlay = null;
        await disposing.cleanup().catch(() => {});
      }
      if (turnRoot !== undefined) {
        const root = turnRoot;
        turnRoot = undefined;
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    });
    return cleanupChain;
  };

  // Abort during setup must close/dispose promptly — it must not wait out a
  // pending RPC (e.g. session/start) on its own, and it must not leave any
  // resource allocated AFTER the abort fired undisposed. This listener fires
  // `cleanup()` immediately on abort regardless of which await is currently
  // in flight; the explicit `if (options.signal.aborted)` checks below (one
  // after every resource-acquiring await) additionally stop the setup from
  // doing any FURTHER work once aborted, and each schedules one more drain
  // pass so a resource that finished allocating in the same tick this check
  // runs is still caught.
  const onAbort = (): void => {
    void cleanup();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const abortedError = (): Error => new Error("muse turn session aborted");

  try {
    if (options.signal.aborted) throw abortedError();
    // Caller resolves its own cwd fallback (the bridge and capture paths
    // disagree: the bridge falls back through `spawnCwd(env)` before
    // `tmpdir()`, capture goes straight to `tmpdir()`) — this helper only
    // ever allocates under whatever `options.cwd` it is handed.
    const dirs = await allocateMuseTurnDirs(
      options.cwd ?? tmpdir(),
      options.dirPrefix,
    );
    turnRoot = dirs.turnRoot;
    if (options.signal.aborted) {
      await cleanup();
      throw abortedError();
    }

    const callerToolNameMap = buildMuseToolNameMap(options.tools ?? []);
    if ((options.tools?.length ?? 0) > 0) {
      mcp = startMuseMcpServer({
        tools: options.tools ?? [],
        onToolCall: (name, args) => options.hooks?.onToolCall?.(name, args),
      });
    }
    if (options.signal.aborted) {
      await cleanup();
      throw abortedError();
    }

    overlay = await createMuseExecutionOverlay({
      baseEnv: options.env,
      mcp,
      modelId: options.providerModelId,
      ...(options.providerId !== undefined
        ? { providerId: options.providerId }
        : {}),
      ...(options.endpointTransport !== undefined
        ? { endpointTransport: options.endpointTransport }
        : {}),
      ...(options.webSearchMode !== undefined
        ? { webSearchMode: options.webSearchMode }
        : {}),
      parentDir: dirs.runtimeParent,
    });
    if (options.signal.aborted) {
      await cleanup();
      throw abortedError();
    }

    const env: NodeJS.ProcessEnv = {
      ...cleanMuseSpawnEnv(options.env),
      ...overlay.env,
      ...(options.extraEnv?.(mcp?.url ?? null) ?? {}),
    };
    options.assertEnv?.(env);

    const spawn = wrapMuseServeSpawn(options.bin);
    options.hooks?.onBeforeHostOpen?.();
    // `openMuseHostWithTimeout` is already abort-aware: it aborts the spawn
    // signal and closes any host that resolves late once abandoned — no
    // separate late-completion handling needed here for the host itself.
    host = await openMuseHostWithTimeout(
      (signal) =>
        hostFactory({
          command: spawn.command,
          args: spawn.args,
          cwd: dirs.workspaceRoot,
          env,
          signal,
          ...(options.hooks?.onStderr !== undefined
            ? { onStderr: options.hooks.onStderr }
            : {}),
        }),
      rpcTimeoutMs,
      "muse SDK spawn",
      options.signal,
    );
    options.hooks?.onHostReady?.();
    if (options.signal.aborted) {
      await cleanup();
      throw abortedError();
    }

    const session = await withAbortableSetupTimeout(
      host.startSession({
        sessionId: Bun.randomUUIDv7(),
        workspaceRoot: dirs.workspaceRoot,
        modelId: options.providerModelId,
        ...(options.providerId !== undefined
          ? { providerId: options.providerId }
          : {}),
        approvalMode: MUSE_APPROVAL_MODE,
      }),
      rpcTimeoutMs,
      "muse session/start",
      options.signal,
    );
    options.hooks?.onSessionReady?.();

    options.signal.removeEventListener("abort", onAbort);
    return { dirs, host, session, mcp, callerToolNameMap, cleanup };
  } catch (error) {
    options.signal.removeEventListener("abort", onAbort);
    await cleanup();
    throw error;
  }
};

/**
 * Run one cold Muse turn through the official SDK surface. Commit-on-first
 * output; every pre-commit failure declines. The child / host is closed on
 * completion, abort, setup-RPC timeout, and pre-commit silence. After the
 * first committed output there is no absolute wall-clock turn cutoff —
 * EOF waits on authoritative `turn.completed` + item/delta drain (or
 * client/stream cancel / caller-tool handoff).
 */
export const runMuseNative = async (
  params: TMuseNativeParams,
): Promise<TNativeRunResult> => {
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "muse CLI not installed" };
  }
  if (params.parts.length === 0) {
    return {
      kind: "declined",
      reason: "prompt contains no text or image content",
    };
  }

  // Entry clock after invalid-request declines — setup includes turn-root
  // prep, MCP, and overlay before the SDK host factory.
  const phaseMarks = createMusePhaseMarks();
  // Split layout (enforced by `openMuseTurnSession`): workspaceRoot (session
  // cwd) NEVER contains the auth overlay HOME. Known-safe workspace reads
  // therefore cannot reach the auth symlink by a workspace-relative path.
  // Absolute-path reads of HOME remain a residual host-policy risk (see file
  // header).
  const rpcTimeoutMs = params.rpcTimeoutMs ?? MUSE_RPC_TIMEOUT_MS;
  const observationGeneration = museNativeModelGeneration();
  const turn = createMuseTurnState({
    providerModelId: params.providerModelId,
  });
  const noteFirstOutputSuccess = (): void => {
    if (phaseMarks.firstOutputAt !== null) return;
    if (!turn.sawOutput()) return;
    phaseMarks.firstOutputAt = musePhaseNow();
    emitMusePhaseTimings(phaseMarks, "success");
  };

  type TQueueItem = TChatCompletionChunk | "end" | { readonly error: Error };
  const queue: Array<TQueueItem> = [];
  let wake: (() => void) | null = null;
  const push = (item: TQueueItem): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  let ended = false;
  const endWith = (chunks: ReadonlyArray<TChatCompletionChunk>): void => {
    if (ended) return;
    ended = true;
    for (const chunk of chunks) push(chunk);
    push("end");
  };
  /** Post-commit non-moderation failure: error the stream, do not finish ok. */
  const failStream = (error: Error): void => {
    if (ended) return;
    ended = true;
    push({ error });
  };

  let session: TMuseSession | null = null;
  let activeTurn: TMuseTurn | null = null;
  let sessionHandle: TMuseTurnSessionResult | null = null;

  const cleanup = async (): Promise<void> => {
    params.signal.removeEventListener("abort", abort);
    if (activeTurn !== null) {
      await activeTurn.cancel().catch(() => {});
      activeTurn = null;
    }
    if (sessionHandle !== null) {
      const closing = sessionHandle;
      sessionHandle = null;
      await closing.cleanup();
    }
  };

  const abort = (): void => {
    void cleanup();
    if (ended) return;
    if (turn.sawOutput()) {
      noteFirstOutputSuccess();
      endWith(turn.finish("cancelled"));
      return;
    }
    emitMusePhaseTimings(phaseMarks, "aborted");
    ended = true;
    push("end");
  };
  params.signal.addEventListener("abort", abort, { once: true });

  try {
    // OUR OWN registered caller/MCP tools, in BOTH the bare form and Meta's
    // observed MCP wire form (`mcp__openllm_muse_client_tools.<leaf>`) —
    // built by the SAME shared helper the return-side tool-name mapping
    // already uses, over the SAME `params.tools` this turn registers, so
    // approval matching verifies against our OWN server's real prefix
    // rather than guessing or accepting an arbitrary name. Approving only
    // lets the turn proceed to OUR loopback MCP server (which immediately
    // ends the turn via `onToolCall` below), never native execution. See
    // `decideMuseNativeApproval`/`isRegisteredCallerToolApproval` in
    // `muse-web-search.ts`.
    sessionHandle = await openMuseTurnSession({
      bin: params.bin,
      env: params.env,
      providerModelId: params.providerModelId,
      ...(params.providerId !== undefined
        ? { providerId: params.providerId }
        : {}),
      tools: params.tools ?? [],
      signal: params.signal,
      rpcTimeoutMs,
      ...(params.hostFactory !== undefined
        ? { hostFactory: params.hostFactory }
        : {}),
      cwd: params.cwd ?? (spawnCwd(params.env) || tmpdir()),
      dirPrefix: "muse-turn-",
      hooks: {
        onToolCall: (name, args) => {
          if (ended) return;
          // Capture vendor usage around cancellation when the fold already
          // holds a session/tokenUsage notification.
          const usage = session?.lastUsage();
          if (usage !== undefined) turn.observeUsage(usage);
          endWith(turn.emitToolCall(name, args));
          noteFirstOutputSuccess();
          void activeTurn?.cancel().catch(() => {});
        },
        onStderr: (chunk) => {
          const trimmed = chunk.trim();
          if (trimmed.length === 0) return;
          const classified = classifyMuseStderr(trimmed);
          logWarn("native-runtime", safeDiagnosticMessage`muse-sdk stderr`, {
            code: classified.code,
            bytes: classified.bytes,
          });
        },
        // Spawn/init clock starts immediately before the host factory — MCP
        // and overlay prep belong to setup_ms, not spawn_init_ms.
        onBeforeHostOpen: () => {
          phaseMarks.spawnStartedAt = musePhaseNow();
        },
        onHostReady: () => {
          phaseMarks.hostReadyAt = musePhaseNow();
        },
        onSessionReady: () => {
          phaseMarks.sessionReadyAt = musePhaseNow();
        },
      },
    });
    session = sessionHandle.session;
    const callerToolNameMap = sessionHandle.callerToolNameMap;
    // Upgrades the session's per-session approval delegate (installed once,
    // for real, inside `wrapOfficialHost.startSession`) from the default
    // `decideNativeApproval` (web_search only) to the caller-tool-aware
    // policy for THIS turn's registered tools. This reassigns the delegate
    // the ONE real SDK callback invokes — it is not a second live SDK
    // registration, so this take effect immediately and exclusively; only
    // THIS caller (the non-capture bridge path, the one that actually
    // reaches MSP's local approval prompt for a caller-tool call; capture
    // mode never does, since it decodes the model's raw wire response
    // itself) approves our own registered caller/MCP tools.
    session.onApproval((request) =>
      decideMuseNativeApproval(request, callerToolNameMap),
    );
    await withTimeout(
      confirmExactModelAndPolicy(
        session,
        params.providerModelId,
        params.providerId,
      ),
      rpcTimeoutMs,
      "muse session model confirm",
    );
    phaseMarks.modelVerifiedAt = musePhaseNow();
    // Do NOT note authenticated on session/start alone — live evidence shows
    // Muse can open a session against an empty providers shell and only fail
    // later with turn errorKind authRequired. Auth memory is pinned by
    // non-empty model/list, login store change + configured providers, or a
    // turn that actually produced output (below).
    // Demand-driven observation for passive discoverModels — never blocks the
    // turn on failure; exact native ids only. rememberMuseModelsFromSession
    // notes auth only when model/list returns at least one model.
    void rememberMuseModelsFromSession(session, observationGeneration).catch(
      () => {},
    );
    if (params.signal.aborted) {
      emitMusePhaseTimings(phaseMarks, "aborted");
      await cleanup();
      return { kind: "declined", reason: "client aborted" };
    }
    activeTurn = await withTimeout(
      session.sendUserTurn(params.parts),
      rpcTimeoutMs,
      "muse turn/start",
    );
    phaseMarks.turnSubmittedAt = musePhaseNow();
  } catch (error) {
    emitMusePhaseTimings(
      phaseMarks,
      params.signal.aborted ? "aborted" : "declined",
    );
    await cleanup();
    return setupDecline(error, params.signal);
  }

  const emitItem = (item: TMuseFoldedItem): void => {
    const chunk = turn.handleItem(item);
    if (chunk !== null && !ended) push(chunk);
    noteFirstOutputSuccess();
  };
  const emitDelta = (delta: TMuseItemDelta): void => {
    const chunk = turn.handleDelta(delta);
    if (chunk !== null && !ended) push(chunk);
    noteFirstOutputSuccess();
  };

  const pumpItems = (async (): Promise<void> => {
    if (activeTurn === null) return;
    for await (const item of activeTurn.items()) {
      if (ended) return;
      emitItem(item);
    }
  })();
  const pumpDeltas = (async (): Promise<void> => {
    if (activeTurn === null) return;
    for await (const delta of activeTurn.deltas()) {
      if (ended) return;
      emitDelta(delta);
    }
  })();
  void pumpItems.catch((error: unknown) => {
    logError("native-runtime", safeDiagnosticMessage`muse item pump failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void pumpDeltas.catch((error: unknown) => {
    logError("native-runtime", safeDiagnosticMessage`muse delta pump failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Official SDK adapters wait for item/delta pumps AFTER turn.completed
  // (held items can still be in the iterator). Finishing on completed alone
  // drops that tail and can emit an empty terminal as the first chunk.
  // There is deliberately no absolute post-submit turn setTimeout here —
  // Claude/Codex native contract: after first output, wait for authoritative
  // completed (or client/stream cancel / caller-tool handoff).
  void (async () => {
    try {
      const outcome = await activeTurn.completed;
      if (outcome.usage !== undefined) turn.observeUsage(outcome.usage);
      else {
        const folded = session?.lastUsage();
        if (folded !== undefined) turn.observeUsage(folded);
      }
      await Promise.all([
        pumpItems.catch(() => {}),
        pumpDeltas.catch(() => {}),
      ]);
      if (ended) return;
      // Official SDK TurnOutcome (flattened): commit-on-first-output. Any
      // settled outcome with no sawOutput declines — including
      // completed/completed, omitted terminal, and tool_calls without an
      // actual emitToolCall (never invent empty stop / empty tool_calls).
      // After output, success is `kind: "completed"` with terminal completed
      // (or omitted), cancelled, or tool_calls. Client abort still finishes
      // via the abort listener (ended before this arm). `unqueued` never
      // ran; `terminalUnknown` is host-death/unknown; `terminal: "failed"`
      // (+ `error`) is a mid-turn / launch failure on the completed arm.
      const terminal = outcome.terminal;
      if (!turn.sawOutput()) {
        const reason = museTurnDeclineReason(outcome);
        logWarn(
          "native-runtime",
          safeDiagnosticMessage`muse turn declined before output`,
          {
            code: "muse_turn_declined_before_output",
            outcomeKind: outcome.kind,
            ...(terminal !== undefined ? { terminal } : {}),
            ...(outcome.error?.kind !== undefined
              ? { errorKind: outcome.error.kind }
              : {}),
            ...(outcome.launchFailure === true ? { launchFailure: true } : {}),
          },
        );
        // Host-authored authRequired means memory verification (if any) was
        // false evidence — drop it so /providers cannot stay "connected".
        if (outcome.error?.kind === "authRequired") {
          clearMuseStatusObservationCache();
        }
        emitMusePhaseTimings(phaseMarks, "failure");
        ended = true;
        push({ error: new Error(reason) });
        void cleanup();
        return;
      }
      const acknowledgedSuccess =
        outcome.kind === "completed" &&
        (terminal === undefined ||
          terminal === "completed" ||
          terminal === "cancelled" ||
          terminal === "tool_calls");
      if (!acknowledgedSuccess) {
        const parts: string[] = [outcome.kind];
        if (terminal !== undefined) parts.push(terminal);
        if (outcome.error?.kind !== undefined) parts.push(outcome.error.kind);
        noteFirstOutputSuccess();
        failStream(
          new Error(
            `muse turn ended without acknowledged success (${parts.join("/")})`,
          ),
        );
        void cleanup();
        return;
      }
      noteFirstOutputSuccess();
      endWith(turn.finish(terminal ?? "completed"));
      void cleanup();
    } catch (error: unknown) {
      // Do not join item/delta pumps here. `completed` already rejected, so a
      // hung iterator (or one that ignores cancel) would stall failStream
      // forever. Pumps are already observed via the void .catch above; cancel
      // via cleanup and surface the host error immediately.
      if (ended) {
        void cleanup();
        return;
      }
      const folded = session?.lastUsage();
      if (folded !== undefined) turn.observeUsage(folded);
      const err = error instanceof Error ? error : new Error(String(error));
      logError(
        "native-runtime",
        safeDiagnosticMessage`muse turn failed after start`,
        {
          code: "muse_turn_failed_after_start",
          error: err.message.slice(0, MUSE_TURN_ERROR_MESSAGE_MAX),
        },
      );
      if (turn.sawOutput()) {
        noteFirstOutputSuccess();
        failStream(err);
      } else {
        emitMusePhaseTimings(phaseMarks, "failure");
        ended = true;
        push({ error: err });
      }
      void cleanup();
    }
  })();

  const nextItem = async (): Promise<TQueueItem> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  // One pending nextItem across pre-commit retries. Calling nextItem() again
  // after a timeout&&sawOutput continue can orphan a read that already claimed
  // the first chunk (Promise.race surfaced timeout while the item arm settled).
  let first: TQueueItem | "timeout";
  const pendingFirst = nextItem();
  for (;;) {
    let precommitTimer: ReturnType<typeof setTimeout> | undefined;
    first = await Promise.race([
      pendingFirst,
      new Promise<"timeout">((resolve) => {
        precommitTimer = setTimeout(
          () => resolve("timeout"),
          params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(precommitTimer);
    if (first === "timeout" && turn.sawOutput()) continue;
    break;
  }
  if (
    first === "timeout" ||
    first === "end" ||
    (typeof first === "object" && first !== null && "error" in first)
  ) {
    emitMusePhaseTimings(
      phaseMarks,
      first === "timeout"
        ? "timeout"
        : params.signal.aborted
          ? "aborted"
          : "failure",
    );
    await cleanup();
    const reason =
      first === "timeout"
        ? "muse SDK produced no output before the pre-commit deadline"
        : params.signal.aborted
          ? "client aborted"
          : typeof first === "object" && first !== null && "error" in first
            ? first.error.message
            : "muse turn ended before producing output";
    return {
      kind: "declined",
      reason,
      ...(params.signal.aborted ? {} : {}),
    };
  }
  noteFirstOutputSuccess();

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const next = await nextItem();
      if (next === "end") {
        controller.close();
        await cleanup();
        return;
      }
      if (typeof next === "object" && next !== null && "error" in next) {
        controller.error(next.error);
        await cleanup();
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      abort();
    },
  });
  return { kind: "committed", chunks, sessionId: () => null };
};
