/**
 * Claude tool-capture readiness labels — single source of truth.
 *
 * Kept in a leaf module so `claude-capture.ts` and `claude-tool-capture.ts`
 * share one `typeof` without an import cycle (tool-capture → capture loopback).
 */

export const CLAUDE_TOOL_CAPTURE_STATUS = {
  proven: true,
  label:
    "first-turn tool schema capture + daemon-owned tool_use decode: hermetic fixture proven; serve wires official Agent SDK builder under bridge-capture (not fixture). Loopback captures only Messages that declare registered mcp__openllm__* tools (aux title/background settled locally); SDK options.title skips auto title gen. Multi-turn: sdk_session_resume (synthetic JSONL + Agent SDK resume) preserves tool ids/args/results; direct AsyncIterable assistant-role MessageParam inject is rejected by the real CLI",
} as const;

export type TClaudeToolCaptureStatus = typeof CLAUDE_TOOL_CAPTURE_STATUS;

/** Direct AsyncIterable assistant-role MessageParam inject — rejected at runtime. */
export const CLAUDE_SDK_STRUCTURED_HISTORY_STATUS = {
  proven: false,
  label:
    "Direct AsyncIterable<SDKUserMessage> with assistant-role MessageParam is REJECTED by the real CLI (Expected message role 'user', got 'assistant'). Held MCP handler resolve is the non-capture bridge path only. Capture multi-turn uses sdk_session_resume instead.",
} as const;

/**
 * Proven (local loopback + live parent #21 continuation): synthetic session
 * JSONL under isolated CLAUDE_CONFIG_DIR + Agent SDK `resume`.
 */
export const CLAUDE_SESSION_RESUME_HISTORY_STATUS = {
  proven: true,
  label:
    "synthetic on-disk session JSONL + Agent SDK resume: preserves assistant tool_use ids/names/args and user tool_result content; skips auto title via options.title; aux Messages still gated. Prompt stream must stay user-role only. Reasoning/thinking-block mapping still refused (no silent drop).",
} as const;

/** Fixture builder exact messages[] feed — hermetic only. */
export const CLAUDE_FIXTURE_STRUCTURED_HISTORY_STATUS = {
  proven: true,
  label:
    "fixture builder posts exact Anthropic messages from history turns; preserves tool ids/args/roles; reasoning/thinking-block mapping unproven and refused",
} as const;
