/**
 * Sub-method capability table + per-hop selection — the ONE home for
 * "which execution methods does each subscription provider support, and
 * which one does this hop use?".
 *
 * `bridge` = the native vendor-runtime path (`native-runtime/`);
 * `bridge-capture` = the same native path with vendor-built request capture
 * (daemon owns the one upstream exchange — see
 * `docs/plan/bridge-request-capture/`);
 * `handrolled` = the walker's manual upstream-HTTP transport. The cloud
 * publishes a preference in the bootstrap snapshot
 * (`config.ts#activeSubMethod` + per-provider
 * `config.ts#activeSubMethodOverrides`, both from the cloud env
 * `ACTIVE_SUB_METHOD`); the walker passes `overrides[provider] ?? global`
 * as `requested`, and selection resolves it against the provider's
 * declared methods:
 *
 * Supported legacy preferences retain their meaning. An absent/unsupported
 * preference uses execution-registry.ts's explicit defaultSelection (and its
 * caller-policy fallback), never methods[0]. resolveHopExecution reconciles
 * both bootstrap vocabularies before choosing the outer transport and the
 * concrete vendor variant together.
 *
 * The walker samples the selection ONCE per hop, before local execution:
 * `handrolled` never probes or spawns the bridge; `bridge` /
 * `bridge-capture` keep the pre-commit decline → manual fallback on the
 * same hop when declared. See `docs/proposals/active-sub-method.md` +
 * `docs/proposals/sub-method-simplified-execution.md`.
 *
 * `bridge-capture` is declared for Claude/Codex native request capture,
 * Cursor's ACP/Connect capture, and Muse's native endpoint-transport capture.
 * Declaration enables selection; it does not certify every live scenario.
 * Only providers without that declaration normalize a capture override to
 * the explicit provider default; see the capture live-validation report for tested coverage.
 */

import type {
  TExecutionSelection,
  TSubMethod,
  TSubscriptionProviderSlug,
} from "@openllmsh/protocol";
import {
  defaultExecutionSelectionFor,
  effectiveExecutionSelectionForHop,
} from "./execution-registry";

const subMethodForSelection = (selection: TExecutionSelection): TSubMethod =>
  selection.kind === "handrolled"
    ? "handrolled"
    : selection.capture
      ? "bridge-capture"
      : "bridge";

export type TSubMethodCapability = {
  /** Non-empty, duplicate-free supported set; order is not default policy. */
  readonly methods: readonly TSubMethod[];
};

/**
 * The initial capability matrix (active-sub-method.md §initial capability
 * matrix). `bridge` is declared exactly for the native-runtime providers
 * (`isNativeRuntimeProvider`); kimi_code + grok are handrolled-only, while
 * Cursor and Muse support native bridge variants without a handrolled fallback.
 * The table ⇔ native-runtime lockstep is machine-checked in
 * `tests/transport/sub-method.test.ts`.
 */
export const SUB_METHOD_CAPABILITIES: Readonly<
  Record<TSubscriptionProviderSlug, TSubMethodCapability>
> = {
  claude_code: { methods: ["bridge", "bridge-capture", "handrolled"] },
  chatgpt: { methods: ["bridge", "bridge-capture", "handrolled"] },
  kimi_code: { methods: ["handrolled"] },
  grok: { methods: ["handrolled"] },
  // Cursor's ONLY inference transport is the ACP bridge (`cursor-agent acp`,
  // native-runtime/cursor-acp.ts) — there is no manual HTTP path (no
  // UPSTREAM_WIRE entry), so it is BRIDGE-ONLY: a bridge decline advances the
  // plan instead of falling to a manual transport. bridge-capture = official
  // RunSSE+BidiAppend transaction via runCursorNativeCapture (HTTP/2 duplex
  // fail-closed post-accept with captureOwnership accepted/uncertain).
  cursor: { methods: ["bridge", "bridge-capture"] },
  // Muse Code: MSP capture by default. bridge-capture activates
  // settings.endpoint_transport plaintext redirect (Keychain-free durable
  // auth proven 2026-09-27). No handrolled Meta Model API path.
  muse: { methods: ["bridge", "bridge-capture"] },
};

