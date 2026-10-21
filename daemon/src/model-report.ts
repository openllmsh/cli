/**
 * Daemon writer for the cloud's per-user model cache
 * (live-provider-model-catalog proposal §4).
 *
 * Demand-driven: live vendor `listModels()` runs only on
 * `auth.login.succeeded` (scoped to that provider) or a `refresh_models`
 * command. Automatic discovery (`mode: "auto"` / `refresh_models_due`)
 * calls `discoverModels` only — never `listModels` — and never resets
 * the throttle. Idle bootstrap ticks must not acquire catalogs or
 * refresh tokens. Previously reported daemon rows stay until a later
 * successful report replaces them.
 *
 * Per-provider throttle: one delegate's failure doesn't block another's
 * cadence. A vendor CLI version change bypasses the TTL. Unscoped force
 * refresh joins `computeStatus`. Unscoped auto prefers last-known
 * connection metadata and never probes. A scoped login report uses the
 * login-succeeded barrier and last-known CLI version.
 */
import type {
  TAuthEvent,
  TDaemonModelReportEntry,
  TDaemonModelsReason,
  TDaemonModelsStatus,
  TDaemonProviderConnection,
  TProviderModelEntry,
  TSubscriptionProviderSlug,
} from "@openllmsh/protocol";
import { normalizeProviderConnection } from "@openllmsh/protocol";
import { addAuthObserver } from "./auth-events";
import { reportModels } from "./cloud-client";
import type { TProviderDelegate } from "./delegation";
import { DELEGATES, getDelegate, isOAuthSlug } from "./delegation";
import type { TListModelsNullReason } from "./delegation/types";
import { logWarn, safeDiagnosticMessage } from "./logger";
import {
  MODEL_REPORT_FAILURE_RETRY_MS,
  MODEL_REPORT_TTL_MS,
} from "./model-report-policy";
import { withoutCommandReplayContext } from "./op-context";
import { markStatusDirty } from "./status-dirty";
import { computeStatus, peekLastKnownConnection } from "./status";

export {
  MODEL_REPORT_FAILURE_RETRY_MS,
  MODEL_REPORT_TTL_MS,
} from "./model-report-policy";

export type TModelReportMode = "force" | "auto";

type TAttempt = {
  readonly at: number;
  readonly ok: boolean;
  readonly cliVersion?: string;
};

type TDueModelReport = {
  readonly slug: string;
  readonly delegate: TProviderDelegate;
  readonly cliVersion: string | undefined;
};

type TListed = {
  readonly slug: string;
  readonly cliVersion: string | undefined;
  readonly outcome:
    | {
        readonly kind: "success";
        readonly models: ReadonlyArray<TProviderModelEntry>;
      }
    | { readonly kind: "skipped" }
    | {
        readonly kind: "failed";
        readonly reason?: TListModelsNullReason;
      };
  readonly postError?: string;
};

/**
 * Closed reason → privacy-safe message. `safeDiagnosticMessage` forbids
 * interpolation, so each closed token gets one frozen template; unknown
 * `http_*` collapses to `http_error`.
 */
const LIST_MODELS_NULL_MESSAGES = {
  token_unavailable: safeDiagnosticMessage`Connected provider model listing returned null (token_unavailable).`,
  version_unresolved: safeDiagnosticMessage`Connected provider model listing returned null (version_unresolved).`,
  empty_after_filter: safeDiagnosticMessage`Connected provider model listing returned null (empty_after_filter).`,
  error: safeDiagnosticMessage`Connected provider model listing returned null (error).`,
  http_401: safeDiagnosticMessage`Connected provider model listing returned null (http_401).`,
  http_403: safeDiagnosticMessage`Connected provider model listing returned null (http_403).`,
  http_404: safeDiagnosticMessage`Connected provider model listing returned null (http_404).`,
  http_429: safeDiagnosticMessage`Connected provider model listing returned null (http_429).`,
  http_500: safeDiagnosticMessage`Connected provider model listing returned null (http_500).`,
  http_502: safeDiagnosticMessage`Connected provider model listing returned null (http_502).`,
  http_503: safeDiagnosticMessage`Connected provider model listing returned null (http_503).`,
  http_error: safeDiagnosticMessage`Connected provider model listing returned null (http_error).`,
} as const;

