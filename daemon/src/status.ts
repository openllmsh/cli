/**
 * The daemon's status snapshot, computed in one place so the `/status`
 * one-shot endpoint and the `/events` SSE push share identical logic.
 *
 * Computing it probes each delegate's `status()` (cheap CLI `--version` + a
 * local store/metadata read — not token refresh). Callers should not hammer
 * it; the relay status watcher also recomputes on a gentle interval while the
 * daemon is connected, even with no dashboard SSE client.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  TDaemonProviderAuthStatus,
  TDaemonProviderConnection,
  TDaemonStatus,
  TProviderUsageSnapshot,
} from "@openllmsh/protocol";
import { normalizeProviderConnection } from "@openllmsh/protocol";
import { setVerifiedLoginAdmitter } from "./auth-events";
import { autoUpdateEnabled } from "./auto-update-pref";
import { getCloudState } from "./config";
import type { TDeadlineBudget } from "./deadline-budget";
import {
  createDeadlineBudget,
  timeoutCallbackLatenessMs,
  waitUntilExpired,
} from "./deadline-budget";
import { DELEGATES, getDelegate, isSubscriptionSlug } from "./delegation";
import {
  loginOwnershipPending,
  loginSlot,
  providerAuthOperationActive,
  providerLogoutActive,
  resetProviderAuthOperationsForTests,
} from "./delegation/login-flow";
import {
  resetStoreIdentityEpochsForTests,
  storeIdentityEpoch,
} from "./delegation/observation-cache";
import { DEFAULT_CAPTURE_TIMEOUT_MS } from "./delegation/spawn";
import { STATUS_CHECK_FAILED_DETAIL } from "./delegation/util";
import { getCliState } from "./device-state";
import { daemonPort, hasApiKey } from "./env";
import { authCooldownForProvider } from "./hop-cooldown";
import { hasIdentityConflict } from "./identity-state";
import { daemonPublicKey } from "./keypair";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { currentDaemonCaps } from "./mux-host";
import {
  currentTickId,
  nextStatusTickId,
  opTickContext,
  withoutCommandReplayContext,
  withUsageNativeRefresh,
} from "./op-context";
import { resolveOnPath } from "./path-utils";
import { getPendingAuth, pendingAuthWire } from "./pending-auth";
import { ptySessionsEnabled } from "./pty-sessions-pref";
import { sandboxState } from "./sandbox/landlock";
import { ptySupported, sessionStatusReport } from "./session-host";
import type {
  TStatusPublishQueueSnapshot,
  TStatusPublishTrigger,
} from "./status-publish-coalesce";
import { cachedUsage, peekUsage } from "./usage-cache";
import { attachVendorCliInstall } from "./vendor-cli-install";
import { DAEMON_VERSION } from "./version";

/** True when `path` is a regular file the process can execute. */
const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const SESSION_CLI_PROBE_TTL_MS = 30_000;
let opencodeProbe: { readonly at: number; readonly found: boolean } | null =
  null;
let hermesProbe: { readonly at: number; readonly found: boolean } | null = null;

// Status runs at hello/reconnect plus the flow watcher cadence. Each delegate's
// version/auth capture self-terminates its process group at
// `DEFAULT_CAPTURE_TIMEOUT_MS`; this wider snapshot ceiling leaves that cleanup
// time to finish before status degrades and the next snapshot retries it.
const DELEGATE_STATUS_TIMEOUT_MS = 10_000;

if (DELEGATE_STATUS_TIMEOUT_MS < DEFAULT_CAPTURE_TIMEOUT_MS) {
  throw new Error("delegate status timeout must cover the capture timeout");
}

// A failed probe cannot establish that a CLI was removed or a credential was
// revoked. Preserve the last complete observation when this daemon has one;
// otherwise omit the unknown installation state rather than serializing it as
// a definitive `false` to the cloud.
const lastKnownConnections = new Map<string, TDaemonProviderConnection>();

