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

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@openllmsh/protocol";
import { accountCell } from "../account-scope";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
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
  readAntigravityModels,
  recordAntigravityModels,
} from "../native-runtime/antigravity-model-observation";
import { AcpClient, AcpRpcError } from "../native-runtime/cursor-acp";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { daemonTempDir } from "../sandbox/working-set";
import { readAntigravityUsage } from "./antigravity-usage";
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

const wiring = loginWiring({
  provider: PROVIDER,
  installHint: INSTALL_HINT,
  connectedDetail: "Google Antigravity already signed in",
  inProgressDetail: "Google sign-in already in progress",
  readToken: async (): Promise<unknown> => (tokenPresent() ? true : null),
});

/** The live login's callback target, for the remote paste-back path. */
const pendingCallback = accountCell<Pick<
  TAntigravityAuthUrl,
  "redirectUri" | "state"
> | null>(() => null);

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

const connect = (): Promise<TConnectResult> =>
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

export const antigravityDelegate: TProviderDelegate = {
  slug: PROVIDER,
  primaryLoginMethod: "browser",
  // Status reads a file stat only — nothing to cancel.
  statusCancellable: false,
  connect,
  submitLoginCode,
  cancelConnect,

  status: async (): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const connected = installed && tokenPresent();
    if (connected) clearPendingAuth(PROVIDER);
    const pending = connected ? null : getPendingAuth(PROVIDER);
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
    const models = readAntigravityModels(geminiHome());
    return models === null ? { kind: "skipped" } : { kind: "success", models };
  },
  listModels: (opts?: TListModelsOptions) =>
    listWithReason(opts, async () => {
      if (!tokenPresent()) {
        return { kind: "null", reason: "token_unavailable" };
      }
      return detailedFromCliList(readAntigravityModels(geminiHome()));
    }),

  // Quota windows via Google's Code Assist quota endpoints with the agent's
  // own token — the t3code approach (see `./antigravity-usage.ts`).
  usage: (): Promise<TProviderUsageSnapshot> =>
    readAntigravityUsage({ geminiHome: geminiHome() }),

  credentialForUpstream: async () => {
    throw new Error(
      "antigravity is served by the ACP bridge (agy_acp_server); there is no manual upstream transport",
    );
  },

  logout: async () => {
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
