/**
 * Google Antigravity subscription delegate through Google's official
 * `agy_acp_server` ACP agent.
 *
 * Login is the agent's OWN Google sign-in: we spawn it, `initialize`, then
 * `authenticate { methodId: "oauth-personal" }`. The agent starts a loopback
 * OAuth listener and asks for a browser — via the `BROWSER` helper we inject
 * (Python `webbrowser`), or a stdout line on older builds. We validate the URL
 * as Google's OAuth endpoint with a 127.0.0.1 redirect and surface it as
 * pending auth. On the daemon's own machine the redirect lands on the agent's
 * listener directly; on a remote/headless box the user pastes the resulting
 * `http://127.0.0.1:…` address back (`submitLoginCode`), which the daemon
 * validates and replays ONLY to that loopback listener. The token lands in the
 * agent's own file store under the isolated GEMINI_HOME. Login and status()
 * never read it (status only checks the file exists); usage() DOES read it to
 * mint an access token for Google's quota endpoints (`./antigravity-usage.ts`).
 *
 * Inference is bridge-only (`native-runtime/antigravity-acp.ts`). The agent
 * exposes no quota over ACP, so `usage()` reads Google's Code Assist quota
 * endpoints with the agent's own token, as t3code does
 * (`./antigravity-usage.ts`); classified ACP errors still drive hop cooldown.
 *
 * Demand-only: `status()` never spawns the agent (each launch unpacks ~1 GB).
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@openllmsh/sdk/protocol";
import { accountCell } from "../account-scope";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv, cliHome } from "../cli-paths";
import { logError, logInfo, safeDiagnosticMessage } from "../logger";
import {
  ANTIGRAVITY_AUTH_METHOD,
  ANTIGRAVITY_INIT_PARAMS,
  antigravityArgv,
  antigravityModelRows,
  antigravitySpawnEnv,
  antigravityTokenPath,
  classifyAntigravityFailure,
  disposeAntigravityWarmPool,
  isAntigravityAgent,
  parseAntigravityAuthUrl,
  prepareAntigravityProfile,
  type TAntigravityAuthUrl,
  validateAntigravityCallback,
  writeAntigravityBrowserHelper,
} from "../native-runtime/antigravity-acp";
import {
  disposeAntigravityHeadlessSpares,
  resolveAntigravityCli,
} from "../native-runtime/antigravity-headless";
import {
  readAntigravityModels,
  recordAntigravityModels,
} from "../native-runtime/antigravity-model-observation";
import { AcpClient, AcpRpcError } from "../native-runtime/cursor-acp";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapAntigravityCliSpawn } from "../sandbox/policy";
import { daemonTempDir } from "../sandbox/working-set";
import { accountHashField } from "./account-id";
import type { TAgyModelRow } from "./antigravity-cli";
import { agyCliSignedIn, readAgyModels, readAgyUsage } from "./antigravity-cli";
import type { TAgyLogin } from "./antigravity-cli-login";
import { runAgyLogout, startAgyLogin } from "./antigravity-cli-login";
import {
  readAntigravityAccountId,
  readAntigravityUsage,
} from "./antigravity-usage";
import { loginWiring } from "./delegate-shared";
import { detailedFromCliList, listWithReason } from "./fetch-model-list";
import type { TConnectResult } from "./login-flow";
import {
  emitLoginFailed,
  emitLoginStarted,
  finalizeLoginTerminal,
  guard,
  makeCancelConnect,
  openAuthUrlUnlessCancelled,
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
const LOGOUT_TIMEOUT_MS = 30_000;

const INSTALL_HINT =
  "Google Antigravity agent not installed — rerun the OpenLLM installer (curl -fsSL https://www.openllm.sh/install | bash).";

const geminiHome = (): string => cliConfigDir(PROVIDER);
const tokenPath = (): string => antigravityTokenPath(geminiHome());

/** Presence of the agent's own token file — never its contents. */
const tokenPresent = (): boolean => {
  try {
    const st = statSync(tokenPath());
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

// ─── The `agy` CLI path ────────────────────────────────────────────────────
// Inference prefers the official `agy` CLI (`native-runtime/antigravity-
// headless.ts`); its sign-in, status, quota and models come from `agy` itself
// (`./antigravity-cli.ts`, `./antigravity-cli-login.ts`). The ACP agent stays
// the fallback until `agy` is installed everywhere.

/** The isolated HOME `agy` runs under (its own sign-in, keychain, settings). */
const agyHome = (): string => cliHome(PROVIDER);

const agyDeps = (bin: string) => ({ bin, env: cliEnv(PROVIDER) });

/** Signed in through ACP's token file or through `agy` (metadata only). */
const signedIn = async (): Promise<boolean> =>
  tokenPresent() || (await agyCliSignedIn(agyHome()));

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

/** The model list for the current sign-in: ACP's observation, else `agy`'s. */
const observedModels = (): ReturnType<typeof readAgyModelsFile> =>
  readAntigravityModels(geminiHome()) ??
  (tokenPresent() ? null : readAgyModelsFile());

/** Installed when either the ACP agent or the `agy` CLI is present. */
const installState = async (): Promise<{
  readonly installed: boolean;
  readonly version: string | null;
}> => {
  const acp = await cliInstallState(PROVIDER);
  if (acp.installed) return acp;
  return resolveAntigravityCli() !== null
    ? { installed: true, version: null }
    : acp;
};

const wiring = loginWiring({
  provider: PROVIDER,
  installHint: INSTALL_HINT,
  connectedDetail: "Google Antigravity already signed in",
  inProgressDetail: "Google sign-in already in progress",
  readToken: async (): Promise<unknown> => ((await signedIn()) ? true : null),
});

/** The live login's callback target, for the remote paste-back path. */
const pendingCallback = accountCell<Pick<
  TAntigravityAuthUrl,
  "redirectUri" | "state"
> | null>(() => null);

/** The live `agy` login screen, while a CLI sign-in waits for its code. */
const activeAgyLogin = accountCell<TAgyLogin | null>(() => null);

/** Replay one validated callback to the agent's loopback listener. */
const forwardCallback = (callback: URL): Promise<boolean> =>
  new Promise((resolve) => {
    const req = httpRequest(
      {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: callback.port,
        path: `${callback.pathname}${callback.search}`,
        method: "GET",
        agent: false,
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        res.once("end", () => {
          const status = res.statusCode ?? 0;
          resolve(status >= 200 && status < 400);
        });
        res.once("error", () => resolve(false));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
    req.end();
  });

const connect = (): Promise<TConnectResult> => {
  const agyBin = resolveAntigravityCli();
  return agyBin !== null ? connectViaAgy(agyBin) : connectViaAcp();
};

/**
 * Sign in through `agy`'s own login screen: keychain ready (no dialog), the
 * screen walked to Google OAuth, the link surfaced, the pasted code typed in.
 * `agy` opens the link in the browser itself, so the daemon does not open a
 * second tab; the link is still published for a remote machine.
 */
const connectViaAgy = (agyBin: string): Promise<TConnectResult> =>
  guard(
    {
      provider: PROVIDER,
      installed: async () => true,
      installHint: INSTALL_HINT,
      shortCircuit: {
        connected: signedIn,
        detail: wiring.connectedDetail,
      },
      slot: wiring.slot,
      inProgressDetail: wiring.inProgressDetail,
      mode: "browser",
    },
    async () => {
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
        if (wiring.slot.wasCancelled()) {
          dispose();
          wiring.slot.end(flow.flowId);
          return false;
        }
        const ok = outcome.kind === "signed_in" && (await signedIn());
        if (ok) {
          // A new sign-in: nothing from the previous account may serve, and
          // its model list is captured once now (no later probe).
          disposeAntigravityHeadlessSpares();
          noteAuthStoreIdentityChange(PROVIDER);
          const rows = await readAgyModels(agyDeps(agyBin));
          if (rows !== null) writeAgyModels(rows);
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
        dispose();
        wiring.slot.end(flow.flowId);
        return ok;
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

const connectViaAcp = (): Promise<TConnectResult> =>
  guard(
    {
      provider: PROVIDER,
      installed: wiring.isInstalled,
      installHint: INSTALL_HINT,
      shortCircuit: {
        connected: async () => tokenPresent(),
        detail: wiring.connectedDetail,
      },
      slot: wiring.slot,
      inProgressDetail: wiring.inProgressDetail,
      mode: "browser",
    },
    async () => {
      const flow = resolveLoginFlow(PROVIDER, "browser");
      const scratch = await mkdtemp(join(daemonTempDir(), "agy-login-"));
      const urlFile = join(scratch, "url.txt");
      const helper = writeAntigravityBrowserHelper(scratch, urlFile);
      const env = cliEnv(PROVIDER);
      prepareAntigravityProfile(geminiHome());

      let surfaced: TAntigravityAuthUrl | null = null;
      let resolveUrl: ((value: TAntigravityAuthUrl | null) => void) | null =
        null;
      const urlReady = new Promise<TAntigravityAuthUrl | null>((resolve) => {
        resolveUrl = resolve;
      });
      const offer = (raw: string): void => {
        if (surfaced !== null) return;
        const parsed = parseAntigravityAuthUrl(raw);
        if (parsed === null) return;
        surfaced = parsed;
        resolveUrl?.(parsed);
      };

      let client: AcpClient;
      try {
        client = new AcpClient(
          cliBin(PROVIDER),
          antigravitySpawnEnv(env, { BROWSER: helper }),
          () => {},
          () => null,
          {
            argv: antigravityArgv(cliBin(PROVIDER)),
            label: "agy_acp_server",
            probe: false,
            exactEnv: true,
            cwd: scratch,
            onNonJsonLine: offer,
          },
        );
      } catch (error) {
        await rm(scratch, { recursive: true, force: true });
        const message =
          error instanceof Error ? error.message : "agent spawn failed";
        emitLoginFailed(flow, {
          code: "spawn_denied",
          message,
          retryable: true,
        });
        return { connected: false, detail: message };
      }
      const dispose = (): void => {
        client.dispose();
        pendingCallback.set(null);
        void rm(scratch, { recursive: true, force: true });
      };
      if (!wiring.slot.start(dispose, flow)) {
        dispose();
        return { connected: false, detail: "daemon update in progress" };
      }
      emitLoginStarted(flow);

      // The BROWSER helper appends URLs to a file; poll it alongside stdout.
      const poll = setInterval(() => {
        if (!existsSync(urlFile)) return;
        try {
          for (const line of readFileSync(urlFile, "utf8").split("\n")) {
            offer(line);
          }
        } catch {
          // helper mid-write — next tick
        }
      }, 200);

      let finished = false;
      // The classified authenticate failure, surfaced by connect() when the
      // attempt settles without a token.
      let settledFailure: string | null = null;
      const finish = (result: {
        readonly ok: boolean;
        readonly message?: string;
        readonly timedOut?: boolean;
      }): void => {
        // Idempotent: the URL-wait timeout and the authenticate settle can
        // both reach here.
        if (finished) return;
        finished = true;
        clearInterval(poll);
        if (wiring.slot.wasCancelled()) {
          dispose();
          wiring.slot.end(flow.flowId);
          return;
        }
        if (result.ok && tokenPresent()) {
          // A new sign-in: no warm agent from the previous one may serve.
          disposeAntigravityWarmPool();
          noteAuthStoreIdentityChange(PROVIDER);
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
              code: result.timedOut === true ? "prompt_timeout" : "cli_crash",
              message: result.message ?? "Google sign-in did not complete",
              retryable: true,
            },
            provider: PROVIDER,
            clearPending: true,
          });
        }
        dispose();
        wiring.slot.end(flow.flowId);
      };

      // Drive the agent's sign-in. `authenticate` resolves once the browser
      // flow lands the token (or fails / times out).
      const authDone = (async (): Promise<void> => {
        try {
          const init = await client.request(
            "initialize",
            ANTIGRAVITY_INIT_PARAMS,
            URL_WAIT_MS,
          );
          if (!isAntigravityAgent(init)) {
            finish({
              ok: false,
              message:
                "The installed agent is not the expected Google Antigravity release.",
            });
            return;
          }
          await client.request(
            "authenticate",
            { methodId: ANTIGRAVITY_AUTH_METHOD },
            LOGIN_TIMEOUT_MS,
          );
          // Same process, one RPC: learn the account's selectable models now
          // so the first request never plans a model the plan lacks. Best
          // effort — a failure here never fails the sign-in.
          await client
            .request(
              "session/new",
              { cwd: scratch, mcpServers: [] },
              URL_WAIT_MS,
            )
            .then((opened) =>
              recordAntigravityModels(
                geminiHome(),
                antigravityModelRows(opened),
              ),
            )
            .catch(() => {});
          finish({ ok: true });
        } catch (error) {
          const failure = classifyAntigravityFailure(error);
          settledFailure =
            failure.cooldown === "payment"
              ? failure.reason.includes("verify the account")
                ? "Google needs to verify this account before it can use Antigravity. Verify it with Google, then sign in again."
                : "Google requires an eligible Antigravity subscription for this account."
              : failure.reason;
          finish({
            ok: false,
            message: settledFailure,
            timedOut: error instanceof AcpRpcError && error.kind === "timeout",
          });
        }
      })();

      let urlWaitTimer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        urlReady,
        authDone.then(() => "settled" as const),
        new Promise<"timeout">((resolve) => {
          urlWaitTimer = setTimeout(() => resolve("timeout"), URL_WAIT_MS);
        }),
      ]);
      clearTimeout(urlWaitTimer);
      if (first === "timeout") {
        // No URL and no settle in time: end the attempt now instead of
        // waiting out the full login timeout on a stuck agent.
        finish({
          ok: false,
          message: "no Google sign-in URL surfaced from the agent",
          timedOut: true,
        });
      }
      if (first === "settled" || first === "timeout" || first === null) {
        // Already signed in (authenticate resolved with no browser) or failed.
        if (tokenPresent()) {
          return { connected: true, detail: wiring.connectedDetail };
        }
        if (first === "timeout") {
          logError(
            "antigravity-connect",
            safeDiagnosticMessage`no Google sign-in URL surfaced from the agent`,
          );
        }
        return {
          connected: false,
          detail:
            settledFailure ??
            "Couldn't start Google sign-in. Retry from the Providers page.",
        };
      }
      logInfo("antigravity-connect", "Google sign-in URL surfaced", {
        urlLen: first.url.length,
      });
      if (!openAuthUrlUnlessCancelled(wiring.slot, first.url)) {
        return { connected: false, detail: "sign-in cancelled" };
      }
      pendingCallback.set({
        redirectUri: first.redirectUri,
        state: first.state,
      });
      publishPendingAuth(flow, PROVIDER, {
        url: first.url,
        code: "",
        mode: "paste_code",
      });
      return {
        connected: false,
        pending: true,
        detail: `Sign in with Google in the browser window that opened — or open ${first.url}. On a remote machine, paste the 127.0.0.1 address your browser lands on back here.`,
      };
    },
  );

const submitLoginCode = async (
  pasted: string,
): Promise<{ readonly ok: boolean; readonly detail?: string }> => {
  const agyLogin = activeAgyLogin.get();
  if (agyLogin !== null && wiring.slot.inFlight()) {
    return agyLogin.submitCode(pasted);
  }
  const target = pendingCallback.get();
  if (target === null || !wiring.slot.inFlight()) {
    return { ok: false, detail: "no Google sign-in is awaiting a response." };
  }
  const checked = validateAntigravityCallback(target, pasted);
  if (!checked.ok) return { ok: false, detail: checked.reason };
  const delivered = await forwardCallback(checked.url);
  return delivered
    ? { ok: true, detail: "Google sign-in response delivered — finishing." }
    : {
        ok: false,
        detail: "Could not deliver the sign-in response. Start sign-in again.",
      };
};

const cancelConnect = makeCancelConnect(PROVIDER, wiring.slot, {
  cancelled: "Google sign-in cancelled",
  none: "no sign-in was in progress",
});

/** Sign out of an `agy` sign-in with `agy`'s own `/logout`. */
const logoutViaAgy = async (
  agyBin: string,
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  const home = agyHome();
  if ((await ensureIsolatedKeychain(home)).kind !== "present") {
    return { ok: false, detail: "couldn't open the sign-in store to sign out" };
  }
  const scratch = await mkdtemp(join(daemonTempDir(), "agy-logout-"));
  try {
    const result = await runAgyLogout({
      argv: sandboxSpawnArgs([agyBin], { probe: unwrapAntigravityCliSpawn() }),
      env: antigravitySpawnEnv(cliEnv(PROVIDER)),
      cwd: scratch,
      isSignedIn: () => agyCliSignedIn(home),
      timeoutMs: LOGOUT_TIMEOUT_MS,
    });
    if (result.ok) {
      // Nothing from the signed-out account may serve or be listed.
      disposeAntigravityHeadlessSpares();
      noteAuthStoreIdentityChange(PROVIDER);
      rmSync(agyModelsPath(), { force: true });
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

export const antigravityDelegate: TProviderDelegate = {
  slug: PROVIDER,
  primaryLoginMethod: "browser",
  // Status reads a file stat only — nothing to cancel.
  statusCancellable: false,
  connect,
  submitLoginCode,
  cancelConnect,

  status: async (): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await installState();
    const connected = installed && (await signedIn());
    if (connected) clearPendingAuth(PROVIDER);
    // ACP's token carries a stable account id; an `agy` sign-in's token is
    // never read, so it reports no account hash.
    const accountId =
      connected && tokenPresent()
        ? await readAntigravityAccountId(geminiHome())
        : null;
    const pending = connected ? null : getPendingAuth(PROVIDER);
    return {
      provider: PROVIDER,
      status: connected ? "connected" : "disconnected",
      ...(connected
        ? {
            ...connectedObservation(),
            ...accountHashField(PROVIDER, accountId),
          }
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
                  : "Google Antigravity agent not installed",
          }),
    };
  },

  // Models come ONLY from the agent's own session/new selector, observed
  // during sign-in and every inference turn — never a dedicated probe.
  // Unobserved → skipped (the previously reported list stands).
  discoverModels: async (
    _options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const models = observedModels();
    return models === null
      ? { kind: "skipped" }
      : { kind: "success", models: [...models] };
  },
  listModels: (opts?: TListModelsOptions) =>
    listWithReason(opts, async () => {
      if (!(await signedIn())) {
        return { kind: "null", reason: "token_unavailable" };
      }
      const models = observedModels();
      return detailedFromCliList(models === null ? null : [...models]);
    }),

  // Quota windows via Google's Code Assist quota endpoints with the agent's
  // own token — the t3code approach (see `./antigravity-usage.ts`).
  // ACP sign-in: Google's quota endpoints with the agent's token (t3code's
  // approach). `agy` sign-in: `agy`'s own `/usage` — no token is read.
  usage: async (): Promise<TProviderUsageSnapshot> => {
    const agyBin = resolveAntigravityCli();
    if (
      !tokenPresent() &&
      agyBin !== null &&
      (await agyCliSignedIn(agyHome()))
    ) {
      return readAgyUsage(agyDeps(agyBin));
    }
    return readAntigravityUsage({ geminiHome: geminiHome() });
  },

  credentialForUpstream: async () => {
    throw new Error(
      "antigravity is served by the ACP bridge (agy_acp_server); there is no manual upstream transport",
    );
  },

  logout: async () => {
    const agyBin = resolveAntigravityCli();
    if (
      !tokenPresent() &&
      agyBin !== null &&
      (await agyCliSignedIn(agyHome()))
    ) {
      return logoutViaAgy(agyBin);
    }
    if (
      tokenPresent() &&
      (await cliInstallState(PROVIDER, { demand: true })).installed
    ) {
      const scratch = await mkdtemp(join(daemonTempDir(), "agy-logout-"));
      const client = new AcpClient(
        cliBin(PROVIDER),
        antigravitySpawnEnv(cliEnv(PROVIDER)),
        () => {},
        () => null,
        {
          argv: antigravityArgv(cliBin(PROVIDER)),
          label: "agy_acp_server",
          probe: false,
          exactEnv: true,
          cwd: scratch,
        },
      );
      try {
        await client.request(
          "initialize",
          ANTIGRAVITY_INIT_PARAMS,
          LOGOUT_TIMEOUT_MS,
        );
        await client.request("logout", {}, LOGOUT_TIMEOUT_MS);
      } catch {
        // surfaced through the presence check below
      } finally {
        client.dispose();
        await rm(scratch, { recursive: true, force: true });
      }
    }
    disposeAntigravityWarmPool();
    noteAuthStoreIdentityChange(PROVIDER);
    return tokenPresent()
      ? { ok: false, detail: "credential still present after logout" }
      : { ok: true, detail: "signed out of Google Antigravity" };
  },
};
