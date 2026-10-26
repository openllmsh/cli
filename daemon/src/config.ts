/**
 * Runtime config + catalog cache.
 *
 * The daemon does NOT compile the model catalog or routing config in — it
 * pulls a single bootstrap snapshot from the cloud
 * (`GET /api/daemon/bootstrap`) and refreshes on a TTL. This keeps the
 * binary's dependency closure to core + schema + effect (no
 * `@openllm/api`, no db) and lets config update without recompiling.
 *
 * The walker makes ZERO routing decisions (the cloud resolved the chain
 * and handed it over as a signed plan), so the daemon only needs from the snapshot:
 * model id → `provider_model_id` (catalog), per-model `output_token_limit`
 * (raise-only max-tokens backfill on alias hops), the per-user
 * plan-signing key, and the cloud-state for `/status`. Fallback/binding
 * fields ride along in the wire shape but are unused on the box.
 */

import type {
  TContextOverflowStrategy,
  TDaemonBootstrap,
  TDaemonCatalogEntry,
  TDaemonReportingPolicy,
  TExecutionSelection,
  TModelCapsDefaultRule,
  TModelSettingsOverrides,
} from "@openllmsh/protocol";
import { resolveContextOverflowStrategy } from "@openllmsh/wire";
import {
  fetchBootstrap,
  InvalidApiKeyError,
  NoApiKeyError,
  publishIdentity,
} from "./cloud-client";
import {
  invalidateDeviceAccessPin,
  setDeviceAccessPubkey,
} from "./device-access-verify";
import { daemonApiKeyId } from "./env";
import { loadIdentityKey } from "./keypair";
import { withoutCommandReplayContext } from "./op-context";
import { clearPlanCache } from "./plan-cache";

/** Empty bootstrap row for offline/seeded hosts and harnesses. */
export const EMPTY_DAEMON_BOOTSTRAP: TDaemonBootstrap = {
  catalog: [],
  provider_prefixes: [],
  user_fallback_groups: [],
  user_model_fallback_bindings: [],
};

const EMPTY = EMPTY_DAEMON_BOOTSTRAP;

/**
 * Outcome of the last bootstrap attempt — surfaced on `GET /status` so
 * the dashboard knows whether to show the API-key picker (`no_key` /
 * `invalid_key`), a retry hint (`unreachable`), or the provider cards
 * (`ok`).
 */
export type TCloudState = "ok" | "no_key" | "invalid_key" | "unreachable";

let snapshot: TDaemonBootstrap = EMPTY;
let byModelId: Map<string, TDaemonCatalogEntry> = new Map();
let cloudState: TCloudState = "no_key";
let reportingPolicyRevision = 0;

/** Started refresh revision, used to fence delayed diagnostics callbacks. */
export const getReportingPolicyRevision = (): number => reportingPolicyRevision;

export const getCloudState = (): TCloudState => cloudState;

/** Last bootstrap reporting policy. Absent/old clouds → null (upload off). */
export const getReportingPolicy = (): TDaemonReportingPolicy | null =>
  currentBootstrapSnapshot().reporting_policy ?? null;

/**
 * Install a full bootstrap snapshot into the in-memory cache (catalog index
 * rebuilt). Offline/seeded hosts call this directly. Bumps the reporting
 * policy revision so delayed diagnostics callbacks can fence — unless
 * {@link refreshBootstrap} already claimed the revision for this fetch.
 */
export const applyBootstrapSnapshot = (
  next: TDaemonBootstrap,
  options?: { readonly preserveReportingRevision?: boolean },
): void => {
  if (options?.preserveReportingRevision !== true) {
    reportingPolicyRevision += 1;
  }
  // The bootstrap body is trusted JSON, not decoded: a degraded or older cloud
  // can omit a collection. Default the required ones so a partial snapshot
  // never leaves `catalog` undefined for every later lookup to crash on.
  snapshot = {
    ...next,
    catalog: next.catalog ?? [],
    provider_prefixes: next.provider_prefixes ?? [],
    user_fallback_groups: next.user_fallback_groups ?? [],
    user_model_fallback_bindings: next.user_model_fallback_bindings ?? [],
  };
  byModelId = new Map(snapshot.catalog.map((e) => [e.model_id, e]));
};

