/**
 * Claude Code TOOL-bearing request-capture (P1/P2).
 *
 * Extends the text Messages loopback capture so caller function tools are
 * registered as in-process MCP schemas (same `mcp__openllm__*` naming as
 * `claude-tool-session.ts`) while their handlers stay **inert** — capture
 * intercepts the vendor Messages POST before any tool execution, the daemon
 * alone consumes the true upstream response, and the builder is settled
 * locally (interrupt / HTTP 204). MCP registration is schema surface only;
 * runtime tool execution is never the capture boundary.
 *
 * Multi-turn tool/reasoning history:
 *   - Shared planner (`captureAwareHistoryBuilderPlan`) refuses silent
 *     `renderSeed` loss of tool IDs / reasoning.
 *   - Hermetic fixture builders may emit exact Anthropic `messages[]` from
 *     {@link anthropicMessagesFromHistoryTurns} (`fixture_messages` feed).
 *   - Production `sdk_session_resume`: write a synthetic Claude session JSONL
 *     (daemon-owned assistant tool_use + caller tool_result) under the
 *     isolated config dir, then Agent SDK `resume`. Direct AsyncIterable
 *     assistant-role MessageParam inject is rejected by the real CLI.
 *
 * Integration wires this adapter when `bridge-capture` is selected for tools.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  TChatCompletionChunk,
  TChatCompletionRequest,
  TToolCall,
} from "@openllmsh/protocol";
import { z } from "zod";
import { spawnCwd } from "../delegation/util";
import { logError, safeDiagnosticMessage } from "../logger";
import type { TClaudeCaptureInferenceGate } from "./claude-capture";
import {
  chunksFromCapturedAnthropicResponse,
  claudeCaptureDestinationPolicy,
  startClaudeCaptureLoopback,
  withClaudeCaptureBaseUrl,
} from "./claude-capture";
import {
  CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS,
  CLAUDE_SDK_STRUCTURED_HISTORY_STATUS,
  CLAUDE_SESSION_RESUME_HISTORY_STATUS,
  CLAUDE_TOOL_CAPTURE_STATUS,
} from "./claude-tool-capture-status";

export type { TClaudeToolCaptureStatus } from "./claude-tool-capture-status";
export {
  CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS,
  CLAUDE_SDK_STRUCTURED_HISTORY_STATUS,
  CLAUDE_SESSION_RESUME_HISTORY_STATUS,
  CLAUDE_TOOL_CAPTURE_STATUS,
} from "./claude-tool-capture-status";

import {
  buildClaudeToolSdkOptionsBase,
  claudeToolResumeAndSystemPromptOptions,
} from "./claude-tool-sdk-options";
import type { TClientTool } from "./claude-tool-session";
import {
  CLAUDE_MCP_TOOL_PREFIX,
  sanitizeClaudeMcpToolName,
} from "./claude-tool-session";
import type {
  TBuilderSettlement,
  TCapturedDispatchSender,
  TCapturedRequestEnvelope,
  TCaptureTerminalOutcome,
  TRunCapturedDispatchResult,
} from "./request-capture";
import {
  createRequestCaptureSession,
  runCapturedDispatch,
} from "./request-capture";
import type { TCaptureHistoryBuilderPlan } from "./request-capture-history";
import {
  captureAwareHistoryBuilderPlan,
  historyStructuredArtifacts,
} from "./request-capture-history";
import type { TCaptureDirectOutput } from "./request-capture-output";
import {
  CAPTURE_INTERRUPT_ORDER,
  captureDirectOutputFailure,
  inventoryToolCallsFromChunks,
  publishCapturedDirectOutput,
  requireCaptureTerminalFinishReason,
} from "./request-capture-output";
import type {
  TCaptureOwnership,
  TNativeHistoryTurn,
  TNativeRunResult,
} from "./types";
import {
  cleanNativeSpawnEnv,
  PRE_COMMIT_TIMEOUT_MS,
  unsupportedNativeControl,
} from "./types";

/** Re-export for callers that only import the tool-capture module. */
export { CLAUDE_MCP_TOOL_PREFIX, sanitizeClaudeMcpToolName };

/** Live Agent-SDK structured history inject — NOT proven. */
/** Fixed session title so the SDK skips automatic title-generation Messages. */
export const CLAUDE_TOOL_CAPTURE_SESSION_TITLE = "openllm-bridge-capture";

/**
 * Classify a loopback `/v1/messages` body for tool capture.
 *
 * Main inference must declare at least one registered caller MCP tool name
 * (`mcp__openllm__…`). Session-title / background Messages posts typically
 * omit tools (live failure captured title JSON as the "answer") — those are
 * auxiliary and must not become the daemon envelope.
 */
export type TClaudeToolCaptureMessagesClass =
  | "main_caller_tools"
  | "auxiliary"
  | "malformed";

export const classifyClaudeToolCaptureMessagesBody = (args: {
  readonly body: Uint8Array | null;
  readonly providerModelId: string;
  readonly expectedMcpToolNames: ReadonlySet<string>;
}): TClaudeToolCaptureMessagesClass => {
  if (args.body === null || args.body.byteLength === 0) return "malformed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(args.body));
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null) return "malformed";
  const row = parsed as Record<string, unknown>;
  const tools = row.tools;
  if (!Array.isArray(tools) || tools.length === 0) return "auxiliary";

  let matchedTool = false;
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && args.expectedMcpToolNames.has(name)) {
      matchedTool = true;
      break;
    }
  }
  if (!matchedTool) return "auxiliary";

  // Tool-name intersection is the load-bearing gate. Title jobs may reuse the
  // same model id; args.providerModelId is retained for callers/tests.
  void args.providerModelId;
  return "main_caller_tools";
};

