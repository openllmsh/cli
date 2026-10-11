/**
 * The DEVICE (remote/headless `connectDeviceCode()`) login adaptor.
 *
 * Builds each delegate's remote-box login — the flow that surfaces an authorize
 * URL (± one-time code) so the user authorizes from THEIR machine — on top of
 * the shared scaffolding in `login-flow.ts`. Two mechanisms:
 *   - `makePasteBackDevice` → claude: a headless `claude auth login` that prints
 *     a hosted-callback URL and consumes a pasted code on stdin (returns
 *     `connectDeviceCode` + `submitLoginCode` + `cancelConnect`).
 *   - `makeStreamDeviceConnect` → codex: spawn `codex login --device-auth`, parse
 *     the device prompt off stdout, surface URL+code, poll in the background
 *     (returns `connectDeviceCode` + `cancelConnect`).
 *
 * The single-flight slot is the SAME `loginSlot(provider)` the direct adaptor
 * uses, so codex's two login methods stay mutually exclusive, and `cancelConnect`
 * cancels whichever flow is live. Provider atoms are injected — no delegate import.
 */

import { pendingAuthDetail } from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import type {
  TConnectResult,
  TLoginSlot,
  TLoginTerminalEvent,
  TLoginVerify,
  TStreamLoginCrashDetail,
} from "./login-flow";
import {
  booleanLoginVerify,
  emitLoginFailed,
  emitLoginStarted,
  finalizeLoginTerminal,
  finishInBackground,
  guard,
  makeCancelConnect,
  openAuthUrlUnlessCancelled,
  publishPendingAuth,
  resolveLoginFlow,
  spawnStreamLogin,
  streamLoginFail,
} from "./login-flow";
import { KEYCHAIN_NOT_READY_DETAIL, loginReady } from "./login-readiness";
import type { TChildCleanupOutcome } from "./spawn";
import type { THeadlessLogin, THeadlessLoginMiss, TStoreRead } from "./util";
import { spawnHeadlessLogin } from "./util";

type TCancelConnect = () => Promise<{
  readonly ok: boolean;
  readonly detail: string;
}>;

// ─── claude: headless paste-back ─────────────────────────────────────────

export type TPasteBackConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Already-signed-in short-circuit + its detail. */
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Re-surface detail when a login is already in flight. */
  readonly inProgressDetail: string;
  /** Runs before the login spawn (claude: ensure the isolated keychain). */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Background side effect once the credential lands (warn-if-unrefreshable +
   *  refresh the auth config). Invoked only when connected. */
  readonly onConnected?: () => void | Promise<void>;
  /** Runs after a code is accepted (claude: grant keychain tool access). */
  readonly onCodeAccepted?: () => Promise<boolean | undefined>;
  /** Authoritative connection check after a submitted code. */
  readonly verifyAfterSubmit: () => Promise<TLoginVerify>;
  /** Typed verify for background-exit cleanup. Defaults to wrapping `connected`. */
  readonly verify?: () => Promise<TLoginVerify>;
  /** The submit success `detail` (refreshable-aware). */
  readonly submitSuccessDetail: () => Promise<string>;
  /** File-store identity hint after child exit (not Darwin keychain). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  /** Whole-operation safety budget forwarded to paste-back spawn (tests inject). */
  readonly timeoutMs?: number;
};

export type TPasteBackDevice = {
  readonly connectDeviceCode: () => Promise<TConnectResult>;
  readonly submitLoginCode: (code: string) => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly cancelConnect: TCancelConnect;
};

/**
 * claude's remote login: spawn `claude auth login --claudeai` headless
 * (DISPLAY stripped, browser suppressed), surface the hosted-callback URL via
 * pending-auth (`paste_code` mode → dashboard paste panel), and hold the process
 * open on stdin until the user pastes the code (`submitLoginCode`) or cancels.
 * The credential that lands is the real refreshable claude.ai OAuth one.
 */
