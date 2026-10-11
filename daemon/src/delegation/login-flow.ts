/**
 * Shared, provider-agnostic login-flow scaffolding for the subscription
 * delegates.
 *
 * The three delegates (`claude-code`, `chatgpt`, `kimi-code`) each expose up to
 * two login methods on `TProviderDelegate`: `connect()` (the on-this-box native
 * login) and `connectDeviceCode()` (the remote/headless login). The orchestration
 * around those — the install-check + already-signed-in preamble, the single-flight
 * guard, the background-exit cleanup, and the codex stream-spawn reader loop —
 * is identical across providers and used to be copy-pasted into each delegate.
 * It lives here once; the per-method adaptors (`login-direct`, `login-device`)
 * build on it, and the delegates inject only their provider-specifics (token
 * store, parse fns, keychain hooks).
 *
 * The single-flight `loginSlot` is keyed by provider and SHARED between the two
 * adaptors so a provider whose `connect` + `connectDeviceCode` must not run at
 * once (codex: one `codex login` process binds the localhost callback / polls)
 * stays guarded across both methods.
 */

import type {
  TAuthLoginFailedCode,
  TAuthLoginMode,
  TDaemonProviderReasonCode,
  TDoctorAuthPhase,
} from "@openllmsh/protocol";
import {
  classifyFailureOutput,
  projectDoctorOutcomeLedger,
} from "@openllmsh/protocol";
import {
  admitVerifiedLogin,
  emitAuth,
  requestStatusPush,
} from "../auth-events";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { opaqueDoctorCorrelation } from "../doctor-report/correlation";
import { logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import type { TLoginCommandContext } from "../op-context";
import {
  currentLoginCommandContext,
  currentLoginCommandCorrelation,
  runWithLoginCommand,
} from "../op-context";
import {
  inspectHostCliRuntime,
  isCliRuntimeMissingOutput,
} from "../path-utils";
import type { TPendingAuth } from "../pending-auth";
import {
  clearPendingAuth,
  getPendingAuth,
  isPromptPending,
  pendingAuthDetail,
  setPendingAuth,
  setPendingAuthOwnerLive,
} from "../pending-auth";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { KEYCHAIN_NOT_READY_DETAIL } from "./login-readiness";
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  mergeSpawnEnv,
  redactUrls,
  spawnCwd,
  spawnEnv,
} from "./spawn";
import { openUrl } from "./util";

/** The shared return shape of `connect()` / `connectDeviceCode()`. */
export type TConnectResult = {
  readonly connected: boolean;
  readonly detail?: string;
  readonly pending?: boolean;
};

/** One in-flight login's identity — `flowId` is the browser/relay command id. */
export type TLoginFlowCtx = {
  readonly flowId: string;
  readonly keyId: string;
  readonly slug: string;
  readonly mode: TAuthLoginMode;
  readonly localOnly?: boolean;
};

// ─── Per-command flow identity (threaded from control-relay) ─────────────
// ALS lives in op-context (single ALS root). Re-export for existing callers.

export type { TLoginCommandContext };
export { currentLoginCommandCorrelation, runWithLoginCommand };

export const resolveLoginFlow = (
  slug: string,
  mode: TAuthLoginMode,
): TLoginFlowCtx => {
  const bound = currentLoginCommandContext();
  return {
    flowId: bound?.flowId ?? crypto.randomUUID(),
    keyId: bound?.keyId ?? "local",
    ...(bound?.localOnly === true ? { localOnly: true } : {}),
    slug,
    mode,
  };
};

// ─── Per-provider single-flight slot ─────────────────────────────────────

/**
 * One provider's login single-flight state, shared by its direct + device
 * adaptors. Holds the in-flight flag plus the set of cancelers a live
 * background flow registers — killing a spawned process (codex), setting an
 * abort flag (kimi's poll), or `THeadlessLogin.cancel()` (claude paste-back).
 * `cancelConnect` runs them all.
 */
export type TLoginSlot = {
  /** True while a login operation owns this provider. */
  readonly inFlight: () => boolean;
  /** The live flow's identity, or null when nothing is in flight. */
  readonly flow: () => TLoginFlowCtx | null;
  /** Immutable start time for the current owner; 0 when idle. */
  readonly startedAtMs: () => number;
  /** True after {@link TLoginSlot.cancelAll} until matching {@link TLoginSlot.end}. */
  readonly wasCancelled: () => boolean;
  /** Unconfirmed child cleanup — retain containment. */
  readonly cleanupUnknown: () => boolean;
  readonly markCleanupUnknown: () => void;
  /**
   * Reserve ownership and register a canceler. Safe before spawn. Does not
   * clear an earlier cancellation flag (a second start must not revive a
   * cancelled flow).
   */
  readonly start: (canceler: () => void, flow?: TLoginFlowCtx) => boolean;
  /** Release ownership for this flow only. */
  readonly end: (flowId?: string) => void;
  /** Signal cancelers; leave ownership until matching {@link TLoginSlot.end}. */
  readonly cancelAll: () => number;
};

const slots = new Map<string, TLoginSlot>();