export const claudeToolCaptureInferenceGate = (args: {
  readonly providerModelId: string;
  readonly expectedMcpToolNames: ReadonlySet<string>;
}): TClaudeCaptureInferenceGate => {
  return ({ envelope }) => {
    const kind = classifyClaudeToolCaptureMessagesBody({
      body: envelope.body,
      providerModelId: args.providerModelId,
      expectedMcpToolNames: args.expectedMcpToolNames,
    });
    if (kind === "main_caller_tools") return { action: "capture" };
    return {
      action: "settle_auxiliary",
      reason:
        kind === "malformed"
          ? "malformed messages body (not caller tool inference)"
          : "auxiliary messages without registered caller MCP tools (e.g. session title)",
    };
  };
};

export type TClaudeToolCaptureHistoryFeed =
  | "fixture_messages"
  | "sdk_unproven"
  | "sdk_session_resume";

export type TClaudeAnthropicMessage = {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<Record<string, unknown>>;
};

export type TClaudeToolNameMap = {
  /** Full MCP name (`mcp__openllm__…`) → original caller name. */
  readonly mcpToCaller: ReadonlyMap<string, string>;
  /** Sanitized MCP leaf → original caller name (collision-safe last-wins). */
  readonly leafToCaller: ReadonlyMap<string, string>;
};

export const buildClaudeToolNameMap = (
  tools: ReadonlyArray<TClientTool>,
): TClaudeToolNameMap => {
  const mcpToCaller = new Map<string, string>();
  const leafToCaller = new Map<string, string>();
  for (const t of tools) {
    const leaf = sanitizeClaudeMcpToolName(t.name);
    const mcp = `${CLAUDE_MCP_TOOL_PREFIX}${leaf}`;
    mcpToCaller.set(mcp, t.name);
    leafToCaller.set(leaf, t.name);
  }
  return { mcpToCaller, leafToCaller };
};

export const mapClaudeCapturedToolName = (
  upstreamName: string,
  nameMap: TClaudeToolNameMap,
): string => {
  const fromFull = nameMap.mcpToCaller.get(upstreamName);
  if (fromFull !== undefined) return fromFull;
  if (upstreamName.startsWith(CLAUDE_MCP_TOOL_PREFIX)) {
    const leaf = upstreamName.slice(CLAUDE_MCP_TOOL_PREFIX.length);
    return nameMap.leafToCaller.get(leaf) ?? leaf;
  }
  return nameMap.leafToCaller.get(upstreamName) ?? upstreamName;
};

type TZodShape = Record<string, z.ZodTypeAny>;

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

/**
 * Register caller tools as MCP schemas whose handlers MUST never execute.
 * If the vendor somehow invokes a handler (response leaked into the builder),
 * the call rejects — capture owns the response boundary, not MCP execution.
 */
export const buildInertClaudeCaptureMcpTools = (
  tools: ReadonlyArray<TClientTool>,
  opts?: { readonly onForbiddenExecution?: (name: string) => void },
): ReturnType<typeof tool>[] =>
  tools.map((t) =>
    tool(
      sanitizeClaudeMcpToolName(t.name),
      t.description ?? t.name,
      jsonSchemaToZodShape(t.parameters),
      async () => {
        opts?.onForbiddenExecution?.(t.name);
        throw new Error(
          `claude tool capture: inert MCP handler for ${t.name} must never execute`,
        );
      },
      { alwaysLoad: true },
    ),
  );

/**
 * Exact Anthropic `messages[]` from capture history turns. Preserves tool call
 * IDs, JSON arguments, roles, and tool_result linkage. Refuses reasoning
 * artifacts rather than inventing thinking/signature blocks or silently
 * dropping them (Claude Messages encoding for capture history is tool/text
 * only until a thinking-block mapping is proven).
 */