const listModelsNullMessage = (
  reason: TListModelsNullReason,
): ReturnType<typeof safeDiagnosticMessage> => {
  if (Object.hasOwn(LIST_MODELS_NULL_MESSAGES, reason)) {
    return LIST_MODELS_NULL_MESSAGES[
      reason as keyof typeof LIST_MODELS_NULL_MESSAGES
    ];
  }
  return LIST_MODELS_NULL_MESSAGES.http_error;
};

const noteConnectedListModelsNull = (
  slug: string,
  reason: TListModelsNullReason,
): void => {
  logWarn("model-report", listModelsNullMessage(reason), undefined, {
    provider: slug as TSubscriptionProviderSlug,
    observation: "connected",
  });
};

/** The result of collecting and attempting one due model-list report. */
export type TMaybeModelReportResult = {
  /** Whether at least one live provider listing was POSTed to the cloud. */
  readonly attempted: boolean;
  /** Number of successful provider model listings included in the report. */
  readonly reported: number;
  /** Whether a provider listing or the cloud POST failed. */
  readonly failed: boolean;
  /** Safe diagnostic for failed provider listings or a cloud POST failure. */
  readonly error?: string;
};

const lastAttempt = new Map<string, TAttempt>();
const autoFlights = new Map<string, Promise<TListed>>();
const forceFlights = new Map<string, Promise<TListed>>();

type TModelsOutcome =
  | { readonly status: "ok" }
  | { readonly status: "unavailable"; readonly reason: TDaemonModelsReason };

/** Latest list/discover outcome per slug — drives `models_status` on status. */
const lastModelsOutcome = new Map<string, TModelsOutcome>();

const toWireModelsReason = (
  reason: TListModelsNullReason | undefined,
): TDaemonModelsReason => {
  if (reason === undefined) return "error";
  if (
    reason === "token_unavailable" ||
    reason === "version_unresolved" ||
    reason === "empty_after_filter" ||
    reason === "error" ||
    reason === "http_401" ||
    reason === "http_403" ||
    reason === "http_404" ||
    reason === "http_429" ||
    reason === "http_500" ||
    reason === "http_502" ||
    reason === "http_503"
  ) {
    return reason;
  }
  return "http_error";
};

const outcomeEqual = (
  a: TModelsOutcome | undefined,
  b: TModelsOutcome,
): boolean => {
  if (a === undefined) return false;
  if (a.status === "ok" && b.status === "ok") return true;
  if (a.status === "unavailable" && b.status === "unavailable") {
    return a.reason === b.reason;
  }
  return false;
};

const noteModelsOutcome = (listed: TListed): boolean => {
  if (listed.outcome.kind === "skipped") return false;
  let next: TModelsOutcome;
  if (
    listed.outcome.kind === "success" &&
    listed.outcome.models.length > 0 &&
    listed.postError === undefined
  ) {
    next = { status: "ok" };
  } else if (listed.outcome.kind === "failed") {
    next = {
      status: "unavailable",
      reason: toWireModelsReason(listed.outcome.reason),
    };
  } else {
    // success with empty models (should be rare — callers coerce to failed)
    next = {
      status: "unavailable",
      reason: "empty_after_filter",
    };
  }
  const prev = lastModelsOutcome.get(listed.slug);
  if (outcomeEqual(prev, next)) return false;
  lastModelsOutcome.set(listed.slug, next);
  return true;
};

/** Models-status fields for one provider; empty when never attempted. */
export const modelsStatusFieldsFor = (
  slug: string,
): {
  readonly models_status?: TDaemonModelsStatus;
  readonly models_reason?: TDaemonModelsReason;
} => {
  const outcome = lastModelsOutcome.get(slug);
  if (outcome === undefined) return {};
  if (outcome.status === "ok") return { models_status: "ok" };
  return {
    models_status: "unavailable",
    models_reason: outcome.reason,
  };
};

/** Overlay latest model-list outcomes onto a status connections array. */
export const attachModelsStatusToConnections = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
): TDaemonProviderConnection[] =>
  connections.map((conn) => {
    const fields = modelsStatusFieldsFor(conn.provider);
    if (fields.models_status === undefined) return conn;
    return { ...conn, ...fields };
  });

/** Reset the throttle — all slugs, or one (post-connect / tests). */
export const resetModelReportThrottle = (slug?: string): void => {
  if (slug === undefined) {
    lastAttempt.clear();
    autoFlights.clear();
    forceFlights.clear();
    lastModelsOutcome.clear();
    return;
  }
  lastAttempt.delete(slug);
  autoFlights.delete(slug);
  forceFlights.delete(slug);
  lastModelsOutcome.delete(slug);
};