/** User-initiated logout, sticky until the next successful login (or a
 *  failed logout that never actually signed out). Set at command receipt. */
const signedOutByUser = new Set<string>();

/** Mark `slug` signed-out at logout command receipt, before `delegate.logout()`. */
export const markProviderSignedOut = (slug: string): void => {
  signedOutByUser.add(slug);
  pendingVerifiedPublish.delete(slug);
  admittedLoginFlow.delete(slug);
};

/** One-shot: publish the verified login row without a passive probe. */
const pendingVerifiedPublish = new Set<string>();
/** Last verified login `flow_id` per slug — not last-known observation. */
const admittedLoginFlow = new Map<string, string>();

/** Clear sticky signed-out (successful login, or a logout that did not take). */
export const clearProviderSignedOut = (slug: string): void => {
  signedOutByUser.delete(slug);
};

/**
 * Late inner/outer determinate results must not publish across user logout or
 * an in-flight login: generation+fingerprint can still match while the vendor
 * still reports connected.
 */
export {
  beginProviderAuthOperation,
  endProviderAuthOperation,
} from "./delegation/login-flow";

const providerAuthOwned = (slug: string): boolean =>
  isSubscriptionSlug(slug) && providerAuthOperationActive(slug);

export const lateProviderAdmitBlocked = (slug: string): boolean =>
  signedOutByUser.has(slug) || providerAuthOwned(slug);

/**
 * Seed last-known Connected from a still-owned verified login. Does not probe,
 * copy prior account/usage, or invent cli_installed. Login-flow calls this
 * through the auth-events admitter so status does not import back into
 * delegation.
 */
export const admitVerifiedLoginObservation = (flow: {
  readonly slug: string;
  readonly flowId: string;
}): boolean => {
  const slug = flow.slug;
  if (providerLogoutActive(slug)) return false;
  const slot = loginSlot(slug);
  const live = slot.flow();
  if (live !== null && live.flowId !== flow.flowId) return false;
  if (live !== null && slot.wasCancelled()) return false;
  if (live === null && slot.inFlight()) return false;
  if (live === null && signedOutByUser.has(slug)) return false;
  const previous = lastKnownConnections.get(slug);
  signedOutByUser.delete(slug);
  lastKnownConnections.set(slug, {
    provider: slug,
    status: "connected",
    observation: "connected",
    ...(previous?.cli_installed !== undefined
      ? { cli_installed: previous.cli_installed }
      : {}),
    last_login_at_ms: statusNow(),
  });
  pendingVerifiedPublish.add(slug);
  admittedLoginFlow.set(slug, flow.flowId);
  return true;
};

/** True only for this command's successful admit, not leftover last-known. */
export const loginAdmittedForCommand = (
  slug: string,
  flowId: string,
): boolean =>
  !signedOutByUser.has(slug) && admittedLoginFlow.get(slug) === flowId;

setVerifiedLoginAdmitter(admitVerifiedLoginObservation);

const PROBE_BACKOFF_AFTER = 2;
const PROBE_BACKOFF_BASE_MS = 15_000;
const PROBE_BACKOFF_MAX_MS = 60_000;

type TProbeBackoff = {
  consecutiveUnknown: number;
  untilMs: number;
  identityEpoch: number;
};

const probeBackoff = new Map<string, TProbeBackoff>();
let statusNow = (): number => Date.now();

/** Test-only clock for probe backoff. Pass `null` to restore. */
export const setStatusClockForTests = (fn: (() => number) | null): void => {
  statusNow = fn ?? (() => Date.now());
};

export const clearProviderProbeBackoff = (slug: string): void => {
  probeBackoff.delete(slug);
};

const forceProbeTrigger = (
  trigger: TStatusPublishTrigger | undefined,
): boolean => trigger === "command" || trigger === "auth-sink";

