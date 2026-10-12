/**
 * Per-hop execution resolution — the ONE home for "which transport does this
 * subscription hop use?".
 *
 * The cloud publishes a preference in the bootstrap snapshot
 * (`config.ts#activeExecutionSelection` + per-provider
 * `config.ts#activeExecutionSelectionOverrides`, both from the cloud env
 * `ACTIVE_SUB_METHOD`): a named vendor variant (`stream-json`, `sdk-facade`,
 * `acp`, `app-server`, `msp`, optionally with capture) or `handrolled` (the
 * walker's manual upstream-HTTP transport). Supported variants and defaults
 * live in `execution-registry.ts`; this module combines them with caller
 * policy.
 *
 * The walker samples the selection ONCE per hop, before local execution.
 * `handrolled` never probes or spawns a vendor runtime; a concrete vendor
 * selection is honored exactly (a refusal declines the hop pre-dispatch —
 * never a silent substitute). A registry-default vendor selection keeps the
 * pre-commit decline → manual fallback on the same hop when the provider
 * also supports `handrolled`.
 */

import type { TExecutionSelection } from "@openllmsh/protocol";
import {
  defaultExecutionSelectionFor,
  providerSupportsVariant,
  registeredVariantsFor,
} from "./execution-registry";

/** A local transport the walker may attempt for one hop. */
export type THopTransport = "native" | "handrolled";

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

export type ResolveHopExecutionParams = {
  readonly provider: string;
  readonly executionPreference: TExecutionSelection | null;
  readonly executionOverrides: Readonly<Record<string, TExecutionSelection>>;
  readonly originator?: { readonly isClaudeCode: boolean };
};

export type THopExecution = {
  /** Ordered local transports; empty = local-exhausted (walker tries fleet). */
  readonly methods: readonly THopTransport[];
  /** The concrete vendor selection `native` dispatches; null when the hop
   *  has no native transport. */
  readonly executionSelection: TExecutionSelection | null;
};

const LOCAL_EXHAUSTED: THopExecution = {
  methods: [],
  executionSelection: null,
};

const nativeThenMaybeHandrolled = (
  provider: string,
  selection: TExecutionSelection,
  allowHandrolledFallback: boolean,
): THopExecution => ({
  methods:
    allowHandrolledFallback && providerSupportsVariant(provider, "handrolled")
      ? ["native", "handrolled"]
      : ["native"],
  executionSelection: selection,
});

const fromDefault = (
  provider: string,
  originator: { readonly isClaudeCode: boolean } | undefined,
): THopExecution => {
  const selection = defaultExecutionSelectionFor(provider, originator);
  if (selection === null) return LOCAL_EXHAUSTED;
  if (selection.kind === "handrolled") {
    return { methods: ["handrolled"], executionSelection: null };
  }
  return nativeThenMaybeHandrolled(
    provider,
    selection,
    // Non-CC claude_code must never fall to handrolled on this box (it would
    // spoof a Claude Code identity the client never sent); fleet covers it.
    provider !== "claude_code",
  );
};

/**
 * Resolve one hop's transports + concrete selection from the sampled
 * preference. Deterministic, provider-agnostic apart from the two Claude
 * ToS policies:
 *
 * - A `claude_code` hop from the REAL Claude Code client is ALWAYS
 *   handrolled (beats `ACTIVE_SUB_METHOD`): forwarding the genuine client's
 *   own request on its own credential IS the official-client flow, and
 *   nesting a second Claude runtime around it would be slower and lossier.
 * - Any other `claude_code` caller never runs handrolled locally; a
 *   handrolled preference resolves to the registry's policy fallback.
 *
 * Unknown providers have no registration → empty methods (fleet).
 */
export const resolveHopExecution = ({
  provider,
  executionPreference,
  executionOverrides,
  originator,
}: ResolveHopExecutionParams): THopExecution => {
  if (registeredVariantsFor(provider).length === 0) return LOCAL_EXHAUSTED;
  if (provider === "claude_code" && originator?.isClaudeCode === true) {
    return { methods: ["handrolled"], executionSelection: null };
  }
  const requested = executionOverrides[provider] ?? executionPreference;
  if (requested === null) return fromDefault(provider, originator);
  if (requested.kind === "bridge") {
    // Never turn a refused concrete variant into a successful handrolled call.
    return nativeThenMaybeHandrolled(provider, requested, false);
  }
  const handrolledAllowed =
    providerSupportsVariant(provider, "handrolled") &&
    provider !== "claude_code";
  return handrolledAllowed
    ? { methods: ["handrolled"], executionSelection: null }
    : fromDefault(provider, originator);
};