/** The memoized single-flight slot for `provider` (created on first use). */
export const loginSlot = (provider: string): TLoginSlot => {
  const existing = slots.get(provider);
  if (existing !== undefined) return existing;
  let inFlight = false;
  let cancelled = false;
  let cleanupUnknown = false;
  let startedAtMs = 0;
  let flow: TLoginFlowCtx | null = null;
  const cancelers = new Set<() => void>();
  const slot: TLoginSlot = {
    inFlight: () => inFlight,
    flow: () => flow,
    startedAtMs: () => startedAtMs,
    wasCancelled: () => cancelled,
    cleanupUnknown: () => cleanupUnknown,
    markCleanupUnknown: () => {
      cleanupUnknown = true;
    },
    start: (canceler, nextFlow) => {
      if (applyHeld) {
        try {
          canceler();
        } catch {
          // apply in progress — do not take ownership
        }
        return false;
      }
      inFlight = true;
      if (nextFlow !== undefined) flow = nextFlow;
      if (startedAtMs === 0) startedAtMs = Date.now();
      if (cancelled) {
        try {
          canceler();
        } catch {
          // already gone
        }
        return true;
      }
      cancelers.add(canceler);
      return true;
    },
    end: (flowId) => {
      if (flowId !== undefined && flow !== null && flow.flowId !== flowId) {
        return;
      }
      inFlight = false;
      cancelers.clear();
      flow = null;
      cancelled = false;
      cleanupUnknown = false;
      startedAtMs = 0;
    },
    cancelAll: () => {
      cancelled = true;
      const n = cancelers.size;
      for (const fn of cancelers) {
        try {
          fn();
        } catch {
          // already gone — the flow's own exit handler ran
        }
      }
      cancelers.clear();
      return n;
    },
  };
  slots.set(provider, slot);
  return slot;
};

setPendingAuthOwnerLive(
  (slug) => loginSlot(slug).inFlight(),
  () => {
    for (const slot of slots.values()) {
      if (slot.inFlight()) return true;
    }
    return false;
  },
);

let applyHeld = false;

/** Exclusive with login slot.start. Hold across background daemon reexec. */
export const tryBeginDaemonApply = (): boolean => {
  if (applyHeld) return false;
  if (logoutOps.size > 0) return false;
  for (const slot of slots.values()) {
    if (slot.inFlight()) return false;
  }
  applyHeld = true;
  return true;
};

export const endDaemonApply = (): void => {
  applyHeld = false;
};

export const daemonApplyActive = (): boolean => applyHeld;

/** Non-secret marker for a live owner — TTL does not expire this. */
export const loginOwnershipPending = (
  slug: string,
): {
  readonly pending: true;
  readonly flow_id: string;
  readonly started_at_ms: number;
  readonly cancel_requested: boolean;
} | null => {
  const slot = loginSlot(slug);
  const flow = slot.flow();
  if (!slot.inFlight() || flow === null) return null;
  return {
    pending: true,
    flow_id: flow.flowId,
    started_at_ms: slot.startedAtMs(),
    cancel_requested: slot.wasCancelled(),
  };
};

/** Providers whose logout is in flight (login uses {@link loginSlot}). */
const logoutOps = new Set<string>();

/** Mark logout as the owner of this provider's auth until verification ends. */
export const beginProviderAuthOperation = (slug: string): void => {
  logoutOps.add(slug);
};

export const endProviderAuthOperation = (slug: string): void => {
  logoutOps.delete(slug);
};

/**
 * True while this provider's login OR logout operation owns auth.
 * Sticky post-logout signed_out is not included — that lives on status.
 */
export const providerAuthOperationActive = (slug: string): boolean =>
  logoutOps.has(slug) || loginSlot(slug).inFlight();

/** Logout owns this provider (login in-flight is a separate slot). */
export const providerLogoutActive = (slug: string): boolean =>
  logoutOps.has(slug);

export const resetProviderAuthOperationsForTests = (): void => {
  logoutOps.clear();
  applyHeld = false;
  for (const slot of slots.values()) {
    slot.end();
  }
};

/** Wrap logout (or other auth mutation) so observers see an active operation. */
export const runWithAuthOperation = async <T>(
  slug: string,
  work: () => Promise<T>,
): Promise<T> => {
  beginProviderAuthOperation(slug);
  try {
    return await work();
  } finally {
    endProviderAuthOperation(slug);
  }
};

/**
 * Open the vendor auth URL on the daemon's box ONLY if the login wasn't
 * cancelled in the race window between parsing the prompt and this call. A
 * `cancel_connect` can land after `spawnStreamLogin` resolved / `requestDeviceAuth`
 * returned but before we open the browser; without this a browser tab would pop
 * on the user AFTER they stopped the flow — and, worse, on the device-code path
 * the subsequent `slot.start()` clears `wasCancelled`, so this is the last point
 * the cancel is still observable. Returns whether it opened (false ⇒ cancelled,
 * so the caller must abort the flow instead of surfacing a prompt). Best-effort:
 * a status/UI cancel already tore down the dashboard side.
 */
export const openAuthUrlUnlessCancelled = (
  slot: TLoginSlot,
  url: string,
): boolean => {
  if (slot.wasCancelled()) return false;
  openUrl(url);
  return true;
};

// ─── Auth event helpers ──────────────────────────────────────────────────

export const emitLoginStarted = (flow: TLoginFlowCtx): void => {
  emitAuth({
    event: "auth.login.started",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    mode: flow.mode,
  });
};

export const emitLoginPrompt = (
  flow: TLoginFlowCtx,
  pending: { readonly url: string; readonly code: string },
): void => {
  // Local login prompts belong only to the authenticated initiating flow.
  if (flow.localOnly === true) return;
  emitAuth({
    event: "auth.login.prompt",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    url: pending.url,
    ...(pending.code.length > 0 ? { code: pending.code } : {}),
    mode: flow.mode,
  });
};

/** Store the pending snapshot then emit `auth.login.prompt` — the pair every
 *  live login uses once a URL (± code) is known. `flow.flowId` is stamped onto
 *  the stored snapshot; `mode` is only written when the caller supplies it
 *  (`paste_code`). Order matches the former inline pair. */