/** Read-only view of the in-memory bootstrap snapshot. */
export const currentBootstrapSnapshot = (): Readonly<TDaemonBootstrap> =>
  snapshot;

/**
 * Refresh the cloud snapshot, recording the outcome in `cloudState`.
 * Never throws — classifies the failure instead so the control surface
 * and dashboard can react (the daemon stays up and serving on a stale /
 * empty snapshot regardless).
 *
 * Returns `true` when `cloudState` CHANGED, so the caller can re-push the
 * daemon's status: a transient boot-time `unreachable` that recovers to `ok`
 * on the next retry must surface immediately, not wait for the next command
 * (otherwise the dashboard shows "can't reach the cloud" indefinitely even
 * though everything is working — the bug this fixes).
 */
export const refreshBootstrap = (): Promise<boolean> =>
  withoutCommandReplayContext(async () => {
    const prev = cloudState;
    const reportingRevision = ++reportingPolicyRevision;
    try {
      const next = await fetchBootstrap();
      if (reportingRevision !== reportingPolicyRevision) return false;
      applyBootstrapSnapshot(next, { preserveReportingRevision: true });
      cloudState = "ok";
      void import("./doctor-report")
        .then((m) => m.onBootstrapReportingPolicy(reportingRevision))
        .catch(() => {});
      // A fresh snapshot may carry new routing config — drop any cached signed
      // plans so a stale chain never outlives the config that produced it.
      clearPlanCache();
      // Pin the seed-gated device-access verifier when the cloud includes it.
      // A cloud-sent null never clears an existing pin (only a local
      // confirmation can). Absent (older cloud) leaves the last-known pin
      // alone so a rolling deploy cannot silently drop enforcement.
      // `kind` / `version` / `rotations` carry the device-control semantics
      // (first-use label, signed rotation chain) — see
      // `device-access-verify.ts`. The cloud can never ANCHOR a pin: only the
      // install anchor / loopback do. Re-read the pin
      // from disk first, so an anchor written by `openllm daemon anchor` /
      // `openllm login` (another process) is seen within one tick. The daemon
      // never receives DEK material.
      invalidateDeviceAccessPin();
      if (snapshot.device_access_pubkey !== undefined) {
        setDeviceAccessPubkey(snapshot.device_access_pubkey, {
          ...(snapshot.device_access_kind === undefined
            ? {}
            : { kind: snapshot.device_access_kind }),
          ...(snapshot.device_access_version === undefined
            ? {}
            : { version: snapshot.device_access_version }),
          ...(snapshot.device_access_rotations === undefined
            ? {}
            : { rotations: snapshot.device_access_rotations }),
        });
      }
      // Best-effort: publish the durable X25519 pin on every successful
      // bootstrap so cold dashboards / fleet peers pin via the cloud path
      // (not solely relay status_push). Isolated from cloudState — a local
      // keypair/construction failure must not flip a successful bootstrap
      // to "unreachable".
      try {
        // R5: publish ONLY a key that reached disk. The cloud pin is write-once,
        // so pinning an in-memory key that a failed write never persisted means
        // the next boot generates a different key and 409s forever — a transient
        // full disk becomes a permanent wedge. Skipping leaves no pin, and the
        // next boot pins cleanly. `keypair.ts` already logged the errno.
        // Fire-and-forget: a slow POST must not hold bootstrap. Sync throws from
        // loadIdentityKey still land in this catch (must not flip cloudState).
        const identity = loadIdentityKey();
        if (identity.persisted) {
          void publishIdentity(identity.publicKeyB64).catch(() => {});
        }
      } catch {
        // swallow — identity pin is non-critical hardening
      }
    } catch (err) {
      if (reportingRevision !== reportingPolicyRevision) return false;
      if (err instanceof NoApiKeyError) cloudState = "no_key";
      else if (err instanceof InvalidApiKeyError) cloudState = "invalid_key";
      else cloudState = "unreachable";
    }
    return cloudState !== prev;
  });

/**
 * The per-user key for verifying the cloud's plan signature (handed
 * over at bootstrap). Null when the cloud has no signing secret configured
 * — the walker then accepts unsigned plans (dev). See `walker.ts`.
 */
