/**
 * Daemon runtime configuration.
 *
 * Everything lives in ONE file — `~/.openllm/.env` (resolved via
 * `envFilePath()`). It's the single source the
 * installed service (systemd `EnvironmentFile=` / the macOS launch agent's
 * `OPENLLM_DAEMON_ENV_FILE`) boots from — and it is SHARED with the other
 * OpenLLM tools on the box: the CLI (`openllm`) reads the same file for
 * the cloud origin + API key.
 *
 * DEV mode (`OPENLLM_DAEMON_DEV=1`) is ISOLATED: `envFilePath()` resolves
 * `<stateDir>/.dev.env` instead, so a source-run dev daemon never clobbers
 * the installed daemon's config — all dev writes (`setApiKey`,
 * `setCloudOrigin`, the minted device id, the auto-update pref) land in
 * `.dev.env`, the default port is `8788` (vs prod `8787`), the cloud origin
 * defaults to the local Next server, and `.dev.env` overrides inherited process
 * env values (except the dev-mode / env-file / state-dir selectors) so Bun's
 * repository `.env` cannot shadow local daemon configuration. The ONLY thing
 * read from the shared `.env` is a live, read-only `OPENLLM_API_KEY` fallback
 * when `.dev.env` is keyless — so dev reuses the already-paired key without
 * copying it. The shared file is never written in dev.
 *
 * The keys the env file holds:
 *
 * - `OPENLLM_API_KEY`     — the user's `sk-llm-...` key. Authenticates
 *                            every cloud control-plane call. OPTIONAL at
 *                            boot: the daemon installs WITHOUT a key and
 *                            the dashboard sets it afterwards via the
 *                            control surface (`POST /config/api-key`).
 *                            Persisted to the env file so it survives
 *                            restarts / HMR. Never leaves the box.
 * - `OPENLLM_DEVICE_ID`   — stable opaque per-machine UUID, minted into
 *                            the env file on first boot. Carries no PII.
 * - `OPENLLM_CLOUD_ORIGIN`— openllm.sh origin for config pull + request
 *                            recording + API-key-hop forwarding. Baked in
 *                            at compile time via --define, overridable.
 * - `OPENLLM_DASHBOARD_ORIGIN` — allowed CORS origin for the control
 *                            surface (the dashboard). Defaults to the
 *                            cloud origin. Access control is the
 *                            localhost bind + this origin lock; there is
 *                            no separate control token at this stage.
 * - `OPENLLM_DAEMON_STATE_DIR` — where .env + state live
 *                            (default `~/.openllm`).
 * - `OPENLLM_DAEMON_AUTO_UPDATE` — self-update opt-out flag (`1`/`0`,
 *                            default ON). Read/written by
 *                            `auto-update-pref.ts`; lives here so ALL daemon
 *                            config is in the one file.
 * - `OPENLLM_SESSION_IDLE_TIMEOUT_MIN` — detached PTY idle-reap window in
 *                            minutes (default `60`; `0` disables). Read by
 *                            `session-host.ts` from this same env file.
 * - `OPENLLM_LOG_LEVEL`   — most-verbose level written to `openllmd.log`
 *                            (`error` | `warn` | `info` | `debug`, default
 *                            `info` — so `debug` is OFF unless set). Read by
 *                            `logger.ts` from this same env file.
 *
 * Pre-launch standalone API-key files are intentionally ignored; native
 * onboarding is the only credential source.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseOpenllmDaemonPort } from "@openllmsh/protocol";
// NOTE: logger.ts imports `stateDir` from this module — a benign cycle, since
// both sides only dereference the other's exports lazily inside functions.
import { logWarn, safeDiagnosticMessage } from "./logger";

export type TDaemonEnv = {
  /** The user's `sk-llm-...` key, or null until the dashboard sets it. */
  readonly apiKey: string | null;
  readonly cloudOrigin: string;
  readonly dashboardOrigin: string;
};

