/**
 * Integrator-owned readiness for bridge request capture.
 *
 * Selection is owned by `ACTIVE_SUB_METHOD` / `sub-method.ts`. There is NO
 * separate capture env flag. Cursor/Claude/Codex/Muse declare bridge-capture
 * when their serve path is ready (Cursor: RunSSE+BidiAppend transaction).
 *
 * Text + first-turn caller tools activate under `bridge-capture`. Multi-turn
 * tool/reasoning history stays refuse-before-send until each provider's
 * structured inject is LIVE-proven (not hermetic-only).
 */

import { providerDeclaresBridgeCapture } from "../sub-method";
import type { TNativeRuntimeProvider } from "./types";

export type TBridgeCaptureReadiness = {
  readonly provider: TNativeRuntimeProvider;
  readonly ready: boolean;
  /**
   * `capture` = serve may enter the capture path for text and first-turn tools.
   * `unchanged_bridge` = keep today's native bridge; capability omits capture.
   */
  readonly mode: "capture" | "unchanged_bridge";
  readonly reason: string;
};

const CLAUDE_READY: TBridgeCaptureReadiness = {
  provider: "claude_code",
  ready: true,
  mode: "capture",
  reason:
    "Claude Messages text + first-turn caller-tool capture serve-wired (SDK builder, inert MCP schemas); multi-turn tool history refuses until Agent SDK structured replay is live-proven",
};

const CODEX_READY: TBridgeCaptureReadiness = {
  provider: "chatgpt",
  ready: true,
  mode: "capture",
  reason:
    "Codex text + first-turn dynamicTools capture serve-wired (isolated app-server); multi-turn tool/reasoning history refuses until thread/inject_items is LIVE-proven (hermetic inject is test-only)",
};

const CURSOR_READY: TBridgeCaptureReadiness = {
  provider: "cursor",
  ready: true,
  mode: "capture",
  reason:
    "Cursor RunSSE+BidiAppend transaction capture serve-wired (exact RPC replay; control-only companion ack; Connect stream decode). HTTP/2 BiDi duplex exec/interaction_query fail-closed post-accept with captureOwnership; untyped TokenDelta omitted from usage; native tool intents never silently relabeled",
};

const MUSE_READY: TBridgeCaptureReadiness = {
  provider: "muse",
  ready: true,
  mode: "capture",
  reason:
    "Muse settings.endpoint_transport capture serve-wired (durable cliEnv→cleanMuseSpawnEnv→overlay, Keychain-free; POST /responses → api.meta.ai/v1; Responses SSE decode). Multi-turn tool/reasoning history refuses until MSP inject exists; cold+seed only",
};

const READINESS: Record<TNativeRuntimeProvider, TBridgeCaptureReadiness> = {
  claude_code: CLAUDE_READY,
  chatgpt: CODEX_READY,
  cursor: CURSOR_READY,
  muse: MUSE_READY,
};

export const bridgeRequestCaptureReadiness = (
  provider: TNativeRuntimeProvider,
): TBridgeCaptureReadiness => READINESS[provider];

export const shouldActivateBridgeRequestCapture = (
  provider: TNativeRuntimeProvider,
  bridgeCaptureSelected: boolean,
): boolean => {
  if (!bridgeCaptureSelected) return false;
  if (!providerDeclaresBridgeCapture(provider)) return false;
  return bridgeRequestCaptureReadiness(provider).ready;
};

export const bridgeRequestCaptureReadinessTable =
  (): ReadonlyArray<TBridgeCaptureReadiness> => [
    CLAUDE_READY,
    CODEX_READY,
    CURSOR_READY,
    MUSE_READY,
  ];
