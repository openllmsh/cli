/**
 * Google Antigravity subscription delegate through Google's official `agy`
 * CLI — the single source of truth for sign-in. ONE Google OAuth (`agy`'s own
 * login screen, driven by `./antigravity-cli-login.ts`) covers everything for
 * an account slot (each slot has its own isolated HOME, `cliHome`): headless
 * chat (`native-runtime/antigravity-headless.ts`) and `agy acp`
 * (`native-runtime/antigravity-acp.ts`, images / client tools / structured
 * output / headless fallback) both use that one sign-in.
 *
 * Nothing here reads a token: `status()` is metadata only (an isolated
 * keychain item or `agy`'s own token file exists, `./antigravity-cli.ts`),
 * usage is `agy`'s own `/usage`, and the model list is `agy models` captured at
 * sign-in. Antigravity has no embeddings or image-generation surface, so those
 * endpoints are not served by it.
 *
 * Demand-only: `status()` never spawns `agy`.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@openllmsh/sdk/protocol";
import { accountCell } from "../account-scope";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliEnv, cliHome } from "../cli-paths";
import { logError, logInfo } from "../logger";
import { disposeAntigravityWarmPool } from "../native-runtime/antigravity-acp";
import { antigravitySpawnEnv } from "../native-runtime/antigravity-env";
import {
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
  "Google Antigravity (agy) not installed — rerun the OpenLLM installer (curl -fsSL https://www.openllm.sh/install | bash).";

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

const writeAgyModels = (rows: ReadonlyArray<TAgyModelRow>): void => {
  try {
    writeFileSync(agyModelsPath(), JSON.stringify(rows), { mode: 0o600 });
  } catch {
    // Best effort: the list is re-captured on the next sign-in.
  }
};

const readAgyModelsFile = (): ReadonlyArray<{
  readonly provider_model_id: string;
  readonly display_name?: string;
}> | null => {
  try {
    const rows = JSON.parse(
      readFileSync(agyModelsPath(), "utf8"),
    ) as ReadonlyArray<TAgyModelRow>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.map((row) => ({
      provider_model_id: row.value,
      ...(row.name !== null ? { display_name: row.name } : {}),
    }));
  } catch {
    return null;
  }
};

/** Installed when the `agy` CLI is present. */
const installState = async (): Promise<{
  readonly installed: boolean;
  readonly version: string | null;
}> => {
  // The resolver decides (an `agy` that can't run is not installed), so
  // status and Connect always agree.
  if (resolveAntigravityCli() === null) {
    return { installed: false, version: null };
  }
  const state = await cliInstallState(PROVIDER);
  return { installed: true, version: state.installed ? state.version : null };
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

/** Capture `agy models` into the model list. A failure never fails the
 *  caller: the list stays missing and the next Connect captures it. */
const captureAgyModels = async (agyBin: string): Promise<void> => {
  try {
    const rows = await readAgyModels(agyDeps(agyBin));
    if (rows !== null) writeAgyModels(rows);
  } catch (error) {
    logError("antigravity-connect", error);
  }
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
        connected: async () => {
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
      const keychain = await ensureIsolatedKeychain(home);
      if (keychain.kind !== "present") {
        const message =
          "Couldn't prepare the sign-in store for Google Antigravity. Try again.";
        emitLoginFailed(flow, {
          code: "spawn_denied",
          message,
          retryable: true,
        });
        return { connected: false, detail: message };
      }
      const scratch = await mkdtemp(join(daemonTempDir(), "agy-login-"));
      const login = startAgyLogin({
        argv: sandboxSpawnArgs([agyBin], {
          probe: unwrapAntigravityCliSpawn(),
        }),
        env: antigravitySpawnEnv(cliEnv(PROVIDER)),
        cwd: scratch,
        urlWaitMs: URL_WAIT_MS,
        loginTimeoutMs: LOGIN_TIMEOUT_MS,
        isSignedIn: () => agyCliSignedIn(home),
      });
      const dispose = (): void => {
        login.cancel();
        activeAgyLogin.set(null);
        void rm(scratch, { recursive: true, force: true });
      };
      if (!wiring.slot.start(dispose, flow)) {
        dispose();
        return { connected: false, detail: "daemon update in progress" };
      }
      activeAgyLogin.set(login);
      emitLoginStarted(flow);

      // Settle the attempt when the screen finishes, whichever way.
      const settled = login.done.then(async (outcome) => {
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
            // The previous account's list never outlives its sign-in.
            try {
              rmSync(agyModelsPath(), { force: true });
            } catch (error) {
              logError("antigravity-connect", error);
            }
            await captureAgyModels(agyBin);
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
  // Status reads metadata only — nothing to cancel.
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
        ? { last_login_at_ms: null }
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
    const removed = await removeAgySignIn(agyHome()).catch((error: unknown) => {
      logError("antigravity-logout", error);
      return false;
    });
    // Whatever was removed, nothing from the old account may serve or be
    // listed.
    disposeAccountRuntimes();
    noteAuthStoreIdentityChange(PROVIDER);
    try {
      rmSync(agyModelsPath(), { force: true });
    } catch (error) {
      logError("antigravity-logout", error);
    }
    return removed
      ? { ok: true, detail: "signed out of Google Antigravity" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