/**
 * Extract the public id half of a `sk-llm-{id}.{secret}` key. The daemon
 * never imports `@openllm/vault`; this is a shape-only parse (id only —
 * secret is ignored). Returns null on any mismatch.
 */
export const parseApiKeyId = (raw: string): string | null => {
  if (!raw.startsWith("sk-llm-")) return null;
  const rest = raw.slice("sk-llm-".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const id = rest.slice(0, dot);
  return id.length > 0 ? id : null;
};

/**
 * This daemon's api key id (the `key_id` grants must target). Null when
 * keyless or the stored key is malformed.
 */
export const daemonApiKeyId = (): string | null => {
  const key = daemonEnv().apiKey;
  if (key === null) return null;
  return parseApiKeyId(key);
};

/**
 * Compile-time default for the cloud origin, injected by
 * scripts/compile.ts via `--define __OPENLLM_CLOUD_ORIGIN_DEFAULT__`.
 * Declared as a global (NOT `process.env`) so the bundler replaces the
 * identifier without clobbering the runtime `process.env` read below —
 * the env var must still win for local testing. Falls back to the public
 * origin when run from source (no define).
 */
declare const __OPENLLM_CLOUD_ORIGIN_DEFAULT__: string | undefined;
const compiledCloudOrigin = (): string => {
  try {
    return typeof __OPENLLM_CLOUD_ORIGIN_DEFAULT__ === "string"
      ? __OPENLLM_CLOUD_ORIGIN_DEFAULT__
      : "https://www.openllm.sh";
  } catch {
    return "https://www.openllm.sh";
  }
};

/**
 * Dev mode (`OPENLLM_DAEMON_DEV=1`, set by `bun run dev:daemon`). Lets
 * the daemon boot from source with `bun --watch` without a full install:
 * the cloud origin defaults to the local Next server and a failed/absent
 * cloud bootstrap is non-fatal. The API key is NOT defaulted — you set a
 * real one from the dashboard's Providers tab (same as production), which
 * also exercises that flow during development. Never set in production.
 */
export const isDevMode = (): boolean => process.env.OPENLLM_DAEMON_DEV === "1";

/**
 * Dev-mode `.dev.env` loading is special: when `OPENLLM_DAEMON_DEV=1`, existing
 * process env vars must be treated as defaults, and file values are honored as
 * overrides so ad-hoc `bun dev` env injection can't block local testing.
 *
 * Production preserves the original behavior: config file values are ignored when
 * already-present in process.env, so explicitly set vars stay source-of-truth.
 *
 * The three selector keys must never be overwritten by file values:
 * `OPENLLM_DAEMON_DEV` (mode), `OPENLLM_DAEMON_ENV_FILE` (path override), and
 * `OPENLLM_DAEMON_STATE_DIR` (state root).
 */
const LOAD_ENV_FILE_NO_OVERRIDE_KEYS = new Set([
  "OPENLLM_DAEMON_DEV",
  "OPENLLM_DAEMON_ENV_FILE",
  "OPENLLM_DAEMON_STATE_DIR",
]);

/**
 * In DEV mode, `.dev.env` is authoritative for all keys except those that select
 * the loaded file/path itself. In non-dev, the file is still additive-only.
 */
function shouldWriteEnvVar(key: string, devMode: boolean): boolean {
  if (LOAD_ENV_FILE_NO_OVERRIDE_KEYS.has(key)) return false;
  if (!devMode) return process.env[key] === undefined;
  return true;
}

// Dev-only fallback for the cloud origin — points at the local Next
// server. (The dashboard origin falls back through `cloudOrigin`, and the
// API key is intentionally absent — set it from the UI like a real user.)
const DEV_CLOUD_ORIGIN = "http://127.0.0.1:3000";

/**
 * Root for the daemon's local state (`.env`, the isolated vendor CLIs
 * under `cli/<provider>/`, …). Defaults to `~/.openllm`; override with
 * `OPENLLM_DAEMON_STATE_DIR`. Exported so cli-paths.ts nests under it.
 *
 * `home` overrides the base for the `homedir()` default — needed ONLY by the
 * `--sandbox-exec` shim, which runs with the CHILD's `HOME` (an isolated CLI
 * home) and must still resolve the DAEMON's state dir. See
 * `sandbox/exec.ts` `HOME_FLAG`.
 */
export const stateDir = (home?: string): string => {
  const override = process.env.OPENLLM_DAEMON_STATE_DIR;
  return override !== undefined && override.length > 0 && isAbsolute(override)
    ? override
    : join(home ?? homedir(), ".openllm");
};

/** The structured log file, isolated from the installed daemon in dev mode. */
export const logFilePath = (): string =>
  join(stateDir(), isDevMode() ? "openllmd.dev.log" : "openllmd.log");

/** Native stdout capture written by the installed launchd/systemd service. */
export const daemonStdoutLogFilePath = (): string =>
  join(stateDir(), "openllmd.out.log");

/** Native stderr capture written by the installed launchd/systemd service. */
export const daemonStderrLogFilePath = (): string =>
  join(stateDir(), "openllmd.err.log");

/**
 * An explicit daemon env-file override is valid only when it is an absolute,
 * nonempty path. This is a service boundary: launchd and systemd must never be
 * handed an empty or cwd-relative config path, and runtime reads/writes must
 * resolve the same file that a registered service will use.
 */
const daemonEnvFileOverride = (): string | null => {
  const override = process.env.OPENLLM_DAEMON_ENV_FILE;
  return override !== undefined && override.length > 0 && isAbsolute(override)
    ? override
    : null;
};

/**
 * The SHARED OpenLLM env/config file. A valid absolute
 * `OPENLLM_DAEMON_ENV_FILE` wins (the macOS launch agent points us here because
 * launchd can't read a native `EnvironmentFile`); otherwise it's `.env` under
 * the state dir — the same path systemd's `EnvironmentFile=` and the installer
 * write to, and the one `bun dev:daemon` auto-loads. Shared product-wide: the
 * CLI (`openllm`) reads the same file for `OPENLLM_CLOUD_ORIGIN` /
 * `OPENLLM_API_KEY`, so a re-pair or a custom origin applies to every OpenLLM
 * tool on the box. In DEV mode this resolves `.dev.env` instead — the isolated
 * dev config — so dev never reads/writes the installed daemon's file (see
 * header).
 */
export const envFilePath = (): string =>
  daemonEnvFileOverride() ??
  join(stateDir(), isDevMode() ? ".dev.env" : ".env");

/**
 * The SHARED (prod/installed) env file — always `.env`, NEVER dev-resolved.
 *
 * Two callers depend on this staying prod-forced regardless of `isDevMode()`:
 *   1. `loadApiKey`'s live, read-only `OPENLLM_API_KEY` fallback in dev.
 *   2. Service INSTALLATION (`renderPlist` / `renderUnit` / `writeEnvFileIfNeeded`
 *      in `service.ts`). Installing a service is inherently a PRODUCTION action,
 *      so the unit/plist must pin `.env` — using the dev-aware `envFilePath()`
 *      would freeze `.dev.env` into a permanent prod service definition if the
 *      install ran with `OPENLLM_DAEMON_DEV=1` in the environment, so the
 *      installed daemon would then boot from dev config forever.
 */
export const sharedEnvFilePath = (): string => join(stateDir(), ".env");

/**
 * The env-file path a SERVICE INSTALL should pin — an explicit
 * `OPENLLM_DAEMON_ENV_FILE` still wins (a custom install may point elsewhere),
 * but the dev-mode `.dev.env` branch is NEVER taken: installing is a production
 * action, so absent an explicit override it forces the shared `.env`. This is
 * the ONLY difference from `envFilePath()` — which resolves `.dev.env` under
 * `OPENLLM_DAEMON_DEV=1` and would otherwise freeze dev config into the plist /
 * systemd unit. Used by `service.ts` renderers + `writeEnvFileIfNeeded`.
 */
export const serviceEnvFilePath = (): string =>
  daemonEnvFileOverride() ?? sharedEnvFilePath();

/** Keep the caller's port beneath dev-file overrides across repeated loads.
 * Only the port needs provenance for installed-service selection; other env
 * keys retain the loader's existing additive/override behavior. A different
 * assignment or deletion transfers ownership back to the caller. Assigning an
 * identical value is unobservable and retains its existing provenance.
 */
let loadedPort:
  | {
      readonly value: string;
      readonly callerValue: string | undefined;
    }
  | undefined;

const callerPortValue = (): string | undefined => {
  const current = process.env.OPENLLM_DAEMON_PORT;
  return loadedPort !== undefined && current === loadedPort.value
    ? loadedPort.callerValue
    : current;
};

/**
 * Load the daemon's `KEY=value` env file into `process.env`.
 *
 * In production, file values only fill already-missing vars. In dev, the file is an
 * override source: values from `.dev.env` replace any pre-set vars (with the
 * exception of selector vars in `LOAD_ENV_FILE_NO_OVERRIDE_KEYS`) so ad-hoc
 * process env from `bun` startup cannot block local testing.
 *
 * Resolved via `envFilePath()` — the single config file. systemd injects the same
 * file via `EnvironmentFile=` before exec (so this read is a harmless no-op there);
 * the macOS launch agent and `bun dev:daemon` rely on this read to load it. No-op
 * when the file is missing. Synchronous (boot-time, before anything reads env).
 */
export const loadEnvFile = (): void => {
  const callerPort = callerPortValue();
  if (callerPort === undefined) delete process.env.OPENLLM_DAEMON_PORT;
  else process.env.OPENLLM_DAEMON_PORT = callerPort;
  loadedPort = undefined;
  let text: string;
  try {
    text = readFileSync(envFilePath(), "utf-8");
  } catch {
    return;
  }
  // Read mode before processing entries: selector values from the file never
  // apply, so its ordering cannot change whether later ordinary keys override.
  const devMode = isDevMode();
  for (const [key, value] of parseEnvLines(text)) {
    if (shouldWriteEnvVar(key, devMode)) {
      if (key === "OPENLLM_DAEMON_PORT") {
        loadedPort = { value, callerValue: callerPort };
      }
      process.env[key] = value;
    }
  }
};

/** Parse `KEY=value` lines (comments + blanks ignored) into a map. Shared by
 *  `loadEnvFile` and the dev-mode shared-file API-key fallback. */
const parseEnvLines = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
};