export const publishPendingAuth = (
  flow: TLoginFlowCtx,
  provider: string,
  pending: {
    readonly url: string;
    readonly code: string;
    readonly mode?: TPendingAuth["mode"];
  },
): void => {
  setPendingAuth(provider, {
    url: pending.url,
    code: pending.code,
    ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
    flowId: flow.flowId,
    ...(flow.localOnly === true ? { localOnly: true } : {}),
  });
  emitLoginPrompt(flow, { url: pending.url, code: pending.code });
};

export const emitLoginSucceeded = (flow: TLoginFlowCtx): boolean => {
  if (!admitVerifiedLogin({ slug: flow.slug, flowId: flow.flowId })) {
    return false;
  }
  noteAuthStoreIdentityChange(flow.slug);
  emitAuth({
    event: "auth.login.succeeded",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
  });
  requestStatusPush();
  return true;
};

const loginFailureMessage = (
  code: TAuthLoginFailedCode,
  reasonCode?: TDaemonProviderReasonCode,
): ReturnType<typeof safeDiagnosticMessage> => {
  if (code === "poll_expired" || code === "prompt_timeout") {
    return safeDiagnosticMessage`The login time budget expired.`;
  }
  if (reasonCode === "cli_runtime_missing") {
    return safeDiagnosticMessage`Login needs a runtime the daemon cannot find.`;
  }
  return safeDiagnosticMessage`Login ended in an unexpected failure.`;
};

export const emitLoginFailed = (
  flow: TLoginFlowCtx,
  fail: {
    readonly code: TAuthLoginFailedCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly reason_code?: TDaemonProviderReasonCode;
  },
): void => {
  // Remote-diagnosable failure record: the closed failure code + a LOCAL
  // classification of the message (which carries the redacted CLI output),
  // never the message itself. Every login failure funnels through here, so
  // this covers the stream, device-code, paste and background paths alike.
  if (fail.code !== "user_cancelled") {
    try {
      const correlation_id = opaqueDoctorCorrelation(flow.flowId);
      logWarn(
        "login-flow",
        loginFailureMessage(fail.code, fail.reason_code),
        undefined,
        {
          ...(correlation_id !== undefined ? { correlation_id } : {}),
          ...projectDoctorOutcomeLedger({
            provider: flow.slug,
            operation_kind: "login",
            outcome: "failed",
            login_failure_code: fail.code,
            failure_signature: classifyFailureOutput(fail.message),
            ...(fail.reason_code !== undefined
              ? { reason_code: fail.reason_code }
              : {}),
          }),
        },
      );
    } catch {
      // Reporting must never change login outcome.
    }
  }
  emitAuth({
    event: "auth.login.failed",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    code: fail.code,
    message: fail.message,
    retryable: fail.retryable,
    ...(fail.reason_code !== undefined
      ? { reason_code: fail.reason_code }
      : {}),
  });
};

/**
 * Shared login-terminal finalizer (audit A4): emit succeeded/failed (or
 * nothing), optionally drop pending-auth, then request a status push.
 * Callers keep polling-specific work (`slot.end`, connection re-read,
 * `onConnected`) and decide which event to emit so stream vs device-code
 * cancel/success semantics stay distinct.
 */
/** Local-only failing phase marker for paste/stream terminals (not on the wire). */
export type TLoginFailedAtPhase = Extract<
  TDoctorAuthPhase,
  "readiness" | "prep"
>;

export type TLoginTerminalEvent =
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly code: TAuthLoginFailedCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly reason_code?: TDaemonProviderReasonCode;
      /** Internal: emit one INFO phase breadcrumb before the terminal ledger. */
      readonly failedAt?: TLoginFailedAtPhase;
    }
  | { readonly kind: "none" };

const FAILED_AT_MESSAGE: Record<
  TLoginFailedAtPhase,
  ReturnType<typeof safeDiagnosticMessage>
> = {
  readiness: safeDiagnosticMessage`Native authentication readiness completed.`,
  prep: safeDiagnosticMessage`Native authentication preparation completed.`,
};

export const finalizeLoginTerminal = (opts: {
  readonly flow: TLoginFlowCtx | null;
  readonly event: TLoginTerminalEvent;
  readonly provider: string;
  readonly clearPending: boolean;
}): void => {
  if (
    opts.flow === null &&
    opts.event.kind === "failed" &&
    opts.event.code !== "user_cancelled"
  ) {
    // Flow-less terminal: `emitLoginFailed` (which records the classified
    // failure) never runs, so record it here.
    logWarn(
      "login-flow",
      loginFailureMessage(opts.event.code, opts.event.reason_code),
      undefined,
      projectDoctorOutcomeLedger({
        provider: opts.provider,
        operation_kind: "login",
        outcome: "failed",
        login_failure_code: opts.event.code,
        failure_signature: classifyFailureOutput(opts.event.message),
        ...(opts.event.reason_code !== undefined
          ? { reason_code: opts.event.reason_code }
          : {}),
      }),
    );
  }
  if (opts.flow !== null) {
    const admitted =
      opts.event.kind === "succeeded" ? emitLoginSucceeded(opts.flow) : false;
    if (opts.event.kind === "failed") {
      emitLoginFailed(opts.flow, {
        code: opts.event.code,
        message: opts.event.message,
        retryable: opts.event.retryable,
        ...(opts.event.reason_code !== undefined
          ? { reason_code: opts.event.reason_code }
          : {}),
      });
    }
    const correlation_id = opaqueDoctorCorrelation(opts.flow.flowId);
    const outcome =
      opts.event.kind === "succeeded"
        ? admitted
          ? "succeeded"
          : "cancelled"
        : opts.event.kind === "failed" && opts.event.code === "user_cancelled"
          ? "cancelled"
          : opts.event.kind === "failed" &&
              (opts.event.code === "poll_expired" ||
                opts.event.code === "prompt_timeout")
            ? "timeout"
            : opts.event.kind === "failed"
              ? "failed"
              : undefined;
    const failureExtras =
      opts.event.kind === "failed"
        ? {
            login_failure_code: opts.event.code,
            failure_signature: classifyFailureOutput(opts.event.message),
            ...(opts.event.reason_code !== undefined
              ? {
                  reason_code: opts.event.reason_code,
                  observation: "unknown" as const,
                }
              : {}),
          }
        : {};
    try {
      if (opts.event.kind === "failed" && opts.event.failedAt !== undefined) {
        const phaseLedger = projectDoctorOutcomeLedger({
          provider: opts.provider,
          operation_kind: "login",
          phase: opts.event.failedAt,
          ...(outcome !== undefined ? { outcome } : {}),
          ...failureExtras,
        });
        logInfo(
          "login-flow",
          FAILED_AT_MESSAGE[opts.event.failedAt],
          { phase: opts.event.failedAt },
          {
            ...(correlation_id !== undefined ? { correlation_id } : {}),
            ...phaseLedger,
          },
        );
      }
      const ledger = projectDoctorOutcomeLedger({
        provider: opts.provider,
        operation_kind: "login",
        phase: "terminal",
        ...(outcome !== undefined ? { outcome } : {}),
        ...(admitted ? { observation: "connected" } : {}),
        ...failureExtras,
      });
      logInfo(
        "login-flow",
        safeDiagnosticMessage`Native authentication attempt finished.`,
        { phase: "terminal" },
        {
          ...(correlation_id !== undefined ? { correlation_id } : {}),
          ...ledger,
        },
      );
    } catch {
      // Reporting must never change login outcome.
    }
  }
  if (opts.clearPending) {
    clearPendingAuth(opts.provider, opts.flow?.flowId);
  }
  requestStatusPush();
};

