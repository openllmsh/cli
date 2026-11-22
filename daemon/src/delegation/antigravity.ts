/**
 * Google Antigravity subscription delegate through Google's official `agy`
 * CLI — the single source of truth for sign-in. ONE Google OAuth (`agy`'s own
 * login screen, driven by `./antigravity-cli-login.ts`) covers everything for
 * an account slot (each slot has its own isolated HOME, `cliHome`): headless
 * chat (`native-runtime/antigravity-headless.ts`) and `agy acp`
 * (`native-runtime/antigravity-acp.ts`, images / client tools / headless
 * fallback) both use that one sign-in. (Structured output is declined
 * before either runs.)
 *
 * Nothing here reads a token: `status()`'s credential check is metadata only
 * (an isolated keychain item or `agy`'s own token file exists,
 * `./antigravity-cli.ts`), usage is `agy`'s own `/usage`, and the model list
 * is `agy models` captured at sign-in. Antigravity has no embeddings or
 * image-generation surface, so those endpoints are not served by it.
 *
 * `status()` signs nothing in and runs no inference. Its install check may
 * run one `agy --version` per binary (cached per binary stamp, 5 s cap).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@openllmsh/sdk/protocol";
import { projectDoctorOutcomeLedger } from "@openllmsh/sdk/protocol";
import { accountCell } from "../account-scope";
import type { TAgyVersionRead } from "../agy-version";
import {
  AGY_VERSION_READ_TIMEOUT_MS,
  peekCliVersion,
  warmCliVersion,
} from "../agy-version";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliEnv, cliHome } from "../cli-paths";
import { stateDir } from "../env";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import { disposeAntigravityWarmPool } from "../native-runtime/antigravity-acp";
import { antigravitySpawnEnv } from "../native-runtime/antigravity-env";
import {
  antigravityCliCandidate,
  antigravityHeadlessEpoch,
  disposeAntigravityHeadlessSpares,
  resolveAntigravityCli,
} from "../native-runtime/antigravity-headless";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import type { TAgyCliDeps, TAgyModelRow } from "./antigravity-cli";
import {
  agyCliSignedIn,
  readAgyModels,
  readAgyUsage,
  removeAgySignIn,
} from "./antigravity-cli";
import type { TAgyLogin } from "./antigravity-cli-login";
import { startAgyLogin } from "./antigravity-cli-login";
import { ANTIGRAVITY_PLANS_URL } from "./antigravity-usage";
import { loginWiring } from "./delegate-shared";
import { detailedFromCliList, listWithReason } from "./fetch-model-list";
import type { TConnectResult } from "./login-flow";
import {
  emitLoginFailed,
  emitLoginStarted,
  finalizeLoginTerminal,
  guard,
  makeCancelConnect,
  publishPendingAuth,
  resolveLoginFlow,
} from "./login-flow";
import type {
  TListModelsOptions,
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import {
  connectedObservation,
  disconnectedObservation,
  ensureIsolatedKeychain,
  unknownObservation,
} from "./util";

const PROVIDER = "antigravity" as const;
/** Google's own login window budget (t3code uses the same 300 s). */
const LOGIN_TIMEOUT_MS = 300_000;
const URL_WAIT_MS = 60_000;

const INSTALL_HINT =
  "Google Antigravity CLI (agy) not installed — install it with: curl -fsSL https://antigravity.google/cli/install.sh | bash";

/** The isolated HOME `agy` runs under (its own sign-in, keychain, settings). */
const agyHome = (): string => cliHome(PROVIDER);

const agyDeps = (bin: string): TAgyCliDeps => ({
  bin,
  env: cliEnv(PROVIDER),
});

/** Signed in through `agy` (metadata only). A leftover credential with no
 *  `agy` installed does not count. */
const signedIn = async (): Promise<boolean> =>
  resolveAntigravityCli() !== null && (await agyCliSignedIn(agyHome()));

/** `agy models` captured at sign-in, kept beside `agy`'s own state so the
 *  list survives a daemon restart without another `agy` launch. Not a token. */
const agyModelsPath = (): string => join(agyHome(), ".openllm-agy-models.json");

/**
 * Set when a sign-in or logout starts replacing the list: until the new
 * account's list is written, nothing serves the old file, even if it could
 * not be deleted. Per account slot, in memory AND as a marker in the
 * daemon's state dir (a different directory from the list), so it outlives
 * a restart too.
 */