export const anthropicMessagesFromHistoryTurns = (
  turns: ReadonlyArray<TNativeHistoryTurn>,
  deltaText: string,
  nameMap: TClaudeToolNameMap,
): ReadonlyArray<TClaudeAnthropicMessage> => {
  const out: TClaudeAnthropicMessage[] = [];
  for (const turn of turns) {
    if (turn.kind === "text") {
      out.push({ role: turn.role, content: turn.text });
      continue;
    }
    if (turn.kind === "assistant_tools") {
      const hasReasoning =
        (turn.reasoningItems !== undefined && turn.reasoningItems.length > 0) ||
        (typeof turn.reasoningContent === "string" &&
          turn.reasoningContent.length > 0);
      if (hasReasoning) {
        throw new Error(
          "claude tool capture cannot encode reasoning into Anthropic messages without a proven thinking-block mapping",
        );
      }
      const content: Array<Record<string, unknown>> = [];
      if (typeof turn.text === "string" && turn.text.length > 0) {
        content.push({ type: "text", text: turn.text });
      }
      for (const call of turn.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments) as unknown;
        } catch {
          input = { _raw: call.arguments };
        }
        const leaf = sanitizeClaudeMcpToolName(call.name);
        const mcpName =
          nameMap.mcpToCaller.size > 0
            ? `${CLAUDE_MCP_TOOL_PREFIX}${leaf}`
            : call.name.startsWith(CLAUDE_MCP_TOOL_PREFIX)
              ? call.name
              : `${CLAUDE_MCP_TOOL_PREFIX}${leaf}`;
        content.push({
          type: "tool_use",
          id: call.id,
          name: mcpName,
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    // tool_result — Anthropic requires user role with tool_result blocks.
    out.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: turn.toolCallId,
          content: turn.content,
        },
      ],
    });
  }
  if (deltaText.length > 0) {
    const last = out.at(-1);
    // If the last turn already is this user delta as plain text, don't duplicate.
    if (
      !(
        last !== undefined &&
        last.role === "user" &&
        typeof last.content === "string" &&
        last.content === deltaText
      )
    ) {
      out.push({ role: "user", content: deltaText });
    }
  }
  return out;
};

export const planClaudeToolCaptureHistory = (args: {
  readonly systemText: string | null;
  readonly turns: ReadonlyArray<TNativeHistoryTurn>;
  readonly deltaText: string;
  readonly hasPrior: boolean;
  readonly historyFeed: TClaudeToolCaptureHistoryFeed;
}): TCaptureHistoryBuilderPlan => {
  const artifacts = historyStructuredArtifacts(args.turns);
  // Claude Messages encoding for capture history is tools/text only. Refuse
  // reasoning rather than invent thinking blocks or drop them silently —
  // even on the hermetic fixture_messages feed.
  if (artifacts.includes("reasoning")) {
    return {
      kind: "unsupported",
      mechanism: "unsupported",
      reason:
        "claude capture history cannot encode reasoning without a proven thinking-block mapping",
      lostArtifacts: artifacts,
    };
  }
  const structuredInjectProven =
    (args.historyFeed === "fixture_messages" &&
      CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS.proven) ||
    (args.historyFeed === "sdk_session_resume" &&
      CLAUDE_SESSION_RESUME_HISTORY_STATUS.proven);
  return captureAwareHistoryBuilderPlan({
    systemText: args.systemText,
    turns: args.turns,
    deltaText: args.deltaText,
    hasPrior: args.hasPrior,
    structuredInjectProven,
  });
};

/** Sanitize cwd the same way Claude Code names `projects/<key>/`. */
export const claudeCaptureProjectsKeyFromCwd = (cwd: string): string =>
  cwd.replace(/\//g, "-").replace(/\./g, "-").replace(/_/g, "-");

/**
 * Minimal continuation prompt when the OpenAI request ends on tool results
 * with no trailing user text. The CLI still appends its own system reminders;
 * this string only triggers a model turn after the resumed transcript.
 */
export const CLAUDE_TOOL_CAPTURE_RESUME_CONTINUE_PROMPT = ".";

export type TClaudeToolCaptureSessionWrite = {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly projectKey: string;
  /** Remove only this owned artifact. No-op if already gone. */
  readonly cleanup: () => void;
};

/**
 * Write a synthetic Claude Code session JSONL the Agent SDK can `resume`.
 * Always uses a fresh UUID path (never overwrites). Mode 0o600. Does not
 * read or modify other sessions — cleanup removes only this file.
 */
export const writeClaudeToolCaptureSessionTranscript = (args: {
  readonly configDir: string;
  readonly cwd: string;
  readonly providerModelId: string;
  readonly turns: ReadonlyArray<TNativeHistoryTurn>;
  readonly nameMap: TClaudeToolNameMap;
  readonly sessionId?: string;
}): TClaudeToolCaptureSessionWrite => {
  const sessionId = args.sessionId ?? randomUUID();
  const projectKey = claudeCaptureProjectsKeyFromCwd(args.cwd);
  const projectsDir = join(args.configDir, "projects", projectKey);
  mkdirSync(projectsDir, { recursive: true });
  const sessionPath = join(projectsDir, `${sessionId}.jsonl`);
  if (existsSync(sessionPath)) {
    throw new Error(
      `claude tool capture refused to overwrite existing session artifact ${sessionId}`,
    );
  }
  const cleanup = (): void => {
    try {
      if (existsSync(sessionPath)) unlinkSync(sessionPath);
    } catch {
      // best-effort
    }
  };

  const lines: Array<Record<string, unknown>> = [];
  let parentUuid: string | null = null;
  const stamp = (): string => new Date().toISOString();
  const push = (
    type: "user" | "assistant",
    message: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void => {
    const uuid = randomUUID();
    lines.push({
      type,
      uuid,
      parentUuid,
      isSidechain: false,
      sessionId,
      timestamp: stamp(),
      cwd: args.cwd,
      userType: "external",
      version: "2.1.283",
      gitBranch: null,
      message,
      ...extra,
    });
    parentUuid = uuid;
  };

  for (const turn of args.turns) {
    if (turn.kind === "text") {
      push(turn.role, {
        role: turn.role,
        content: [{ type: "text", text: turn.text }],
      });
      continue;
    }
    if (turn.kind === "assistant_tools") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof turn.text === "string" && turn.text.length > 0) {
        content.push({ type: "text", text: turn.text });
      }
      for (const call of turn.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments) as unknown;
        } catch {
          input = { raw: call.arguments };
        }
        const leaf = sanitizeClaudeMcpToolName(call.name);
        const mcpName = call.name.startsWith(CLAUDE_MCP_TOOL_PREFIX)
          ? call.name
          : `${CLAUDE_MCP_TOOL_PREFIX}${leaf}`;
        content.push({
          type: "tool_use",
          id: call.id,
          name: mcpName,
          input,
        });
      }
      push("assistant", {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: args.providerModelId,
        stop_reason: turn.toolCalls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        content,
      });
      continue;
    }
    if (turn.kind === "tool_result") {
      push(
        "user",
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: turn.toolCallId,
              content: turn.content,
            },
          ],
        },
        {
          toolUseResult: {
            content: [{ type: "text", text: turn.content }],
          },
        },
      );
    }
  }

  writeFileSync(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return { sessionId, sessionPath, projectKey, cleanup };
};