const CAPTURE_MAX = 400;

const captureBody = (captured: string): string =>
  redactUrls(captured).slice(0, CAPTURE_MAX).trim();

const isInnerSpawnDenied = (
  captured: string,
  exitCode: number | null,
): boolean =>
  exitCode === 127 &&
  /EPERM|posix_spawn|operation not permitted/i.test(captured);

/**
 * Optional provider mapper for a non-zero login-child exit. Used by
 * pre-prompt `streamLoginFail` (`crashDetail`) and, separately, by an
 * explicit background opt-in (`backgroundCrashDetail`) — forwarding the
 * pre-prompt mapper into background would change Grok/ChatGPT behaviour.
 */
export type TStreamLoginCrashDetail = (
  captured: string,
  exitCode: number | null,
) => string;

/**
 * Map a stream-login miss onto an `auth.login.failed` code + the dashboard
 * `detail`. The static `failDetail` is a TITLE — the body is the redacted
 * capture (and `[code]` for an outer spawn throw). Never the title alone
 * when we have anything else to say.
 */
export const streamLoginFail = (
  title: string,
  res: Extract<TStreamLoginResult<unknown>, { found: null }>,
  crashDetail?: TStreamLoginCrashDetail,
): {
  readonly code: TAuthLoginFailedCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly reason_code?: TDaemonProviderReasonCode;
} => {
  if (res.spawnFailure !== undefined) {
    return {
      code: "spawn_denied",
      message: `${title} [${res.spawnFailure.code}] ${res.spawnFailure.message}`,
      retryable: res.spawnFailure.code === "spawn_denied",
    };
  }
  const body = captureBody(res.captured);
  const titled =
    body.length > 0
      ? `${title}
${body}`
      : title;
  if (isInnerSpawnDenied(res.captured, res.exitCode)) {
    return { code: "spawn_denied", message: titled, retryable: false };
  }
  if (res.crashed && isCliRuntimeMissingOutput(res.captured)) {
    const message =
      crashDetail !== undefined
        ? crashDetail(res.captured, res.exitCode)
        : titled;
    return {
      code: "cli_crash",
      message,
      retryable: false,
      reason_code: "cli_runtime_missing",
    };
  }
  if (res.crashed) {
    return {
      code: "cli_crash",
      message:
        crashDetail !== undefined
          ? crashDetail(res.captured, res.exitCode)
          : titled,
      retryable: false,
    };
  }
  if (res.timedOut === true) {
    return { code: "prompt_timeout", message: titled, retryable: true };
  }
  return { code: "poll_expired", message: titled, retryable: true };
};

// ─── Guard preamble ──────────────────────────────────────────────────────

export type TGuardOpts = {
  readonly provider: string;
  /** Whether the vendor CLI is installed; a `false` returns `installHint`. */
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Optional already-signed-in short-circuit (codex/kimi/claude-device). */
  readonly shortCircuit?: {
    readonly connected: () => Promise<boolean>;
    readonly detail: string;
  };
  /** Optional single-flight slot — when in-flight, re-surface instead of
   *  spawning a second login. Absent ⇒ no single-flight (claude's blocking
   *  `connect`, which simply blocks in the spawned login). */
  readonly slot?: TLoginSlot;
  /** Fallback re-surface detail when no pending-auth is live. */
  readonly inProgressDetail?: string;
  /** Override the default re-surface result (kimi's `connect` returns a fixed
   *  string with no `pending` flag, unlike codex/claude's pending re-surface). */
  readonly resurface?: (pending: TPendingAuth | null) => TConnectResult;
  /** Login mode for events fired from the preamble (not_installed / short-circuit
   *  / in-flight re-prompt). Default `browser`. */
  readonly mode?: TAuthLoginMode;
};

/**
 * Run the shared login preamble, then `run()` if it clears: not-installed →
 * `installHint`; in-flight single-flight re-surface (before expensive
 * connected verification); already-signed-in short-circuit (clears any stale
 * pending); otherwise start the flow.
 */
