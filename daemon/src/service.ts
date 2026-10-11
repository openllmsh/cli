/**
 * Service lifecycle — `openllmd start | stop | status | restart`.
 *
 * The daemon supervises ITSELF: registering, starting, stopping, and querying
 * its own background service (a macOS launch agent / a Linux systemd --user
 * unit). The install script (`packages/registry/setup/daemon/install.sh`) downloads the
 * binary, puts it on PATH, and then delegates to `openllmd start` — so the same
 * code path the installer uses is the one a user runs by hand.
 *
 * - `start`  — register + enable + (re)start in FULL self-restore mode: launchd
 *              `KeepAlive`+`RunAtLoad`, systemd `Restart=always` + boot start +
 *              linger. Survives crash, logout, and reboot. Idempotent.
 * - `stop`   — stop AND disable all self-restore: launchd `bootout`+`disable`
 *              (persistent override so login won't relaunch it), systemd
 *              `disable --now`. Stays down until the next explicit `start`.
 * - `status` — service registration/run state + listening check.
 * - `restart`— stop then start.
 *
 * The service runs `process.execPath` — the compiled binary that invoked
 * `start`. Running `start` from a source checkout (`bun src/main.ts start`,
 * reported as `0.0.0-dev`) would register `bun` as the service, so it's
 * refused; install + run the compiled binary (`bun run daemon:dist` then
 * `bun run daemon:dist:install`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setAutoUpdate } from "./auto-update-pref";
import type { TCredentialGateResult } from "./credential-gate";
import { hasCredentialProof, requireServiceApiKey } from "./credential-gate";
import {
  daemonEnv,
  daemonStderrLogFilePath,
  daemonStdoutLogFilePath,
  hasExplicitServicePortOverride,
  logFilePath,
  serviceEnvFilePath,
  servicePort,
  stateDir,
  writeEnvFileVars,
} from "./env";
import { hardenMacBinary } from "./harden-binary";
import type { TDaemonHealth } from "./health";
import { DAEMON_VERSION } from "./version";

const LABEL = "sh.openllm.daemon";
const isMac = process.platform === "darwin";

const plistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitDir = (): string => join(homedir(), ".config", "systemd", "user");
const unitPath = (): string => join(unitDir(), "openllmd.service");

const uid = (): number => (process.getuid ? process.getuid() : 0);
const guiDomain = (): string => `gui/${uid()}`;
const guiTarget = (): string => `${guiDomain()}/${LABEL}`;

/** Run a command, swallowing failure; returns whether it exited 0. */
const tryRun = (cmd: string, args: readonly string[]): boolean => {
  try {
    execFileSync(cmd, args as string[], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Run a command and capture stdout (empty string on failure). The 5s timeout
 *  keeps a hung supervisor (e.g. a wedged systemctl) from hanging the CLI. */
const capture = (cmd: string, args: readonly string[]): string => {
  try {
    return execFileSync(cmd, args as string[], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return "";
  }
};

/**
 * Ensure the env file carries the cloud origin + port the service reads at boot.
 * Written when absent so a standalone `openllmd start` works without the
 * installer; also (re)written when `OPENLLM_CLOUD_ORIGIN` or
 * `OPENLLM_DAEMON_PORT` is set explicitly, so `OPENLLM_CLOUD_ORIGIN=… openllmd
 * start` (or `…PORT=…`) re-points an existing install. Upserts only these two
 * keys — the paired `OPENLLM_API_KEY` and minted `OPENLLM_DEVICE_ID` lines in
 * the same file are preserved.
 */
const writeEnvFileIfNeeded = (): void => {
  // Either var set explicitly re-points an existing install — otherwise
  // `OPENLLM_DAEMON_PORT=9000 openllmd start` would report :9000 while the
  // persisted env file (what the service actually boots with) kept the old one.
  // The port half uses `hasExplicitServicePortOverride()` rather than a bare
  // `process.env` presence check: earlier code in the same command (e.g.
  // `requireServiceApiKey` -> `daemonEnv()`) may already have loaded
  // `.dev.env` and written its own port into `process.env.OPENLLM_DAEMON_PORT`,
  // which must never be mistaken for a genuine caller override of the
  // installed (prod) service's port.
  const explicitOverride =
    process.env.OPENLLM_CLOUD_ORIGIN !== undefined ||
    hasExplicitServicePortOverride();
  // Seed the PROD `.env` the installed service actually boots from — NEVER the
  // dev-resolved `.dev.env`, even under `OPENLLM_DAEMON_DEV=1` (installing is a
  // production action; see `serviceEnvFilePath`).
  const target = serviceEnvFilePath();
  if (existsSync(target) && !explicitOverride) return;
  const env = daemonEnv();
  writeEnvFileVars(
    {
      OPENLLM_CLOUD_ORIGIN: env.cloudOrigin,
      OPENLLM_DAEMON_PORT: String(servicePort()),
    },
    target,
  );
};

/**
 * The daemon's service-captured log files — the stdout/stderr the OS
 * supervisor (launchd/systemd) redirects, distinct from the app's own
 * structured `openllmd.log`. Single source of truth, consumed by `renderPlist`,
 * `renderUnit`, and `serviceStatus` so the capture policy is ONE value, not
 * per-renderer copies that drift (the bug: macOS captured an err.log, Linux
 * didn't).
 */
export const serviceLogPaths = (): { out: string; err: string } => ({
  out: daemonStdoutLogFilePath(),
  err: daemonStderrLogFilePath(),
});

/**
 * Major version from `systemctl --version` (first line: `systemd 249 (…)`).
 * Returns 0 when systemctl is absent/unparseable so callers fall back to
 * journald rather than emitting a directive an older systemd rejects at unit
 * load.
 */
const systemdMajor = (): number => {
  const m = capture("systemctl", ["--version"]).match(/\bsystemd\s+(\d+)/);
  return m === null ? 0 : Number.parseInt(m[1], 10);
};

/** Raw env override is relative — `stateDir()` would ignore it and fall back
 *  to `~/.openllm`, which is absolute, so the unit must not emit `append:`. */
const hasRelativeStateDirOverride = (): boolean => {
  const override = process.env.OPENLLM_DAEMON_STATE_DIR;
  return override !== undefined && override.length > 0 && !isAbsolute(override);
};

/**
 * Service-log directives for the systemd unit. Always tags journald with a
 * greppable identity; ADDITIONALLY mirrors stdout/stderr to files — parity with
 * the macOS launch agent's `StandardOut/ErrorPath`, so Linux finally writes an
 * `openllmd.err.log` capturing crash/OOM/native output the app logger can't
 * reach — when systemd supports `append:` (≥240) and the paths are absolute (an
 * `OPENLLM_DAEMON_STATE_DIR` override could be relative). Otherwise stays
 * journald-only — never `file:`, which truncates the log on every (re)start.
 * `append:` needs the parent dir to exist at exec time (see `startLinux`).
 *
 * Takes the systemd major (from `systemdMajor()`) so the version gate is
 * injectable — exported for the same reason `renderUnitHardening` is: so a test
 * can assert both branches without a real systemd.
 */
export const renderUnitLogging = (systemdMajorVersion: number): string => {
  const { out, err } = serviceLogPaths();
  let s = "SyslogIdentifier=openllmd\n";
  if (
    systemdMajorVersion >= 240 &&
    !hasRelativeStateDirOverride() &&
    isAbsolute(out) &&
    isAbsolute(err)
  ) {
    s += `StandardOutput=append:${out}\n`;
    s += `StandardError=append:${err}\n`;
  }
  return s;
};

/**
 * launchd must retain its default process-group cleanup when the daemon exits;
 * durable session hosts deliberately run detached, while disposable children
 * remain in the daemon's group. Exported so service-rendering tests can guard
 * against accidentally adding `AbandonProcessGroup=true`.
 */
export const plistUsesLaunchdProcessGroupCleanup = (plist: string): boolean =>
  !/<key>AbandonProcessGroup<\/key>\s*<true\s*\/>/.test(plist);

export const renderPlist = (binPath: string): string => {
  const { out, err } = serviceLogPaths();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${binPath}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>OPENLLM_DAEMON_ENV_FILE</key><string>${serviceEnvFilePath()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Minimum seconds between respawns ("cap on retry" — backoff floor). launchd
       has no exponential ramp or start-limit, so a higher floor is the only
       native throttle on a crash loop; the hard ceiling is boot-guard.ts. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
</dict>
</plist>
`;
  if (!plistUsesLaunchdProcessGroupCleanup(plist)) {
    throw new Error("LaunchAgent must not abandon the daemon process group");
  }
  return plist;
};

/**
 * OS-sandbox half of the unit — intentionally EMPTY.
 *
 * The daemon registers a `systemctl --user` unit (it installs without root).
 * In an unprivileged unit, every seccomp/prctl directive — `SystemCallFilter=`,
 * `SystemCallArchitectures=`, `RestrictAddressFamilies=`, `RestrictNamespaces=`,
 * `LockPersonality=`, `RestrictRealtime=` — IMPLIES `NoNewPrivileges=yes`
 * (systemd.exec(5)), and no_new_privs is inherited by every descendant. The
 * daemon's device-session PTYs are the user's real shell, so that flag broke
 * `sudo` inside them ("The \"no new privileges\" flag is set"). Capability and
 * mount directives were already impossible here (`218/CAPABILITIES`).
 *
 * So the unit carries no hardening at all. FS confinement stays Landlock's job
 * (`sandbox/landlock.ts`), applied PER CHILD through the `--sandbox-exec` shim
 * — the PTY path is deliberately unwrapped, so it keeps full privilege
 * escalation. Never add a directive that implies NoNewPrivileges back here.
 */
export const renderUnitHardening = (): string => "";

/**
 * Restart policy for the systemd unit — exponential backoff with a hard ceiling
 * ("cap on retry"). Takes the systemd major (from `systemdMajor()`) so the
 * version gate is injectable for tests (like `renderUnitLogging`).
 *
 * Always `Restart=always` (recover from clean exit, crash, OOM, signal — only an
 * explicit `systemctl --user stop` keeps it down). On systemd ≥254 the respawn
 * interval RAMPS from `RestartSec` to `RestartMaxDelaySec` over `RestartSteps`
 * rather than hammering at a fixed 2s — so a persistent boot failure backs off
 * to a 30s cadence instead of pegging the CPU. Older systemd lacks `RestartSteps`
 * (it would reject the unit), so it falls back to a fixed, slightly slower 5s.
 */
export const renderUnitRestart = (systemdMajorVersion: number): string => {
  if (systemdMajorVersion >= 254) {
    return "Restart=always\nRestartSec=2\nRestartSteps=8\nRestartMaxDelaySec=30\n";
  }
  return "Restart=always\nRestartSec=5\n";
};

export const renderUnit = (binPath: string): string => `[Unit]
Description=OpenLLM local daemon
After=network-online.target
Wants=network-online.target
# Start-limit cap ("cap on retry"). The daemon is meant to run forever, so the
# bound is generous — but NOT infinite: a persistent boot failure (port
# permanently in use, a bad binary) used to crash-loop forever with the limiter
# disabled, flooding the log + burning CPU. With backoff (RestartSteps below) a
# real loop runs at ~30s/boot, so 20 starts in 5 min only triggers after minutes
# of genuine thrashing → systemd parks the unit "failed" and stops. The app-side
# crash-loop guard (boot-guard.ts) is the cross-platform backstop (+ the only one
# on macOS). Recover from a parked unit with \`openllmd restart\`.
StartLimitIntervalSec=300
StartLimitBurst=20

[Service]
EnvironmentFile=${serviceEnvFilePath()}
ExecStart=${binPath}
${renderUnitRestart(systemdMajor())}${renderUnitLogging(systemdMajor())}${renderUnitHardening()}
[Install]
WantedBy=default.target
`;

/**
 * `launchctl bootout` is ASYNCHRONOUS — it requests teardown and returns while
 * launchd is still killing the old process and unregistering the label. A
 * `bootstrap` issued in that window fails ("service already bootstrapped" —
 * swallowed by tryRun), the legacy `load` fallback silently no-ops, and the
 * follow-up `kickstart -k` lands on a half-torn-down label: the net effect was
 * a reinstall that left the OLD binary running (or nothing running) until the
 * user manually ran `openllmd restart` after the race had settled. Poll the
 * label until launchd reports it gone (bounded) so the re-bootstrap below is
 * deterministic. Returns whether teardown completed — a caller must NOT
 * bootstrap on `false` (it would re-enter the same race).
 */
const waitForBootout = (target: string, timeoutMs = 10_000): boolean => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // `launchctl print` exits non-zero once the label is fully unregistered.
    // (A broken launchctl also captures empty — acceptable: the bootstrap
    // that follows would then fail loudly and throw.)
    if (capture("launchctl", ["print", target]).length === 0) return true;
    execFileSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  return false;
};

const startMac = (binPath: string): void => {
  const plist = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, renderPlist(binPath));
  const domain = guiDomain();
  const target = guiTarget();
  // Modern launchd lifecycle (domain-target). The legacy `launchctl load`
  // silently no-ops in common states — notably when a prior `stop` left the
  // label in a DISABLED override — so KeepAlive/RunAtLoad never take effect and
  // the daemon "won't stay running". `enable` clears that override; `bootstrap`
  // loads it (fall back to `load` on older macOS); `kickstart -k` (re)starts it.
  if (tryRun("launchctl", ["bootout", target]) && !waitForBootout(target)) {
    // Teardown never completed — bootstrapping now would land on the
    // half-registered label (the exact race this guard exists to close).
    throw new Error(
      `launchd did not finish tearing down ${LABEL} within 10s — run 'openllmd restart' to retry`,
    );
  }
  tryRun("launchctl", ["enable", target]);
  if (
    !tryRun("launchctl", ["bootstrap", domain, plist]) &&
    !tryRun("launchctl", ["load", plist])
  ) {
    throw new Error(`failed to load launch agent ${LABEL} (${plist})`);
  }
  tryRun("launchctl", ["kickstart", "-k", target]);
};

const startLinux = (binPath: string): void => {
  mkdirSync(unitDir(), { recursive: true });
  // systemd opens the `append:` log targets (renderUnitLogging) at exec time —
  // the state dir must exist first or the unit fails to start.
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(unitPath(), renderUnit(binPath));
  if (!tryRun("systemctl", ["--version"])) {
    throw new Error("systemctl not found — cannot register a systemd unit");
  }
  // Keep the user manager (and the daemon) alive across logout + at boot —
  // critical on headless servers where logind would otherwise reap it when the
  // SSH session ends. Self-linger usually needs no root (polkit); fall back to
  // sudo, then a hint.
  const user =
    capture("id", ["-un"]).trim() || homedir().split("/").pop() || "";
  if (
    user.length > 0 &&
    !tryRun("loginctl", ["enable-linger", user]) &&
    !tryRun("sudo", ["-n", "loginctl", "enable-linger", user])
  ) {
    process.stdout.write(
      `Note: run 'sudo loginctl enable-linger ${user}' so the daemon survives logout + reboot.\n`,
    );
  }
  tryRun("systemctl", ["--user", "daemon-reload"]);
  if (!tryRun("systemctl", ["--user", "enable", "--now", "openllmd.service"])) {
    throw new Error("failed to enable openllmd.service");
  }
  // Restart so a re-run with changed config takes effect (enable --now no-ops
  // when already running).
  tryRun("systemctl", ["--user", "restart", "openllmd.service"]);
};

const stopMac = (): void => {
  const target = guiTarget();
  tryRun("launchctl", ["bootout", target]);
  // Persistent disable override so a login/boot won't relaunch it — this is the
  // "disable all self-restore" half. Cleared by the next `start`'s `enable`.
  tryRun("launchctl", ["disable", target]);
};

const stopLinux = (): void => {
  // `disable --now` stops it AND removes the WantedBy symlink (no boot start);
  // a manual stop does not re-trigger Restart=always, so it stays down.
  tryRun("systemctl", ["--user", "disable", "--now", "openllmd.service"]);
};

// ─── Supervisor state (real, not a boolean) ──────────────────────────
// `is-active`/`state = running` answers "does the supervisor have a process",
// NOT "is the daemon actually serving". A daemon crash-looping on its listener
// bind (e.g. port in use) flickers through `active`/`running` between respawns
// and reports "running" — the bug this replaces. We now surface the supervisor's
// REAL state (systemd sub-state + restart count + last exit; launchd pid + last
// exit) and pair it with a live `/status` probe (see `serviceStatus`) so a crash
// loop reads as `activating (auto-restart) · N restarts` + `health: NOT
// responding` instead of a falsely reassuring "running".

/** Parse `key=value` lines (systemctl show output) into a record. */
export const parseKeyValues = (out: string): Record<string, string> => {
  const rec: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return rec;
};

/** Render a systemd `show` record into a human supervisor line. Pure. */
export const renderSystemdSupervisor = (f: Record<string, string>): string => {
  const active = f.ActiveState ?? "unknown";
  const sub = f.SubState ?? "";
  const parts = [sub && sub !== active ? `${active} (${sub})` : active];
  const n = Number.parseInt(f.NRestarts ?? "", 10);
  if (Number.isFinite(n) && n > 0) parts.push(`${n} restarts`);
  const exit = Number.parseInt(f.ExecMainStatus ?? "", 10);
  if (Number.isFinite(exit) && exit !== 0) parts.push(`last exit ${exit}`);
  return parts.join(" · ");
};

/** Parse the fields we need from `launchctl print` output. */
export const parseLaunchctlPrint = (
  out: string,
): { running: boolean; pid: number | null; lastExitCode: number | null } => {
  const pidMatch = out.match(/\bpid = (\d+)/);
  const exitMatch = out.match(/last exit code = (\d+)/); // `(none)` → no match
  return {
    running: /state = running/.test(out) || pidMatch !== null,
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    lastExitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
  };
};

/** Render parsed launchd fields into a human supervisor line. Pure. */
export const renderLaunchdSupervisor = (s: {
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
}): string => {
  if (s.running) return s.pid !== null ? `running (pid ${s.pid})` : "running";
  const exit =
    s.lastExitCode !== null && s.lastExitCode !== 0
      ? ` · last exit ${s.lastExitCode}`
      : "";
  return `not running${exit}`;
};

export type TSupervisorInfo = {
  readonly pid: number | null;
  readonly state: string;
};

/** Capture the daemon supervisor once for callers that need both state and PID. */
export const supervisorInfo = (): TSupervisorInfo => {
  if (isMac) {
    // `launchctl print` exits non-zero (empty capture) when the label isn't
    // bootstrapped at all.
    const out = capture("launchctl", ["print", guiTarget()]);
    if (out.length === 0) return { state: "not loaded", pid: null };
    const parsed = parseLaunchctlPrint(out);
    return { state: renderLaunchdSupervisor(parsed), pid: parsed.pid };
  }
  const out = capture("systemctl", [
    "--user",
    "show",
    "-p",
    "ActiveState,SubState,NRestarts,ExecMainStatus,Result,MainPID",
    "openllmd.service",
  ]);
  if (out.length === 0) return { state: "unknown", pid: null };
  const fields = parseKeyValues(out);
  const pid = Number.parseInt(fields.MainPID ?? "", 10);
  return {
    state: renderSystemdSupervisor(fields),
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
  };
};

export const supervisorState = (): string => supervisorInfo().state;

/**
 * The RUNNING daemon's PID as reported by the service supervisor — launchd on
 * macOS, systemd `MainPID` on Linux — or null when no supervised daemon is
 * live. Callers running as a SEPARATE process (e.g. `openllm doctor`) must use
 * this, never `process.pid`, to inspect the daemon's own process tree.
 */
export const supervisorPid = (): number | null => supervisorInfo().pid;

/**
 * Probe the running daemon's read-only `/status` (see `health.ts`/`main.ts`).
 * A successful fetch is the authoritative "actually serving" signal — and the
 * only source of the LIVE sandbox posture (the CLI never ran the sandbox). Short
 * timeout so a hung daemon can't hang the CLI; null on any failure.
 */
const probeHealth = async (port: number): Promise<TDaemonHealth | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? ((await res.json()) as TDaemonHealth) : null;
  } catch {
    return null;
  }
};

/**
 * Register + start the service in full self-restore mode. Idempotent. Refuses
 * to register a from-source run (would point the service at `bun`).
 */
const rejectSourceServiceRegistration = (): never => {
  process.stderr.write(
    "refusing to register a service from a source run.\n" +
      "Build + install the compiled binary first: bun run daemon:dist && bun run daemon:dist:install\n",
  );
  process.exit(2);
};

const startServiceAfterCredentialGate = (
  gate: TCredentialGateResult,
): boolean => {
  if (!hasCredentialProof(gate)) return false;
  if (DAEMON_VERSION === "0.0.0-dev") rejectSourceServiceRegistration();
  const binPath = process.execPath;
  writeEnvFileIfNeeded();
  // An explicit OPENLLM_DAEMON_AUTO_UPDATE at registration is persisted to
  // the env file BEFORE the service first boots — so a `daemon:dist` install that
  // sets it `0` can't be clobbered by a self-update on the daemon's first tick.
  // Mirrors how writeEnvFileIfNeeded persists an explicit cloud-origin/port.
  const autoUpdateEnv = process.env.OPENLLM_DAEMON_AUTO_UPDATE;
  if (autoUpdateEnv !== undefined) {
    setAutoUpdate(autoUpdateEnv !== "0" && autoUpdateEnv !== "false");
  }
  hardenMacBinary(binPath); // arm64 SIGKILLs an unsigned binary launchd spawns
  if (isMac) startMac(binPath);
  else startLinux(binPath);
  process.stdout.write(
    `openllmd v${DAEMON_VERSION} started in self-restore mode (listening on http://127.0.0.1:${servicePort()}).\n`,
  );
  return true;
};

export const serviceStart = (): boolean => {
  // Refuse a from-source run BEFORE the credential gate can prompt for or
  // persist a key: a dev run is rejected either way, so it must never solicit
  // credentials just to exit(2). Mirrors serviceRestart, which runs the same
  // guard ahead of stopping a healthy service.
  if (DAEMON_VERSION === "0.0.0-dev") rejectSourceServiceRegistration();
  const gate = requireServiceApiKey("human", undefined, serviceEnvFilePath());
  if (!gate.ok) {
    process.stderr.write(gate.message);
    return false;
  }
  return startServiceAfterCredentialGate(gate);
};

/** Stop the service and disable all self-restore. Idempotent. */
export const serviceStop = (): void => {
  if (isMac) stopMac();
  else stopLinux();
  process.stdout.write("openllmd stopped; self-restore disabled.\n");
};

/**
 * Stop then start — picks up a changed binary/config. Credential onboarding runs
 * first, so a failed/cancelled restart leaves an existing service untouched.
 */
export const serviceRestart = (): boolean => {
  const gate = requireServiceApiKey("human", undefined, serviceEnvFilePath());
  if (!gate.ok) {
    process.stderr.write(gate.message);
    return false;
  }
  // Keep the credential/persistence gate ahead of stop: cancelling or failing
  // onboarding must leave a currently healthy service running. The source-build
  // guard must also run before stop, otherwise a rejected dev restart could
  // disable a healthy production service.
  if (DAEMON_VERSION === "0.0.0-dev") rejectSourceServiceRegistration();
  serviceStop();
  return startServiceAfterCredentialGate(gate);
};

/**
 * Stop the service AND remove its registration entirely (full uninstall) —
 * stronger than `stop`, which only disables self-restore but leaves the launch
 * agent / systemd unit file on disk. Stops the running daemon + any self-restore
 * first (so nothing relaunches mid-removal), then deletes the plist / unit file
 * and reloads the user manager on Linux. Returns the path it removed, or null if
 * no registration was present. Best-effort + idempotent. Used by
 * `openllmd uninstall`.
 */
export const serviceUninstall = (): string | null => {
  // 1. Stop + disable self-restore so nothing respawns while we tear down.
  if (isMac) stopMac();
  else stopLinux();
  // 2. Remove the registration file itself.
  const path = isMac ? plistPath() : unitPath();
  const existed = existsSync(path);
  rmSync(path, { force: true });
  // Linux: drop the removed unit from the in-memory view so it's fully gone.
  if (!isMac && existed) tryRun("systemctl", ["--user", "daemon-reload"]);
  return existed ? path : null;
};

export type TStatusFields = {
  readonly version: string;
  readonly registered: boolean;
  readonly supervisor: string;
  readonly health: TDaemonHealth | null;
  readonly port: number;
  readonly binary: string;
  readonly stateDir: string;
  readonly logFile: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
};

const padStatusLabel = (label: string, width: number): string => {
  const spaces = Math.max(1, width - label.length);
  return `  ${label}: ${" ".repeat(spaces)}`;
};

/**
 * Format the daemon status block in one place so it can be tested independently.
 * Keep labels aligned so the values scan quickly and the output can evolve safely.
 */
export const formatStatus = (fields: TStatusFields): string => {
  const unknown = "unknown (daemon not responding)";
  const rows: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }> = [
    {
      label: "service",
      value: fields.registered ? "registered" : "not registered",
    },
    {
      label: "supervisor",
      value: fields.supervisor,
    },
    {
      label: "health",
      value:
        fields.health !== null
          ? `serving on 127.0.0.1:${fields.port}`
          : `NOT responding on 127.0.0.1:${fields.port}`,
    },
    {
      label: "sandbox",
      value: fields.health !== null ? fields.health.sandbox : unknown,
    },
    {
      label: "cloud",
      value: fields.health !== null ? fields.health.cloud_state : unknown,
    },
    {
      label: "cloud origin",
      value: fields.health !== null ? fields.health.cloud_origin : unknown,
    },
    {
      label: "port",
      value: String(fields.port),
    },
    {
      label: "binary",
      value: fields.binary,
    },
    {
      label: "state dir",
      value: fields.stateDir,
    },
    {
      label: "logs",
      value: fields.logFile,
    },
    {
      label: "stdout",
      value: fields.stdoutLog,
    },
    {
      label: "stderr",
      value: fields.stderrLog,
    },
  ];
  const width = Math.max(...rows.map((row) => row.label.length)) + 1;
  return [
    `openllmd v${fields.version}`,
    ...rows.map((row) => `${padStatusLabel(row.label, width)}${row.value}`),
    "",
  ].join("\n");
};

/**
 * Print the service's registration + RUN state. Three independent signals:
 *   - service:    is a launch agent / systemd unit registered (file on disk);
 *   - supervisor: the OS supervisor's REAL state (sub-state, restarts, last
 *                 exit) — a crash loop shows here, not a false "running";
 *   - health:     a live `/status` probe — the authoritative "actually serving"
 *                 signal, and the source of the live sandbox + cloud state.
 * Async because of the health probe.
 */
export const serviceStatus = async (): Promise<void> => {
  const registered = isMac ? existsSync(plistPath()) : existsSync(unitPath());
  const port = servicePort();
  const supervisor = supervisorState();
  const health = await probeHealth(port);
  const logs = serviceLogPaths();
  process.stdout.write(
    formatStatus({
      version: DAEMON_VERSION,
      registered,
      supervisor,
      health,
      port,
      binary: process.execPath,
      stateDir: stateDir(),
      logFile: logFilePath(),
      stdoutLog: logs.out,
      stderrLog: logs.err,
    }),
  );
};