/** Anthropic tools[] entries as the vendor request would declare MCP tools. */
export const anthropicToolDefsFromClientTools = (
  tools: ReadonlyArray<TClientTool>,
): ReadonlyArray<Record<string, unknown>> =>
  tools.map((t) => ({
    name: `${CLAUDE_MCP_TOOL_PREFIX}${sanitizeClaudeMcpToolName(t.name)}`,
    description: t.description ?? t.name,
    input_schema: t.parameters ?? { type: "object", properties: {} },
  }));

export type TClaudeToolCaptureBuilderResult = {
  /** Local settlement / interrupt — never receives the true upstream body. */
  readonly settle: (settlement: TBuilderSettlement) => Promise<void>;
  readonly abort: () => void;
};

/**
 * Builder that constructs the vendor Messages request (headers+body) against
 * the capture loopback. Production default uses Agent SDK + inert MCP tools;
 * hermetic tests inject a fixture that POSTs a known envelope.
 */
export type TClaudeToolCaptureBuilder = (args: {
  readonly bin: string;
  readonly cleanedEnv: Record<string, string>;
  readonly loopbackBase: string;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly tools: ReadonlyArray<TClientTool>;
  readonly messages: ReadonlyArray<TClaudeAnthropicMessage>;
  readonly signal: AbortSignal;
  /** When set, production SDK builder resumes this synthetic session id. */
  readonly resumeSessionId?: string | null;
}) => Promise<TClaudeToolCaptureBuilderResult>;

/**
 * Hermetic fixture builder: POST a vendor-shaped Messages body (with tools +
 * exact messages) to the loopback, drain local settlement, never interpret
 * response as model output.
 */
export const claudeToolCaptureFixtureBuilder: TClaudeToolCaptureBuilder =
  async (args) => {
    const auth =
      args.cleanedEnv.FAKE_CLAUDE_AUTH ?? "Bearer sk-fixture-vendor-token";
    const headers = {
      Authorization: auth,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/fixture-tool-capture",
      "x-app": "cli",
    } as const;

    // Preamble — must stay local (no external auth forward).
    await fetch(`${args.loopbackBase}/api/oauth/usage`, {
      method: "GET",
      headers: { Authorization: auth, "user-agent": headers["user-agent"] },
      signal: args.signal,
    }).catch(() => undefined);

    const body = JSON.stringify({
      model: args.providerModelId,
      max_tokens: 64,
      stream: true,
      ...(args.systemText !== null ? { system: args.systemText } : {}),
      tools: anthropicToolDefsFromClientTools(args.tools),
      tool_choice: { type: "auto" },
      messages: args.messages,
    });

    let settleResolve: ((s: TBuilderSettlement) => void) | null = null;
    const settled = new Promise<TBuilderSettlement>((resolve) => {
      settleResolve = resolve;
    });

    const fetchP = (async (): Promise<number> => {
      try {
        const res = await fetch(`${args.loopbackBase}/v1/messages`, {
          method: "POST",
          headers: { ...headers },
          body,
          signal: args.signal,
        });
        await res.arrayBuffer().catch(() => undefined);
        return res.status;
      } catch {
        return 0;
      }
    })();

    return {
      settle: async (settlement) => {
        settleResolve?.(settlement);
        await settled;
        await fetchP;
      },
      abort: (): void => {
        // fetch aborted via signal; nothing else to tear down.
      },
    };
  };

/**
 * Production SDK builder: register inert MCP tools, point env at loopback,
 * start `query()`. Settlement prefers `interrupt()` then `close()` cleanup.
 * Does NOT feed the true upstream response into the query.
 */