const agyModelsStaleCell = accountCell<boolean>(() => false);
const agyModelsStaleMarker = (): string =>
  join(
    stateDir(),
    `antigravity-models-stale-${createHash("sha256").update(agyModelsPath()).digest("hex").slice(0, 16)}`,
  );
/** True when the mark was persisted (it outlives a restart). */
const markAgyModelsStale = (): boolean => {
  agyModelsStaleCell.set(true);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(agyModelsStaleMarker(), "", { mode: 0o600 });
    return true;
  } catch (error) {
    logError("antigravity-models", error);
    return false;
  }
};
/** True when no mark is left (in memory or on disk). */
const clearAgyModelsStale = (): boolean => {
  try {
    rmSync(agyModelsStaleMarker(), { force: true });
    agyModelsStaleCell.set(false);
    return true;
  } catch (error) {
    logError("antigravity-models", error);
    return false;
  }
};
const agyModelsStale = (): boolean =>
  agyModelsStaleCell.get() || existsSync(agyModelsStaleMarker());

/** True when the fresh list was written AND serves (its stale mark is
 *  gone). A mark that can't be cleared is not reported as recovered: the
 *  next Connect captures again — clearing the mark alone is never safe,
 *  since the file under it might still be the old account's. */
const writeAgyModels = (rows: ReadonlyArray<TAgyModelRow>): boolean => {
  try {
    writeFileSync(agyModelsPath(), JSON.stringify(rows), { mode: 0o600 });
  } catch {
    // Best effort: the list is re-captured on the next Connect.
    return false;
  }
  // The fresh list is on disk; it serves once the stale mark is gone. A
  // mark that won't clear keeps the warning (a later Connect retries it).
  const cleared = clearAgyModelsStale();
  if (cleared) agyModelsCleanupOwed.set(false);
  return cleared;
};

/** A sign-in where the old list could be neither marked stale on disk,
 *  deleted, nor replaced: after a restart it could come back. Status says
 *  so until a later Connect / sign-out clears it. Per account slot. */
const agyModelsCleanupOwed = accountCell<boolean>(() => false);

/** A cached row: a non-empty string id and a string-or-null name. */
const isAgyModelRow = (row: unknown): row is TAgyModelRow => {
  if (typeof row !== "object" || row === null) return false;
  const { value, name } = row as { value?: unknown; name?: unknown };
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (name === null || typeof name === "string")
  );
};

const readAgyModelsFile = (): ReadonlyArray<{
  readonly provider_model_id: string;
  readonly display_name?: string;
}> | null => {
  if (agyModelsStale()) return null;
  try {
    const rows: unknown = JSON.parse(readFileSync(agyModelsPath(), "utf8"));
    // Malformed counts as missing, so a Connect re-captures it.
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (!rows.every(isAgyModelRow)) return null;
    return rows.map((row) => ({
      provider_model_id: row.value,
      ...(row.name !== null ? { display_name: row.name } : {}),
    }));
  } catch {
    return null;
  }
};

/** A failed `agy --version` read is a doctor record: a slow or hung `agy` is
 *  otherwise invisible (status just shows no version). */
const noteAgyVersionRead = (result: TAgyVersionRead): void => {
  if (result.ok) return;
  logWarn(
    "cli-install",
    safeDiagnosticMessage`The agy version read failed or timed out.`,
    undefined,
    {
      ...projectDoctorOutcomeLedger({ provider: PROVIDER }),
      timings: {
        elapsed_ms: Math.round(result.elapsedMs),
        configured_timeout_ms: AGY_VERSION_READ_TIMEOUT_MS,
      },
    },
  );
};

/** Installed when the `agy` CLI is present. */
const installState = async (): Promise<{
  readonly installed: boolean;
  readonly version: string | null;
}> => {
  // Read the candidate's version off the event loop first, so this status
  // carries it when the read answers in time.
  const candidate = antigravityCliCandidate();
  if (candidate !== null) {
    await warmCliVersion(candidate, undefined, noteAgyVersionRead);
  }
  // The resolver decides (an `agy` that can't run is not installed), so
  // status and Connect always agree. A version still unknown (slow or timed
  // out read) is installed, with no version yet.
  const agyBin = resolveAntigravityCli();
  if (agyBin === null) return { installed: false, version: null };
  // The version of the binary that actually runs (it honours
  // OPENLLM_AGY_BIN), from the background cache.
  return { installed: true, version: peekCliVersion(agyBin) ?? null };
};