const isDue = (
  slug: string,
  now: number,
  cliVersion: string | undefined,
): boolean => {
  const prev = lastAttempt.get(slug);
  if (prev === undefined) return true;
  if (cliVersion !== undefined && cliVersion !== prev.cliVersion) return true;
  return (
    now - prev.at >=
    (prev.ok ? MODEL_REPORT_TTL_MS : MODEL_REPORT_FAILURE_RETRY_MS)
  );
};

const dueFromConnections = (
  now: number,
  connections: ReadonlyArray<TDaemonProviderConnection>,
  slugFilter: string | undefined,
): ReadonlyArray<TDueModelReport> => {
  const byProvider = new Map(
    connections.map((conn) => [conn.provider, conn] as const),
  );
  const due: TDueModelReport[] = [];
  for (const [slug, delegate] of Object.entries(DELEGATES)) {
    if (delegate.listModels === undefined) continue;
    if (slugFilter !== undefined && slug !== slugFilter) continue;
    const conn = byProvider.get(slug);
    if (conn === undefined || !normalizeProviderConnection(conn).serviceable) {
      continue;
    }
    const cliVersion = conn.cli_version;
    if (!isDue(slug, now, cliVersion)) continue;
    due.push({ slug, delegate, cliVersion });
  }
  return due;
};

const dueForSucceededLogin = (
  now: number,
  slug: string,
): ReadonlyArray<TDueModelReport> => {
  const delegate = getDelegate(slug);
  if (delegate === null || delegate.listModels === undefined) return [];
  const cliVersion = peekLastKnownConnection(slug)?.cli_version;
  if (!isDue(slug, now, cliVersion)) return [];
  return [{ slug, delegate, cliVersion }];
};

const dueFromLastKnown = (
  now: number,
  slugFilter: string | undefined,
): ReadonlyArray<TDueModelReport> => {
  const due: TDueModelReport[] = [];
  for (const [slug, delegate] of Object.entries(DELEGATES)) {
    if (delegate.discoverModels === undefined) continue;
    if (slugFilter !== undefined && slug !== slugFilter) continue;
    const conn = peekLastKnownConnection(slug);
    if (conn === undefined || !normalizeProviderConnection(conn).serviceable) {
      continue;
    }
    const cliVersion = conn.cli_version;
    if (!isDue(slug, now, cliVersion)) continue;
    due.push({ slug, delegate, cliVersion });
  }
  return due;
};

/** Walker-scoped auto: the hop just succeeded; do not require last-known. */
const dueForUsedProvider = (
  now: number,
  slug: string,
): ReadonlyArray<TDueModelReport> => {
  const delegate = getDelegate(slug);
  if (delegate === null || delegate.discoverModels === undefined) return [];
  const cliVersion = peekLastKnownConnection(slug)?.cli_version;
  if (!isDue(slug, now, cliVersion)) return [];
  return [{ slug, delegate, cliVersion }];
};

const runForceList = (due: TDueModelReport): Promise<TListed> => {
  const existing = forceFlights.get(due.slug);
  if (existing !== undefined) return existing;
  const flight = (async (): Promise<TListed> => {
    try {
      let nullReason: TListModelsNullReason | undefined;
      const models = await (due.delegate.listModels?.({
        onNullReason: (reason) => {
          nullReason = reason;
        },
      }) ?? Promise.resolve(null));
      if (models === null) {
        const reason = nullReason ?? "error";
        noteConnectedListModelsNull(due.slug, reason);
        return {
          slug: due.slug,
          cliVersion: due.cliVersion,
          outcome: { kind: "failed", reason },
        };
      }
      return {
        slug: due.slug,
        cliVersion: due.cliVersion,
        outcome: { kind: "success", models },
      };
    } catch {
      noteConnectedListModelsNull(due.slug, "error");
      return {
        slug: due.slug,
        cliVersion: due.cliVersion,
        outcome: { kind: "failed", reason: "error" },
      };
    }
  })();
  const tracked = flight.finally(() => {
    if (forceFlights.get(due.slug) === tracked) forceFlights.delete(due.slug);
  });
  forceFlights.set(due.slug, tracked);
  return tracked;
};