export const claudeToolCaptureSdkBuilder: TClaudeToolCaptureBuilder = async (
  args,
) => {
  let handlerInvocations = 0;
  const sdkTools = buildInertClaudeCaptureMcpTools(args.tools, {
    onForbiddenExecution: () => {
      handlerInvocations += 1;
    },
  });
  const spawnEnv = withClaudeCaptureBaseUrl(args.cleanedEnv, args.loopbackBase);

  // Prompt must stay user-role text. Multi-turn tool history is NOT flattened
  // into the prompt — it is resumed from a synthetic on-disk session when
  // `resumeSessionId` is set (sdk_session_resume). Forging assistant-role
  // MessageParam entries on the prompt stream is rejected by the real CLI.
  const resumeId =
    typeof args.resumeSessionId === "string" && args.resumeSessionId.length > 0
      ? args.resumeSessionId
      : null;
  const last = args.messages.at(-1);
  const lastUserText =
    last !== undefined &&
    last.role === "user" &&
    typeof last.content === "string" &&
    last.content.length > 0
      ? last.content
      : null;
  const promptText =
    resumeId !== null
      ? (lastUserText ?? CLAUDE_TOOL_CAPTURE_RESUME_CONTINUE_PROMPT)
      : lastUserText;
  if (promptText === null) {
    throw new Error(
      "claude tool capture SDK builder cannot string-flatten tool-bearing history; use sdk_session_resume or fixture_messages",
    );
  }

  const abortController = new AbortController();
  const onOuterAbort = (): void => abortController.abort();
  if (args.signal.aborted) abortController.abort();
  else args.signal.addEventListener("abort", onOuterAbort, { once: true });

  const q = query({
    prompt: promptText,
    options: {
      ...buildClaudeToolSdkOptionsBase({
        bin: args.bin,
        env: spawnEnv,
        providerModelId: args.providerModelId,
        tools: sdkTools,
      }),
      // Hard deny — capture has no legitimate execution path at all (unlike
      // passthrough's pause-for-client-result).
      canUseTool: async () => ({
        behavior: "deny" as const,
        message: "claude tool capture: tool execution denied (inert capture)",
      }),
      // Capture's own AbortController — independent interrupt/close, unlike
      // the passthrough session which stays held open across requests.
      abortController,
      // Skip SDK auto title-generation (live capture otherwise ate the title
      // JSON as the daemon answer); the loopback gate is the hard backstop.
      title: CLAUDE_TOOL_CAPTURE_SESSION_TITLE,
      ...claudeToolResumeAndSystemPromptOptions({
        systemText: args.systemText,
        resumeSessionId: resumeId,
        suppressSystemPromptWhenResuming: true,
      }),
    },
  });

  // Drain iterator in the background so the CLI actually builds + sends the
  // Messages request; never treat yielded content as the daemon response.
  const drain = (async (): Promise<void> => {
    try {
      for await (const _msg of q as AsyncIterable<unknown>) {
        if (args.signal.aborted || abortController.signal.aborted) break;
      }
    } catch {
      // interrupt/close/abort
    }
  })();

  return {
    settle: async (settlement) => {
      try {
        if (settlement.kind === "cancelled" || settlement.kind === "failed") {
          abortController.abort();
        }
        // Prefer documented interrupt; close() is cleanup not warm-reuse proof.
        const interrupt = (q as { interrupt?: () => Promise<unknown> })
          .interrupt;
        if (typeof interrupt === "function") {
          await interrupt.call(q).catch(() => undefined);
        }
        const close = (q as { close?: () => void }).close;
        if (typeof close === "function") {
          try {
            close.call(q);
          } catch {
            // already closed
          }
        }
      } finally {
        args.signal.removeEventListener("abort", onOuterAbort);
        await drain.catch(() => undefined);
        if (handlerInvocations > 0) {
          logError(
            "native-runtime",
            safeDiagnosticMessage`claude tool capture inert handler was invoked`,
            { count: handlerInvocations },
          );
        }
      }
    },
    abort: (): void => {
      abortController.abort();
    },
  };
};

const remapToolCallsInChunk = (
  chunk: TChatCompletionChunk,
  nameMap: TClaudeToolNameMap,
): TChatCompletionChunk => {
  let changed = false;
  const choices = chunk.choices.map((choice) => {
    const toolCalls = choice.delta.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return choice;
    const mapped = toolCalls.map((tc) => {
      const fn = tc.function;
      if (fn === undefined || fn === null || typeof fn.name !== "string") {
        return tc;
      }
      const mappedName = mapClaudeCapturedToolName(fn.name, nameMap);
      if (mappedName === fn.name) return tc;
      changed = true;
      return {
        ...tc,
        function: { ...fn, name: mappedName },
      };
    });
    return { ...choice, delta: { ...choice.delta, tool_calls: mapped } };
  });
  if (!changed) return chunk;
  return { ...chunk, choices };
};

