/**
 * OpenLLM local daemon — entrypoint.
 *
 * Headless. Boots a localhost `Bun.serve` that exposes the
 * OpenAI/Anthropic-compatible `/v1/*` inference surface (run locally against
 * `packages/core`'s pipeline for SUBSCRIPTION hops, credentials delegated to
 * the official vendor CLIs) plus a tiny read-only `/whoami` that returns this
 * daemon's opaque `device_id` so the dashboard can tell which key's daemon is
 * on THIS host (`docs/proposals/this-machine-detection-audit.md`). Dashboard
 * control travels through the outbound relay WebSocket (`control-channel.ts`).
 * The CLI-only `/local/auth` and doctor routes instead require this boot's
 * owner-only capability and reject browser Origin; they do not share the
 * public inference/health CORS grant. See `local-auth.ts` and `local-http.ts`.
 *
 * It holds NO DEK and decrypts NO vault credential. The only secret it
 * carries is the user's `sk-llm-...` key, used to authenticate cloud
 * control-plane calls (config pull + request-metadata recording) and to
 * forward API-key hops in a mixed chain to the cloud `/v1/*` surface.
 *
 * This file is compiled into a source-free standalone binary with
 * `bun build --compile --minify --bytecode` (see
 * `packages/cli/scripts/compile.ts`; the CLI entry routes `openllm daemon` here).
 */

// MUST be the entrypoint's FIRST import. `@peculiar/x509` (pulled in by
// `werift`, our RTC stack) constructs a `tsyringe` DI container at module load,
// and tsyringe THROWS unless `Reflect.getMetadata` already exists. x509's own
// ESM build imports this polyfill, but `bun build --compile` drops that
// side-effect-only import, so the compiled binary died on boot with "tsyringe
// requires a reflect polyfill" while `bun run` from source was fine. Importing
// it here — from the entry, ahead of the RTC import chain — is the fix the
// tsyringe error message itself prescribes. `tests/daemon/compiled-boot.test.ts`
// guards it.
import "reflect-metadata";

import { AGENT_HOOK_LOCAL_PATH, AUTH_LOCAL_PATH } from "@openllmsh/protocol";
import { isStreamResetError } from "@openllmsh/tunnel";
import { handleLocalAgentHook } from "./agent/hook-endpoint";
import type { TLocalAgentSocketData } from "./agent/loopback";
import {
  AGENT_LOCAL_PATH,
  createLocalAgentWebSocket,
  localAgentRefusal,
  localAgentRefusalResponse,
  localAgentSocketData,
  selectedLocalAgentProtocol,
} from "./agent/loopback";
import {
  guardCrashLoop,
  guardRtcCircuitBreaker,
  markHealthyBoot,
} from "./boot-guard";
import {
  bootstrapBackoffConfig,
  createBootstrapBackoff,
} from "./bootstrap-backoff";
import {
  drainDisposableChildren,
  sweepStaleChildrenOnBoot,
} from "./child-supervisor";
import { runCli } from "./cli";
import { getCloudState, latestCliVersion, refreshBootstrap } from "./config";
import { corsHeaders, isPreflight, preflightResponse } from "./cors";
import { isSurvivableTransportError } from "./crash-policy";
import { requireServiceApiKey } from "./credential-gate";
import { getCliState, refreshCliState } from "./device-state";
import {
  daemonEnv,
  daemonPort,
  deviceId,
  hasApiKey,
  isDevMode,
  stateDir,
} from "./env";
import { buildHealth } from "./health";
import { handleLocalAuth } from "./local-auth";
import {
  handleLocalDeviceControl,
  isLocalDeviceControlPath,
} from "./local-device-control";
import { flushLogs, logError, logInfo, safeDiagnosticMessage } from "./logger";
import { startPlanCacheSweeper } from "./plan-cache";
import type { TLocalRealtimeSocketData } from "./realtime-handler";
import {
  authorizeLocalRealtimeRequest,
  localRealtimeWebSocket,
  parseLocalRealtimeOpen,
} from "./realtime-handler";
import { probeSandboxCapability } from "./sandbox/exec";
import { recordSandboxState, sandboxState } from "./sandbox/landlock";
import { beginRequest, endRequest, trackBodyDone } from "./self-update";
import { migrateLegacyInstall } from "./service";
import { reconcileSessionHostsAtBoot } from "./session-host";
import { convergeBinary } from "./updater";
import { enableUsagePersistence } from "./usage-cache";
import { DAEMON_VERSION } from "./version";