export const makePasteBackDevice = (
  cfg: TPasteBackConfig,
): TPasteBackDevice => {
  // The live headless login handle, awaiting the user's pasted code. Single-
  // flight — one in-flight paste-back per provider (the slot also guards it).
  let handle: THeadlessLogin | null = null;
  // The in-flight code submission, if any. A VALID pasted code exits the CLI —
  // firing `login.done` (the finalizer) AND resolving `submitLoginCode`, which
  // grants prompt-free keychain access (`onCodeAccepted`). The finalizer must
  // wait for that submit so `finishInBackground` runs its connection check +
  // `onConnected` (the auth-config refresh) AFTER the grant, not racing before
  // it (where the credential isn't yet readable → a false not-connected).
  let submitting: Promise<unknown> | null = null;

  const connectDeviceCode = (): Promise<TConnectResult> =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "paste_code",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "paste_code");
        const ready = await cfg.beforeLogin?.();
        if (!loginReady(ready)) {
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
        const abort = new AbortController();
        if (
          !cfg.slot.start(() => {
            abort.abort();
          }, flow)
        ) {
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: "daemon update in progress",
            retryable: true,
          });
          return { connected: false, detail: "daemon update in progress" };
        }
        const endOwnership = (
          cleanup: TChildCleanupOutcome | undefined,
          whenReleased: Promise<unknown> | undefined,
        ): void => {
          if (whenReleased !== undefined) {
            if (cleanup !== undefined && !cleanup.confirmed) {
              cfg.slot.markCleanupUnknown();
            }
            void whenReleased.finally(() => {
              cfg.slot.end(flow.flowId);
            });
            return;
          }
          cfg.slot.end(flow.flowId);
        };
        const failFromMiss = (miss: THeadlessLoginMiss): TConnectResult => {
          if (miss.cancelled || cfg.slot.wasCancelled()) {
            // cancelConnect already emitted `user_cancelled` via makeCancelConnect.
            if (!cfg.slot.wasCancelled()) {
              finalizeLoginTerminal({
                flow,
                event: {
                  kind: "failed",
                  code: "user_cancelled",
                  message: "sign-in cancelled",
                  retryable: false,
                },
                provider: cfg.provider,
                clearPending: true,
              });
            }
            endOwnership(miss.cleanup, miss.whenReleased);
            return { connected: false, detail: "sign-in cancelled" };
          }
          const event: TLoginTerminalEvent = miss.crashed
            ? {
                kind: "failed",
                code: "cli_crash",
                message: miss.error,
                retryable: false,
              }
            : miss.timedOut
              ? {
                  kind: "failed",
                  code: "prompt_timeout",
                  message: miss.error,
                  retryable: true,
                }
              : {
                  kind: "failed",
                  code: "poll_expired",
                  message: miss.error,
                  retryable: true,
                };
          finalizeLoginTerminal({
            flow,
            event,
            provider: cfg.provider,
            clearPending: true,
          });
          endOwnership(miss.cleanup, miss.whenReleased);
          return { connected: false, detail: miss.error };
        };
        let login: THeadlessLogin | THeadlessLoginMiss;
        try {
          // Keychain-dependent paste-back login (claude) is unconfined on macOS
          // (`sandbox/policy.ts`).
          login = await spawnHeadlessLogin([...cfg.argv()], cfg.env(), {
            probe: unwrapKeychainSpawn(cfg.provider),
            signal: abort.signal,
            ...(cfg.timeoutMs !== undefined
              ? { timeoutMs: cfg.timeoutMs }
              : {}),
            onSpawned: () => {
              if (!abort.signal.aborted) emitLoginStarted(flow);
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "login spawn failed";
          finalizeLoginTerminal({
            flow,
            event: {
              kind: "failed",
              code: "spawn_denied",
              message,
              retryable: true,
            },
            provider: cfg.provider,
            clearPending: true,
          });
          cfg.slot.end(flow.flowId);
          return { connected: false, detail: message };
        }
        if ("error" in login) {
          return failFromMiss(login);
        }
        const cancelledAfterUrl =
          cfg.slot.wasCancelled() || abort.signal.aborted;
        if (cancelledAfterUrl) {
          login.cancel();
        } else {
          handle = login;
          publishPendingAuth(flow, cfg.provider, {
            url: login.url,
            code: "",
            mode: "paste_code",
          });
        }
        // On exit (success, cancel, or expiry) drop the handle + the stale
        // pending URL; on success run onConnected (warn + refresh auth config).
        // Wait for any in-flight submit FIRST so the keychain grant lands before
        // the connection check (a valid code triggers both at once).
        // Cancel-after-URL still uses this terminal so a late connected verify
        // cannot emit succeeded (finishInBackground fences wasCancelled).
        void login.done.then(async () => {
          // Only clear if we still own the paste handle — an older completion
          // must not null a newer flow's login.
          if (handle === login) handle = null;
          // Cancel/abort release runs without awaiting shared submitting so an
          // older done cannot wait on a newer flow's grant/submit work.
          if (cfg.slot.wasCancelled() || abort.signal.aborted) {
            await login.whenReleased.catch(() => {});
            if (
              cfg.slot.flow()?.flowId === flow.flowId &&
              cfg.slot.inFlight()
            ) {
              cfg.slot.end(flow.flowId);
            }
            return;
          }
          if (cfg.slot.flow()?.flowId !== flow.flowId) {
            return;
          }
          if (submitting !== null) await submitting.catch(() => {});
          // Re-check after the awaited grant/submit: cancel, abort, or a newer
          // flow must not reach finishInBackground.
          if (cfg.slot.wasCancelled() || abort.signal.aborted) {
            await login.whenReleased.catch(() => {});
            if (
              cfg.slot.flow()?.flowId === flow.flowId &&
              cfg.slot.inFlight()
            ) {
              cfg.slot.end(flow.flowId);
            }
            return;
          }
          if (cfg.slot.flow()?.flowId !== flow.flowId) {
            return;
          }
          await finishInBackground({
            provider: cfg.provider,
            slot: cfg.slot,
            verify: cfg.verify ?? (() => booleanLoginVerify(cfg.connected)),
            waitStoreHint: cfg.waitStoreHint,
            onConnected: cfg.onConnected,
            alwaysClearPending: true,
          });
        });
        if (cancelledAfterUrl) {
          return { connected: false, detail: "sign-in cancelled" };
        }
        return {
          connected: false,
          pending: true,
          detail: pendingAuthDetail({
            url: login.url,
            code: "",
            mode: "paste_code",
          }),
        };
      },
    );

  const submitLoginCode = async (
    code: string,
  ): Promise<{ readonly ok: boolean; readonly detail?: string }> => {
    const current = handle;
    if (current === null) {
      return { ok: false, detail: "no Claude sign-in is awaiting a code." };
    }
    // Track this submission so the `login.done` finalizer can await it: a valid
    // code exits the CLI, firing the finalizer concurrently with the keychain
    // grant + verify below.
    const work = (async (): Promise<{
      readonly ok: boolean;
      readonly detail?: string;
    }> => {
      // Capture the submitting flow BEFORE any await. A cancel/new-flow during
      // grant must never finalize or end whatever currently owns the slot.
      const submittingFlow = cfg.slot.flow();
      if (submittingFlow === null || cfg.slot.wasCancelled()) {
        return { ok: false, detail: "sign-in cancelled" };
      }
      const stillSubmittingFlow = (): boolean =>
        !cfg.slot.wasCancelled() &&
        cfg.slot.flow()?.flowId === submittingFlow.flowId;
      const r = await current.submitCode(code);
      if (!r.ok) return { ok: false, detail: r.detail };
      if (!stillSubmittingFlow()) {
        return { ok: false, detail: "sign-in cancelled" };
      }
      const granted = await cfg.onCodeAccepted?.();
      if (!stillSubmittingFlow()) {
        // Cancel already emitted its terminal, or a newer flow owns the slot —
        // do not emit spawn_denied / clearPending / end against the live flow.
        return {
          ok: false,
          detail:
            granted === false ? KEYCHAIN_NOT_READY_DETAIL : "sign-in cancelled",
        };
      }
      if (granted === false) {
        finalizeLoginTerminal({
          flow: submittingFlow,
          event: {
            kind: "failed",
            code: "store_unavailable",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
            reason_code: "keychain_unavailable",
            failedAt: "prep",
          },
          provider: cfg.provider,
          clearPending: true,
        });
        // End this flow so login.done's finishInBackground is stale and cannot
        // emit succeeded after preparation refusal.
        if (cfg.slot.flow()?.flowId === submittingFlow.flowId) {
          cfg.slot.end(submittingFlow.flowId);
        }
        return { ok: false, detail: KEYCHAIN_NOT_READY_DETAIL };
      }
      const submitted = await cfg.verifyAfterSubmit();
      if (submitted.state === "absent") {
        return {
          ok: false,
          detail: "code accepted but no credential was stored.",
        };
      }
      // unavailable must not fail a paste whose code was accepted — finishInBackground
      // re-reads with a store hint / watchdog.
      return { ok: true, detail: await cfg.submitSuccessDetail() };
    })();
    submitting = work;
    try {
      return await work;
    } finally {
      submitting = null;
    }
  };

  const cancelConnect = makeCancelConnect(cfg.provider, cfg.slot, {
    cancelled: "sign-in cancelled",
    none: "sign-in cancelled",
  });

  return { connectDeviceCode, submitLoginCode, cancelConnect };
};