/** A new or removed sign-in: nothing from the previous account may serve —
 *  no spare, parked conversation or warm ACP process (they all hold the old
 *  account's session). */
const disposeAccountRuntimes = (): void => {
  disposeAntigravityHeadlessSpares();
  disposeAntigravityWarmPool();
};

const wiring = loginWiring({
  provider: PROVIDER,
  installHint: INSTALL_HINT,
  connectedDetail: "Google Antigravity already signed in",
  inProgressDetail: "Google sign-in already in progress",
  readToken: async (): Promise<unknown> => ((await signedIn()) ? true : null),
});

/** The live `agy` login screen, while a CLI sign-in waits for its code. */
const activeAgyLogin = accountCell<TAgyLogin | null>(() => null);

/** Capture `agy models` into the model list; true when a fresh list was
 *  written. A failure never fails the caller: the list stays missing and
 *  the next Connect captures it. */
const captureAgyModels = async (agyBin: string): Promise<boolean> => {
  // The account this capture belongs to: a logout or another sign-in that
  // lands while `agy models` runs must not get the old list written back.
  const epoch = antigravityHeadlessEpoch();
  try {
    const rows = await readAgyModels(agyDeps(agyBin));
    if (rows !== null && epoch === antigravityHeadlessEpoch()) {
      return writeAgyModels(rows);
    }
  } catch (error) {
    logError("antigravity-connect", error);
  }
  return false;
};

/**
 * Sign in through `agy`'s own login screen: keychain ready (no dialog), the
 * screen walked to Google OAuth, the link surfaced, the pasted code typed in.
 * `agy` opens the link in the browser itself, so the daemon does not open a
 * second tab; the link is still published for a remote machine.
 */
