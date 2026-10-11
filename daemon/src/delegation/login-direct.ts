/**
 * The DIRECT (native `connect()`) login adaptor.
 *
 * Builds each delegate's on-this-box `connect()` from injected provider
 * specifics, on top of the shared scaffolding in `login-flow.ts`. There are
 * three native mechanisms — one per provider — each a small factory:
 *   - `makeBlockingConnect`  → claude: spawn `claude auth login`, BLOCK, verify.
 *   - `makeStreamConnect`    → codex: spawn `codex login`, parse the authorize
 *                              URL off stderr, surface it, complete in background.
 *   - `makeDeviceCodeConnect`→ kimi: run the vendor device-code OAuth handshake
 *                              (request → surface URL+code → background poll).
 *
 * Provider atoms (bin/env, token reads, parse fns, keychain hooks, the wire
 * request/poll calls) are injected — this file never imports a delegate, so
 * there is no cycle.
 */

import type { TSubscriptionProviderSlug } from "@openllmsh/protocol";
import { classifyFailureOutput } from "@openllmsh/protocol";
import type { TReapOutcome } from "../child-supervisor";
import { opaqueDoctorCorrelation } from "../doctor-report/correlation";
import { clearPendingAuth } from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import type {
  TConnectResult,
  TLoginFlowCtx,
  TLoginSlot,
  TLoginTerminalEvent,
  TLoginVerify,
  TStreamLoginCrashDetail,
  TStreamLoginOpts,
} from "./login-flow";
import {
  booleanLoginVerify,
  currentLoginCommandCorrelation,
  emitLoginFailed,
  emitLoginStarted,
  emitLoginSucceeded,
  finalizeLoginTerminal,
  guard,
  LOGIN_VERIFY_WATCHDOG_MS,
  openAuthUrlUnlessCancelled,
  publishPendingAuth,
  resolveLoginFlow,
  spawnStreamLogin,
  streamLoginFail,
  waitLoginVerifyHint,
} from "./login-flow";
import { KEYCHAIN_NOT_READY_DETAIL, loginReady } from "./login-readiness";
import type { TNativeAuthLifecycleTimings } from "./native-auth-lifecycle";
import { createNativeAuthLifecycle } from "./native-auth-lifecycle";
import type { TNativeAuthProducer } from "./spawn";
import type { TLoginResult, TStoreRead } from "./util";
import { spawnLogin } from "./util";

const UNCONFIRMED_CLEANUP_DETAIL = "sign-in child cleanup is unconfirmed";

const whenReleasedOf = (value: object): Promise<TReapOutcome> | undefined => {
  if (!("whenReleased" in value)) return undefined;
  const released = value.whenReleased;
  if (
    released !== null &&
    typeof released === "object" &&
    "then" in released &&
    typeof released.then === "function"
  ) {
    return released as Promise<TReapOutcome>;
  }
  return undefined;
};

// ─── claude: blocking native login ───────────────────────────────────────

export type TBlockingConnectConfig = {
  readonly provider: string;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Runs before the login spawn (claude: ensure the isolated keychain). */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string | undefined>;
  /** Runs after the login spawn (claude: grant keychain tool access). */
  readonly afterLogin?: () => Promise<boolean | undefined>;
  /** Authoritative connection check after the login completes. */
  readonly verifyConnected: () => Promise<TLoginVerify>;
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs?: number;
  /** Fire-and-forget side effect on success (claude: refresh the auth config). */
  readonly onConnected?: () => void | Promise<void>;
  /** The success `detail` — provider-computed so it can flag a credential that
   *  can't auto-refresh (claude's no-refresh-token warning). */
  readonly successDetail: () => Promise<string>;
  /** The failure `detail`, from the (abandoned-or-exited) login output. */
  readonly failDetail: (result: TLoginResult) => string;
  /** Native-child producer. Callers supply the label; this helper stays generic. */
  readonly nativeAuth?: {
    readonly producer: TNativeAuthProducer;
  };
  /** Shared with paste-back for this provider. */
  readonly slot?: TLoginSlot;
};

/**
 * claude's `connect`: a SYNCHRONOUS browser login — `claude auth login` opens
 * the browser and blocks until its own localhost callback completes. Ownership
 * is the shared per-provider slot (same as paste-back), reserved before
 * readiness/spawn so cancel can reach the operation with no child yet.
 */
