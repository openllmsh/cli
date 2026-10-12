/**
 * The capability and default authority for named execution methods.
 * `defaultSelection` is policy; variants/captureVariants are supported sets,
 * never priority lists. `sub-method.ts#resolveHopExecution` combines these
 * defaults with the bootstrap preference and caller policy before dispatch.
 * Concrete vendor selections still validate strictly; selecting a default
 * is not permission to substitute another method after dispatch fails.
 */

import type {
  TBridgeVariant,
  TExecutionSelection,
  TSubscriptionProviderSlug,
} from "@openllmsh/protocol";
import {
  executionSelectionBridge,
  executionSelectionHandrolled,
} from "@openllmsh/protocol";

export type TExecutionVariant = TBridgeVariant | "handrolled";

export type TProviderExecutionRegistration = {
  readonly provider: TSubscriptionProviderSlug;
  /** Duplicate-free supported methods. Order does not select a default. */
  readonly variants: readonly TExecutionVariant[];
  readonly defaultSelection: TExecutionSelection;
  /** Caller-policy fallback only; never an inference-failure retry. */
  readonly policyFallbackSelection?: TExecutionSelection;
  /** Capture-capable subset of `variants`; the bridge-only type excludes
   *  `handrolled`, which never supports capture. */
  readonly captureVariants: readonly TBridgeVariant[];
};

/**
 * The per-provider registration, grounded in the baseline plan's target matrix
 * (09-implementation-plan.md §2). `agent-sdk` (independently selectable) is
 * a reserved public id with NO registration yet — selecting it MUST resolve
 * to `unsupported_execution_variant` until a later phase implements and
 * registers it; the same held true for `sdk-facade` until phase 6
 * (`claude-sdk-facade.ts`/`claude-sdk-facade-capture.ts`,
 * 12-hermes-adoption-plan.md H1-H4) implemented and registered it below.
 * Adding a registration is how a reservation becomes a real, selectable
 * integration; it is never done by widening this file's literal set alone.
 */
export const PROVIDER_EXECUTION_REGISTRY: readonly TProviderExecutionRegistration[] =
  [
    {
      provider: "claude_code",
      // Other callers need a vendor runtime; the facade supports both tools
      // and history replay (routing-variants-bench.md, run 1790691747528).
      defaultSelection: executionSelectionHandrolled(),
      policyFallbackSelection: executionSelectionBridge("sdk-facade", true),
      variants: ["stream-json", "sdk-facade", "handrolled"],
      captureVariants: ["stream-json", "sdk-facade"],
    },
    {
      provider: "chatgpt",
      defaultSelection: executionSelectionHandrolled(),
      variants: ["app-server", "handrolled"],
      captureVariants: ["app-server"],
    },
    {
      provider: "cursor",
      defaultSelection: executionSelectionBridge("acp", false),
      variants: ["acp"],
      captureVariants: ["acp"],
    },
    {
      provider: "muse",
      defaultSelection: executionSelectionBridge("msp", true),
      variants: ["msp"],
      captureVariants: ["msp"],
    },
    {
      provider: "antigravity",
      defaultSelection: executionSelectionBridge("acp", false),
      variants: ["acp"],
      captureVariants: [],
    },
    {
      provider: "kimi_code",
      defaultSelection: executionSelectionHandrolled(),
      variants: ["handrolled"],
      captureVariants: [],
    },
    {
      provider: "grok",
      defaultSelection: executionSelectionHandrolled(),
      variants: ["handrolled"],
      captureVariants: [],
    },
  ];

const registrationFor = (
  provider: string,
): TProviderExecutionRegistration | undefined =>
  PROVIDER_EXECUTION_REGISTRY.find((entry) => entry.provider === provider);

/** Handrolled is not eligible for non-first-party Claude callers. */
export const defaultExecutionSelectionFor = (
  provider: string,
  originator?: { readonly isClaudeCode: boolean },
): TExecutionSelection | null => {
  const registration = registrationFor(provider);
  if (registration === undefined) return null;
  if (provider === "claude_code" && originator?.isClaudeCode !== true) {
    return registration.policyFallbackSelection ?? null;
  }
  return registration.defaultSelection;
};

export const registeredVariantsFor = (
  provider: string,
): readonly TExecutionVariant[] => registrationFor(provider)?.variants ?? [];

export const providerSupportsVariant = (
  provider: string,
  variant: TExecutionVariant,
): boolean => registeredVariantsFor(provider).includes(variant);

/** Capture support is declared by the provider's captureVariants subset. */
export const providerSupportsCaptureFor = (
  provider: string,
  variant: TExecutionVariant,
): boolean =>
  registrationFor(provider)?.captureVariants.some(
    (captureVariant) => captureVariant === variant,
  ) ?? false;

/** The provider's first capture-capable variant, with capture on — null
 *  when it registers none. */
export const captureSelectionFor = (
  provider: string,
): TExecutionSelection | null => {
  const variant = registrationFor(provider)?.captureVariants[0];
  return variant === undefined ? null : executionSelectionBridge(variant, true);
};