export const guard = async (
  opts: TGuardOpts,
  run: () => Promise<TConnectResult>,
): Promise<TConnectResult> => {
  const mode = opts.mode ?? "browser";
  if (!(await opts.installed())) {
    const flow = resolveLoginFlow(opts.provider, mode);
    emitLoginFailed(flow, {
      code: "not_installed",
      message: opts.installHint,
      retryable: false,
    });
    return { connected: false, detail: opts.installHint };
  }
  if (opts.slot?.inFlight() === true) {
    const pending = getPendingAuth(opts.provider);
    const live = opts.slot.flow();
    if (pending !== null && live !== null && isPromptPending(pending)) {
      emitLoginPrompt(live, {
        url: pending.url ?? "",
        code: pending.code ?? "",
      });
    }
    if (opts.resurface !== undefined) return opts.resurface(pending);
    return {
      connected: false,
      pending: true,
      detail:
        pending !== null
          ? pendingAuthDetail(pending)
          : (opts.inProgressDetail ??
            "Sign-in already in progress — this updates automatically."),
    };
  }
  if (
    opts.shortCircuit !== undefined &&
    (await opts.shortCircuit.connected())
  ) {
    clearPendingAuth(opts.provider);
    const flow = resolveLoginFlow(opts.provider, mode);
    if (!emitLoginSucceeded(flow)) {
      return {
        connected: false,
        detail: "sign-in is no longer the active attempt",
      };
    }
    return { connected: true, detail: opts.shortCircuit.detail };
  }
  return run();
};

// ─── Background-exit cleanup ─────────────────────────────────────────────

/** Verification watchdog after child exit — matches Claude `AUTH_STATUS_TIMEOUT_MS`. */
export const LOGIN_VERIFY_WATCHDOG_MS = 4_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Typed login observation: never collapse timeout/throw to signed-out. */
export type TLoginVerify = {
  readonly state: "connected" | "absent" | "unavailable";
};

export const booleanLoginVerify = async (
  check: () => Promise<boolean>,
): Promise<TLoginVerify> => {
  try {
    return { state: (await check()) ? "connected" : "absent" };
  } catch {
    return { state: "unavailable" };
  }
};

const sampleVerify = async (
  verify: () => Promise<TLoginVerify>,
): Promise<TLoginVerify> => {
  try {
    return await verify();
  } catch {
    return { state: "unavailable" };
  }
};

/** Race a store-lifecycle hint against a finite watchdog, then abort the hint. */
export const waitLoginVerifyHint = async (opts: {
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs: number;
}): Promise<void> => {
  const ac = new AbortController();
  const watchdog = sleep(opts.verifyWatchdogMs);
  const hint =
    opts.waitStoreHint !== undefined
      ? opts.waitStoreHint(ac.signal).then(
          () => undefined,
          () => undefined,
        )
      : watchdog;
  await Promise.race([watchdog, hint]);
  ac.abort();
};

/**
 * The cleanup a background login runs when its process exits / its poll ends:
 * keep the slot in verifying phase until terminal classify, then — if a
 * credential landed — run `onConnected` (e.g. refresh the auth config), else
 * drop the stale pending code so the card stops showing a dead one.
 * `alwaysClearPending` also drops it on success (claude's paste-back clears
 * unconditionally; codex/kimi rely on `status()`).
 *
 * Typed verify: `connected` / `absent` / `unavailable`. Unavailable after
 * child exit waits for a store-identity hint or a finite watchdog, then one
 * reread — not a 400ms sleep as truth. Emits `auth.login.succeeded` or
 * `auth.login.failed` and triggers a status push. Explicit cancellation
 * always wins; a superseded `flowId` must not clear a newer pending.
 */