const connect = (): Promise<TConnectResult> =>
  guard(
    {
      provider: PROVIDER,
      installed: async () => resolveAntigravityCli() !== null,
      installHint: INSTALL_HINT,
      shortCircuit: {
        // Already signed in: a model list the sign-in failed to capture is
        // captured now (this Connect is the user asking; never a probe).
        connected: async (): Promise<boolean> => {
          const yes = await agyCliSignedIn(agyHome());
          const agyBin = resolveAntigravityCli();
          if (yes && agyBin !== null && readAgyModelsFile() === null) {
            await captureAgyModels(agyBin);
          }
          return yes;
        },
        detail: wiring.connectedDetail,
      },
      slot: wiring.slot,
      inProgressDetail: wiring.inProgressDetail,
      mode: "browser",
    },
    async () => {
      const agyBin = resolveAntigravityCli();
      if (agyBin === null) return { connected: false, detail: INSTALL_HINT };
      const flow = resolveLoginFlow(PROVIDER, "browser");
      const home = agyHome();
      // The slot is claimed BEFORE any await: account removal sees a login in
      // progress for the whole setup (keychain, spawn), never a free slot.
      let disposeLogin: () => void = () => {};
      if (!wiring.slot.start(() => disposeLogin(), flow)) {
        return { connected: false, detail: "daemon update in progress" };
      }
      const keychain = await ensureIsolatedKeychain(home);
      if (wiring.slot.wasCancelled()) {
        wiring.slot.end(flow.flowId);
        return { connected: false, detail: "sign-in cancelled" };
      }
      if (keychain.kind !== "present") {
        const message =
          "Couldn't prepare the sign-in store for Google Antigravity. Try again.";
        emitLoginFailed(flow, {
          code: "spawn_denied",
          message,
          retryable: true,
        });
        wiring.slot.end(flow.flowId);
        return { connected: false, detail: message };
      }
      let scratch: string;
      try {
        scratch = await mkdtemp(join(daemonTempDir(), "agy-login-"));
      } catch (error) {
        wiring.slot.end(flow.flowId);
        throw error;
      }
      // Before agy can save a NEW sign-in: whatever list is cached belongs
      // to no live sign-in here (Connect only gets this far signed out), so
      // it is marked unusable now — a daemon that stops between agy saving
      // the sign-in and the capture below never serves it to the new one.
      markAgyModelsStale();
      const login = startAgyLogin({
        argv: sandboxSpawnArgs([agyBin], {
          probe: unwrapAntigravityCliSpawn(),
        }),
        env: antigravitySpawnEnv(cliEnv(PROVIDER)),
        cwd: scratch,
        urlWaitMs: URL_WAIT_MS,
        loginTimeoutMs: LOGIN_TIMEOUT_MS,
        isSignedIn: (): Promise<boolean> => agyCliSignedIn(home),
      });
      const dispose = (): void => {
        login.cancel();
        // Only the attempt that still owns the cell clears it: a losing
        // overlapping Connect must not clear the winner's waiting login.
        if (activeAgyLogin.get() === login) activeAgyLogin.set(null);
        void rm(scratch, { recursive: true, force: true });
      };
      disposeLogin = dispose;
      // Cancelled while it was being set up: close the screen it just opened.
      if (wiring.slot.wasCancelled()) {
        dispose();
        await login.exited;
        wiring.slot.end(flow.flowId);
        return { connected: false, detail: "sign-in cancelled" };
      }
      activeAgyLogin.set(login);
      emitLoginStarted(flow);

      // Settle the attempt when the screen finishes, whichever way.
      const settled = login.done.then(async (outcome): Promise<boolean> => {
        // Cleanup runs however the attempt ends — including a failure below.
        try {
          if (wiring.slot.wasCancelled()) return false;
          const ok = outcome.kind === "signed_in" && (await signedIn());
          if (ok) {
            // A new sign-in: nothing from the previous account may serve, and
            // its model list is captured once now (no later probe). A capture
            // failure never fails the sign-in: the next sign-in retries it.
            disposeAccountRuntimes();
            noteAuthStoreIdentityChange(PROVIDER);
            // The previous account's list never outlives its sign-in —
            // not even when its file cannot be deleted.
            const marked = markAgyModelsStale();
            let deleted = false;
            try {
              rmSync(agyModelsPath(), { force: true });
              deleted = true;
            } catch (error) {
              logError("antigravity-connect", error);
            }
            const captured = await captureAgyModels(agyBin);
            // The sign-in stands either way; with none of the three, the old
            // list could outlive a restart, so status says so.
            agyModelsCleanupOwed.set(!(marked || deleted || captured));
            // A cancel that landed during the checks above wins: the
            // attempt never reports success after the user cancelled.
            if (wiring.slot.wasCancelled()) return false;
            finalizeLoginTerminal({
              flow,
              event: { kind: "succeeded" },
              provider: PROVIDER,
              clearPending: true,
            });
          } else {
            finalizeLoginTerminal({
              flow,
              event: {
                kind: "failed",
                code:
                  outcome.kind === "failed" && outcome.timedOut === true
                    ? "prompt_timeout"
                    : "cli_crash",
                message:
                  outcome.kind === "failed"
                    ? outcome.reason
                    : "Google sign-in did not complete",
                retryable: true,
              },
              provider: PROVIDER,
              clearPending: true,
            });
          }
          return ok;
        } finally {
          dispose();
          // The slot stays held until the login screen is gone: account
          // removal waits on it, and a screen still in its kill grace could
          // otherwise write a sign-in into a removed slot.
          await login.exited;
          wiring.slot.end(flow.flowId);
        }
      });

      const surfaced = await login.url;
      if (surfaced === null) {
        // Already signed in (the screen opened signed in) or it failed.
        const ok = await settled;
        return ok
          ? { connected: true, detail: wiring.connectedDetail }
          : {
              connected: false,
              detail:
                "Couldn't start Google sign-in. Retry from the Providers page.",
            };
      }
      if (wiring.slot.wasCancelled()) {
        return { connected: false, detail: "sign-in cancelled" };
      }
      logInfo("antigravity-connect", "Google sign-in URL surfaced (agy)", {
        urlLen: surfaced.url.length,
      });
      publishPendingAuth(flow, PROVIDER, {
        url: surfaced.url,
        code: "",
        mode: "paste_code",
      });
      return {
        connected: false,
        pending: true,
        detail: `Sign in with Google in the browser window that opened — or open ${surfaced.url}. Then paste the code Google shows back here.`,
      };
    },
  );

const cancelConnect = makeCancelConnect(PROVIDER, wiring.slot, {
  cancelled: "Google sign-in cancelled",
  none: "no sign-in was in progress",
});

const submitLoginCode = async (
  pasted: string,
): Promise<{ readonly ok: boolean; readonly detail?: string }> => {
  const login = activeAgyLogin.get();
  if (login === null || !wiring.slot.inFlight()) {
    return { ok: false, detail: "no Google sign-in is awaiting a response." };
  }
  return login.submitCode(pasted);
};