// ─── codex: stream-spawn device-code ─────────────────────────────────────

export type TStreamDeviceConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  readonly inProgressDetail: string;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Which fd carries the device prompt. Codex uses stdout; Grok uses stderr. */
  readonly stream?: "stdout" | "stderr";
  readonly parse: (buf: string) => { url: string; code: string } | null;
  readonly onConnected?: () => void | Promise<void>;
  readonly pendingDetail: (found: { url: string; code: string }) => string;
  readonly failDetail: string;
  /** Detail when the login child CRASHED (exited non-zero before a prompt).
   *  Optional — omit to fall back to `failDetail` plus the redacted capture. */
  readonly crashDetail?: TStreamLoginCrashDetail;
  /** cancelConnect wording. */
  readonly cancelMessages: {
    readonly cancelled: string;
    readonly none: string;
  };
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
};

export type TStreamDevice = {
  readonly connectDeviceCode: () => Promise<TConnectResult>;
  readonly cancelConnect: TCancelConnect;
};

/**
 * codex's remote login: run `codex login --device-auth`, capture the
 * verification URL + one-time code off stdout, surface them (and open the URL
 * locally — kimi's device flow does the same), then let the process poll in the
 * background and write auth.json on success.
 */
export const makeStreamDeviceConnect = (
  cfg: TStreamDeviceConfig,
): TStreamDevice => {
  const connectDeviceCode = (): Promise<TConnectResult> =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "device_code",
      },
      async () => {
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: cfg.stream ?? "stdout",
          parse: cfg.parse,
          verify: () => booleanLoginVerify(cfg.connected),
          waitStoreHint: cfg.waitStoreHint,
          onConnected: cfg.onConnected,
          // codex/grok device-code login is file-backed → stays confined
          // (`sandbox/policy.ts`); the predicate returns false for them.
          probe: unwrapKeychainSpawn(cfg.provider),
          mode: "device_code",
        });
        if (res.found === null) {
          if (res.cancelled === true) {
            return { connected: false, detail: "sign-in cancelled" };
          }
          const fail = streamLoginFail(cfg.failDetail, res, cfg.crashDetail);
          emitLoginFailed(res.flow, fail);
          return { connected: false, detail: fail.message };
        }
        // A cancel_connect can land between the prompt parsing and here; don't
        // pop a browser on a user who already stopped. `spawnStreamLogin` kills
        // the child on cancel, so only the URL-open needs guarding.
        if (!openAuthUrlUnlessCancelled(cfg.slot, res.found.url)) {
          return { connected: false, detail: "sign-in cancelled" };
        }
        const flow =
          cfg.slot.flow() ?? resolveLoginFlow(cfg.provider, "device_code");
        publishPendingAuth(flow, cfg.provider, res.found);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(res.found),
        };
      },
    );

  const cancelConnect = makeCancelConnect(
    cfg.provider,
    cfg.slot,
    cfg.cancelMessages,
  );

  return { connectDeviceCode, cancelConnect };
};