const stampAttempt = (listed: TListed, now: number): void => {
  if (listed.outcome.kind === "skipped") return;
  lastAttempt.set(listed.slug, {
    at: now,
    ok: listed.outcome.kind === "success" && listed.postError === undefined,
    ...(listed.cliVersion ? { cliVersion: listed.cliVersion } : {}),
  });
  if (noteModelsOutcome(listed)) {
    // Deduped dirty bit — watcher publishes once; no per-provider storm.
    markStatusDirty("models");
  }
};

const runAutoDiscoverAndReport = (
  due: TDueModelReport,
  now: number,
): Promise<TListed> => {
  const existing = autoFlights.get(due.slug);
  if (existing !== undefined) return existing;
  const flight = (async (): Promise<TListed> => {
    const discover = due.delegate.discoverModels;
    let listed: TListed;
    if (discover === undefined) {
      listed = {
        slug: due.slug,
        cliVersion: due.cliVersion,
        outcome: { kind: "skipped" },
      };
    } else {
      try {
        const result = await discover(
          due.cliVersion === undefined ? {} : { cliVersion: due.cliVersion },
        );
        if (result.kind === "success" && result.models.length === 0) {
          listed = {
            slug: due.slug,
            cliVersion: due.cliVersion,
            outcome: { kind: "failed" },
          };
        } else {
          listed = {
            slug: due.slug,
            cliVersion: due.cliVersion,
            outcome: result,
          };
        }
      } catch {
        listed = {
          slug: due.slug,
          cliVersion: due.cliVersion,
          outcome: { kind: "failed" },
        };
      }
    }
    if (listed.outcome.kind === "success" && listed.outcome.models.length > 0) {
      const posted = await reportModels({
        entries: [
          {
            provider: listed.slug,
            models: listed.outcome.models,
            ...(listed.cliVersion ? { cli_version: listed.cliVersion } : {}),
          },
        ],
      });
      if (!posted.ok) {
        listed = { ...listed, postError: posted.error };
      }
    }
    stampAttempt(listed, now);
    return listed;
  })();
  const tracked = flight.finally(() => {
    if (autoFlights.get(due.slug) === tracked) autoFlights.delete(due.slug);
  });
  autoFlights.set(due.slug, tracked);
  return tracked;
};

const withInFlightAuto = (
  due: ReadonlyArray<TDueModelReport>,
  slugFilter: string | undefined,
): ReadonlyArray<TDueModelReport> => {
  const have = new Set(due.map((item) => item.slug));
  const extra: TDueModelReport[] = [];
  for (const slug of autoFlights.keys()) {
    if (slugFilter !== undefined && slug !== slugFilter) continue;
    if (have.has(slug)) continue;
    const delegate = getDelegate(slug);
    if (delegate === null) continue;
    extra.push({
      slug,
      delegate,
      cliVersion: peekLastKnownConnection(slug)?.cli_version,
    });
  }
  return extra.length === 0 ? due : [...due, ...extra];
};

/**
 * Collect + report due model lists without throwing. The returned outcome lets
 * explicit callers surface a cloud-report failure. Idle / skipped reports are
 * `attempted: false` without `failed` — they must not look like a failed
 * request. Pass `slug` after `auth.login.succeeded` so the other four
 * delegates are not probed or listed. `mode: "auto"` never calls
 * `listModels` and never joins a force listing.
 */
export const maybeReportModels = (
  now: number = Date.now(),
  slug?: string,
  mode: TModelReportMode = "force",
): Promise<TMaybeModelReportResult> =>
  withoutCommandReplayContext(async () => {
    if (mode === "auto") {
      const due =
        slug === undefined
          ? dueFromLastKnown(now, undefined)
          : dueForUsedProvider(now, slug);
      const joined = withInFlightAuto(due, slug);
      const results = await Promise.all(
        joined.map((item) => runAutoDiscoverAndReport(item, now)),
      );
      return aggregateListed(results, { alreadyPosted: true });
    }

    const due =
      slug === undefined
        ? dueFromConnections(
            now,
            (await computeStatus()).connections,
            undefined,
          )
        : dueForSucceededLogin(now, slug);

    const results = await Promise.all(due.map((item) => runForceList(item)));
    for (const listed of results) stampAttempt(listed, now);
    return aggregateListed(results, { alreadyPosted: false });
  });