export const makeBlockingConnect = (
  cfg: TBlockingConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        mode: "browser",
        ...(cfg.slot !== undefined ? { slot: cfg.slot } : {}),
        inProgressDetail:
          "Sign-in already in progress — this updates automatically.",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "browser");
        const slot = cfg.slot;
        const operation = new AbortController();
        if (slot !== undefined && !slot.start(() => operation.abort(), flow)) {
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: "daemon update in progress",
            retryable: true,
          });
          return { connected: false, detail: "daemon update in progress" };
        }
        const correlation = opaqueDoctorCorrelation(flow.flowId);
        const lifecycleProvider = lifecycleProviderOf(cfg.provider);
        const lifecycle =
          cfg.nativeAuth === undefined
            ? null
            : createNativeAuthLifecycle({
                scope: "login",
                producer: cfg.nativeAuth.producer,
                ...(correlation !== undefined
                  ? { operationId: correlation }
                  : {}),
                ...(lifecycleProvider !== undefined
                  ? { provider: lifecycleProvider }
                  : {}),
              });
        let terminalLedger: TNativeAuthLifecycleTimings | undefined;
        const releaseNoChild = (): void => {
          slot?.end(flow.flowId);
          clearPendingAuth(cfg.provider, flow.flowId);
        };
        const cancelledResult = (): TConnectResult => {
          terminalLedger = { outcome: "cancelled" };
          emitLoginFailed(flow, {
            code: "user_cancelled",
            message: "sign-in cancelled",
            retryable: false,
          });
          return { connected: false, detail: "sign-in cancelled" };
        };
        const retainUnconfirmedCleanup = (
          released: Promise<TReapOutcome> | undefined,
        ): TConnectResult => {
          slot?.markCleanupUnknown();
          if (released !== undefined) {
            void released.then(() => {
              if (slot?.flow()?.flowId === flow.flowId) {
                slot.end(flow.flowId);
                clearPendingAuth(cfg.provider, flow.flowId);
              }
            });
          }
          finalizeLoginTerminal({
            flow,
            event: {
              kind: "failed",
              code: "poll_expired",
              message: UNCONFIRMED_CLEANUP_DETAIL,
              retryable: true,
            },
            provider: cfg.provider,
            clearPending: false,
          });
          return {
            connected: false,
            pending: true,
            detail: UNCONFIRMED_CLEANUP_DETAIL,
          };
        };
        try {
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            releaseNoChild();
            return cancelledResult();
          }
          const readyMark = lifecycle?.mark();
          lifecycle?.record("readiness_wait", readyMark);
          const ready = await cfg.beforeLogin?.();
          lifecycle?.record("readiness", readyMark);
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            releaseNoChild();
            return cancelledResult();
          }
          if (!loginReady(ready)) {
            terminalLedger = {
              outcome: "failed",
              observation: "unknown",
              reason_code: "keychain_unavailable",
            };
            emitLoginFailed(flow, {
              code: "store_unavailable",
              message: KEYCHAIN_NOT_READY_DETAIL,
              retryable: true,
              reason_code: "keychain_unavailable",
            });
            releaseNoChild();
            return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
          }
          emitLoginStarted(flow);
          lifecycle?.record("start");
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            releaseNoChild();
            return cancelledResult();
          }
          const childMark = lifecycle?.mark();
          lifecycle?.record("child_wait", childMark);
          let result: TLoginResult;
          try {
            result = await spawnLogin([...cfg.argv()], cfg.env(), {
              probe: unwrapKeychainSpawn(cfg.provider),
              signal: operation.signal,
              ...(cfg.nativeAuth !== undefined
                ? {
                    producer: cfg.nativeAuth.producer,
                    ...(correlation !== undefined
                      ? { operationId: correlation }
                      : {}),
                  }
                : {}),
            });
          } catch (err) {
            const cleanup =
              err !== null &&
              typeof err === "object" &&
              "cleanup" in err &&
              err.cleanup !== null &&
              typeof err.cleanup === "object"
                ? (err.cleanup as TLoginResult["cleanup"])
                : undefined;
            if (cleanup?.confirmed === false) {
              return retainUnconfirmedCleanup(
                err !== null && typeof err === "object"
                  ? whenReleasedOf(err)
                  : undefined,
              );
            }
            if (operation.signal.aborted || slot?.wasCancelled() === true) {
              releaseNoChild();
              return cancelledResult();
            }
            terminalLedger = { outcome: "failed" };
            emitLoginFailed(flow, {
              code: "spawn_denied",
              message: "login spawn failed",
              retryable: true,
            });
            releaseNoChild();
            return { connected: false, detail: "login spawn failed" };
          }
          lifecycle?.record("child", childMark, {
            ...(result.spawn_setup_ms !== undefined
              ? { spawn_setup_ms: result.spawn_setup_ms }
              : {}),
            ...(result.child_wait_ms !== undefined
              ? { child_wait_ms: result.child_wait_ms }
              : {}),
          });
          if (
            result.cleanup !== undefined &&
            result.cleanup.confirmed === false
          ) {
            return retainUnconfirmedCleanup(result.whenReleased);
          }
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            slot?.end(flow.flowId);
            clearPendingAuth(cfg.provider, flow.flowId);
            return cancelledResult();
          }
          const prepMark = lifecycle?.mark();
          lifecycle?.record("prep_wait", prepMark);
          const granted = await cfg.afterLogin?.();
          lifecycle?.record("prep", prepMark);
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            slot?.end(flow.flowId);
            clearPendingAuth(cfg.provider, flow.flowId);
            return cancelledResult();
          }
          const sample = async (): Promise<TLoginVerify> => {
            try {
              return await cfg.verifyConnected();
            } catch {
              return { state: "unavailable" };
            }
          };
          const verifyMark = lifecycle?.mark();
          lifecycle?.record("verify_wait", verifyMark);
          let verified = await sample();
          if (verified.state === "unavailable") {
            await waitLoginVerifyHint({
              waitStoreHint: cfg.waitStoreHint,
              verifyWatchdogMs:
                cfg.verifyWatchdogMs ?? LOGIN_VERIFY_WATCHDOG_MS,
            });
            verified = await sample();
          }
          lifecycle?.record("verify", verifyMark);
          if (operation.signal.aborted || slot?.wasCancelled() === true) {
            slot?.end(flow.flowId);
            clearPendingAuth(cfg.provider, flow.flowId);
            return cancelledResult();
          }
          if (verified.state === "connected") {
            if (granted === false) {
              terminalLedger = {
                outcome: "failed",
                observation: "unknown",
                reason_code: "keychain_unavailable",
              };
              emitLoginFailed(flow, {
                code: "store_unavailable",
                message: KEYCHAIN_NOT_READY_DETAIL,
                retryable: true,
                reason_code: "keychain_unavailable",
              });
              slot?.end(flow.flowId);
              clearPendingAuth(cfg.provider, flow.flowId);
              return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
            }
            await cfg.onConnected?.();
            terminalLedger = {
              outcome: "succeeded",
              observation: "connected",
            };
            if (!emitLoginSucceeded(flow)) {
              terminalLedger = { outcome: "cancelled" };
              slot?.end(flow.flowId);
              clearPendingAuth(cfg.provider, flow.flowId);
              return {
                connected: false,
                detail: "sign-in is no longer the active attempt",
              };
            }
            slot?.end(flow.flowId);
            clearPendingAuth(cfg.provider, flow.flowId);
            return { connected: true, detail: await cfg.successDetail() };
          }
          const detail = cfg.failDetail(result);
          if (verified.state === "unavailable") {
            terminalLedger = {
              outcome: "timeout",
              observation: "unknown",
              reason_code: "probe_timeout",
            };
            emitLoginFailed(flow, {
              code: "poll_expired",
              message: detail,
              retryable: true,
            });
            slot?.end(flow.flowId);
            clearPendingAuth(cfg.provider, flow.flowId);
            return { connected: false, detail };
          }
          const crashed =
            result.abandoned !== true &&
            typeof result.code === "number" &&
            result.code !== 0;
          terminalLedger = {
            outcome: crashed ? "failed" : "timeout",
            observation: "disconnected",
            reason_code: "credential_absent",
          };
          emitLoginFailed(flow, {
            code: crashed ? "cli_crash" : "poll_expired",
            message: detail,
            retryable: !crashed,
          });
          slot?.end(flow.flowId);
          clearPendingAuth(cfg.provider, flow.flowId);
          return { connected: false, detail };
        } finally {
          lifecycle?.record("terminal", undefined, terminalLedger);
        }
      },
    );
};