const noteProbeIndeterminate = (slug: string, indeterminate: boolean): void => {
  if (!indeterminate) {
    probeBackoff.delete(slug);
    return;
  }
  const prev = probeBackoff.get(slug);
  const consecutiveUnknown = (prev?.consecutiveUnknown ?? 0) + 1;
  let untilMs = prev?.untilMs ?? 0;
  if (consecutiveUnknown >= PROBE_BACKOFF_AFTER) {
    const shift = Math.min(consecutiveUnknown - PROBE_BACKOFF_AFTER, 2);
    untilMs =
      statusNow() +
      Math.min(PROBE_BACKOFF_BASE_MS * 2 ** shift, PROBE_BACKOFF_MAX_MS);
  }
  probeBackoff.set(slug, {
    consecutiveUnknown,
    untilMs,
    identityEpoch: storeIdentityEpoch(slug),
  });
};

const probeBackoffBlocks = (slug: string, force: boolean): boolean => {
  if (force) return false;
  const entry = probeBackoff.get(slug);
  if (entry === undefined) return false;
  if (storeIdentityEpoch(slug) !== entry.identityEpoch) {
    probeBackoff.delete(slug);
    return false;
  }
  return entry.untilMs > statusNow();
};

/** Test-only: sticky logout flag after late-admit attempts. */
export const providerSignedOutByUserForTests = (slug: string): boolean =>
  signedOutByUser.has(slug);

const applyAuthLiteral = (
  slug: string,
  conn: TDaemonProviderConnection,
): TDaemonProviderConnection => {
  const localPending = getPendingAuth(slug);
  if (localPending?.localOnly === true) {
    conn = {
      ...conn,
      detail: "Sign-in is running on this machine.",
      pending_auth: pendingAuthWire(localPending),
    };
  }
  const last = lastKnownConnections.get(slug);
  const inFlight = providerAuthOwned(slug);
  const normalized = normalizeProviderConnection(conn);
  const indeterminate =
    normalized.observation === "unknown" ||
    conn.detail === STATUS_CHECK_FAILED_DETAIL;
  // Determinate = this tick's vendor read, not last-known overlay.
  const determinate = !inFlight && !indeterminate && !normalized.pending;

  if (determinate && normalized.observation === "connected") {
    // Logout receipt sets the sticky flag while the vendor may still
    // read connected until `delegate.logout()` finishes. Only a rising
    // edge (fresh connected, last-known was not connected) is a login
    // by any path and clears the flag.
    if (signedOutByUser.has(slug) && last?.status === "connected") {
      return {
        ...conn,
        status: "signed_out",
        observation: "signed_out",
      };
    }
    signedOutByUser.delete(slug);
    return { ...conn, status: "connected", observation: "connected" };
  }
  if (signedOutByUser.has(slug) || normalized.signed_out) {
    return { ...conn, status: "signed_out", observation: "signed_out" };
  }
  if (!determinate) {
    const preserved: TDaemonProviderAuthStatus = last?.status ?? conn.status;
    const stored = getPendingAuth(slug);
    const owner = loginOwnershipPending(slug);
    const livePending =
      conn.pending_auth ??
      (stored !== null
        ? pendingAuthWire(stored, {
            cancel_requested: owner?.cancel_requested === true,
          })
        : owner !== null
          ? owner
          : undefined);
    const base = last !== undefined ? last : conn;
    return {
      ...base,
      detail: conn.detail ?? base.detail,
      status: preserved,
      observation: "unknown",
      reason_code: normalized.reason_code ?? "probe_failed",
      ...(livePending !== undefined ? { pending_auth: livePending } : {}),
    };
  }
  return {
    ...conn,
    status: "disconnected",
    observation: "disconnected",
    reason_code: normalized.reason_code ?? "credential_absent",
  };
};

type TSlugProbe = {
  readonly promise: Promise<TDaemonProviderConnection>;
  settled: boolean;
};

const inFlightSlugProbes = new Map<string, TSlugProbe>();
let inFlightStatus: Promise<TDaemonStatus> | null = null;

const dropSettledSlugProbes = (): void => {
  for (const [slug, probe] of inFlightSlugProbes) {
    if (probe.settled) inFlightSlugProbes.delete(slug);
  }
};

