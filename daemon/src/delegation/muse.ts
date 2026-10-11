/**
 * Muse Code subscription delegate through the official `muse` CLI.
 *
 * Login/logout are official CLI only (`muse login` / `muse logout`). Inference
 * is bridge-only via the native Muse runtime — this delegate never exports
 * credential secrets and never serves Meta Model API HTTP with subscription
 * material. META_API_KEY outranks stored credentials in the official runtime,
 * so child env strips ambient API-key overrides.
 *
 * Local configured login is the durable FILE-backed store under the isolated
 * XDG config home: `providers.meta.mechanism === "oauth"` with a non-empty
 * inline `access_token`. That is a local store observation only — not
 * subscription/quota proof. `storage: "keychain"` pointers are rejected (macOS
 * Keychain is not HOME-isolated). Passive status uses `readJsonStore` + shape
 * narrowing + the shared observation cache — no MSP model/list proof, no
 * in-memory-only session flag. Quota/plan are never claimed without an
 * official source.
 */
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderModelEntry,
  TProviderUsageSnapshot,
} from "@openllmsh/protocol";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir } from "../cli-paths";
import { logError, logInfo, safeDiagnosticMessage } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { resolveUpstreamUrl } from "./auth-config";
import { cliLaunch, loginWiring } from "./delegate-shared";
import { makeStreamConnect } from "./login-direct";
import { makeCancelConnect } from "./login-flow";
import {
  classifyMuseLoginBackgroundExit,
  mapMuseLoginCrashDetail,
} from "./muse-login-diagnostics";
import {
  createPassiveObservationCache,
  fileStoreIdentity,
  fingerprintStoreIdentity,
  waitFileStoreHint,
} from "./observation-cache";
import type {
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import type { TStoreRead } from "./util";
import {
  connectedObservation,
  disconnectedObservation,
  readJsonStore,
  runCapture,
  STATUS_CHECK_FAILED_DETAIL,
  stripAnsi,
  unknownObservation,
} from "./util";

const PROVIDER = "muse" as const;

/** Official auth store under the isolated XDG config home. */
export const museAuthJsonPath = (): string =>
  join(cliConfigDir(PROVIDER), "auth.json");

/**
 * Ambient metered-key overrides that outrank a stored Muse browser session.
 * Values are set to `undefined` so {@link mergeSpawnEnv} deletes them from the
 * child environment.
 */
const METERED_KEY_OVERRIDES: Readonly<Record<string, undefined>> = {
  META_API_KEY: undefined,
  MUSE_API_KEY: undefined,
  META_ACCESS_TOKEN: undefined,
  MUSE_ACCESS_TOKEN: undefined,
};

const { bin, env: baseEnv } = cliLaunch(PROVIDER);

const env = (): Record<string, string | undefined> => ({
  ...baseEnv(),
  ...METERED_KEY_OVERRIDES,
});

const ALLOWED_AUTH_HOSTS = ["meta.ai", "facebook.com", "meta.com"] as const;

const hostAllowed = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return ALLOWED_AUTH_HOSTS.some(
    (root) => host === root || host.endsWith(`.${root}`),
  );
};

/**
 * Parse a Muse authorize URL from official-login stdout.
 *
 * ASSUMPTION (not live-captured here): Muse prints an HTTPS Meta/Facebook
 * auth or device-verification URL. Host allowlist is intentionally narrow —
 * stderr is not trusted as an alternate link source. Trailing punctuation is
 * stripped; userinfo is rejected.
 */