/**
 * Is the inbound request from a REAL first-party Claude client? Claude
 * Code stamps `user-agent: claude-cli/<semver> …`, Claude Cowork (and
 * sibling official Claude apps) stamp their own `claude*` identity, and
 * the gateway/daemon forward the header verbatim
 * (`originatorHeadersFrom`) — so the `claude` prefix is the family
 * signature. A spoof (or an unrelated third-party lib that happens to
 * name itself `claude-*`) gains nothing: it merely selects the MORE
 * ToS-aligned transport, which serves every request shape anyway.
 */
export const isClaudeCodeOriginator = (headers: Headers): boolean =>
  headers.get("user-agent")?.toLowerCase().startsWith("claude") === true;

/**
 * Resolve the effective method for one subscription hop. Deterministic:
 * a null/unsupported preference selects the provider default
 * (the registry's explicit selection). Unknown providers (not in the closed subscription set)
 * resolve to `handrolled` — the walker's `canWalkPlan`/`UPSTREAM_WIRE`
 * already decide whether such a hop is servable at all.
 *
 * ToS-alignment override (beats `ACTIVE_SUB_METHOD`): a `claude_code`
 * hop whose inbound request comes from the REAL Claude Code client
 * (`originator.isClaudeCode`) is ALWAYS handrolled. The handrolled
 * transport forwards the genuine client's own request — verbatim
 * Anthropic wire, its own identity headers — on the CLI's own
 * credential, which IS the official-client flow the subscription terms
 * describe. Spawning the bridge (or bridge-capture) there would nest a
 * SECOND Claude Code runtime around a request the real one already
 * produced: slower (process spawn + stream-json re-encode), lossier, and
 * no more compliant.
 */
export const selectSubMethod = (
  provider: string,
  requested: TSubMethod | null,
  originator?: { readonly isClaudeCode: boolean },
): TSubMethod => {
  if (provider === "claude_code" && originator?.isClaudeCode === true) {
    return "handrolled";
  }
  const capability =
    SUB_METHOD_CAPABILITIES[provider as TSubscriptionProviderSlug];
  if (capability === undefined) return "handrolled";
  if (requested !== null && capability.methods.includes(requested)) {
    return requested;
  }
  const selection = defaultExecutionSelectionFor(provider, originator);
  return selection === null ? "handrolled" : subMethodForSelection(selection);
};

/**
 * Ordered local transports this box may attempt for one subscription hop.
 * Provider-agnostic: capability table + preference + the two ToS policies
 * already owned by {@link selectSubMethod} / the non-CC claude_code rule.
 *
 * Walker uses this instead of hard-coding per-slug branches:
 *   - `["bridge"]` / `["bridge-capture"]`
 *       — bridge-only (cursor/muse), or non-CC claude_code (handrolled would
 *         spoof Claude Code identity)
 *   - `["handrolled"]` — handrolled preference, or CC originator
 *                               (selectSubMethod forces handrolled)
 *   - `["bridge","handrolled"]` / `["bridge-capture","handrolled"]`
 *       — bridge(-capture) preference with handrolled fallback
 *
 * Empty only for an unknown provider with no declared methods (walker then
 * treats local serve as exhausted and tries the fleet tunnel).
 *
 * After upstream acceptance on a capture path, the walker must NOT retry the
 * same hop via another method (uncertain_accept → no second send). Pre-accept
 * declines may still fall through to handrolled when listed.
 */