const connectionFingerprint = (conn: TDaemonProviderConnection): string =>
  JSON.stringify(conn);

const defaultLateProbePush = (): void => {
  void import("./control-channel")
    .then((mod) => mod.pushStatusIfChanged("late-probe"))
    .catch(() => {});
};

let requestLateProbePush: () => void = defaultLateProbePush;

const emptyPublishQueueSnapshot = (): TStatusPublishQueueSnapshot => ({
  queued_publish_depth: 0,
  collapsed_count: 0,
  oldest_queued_publish_age_ms: 0,
  status_trigger: undefined,
});

let readPublishQueueSnapshot: () => TStatusPublishQueueSnapshot =
  emptyPublishQueueSnapshot;

/** Control-channel coalescer registers here so observer timeouts can log D0 queue fields. */
export const setStatusPublishQueueSnapshot = (
  fn: (() => TStatusPublishQueueSnapshot) | null,
): void => {
  readPublishQueueSnapshot = fn ?? emptyPublishQueueSnapshot;
};

/** Test-only: intercept the late-probe status push. Pass `null` to restore. */
export const setLateProbeStatusPushForTests = (
  fn: (() => void) | null,
): void => {
  requestLateProbePush = fn ?? defaultLateProbePush;
};

/** Last complete observation for `slug`, if any. Read-only — no probe. */
export const peekLastKnownConnection = (
  slug: string,
): TDaemonProviderConnection | undefined => lastKnownConnections.get(slug);

/** Test-only: last-known is process-global and otherwise unreadable. */
export const lastKnownConnectionForTests = (
  slug: string,
): TDaemonProviderConnection | undefined => peekLastKnownConnection(slug);

/** Test-only: seed last-known without running `computeStatus`. */
export const seedLastKnownConnectionForTests = (
  conn: TDaemonProviderConnection,
): void => {
  lastKnownConnections.set(conn.provider, conn);
};

/** Test-only: the last-known map is process-global and leaks across suites. */
export const resetLastKnownConnectionsForTests = (): void => {
  lastKnownConnections.clear();
  signedOutByUser.clear();
  resetProviderAuthOperationsForTests();
  resetStoreIdentityEpochsForTests();
  pendingVerifiedPublish.clear();
  admittedLoginFlow.clear();
  probeBackoff.clear();
  inFlightSlugProbes.clear();
  inFlightStatus = null;
  requestLateProbePush = defaultLateProbePush;
  statusNow = () => Date.now();
};

const recordLateProbeOutcome = (
  slug: string,
  raw: TDaemonProviderConnection,
): void => {
  const previous = lastKnownConnections.get(slug);
  const conn = applyAuthLiteral(slug, raw);
  rememberConnection(slug, raw, conn);
  const next = lastKnownConnections.get(slug);
  if (next === undefined) return;
  if (
    previous !== undefined &&
    connectionFingerprint(previous) === connectionFingerprint(next)
  ) {
    return;
  }
  requestLateProbePush();
};

/**
 * Inner shared-auth (or equivalent) determinate result after the outer observer
 * already returned unknown. Same last-known + push rules as an abandoned outer
 * producer. Callers must fence generation + store identity before invoking.
 */
export const admitLateProviderConnection = (
  slug: string,
  raw: TDaemonProviderConnection,
): void => {
  if (lateProviderAdmitBlocked(slug)) return;
  recordLateProbeOutcome(slug, raw);
};

const statusFailure = (slug: string): TDaemonProviderConnection => {
  const lastKnown = lastKnownConnections.get(slug);
  if (lastKnown !== undefined) {
    return {
      ...lastKnown,
      detail: STATUS_CHECK_FAILED_DETAIL,
      observation: "unknown",
      reason_code: "probe_timeout",
    };
  }
  return {
    provider: slug,
    // Probe failure is not a logout assertion. Cold-start keeps legacy
    // `disconnected` plus typed `unknown` and does not write last-known
    // (so it cannot emit credential_gone).
    status: "disconnected",
    observation: "unknown",
    reason_code: "probe_timeout",
    detail: STATUS_CHECK_FAILED_DETAIL,
  };
};

