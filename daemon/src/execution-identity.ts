/**
 * Normalized execution identity — the internal `(provider, variant,
 * capture)` triple that partitions native-runtime session/continuation
 * state so a sibling execution variant can never collide with, silently
 * resume, or redeem another variant's held state
 * (docs/plan/bridge-variants-and-capture-adapters/09-implementation-plan.md
 * §7, phase 3).
 *
 * This is INTERNAL bookkeeping, distinct from the public wire vocabulary in
 * `@openllmsh/protocol` (`TExecutionSelection` / `TBridgeVariant` /
 * `resolveExecutionSelection` in `./execution-registry.ts`). For the LEGACY
 * `bridge`/`bridge-capture` selector (still the default — no explicit
 * new-vocabulary override configured for the hop), `native-runtime/serve.ts`
 * derives the variant purely from which CODE PATH it is already running,
 * not from a resolved public selection — so more than one internal identity
 * can correspond to what is, on the wire, still ONE `ACTIVE_SUB_METHOD`
 * selector: Claude's legacy `bridge`/`bridge-capture` dispatches a
 * plain-text turn through the direct-CLI `stream-json` engine and a
 * tool-bearing turn through the held Agent SDK `query()` engine
 * (`agent-sdk`) — see 09-implementation-plan.md §3, "Claude SDK" row. This
 * module's job is to make that existing split explicit and consistently
 * keyed, not to pretend it is already one uniform variant (that unification
 * — or its explicit rejection — is the Claude CLI tool-scope milestone in
 * 09-implementation-plan.md §2). As of the phase-5 migration, `serve.ts`
 * ALSO resolves an EXPLICIT new-vocabulary selection (when the walker
 * samples one) through `resolveExecutionSelection`, and that resolution's
 * `variant` is what feeds these SAME constructors — an explicit
 * `claude_code:stream-json` selection still keys the identity exactly as
 * `nativeTextExecutionIdentity("claude_code", …)` does today, because the
 * registry only ever accepts the one variant this module already names for
 * that dispatch path (see `PROVIDER_EXECUTION_REGISTRY`).
 *
 * `agent-sdk` here is the SAME closed `TBridgeVariant` literal the public
 * vocabulary reserves for the (not yet independently selectable) official
 * Agent SDK integration — this reuses that one enum rather than inventing a
 * parallel internal string union, per the task's "derive types... from
 * existing contracts/one registry" constraint. It does not imply `agent-sdk`
 * is independently selectable on the wire today; `./execution-registry.ts`
 * (the capability authority) still does not register it for any provider.
 */

import type { TBridgeVariant } from "@openllmsh/protocol";
import type { TNativeRuntimeProvider } from "./native-runtime/types";

export type TExecutionIdentity = {
  readonly provider: TNativeRuntimeProvider;
  readonly variant: TBridgeVariant;
  readonly capture: boolean;
};

/**
 * Canonical string key for maps/logs/token-claim scoping. This is an OPAQUE
 * partition key, never parsed back into a {@link TExecutionIdentity} — for
 * the parsed public wire grammar, see
 * `@openllmsh/protocol/execution-selection`'s `parseActiveExecutionToken`.
 */
export const executionIdentityKey = (identity: TExecutionIdentity): string =>
  `${identity.provider}:${identity.variant}:${identity.capture ? "capture" : "native"}`;

export const sameExecutionOwner = (
  a: TExecutionIdentity,
  b: TExecutionIdentity,
): boolean => executionIdentityKey(a) === executionIdentityKey(b);

/**
 * Today's Claude/Codex TEXT dispatch — the direct-CLI (`stream-json`)
 * completion engine for `claude_code`, the `app-server` JSON-RPC engine for
 * `chatgpt` (`tryServeNativeRuntime`'s text branch in `native-runtime/serve.ts`),
 * keyed by whether bridge-capture is active for this hop.
 */
export const nativeTextExecutionIdentity = (
  provider: "claude_code" | "chatgpt",
  captureActive: boolean,
): TExecutionIdentity => ({
  provider,
  variant: provider === "claude_code" ? "stream-json" : "app-server",
  capture: captureActive,
});

/**
 * Today's Claude/Codex TOOL-passthrough dispatch
 * (`tryServeNativeToolTurn` / `serveCapturedToolTurn` in
 * `native-runtime/serve.ts`). Claude's tool-bearing turns run through the
 * held Agent SDK `query()` orchestrator (`claude-tool-session.ts` /
 * `claude-tool-capture.ts`) — a DIFFERENT engine from its own text path's
 * direct CLI, so this is deliberately NOT
 * {@link nativeTextExecutionIdentity} with the same variant. Codex's tool
 * turns share the SAME `app-server` JSON-RPC client as its text path
 * (`codex-tool-session.ts` reuses `codex-app-server.ts`'s `clientFor`), so
 * this intentionally resolves to the identical identity
 * {@link nativeTextExecutionIdentity} would for `chatgpt`.
 */
export const nativeToolExecutionIdentity = (
  provider: "claude_code" | "chatgpt",
  captureActive: boolean,
): TExecutionIdentity => ({
  provider,
  variant: provider === "claude_code" ? "agent-sdk" : "app-server",
  capture: captureActive,
});

/** Today's Cursor dispatch — bridge-only, one ACP engine. */
export const cursorExecutionIdentity = (
  captureActive: boolean,
): TExecutionIdentity => ({
  provider: "cursor",
  variant: "acp",
  capture: captureActive,
});

/** Today's Muse dispatch — bridge-only, one MSP engine. */
export const museExecutionIdentity = (
  captureActive: boolean,
): TExecutionIdentity => ({
  provider: "muse",
  variant: "msp",
  capture: captureActive,
});

/**
 * The single production scope Claude's tool-continuation tokens are minted
 * and redeemed under today (`native-runtime/claude-tool-continuation.ts`, via
 * `native-runtime/serve.ts`'s `toolContinuationIdentity`) — the non-captured
 * held Agent SDK tool-passthrough engine. `claude-tool-capture.ts`'s own
 * tool-bearing capture path does not mint or redeem these tokens at all (a
 * separate, continuation-less mechanism today), so no `capture: true` scope
 * exists for this token family yet; adding one is future work for whichever
 * phase gives that path a resumable continuation, not a gap this stage
 * silently papers over.
 */
export const CLAUDE_TOOL_PASSTHROUGH_SCOPE = executionIdentityKey(
  nativeToolExecutionIdentity("claude_code", false),
);