export const localMethodsForHop = (
  provider: string,
  requested: TSubMethod | null,
  originator?: { readonly isClaudeCode: boolean },
): readonly TSubMethod[] => {
  // Non-CC claude_code: never attempt handrolled on this box (would require
  // spoofing a "You are Claude Code" identity the client never sent). Bridge
  // / bridge-capture only; fleet covers a peer that can serve under its own
  // policy.
  if (provider === "claude_code" && originator?.isClaudeCode !== true) {
    const selected = selectSubMethod(provider, requested, originator);
    if (selected === "handrolled") {
      const fallback = defaultExecutionSelectionFor(provider, originator);
      return fallback?.kind === "bridge"
        ? [subMethodForSelection(fallback)]
        : [];
    }
    return [selected];
  }

  const capability =
    SUB_METHOD_CAPABILITIES[provider as TSubscriptionProviderSlug];
  // Unknown provider: no declared local transports. Walker treats empty as
  // local-exhausted and tries the fleet tunnel (matches the doc comment above).
  if (capability === undefined) return [];

  const selected = selectSubMethod(provider, requested, originator);
  if (selected === "handrolled") return ["handrolled"];
  if (selected === "bridge-capture") {
    if (capability.methods.includes("handrolled")) {
      return ["bridge-capture", "handrolled"];
    }
    return ["bridge-capture"];
  }
  // Bridge selected (preference or default): try bridge first; fall through
  // to handrolled on the same hop when the capability table declares it.
  if (capability.methods.includes("handrolled")) {
    return ["bridge", "handrolled"];
  }
  return ["bridge"];
};

export type ResolveHopExecutionParams = {
  readonly provider: string;
  readonly legacyPreference: TSubMethod | null;
  readonly legacyOverrides: Readonly<Record<string, TSubMethod>>;
  readonly executionPreference: TExecutionSelection | null;
  readonly executionOverrides: Readonly<Record<string, TExecutionSelection>>;
  readonly originator?: { readonly isClaudeCode: boolean };
};

/** Resolve both bootstrap projections once, before any local dispatch.
 * A handrolled preference may need a vendor default; forwarding that original
 * handrolled token into native dispatch would contradict the outer fallback.
 * Explicit vendor selections stay exact, including their pre-dispatch refusals.
 */
export const resolveHopExecution = ({
  provider,
  legacyPreference,
  legacyOverrides,
  executionPreference,
  executionOverrides,
  originator,
}: ResolveHopExecutionParams): {
  readonly methods: readonly TSubMethod[];
  readonly executionSelection: TExecutionSelection | null;
} => {
  const requested = legacyOverrides[provider] ?? legacyPreference;
  if (provider === "claude_code" && originator?.isClaudeCode === true) {
    return {
      methods: localMethodsForHop(provider, requested, originator),
      executionSelection: null,
    };
  }
  const explicit = effectiveExecutionSelectionForHop(
    provider,
    executionOverrides,
    legacyOverrides,
    executionPreference,
  );
  if (explicit?.kind === "bridge") {
    // Never turn a refused concrete variant into a successful handrolled call.
    return {
      methods: [subMethodForSelection(explicit)],
      executionSelection: explicit,
    };
  }
  if (explicit?.kind === "handrolled" || requested === "handrolled") {
    const methods = localMethodsForHop(provider, "handrolled", originator);
    if (methods.includes("handrolled")) {
      return { methods, executionSelection: null };
    }
  }
  const capability =
    SUB_METHOD_CAPABILITIES[provider as TSubscriptionProviderSlug];
  if (
    explicit?.kind === "handrolled" ||
    requested === null ||
    requested === "handrolled" ||
    !capability?.methods.includes(requested)
  ) {
    const selection = defaultExecutionSelectionFor(provider, originator);
    return {
      methods:
        selection === null
          ? []
          : localMethodsForHop(
              provider,
              subMethodForSelection(selection),
              originator,
            ),
      executionSelection: selection?.kind === "bridge" ? selection : null,
    };
  }
  // Explicit legacy bridge selectors keep their historical shape-dependent
  // dispatch and pre-accept fallback behavior, not the new concrete defaults.
  return {
    methods: localMethodsForHop(provider, requested, originator),
    executionSelection: null,
  };
};

/** Whether the capability table declares a serve-activated capture route. */
export const providerDeclaresBridgeCapture = (provider: string): boolean => {
  const capability =
    SUB_METHOD_CAPABILITIES[provider as TSubscriptionProviderSlug];
  return capability?.methods.includes("bridge-capture") === true;
};

/** Native vendor-runtime methods the walker may enter via `tryServeNativeRuntime`. */
export const isNativeBridgeMethod = (method: TSubMethod): boolean =>
  method === "bridge" || method === "bridge-capture";

export const methodsIncludeNativeBridge = (
  methods: readonly TSubMethod[],
): boolean => methods.some(isNativeBridgeMethod);