export const planSigningKey = (): string | null =>
  snapshot.plan_signing_key ?? null;

/** Sparse per-model user overrides from the authenticated bootstrap snapshot. */
export const modelSettingsOverrides = (): TModelSettingsOverrides =>
  snapshot.model_settings ?? {};

/** Per-user context-overflow policy from bootstrap; absence preserves hopping. */
export const contextOverflowStrategy = (): TContextOverflowStrategy =>
  resolveContextOverflowStrategy(snapshot.context_overflow_strategy);

/**
 * The cloud's resolved `ACTIVE_SUB_METHOD` global preference — a named
 * execution variant (`stream-json` / `sdk-facade` / `acp` / `app-server` /
 * `msp` / `agent-sdk`, optionally capture) or `handrolled`; see
 * `@openllmsh/protocol`'s `execution-selection.ts`. The daemon NEVER reads an
 * `ACTIVE_SUB_METHOD` env of its own — this snapshot field is the only
 * source; null = no preference (each hop uses its registry default).
 * `walker.ts` samples it (with the overrides below) once per request so a
 * mid-walk bootstrap refresh never switches a hop.
 */
export const activeExecutionSelection = (): TExecutionSelection | null =>
  snapshot.execution_selection ?? null;

/** Per-provider overrides layered on top of {@link activeExecutionSelection},
 *  same sampling/staleness contract. */
export const activeExecutionSelectionOverrides = (): Readonly<
  Record<string, TExecutionSelection>
> => snapshot.execution_selections ?? {};

/**
 * Cloud-controlled opt-in for the daemon's signed-plan cache (default off —
 * absent on older clouds keeps the rider inert). See `plan-cache.ts`.
 */
export const planCacheEnabled = (): boolean => snapshot.plan_cache === true;

/**
 * The fleet-peer key id serving `provider` (subscription tunnel — feature
 * §1), from the last bootstrap. Null when no online fleet daemon serves it
 * (or the cloud predates the field), or when a stale cloud snapshot names this
 * daemon's own key — local serving is handled separately and must not tunnel
 * back to itself.
 */
export const fleetSubscriptionServerFor = (provider: string): string | null => {
  const keyId =
    snapshot.fleet_subscriptions?.find((f) => f.provider === provider)
      ?.key_id ?? null;
  return keyId === daemonApiKeyId() ? null : keyId;
};

/** Serving daemon X25519 pubkey for a fleet peer, when its bootstrap status supplied one. */
export const fleetSubscriptionPubkeyFor = (keyId: string): string | null =>
  snapshot.fleet_subscriptions?.find((f) => f.key_id === keyId)?.pubkey ?? null;

/**
 * The daemon version the cloud currently publishes (bare semver), from the last
 * bootstrap. Null when unpublished or the cloud is too old to advertise it. The
 * self-updater compares it to `DAEMON_VERSION`. See `self-update.ts`.
 */
export const latestVersion = (): string | null =>
  snapshot.latest_version ?? null;

/**
 * The release the cloud currently pins for the single `openllm` binary (bare
 * semver), from the last bootstrap. Null when unpublished or the cloud is too
 * old to advertise it. The updater converges the binary to it. See
 * `updater.ts`.
 */
export const latestCliVersion = (): string | null =>
  snapshot.latest_cli_version ?? null;

/**
 * Look up a model id in the cached catalog → its `{ provider,
 * provider_model_id }` row. The walker uses this to resolve each plan
 * hop to its concrete upstream model id (falling back to splitting the
 * `provider/model` pair when uncached).
 */
export const lookupCatalogEntry = (
  modelId: string,
): TDaemonCatalogEntry | null => byModelId.get(modelId) ?? null;

/**
 * Catalog-owned caps DEFAULTS from the last bootstrap, for models with
 * no catalog row. Empty when the cloud is too old to advertise them —
 * the walker then resolves no defaults, which is today's behaviour.
 */
export const catalogCapsDefaults = (): ReadonlyArray<TModelCapsDefaultRule> =>
  currentBootstrapSnapshot().caps_defaults ?? [];