// ─── codex: stream-spawn native login ────────────────────────────────────

export type TStreamConnectConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Already-signed-in short-circuit + its detail. */
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Re-surface detail when a login is already in flight. */
  readonly inProgressDetail: string;
  readonly argv: () => ReadonlyArray<string>;
  /** Override map. `undefined` values delete keys (see mergeSpawnEnv). */
  readonly env: () => Record<string, string | undefined>;
  /** Which fd carries the authorize URL. Codex/Grok: stderr. Cursor: stdout. Default stderr. */
  readonly stream?: "stdout" | "stderr";
  /** Parse the authorize URL off the chosen fd → `{ url, code }` (code: ""). */
  readonly parse: (buf: string) => { url: string; code: string } | null;
  /** Runs once a credential lands. Returning `false` FAILS the login — the
   *  keychain partition-list grant is observed, not best-effort. */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  /** Cursor: isolated keychain must be `present` before a prompt-capable spawn. */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  /** Diagnostics: before spawn, after a successful parse, on a parse miss
   *  (the captured output is passed so the caller can redact + log it). */
  readonly onStart?: () => void;
  readonly onParsed?: (url: string) => void;
  readonly onParseFail?: (captured: string) => void;
  readonly pendingDetail: (url: string) => string;
  /** Detail when NO prompt was parsed — the benign case (the child is still
   *  running its browser flow, or timed out): a generic "Retry" is right. */
  readonly failDetail: string;
  /** Detail when the login child CRASHED (exited non-zero before a prompt).
   *  A retry can't fix a deterministic crash, so surface the captured error
   *  instead of `failDetail`. Optional — omit to keep the generic message. */
  readonly crashDetail?: TStreamLoginCrashDetail;
  /**
   * Explicit opt-in mapping for background nonzero disconnected exits.
   * Separate from `crashDetail` (pre-prompt only) so providers like Grok /
   * ChatGPT keep their prior generic background message unless they opt in.
   * Muse may pass the same callback reference for both.
   */
  readonly backgroundCrashDetail?: TStreamLoginCrashDetail;
  /** File-store identity hint after child exit (not Darwin keychain). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  /**
   * Optional provider hook after a parsed prompt when the login child exits
   * (background path). See {@link spawnStreamLogin}'s `onBackgroundExit`.
   */
  readonly onBackgroundExit?: TStreamLoginOpts<unknown>["onBackgroundExit"];
};