/** Whether the provider registers any capture-capable variant. */
export const providerDeclaresBridgeCapture = (provider: string): boolean =>
  (registrationFor(provider)?.captureVariants.length ?? 0) > 0;

/**
 * Provider/variant combinations whose request-shape support is not yet
 * proven — checked independently of capture. Per
 * 09-implementation-plan.md §2 ("Claude CLI tool scope"): Claude's explicit
 * `stream-json` (direct CLI) integration is proven for TEXT only; caller
 * tools on an explicit `stream-json`/`stream-json-capture` selection must
 * refuse pre-dispatch rather than silently falling back to the held Agent
 * SDK (`agent-sdk`) — that would defeat the whole point of an explicit
 * selection.
 * this check runs for every concrete selection.
 */
const requestShapeUnsupportedFor = (
  provider: string,
  variant: TBridgeVariant,
  requestShape: { readonly hasClientTools: boolean } | undefined,
): string | null => {
  if (
    provider === "claude_code" &&
    variant === "stream-json" &&
    requestShape?.hasClientTools === true
  ) {
    return "claude_code stream-json has no proven caller-tool integration yet — refusing rather than silently invoking the official Agent SDK";
  }
  return null;
};

/** Typed refusal for a concrete selection this registry
 *  cannot honor. */
export type TExecutionSelectionRefusal =
  | {
      readonly kind: "unsupported_execution_variant";
      readonly provider: string;
      readonly variant: TExecutionVariant;
    }
  | {
      readonly kind: "capture_not_supported";
      readonly provider: string;
      readonly variant: TBridgeVariant;
    }
  | {
      /** The variant/provider pair is registered, but THIS request's shape
       *  (e.g. caller tools) is not yet a proven combination — see
       *  {@link requestShapeUnsupportedFor}. Distinct from
       *  `unsupported_execution_variant` (the pair itself is fine) and from
       *  `capture_not_supported` (a capture-eligibility fact, not a
       *  request-shape one). */
      readonly kind: "unsupported_execution_shape";
      readonly provider: string;
      readonly variant: TBridgeVariant;
      readonly reason: string;
    };

export type TExecutionSelectionResolution =
  | { readonly ok: true; readonly selection: TExecutionSelection }
  | { readonly ok: false; readonly refusal: TExecutionSelectionRefusal };

/**
 * Resolve one hop's concrete selection against this registry.
 * `requested === null` returns null (no selection to validate).
 *
 * The genuine-Claude-Code-originator override mirrors
 * `sub-method.ts#resolveHopExecution`'s ToS-alignment rule exactly: a request
 * that is itself the real Claude Code client always resolves to
 * `handrolled`, beating any configured preference, because forwarding the
 * genuine client's own request on its own credential IS the official-
 * client flow.
 *
 * `requestShape` folds in the ONE request-shape gate this baseline defines
 * (Claude `stream-json` + caller tools — see
 * {@link requestShapeUnsupportedFor}); a caller with no request-shape
 * concerns (or resolving a non-Claude/non-stream-json selection) may omit
 * it safely.
 */
export const resolveExecutionSelection = (
  provider: string,
  requested: TExecutionSelection | null,
  originator?: { readonly isClaudeCode: boolean },
  requestShape?: { readonly hasClientTools: boolean },
): TExecutionSelectionResolution | null => {
  if (requested === null) return null;
  if (provider === "claude_code" && originator?.isClaudeCode === true) {
    return { ok: true, selection: { kind: "handrolled" } };
  }
  const variant =
    requested.kind === "handrolled" ? "handrolled" : requested.variant;
  if (!providerSupportsVariant(provider, variant)) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported_execution_variant",
        provider,
        variant,
      },
    };
  }
  if (requested.kind === "handrolled") {
    return { ok: true, selection: requested };
  }
  const shapeReason = requestShapeUnsupportedFor(
    provider,
    requested.variant,
    requestShape,
  );
  if (shapeReason !== null) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported_execution_shape",
        provider,
        variant: requested.variant,
        reason: shapeReason,
      },
    };
  }
  if (
    requested.capture &&
    !providerSupportsCaptureFor(provider, requested.variant)
  ) {
    return {
      ok: false,
      refusal: {
        kind: "capture_not_supported",
        provider,
        variant: requested.variant,
      },
    };
  }
  return { ok: true, selection: requested };
};

/** Human-readable diagnostic for a typed refusal — used by native-runtime
 *  serve sites as the pre-dispatch decline reason (never a fallback to
 *  another variant; see 09-implementation-plan.md §4.1). */
export const describeExecutionSelectionRefusal = (
  refusal: TExecutionSelectionRefusal,
): string => {
  if (refusal.kind === "unsupported_execution_variant") {
    return `${refusal.provider} has no registered ${refusal.variant} execution variant`;
  }
  if (refusal.kind === "capture_not_supported") {
    return `${refusal.provider} does not support capture for ${refusal.variant}`;
  }
  return refusal.reason;
};
