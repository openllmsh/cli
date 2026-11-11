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
  TDaemonCloudState,
  TDaemonReportingPolicy,
  TExecutionSelection,
  TModelCapsDefaultRule,
  TModelSettingsOverrides,
} from "@openllmsh/sdk/protocol";
import { resolveContextOverflowStrategy } from "@openllmsh/sdk/wire";
import {
  fetchBootstrap,
  InvalidApiKeyError,
  NoApiKeyError,
  publishIdentity,
} from "./cloud-client";
import type { TPublishIdentityResult } from "./cloud-client";
import {
  invalidateDeviceAccessPin,
  setDeviceAccessPubkey,
} from "./device-access-verify";
import { daemonApiKeyId, hasApiKey } from "./env";
import { loadIdentityKey } from "./keypair";
import { withoutCommandReplayContext } from "./op-context";
import { clearPlanCache, observePolicyRevision } from "./plan-cache";

/**
 * Outcome of ensuring the durable identity is published before (or during)
 * online presence. `"conflict"` is the only value that must stop the daemon;
 * `"failed"` from the underlying publish is folded into `"ok"` here so a
 * transient network blip never blocks the control channel.
 */
export type TEnsureIdentityPublishedResult = "ok" | "conflict" | "skipped";

/**
 * Await a publish of the persisted X25519 identity when one exists on disk.
 * Callers must run this before starting the control channel so the online-lock
 * model can refuse a different identity while another device still holds the
 * key — painting the key online first would wedge a replacement forever.
 */
export const ensureIdentityPublished =
  async (): Promise<TEnsureIdentityPublishedResult> => {
    try {
      const identity = loadIdentityKey();
      if (!identity.persisted) return "skipped";
      const result: TPublishIdentityResult = await publishIdentity(
        identity.publicKeyB64,
      );
      if (result === "conflict") return "conflict";
      // `ok` and `failed` both proceed — only an explicit conflict stops us.
      return "ok";
    } catch {
      // loadIdentityKey sync failures must not block boot / bootstrap.
      return "skipped";
    }
  };

/** Empty bootstrap row for offline/seeded hosts and harnesses. */
export const EMPTY_DAEMON_BOOTSTRAP: TDaemonBootstrap = {
  catalog: [],
  provider_prefixes: [],
  user_fallback_groups: [],
  user_model_fallback_bindings: [],
  key_policy_rev: null,
};

const EMPTY = EMPTY_DAEMON_BOOTSTRAP;

/**
 * Outcome of the last bootstrap attempt — surfaced on `GET /status` so
 * the dashboard knows whether to show the API-key picker (`no_key` /
 * `invalid_key`), a retry hint (`unreachable`), a still-booting hint
 * (`connecting`), or the provider cards (`ok`).
 */
export type TCloudState = TDaemonCloudState;

/**
 * Initial `/status` cloud state before the first bootstrap attempt finishes.
 * A configured key must not read as `no_key` while the listener is already up
 * and bootstrap is still in flight (`openllm status` right after `start`).
 */
export const initialCloudState = (keyConfigured: boolean): TCloudState =>
  keyConfigured ? "connecting" : "no_key";

let snapshot: TDaemonBootstrap = EMPTY;
let byModelId: Map<string, TDaemonCatalogEntry> = new Map();
let cloudState: TCloudState = initialCloudState(hasApiKey());
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
      observePolicyRevision(next.key_policy_rev);
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
        await setDeviceAccessPubkey(snapshot.device_access_pubkey, {
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
      // Await the durable X25519 pin on every successful bootstrap so cold
      // dashboards / fleet peers pin via the cloud path, and so a mid-run
      // `identity_conflict` can shut the daemon down (see main.ts). Isolated
      // from cloudState — a local keypair failure or network blip must not flip
      // a successful bootstrap to "unreachable". R5: publish ONLY a key that
      // reached disk (`ensureIdentityPublished` skips otherwise).
      await ensureIdentityPublished();
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

/**
 * Authenticated account id from bootstrap. Null when an older cloud omitted
 * it — peer_user_id cross-user detection then falls back to the trusted-relay
 * assumption for grant-less opens.
 */
export const daemonUserId = (): string | null => snapshot.user_id ?? null;

/**
 * Per-contributor HMAC key for team grants from bootstrap. Null when the
 * cloud has no `NEON_AUTH_COOKIE_SECRET` — team traffic is then refused.
 */
export const teamGrantKey = (): string | null =>
  snapshot.team_grant_key ?? null;

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
 * `@openllmsh/sdk/protocol`'s `execution-selection.ts`. The daemon NEVER reads an
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
  // Skip THIS device, not the whole list: when this device is listed first,
  // a peer listed after it is still a valid server.
  const self = daemonApiKeyId();
  return (
    snapshot.fleet_subscriptions?.find(
      (f) => f.provider === provider && f.key_id !== self,
    )?.key_id ?? null
  );
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