/**
 * codex's `connect`: spawn `codex login`, which binds a localhost callback +
 * prints the authorize URL to STDERR. We parse + surface that URL (codex opens
 * its OWN browser, so we do NOT open a second tab) and let the process complete
 * the flow in the background; the status watcher flips the card on success.
 */
const LIFECYCLE_PROVIDERS = [
  "claude_code",
  "chatgpt",
  "kimi_code",
  "grok",
  "cursor",
  "muse",
] as const satisfies ReadonlyArray<TSubscriptionProviderSlug>;

const lifecycleProviderOf = (
  provider: string,
): TSubscriptionProviderSlug | undefined =>
  LIFECYCLE_PROVIDERS.find((item) => item === provider);

/** Stage recorder for browser-URL stream logins (correlated to the flow). */
const streamLoginLifecycle = (
  provider: string,
): ReturnType<typeof createNativeAuthLifecycle> => {
  const correlation = currentLoginCommandCorrelation();
  const slug = lifecycleProviderOf(provider);
  return createNativeAuthLifecycle({
    scope: "login",
    producer: "stream-login",
    ...(correlation !== undefined ? { operationId: correlation } : {}),
    ...(slug !== undefined ? { provider: slug } : {}),
  });
};

export const makeStreamConnect = (
  cfg: TStreamConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "browser",
      },
      async () => {
        const lifecycle = streamLoginLifecycle(cfg.provider);
        const readyMark = lifecycle.mark();
        lifecycle.record("readiness_wait", readyMark);
        const ready = await cfg.beforeLogin?.();
        if (!loginReady(ready)) {
          // finalizeLoginTerminal records the failed readiness + terminal.
          const flow = resolveLoginFlow(cfg.provider, "browser");
          finalizeLoginTerminal({
            flow,
            event: {
              kind: "failed",
              code: "store_unavailable",
              message: KEYCHAIN_NOT_READY_DETAIL,
              retryable: true,
              reason_code: "keychain_unavailable",
              failedAt: "readiness",
            },
            provider: cfg.provider,
            clearPending: true,
          });
          return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
        }
        lifecycle.record("readiness", readyMark);
        cfg.onStart?.();
        lifecycle.record("start");
        const childMark = lifecycle.mark();
        lifecycle.record("child_wait", childMark);
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: cfg.stream ?? "stderr",
          parse: cfg.parse,
          verify: () => booleanLoginVerify(cfg.connected),
          waitStoreHint: cfg.waitStoreHint,
          onConnected: cfg.onConnected,
          onBackgroundExit: cfg.onBackgroundExit,
          backgroundCrashDetail: cfg.backgroundCrashDetail,
          // cursor's store is the macOS keychain → unconfined on mac; codex is
          // file-backed → stays confined (`sandbox/policy.ts`).
          probe: unwrapKeychainSpawn(cfg.provider),
          mode: "browser",
        });
        if (res.found === null) {
          if (res.cancelled === true) {
            lifecycle.record("terminal", undefined, { outcome: "cancelled" });
            return { connected: false, detail: "sign-in cancelled" };
          }
          if (res.spawnFailure === undefined) cfg.onParseFail?.(res.captured);
          const fail = streamLoginFail(cfg.failDetail, res, cfg.crashDetail);
          const failOutcome =
            fail.code === "poll_expired" || fail.code === "prompt_timeout"
              ? "timeout"
              : "failed";
          lifecycle.record("child", childMark, {
            outcome: failOutcome,
            login_failure_code: fail.code,
            failure_signature: classifyFailureOutput(res.captured),
            ...(typeof res.exitCode === "number"
              ? { root_exit_code: res.exitCode }
              : {}),
          });
          lifecycle.record("terminal", undefined, {
            outcome: failOutcome,
            login_failure_code: fail.code,
          });
          emitLoginFailed(res.flow, fail);
          return { connected: false, detail: fail.message };
        }
        // Time-to-URL: how long the user waited before a link appeared.
        lifecycle.record("prompt", childMark);
        cfg.onParsed?.(res.found.url);
        const flow =
          cfg.slot.flow() ?? resolveLoginFlow(cfg.provider, "browser");
        publishPendingAuth(flow, cfg.provider, res.found);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(res.found.url),
        };
      },
    );
};