const awaitProducer = async (
  slug: string,
  producer: Promise<TDaemonProviderConnection>,
  markAbandoned: () => void,
  ownerBudget?: TDeadlineBudget,
  joined = false,
): Promise<TDaemonProviderConnection> => {
  const observerBudget =
    ownerBudget ?? createDeadlineBudget(DELEGATE_STATUS_TIMEOUT_MS);
  const observerStartedWall = Date.now();
  const timerArmedAtMs = performance.now();
  const observerDelayMs = observerBudget.remainingMs();
  let settled = false;
  return Promise.race([
    producer.then((conn) => {
      settled = true;
      return conn;
    }),
    waitUntilExpired(observerBudget).then((): TDaemonProviderConnection => {
      const timerFiredAtMs = performance.now();
      if (settled) return statusFailure(slug);
      markAbandoned();
      logWarn(
        "status",
        safeDiagnosticMessage`delegate status probe timed out`,
        {
          slug,
          phase: "delegate_status",
          timeout_ms: DELEGATE_STATUS_TIMEOUT_MS,
          elapsed_ms: Date.now() - observerStartedWall,
          observer_started_at_ms: timerArmedAtMs,
          timer_armed_at_ms: timerArmedAtMs,
          timer_fired_at_ms: timerFiredAtMs,
          timeout_callback_lateness_ms: timeoutCallbackLatenessMs(
            timerArmedAtMs,
            timerFiredAtMs,
            observerDelayMs,
          ),
          clock_elapsed: "Date.now",
          clock_timer: "performance.now",
          joined,
          cancellable: getDelegate(slug)?.statusCancellable === true,
          tick_id: currentTickId(),
          ...readPublishQueueSnapshot(),
        },
      );
      return statusFailure(slug);
    }),
  ]);
};

type TBoundedDelegateStatusOptions = {
  readonly force?: boolean;
  readonly reuseSettled?: boolean;
};

const overlayUnknownObservation = (slug: string): TDaemonProviderConnection => {
  const lastKnown = lastKnownConnections.get(slug);
  if (lastKnown !== undefined) {
    return {
      ...lastKnown,
      detail: STATUS_CHECK_FAILED_DETAIL,
      observation: "unknown",
      reason_code: lastKnown.reason_code ?? "probe_failed",
    };
  }
  return statusFailure(slug);
};