export const finishInBackground = async (opts: {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly verify: () => Promise<TLoginVerify>;
  /** Resolves when the credential store identity changes (hint, not truth). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  /** Finite verification watchdog. Default {@link LOGIN_VERIFY_WATCHDOG_MS}. */
  readonly verifyWatchdogMs?: number;
  /** Runs after a credential lands. Returning `false` marks the login FAILED
   *  (e.g. the keychain partition-list grant was refused) — see below. */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  readonly alwaysClearPending?: boolean;
  /** Child exit code when known. Non-zero + absent → `cli_crash`;
   *  unavailable after a live child is retryable, never `cli_crash` from unread store. */
  readonly exitCode?: number | null;
  /** Combined stdout+stderr capture when the child exited (for mapping). */
  readonly captured?: string;
  /**
   * Explicit opt-in mapping for genuine nonzero disconnected exits only.
   * Separate from pre-prompt `crashDetail` so Grok/ChatGPT keep prior
   * background generics unless a provider opts in.
   */
  readonly backgroundCrashDetail?: TStreamLoginCrashDetail;
}): Promise<void> => {
  const flow = opts.slot.flow();
  const flowId = flow?.flowId;
  const stillThisFlow = (): boolean =>
    flowId !== undefined && opts.slot.flow()?.flowId === flowId;
  const watchdogMs = opts.verifyWatchdogMs ?? LOGIN_VERIFY_WATCHDOG_MS;

  const settleNone = (clearPending: boolean): void => {
    if (stillThisFlow()) opts.slot.end();
    finalizeLoginTerminal({
      flow,
      event: { kind: "none" },
      provider: opts.provider,
      clearPending,
    });
  };

  // Both callbacks are BEST-EFFORT: this runs from a `void proc.exited.then(...)`
  // / `void login.done.then(...)`, so a throw here would be an unhandled
  // rejection AND could skip `clearPendingAuth`.
  if (opts.slot.wasCancelled()) {
    settleNone(true);
    return;
  }
  if (!stillThisFlow()) {
    return;
  }
  let sampled = await sampleVerify(opts.verify);
  if (opts.slot.wasCancelled()) {
    settleNone(true);
    return;
  }
  if (!stillThisFlow()) {
    return;
  }
  if (sampled.state === "unavailable") {
    await waitLoginVerifyHint({
      waitStoreHint: opts.waitStoreHint,
      verifyWatchdogMs: watchdogMs,
    });
    if (opts.slot.wasCancelled()) {
      settleNone(true);
      return;
    }
    if (!stillThisFlow()) {
      return;
    }
    sampled = await sampleVerify(opts.verify);
    if (opts.slot.wasCancelled()) {
      settleNone(true);
      return;
    }
    if (!stillThisFlow()) {
      return;
    }
  }
  // An `onConnected` that returns `false` is an OBSERVED refusal (the keychain
  // partition-list grant), not a best-effort miss: the credential landed but the
  // daemon can't read it prompt-free, so the login is failed + retryable rather
  // than reported as succeeded. A THROW stays best-effort (swallowed) so cleanup
  // still runs and `clearPendingAuth` is never skipped.
  let grantDenied = false;
  if (sampled.state === "connected" && opts.onConnected !== undefined) {
    try {
      grantDenied = (await opts.onConnected()) === false;
    } catch {
      // best-effort — a failed onConnected must not reject the cleanup
    }
  }
  if (opts.slot.wasCancelled()) {
    settleNone(true);
    return;
  }
  if (!stillThisFlow()) {
    return;
  }
  // Only a definite non-zero exit code is a crash. `null` (killed by signal,
  // no exit code) and `undefined` (unknown) are NOT crashes — keep the
  // retryable poll_expired outcome rather than asserting a crash from an
  // ambiguous exit. Unreadable/timeout store is unavailable, not a crash.
  const crashed = typeof opts.exitCode === "number" && opts.exitCode !== 0;
  const GENERIC_BG_CRASH = "sign-in process exited before a credential landed";
  let disconnectedMessage = crashed
    ? GENERIC_BG_CRASH
    : "sign-in ended without a stored credential";
  if (crashed && opts.backgroundCrashDetail !== undefined) {
    // Mapper is best-effort — a throw must not skip finalize/cleanup.
    try {
      disconnectedMessage = opts.backgroundCrashDetail(
        opts.captured ?? "",
        opts.exitCode ?? null,
      );
    } catch {
      disconnectedMessage = GENERIC_BG_CRASH;
    }
  }
  const event: TLoginTerminalEvent =
    flow === null
      ? { kind: "none" }
      : sampled.state === "connected" && grantDenied
        ? {
            kind: "failed",
            code: "spawn_denied",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
            reason_code: "keychain_unavailable",
            failedAt: "prep",
          }
        : sampled.state === "connected"
          ? { kind: "succeeded" }
          : sampled.state === "unavailable"
            ? {
                kind: "failed",
                code: "poll_expired",
                message: "sign-in could not be verified",
                retryable: true,
              }
            : {
                kind: "failed",
                code: crashed ? "cli_crash" : "poll_expired",
                message: disconnectedMessage,
                retryable: !crashed,
              };
  const clearPending =
    opts.alwaysClearPending === true ||
    sampled.state !== "connected" ||
    grantDenied;
  // Admit verified Connected while this flow still owns the slot.
  if (event.kind === "succeeded") {
    finalizeLoginTerminal({
      flow,
      event,
      provider: opts.provider,
      clearPending,
    });
    if (stillThisFlow()) opts.slot.end();
    return;
  }
  opts.slot.end();
  finalizeLoginTerminal({
    flow,
    event,
    provider: opts.provider,
    clearPending,
  });
};

// ─── Stream-spawn login primitive (codex) ────────────────────────────────

/**
 * First-prompt *warn* mark. A still-alive child is NOT killed here — we keep
 * reading until parse, self-exit, or {@link DEFAULT_LOGIN_TIMEOUT_MS}.
 */
const STREAM_PROMPT_WARN_MS = 30_000;

export type TStreamLoginOpts<T> = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly argv: ReadonlyArray<string>;
  /** Override map. Values of `undefined` delete the key from the child env
   *  (see {@link mergeSpawnEnv}) so ambient secrets like `META_API_KEY` can be
   *  stripped. */
  readonly env: Record<string, string | undefined>;
  /** Which fd carries the prompt: codex `login` prints the authorize URL to
   *  stderr; `codex login --device-auth` prints the device prompt to stdout. */
  readonly stream: "stdout" | "stderr";
  /** Returns the parsed prompt the instant the buffered output contains it. */
  readonly parse: (buf: string) => T | null;
  /** Hard ceiling (default {@link DEFAULT_LOGIN_TIMEOUT_MS}). Not the 30s
   *  first-prompt warn. */
  readonly timeoutMs?: number;
  /** First-prompt WARN threshold (default {@link STREAM_PROMPT_WARN_MS}) — logs
   *  a "still waiting" line, never kills. Overridable so a test can assert the
   *  no-kill behaviour without a 30s wait. */
  readonly warnMs?: number;
  /** Typed connection check for the background-exit cleanup. */
  readonly verify: () => Promise<TLoginVerify>;
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs?: number;
  /** Runs in the background-exit cleanup when a credential landed. Returning
   *  `false` fails the login (see {@link finishInBackground}). */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  /** Skip the sandbox wrap (macOS keychain-dependent login — see
   *  `sandbox/policy.ts`). Set from `unwrapKeychainSpawn(provider)`. */
  readonly probe?: boolean;
  /** `auth.login.started` mode. Default `browser`. */
  readonly mode?: TAuthLoginMode;
  /**
   * Fires once when the child exits AFTER a prompt was parsed (background
   * completion path). Receives the exit code and a bounded combined
   * stdout+stderr capture so a provider can log privacy-safe diagnostics —
   * the shared terminal event still comes from {@link finishInBackground}.
   * Best-effort: a throw must not skip cleanup.
   */
  readonly onBackgroundExit?: (info: {
    readonly exitCode: number | null;
    readonly captured: string;
    readonly reaped: boolean;
  }) => void;
  /**
   * Explicit opt-in mapping for {@link finishInBackground} genuine nonzero
   * disconnected exits after a prompt was parsed. Omit (the default) to keep
   * the shared generic public message — do NOT reuse pre-prompt crashDetail.
   */
  readonly backgroundCrashDetail?: TStreamLoginCrashDetail;
};