// ─── kimi: device-code native login ──────────────────────────────────────

export type TDeviceAuth = {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUriComplete: string;
  readonly intervalMs: number;
  readonly expiresInMs: number;
};

export type TDevicePoll =
  | { readonly kind: "success"; readonly wire: Record<string, unknown> }
  | { readonly kind: "pending"; readonly slowDown: boolean }
  | { readonly kind: "stop" };

export type TDeviceCodeConnectConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Fixed re-surface string (kimi returns no `pending` flag, unlike codex). */
  readonly inProgressDetail: string;
  /** Request a device code from the vendor (null on failure). */
  readonly requestDeviceAuth: () => Promise<TDeviceAuth | null>;
  /** Poll the token endpoint for one device code. */
  readonly pollToken: (deviceCode: string) => Promise<TDevicePoll>;
  /** Persist the credential the poll returned (writes the CLI's store shape). */
  readonly onCredential: (wire: Record<string, unknown>) => void;
  /** Fire-and-forget side effect after the credential lands (refresh config). */
  readonly onConnected?: () => void | Promise<void>;
  readonly pendingDetail: (auth: TDeviceAuth) => string;
  readonly startFailDetail: string;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Background device-code poll: register an abort canceler on the slot, then
 * poll the token endpoint until success / stop / expiry. On success persist the
 * credential + refresh the auth config; the `finally` always clears single-flight
 * and drops the in-memory device code (on success `status()` reports connected
 * from the token regardless; on expiry/denial it stops showing a dead code).
 */