// Bootstrap refresh cadence — healthy stays on the long TTL; unhealthy uses
// exponential backoff with jitter (see bootstrap-backoff.ts / audit §2).
const bootstrapBackoff = createBootstrapBackoff(bootstrapBackoffConfig);

// Wall-clock at process start, for the `/status` uptime field. Module-load time
// is "boot" for our purposes (the listener binds within the same tick).
const BOOT_AT = Date.now();

/** Per-socket data of the two local WS surfaces (realtime + loopback agent). */
type TLocalSocketData = TLocalRealtimeSocketData | TLocalAgentSocketData;

const isAgentSocket = (
  socket: Bun.ServerWebSocket<TLocalSocketData>,
): socket is Bun.ServerWebSocket<TLocalAgentSocketData> =>
  "agentLoopback" in socket.data;

const isRealtimeSocket = (
  socket: Bun.ServerWebSocket<TLocalSocketData>,
): socket is Bun.ServerWebSocket<TLocalRealtimeSocketData> =>
  !("agentLoopback" in socket.data);

export const main = async (): Promise<void> => {
  // `daemonPort()` loads the env file, so the kill-switch / opt-in vars are
  // resolved before the sandbox decision.
  const port = daemonPort();
  // Doctor engine is lazy (§3) — loaded just before listen hooks need it,
  // never at module-eval time.
  type TDoctorMod = typeof import("./doctor-report");
  let doctorMod: TDoctorMod | null = null;
  const loadDoctor = async (): Promise<TDoctorMod> => {
    if (doctorMod === null) doctorMod = await import("./doctor-report");
    return doctorMod;
  };

  // Crash-loop circuit breaker. The supervisor (systemd `Restart=always` /
  // launchd `KeepAlive`) relaunches us on every exit, so a persistent boot
  // failure (port permanently in use, a bad binary) would otherwise respawn
  // forever — flooding the log + burning CPU on each boot's sandbox/FFI setup.
  // Record this boot and, if we've restarted too many times in a short window,
  // disable self-restore and exit cleanly so the thrashing STOPS (recover with
  // `openllmd restart`). systemd ALSO has a native start-limit backstop
  // (`service.ts`); this is the cross-platform half (launchd has no equivalent).
  // Runs before the sandbox so it can't be tripped by an FS-confinement bug,
  // and before the (costly) sandbox/FFI work it's meant to stop repeating.
  guardCrashLoop();

  // Converge a pre-merge two-binary install (real `openllmd` file, units that
  // exec bare `openllmd`) onto the single `openllm daemon` binary.
  migrateLegacyInstall();

  // RTC native-crash breaker (right after the crash-loop guard, before the
  // costly sandbox/FFI work). If this host has died to a Bun/werift native fault
  // with RTC live too many times recently, withdraw RTC for this run so the
  // daemon falls back to relay-mux instead of crash-looping. Sets
  // `OPENLLM_RTC_DISABLE=1` before `mux-host`'s capability list is read.
  guardRtcCircuitBreaker();

  // A supervised boot is machine-only and never mutates credentials, but it
  // must count missing/malformed-key exits toward the crash-loop breaker.
  const gate = requireServiceApiKey("machine");
  if (!gate.ok) {
    process.stderr.write(gate.message);
    process.exit(1);
  }

  // OS sandbox is PER-CHILD, not process-wide (see
  // `docs/audits/daemon-sandbox-scoping.md`): the daemon itself boots
  // UNCONFINED so device-session PTYs can run the user's real CLI over their
  // real files; every risky child is wrapped through the `--sandbox-exec`
  // shim (`sandbox/exec.ts` `sandboxSpawnArgs`). Here we only run the cheap
  // boot-time CAPABILITY probe (platform + gates + Linux Landlock ABI) so the
  // posture rides every status push (`DaemonStatus.sandbox`) — "enforced"
  // means "risky children are wrapped".
  const sandbox = await probeSandboxCapability();
  recordSandboxState(sandbox);
  // Always record the decision at boot so an unconfined posture is visible in
  // the log, not just on the (cloud-pushed) `DaemonStatus.sandbox` field —
  // the localhost-only boot never pushes status.
  // "capability" wording: this is what wrapped children WILL get, not proof
  // any child applied it — a per-spawn apply that degrades logs its own
  // loud warning from the shim (`runSandboxExec`), fail-open per the audit.
  logInfo("sandbox", `os sandbox capability (per-child): ${sandbox}`);

  // Last-resort crash handling. The daemon is headless under launchd/systemd,
  // so an uncaught throw or rejected promise would otherwise die silently —
  // log it to `~/.openllm/openllmd.log`, then EXIT non-zero. Registering a
  // handler does NOT stop the runtime from terminating, and continuing after a
  // fatal error leaves the process in an indeterminate state; exiting lets the
  // launch agent / systemd unit restart it clean. `logError` writes
  // synchronously (appendFileSync), so the line is flushed before exit.
  const exitAfterDisposableDrain = (code: number): void => {
    void drainDisposableChildren().finally(() => process.exit(code));
  };
  // A remote peer's dead socket — or a leaked tunnel/mux stream reset — is not
  // this process's problem (see `crash-policy.ts`). Exiting over one turned an
  // unreachable WebRTC ICE candidate into a permanent crash loop; a leaked
  // `StreamResetError` (code `protocol_error` / `peer_gone` / …) was doing the
  // same. Log it (naming a reset by its code) and survive.
  const survivedTransportLabel = (err: unknown): string =>
    isStreamResetError(err)
      ? `streamReset:${err.code}`
      : "transientNetworkError";
  process.on("uncaughtException", (err) => {
    if (isSurvivableTransportError(err)) {
      logError(
        "process",
        safeDiagnosticMessage`A transient transport error was ignored.`,
        {
          label: survivedTransportLabel(err),
          error:
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        },
      );
      return;
    }
    logError(
      "process",
      safeDiagnosticMessage`The daemon encountered an uncaught exception.`,
      {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
    );

    // Durable local session hosts are detached sibling processes. A daemon
    // fatal exit must never terminate their vendor PTYs; attached browser
    // clients simply lose their transport until Phase 2 reconnects them.
    // Do not wait on network reporting.
    exitAfterDisposableDrain(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (isSurvivableTransportError(reason)) {
      logError(
        "process",
        safeDiagnosticMessage`A transient transport error was ignored.`,
        {
          label: survivedTransportLabel(reason),
          error:
            reason instanceof Error
              ? (reason.stack ?? reason.message)
              : String(reason),
        },
      );
      return;
    }
    logError(
      "process",
      safeDiagnosticMessage`The daemon encountered an unhandled rejection.`,
      {
        error:
          reason instanceof Error
            ? (reason.stack ?? reason.message)
            : String(reason),
      },
    );

    exitAfterDisposableDrain(1);
  });

  // Opt the usage cache into disk-backed survival across restarts, and hydrate
  // it from any prior file NOW — before the control relay's first status push —
  // so a freshly restarted daemon already has last-known figures to serve if
  // the post-restart usage read is rate-limited (rather than showing an error
  // with nothing to fall back to). See `usage-cache.ts`.
  enableUsagePersistence(stateDir());
  // Model-report observers pull the auth/delegate graph — defer off cold boot (§3).
  void import("./model-report")
    .then((m) => {
      m.observeLoginModelReports();
    })
    .catch((err) => logError("main", err));
  startPlanCacheSweeper();

  // Control channel (status watcher, relay) stays off the module-eval graph so
  // listen can bind before delegates / keychain / native-runtime load (§3).
  type TControlChannelMod = typeof import("./control-channel");
  let controlChannel: TControlChannelMod | null = null;
  const loadControlChannel = async (): Promise<TControlChannelMod> => {
    if (controlChannel === null) {
      controlChannel = await import("./control-channel");
    }
    return controlChannel;
  };
  const pushStatusIfChanged = async (
    trigger?: import("./status-publish-coalesce").TStatusPublishTrigger,
  ): Promise<void> => {
    const cc = await loadControlChannel();
    await cc.pushStatusIfChanged(trigger);
  };

  // Pull the catalog + routing config. This NEVER throws — when there's
  // no API key yet (the daemon installs keyless; the dashboard sets the
  // key afterwards) or the cloud isn't reachable, it records the reason
  // in `cloudState` and the daemon comes up anyway, serving the control
  // surface so the dashboard can set/fix the key. Unhealthy retries use
  // exponential backoff (§2); `no_key` stays fast so a just-set key is
  // picked up within seconds.
  const runCloudReadyWork = (): void => {
    if (getCloudState() === "ok") {
      // Eager manifest-driven device-state walk (`install.sh -s` per registry item)
      // once the cloud is reachable, so the dashboard's Integrations tab paints
      // installed-state on first connect. Fire-and-forget + cloud-gated; the status
      // watcher re-pushes when the cache lands. Re-walked after install/uninstall
      // and on a whole-daemon refresh (control-relay.ts).
      void refreshCliState()
        .then(() => pushStatusIfChanged("bootstrap"))
        .catch((err) => logError("main", err));
    }
  };
  const noteBootstrapOutcome = (): void => {
    const state = getCloudState();
    if (state === "ok") bootstrapBackoff.noteSuccess();
    else if (state !== "no_key") bootstrapBackoff.noteFailure();
  };
  const scheduleBootstrap = (): void => {
    const delay = bootstrapBackoff.nextDelayMs(getCloudState());
    const timer = setTimeout(async () => {
      try {
        // A retry that flips cloud_state (e.g. a boot-time `unreachable`
        // recovering to `ok` once the network/cloud is up) must re-push the
        // status, or the dashboard stays stuck on the stale value. Push it over
        // the relay socket immediately on change (the channel's own watcher
        // would catch it within a couple seconds anyway).
        const changed = await refreshBootstrap();
        noteBootstrapOutcome();
        if (changed) await pushStatusIfChanged("bootstrap");
        // A bootstrap that just recovered to `ok` (boot-time unreachable, or a
        // newly-set key) is the first chance to run the device-state walk.
        if (changed && getCloudState() === "ok") {
          void refreshCliState()
            .then(() => pushStatusIfChanged("bootstrap"))
            .catch((err) => logError("main", err));
        }
        // Periodic version check — picks up a release published while running,
        // and notices a binary someone else swapped (the CLI's launch check).
        // Coalesced here (§5) — the former 30s watchBinary timer is gone.
        if (getCloudState() === "ok") {
          void convergeBinary(latestCliVersion()).catch((err) =>
            logError("main", err),
          );
        }
      } catch (err) {
        // setTimeout doesn't observe the async callback's promise, so an
        // unguarded throw here is an unhandled rejection AND skips the reschedule
        // below — silently killing the bootstrap/self-update loop forever. Catch,
        // log, and always reschedule in `finally`.
        logError("main", err);
        noteBootstrapOutcome();
      } finally {
        scheduleBootstrap();
      }
    }, delay);
    timer.unref?.();
  };
  const startBootstrapLoop = (): void => {
    void refreshBootstrap()
      .then(() => {
        noteBootstrapOutcome();
        // Converge the single binary to the cloud's pinned release (no-op
        // from source / when already current). It restarts the daemon only
        // when the daemon half changed, and only once `/v1` is idle.
        // `.catch` so a rejected converge can't escape this `.then` as an
        // unhandledRejection. Gated on healthy cloud (§2 proposal).
        if (getCloudState() === "ok") {
          void convergeBinary(latestCliVersion()).catch((err) =>
            logError("main", err),
          );
        }
        runCloudReadyWork();
      })
      .catch((err) => {
        logError("main", err);
        noteBootstrapOutcome();
      })
      .finally(() => {
        scheduleBootstrap();
      });
  };

  // Lazy inference handler — keeps native-runtime / walker off the listen path (§3).
  let handleInference: ((req: Request) => Promise<Response>) | null = null;
  const inference = async (req: Request): Promise<Response> => {
    if (handleInference === null) {
      const mod = await import("./listener");
      handleInference = mod.handleInference;
    }
    return handleInference(req);
  };

  // Agent sessions (plan: agent-sessions-replace-remote-pty). The runtime pulls
  // the mux host; loaded after listen, before the relay hello (so the hello's
  // caps carry `agent1`). The loopback socket reads it per open.
  type TAgentRuntimeMod = typeof import("./agent/runtime");
  let agentRuntime: TAgentRuntimeMod | null = null;
  const localAgentWebSocket = createLocalAgentWebSocket(
    () => agentRuntime?.activeAgentDispatcher() ?? null,
  );

  // Graceful-exit beacon: flip the key offline immediately on Ctrl-C /
  // termination instead of waiting for the presence-staleness window.
  let shuttingDown = false;
  const finishShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      if (controlChannel !== null) await controlChannel.stopControlChannel();
    } catch (err) {
      logError("control-channel", err);
    }
    try {
      agentRuntime?.stopAgentSessions();
    } catch (err) {
      logError("agent", err);
    }
    // Durable local session hosts are detached from this daemon. The supervisor
    // tracks only disposable children, leaving their PTYs alone.
    await drainDisposableChildren();
    // Queued async appends would otherwise be dropped by process.exit.
    await flushLogs();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void finishShutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Bun.serve throws synchronously when the port can't be bound. The headline
  // failure is EADDRINUSE (another openllmd, or a stray process, on the port) —
  // emit ONE clear line instead of an opaque stack trace on every supervised
  // respawn, then exit non-zero (the crash-loop guard above bounds the retries).
  try {
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Long-lived connections: streaming `/v1/*` inference. The default
      // ~10s idle timeout would sever a stream between writes, so raise it to
      // Bun's max; the stream emits its own keep-alives well under it.
      idleTimeout: 255,
      fetch: async (
        req: Request,
        server: Bun.Server<TLocalSocketData>,
      ): Promise<Response | undefined> => {
        const url = new URL(req.url);
        // `/v1/realtime` is a WebSocket upgrade, not `handleInference` HTTP —
        // handled BEFORE the generic `/v1/` branch below so it never reaches
        // the inference listener. Authenticated LOCAL clients only: a
        // browser's `WebSocket` API cannot set `Authorization`, so this gate
        // alone keeps browsers off this path (they use the mux `realtime1`
        // channel instead — see `realtime-handler.ts`'s module doc).
        if (url.pathname === "/v1/realtime") {
          if (isPreflight(req)) return preflightResponse(req);
          if (!authorizeLocalRealtimeRequest(req)) {
            return new Response("unauthorized", { status: 401 });
          }
          const open = parseLocalRealtimeOpen(url);
          if (open === null) {
            return new Response(
              JSON.stringify({
                error: { message: "unsupported provider/model/voice" },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          const upgraded = server.upgrade(req, {
            data: { open, handle: null, closed: false, pending: [] },
          });
          return upgraded
            ? undefined
            : new Response("websocket upgrade failed", { status: 400 });
        }
        if (url.pathname.startsWith("/v1/")) {
          // Stamp every inference response as daemon-served — an
          // observability marker (you can always tell a response came from
          // the local daemon vs the cloud) AND a safety net: an unexpected
          // throw in `handleInference` becomes a clean error envelope
          // instead of a bare runtime 500. Body is passed through
          // untouched so streaming responses keep streaming.
          //
          // Count this request as in-flight so a self-update holds the restart
          // until it finishes (no cut streams). A streaming body keeps flowing
          // AFTER this handler returns, so `endRequest` must fire when the BODY
          // completes (or cancels/errors), not when the handler resolves —
          // `trackBodyDone` wraps the stream to do exactly that.
          beginRequest();
          let res: Response;
          try {
            res = await inference(req);
          } catch (err) {
            logError("inference", err, { path: url.pathname });
            // Carry CORS on the synthesized error too — a cross-origin dashboard
            // call must see the JSON error payload, not a CORS failure (the
            // success path inherits CORS from `handleInference`'s response).
            const errorHeaders = new Headers(corsHeaders(req));
            errorHeaders.set("content-type", "application/json");
            res = new Response(
              JSON.stringify({
                error: {
                  message: err instanceof Error ? err.message : String(err),
                },
              }),
              { status: 500, headers: errorHeaders },
            );
          }
          const headers = new Headers(res.headers);
          headers.set("x-openllm-served-by", "daemon");
          if (res.body === null) {
            endRequest();
            return new Response(null, {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
          }
          return new Response(trackBodyDone(res.body, endRequest), {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
        // `/whoami` — the public loopback identity probe: returns this daemon's
        // opaque `device_id` so the dashboard can learn which key's daemon is on
        // THIS host (a daemon answering your own loopback IS on your machine —
        // the single authoritative locality signal, replacing the IP heuristic +
        // localStorage device-code guess). No PII, no token; reuses the same
        // cross-origin CORS/PNA grant the browser already holds for `/v1/*`. See
        // `docs/proposals/this-machine-detection-audit.md`.
        if (url.pathname === "/whoami") {
          if (isPreflight(req)) return preflightResponse(req);
          const headers = new Headers(corsHeaders(req));
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify({ device_id: deviceId() }), {
            status: 200,
            headers,
          });
        }
        // `/status` — read-only loopback health snapshot. A successful fetch is
        // the authoritative "this daemon is actually SERVING" signal (the
        // supervisor only knows it has a process, not that it bound the port),
        // and it carries the real sandbox posture this process applied at boot —
        // which `openllmd status` can't compute itself. Secret-free subset of
        // `computeStatus()`; see `health.ts`. Shares the loopback CORS grant.
        // `/local/agent` — the desktop app's loopback agent sessions (no device
        // grant: loopback peer + Host, Tauri/OpenLLM Origin, local control
        // capability). See `agent/loopback.ts`.
        if (url.pathname === AGENT_HOOK_LOCAL_PATH) {
          return handleLocalAgentHook(req, server.requestIP(req)?.address);
        }
        if (url.pathname === AGENT_LOCAL_PATH) {
          const refusal = localAgentRefusal(
            req,
            server.requestIP(req)?.address,
          );
          if (refusal !== null) return localAgentRefusalResponse(refusal);
          if (agentRuntime?.activeAgentDispatcher() == null) {
            return new Response(
              JSON.stringify({ error: "agent_unavailable" }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              },
            );
          }
          const protocol = selectedLocalAgentProtocol(req);
          const upgraded = server.upgrade(req, {
            data: localAgentSocketData(),
            ...(protocol === null
              ? {}
              : { headers: { "sec-websocket-protocol": protocol } }),
          });
          return upgraded
            ? undefined
            : new Response("websocket upgrade failed", { status: 400 });
        }
        // `/local/identity` + `/local/device-control` — TOFU-free identity read
        // and device-control pin for the desktop app (same admission as
        // `/local/agent`). See `local-device-control.ts`.
        if (isLocalDeviceControlPath(url.pathname)) {
          return handleLocalDeviceControl(req, server.requestIP(req)?.address);
        }
        if (url.pathname === AUTH_LOCAL_PATH) return handleLocalAuth(req);
        {
          const doctor = await loadDoctor();
          if (doctor.isDoctorLocalPath(url.pathname)) {
            return doctor.handleDoctorLocal(req);
          }
        }
        if (url.pathname === "/status") {
          if (isPreflight(req)) return preflightResponse(req);
          const headers = new Headers(corsHeaders(req));
          headers.set("content-type", "application/json");
          const health = buildHealth({
            version: DAEMON_VERSION,
            installedVersion: getCliState().version ?? null,
            port,
            sandbox: sandboxState(),
            cloudState: getCloudState(),
            keyConfigured: hasApiKey(),
            cloudOrigin: daemonEnv().cloudOrigin,
            bootAt: BOOT_AT,
            now: Date.now(),
          });
          return new Response(JSON.stringify(health), { status: 200, headers });
        }
        // All other control remains relay-only; the capability-gated local
        // auth/doctor routes above never authorize a browser→loopback call.
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
      // Two local WS surfaces: `/v1/realtime` and `/local/agent` (see `fetch`
      // above). Every upgrade already passed its admission; `data` says which
      // surface the socket belongs to.
      websocket: {
        open: (socket) => {
          if (isAgentSocket(socket)) localAgentWebSocket.open(socket);
          else if (isRealtimeSocket(socket))
            localRealtimeWebSocket.open(socket);
        },
        message: (socket, message) => {
          if (isAgentSocket(socket))
            localAgentWebSocket.message(socket, message);
          else if (isRealtimeSocket(socket))
            localRealtimeWebSocket.message(socket, message);
        },
        close: (socket) => {
          if (isAgentSocket(socket)) localAgentWebSocket.close(socket);
          else if (isRealtimeSocket(socket))
            localRealtimeWebSocket.close(socket);
        },
      },
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    // BOTH channels: `logError` lands in the shared log file only — without a
    // stderr line a foreground/dev run (`bun dev:sb`) dies as a bare exit 1
    // with no visible reason.
    if (code === "EADDRINUSE") {
      const msg =
        `port ${port} already in use — another openllmd (or a stray process) holds 127.0.0.1:${port}. ` +
        "Stop it (`openllmd stop`) or set OPENLLM_DAEMON_PORT to a free port.";
      process.stderr.write(`openllmd: ${msg}\n`);
      logError("boot", msg);
    } else {
      process.stderr.write(
        `openllmd: boot failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      logError("boot", err);
    }
    void loadDoctor()
      .then((d) => d.onDoctorListenAttempt(false))
      .catch((err: unknown) => {
        logError("boot", err);
      });
    exitAfterDisposableDrain(1);
    return;
  }

  {
    const doctor = await loadDoctor();
    doctor.initDoctorCursorAtTail();
    if (!doctor.onDoctorListenAttempt(true)) {
      const msg =
        "doctor capability could not be persisted; local doctor routes fail closed";
      process.stderr.write(`openllmd: ${msg}\n`);
      logError("boot", msg);
    }
  }

  // Reap verified disposable children left by a prior daemon instance —
  // FIRE-AND-FORGET. This must NOT gate cloud registration: on a machine with a
  // pile of orphaned probes the TERM→grace→KILL sweep can take seconds, and the
  // `hello`/registration handshake must not wait on it (that delay was a boot
  // wedge — the relay saw connect→disconnect and registration never stuck). The
  // sweep only touches prior-instance orphans, never this daemon's own work, so
  // running it concurrently with startup is safe.
  void sweepStaleChildrenOnBoot().catch((err: unknown) => {
    logError("child-supervisor", err);
  });

  // Dial the control channel as soon as the listener is bound so a planned
  // restart reconnects in seconds, not after session-host reconcile. Commands
  // stay deferred until reconcile finishes (handlers must not race that pass).
  // See `docs/audit/2026-10-20-deploy-zero-downtime.md` fix #3.
  // Register the agent dispatcher BEFORE the hello so its caps carry `agent1`.
  try {
    agentRuntime = await import("./agent/runtime");
    agentRuntime.startAgentSessions();
  } catch (err) {
    logError("agent", err);
  }

  const cc = await loadControlChannel();
  cc.startControlChannel({ deferCommandsUntilReady: true });

  // Reconcile the durable session-host registry before releasing commands so
  // handlers cannot race an in-flight reap. Discovery is bounded and async (it
  // yields), but `main` awaits it at this boot boundary. A live socket directory
  // belongs to an independent session process and is adopted (kept); only
  // incomplete or dead entries are removed. Identity timeouts stay unknown and
  // never authorize deletion.
  try {
    await reconcileSessionHostsAtBoot();
  } catch (err) {
    logError("session", err);
  }
  cc.markControlChannelCommandsReady();

  // Local discovery is demand-adjacent and not required to bind the port —
  // load it after listen so its probe graph stays off the cold boot path (§3).
  void import("./local-servers")
    .then((m) => {
      m.startLocalServerDiscovery();
    })
    .catch((err) => logError("main", err));

  // Bootstrap is intentionally last: the listener is already bound and relay
  // presence can only be published after it is routeable. Keep cloud-dependent
  // device/model work chained to the initial refresh.
  startBootstrapLoop();

  // Mark this boot as healthy once the listener is bound and a small stabilization
  // window has elapsed, then clear the crash-loop history so transient restarts do
  // not accumulate into a permanent park.
  setTimeout(() => {
    markHealthyBoot();
  }, 3_000);

  // Single line to stdout so the install-time launcher can confirm boot.
  process.stdout.write(
    `openllmd v${DAEMON_VERSION}${isDevMode() ? " (dev)" : ""} listening on http://127.0.0.1:${port}\n`,
  );
  logInfo("boot", `openllmd v${DAEMON_VERSION} listening on :${port}`);
};

/**
 * The daemon half of the single `openllm` binary. The CLI entry calls this
 * with the args after `daemon` (or the raw argv for the internal re-exec
 * flags / an `openllmd`-named invocation). Management subcommands dispatch
 * here; a bare invocation boots the service, which is always machine mode
 * and must never consume terminal input.
 */
export const runDaemon = (args: readonly string[]): void => {
  if (!runCli(args)) void main();
};

// From-source runs (`bun packages/cli/daemon/src/main.ts`) still boot directly.
if (import.meta.main) runDaemon(process.argv.slice(2));