/**
 * Spawn a vendor CLI login, drain BOTH fds (the prompt-carrying one is parsed;
 * the other is captured so an inner `--sandbox-exec` posix_spawn EPERM on
 * stderr is not dropped when the prompt is on stdout), and resolve the instant
 * `parse` matches — then keep draining for the process's lifetime so a full
 * pipe can't stall the child's background callback/poll. The process is NOT
 * killed on a match (it runs its localhost callback / device poll until the
 * credential lands); `proc.exited` runs {@link finishInBackground}. On no
 * match the child is reaped only at the hard login ceiling, not at 30s.
 *
 * Single-flight is reserved BEFORE spawn (apply-hold must not create a child).
 * A `Bun.spawn` throw releases only that matching `flowId`.
 */
const SPAWN_FAILURE_MAX_ERROR_CHARS = 400;

const redactSpawnFailure = (raw: string): string =>
  redactUrls(raw.slice(0, SPAWN_FAILURE_MAX_ERROR_CHARS)).trim();

type TSpawnFailure = Readonly<{
  readonly code: string;
  /** Short, redacted message suitable for surfacing to the dashboard. */
  readonly message: string;
}>;

const spawnFailureFromError = (error: unknown): TSpawnFailure => {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "unknown";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "no error message was provided";
  return { code, message: redactSpawnFailure(message) };
};

export type TStreamLoginResult<T> =
  | { readonly found: T }
  | {
      readonly found: null;
      readonly captured: string;
      readonly exitCode: number | null;
      /** True iff the child exited NON-ZERO on its own before printing a prompt
       *  — a deterministic failure a "Retry" can't fix (e.g. `grok login`
       *  crashing with a traceback). False for a benign prompt timeout, so the
       *  connect layer can surface the captured error only when it's real. */
      readonly crashed: boolean;
      /** Spawn-level failure (e.g. `EPERM`, `ENOENT`) with a short redacted
       *  message. Set when `Bun.spawn(...)` itself throws before a child exists.
       */
      readonly spawnFailure?: TSpawnFailure;
      /** True iff we hit the hard login ceiling and reaped a still-alive child. */
      readonly timedOut?: boolean;
      /** True iff `cancelConnect` killed this child while we were still waiting
       *  for a prompt — the cancel path already emitted `user_cancelled`. */
      readonly cancelled?: boolean;
      /** Captured before `slot.end()` so the handler can emit `failed` with the
       *  same `flow_id` as `started`. */
      readonly flow: TLoginFlowCtx;
    };

const drainStream = async (
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  try {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
  } catch {
    // peer closed — the prompt loop settles on EOF
  }
};