/**
 * Upsert `KEY=value` pairs into the env file, preserving every other line
 * (comments, unrelated keys, ordering). Creates the file `0600` when absent.
 * This is how runtime-resolved secrets/ids (`OPENLLM_API_KEY`,
 * `OPENLLM_DEVICE_ID`) and re-pointed config (`OPENLLM_CLOUD_ORIGIN`,
 * `OPENLLM_DAEMON_PORT`) get persisted back to the one file both dev and the
 * service boot from. Returns true on successful write, false on failure.
 *
 * `targetPath` defaults to `envFilePath()` (dev-aware). The service installer
 * passes `serviceEnvFilePath()` so it seeds the PROD `.env` even under the dev
 * flag — see `serviceEnvFilePath` / `service.ts writeEnvFileIfNeeded`.
 */
const lockWait = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};

/** Serialize env-file read/modify/write operations across daemon processes. */
const withEnvFileLock = (
  targetPath: string,
  operation: () => boolean,
): boolean => {
  const lockPath = `${targetPath}.lock`;
  let acquired = false;
  for (let attempts = 0; attempts < 500; attempts += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      closeSync(fd);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // A process killed while holding the lock must not block configuration forever.
      try {
        const lock = lstatSync(lockPath);
        if (lock.isFile() && Date.now() - lock.mtimeMs > 30_000)
          unlinkSync(lockPath);
      } catch {
        // Another writer may have released/replaced it; retry normally.
      }
      lockWait();
    }
  }
  if (!acquired) return false;
  try {
    return operation();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort: stale-lock recovery above prevents a permanent wedge.
    }
  }
};