const aggregateListed = async (
  results: ReadonlyArray<TListed>,
  opts: { readonly alreadyPosted: boolean },
): Promise<TMaybeModelReportResult> => {
  const entries: TDaemonModelReportEntry[] = [];
  const failedProviders: string[] = [];
  for (const listed of results) {
    if (listed.outcome.kind === "failed" || listed.postError !== undefined) {
      failedProviders.push(listed.slug);
      continue;
    }
    if (listed.outcome.kind !== "success") continue;
    if (listed.outcome.models.length > 0) {
      entries.push({
        provider: listed.slug,
        models: listed.outcome.models,
        ...(listed.cliVersion ? { cli_version: listed.cliVersion } : {}),
      });
    }
  }
  const listingError =
    failedProviders.length > 0
      ? `model listing failed for ${failedProviders.join(", ")}`
      : undefined;
  if (opts.alreadyPosted) {
    const posted = entries.length;
    return {
      attempted: posted > 0,
      reported: posted,
      failed: failedProviders.length > 0,
      ...(listingError === undefined ? {} : { error: listingError }),
    };
  }
  if (entries.length === 0) {
    return {
      attempted: false,
      reported: 0,
      failed: failedProviders.length > 0,
      ...(listingError === undefined ? {} : { error: listingError }),
    };
  }

  const result = await reportModels({ entries });
  if (result.ok) {
    return {
      attempted: true,
      reported: entries.length,
      failed: failedProviders.length > 0,
      ...(listingError === undefined ? {} : { error: listingError }),
    };
  }

  return {
    attempted: true,
    reported: 0,
    failed: true,
    error:
      listingError === undefined
        ? result.error
        : `${listingError}; ${result.error}`,
  };
};

let loginObserverInstalled = false;

const onAuthEvent = (event: TAuthEvent): void => {
  if (event.event !== "auth.login.succeeded") return;
  resetModelReportThrottle(event.slug);
  void maybeReportModels(Date.now(), event.slug, "force").catch(() => {});
};

/**
 * Subscribe once to `auth.login.succeeded` so pending device-code / paste-back
 * logins report models when the credential actually lands — not when the
 * connect command acked `pending`, and not on failed/cancelled terminals.
 * Idempotent. Tests that must not fan out to real vendors should not call this.
 */
export const observeLoginModelReports = (): void => {
  if (loginObserverInstalled) return;
  loginObserverInstalled = true;
  addAuthObserver(onAuthEvent);
};

type TConnectedBaseline = {
  readonly connected: boolean;
};

/**
 * Observe status snapshots and demand-report models on any oauth transition
 * into `connected` — including credentials that appear out-of-band (native
 * CLI login). Uses `mode: "auto"` (discoverModels only — observe-only store
 * reads, never `listModels` / native refresh) so a passive status edge cannot
 * open a keychain-prompting path. Explicit `auth.login.succeeded` and
 * `refresh_models` still force-list. Deduped by the per-slug throttle /
 * single-flight; does NOT reset the throttle (login.succeeded still does).
 */
export type TConnectedModelReportTracker = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
) => void;

export const createConnectedModelReportTracker =
  (): TConnectedModelReportTracker => {
    const last = new Map<string, TConnectedBaseline>();
    let seeded = false;
    return (connections) => {
      // First status snapshot after daemon start: seed the baseline WITHOUT
      // firing. Every already-connected provider would otherwise look like a
      // rising edge and discoverModels would keychain-read on every boot.
      if (!seeded) {
        for (const conn of connections) {
          if (!isOAuthSlug(conn.provider)) continue;
          last.set(conn.provider, {
            connected:
              normalizeProviderConnection(conn).observation === "connected",
          });
        }
        seeded = true;
        return;
      }
      const now = Date.now();
      for (const conn of connections) {
        if (!isOAuthSlug(conn.provider)) continue;
        const connected =
          normalizeProviderConnection(conn).observation === "connected";
        const was = last.get(conn.provider)?.connected === true;
        last.set(conn.provider, { connected });
        if (!connected || was) continue;
        // Skip providers with a fresh last attempt — throttle already gates
        // inside maybeReportModels, but avoid even scheduling a no-op flight.
        if (!isDue(conn.provider, now, conn.cli_version)) continue;
        void maybeReportModels(now, conn.provider, "auto").catch(() => {});
      }
    };
  };

/** Process-wide tracker — one baseline Map for the daemon lifetime. */
export const noteConnectionsForModelReport: TConnectedModelReportTracker =
  createConnectedModelReportTracker();