export const spawnStreamLogin = async <T>(
  opts: TStreamLoginOpts<T>,
): Promise<TStreamLoginResult<T>> => {
  const flow = resolveLoginFlow(opts.provider, opts.mode ?? "browser");
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  if (
    !opts.slot.start(() => {
      try {
        proc?.kill();
      } catch {
        // already exited — its own exit handler ran
      }
    }, flow)
  ) {
    return {
      found: null,
      captured: "daemon update in progress",
      exitCode: null,
      crashed: false,
      spawnFailure: {
        code: "spawn_denied",
        message: "daemon update in progress",
      },
      flow,
    };
  }
  try {
    proc = Bun.spawn(sandboxSpawnArgs(opts.argv, { probe: opts.probe }), {
      stdin: "ignore",
      // Always pipe BOTH fds: the prompt may be on stdout (device-code) while
      // the `--sandbox-exec` shim writes inner posix_spawn EPERM to stderr.
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(opts.env),
      env: spawnEnv(opts.env) ?? mergeSpawnEnv(process.env),
    });
  } catch (error) {
    opts.slot.end(flow.flowId);
    const spawnFailure = spawnFailureFromError(error);
    return {
      found: null,
      captured: spawnFailure.message,
      exitCode: null,
      crashed: false,
      spawnFailure,
      flow,
    };
  }
  if (proc === null) {
    opts.slot.end(flow.flowId);
    return {
      found: null,
      captured: "login spawn failed",
      exitCode: null,
      crashed: false,
      spawnFailure: { code: "unknown", message: "login spawn failed" },
      flow,
    };
  }
  const child = proc;
  emitLoginStarted(flow);
  try {
    const target = opts.argv[0];
    const runtime =
      typeof target === "string" ? inspectHostCliRuntime(target) : null;
    if (runtime !== null) {
      const correlation_id = opaqueDoctorCorrelation(flow.flowId);
      logInfo(
        "login-flow",
        safeDiagnosticMessage`Login spawn prepared.`,
        undefined,
        {
          ...(correlation_id !== undefined ? { correlation_id } : {}),
          ...projectDoctorOutcomeLedger({
            provider: flow.slug,
            operation_kind: "login",
            phase: "start",
          }),
          timings: {
            cli_is_script: runtime.kind === "script",
            interpreter_resolved: runtime.interpreterResolved,
          },
        },
      );
    }
  } catch {
    // Observation must never change login outcome.
  }

  const promptStream = (
    opts.stream === "stdout" ? child.stdout : child.stderr
  ) as ReadableStream<Uint8Array>;
  const otherStream = (
    opts.stream === "stdout" ? child.stderr : child.stdout
  ) as ReadableStream<Uint8Array>;
  let promptBuf = "";
  let otherBuf = "";
  const otherDone = drainStream(otherStream, (text) => {
    otherBuf += text;
  });
  const combined = (): string =>
    [promptBuf, otherBuf].filter((s) => s.length > 0).join("\n");
  // Set ONLY by the hard-ceiling timer. Distinguishes the two null outcomes:
  // a timeout (child still running → kill it, not a crash) vs the reader
  // reaching EOF because the child EXITED on its own before a prompt (a crash).
  let timedOut = false;
  const ceilingMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const found = await new Promise<T | null>((resolve) => {
    let settled = false;
    const settle = (v: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const warnMs = opts.warnMs ?? STREAM_PROMPT_WARN_MS;
    const warnTimer =
      ceilingMs > warnMs
        ? setTimeout(() => {
            if (!settled) {
              logWarn(
                "login-flow",
                safeDiagnosticMessage`Login is still waiting for an authorize prompt.`,
                { provider: opts.provider },
              );
            }
          }, warnMs)
        : null;
    const ceilingTimer = setTimeout(() => {
      timedOut = true;
      settle(null);
    }, ceilingMs);
    void (async (): Promise<void> => {
      try {
        await drainStream(promptStream, (text) => {
          promptBuf += text;
          const p = opts.parse(promptBuf) ?? opts.parse(combined());
          if (p !== null) settle(p);
        });
      } finally {
        if (warnTimer !== null) clearTimeout(warnTimer);
        clearTimeout(ceilingTimer);
        settle(null);
      }
    })();
  });

  if (found === null) {
    // Pull any remaining other-fd bytes so inner EPERM isn't dropped.
    await Promise.race([otherDone, sleep(200)]);
    const captured = combined();
    const cancelled = opts.slot.wasCancelled();
    if (!timedOut) {
      // The prompt reader hit EOF before the ceiling — the child normally has
      // already exited, so this resolves at once. Guard the rare case where the
      // fd closed but the process lingers: race a short grace and kill on
      // expiry, so a wedged child can't hang the connect indefinitely.
      const EXIT_GRACE_MS = 2_000;
      const exitCode = await Promise.race([
        child.exited,
        sleep(EXIT_GRACE_MS).then(() => null),
      ]);
      if (exitCode === null) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
      opts.slot.end();
      return {
        found: null,
        captured,
        exitCode,
        crashed: exitCode !== null && exitCode !== 0,
        cancelled,
        flow,
      };
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
    opts.slot.end();
    return {
      found: null,
      captured,
      exitCode: null,
      crashed: false,
      timedOut: true,
      cancelled,
      flow,
    };
  }

  // Prompt parsed: keep the child alive for the localhost callback / device
  // poll. finishInBackground is the ONLY terminal path from here.
  //
  // Abandonment ceiling: the child now holds its localhost callback / device
  // poll waiting for the user. If the user neither finishes NOR cancels, nothing
  // else bounds it — an abandoned `codex login` would sit alive holding that
  // callback indefinitely (leaking a process + a stale pending_auth). Reap it at
  // the login ceiling. A reap is an EXPIRY, not a crash, so report `exitCode: 0`
  // → `finishInBackground` emits `poll_expired` (not `cli_crash`); a login that
  // DID land a credential in the last moment still reports succeeded, since
  // `finishInBackground` checks typed verify before the exit code.
  let reaped = false;
  const reaper = setTimeout(() => {
    reaped = true;
    try {
      child.kill();
    } catch {
      // already exited — its own exit handler ran
    }
  }, ceilingMs);
  void child.exited.then(async (exitCode) => {
    clearTimeout(reaper);
    const finalExit = reaped ? 0 : exitCode;
    if (opts.onBackgroundExit !== undefined) {
      // Only opted-in diagnostics wait for the non-prompt stream remainder.
      // Existing providers keep their original completion timing.
      await Promise.race([otherDone, sleep(200)]);
      try {
        opts.onBackgroundExit({
          exitCode: finalExit,
          captured: combined(),
          reaped,
        });
      } catch {
        // best-effort — never skip finishInBackground
      }
    }
    return finishInBackground({
      provider: opts.provider,
      slot: opts.slot,
      verify: opts.verify,
      waitStoreHint: opts.waitStoreHint,
      verifyWatchdogMs: opts.verifyWatchdogMs,
      onConnected: opts.onConnected,
      exitCode: finalExit,
      captured: combined(),
      backgroundCrashDetail: opts.backgroundCrashDetail,
    });
  });
  return { found };
};

// ─── cancelConnect ───────────────────────────────────────────────────────

/**
 * Build the delegate's `cancelConnect`: run the in-flight flow's canceler(s)
 * via the shared slot + drop the pending code. Idempotent — no in-flight flow
 * is success. The `messages` carry the provider's wording.
 */
export const makeCancelConnect = (
  provider: string,
  slot: TLoginSlot,
  messages: { readonly cancelled: string; readonly none: string },
): (() => Promise<{ readonly ok: boolean; readonly detail: string }>) => {
  return async () => {
    const flow = slot.flow();
    const n = slot.cancelAll();
    // Prompt secrets drop immediately; ownership/marker lives on the slot
    // until matching end/cleanup.
    clearPendingAuth(provider);
    if (n > 0 && flow !== null) {
      emitLoginFailed(flow, {
        code: "user_cancelled",
        message: messages.cancelled,
        retryable: false,
      });
    }
    return { ok: true, detail: n > 0 ? messages.cancelled : messages.none };
  };
};