const startDeviceCodePoll = (
  cfg: TDeviceCodeConnectConfig,
  auth: TDeviceAuth,
  flow: TLoginFlowCtx,
): boolean => {
  let aborted = false;
  let outcome: "success" | "stop" | "expired" | "aborted" = "expired";
  if (
    !cfg.slot.start(() => {
      aborted = true;
    }, flow)
  ) {
    return false;
  }
  void (async () => {
    const deadline = Date.now() + auth.expiresInMs;
    let delayMs = auth.intervalMs;
    try {
      while (Date.now() < deadline) {
        if (aborted) {
          outcome = "aborted";
          return;
        }
        await sleep(delayMs);
        if (aborted) {
          outcome = "aborted";
          return;
        }
        let res: TDevicePoll;
        try {
          res = await cfg.pollToken(auth.deviceCode);
        } catch {
          // A transient poll failure (network blip / parse error) must NOT end
          // the whole login — keep polling until success, stop, cancel, or
          // expiry. The next iteration retries after the same backoff.
          continue;
        }
        // Re-check AFTER the awaited poll: a cancel that arrived while the
        // request was in flight must win, or we'd sign in a cancelled login.
        if (aborted) {
          outcome = "aborted";
          return;
        }
        if (res.kind === "success") {
          cfg.onCredential(res.wire);
          await cfg.onConnected?.();
          outcome = "success";
          return;
        }
        if (res.kind === "stop") {
          outcome = "stop";
          return;
        }
        if (res.slowDown) delayMs += 5_000;
      }
    } catch {
      // swallow — the user can retry Connect
    } finally {
      const cancelled = cfg.slot.wasCancelled() || aborted;
      cfg.slot.end(flow.flowId);
      const event: TLoginTerminalEvent =
        outcome === "success"
          ? { kind: "succeeded" }
          : cancelled
            ? { kind: "none" }
            : {
                kind: "failed",
                code: outcome === "stop" ? "cli_crash" : "poll_expired",
                message:
                  outcome === "stop"
                    ? "sign-in was rejected"
                    : "sign-in expired before a credential landed",
                retryable: outcome !== "stop",
              };
      finalizeLoginTerminal({
        flow,
        event,
        provider: cfg.provider,
        clearPending: true,
      });
    }
  })();
  return true;
};

/**
 * kimi's `connect`: the CLI's sign-in is the in-TUI `/login` slash command
 * (raw-mode TTY), which the daemon can't spawn — so the daemon drives kimi's
 * OWN device-code OAuth flow directly: request a device code, open the
 * pre-filled verification URL, surface URL+code to the dashboard, and poll in
 * the background. On success the credential file lands; the status watcher flips
 * the card.
 */
export const makeDeviceCodeConnect = (
  cfg: TDeviceCodeConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        resurface: () => ({ connected: false, detail: cfg.inProgressDetail }),
        mode: "device_code",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "device_code");
        const auth = await cfg.requestDeviceAuth();
        if (auth === null) {
          emitLoginFailed(flow, {
            code: "cli_crash",
            message: cfg.startFailDetail,
            retryable: true,
          });
          return { connected: false, detail: cfg.startFailDetail };
        }
        emitLoginStarted(flow);
        // Reserve the slot before opening a browser or storing pending — apply
        // hold must deny without a poll, pending snapshot, or slot.end of another
        // flow. `slot.start()` still fires the canceler when `wasCancelled` is
        // already set (cancel during `requestDeviceAuth`).
        if (!startDeviceCodePoll(cfg, auth, flow)) {
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: "daemon update in progress",
            retryable: true,
          });
          return { connected: false, detail: "daemon update in progress" };
        }
        if (
          !openAuthUrlUnlessCancelled(cfg.slot, auth.verificationUriComplete)
        ) {
          cfg.slot.cancelAll();
          clearPendingAuth(cfg.provider, flow.flowId);
          emitLoginFailed(flow, {
            code: "user_cancelled",
            message: "sign-in cancelled",
            retryable: true,
          });
          return { connected: false, detail: "sign-in cancelled" };
        }
        publishPendingAuth(flow, cfg.provider, {
          url: auth.verificationUriComplete,
          code: auth.userCode,
        });
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(auth),
        };
      },
    );
};