export const mapClaudeCaptureChunkToolNames = (
  chunks: ReadableStream<TChatCompletionChunk>,
  nameMap: TClaudeToolNameMap,
): ReadableStream<TChatCompletionChunk> => {
  // Acquired once, up front, so `cancel()` can reach the SAME locked reader —
  // `chunks.cancel()` on a stream that already has an active reader (the one
  // `start()` acquires) rejects with "Cannot cancel a locked ReadableStream".
  const reader = chunks.getReader();
  return new ReadableStream<TChatCompletionChunk>({
    async start(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(remapToolCallsInChunk(value, nameMap));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
};

export type TClaudeToolCaptureDiagnostics = {
  readonly textSettlement:
    | "unproven_text_settlement"
    | "cancelled"
    | "failed"
    | "interrupted"
    | null;
  readonly toolCapture: typeof CLAUDE_TOOL_CAPTURE_STATUS;
  readonly sdkStructuredHistory: typeof CLAUDE_SDK_STRUCTURED_HISTORY_STATUS;
  readonly fixtureStructuredHistory: typeof CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS;
  readonly daemonDispatchCount: number;
  readonly preambleExternalForwards: 0;
  /** Locally settled `/v1/messages` posts that were not caller-tool inference. */
  readonly auxiliaryMessagesSettled: number;
  readonly capturedEnvelope: TCapturedRequestEnvelope | null;
  readonly inertHandlerInvocations: 0;
  readonly interruptOrder: typeof CAPTURE_INTERRUPT_ORDER;
  readonly toolInventory: ReturnType<
    typeof inventoryToolCallsFromChunks
  > | null;
};

export type TClaudeToolCaptureAdapterResult = {
  readonly run: TNativeRunResult;
  readonly diagnostics: TClaudeToolCaptureDiagnostics;
  readonly directOutput: TCaptureDirectOutput | null;
};

export type TClaudeToolCaptureParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly tools: ReadonlyArray<TClientTool>;
  readonly historyTurns: ReadonlyArray<TNativeHistoryTurn>;
  readonly deltaText: string;
  readonly hasPrior: boolean;
  readonly signal: AbortSignal;
  readonly captureSender: TCapturedDispatchSender;
  readonly historyFeed?: TClaudeToolCaptureHistoryFeed;
  readonly builder?: TClaudeToolCaptureBuilder;
  readonly allowLoopbackDestinations?: boolean;
  readonly captureTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Optional canonical gate (temperature / forced tool_choice / …). */
  readonly canonical?: TChatCompletionRequest;
};

const emptyToolDiagnostics = (): TClaudeToolCaptureDiagnostics => ({
  textSettlement: null,
  toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
  sdkStructuredHistory: CLAUDE_SDK_STRUCTURED_HISTORY_STATUS,
  fixtureStructuredHistory: CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS,
  daemonDispatchCount: 0,
  preambleExternalForwards: 0,
  auxiliaryMessagesSettled: 0,
  capturedEnvelope: null,
  inertHandlerInvocations: 0,
  interruptOrder: CAPTURE_INTERRUPT_ORDER,
  toolInventory: null,
});

const settlementKindOf = (
  settlement: TBuilderSettlement,
): NonNullable<TClaudeToolCaptureDiagnostics["textSettlement"]> => {
  if (settlement.kind === "cancelled") return "cancelled";
  if (settlement.kind === "failed") return "failed";
  // `suppressed` = local ownership transfer after capture (interrupt path).
  return "interrupted";
};

/**
 * Tool-bearing Claude capture: plan history → register inert MCP schemas via
 * builder → capture Messages envelope → daemon dispatch once → decode + remap
 * tool names → publish daemon-owned output; builder only gets local settlement.
 */
export const runClaudeToolCapture = async (
  params: TClaudeToolCaptureParams,
): Promise<TClaudeToolCaptureAdapterResult> => {
  const diagnostics = emptyToolDiagnostics();
  if (params.tools.length === 0) {
    return {
      run: {
        kind: "declined",
        reason: "claude tool capture requires at least one caller tool",
      },
      diagnostics,
      directOutput: null,
    };
  }
  // Production SDK builder only — fixture builders never touch a real CLI.
  if (params.builder === undefined && !existsSync(params.bin)) {
    return {
      run: { kind: "declined", reason: "claude CLI not installed" },
      diagnostics,
      directOutput: null,
    };
  }

  if (params.canonical !== undefined) {
    const unsupported = unsupportedNativeControl(params.canonical);
    if (unsupported !== null) {
      return {
        run: {
          kind: "declined",
          reason: `native runtime can't honor ${unsupported}`,
        },
        diagnostics,
        directOutput: null,
      };
    }
  }

  const historyFeed: TClaudeToolCaptureHistoryFeed =
    params.historyFeed ?? "sdk_session_resume";
  const historyPlan = planClaudeToolCaptureHistory({
    systemText: params.systemText,
    turns: params.historyTurns,
    deltaText: params.deltaText,
    hasPrior: params.hasPrior,
    historyFeed,
  });
  if (historyPlan.kind === "unsupported") {
    return {
      run: {
        kind: "declined",
        reason: `claude tool capture history unsupported: ${historyPlan.reason} (lost=${historyPlan.lostArtifacts.join(",")})`,
      },
      diagnostics,
      directOutput: null,
    };
  }

  const nameMap = buildClaudeToolNameMap(params.tools);
  const cleaned = cleanNativeSpawnEnv(params.env);
  const cwd = spawnCwd(cleaned);
  const configDir =
    cleaned.CLAUDE_CONFIG_DIR ?? join(cleaned.HOME ?? cwd, ".claude");

  let resumeSessionId: string | null = null;
  let ownedSessionCleanup: (() => void) | null = null;
  let messages: ReadonlyArray<TClaudeAnthropicMessage>;
  try {
    if (
      historyPlan.kind === "structured_items" &&
      historyFeed === "sdk_session_resume"
    ) {
      // Persist daemon-owned assistant tool_use + caller tool_result into a
      // synthetic Claude session, then resume. Prompt stays user-text only.
      // Live-proven path keeps tool_result in the transcript (not only as a
      // streamed user block) so the CLI does not synthesize "interrupted".
      const written = writeClaudeToolCaptureSessionTranscript({
        configDir,
        cwd,
        providerModelId: params.providerModelId,
        turns: historyPlan.items,
        nameMap,
      });
      resumeSessionId = written.sessionId;
      ownedSessionCleanup = written.cleanup;
      messages = [
        {
          role: "user",
          content:
            historyPlan.deltaText.length > 0
              ? historyPlan.deltaText
              : CLAUDE_TOOL_CAPTURE_RESUME_CONTINUE_PROMPT,
        },
      ];
    } else if (historyPlan.kind === "structured_items") {
      messages = anthropicMessagesFromHistoryTurns(
        historyPlan.items,
        historyPlan.deltaText,
        nameMap,
      );
    } else if (historyPlan.kind === "cold_text_seed") {
      messages = [{ role: "user", content: historyPlan.userText }];
    } else {
      messages = [{ role: "user", content: params.deltaText }];
    }
  } catch (err) {
    ownedSessionCleanup?.();
    const reason = err instanceof Error ? err.message : String(err);
    return {
      run: {
        kind: "declined",
        reason: `claude tool capture history unsupported: ${reason}`,
      },
      diagnostics,
      directOutput: null,
    };
  }

  const systemText =
    historyPlan.kind === "cold_text_seed" ||
    historyPlan.kind === "structured_items"
      ? historyPlan.systemText
      : params.systemText;

  const session = createRequestCaptureSession({
    destinationPolicy: claudeCaptureDestinationPolicy({
      allowLoopback: params.allowLoopbackDestinations === true,
    }),
    signal: params.signal,
    captureTimeoutMs: params.captureTimeoutMs,
    maxBodyBytes: params.maxBodyBytes,
  });

  let textSettlement: TClaudeToolCaptureDiagnostics["textSettlement"] = null;
  let auxiliaryMessagesSettled = 0;
  const expectedMcpToolNames = new Set(nameMap.mcpToCaller.keys());
  const loopback = startClaudeCaptureLoopback({
    session,
    inferenceGate: claudeToolCaptureInferenceGate({
      providerModelId: params.providerModelId,
      expectedMcpToolNames,
    }),
    onSettlement: (kind) => {
      textSettlement =
        kind === "unproven_text_settlement" ? "interrupted" : kind;
    },
    onAuxiliarySettled: () => {
      auxiliaryMessagesSettled += 1;
    },
  });

  const releaseOwnedSession = (): void => {
    const fn = ownedSessionCleanup;
    ownedSessionCleanup = null;
    fn?.();
  };
  const builder = params.builder ?? claudeToolCaptureSdkBuilder;

  let builderHandle: TClaudeToolCaptureBuilderResult;
  try {
    builderHandle = await builder({
      bin: params.bin,
      cleanedEnv: cleaned,
      loopbackBase: loopback.baseUrl,
      providerModelId: params.providerModelId,
      systemText,
      tools: params.tools,
      messages,
      ...(resumeSessionId !== null ? { resumeSessionId } : {}),
      signal: params.signal,
    });
  } catch (err) {
    loopback.stop();
    session.dispose();
    releaseOwnedSession();
    const reason = err instanceof Error ? err.message : String(err);
    return {
      run: {
        kind: "declined",
        reason: `claude tool capture builder failed: ${reason}`,
      },
      diagnostics,
      directOutput: null,
    };
  }

  if (params.signal.aborted) {
    builderHandle.abort();
    await builderHandle
      .settle({ kind: "cancelled", reason: "client aborted" })
      .catch(() => undefined);
    loopback.stop();
    session.dispose();
    releaseOwnedSession();
    return {
      run: { kind: "declined", reason: "client aborted" },
      diagnostics: {
        ...diagnostics,
        textSettlement: "cancelled",
        auxiliaryMessagesSettled,
      },
      directOutput: null,
    };
  }

  let daemonDispatchCount = 0;
  let dispatchResult: TRunCapturedDispatchResult;
  try {
    dispatchResult = await runCapturedDispatch({
      session,
      sender: async (request, envelope, signal) => {
        daemonDispatchCount += 1;
        return params.captureSender(request, envelope, signal);
      },
      signal: params.signal,
      suppressReason:
        "claude tool capture: original external send suppressed; builder settled locally (interrupt) — not warm-reuse proof",
    });
  } catch (err) {
    const ownership: TCaptureOwnership =
      daemonDispatchCount > 0
        ? session.upstreamAccepted()
          ? "accepted"
          : "uncertain"
        : "none";
    const failure = captureDirectOutputFailure({
      session,
      reason: err instanceof Error ? err.message : String(err),
    });
    await builderHandle
      .settle(
        failure.builderSettlement ?? {
          kind: "failed",
          reason: failure.reason,
        },
      )
      .catch(() => undefined);
    builderHandle.abort();
    loopback.stop();
    session.dispose();
    releaseOwnedSession();
    return {
      run: {
        kind: "declined",
        reason: `claude tool capture dispatch failed: ${failure.reason}`,
        ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
      },
      diagnostics: {
        ...diagnostics,
        textSettlement: textSettlement ?? "failed",
        daemonDispatchCount,
        auxiliaryMessagesSettled,
        capturedEnvelope: failure.envelope,
      },
      directOutput: null,
    };
  }

  // CAPTURE_INTERRUPT_ORDER: settle builder → terminal → publish.
  // `runCapturedDispatch` already called session.settleBuilder(suppressed)
  // before the daemon send; re-read that settlement for the SDK interrupt.
  const builderSettlement: TBuilderSettlement = session.builderSettlement() ?? {
    kind: "suppressed",
    reason:
      "original external send suppressed; daemon owns the exchange (tool capture)",
  };
  await builderHandle.settle(builderSettlement).catch(() => undefined);
  textSettlement = settlementKindOf(builderSettlement);
  const terminal: TCaptureTerminalOutcome = dispatchResult.outcome;

  const rawChunks = chunksFromCapturedAnthropicResponse(
    dispatchResult.response,
    params.providerModelId,
  );
  const mappedChunks = mapClaudeCaptureChunkToolNames(rawChunks, nameMap);
  // Capture-only guard: a clean upstream EOF with no observed terminal
  // finish_reason (dropped connection, truncated body after 200) must not
  // silently become a synthesized "stop" — see request-capture-output.ts.
  const guardedChunks = requireCaptureTerminalFinishReason(mappedChunks);

  // Pre-commit: require first meaningful byte (text or tool_call) within
  // budget. Called ONLY after dispatch already succeeded, so a rejected
  // `reader.read()` (including the terminal-finish-reason guard above) is
  // folded into the same "exit" decline below — which already carries
  // `captureOwnership: "accepted"` — never left to propagate uncaught (this
  // function's callers do not wrap it in try/catch and would otherwise lose
  // that ownership signal).
  const reader = guardedChunks.getReader();
  const buffered: TChatCompletionChunk[] = [];
  let firstMeaningful: TChatCompletionChunk | null = null;
  let precommitTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    (async (): Promise<"ok" | "exit"> => {
      for (;;) {
        let read: { value: TChatCompletionChunk; done: false } | { done: true };
        try {
          read = await reader.read();
        } catch {
          return "exit";
        }
        if (read.done) return "exit";
        const { value } = read;
        const inv = inventoryToolCallsFromChunks([value]);
        const hasTool = inv.toolCalls.length > 0;
        const hasText = value.choices.some(
          (c) =>
            typeof c.delta.content === "string" && c.delta.content.length > 0,
        );
        const hasReasoning =
          typeof value.choices[0]?.delta.reasoning_content === "string" &&
          (value.choices[0]?.delta.reasoning_content.length ?? 0) > 0;
        if (hasTool || hasText || hasReasoning) {
          firstMeaningful = value;
          return "ok";
        }
        buffered.push(value);
      }
    })(),
    new Promise<"timeout">((resolve) => {
      precommitTimer = setTimeout(
        () => resolve("timeout"),
        PRE_COMMIT_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(precommitTimer);

  if (first !== "ok" || firstMeaningful === null) {
    builderHandle.abort();
    loopback.stop();
    session.dispose();
    releaseOwnedSession();
    void reader.cancel().catch(() => undefined);
    return {
      run: {
        kind: "declined",
        reason:
          first === "timeout"
            ? "claude tool capture produced no output before the pre-commit deadline"
            : "claude tool capture upstream ended before producing output",
        captureOwnership: "accepted",
      },
      diagnostics: {
        ...diagnostics,
        textSettlement: textSettlement ?? "failed",
        daemonDispatchCount,
        auxiliaryMessagesSettled,
        capturedEnvelope: dispatchResult.envelope,
      },
      directOutput: null,
    };
  }

  const committedSeed = firstMeaningful;
  const restStream = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      for (const c of buffered) controller.enqueue(c);
      controller.enqueue(committedSeed);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  const directOutput = publishCapturedDirectOutput({
    session,
    envelope: dispatchResult.envelope,
    terminal,
    chunks: restStream,
    builderSettlement,
    onRelease: () => {
      builderHandle.abort();
      loopback.stop();
      session.dispose();
      releaseOwnedSession();
    },
  });

  // Inventory from the seed chunk (full parallel set may arrive later in stream;
  // tests also drain + re-inventory).
  const seedInventory = inventoryToolCallsFromChunks([committedSeed]);

  return {
    run: {
      kind: "committed",
      chunks: directOutput.chunks,
      sessionId: () => null,
    },
    diagnostics: {
      textSettlement: textSettlement ?? "interrupted",
      toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
      sdkStructuredHistory: CLAUDE_SDK_STRUCTURED_HISTORY_STATUS,
      fixtureStructuredHistory: CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS,
      daemonDispatchCount,
      preambleExternalForwards: 0,
      auxiliaryMessagesSettled,
      capturedEnvelope: dispatchResult.envelope,
      inertHandlerInvocations: 0,
      interruptOrder: CAPTURE_INTERRUPT_ORDER,
      toolInventory: seedInventory,
    },
    directOutput,
  };
};

/**
 * Collect tool calls from a finished chunk list after caller-name remapping.
 * Convenience for hermetic assertions on parallel calls / JSON args.
 */
export const inventoryRemappedClaudeToolCalls = (
  chunks: ReadonlyArray<TChatCompletionChunk>,
  nameMap: TClaudeToolNameMap,
): ReadonlyArray<TToolCall> => {
  const remapped = chunks.map((c) => remapToolCallsInChunk(c, nameMap));
  return inventoryToolCallsFromChunks(remapped).toolCalls;
};