const isSafeEnvTarget = (targetPath: string): boolean => {
  try {
    const target = lstatSync(targetPath);
    return target.isFile() && !target.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

const updatedEnvLines = (
  existing: readonly string[],
  updates: Readonly<Record<string, string>>,
): string[] => {
  const pending = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of existing) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    // Only treat keys the caller actually supplied as updates. A bare
    // `updates[key]` read would resolve inherited Object.prototype names
    // (`constructor`, `toString`, …) to functions and rewrite those lines.
    if (!Object.hasOwn(updates, key)) {
      out.push(line);
      continue;
    }
    const value = updates[key];
    if (value === undefined) {
      out.push(line);
      continue;
    }
    // Keep one canonical occurrence at the first position and remove conflicting
    // duplicates. Unrelated lines retain their original spelling and order.
    if (!seen.has(key)) {
      out.push(`${key}=${value}`);
      seen.add(key);
      pending.delete(key);
    }
  }
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return out;
};

/**
 * Atomically upsert env values without following links or losing concurrent
 * updates. Existing targets are required to be regular files and every success
 * leaves a private `0600` file.
 */
export const writeEnvFileVars = (
  updates: Readonly<Record<string, string>>,
  targetPath: string = envFilePath(),
): boolean => {
  if (Object.values(updates).some((value) => /[\r\n\0]/.test(value)))
    return false;
  try {
    const parentDir = dirname(targetPath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    return withEnvFileLock(targetPath, () => {
      if (!isSafeEnvTarget(targetPath)) return false;
      let existing: string[] = [];
      try {
        existing = readFileSync(targetPath, "utf-8").split("\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      const content = `${updatedEnvLines(existing, updates).join("\n")}\n`;
      const temporaryPath = join(
        parentDir,
        `.${targetPath.split("/").at(-1) ?? "env"}.${randomUUID()}.tmp`,
      );
      let temporaryFd: number | null = null;
      try {
        temporaryFd = openSync(temporaryPath, "wx", 0o600);
        writeFileSync(temporaryFd, content, "utf-8");
        fsyncSync(temporaryFd);
        closeSync(temporaryFd);
        temporaryFd = null;
        // Re-check immediately before replacement to reject a target swapped for
        // a symlink by another local process while this writer held the lock.
        if (!isSafeEnvTarget(targetPath)) return false;
        renameSync(temporaryPath, targetPath);
        chmodSync(targetPath, 0o600);
        const directoryFd = openSync(parentDir, "r");
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
        return true;
      } finally {
        if (temporaryFd !== null) closeSync(temporaryFd);
        try {
          unlinkSync(temporaryPath);
        } catch {
          // The rename consumed it, or creation failed.
        }
      }
    });
  } catch {
    return false;
  }
};

/** The default loopback port for the daemon's `/v1/*` + `/whoami` surface. */
export const DEFAULT_DAEMON_PORT = 8787;

/** Dev-mode default port — distinct from prod so a source-run dev daemon can
 *  coexist with the installed daemon on `8787`. */
export const DEV_DEFAULT_DAEMON_PORT = 8788;

/**
 * The loopback port the daemon listens on (`OPENLLM_DAEMON_PORT`, default
 * `8787`; `8788` in dev mode). Single source — `main.ts` binds it and
 * `status.ts` publishes it on `TDaemonStatus.port` so the dashboard can probe
 * `/whoami` for locality. See
 * `docs/proposals/this-machine-detection-audit.md`.
 */
export const daemonPort = (): number => {
  // `main()` resolves the port before anything else calls `daemonEnv()`, so load
  // the env file here too — otherwise a port supplied via `OPENLLM_DAEMON_ENV_FILE`
  // is ignored for the actual bind. Idempotent (respects DEV override semantics).
  loadEnvFile();
  const fallback = isDevMode() ? DEV_DEFAULT_DAEMON_PORT : DEFAULT_DAEMON_PORT;
  const raw = process.env.OPENLLM_DAEMON_PORT;
  if (raw === undefined) return fallback;
  return parseOpenllmDaemonPort(raw, fallback);
};

/**
 * The port an *installed service* (launch agent / systemd unit) should bind
 * and report — always resolved against `serviceEnvFilePath()` (the prod
 * `.env`, never `.dev.env`) and the normal (non-dev) default, regardless of
 * `OPENLLM_DAEMON_DEV`. Installing/starting the service is a production
 * action; `service.ts` must never report or persist the dev port. An
 * explicit `OPENLLM_DAEMON_PORT` supplied by the actual caller still wins
 * (re-pointing an existing install), matching `daemonPort()`'s override
 * precedence — but ONLY when that value in `process.env` wasn't just written
 * by `loadEnvFile()` itself (`hasExplicitServicePortOverride()`): in dev mode
 * `.dev.env` overwrites any pre-set `OPENLLM_DAEMON_PORT`, and by the time
 * this runs `loadEnvFile()` may already have run elsewhere in the same
 * command (e.g. `requireServiceApiKey` -> `daemonEnv()`), so a live
 * `process.env` read alone cannot tell a genuine caller override from a
 * value the dev file loader just wrote over it.
 */
export const hasExplicitServicePortOverride = (): boolean =>
  callerPortValue() !== undefined;

export const servicePort = (): number => {
  const explicit = callerPortValue();
  if (explicit !== undefined && hasExplicitServicePortOverride()) {
    return parseOpenllmDaemonPort(explicit, DEFAULT_DAEMON_PORT);
  }
  const persisted = envFileValue(serviceEnvFilePath(), "OPENLLM_DAEMON_PORT");
  if (persisted === null) return DEFAULT_DAEMON_PORT;
  return parseOpenllmDaemonPort(persisted, DEFAULT_DAEMON_PORT);
};

let cachedDeviceId: string | null = null;

/**
 * A stable per-machine id, minted once and persisted in the env file as
 * `OPENLLM_DEVICE_ID`. Opaque (a random uuid) — carries no PII. Used to bind
 * the daemon's presence token to this device
 * (`docs/proposals/daemon-presence-without-heartbeat.md`); survives restarts
 * so the token stays constant.
 */
export const deviceId = (): string => {
  if (cachedDeviceId !== null) return cachedDeviceId;
  loadEnvFile();
  const fromEnv = process.env.OPENLLM_DEVICE_ID?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    cachedDeviceId = fromEnv;
    return fromEnv;
  }
  // Mint a fresh id and persist it in the env file (single source).
  const id = randomUUID();
  writeEnvFileVars({ OPENLLM_DEVICE_ID: id });
  process.env.OPENLLM_DEVICE_ID = id;
  cachedDeviceId = id;
  return id;
};

/**
 * The persisted API key, if any. `OPENLLM_API_KEY` is loaded from the env file
 * or set explicitly in the environment. Returns null when it is absent — the
 * daemon remains keyless until native onboarding stores one. Callers run
 * `loadEnvFile` before this (via `daemonEnv`).
 *
 * DEV mode adds a LIVE, read-only fallback: when `.dev.env` is keyless, the
 * shared `.env`'s `OPENLLM_API_KEY` is used (parsed key-only — never a blanket
 * merge, which would leak the prod origin/port/device-id into dev) and never
 * written anywhere, so dev reuses the paired key without forking it.
 */
const loadApiKey = (): string | null => {
  const fromEnv = process.env.OPENLLM_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (isDevMode()) {
    try {
      const shared = parseEnvLines(readFileSync(sharedEnvFilePath(), "utf-8"))
        .get("OPENLLM_API_KEY")
        ?.trim();
      if (shared !== undefined && shared.length > 0) return shared;
    } catch {
      // no shared file — keyless
    }
  }
  return null;
};

let cached: TDaemonEnv | null = null;

export const daemonEnv = (): TDaemonEnv => {
  if (cached !== null) return cached;
  loadEnvFile();
  // In dev, default the cloud origin to the local Next server rather than
  // the compiled-in production origin.
  const originDefault = isDevMode() ? DEV_CLOUD_ORIGIN : compiledCloudOrigin();
  // Precedence: an explicit env var (the installed prod daemon sets it, and a
  // dev-adopted origin persists here via `setCloudOrigin`) wins; then the
  // default.
  const cloudOrigin = (
    process.env.OPENLLM_CLOUD_ORIGIN ?? originDefault
  ).replace(/\/+$/, "");
  cached = {
    apiKey: loadApiKey(),
    cloudOrigin,
    dashboardOrigin: (
      process.env.OPENLLM_DASHBOARD_ORIGIN ?? cloudOrigin
    ).replace(/\/+$/, ""),
  };
  return cached;
};

/**
 * Test-only: clear the memoized {@link daemonEnv} cache so the next call
 * re-reads `process.env`. Mirrors `resetSessionsForTest`. Never called in
 * production.
 */
export const resetDaemonEnvCacheForTest = (): void => {
  cached = null;
};

/** Apply a credential only after its durable env-file write has succeeded. */
export const applyPersistedApiKey = (key: string): void => {
  process.env.OPENLLM_API_KEY = key;
  const current = daemonEnv();
  cached = { ...current, apiKey: key };
};

/** Read one value from an exact env file without merging it into process state. */
export const envFileValue = (
  targetPath: string,
  key: string,
): string | null => {
  try {
    return parseEnvLines(readFileSync(targetPath, "utf-8")).get(key) ?? null;
  } catch {
    return null;
  }
};

/**
 * Persist a new API key (set from the dashboard) into the env file (`0600`) and
 * update the in-memory cache so the next cloud call uses it immediately. Pass
 * `null`/empty to clear it. The env file is the single source.
 */
export const setApiKey = (key: string | null): void => {
  const trimmed = key?.trim() ?? "";
  writeEnvFileVars({ OPENLLM_API_KEY: trimmed });
  process.env.OPENLLM_API_KEY = trimmed;
  // Refresh the cache in place so callers don't need to re-resolve env.
  const current = daemonEnv();
  cached = { ...current, apiKey: trimmed.length > 0 ? trimmed : null };
};

export const hasApiKey = (): boolean => daemonEnv().apiKey !== null;

/**
 * Re-point the daemon's cloud origin at runtime (DEV only — gated by the
 * caller in `control.ts`). PERSISTS the choice (so it survives a restart)
 * and updates the in-memory cache so the next bootstrap, usage record, and
 * API-key-hop forward target the new origin. Lets one local dev daemon serve
 * whichever deployment's dashboard it last followed (a preview, prod, or
 * localhost) without a reinstall. No-op on an empty origin.
 */
export const setCloudOrigin = (origin: string): void => {
  const trimmed = origin.replace(/\/+$/, "");
  if (trimmed.length === 0) return;
  // Persist into the shared env file (single source; `loadEnvFile` is source-aware
  // in dev), so mirror into process.env too. A failed write is surfaced but
  // non-fatal — the in-memory update below still applies for this process; only
  // restart durability is lost.
  if (!writeEnvFileVars({ OPENLLM_CLOUD_ORIGIN: trimmed })) {
    logWarn(
      "env",
      safeDiagnosticMessage`failed to persist OPENLLM_CLOUD_ORIGIN to the env file`,
    );
  }
  process.env.OPENLLM_CLOUD_ORIGIN = trimmed;
  const current = daemonEnv();
  cached = { ...current, cloudOrigin: trimmed, dashboardOrigin: trimmed };
};