export const antigravityDelegate: TProviderDelegate = {
  slug: PROVIDER,
  primaryLoginMethod: "browser",
  // Status reads sign-in metadata; its install check may run one
  // `agy --version` per binary stamp (5 s cap) — nothing to cancel.
  statusCancellable: false,
  connect,
  submitLoginCode,
  cancelConnect,

  status: async (): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await installState();
    const connected = installed && (await signedIn());
    const signingIn = wiring.slot.inFlight();
    if (connected && !signingIn) clearPendingAuth(PROVIDER);
    const pending = connected && !signingIn ? null : getPendingAuth(PROVIDER);
    return {
      provider: PROVIDER,
      status: connected ? "connected" : "disconnected",
      ...(connected
        ? connectedObservation()
        : pending !== null
          ? {}
          : installed
            ? disconnectedObservation()
            : unknownObservation("cli_unavailable")),
      cli_installed: installed,
      ...(version !== null ? { cli_version: version } : {}),
      ...(pending !== null
        ? {
            pending_auth: {
              url: pending.url,
              code: pending.code,
              ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
              started_at_ms: pending.startedAt,
              ...(pending.flowId !== undefined
                ? { flow_id: pending.flowId }
                : {}),
            },
          }
        : {}),
      ...(connected
        ? {
            last_login_at_ms: null,
            ...(agyModelsCleanupOwed.get()
              ? {
                  detail:
                    "Signed in, but the previous account's cached model list couldn't be cleared — Connect again to retry",
                }
              : {}),
          }
        : {
            detail:
              pending !== null
                ? pendingAuthDetail(pending)
                : installed
                  ? "Google Antigravity installed but not signed in"
                  : "Google Antigravity (agy) not installed",
          }),
    };
  },

  // Models are `agy models`, captured at sign-in (or by a Connect that finds
  // it missing) — never a dedicated probe. Not captured → skipped.
  discoverModels: async (
    _options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const models = readAgyModelsFile();
    return models === null
      ? { kind: "skipped" }
      : { kind: "success", models: [...models] };
  },
  listModels: (opts?: TListModelsOptions) =>
    listWithReason(opts, async () => {
      if (!(await signedIn())) {
        return { kind: "null", reason: "token_unavailable" };
      }
      const models = readAgyModelsFile();
      return detailedFromCliList(models === null ? null : [...models]);
    }),

  // `agy`'s own `/usage` — no token is read.
  usage: async (): Promise<TProviderUsageSnapshot> => {
    const agyBin = resolveAntigravityCli();
    if (agyBin !== null && (await agyCliSignedIn(agyHome()))) {
      return readAgyUsage(agyDeps(agyBin));
    }
    return {
      kind: "unavailable",
      reason: "Antigravity limits unavailable.",
      link: ANTIGRAVITY_PLANS_URL,
    };
  },

  credentialForUpstream: async () => {
    throw new Error(
      "antigravity is served through the agy CLI (headless / agy acp); there is no manual upstream transport",
    );
  },

  // Sign out by clearing `agy`'s sign-in from the daemon's isolated store
  // (removal itself readies the isolated keychain, so an unobservable store is
  // cleared rather than assumed empty). That one store is the whole sign-in:
  // headless and `agy acp` share it.
  logout: async () => {
    const removed = await removeAgySignIn(agyHome()).catch(
      (error: unknown): boolean => {
        logError("antigravity-logout", error);
        return false;
      },
    );
    // Whatever was removed, nothing from the old account may serve or be
    // listed.
    disposeAccountRuntimes();
    noteAuthStoreIdentityChange(PROVIDER);
    // Invalid for readers first: a cache that can't be deleted still never
    // lists the signed-out account's models.
    const marked = markAgyModelsStale();
    let deleted = false;
    try {
      rmSync(agyModelsPath(), { force: true });
      deleted = true;
    } catch (error) {
      logError("antigravity-logout", error);
    }
    if (!removed) {
      return { ok: false, detail: "credential still present after logout" };
    }
    if (marked || deleted) agyModelsCleanupOwed.set(false);
    // Either invalidation lasts past a restart; with neither, the old
    // account's list could come back — say so (logging out again retries).
    return marked || deleted
      ? { ok: true, detail: "signed out of Google Antigravity" }
      : {
          ok: false,
          detail:
            "signed out of Google Antigravity, but its cached model list couldn't be cleared — sign out again to retry",
        };
  },
};
