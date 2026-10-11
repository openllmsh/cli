/**
 * The daemon's read-only loopback HEALTH snapshot — the body of `GET /status`
 * (served in `main.ts`) and the shape `openllmd status` (the CLI, `service.ts`)
 * fetches to learn the LIVE state of a running daemon.
 *
 * It's deliberately a tiny, secret-free subset of the cloud-facing
 * `TDaemonStatus` (`computeStatus()` in `status.ts`): no `pubkey`, no
 * `connections`, no `usage`, and — crucially — it spawns NO delegate `status()`
 * subprocesses, so the CLI probe stays cheap. The contract lives here (not in
 * `packages/schema`) because both producer and consumer are the SAME binary;
 * there's no wire-version skew to guard against.
 *
 * The point of the endpoint: the supervisor (systemd/launchd) only knows
 * whether it has a process; it can't tell a daemon that's actually SERVING from
 * one that's crash-looping on the listener bind. A successful fetch of this body
 * IS the authoritative "the daemon is up and serving" signal, and it carries
 * the real `sandbox` posture the boot-time capability probe computed —
 * "enforced" means risky CHILDREN are wrapped via the `--sandbox-exec` shim
 * (`sandbox/exec.ts`), not that the daemon process is confined (the CLI can't
 * compute the posture itself — it never ran the probe).
 */
import type { TCloudState } from "./config";
import { keychainTelemetrySnapshot } from "./delegation/keychain";
import { refreshTelemetrySnapshot } from "./delegation/refresh";
import { hasIdentityConflict } from "./identity-state";
import type { TSandboxState } from "./sandbox/landlock";

export type TDaemonHealth = {
  readonly version: string;
  readonly port: number;
  /** The per-child OS-sandbox posture from the boot capability probe
   *  (`sandboxState()`): "enforced" = risky children are wrapped. */
  readonly sandbox: TSandboxState;
  readonly cloud_state: TCloudState;
  readonly key_configured: boolean;
  /** Whether new remote terminal-session opens are allowed on this device. */
  readonly pty_sessions: boolean;
  /**
   * Where this process pulls bootstrap/plans and forwards BYOK hops
   * (`daemonEnv().cloudOrigin`). Secret-free — origin only, no key. Lets
   * `curl /status` answer "is the dev daemon on localhost:3000 or still
   * on staging?" without digging through process env.
   */
  readonly cloud_origin: string;
  /** Seconds since this process booted (whole seconds). */
  readonly uptime_s: number;
  /** Attempt-level `security` spawn counters — no subprocess probe. */
  readonly keychain_spawns: ReturnType<typeof keychainTelemetrySnapshot>;
  /** Per-provider refresh counters — no subprocess probe. */
  readonly refresh_spawns: ReturnType<typeof refreshTelemetrySnapshot>;
  /**
   * Cloud write-once X25519 pin disagrees with this process's key.
   * Secret-free; recovery is a session-gated dashboard reset, not API-key rotate.
   */
  readonly identity_conflict: boolean;
};

/**
 * Assemble the `/status` body. Pure (all live values injected) so the snapshot
 * shape — and its secret-free key set — is unit-testable without booting the
 * daemon. `main.ts` is the only caller, passing live `sandboxState()` etc.
 */
export const buildHealth = (deps: {
  readonly version: string;
  readonly port: number;
  readonly sandbox: TSandboxState;
  readonly cloudState: TCloudState;
  readonly keyConfigured: boolean;
  readonly ptySessions: boolean;
  readonly cloudOrigin: string;
  readonly bootAt: number;
  readonly now: number;
}): TDaemonHealth => ({
  version: deps.version,
  port: deps.port,
  sandbox: deps.sandbox,
  cloud_state: deps.cloudState,
  key_configured: deps.keyConfigured,
  pty_sessions: deps.ptySessions,
  cloud_origin: deps.cloudOrigin,
  uptime_s: Math.max(0, Math.floor((deps.now - deps.bootAt) / 1000)),
  keychain_spawns: keychainTelemetrySnapshot(),
  refresh_spawns: refreshTelemetrySnapshot(),
  identity_conflict: hasIdentityConflict(),
});