const boundedDelegateStatus = async (
  slug: string,
  status: (signal?: AbortSignal) => Promise<TDaemonProviderConnection>,
  options?: TBoundedDelegateStatusOptions,
): Promise<TDaemonProviderConnection> => {
  const parentTick = opTickContext.getStore();
  const run = async (): Promise<TDaemonProviderConnection> => {
    if (providerAuthOwned(slug)) {
      return overlayUnknownObservation(slug);
    }
    const existing = inFlightSlugProbes.get(slug);
    if (
      existing !== undefined &&
      (options?.reuseSettled === true || !existing.settled)
    ) {
      return awaitProducer(slug, existing.promise, () => {}, undefined, true);
    }
    if (probeBackoffBlocks(slug, options?.force === true)) {
      return overlayUnknownObservation(slug);
    }
    const ownerBudget = createDeadlineBudget(DELEGATE_STATUS_TIMEOUT_MS);
    let abandoned = false;
    const producer: Promise<TDaemonProviderConnection> = status(
      ownerBudget.signal,
    ).then(
      (conn) => conn,
      (err: unknown) => {
        logWarn("status", `status() failed for ${slug}`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return statusFailure(slug);
      },
    );
    const probe: TSlugProbe = { promise: producer, settled: false };
    inFlightSlugProbes.set(slug, probe);
    void producer.finally(() => {
      if (inFlightSlugProbes.get(slug) === probe) {
        probe.settled = true;
      }
    });
    void producer.then((conn) => {
      if (abandoned) recordLateProbeOutcome(slug, conn);
    });
    return awaitProducer(
      slug,
      producer,
      () => {
        abandoned = true;
      },
      ownerBudget,
      false,
    );
  };
  return withoutCommandReplayContext(() =>
    parentTick === undefined
      ? run()
      : opTickContext.run({ tick_id: parentTick.tick_id, slug }, run),
  );
};

/** OpenCode is a device-session client (not a subscription delegate). Surface
 *  install presence so the device picker can offer it when the binary exists. */
const opencodeInstalled = (): boolean => {
  if (
    opencodeProbe !== null &&
    Date.now() - opencodeProbe.at < SESSION_CLI_PROBE_TTL_MS
  ) {
    return opencodeProbe.found;
  }
  const home = homedir();
  const candidates = [
    join(home, ".opencode", "bin", "opencode"),
    join(home, ".local", "bin", "opencode"),
    ...resolveOnPath("opencode"),
  ];
  const found = candidates.some((path) => isExecutableFile(path));
  opencodeProbe = { at: Date.now(), found };
  return found;
};

/** Hermes is a device-session client (not a subscription delegate). */
const hermesInstalled = (): boolean => {
  if (
    hermesProbe !== null &&
    Date.now() - hermesProbe.at < SESSION_CLI_PROBE_TTL_MS
  ) {
    return hermesProbe.found;
  }
  const home = homedir();
  const candidates = [
    join(home, ".hermes", "bin", "hermes"),
    join(home, ".local", "bin", "hermes"),
    ...resolveOnPath("hermes"),
  ];
  const found = candidates.some((path) => isExecutableFile(path));
  hermesProbe = { at: Date.now(), found };
  return found;
};

const rememberConnection = (
  slug: string,
  raw: TDaemonProviderConnection,
  conn: TDaemonProviderConnection,
): void => {
  if (
    conn.observation !== "unknown" &&
    conn.detail !== STATUS_CHECK_FAILED_DETAIL &&
    !providerAuthOwned(slug) &&
    // Overlaying signed_out on a still-connected vendor read (logout
    // in flight) must not rewrite last-known to signed_out, or the
    // next connected tick would look like a login rising edge.
    !(conn.status === "signed_out" && raw.status === "connected")
  ) {
    lastKnownConnections.set(slug, conn);
  }
};

/**
 * Visibility-only overlay: a live `auth` hop cooldown on a subscription
 * slug. Attached AFTER {@link rememberConnection} so last-known never
 * persists a transient cooldown. Does not rewrite status/observation.
 */
const attachUpstreamAuthCooldown = (
  slug: string,
  conn: TDaemonProviderConnection,
): TDaemonProviderConnection => {
  if (!isSubscriptionSlug(slug)) return conn;
  const cooldown = authCooldownForProvider(slug);
  if (cooldown === null) return conn;
  return { ...conn, upstream_auth_cooldown: cooldown };
};

/**
 * Join the one per-slug status producer. Walkers and other local callers must
 * use this instead of `delegate.status()` so last-known and in-flight sharing
 * stay in one place.
 */
export const readProviderStatus = async (
  slug: string,
): Promise<TDaemonProviderConnection | null> => {
  const d = getDelegate(slug);
  if (d === null) return null;
  // Capture before the await: an overlay unknown from login/logout is not a
  // probe failure and must not arm observer backoff. A login that starts
  // after this point still ran a real probe (boundedDelegateStatus checks
  // ownership again at start).
  const authSuppressed = providerAuthOwned(d.slug);
  const raw = await boundedDelegateStatus(
    d.slug,
    (signal) => d.status(signal),
    { force: true },
  );
  const conn = applyAuthLiteral(d.slug, raw);
  rememberConnection(d.slug, raw, conn);
  if (!authSuppressed) {
    noteProbeIndeterminate(
      d.slug,
      conn.observation === "unknown" ||
        conn.detail === STATUS_CHECK_FAILED_DETAIL,
    );
  }
  return conn;
};

export type TComputeStatusFreshOptions = {
  /**
   * Late-probe publish must join the producer that just settled rather than
   * spawn a second child. Watcher/command/login follow-ups omit this so a new
   * tick drops settled flights and re-reads vendors.
   */
  readonly reuseSettledSlugProbes?: boolean;
  /** Publication trigger — command/auth bypass observer backoff. */
  readonly trigger?: TStatusPublishTrigger;
};

const computeStatusFreshInner = async (
  options?: TComputeStatusFreshOptions,
): Promise<TDaemonStatus> => {
  const force = forceProbeTrigger(options?.trigger);
  const connections = await Promise.all(
    Object.values(DELEGATES).map(async (d) => {
      try {
        if (pendingVerifiedPublish.has(d.slug)) {
          pendingVerifiedPublish.delete(d.slug);
          const seeded = lastKnownConnections.get(d.slug);
          if (seeded?.observation === "connected") {
            return attachVendorCliInstall(
              attachUpstreamAuthCooldown(d.slug, seeded),
            );
          }
        }
        const raw = await boundedDelegateStatus(
          d.slug,
          (signal) => d.status(signal),
          { force, reuseSettled: options?.reuseSettledSlugProbes === true },
        );
        const conn = applyAuthLiteral(d.slug, raw);
        rememberConnection(d.slug, raw, conn);
        if (!providerAuthOwned(d.slug) && !probeBackoffBlocks(d.slug, force)) {
          // An absent CLI is a definite (cheap stat) answer, not a flaky
          // probe: backing it off would delay detecting a finished vendor
          // install by up to the backoff ceiling and publish a placeholder
          // that drops `cli_installed` in the meantime.
          noteProbeIndeterminate(
            d.slug,
            conn.reason_code !== "cli_unavailable" &&
              (conn.observation === "unknown" ||
                conn.detail === STATUS_CHECK_FAILED_DETAIL),
          );
        }
        // Installer metadata is merged AFTER auth overlays / last-known spreads
        // so a probe timeout cannot drop this-tick `cli_install`, and last-known
        // never has to persist process-local progress.
        let published = attachUpstreamAuthCooldown(d.slug, conn);
        // Attach a metadata-only usage snapshot for connected providers so the
        // dashboard can show remaining quota (read locally; never a token).
        if (
          normalizeProviderConnection(published).observation !== "connected"
        ) {
          return attachVendorCliInstall(published);
        }
        // PEEK only — never hit the vendor here. `computeStatus` runs on every
        // status push (hello/reconnect, the periodic observer, post-command),
        // and the vendor usage endpoint rate-limits independently of inference;
        // reading it on that cadence 429'd it ("Claude usage is rate-limited
        // right now") on a daemon nobody was even looking at. Usage is read ONLY
        // on demand — the `refresh` command → `refreshUsage` (the manual button
        // or the providers page mounting). Here we just attach whatever that last
        // on-demand read cached. See `usage-cache.ts`.
        const usage = peekUsage(d.slug, published.account_hash);
        if (usage !== null) published = { ...published, usage };
        return attachVendorCliInstall(published);
      } catch (err) {
        // One provider's status read must NOT sink the whole snapshot (every
        // card would vanish + the push would fail). Surface a safe placeholder;
        // the next push self-corrects once the provider recovers.
        logWarn("status", `status() failed for ${d.slug}`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return attachVendorCliInstall(
          attachUpstreamAuthCooldown(d.slug, statusFailure(d.slug)),
        );
      }
    }),
  );
  // Device-session-only CLI (no subscription connect card). Append so the
  // device picker can list it; /providers filters to subscription slugs.
  if (opencodeInstalled()) {
    connections.push({
      provider: "opencode",
      status: "disconnected",
      cli_installed: true,
    });
  }
  if (hermesInstalled()) {
    connections.push({
      provider: "hermes",
      status: "disconnected",
      cli_installed: true,
    });
  }
  return {
    daemon_version: DAEMON_VERSION,
    key_configured: hasApiKey(),
    auto_update: autoUpdateEnabled(),
    pty_sessions: ptySessionsEnabled(),
    cloud_state: getCloudState(),
    pubkey: daemonPublicKey(),
    identity_conflict: hasIdentityConflict() || undefined,
    port: daemonPort(),
    sandbox: sandboxState(),
    caps: currentDaemonCaps(),
    control_caps: ["refresh_models_due"],
    connections,
    // TTL-cached CLI probe from `getCliState()`. It returns cached state when fresh
    // and schedules a background refresh when stale, so status can stay responsive
    // without blocking and without manifest scans.
    cli: getCliState(),
    // Device chat sessions (feature §2.2): whether this box can host a
    // PTY, and the sessions it currently holds (live/dormant).
    pty_supported: ptySupported(),
    sessions: await sessionStatusReport(),
  };
};

export const computeStatusFresh = (
  options?: TComputeStatusFreshOptions,
): Promise<TDaemonStatus> => {
  if (options?.reuseSettledSlugProbes !== true) {
    dropSettledSlugProbes();
  }
  const tick_id = nextStatusTickId();
  return withoutCommandReplayContext(() =>
    opTickContext.run({ tick_id }, () => computeStatusFreshInner(options)),
  );
};

export const computeStatus = async (): Promise<TDaemonStatus> => {
  if (inFlightStatus === null) {
    const flight = computeStatusFresh().finally(() => {
      if (inFlightStatus === flight) {
        inFlightStatus = null;
      }
    });
    inFlightStatus = flight;
  }
  return inFlightStatus;
};

/**
 * Command-driven usage read for connected providers (or just `slug`). The
 * subsequent status push serves the result through `peekUsage`. Automatic
 * callers respect cache TTLs and never renew tokens. Explicit manual refresh
 * bypasses the usage TTL and permits existing native renewal, scoped per
 * provider/account. Each provider is best-effort: a failed read preserves its
 * last-good figures plus failure metadata without blocking other providers.
 */
export const refreshUsage = async (
  slug?: string,
  options?: { readonly manual?: boolean },
): Promise<{ readonly deferred: readonly string[] }> => {
  // Join the canonical snapshot — never a raw `d.status()` bypass that would
  // start a second producer beside `computeStatus`. `allSettled`, NOT `all`:
  // ONE provider throwing (e.g. a failing usage read) must not reject the whole
  // refresh — that would error the `refresh` command ack, so the dashboard's
  // "Refresh usage" button would fail and every card stay stale just because a
  // single provider is broken. Each provider's read is independent +
  // best-effort (`cachedUsage` already swallows fetch failures into an
  // `unavailable` snapshot).
  const manual = options?.manual === true;
  if (slug === undefined) {
    const deferred: string[] = [];
    await Promise.allSettled(
      Object.values(DELEGATES).map(async (d) => {
        const one = await refreshUsage(d.slug, options);
        deferred.push(...one.deferred);
      }),
    );
    return { deferred };
  }
  if (providerAuthOperationActive(slug) || loginSlot(slug).inFlight()) {
    return { deferred: [slug] };
  }
  const d = DELEGATES[slug];
  if (d === undefined) return { deferred: [] };
  const raw = await boundedDelegateStatus(slug, (signal) => d.status(signal), {
    force: manual,
  });
  const conn = applyAuthLiteral(slug, raw);
  rememberConnection(slug, raw, conn);
  if (!normalizeProviderConnection(conn).serviceable) {
    return { deferred: [] };
  }
  const fetchUsage = (): Promise<TProviderUsageSnapshot> =>
    manual
      ? withUsageNativeRefresh(() => d.usage(), conn.account_hash)
      : d.usage();
  await cachedUsage(slug, fetchUsage, {
    accountHash: conn.account_hash,
    ...(manual ? { force: true } : {}),
  });
  return { deferred: [] };
};