export const parseMuseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  const match = clean.match(/https:\/\/[^\s<>"'\\]+/i);
  if (match === null || match[0] === undefined) return null;
  const candidate = match[0].replace(/[),.;:!?]+$/u, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    if (url.username.length > 0 || url.password.length > 0) return null;
    if (!hostAllowed(url.hostname)) return null;
    // Drop fragment — never surface token-like fragments to pending_auth.
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Parse optional user code alongside the authorize URL.
 *
 * ASSUMPTION: tertiary guides describe device-code-like "URL + code" output
 * from `muse login`. Official Meta auth docs emphasize browser sign-in /
 * `muse auth set` / `META_API_KEY` and do not document a `--device-auth` flag.
 * When no code is present, pending_auth carries `code: ""` (Cursor parity).
 */
export const parseMuseLoginPrompt = (
  raw: string,
): { readonly url: string; readonly code: string } | null => {
  const url = parseMuseAuthUrl(raw);
  if (url === null) return null;
  const clean = stripAnsi(raw);
  const code =
    clean.match(
      /(?:one[- ]?time code|user code|enter(?:\s+the)?\s+code)[^\n]*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i,
    )?.[1] ??
    clean.match(/\bcode\b[^\n]*?\b([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b/i)?.[1] ??
    "";
  return { url, code };
};

/** Official file-backed Muse auth.json (synthetic fixtures match this shape). */
export type TMuseAuthFile = {
  readonly schema_version?: number;
  readonly providers?: {
    readonly meta?: {
      readonly mechanism?: string;
      readonly storage?: string;
      readonly access_token?: string;
      readonly obtained_via?: string;
      readonly user_email?: string;
      readonly user_full_name?: string;
      readonly api_base_url?: string;
    };
  };
};

type TMuseStoreObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "keychain_pointer" }
  | { readonly kind: "file_backed" };

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Presence-only parse of the durable auth store. Never returns token material.
 * `file_backed` = oauth + inline access_token (local configured login only).
 * `keychain_pointer` = oauth + storage:keychain (rejected for daemon isolation).
 * Malformed shapes (null/array providers or meta) → `indeterminate`.
 * Valid empty / missing meta → `absent`.
 */
export const observeMuseAuthStore = async (): Promise<
  TStoreRead<TMuseStoreObservation>
> => {
  const store = await readJsonStore<unknown>(museAuthJsonPath());
  if (store.kind === "absent") {
    return { kind: "present", value: { kind: "absent" } };
  }
  if (store.kind === "indeterminate") return store;
  if (!isJsonRecord(store.value)) {
    return { kind: "indeterminate", cause: "malformed_auth_root" };
  }
  if (!("providers" in store.value) || store.value.providers === undefined) {
    return { kind: "present", value: { kind: "absent" } };
  }
  const providers = store.value.providers;
  if (
    providers === null ||
    Array.isArray(providers) ||
    !isJsonRecord(providers)
  ) {
    return { kind: "indeterminate", cause: "malformed_providers" };
  }
  if (!("meta" in providers) || providers.meta === undefined) {
    return { kind: "present", value: { kind: "absent" } };
  }
  const meta = providers.meta;
  if (meta === null || Array.isArray(meta) || !isJsonRecord(meta)) {
    return { kind: "indeterminate", cause: "malformed_meta" };
  }
  if (meta.mechanism !== "oauth") {
    return { kind: "present", value: { kind: "absent" } };
  }
  if (meta.storage === "keychain") {
    return { kind: "present", value: { kind: "keychain_pointer" } };
  }
  if (typeof meta.access_token === "string" && meta.access_token.length > 0) {
    return { kind: "present", value: { kind: "file_backed" } };
  }
  return { kind: "present", value: { kind: "absent" } };
};

const museStatusCache = createPassiveObservationCache<TMuseStoreObservation>();

/**
 * Internal connected check for loginWiring. Returns a non-null sentinel when
 * the durable file carries an inline oauth token — the token string is never
 * exported from the delegate / credentialForUpstream.
 */
const readFileBackedAuthPresence = async (): Promise<true | null> => {
  const observed = await observeMuseAuthStore();
  if (observed.kind !== "present") return null;
  return observed.value.kind === "file_backed" ? true : null;
};

const storeFingerprint = (): string | null => {
  const identity = fileStoreIdentity(museAuthJsonPath());
  if (!identity.statOk) return null;
  return fingerprintStoreIdentity(identity);
};

/**
 * Compatibility hook for the native runtime after a successful MSP model/list
 * or session. Local configured-login status no longer depends on this memory
 * flag — it only refreshes the passive observation cache under the live store
 * fingerprint.
 */
export const noteMuseAuthenticatedSession = (opts: {
  readonly fingerprint: string;
}): void => {
  const fp = storeFingerprint();
  if (fp === null || fp !== opts.fingerprint) return;
  museStatusCache.invalidate();
};

/** Drop cached Muse status presence after login/logout mutations. */
export const clearMuseStatusObservationCache = (): void => {
  museStatusCache.invalidate();
  clearMuseNativeModels();
  noteAuthStoreIdentityChange(PROVIDER);
};

const readCachedStoreObservation = async (): Promise<
  TStoreRead<TMuseStoreObservation>
> => {
  const identity = fileStoreIdentity(museAuthJsonPath());
  if (!identity.statOk) {
    return { kind: "indeterminate", cause: "stat_failed" };
  }
  const fingerprint = fingerprintStoreIdentity(identity);
  const generation = museStatusCache.generation();
  const cached = museStatusCache.get(fingerprint);
  if (cached !== undefined) {
    return { kind: "present", value: cached };
  }
  const observed = await observeMuseAuthStore();
  if (observed.kind !== "present") return observed;
  museStatusCache.set(fingerprint, observed.value, generation);
  return observed;
};

// ─── Passive model observation (zero-spawn; filled by runtime later) ─────

type TMuseNativeModelCache = {
  readonly fingerprint: string;
  readonly accountHint: string | null;
  readonly generation: number;
  readonly models: ReadonlyArray<TProviderModelEntry>;
  readonly observedAtMs: number;
};

const MUSE_NATIVE_MODEL_TTL_MS = 30 * 60_000;
let museNativeGeneration = 0;
let museNativeModels: TMuseNativeModelCache | null = null;

export const museNativeModelGeneration = (): number => museNativeGeneration;

export const clearMuseNativeModels = (): void => {
  museNativeModels = null;
  museNativeGeneration += 1;
};

export const museNativeModelFingerprint = (): string | null => {
  const identity = fileStoreIdentity(museAuthJsonPath());
  if (!identity.statOk) return null;
  if (!identity.present) return null;
  return fingerprintStoreIdentity(identity);
};

export const rememberMuseNativeModels = (opts: {
  readonly fingerprint: string;
  readonly accountHint: string | null;
  readonly generation: number;
  readonly models: ReadonlyArray<TProviderModelEntry>;
}): void => {
  if (opts.generation !== museNativeGeneration) return;
  if (opts.models.length === 0) return;
  const live = museNativeModelFingerprint();
  if (live === null || live !== opts.fingerprint) return;
  museNativeModels = {
    fingerprint: opts.fingerprint,
    accountHint: opts.accountHint,
    generation: opts.generation,
    models: opts.models,
    observedAtMs: Date.now(),
  };
};

export const readMuseNativeModels = (opts: {
  readonly fingerprint: string;
  readonly accountHint: string | null;
}): ReadonlyArray<TProviderModelEntry> | null => {
  const cached = museNativeModels;
  if (cached === null) return null;
  if (cached.generation !== museNativeGeneration) return null;
  if (cached.fingerprint !== opts.fingerprint) return null;
  if (cached.accountHint !== opts.accountHint) return null;
  const live = museNativeModelFingerprint();
  if (live === null || live !== opts.fingerprint) return null;
  if (Date.now() - cached.observedAtMs > MUSE_NATIVE_MODEL_TTL_MS) return null;
  return cached.models;
};

export const resetMuseNativeModelObservationForTests = (): void => {
  museNativeModels = null;
  museNativeGeneration = 0;
  museStatusCache.invalidate();
};

const {
  installHint: INSTALL_HINT,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  isInstalled,
  isConnected,
  refreshConfig,
  slot,
} = loginWiring({
  provider: PROVIDER,
  installHint:
    "Muse Code not found — install with `curl -fsSL https://dev.meta.ai/install.sh | sh`, then retry.",
  connectedDetail: "signed in via Muse Code",
  inProgressDetail:
    "Muse sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  readToken: readFileBackedAuthPresence,
});

const connectDirect = makeStreamConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: isConnected,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  argv: () => [bin(), "login"],
  env,
  waitStoreHint: (signal) => waitFileStoreHint(museAuthJsonPath(), signal),
  stream: "stdout",
  parse: (buffer) => parseMuseLoginPrompt(buffer),
  onConnected: () => {
    museStatusCache.invalidate();
    clearMuseNativeModels();
    refreshConfig();
    noteAuthStoreIdentityChange(PROVIDER);
    return true;
  },
  onStart: () => {
    logInfo("muse-connect", "spawning `muse login`");
  },
  onParsed: (url) =>
    logInfo("muse-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError(
      "muse-connect",
      safeDiagnosticMessage`no authorize URL parsed from muse login`,
      {
        // Never log raw stdout — device codes / fragments / tokens can leak.
        capturedLen: captured.length,
      },
    ),
  onBackgroundExit: (info) => {
    const diag = classifyMuseLoginBackgroundExit(info);
    logError(
      "muse-connect",
      safeDiagnosticMessage`muse login exited before verified credential`,
      {
        exitCode: diag.exitCode,
        exitCategory: diag.exitCategory,
        stderrCategory: diag.stderrCategory,
        capturedBytes: diag.capturedBytes,
      },
    );
  },
  crashDetail: (captured, exitCode) => {
    const mapped = mapMuseLoginCrashDetail(captured);
    if (mapped !== null) return mapped;
    const diag = classifyMuseLoginBackgroundExit({
      exitCode,
      captured,
      reaped: false,
    });
    const code =
      typeof exitCode === "number" ? `exit ${exitCode}` : "no exit code";
    return `Couldn't start Muse sign-in (${code}; ${diag.stderrCategory}). Retry, or run \`muse login\` on the box.`;
  },
  // Explicit opt-in — do not reuse crashDetail for all stream providers.
  backgroundCrashDetail: (captured, _exitCode) =>
    mapMuseLoginCrashDetail(captured) ??
    "sign-in process exited before a credential landed",
  pendingDetail: (url) =>
    `Authorize Muse in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Muse sign-in. Retry, or run `muse login` on the box.",
});

const cancelConnect = makeCancelConnect(PROVIDER, slot, {
  cancelled: "Muse sign-in cancelled",
  none: "no sign-in was in progress",
});

export const museDelegate: TProviderDelegate = {
  slug: PROVIDER,
  // cliInstallState is a shared probe and does not accept observer aborts.
  statusCancellable: false,
  invalidateStatusObservation: clearMuseStatusObservationCache,
  connect: connectDirect,
  cancelConnect,

  status: async (): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const storeRead = installed
      ? await readCachedStoreObservation()
      : undefined;
    if (storeRead?.kind === "indeterminate") {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("store_unreadable"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    const fileBacked =
      storeRead?.kind === "present" && storeRead.value.kind === "file_backed";
    const keychainPointer =
      storeRead?.kind === "present" &&
      storeRead.value.kind === "keychain_pointer";
    if (fileBacked) clearPendingAuth(PROVIDER);
    const pending = fileBacked ? null : getPendingAuth(PROVIDER);

    if (fileBacked) {
      return {
        provider: PROVIDER,
        status: "connected",
        ...connectedObservation(),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        last_login_at_ms: null,
        detail:
          "Muse local file-backed oauth login present under the isolated XDG store. Not subscription/quota proof; META_API_KEY is stripped from child env.",
      };
    }

    if (keychainPointer) {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("probe_failed"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        ...(pending !== null
          ? {
              pending_auth: {
                url: pending.url,
                code: pending.code,
                started_at_ms: pending.startedAt,
                ...(pending.flowId !== undefined
                  ? { flow_id: pending.flowId }
                  : {}),
              },
            }
          : {}),
        detail:
          pending !== null
            ? pendingAuthDetail(pending)
            : "Muse auth.json points at the macOS Keychain (`storage: keychain`), which is not isolated under the daemon HOME. Re-login with the file credential backend (TBH_CREDENTIAL_BACKEND=file) so the token is stored inline.",
      };
    }

    return {
      provider: PROVIDER,
      status: "disconnected",
      ...(pending !== null
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
              started_at_ms: pending.startedAt,
              ...(pending.flowId !== undefined
                ? { flow_id: pending.flowId }
                : {}),
            },
          }
        : {}),
      detail:
        pending !== null
          ? pendingAuthDetail(pending)
          : installed
            ? "muse installed but not signed in"
            : "muse not installed",
    };
  },

  usage: async (): Promise<TProviderUsageSnapshot> => ({
    kind: "unavailable",
    reason:
      "Muse subscription quota is not published through a verified local API for this daemon yet.",
    link: "https://dev.meta.ai/docs/muse-code/auth",
  }),

  discoverModels: async (
    _options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    // Zero-spawn: only reuse observations remembered from a prior native
    // session under the current store fingerprint. Never launch muse / MSP.
    const fingerprint = museNativeModelFingerprint();
    if (fingerprint === null) return { kind: "skipped" };
    const cached = readMuseNativeModels({
      fingerprint,
      accountHint: null,
    });
    if (cached === null || cached.length === 0) return { kind: "skipped" };
    return { kind: "success", models: cached };
  },

  listModels: async (): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
    // Explicit manual refresh: demand-driven MSP model/list via runtime helper.
    try {
      const { listMuseModelsDemand } = await import(
        "../native-runtime/muse-runtime"
      );
      const listed = await listMuseModelsDemand({
        bin: cliBin(PROVIDER),
        env: baseEnv(),
      });
      if (listed === null) return null;
      return listed.length > 0 ? listed : null;
    } catch {
      const fingerprint = museNativeModelFingerprint();
      if (fingerprint === null) return null;
      return readMuseNativeModels({ fingerprint, accountHint: null });
    }
  },

  credentialForUpstream: async () => {
    if ((await readFileBackedAuthPresence()) === null) {
      throw new Error("muse: not signed in (no file-backed Muse credential)");
    }
    const url = await resolveUpstreamUrl(PROVIDER);
    throw new Error(
      `muse is served by the native Muse bridge (muse serve / SDK); there is no manual upstream transport (configured target: ${new URL(url).origin})`,
    );
  },

  logout: async () => {
    clearMuseStatusObservationCache();
    if ((await cliInstallState(PROVIDER, { demand: true })).installed) {
      await runCapture([bin(), "logout"], env(), {
        probe: unwrapKeychainSpawn(PROVIDER),
      });
    }
    const stillPresent = (await readFileBackedAuthPresence()) !== null;
    clearMuseStatusObservationCache();
    return !stillPresent
      ? {
          ok: true,
          detail:
            "signed out of Muse (an exported META_API_KEY in the host shell is unchanged)",
        }
      : {
          ok: false,
          detail:
            "credential store still present after logout (or still configured via host META_API_KEY outside this daemon)",
        };
  },
};
